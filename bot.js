// ============================================================
// ====== ANIME DUB TRACKER BOT — bot.js =====================
// ============================================================
// HOW DUB COUNT WORKS (important to understand):
//
// PRIORITY 1: Read from dubCache (Firestore) - FAST
// PRIORITY 2: Fall back to AnimeSchedule API - SLOW (only when cache is stale/missing)
//
// dubCache is populated by running: node scripts/fetchDubData.js
// Cache refreshes automatically when data is stale (>24 hours old)
// ============================================================

require("dotenv").config();

// ====== EXPRESS (RAILWAY KEEP-ALIVE) ======
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("🚀 Anime Dub Tracker Bot is running!"));
app.listen(process.env.PORT || 3000, () =>
  console.log("✅ Express server live on port", process.env.PORT || 3000)
);

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cron = require("node-cron");
const admin = require("firebase-admin");

// ============================================================
// ====== FIREBASE ============================================
// ============================================================
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch {
  console.error("❌ FIREBASE_KEY missing or invalid");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log("✅ Firebase connected");

// ====== BOT ======
if (!process.env.BOT_TOKEN) { console.error("❌ BOT_TOKEN missing"); process.exit(1); }
if (!process.env.ANIMESCHEDULE_KEY) console.warn("⚠️  ANIMESCHEDULE_KEY not set");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
bot.getMe().then((me) => console.log(`🤖 Bot: @${me.username}`));

// ====== SAFE LOG ======
let lastLog = 0;
function safeLog(msg) {
  if (Date.now() - lastLog > 15000) { console.log(msg); lastLog = Date.now(); }
}

// ====== UTILS ======
function cleanText(t) {
  if (!t) return "No synopsis available.";
  return t.replace(/<[^>]*>/g, "").trim().slice(0, 350);
}
function escMd(t) {
  if (t == null) return "";
  return String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
function normalizeText(text) {
  return (text || "").toString().toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// ============================================================
// 🆕 NEW: STREAMING SITE HELPERS
// ============================================================

// Convert anime title to URL-friendly format for streaming sites
function getSearchQuery(title) {
  // Remove special characters and normalize
  let query = title
    .toLowerCase()
    .replace(/[′'’]/g, "'")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  
  // Replace spaces with hyphens or + based on site
  return {
    hyphen: query.replace(/ /g, "-"),
    plus: query.replace(/ /g, "+"),
    encoded: encodeURIComponent(query),
  };
}

// Get streaming site URLs for an anime
function getStreamingUrls(animeTitle) {
  const query = getSearchQuery(animeTitle);
  
  // 🆕 Add or remove sites here
  const sites = [
    {
      name: "Gogoanime",
      url: `https://gogoanime.gg/search.html?keyword=${query.encoded}`,
      emoji: "▶️",
    },
    {
      name: "AnimeKai.to",
      url: `https://animekai.to/search.html?keyword=${query.encoded}`,
      emoji: "🎬",
    },
    {
      name: "AnimeKaizoku",
      url: `https://animekaizoku.com/search?q=${query.encoded}`,
      emoji: "📺",
    },
    {
      name: "AnimeKayo",
      url: `https://animekayo.com/?s=${query.encoded}`,
      emoji: "🍿",
    },
  ];
  
  return sites;
}

// 🆕 Create inline keyboard with streaming buttons
function createStreamingKeyboard(animeTitle, trackCallbackData = null) {
  const sites = getStreamingUrls(animeTitle);
  
  // Create a row of streaming buttons (max 4 per row)
  const streamingButtons = sites.map(site => ({
    text: `${site.emoji} ${site.name}`,
    url: site.url,
  }));
  
  // Split into rows of 3 buttons per row (looks cleaner)
  const rows = [];
  for (let i = 0; i < streamingButtons.length; i += 3) {
    rows.push(streamingButtons.slice(i, i + 3));
  }
  
  // Add the track button if provided
  if (trackCallbackData) {
    rows.push([{ text: "📌 Track this anime", callback_data: trackCallbackData }]);
  }
  
  return { inline_keyboard: rows };
}

// 🆕 Create alert message keyboard (watch now buttons only, no track button)
function createAlertKeyboard(animeTitle) {
  const sites = getStreamingUrls(animeTitle);
  
  const streamingButtons = sites.map(site => ({
    text: `${site.emoji} Watch on ${site.name}`,
    url: site.url,
  }));
  
  // Split into rows of 2 buttons per row for alerts
  const rows = [];
  for (let i = 0; i < streamingButtons.length; i += 2) {
    rows.push(streamingButtons.slice(i, i + 2));
  }
  
  // Add a close/back button
  rows.push([{ text: "❌ Close", callback_data: "close_alert" }]);
  
  return { inline_keyboard: rows };
}

// ============================================================
// ====== ANILIST — SEARCH BY NAME ============================
// ============================================================
async function getAnimeBySearch(search) {
  try {
    const res = await axios.post(
      "https://graphql.anilist.co",
      {
        query: `query ($s: String) {
          Media(search: $s, type: ANIME, isAdult: false) {
            id title { romaji english } episodes status description coverImage { large }
          }
        }`,
        variables: { s: search },
      },
      { timeout: 10000 }
    );
    return res.data.data.Media;
  } catch (err) {
    console.error("AniList search error:", err.message);
    return null;
  }
}

// ============================================================
// ====== ANILIST — FETCH BY ID ===============================
// ============================================================
async function getAnimeById(id) {
  try {
    const res = await axios.post(
      "https://graphql.anilist.co",
      {
        query: `query ($id: Int) {
          Media(id: $id, type: ANIME) {
            id title { romaji english } episodes status description coverImage { large }
          }
        }`,
        variables: { id: parseInt(id) },
      },
      { timeout: 10000 }
    );
    return res.data.data.Media;
  } catch (err) {
    console.error("AniList ID error:", err.message);
    return null;
  }
}

// ============================================================
// ====== ANIMESCHEDULE — STEP 1: Get show route by AniList ID
// ============================================================
async function getAnimeScheduleEntry(anilistId) {
  if (!process.env.ANIMESCHEDULE_KEY) return null;
  try {
    const res = await axios.get("https://animeschedule.net/api/v3/anime", {
      params: { "anilist-ids": parseInt(anilistId) },
      headers: { Authorization: `Bearer ${process.env.ANIMESCHEDULE_KEY}` },
      timeout: 10000,
    });

    const data = res.data?.data || res.data || [];
    const entry = Array.isArray(data) ? data[0] : data;

    if (entry) {
      console.log(`[AS /anime] id=${anilistId} route="${entry.route}" status="${entry.status}" episodes=${entry.episodes} dubPremier="${entry.dubPremier}"`);
    } else {
      console.log(`[AS /anime] id=${anilistId} → no result`);
    }
    return entry || null;
  } catch (err) {
    console.error(`[AS /anime] error: ${err.response?.status || 'unknown'} ${err.message}`);
    if (err.response?.data) console.error(`Response data:`, err.response.data);
    return null;
  }
}

// ============================================================
// ====== ANIMESCHEDULE — STEP 2: Get current dub timetable ===
// ============================================================
async function getDubTimetable() {
  if (!process.env.ANIMESCHEDULE_KEY) return [];
  try {
    const res = await axios.get("https://animeschedule.net/api/v3/timetables/dub", {
      headers: { Authorization: `Bearer ${process.env.ANIMESCHEDULE_KEY}` },
      timeout: 10000,
    });

    let entries = [];
    if (Array.isArray(res.data)) {
      entries = res.data;
    } else if (Array.isArray(res.data?.data)) {
      entries = res.data.data;
    } else if (Array.isArray(res.data?.results)) {
      entries = res.data.results;
    } else if (typeof res.data === 'object' && res.data !== null) {
      entries = Object.values(res.data).find(v => Array.isArray(v)) || [];
    }

    console.log(`[AS timetable] fetched ${entries.length} dub entries`);
    return entries;
  } catch (err) {
    console.error(`[AS timetable] error: ${err.response?.status || 'unknown'} ${err.message}`);
    return [];
  }
}

// ============================================================
// ====== HELPER: Check if dubPremier is valid ================
// ============================================================
function hasValidDubPremier(entry) {
  if (!entry || !entry.dubPremier) return false;
  return entry.dubPremier !== "0001-01-01T00:00:00Z";
}

// ============================================================
// ====== MASTER DUB LOOKUP ===================================
// PRIORITY 1: Read from dubCache (FAST)
// PRIORITY 2: Fall back to API (SLOW, only when needed)
// ============================================================
async function getDubCount(anilistId, fallbackTitle) {
  // ============================================================
  // STEP 1: Check dubCache FIRST (much faster!)
  // ============================================================
  try {
    const cacheDoc = await db.collection("dubCache").doc(String(anilistId)).get();
    
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      
      // Check if cache is fresh (less than 24 hours old)
      let lastUpdated = cached.lastUpdated;
      if (lastUpdated && typeof lastUpdated.toDate === 'function') {
        lastUpdated = lastUpdated.toDate().getTime();
      } else if (lastUpdated && typeof lastUpdated === 'object' && lastUpdated._seconds) {
        lastUpdated = lastUpdated._seconds * 1000;
      } else if (typeof lastUpdated === 'number') {
        lastUpdated = lastUpdated;
      } else {
        lastUpdated = 0;
      }
      
      const isFresh = lastUpdated && (Date.now() - lastUpdated) < 24 * 60 * 60 * 1000;
      
      if (isFresh && cached.dubEpisodes !== undefined && cached.dubEpisodes !== null) {
        console.log(`[DubCount] ✅ Using CACHED data for "${fallbackTitle}" → ${cached.dubEpisodes} eps dubbed (${cached.dubStatus || 'unknown'})`);
        
        return {
          dubEpisodes: cached.dubEpisodes,
          totalEpisodes: cached.totalEpisodes,
          nextEpDate: cached.nextEpisodeDate,
          isFinished: cached.isFinished || false,
        };
      } else if (cached.dubEpisodes !== undefined && cached.dubEpisodes !== null) {
        console.log(`[DubCount] ⚠️ Cache stale for "${fallbackTitle}" (${lastUpdated ? Math.round((Date.now() - lastUpdated)/3600000) : 'unknown'}h old), refreshing from API...`);
      } else {
        console.log(`[DubCount] ⚠️ Cache invalid for "${fallbackTitle}", refreshing...`);
      }
    }
  } catch (err) {
    console.log(`[DubCount] Cache check failed for ${fallbackTitle}:`, err.message);
  }
  
  // ============================================================
  // STEP 2: If not in cache or stale, fall back to API
  // ============================================================
  if (!process.env.ANIMESCHEDULE_KEY) return null;

  const entry = await getAnimeScheduleEntry(anilistId);
  
  if (!entry) {
    console.log(`[DubCount] no AnimeSchedule entry for "${fallbackTitle}"`);
    return null;
  }

  // Check for completed dub
  const isFinished = entry.status?.toLowerCase() === "finished";
  const hasDub = hasValidDubPremier(entry);
  const totalEpisodes = entry.episodes || 0;
  
  if (isFinished && hasDub && totalEpisodes > 0) {
    console.log(`[DubCount] "${fallbackTitle}" is a COMPLETED DUB → all ${totalEpisodes} episodes dubbed`);
    
    // Save to cache for next time
    await db.collection("dubCache").doc(String(anilistId)).set({
      anilistId: anilistId,
      title: fallbackTitle,
      totalEpisodes: totalEpisodes,
      dubEpisodes: totalEpisodes,
      nextEpisode: null,
      nextEpisodeDate: null,
      isFinished: true,
      dubStatus: "completed",
      lastUpdated: new Date(),
    }, { merge: true });
    
    return {
      dubEpisodes: totalEpisodes,
      totalEpisodes: totalEpisodes,
      nextEpDate: null,
      isFinished: true,
    };
  }

  // Check ongoing timetable
  const timetable = await getDubTimetable() || [];
  let match = null;

  if (entry?.route) {
    match = timetable.find((t) => {
      const routeValueT = normalizeText(t.route || t.slug || t.route_slug || t.slug_name);
      return routeValueT && routeValueT === normalizeText(entry.route);
    });
  }

  if (!match) {
    match = timetable.find((t) => {
      if (t.anilistId && parseInt(t.anilistId) === parseInt(anilistId)) return true;
      if (t.anilist_id && parseInt(t.anilist_id) === parseInt(anilistId)) return true;
      if (t.anilistIds && Array.isArray(t.anilistIds) && t.anilistIds.map(String).includes(String(anilistId))) return true;
      return false;
    });
  }

  if (match) {
    const nextEpNum = match.episodeNumber || 0;
    const currentDubbed = Math.max(0, nextEpNum - 1);
    const nextEpDate = match.episodeDate ? new Date(match.episodeDate) : null;

    console.log(`[DubCount] ONGOING: "${fallbackTitle}" → ${currentDubbed} eps dubbed (next: ${nextEpNum})`);
    
    // Save to cache
    await db.collection("dubCache").doc(String(anilistId)).set({
      anilistId: anilistId,
      title: fallbackTitle,
      totalEpisodes: match.episodes || entry?.episodes || 0,
      dubEpisodes: currentDubbed,
      nextEpisode: nextEpNum,
      nextEpisodeDate: nextEpDate,
      isFinished: false,
      dubStatus: "ongoing",
      lastUpdated: new Date(),
    }, { merge: true });

    return {
      dubEpisodes: currentDubbed,
      totalEpisodes: match.episodes || entry?.episodes || null,
      nextEpDate,
      isFinished: false,
    };
  }

  console.log(`[DubCount] no dub data for "${fallbackTitle}"`);
  return null;
}

// ============================================================
// ====== BUILD FULL ANIME OBJECT =============================
// ============================================================
async function buildAnimeData(anime) {
  const title = anime.title.english || anime.title.romaji;
  const dubData = await getDubCount(anime.id, title);

  return {
    id: anime.id,
    title,
    image: anime.coverImage?.large || null,
    episodes: anime.episodes || dubData?.totalEpisodes || null,
    status: anime.status || "UNKNOWN",
    synopsis: cleanText(anime.description),
    dubEpisodes: dubData?.dubEpisodes ?? null,
    nextEpDate: dubData?.nextEpDate ?? null,
    isFinished: dubData?.isFinished ?? false,
    dubFound: dubData !== null,
  };
}

// ============================================================
// ====== FIREBASE HELPERS ====================================
// ============================================================
async function getTrackedList(userId) {
  try {
    const doc = await db.collection("users").doc(String(userId)).get();
    return doc.exists ? (doc.data().tracking || []) : [];
  } catch (err) { console.error("FB getList:", err.message); return []; }
}

async function saveTrackedList(userId, list) {
  try {
    await db.collection("users").doc(String(userId)).set({ tracking: list }, { merge: true });
  } catch (err) { console.error("FB saveList:", err.message); }
}

async function trackAnime(userId, data) {
  const list = await getTrackedList(userId);
  if (list.find((a) => a.id === data.id)) return false;
  list.push({
    id: data.id,
    title: data.title,
    dubEpisodes: data.dubEpisodes,
    lastEpisodeAlerted: data.dubEpisodes ?? 0,
  });
  await saveTrackedList(userId, list);
  return true;
}

async function untrackAnime(userId, animeId) {
  const list = await getTrackedList(userId);
  await saveTrackedList(userId, list.filter((a) => a.id !== parseInt(animeId)));
}

async function updateLastAlerted(userId, animeId, episode) {
  const list = await getTrackedList(userId);
  const item = list.find((a) => a.id === parseInt(animeId));
  if (item) { item.lastEpisodeAlerted = episode; item.dubEpisodes = episode; }
  await saveTrackedList(userId, list);
}

// ============================================================
// ====== FORMAT SEARCH RESULT MESSAGE ========================
// ============================================================
function formatAnimeMessage(data) {
  const statusLabel = {
    FINISHED: "Finished ✅",
    RELEASING: "Currently Airing 📡",
    NOT_YET_RELEASED: "Not Yet Released 🔜",
    CANCELLED: "Cancelled ❌",
  };

  let dubLine;
  if (!data.dubFound) {
    dubLine = `Not currently tracked \\(no English dub scheduled\\)`;
  } else if (data.isFinished) {
    dubLine = `All *${escMd(data.dubEpisodes)}* episodes available in English dub ✅`;
  } else if (data.dubEpisodes === 0) {
    dubLine = `Dub not started yet — Ep 1 coming soon`;
  } else {
    dubLine = `*${escMd(data.dubEpisodes)}* episode${data.dubEpisodes === 1 ? "" : "s"} available in English dub`;
  }

  const totalLine = data.episodes ? `*${escMd(data.episodes)}*` : "Unknown";

  return (
    `🎬 *${escMd(data.title)}*\n\n` +
    `📺 Total Episodes: ${totalLine}\n` +
    `📊 Status: ${escMd(statusLabel[data.status] || data.status)}\n\n` +
    `🇬🇧 *English Dub:*\n${dubLine}\n\n` +
    `📖 *Synopsis:*\n${escMd(data.synopsis)}`
  );
}

// ============================================================
// ====== /mylist MESSAGE BUILDER =============================
// ============================================================
function buildMyListMessage(list) {
  let text = `📋 *Your Tracked Anime \\(${escMd(list.length)}\\):*\n\n`;
  list.forEach((item, i) => {
    const dub = (item.dubEpisodes != null)
      ? `Ep *${escMd(item.dubEpisodes)}* dubbed`
      : "Dub unknown";
    text += `${i + 1}\\. *${escMd(item.title)}* — 🇬🇧 ${dub}\n`;
  });
  text += `\n_Tap below to untrack_`;
  const keyboard = list.map((item) => [
    { text: `🗑 Untrack: ${item.title}`, callback_data: `untrack_${item.id}` },
  ]);
  return { text, keyboard };
}

// ============================================================
// ====== /start & /help ======================================
// ============================================================
const welcomeText =
  `👋 *Welcome to Anime Dub Tracker\\!*\n\n` +
  `I show you how many English dubbed episodes are out right now, and alert you the moment a new dubbed episode drops\\.\n\n` +
  `*Commands:*\n` +
  `🔍 /search \\<name\\> — Search for an anime\n` +
  `📋 /mylist — View and manage your tracked anime\n` +
  `❓ /help — Show this message\n\n` +
  `_Dub data: AnimeSchedule\\.net_`;

bot.onText(/\/start/, (msg) =>
  bot.sendMessage(msg.chat.id, welcomeText, {
    parse_mode: "MarkdownV2",
    reply_markup: { remove_keyboard: true },
  })
);
bot.onText(/\/help/, (msg) =>
  bot.sendMessage(msg.chat.id, welcomeText, {
    parse_mode: "MarkdownV2",
    reply_markup: { remove_keyboard: true },
  })
);

// ============================================================
// ====== /search =============================================
// 🆕 UPDATED: Now includes streaming site buttons
// ============================================================
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1].trim();

  const placeholder = await bot.sendMessage(chatId,
    `🔍 Searching for *${escMd(query)}*\\.\\.\\.`,
    { parse_mode: "MarkdownV2" }
  );

  const anime = await getAnimeBySearch(query);
  await bot.deleteMessage(chatId, placeholder.message_id).catch(() => {});

  if (!anime) {
    return bot.sendMessage(chatId, "❌ Anime not found\\. Try a different spelling\\.", {
      parse_mode: "MarkdownV2",
    });
  }

  const data = await buildAnimeData(anime);
  const caption = formatAnimeMessage(data);
  
  // 🆕 Create keyboard with streaming buttons + track button
  const keyboard = createStreamingKeyboard(data.title, `track_${data.id}`);

  try {
    if (data.image) {
      await bot.sendPhoto(chatId, data.image, {
        caption, 
        parse_mode: "MarkdownV2", 
        reply_markup: keyboard,
      });
    } else throw new Error("no image");
  } catch {
    await bot.sendMessage(chatId, caption, { 
      parse_mode: "MarkdownV2", 
      reply_markup: keyboard,
    });
  }
});

// ============================================================
// ====== /mylist =============================================
// ============================================================
bot.onText(/\/mylist/, async (msg) => {
  const list = await getTrackedList(msg.from.id);
  if (list.length === 0) {
    return bot.sendMessage(msg.chat.id,
      "📭 *Your list is empty\\!*\n\nUse /search to find anime to track\\.",
      { parse_mode: "MarkdownV2" }
    );
  }
  const { text, keyboard } = buildMyListMessage(list);
  bot.sendMessage(msg.chat.id, text, {
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: keyboard },
  });
});

// ============================================================
// ====== CALLBACK QUERY ======================================
// 🆕 UPDATED: Added close_alert handler
// ============================================================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  // 🆕 Handle close alert button
  if (data === "close_alert") {
    await bot.answerCallbackQuery(q.id, { text: "Closed" });
    try {
      await bot.deleteMessage(chatId, q.message.message_id);
    } catch (_) {}
    return;
  }

  if (data.startsWith("track_")) {
    const animeId = parseInt(data.split("_")[1]);
    const anime = await getAnimeById(animeId);
    if (!anime) {
      return bot.answerCallbackQuery(q.id, { text: "❌ Could not fetch data.", show_alert: true });
    }
    const animeData = await buildAnimeData(anime);
    const added = await trackAnime(userId, animeData);
    if (added) {
      await bot.answerCallbackQuery(q.id, {
        text: `✅ "${animeData.title}" is now tracked!`, show_alert: true,
      });
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "✅ Tracked!", callback_data: `noop_${animeId}` }]] },
          { chat_id: chatId, message_id: q.message.message_id }
        );
      } catch (_) {}
    } else {
      await bot.answerCallbackQuery(q.id, { text: "📌 Already in your list!", show_alert: false });
    }
    return;
  }

  if (data.startsWith("untrack_")) {
    const animeId = parseInt(data.split("_")[1]);
    await untrackAnime(userId, animeId);
    await bot.answerCallbackQuery(q.id, { text: "🗑 Removed.", show_alert: false });
    const newList = await getTrackedList(userId);
    try {
      if (newList.length === 0) {
        await bot.editMessageText(
          "📭 *Your list is now empty\\!*\n\nUse /search to find anime to track\\.",
          { chat_id: chatId, message_id: q.message.message_id, parse_mode: "MarkdownV2", reply_markup: { inline_keyboard: [] } }
        );
      } else {
        const { text, keyboard } = buildMyListMessage(newList);
        await bot.editMessageText(text, {
          chat_id: chatId, message_id: q.message.message_id,
          parse_mode: "MarkdownV2", reply_markup: { inline_keyboard: keyboard },
        });
      }
    } catch (_) {}
    return;
  }

  if (data.startsWith("noop_")) {
    return bot.answerCallbackQuery(q.id, { text: "Already tracked ✅", show_alert: false });
  }

  await bot.answerCallbackQuery(q.id, { text: "Unknown action." });
});

// ============================================================
// ====== ALERT CRON (every 30 min) ===========================
// 🆕 UPDATED: Alert messages now include streaming buttons
// ============================================================
cron.schedule("*/30 * * * *", async () => {
  safeLog("🔔 Checking for new dubbed episodes...");

  let snapshot;
  try { snapshot = await db.collection("users").get(); }
  catch (err) { console.error("Firestore error:", err.message); return; }

  for (const doc of snapshot.docs) {
    const userId = doc.id;
    const list = doc.data().tracking || [];

    for (const tracked of list) {
      try {
        let currentDub = null;
        
        // FIRST: Check dubCache
        const cacheDoc = await db.collection("dubCache").doc(String(tracked.id)).get();
        
        if (cacheDoc.exists) {
          const cached = cacheDoc.data();
          currentDub = cached.dubEpisodes;
          console.log(`[Alert] Using cached dub count for ${tracked.title}: ${currentDub}`);
        } else {
          // FALLBACK: Check API directly
          const entry = await getAnimeScheduleEntry(tracked.id);
          
          if (entry?.status?.toLowerCase() === "finished" && entry?.dubPremier && entry?.dubPremier !== "0001-01-01T00:00:00Z" && entry?.episodes > 0) {
            currentDub = entry.episodes;
          } else if (entry?.route) {
            const timetable = await getDubTimetable();
            const match = timetable.find((t) => t.route === entry.route);
            if (match) currentDub = Math.max(0, (match.episodeNumber || 1) - 1);
          }
        }

        if (currentDub === null) continue;

        const lastAlerted = tracked.lastEpisodeAlerted ?? 0;

        if (currentDub > lastAlerted) {
          // 🆕 Create keyboard with streaming buttons for the alert
          const alertKeyboard = createAlertKeyboard(tracked.title);
          
          await bot.sendMessage(
            userId,
            `🚨 *New Dubbed Episode Alert\\!*\n\n` +
            `🎬 *${escMd(tracked.title)}*\n\n` +
            `🇬🇧 Episode *${escMd(currentDub)}* is now available in English dub\\!\n\n` +
            `🔗 *Watch now:*\n` +
            `_Click a button below to start watching_`,
            { 
              parse_mode: "MarkdownV2",
              reply_markup: alertKeyboard,
            }
          );
          await updateLastAlerted(userId, tracked.id, currentDub);
        }
      } catch (err) {
        console.error(`Alert error for ${tracked.id}:`, err.message);
      }
    }
  }
});

// ============================================================
// ====== GLOBAL ERROR HANDLERS ===============================
// ============================================================
bot.on("polling_error", (err) => console.error("Polling error:", err.message));
process.on("unhandledRejection", (r) => console.error("Unhandled rejection:", r));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err.message));

console.log("✅ Bot started successfully!");