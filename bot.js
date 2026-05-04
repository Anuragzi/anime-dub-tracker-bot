// ============================================================
// ====== ANIME DUB TRACKER BOT — bot.js =====================
// ============================================================
// HOW DUB COUNT WORKS (important to understand):
//
// PRIORITY 1: Read from dubCache (Firestore) - FAST
// PRIORITY 2: Read from dub_updates (Firestore) - from collector
// PRIORITY 3: Fall back to AnimeSchedule API - SLOW (only when cache missing)
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

// Delete any existing webhook to prevent 409 conflict error
axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/deleteWebhook`)
  .catch(err => console.log("Webhook delete error:", err.message));

bot.getMe().then((me) => console.log(`🤖 Bot: @${me.username}`));

bot.setMyCommands([
  {
    command: "search",
    description: "🔍 Search for an anime by title"
  },
  {
    command: "mylist",
    description: "📋 View your tracked anime list"
  },
  {
    command: "donate",
    description: "💚 Support the developer"
  },
  {
    command: "help",
    description: "❓ Show help message"
  },
  {
    command: "start",
    description: "👋 Start the bot"
  }
]).then(() => {
  console.log("✅ Command menu set successfully!");
});

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

// FIXED: Escape ALL special Telegram MarkdownV2 characters
function escMd(t) {
  if (t == null) return "";
  return String(t).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function normalizeText(text) {
  return (text || "").toString().toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// ============================================================
// ====== CACHE FOR SIMILAR ANIMES ============================
// ============================================================
const similarCache = new Map();

// ============================================================
// ====== SIMILAR ANIMES FUNCTION =============================
// ============================================================
async function getSimilarAnimes(animeId) {
  if (similarCache.has(animeId)) {
    return similarCache.get(animeId);
  }
  
  try {
    const animeData = await axios.post(
      "https://graphql.anilist.co",
      {
        query: `query ($id: Int) {
          Media(id: $id, type: ANIME) {
            genres
            title { english romaji }
          }
        }`,
        variables: { id: parseInt(animeId) },
      },
      { timeout: 10000 }
    );

    const genres = animeData.data?.data?.Media?.genres || [];
    const originalTitle = animeData.data?.data?.Media?.title?.english || 
                          animeData.data?.data?.Media?.title?.romaji || 
                          "Unknown";
    
    if (genres.length === 0) return { results: [], originalTitle };

    const searchQuery = `query ($genres: [String], $excludeId: Int) {
      Page(page: 1, perPage: 6) {
        media(genre_in: $genres, type: ANIME, id_not: $excludeId, sort: POPULARITY_DESC) {
          id
          title { english romaji }
          genres
          episodes
          coverImage { large }
        }
      }
    }`;

    const similarRes = await axios.post(
      "https://graphql.anilist.co",
      {
        query: searchQuery,
        variables: { genres: genres, excludeId: parseInt(animeId) },
      },
      { timeout: 10000 }
    );

    const similarAnimes = similarRes.data?.data?.Page?.media || [];
    
    const results = similarAnimes.slice(0, 3).map(anime => ({
      id: anime.id,
      title: anime.title.english || anime.title.romaji || "Unknown",
      episodes: anime.episodes
    }));
    
    similarCache.set(animeId, { results, originalTitle });
    setTimeout(() => similarCache.delete(animeId), 3600000);
    
    return { results, originalTitle };
    
  } catch (err) {
    console.error("Similar animes error:", err.message);
    return { results: [], originalTitle: "Unknown" };
  }
}

// ============================================================
// ====== DONATE MESSAGE ======================================
// ============================================================
function sendDonateMessage(chatId, editMessageId = null) {
  const donateText = 
    `💚 *Support Anime Dub Tracker*\n\n` +
    `If you find this bot useful, please consider supporting its development.\n\n` +
    `📱 *UPI ID:* \`clnishadaca@ybl\`\n\n` +
    `💳 *PhonePe QR:* Scan using PhonePe app\n\n` +
    `*Thank you for your support!* 🙏\n\n` +
    `_Every contribution helps keep the bot running!_`;
  
  const donateKeyboard = {
    inline_keyboard: [
      [{ text: "💚 Send Donation (UPI)", callback_data: "upi_donate" }],
      [{ text: "❌ Close", callback_data: "close_donate" }]
    ]
  };
  
  if (editMessageId) {
    bot.editMessageText(donateText, {
      chat_id: chatId,
      message_id: editMessageId,
      parse_mode: "MarkdownV2",
      reply_markup: donateKeyboard
    }).catch(() => {});
  } else {
    bot.sendMessage(chatId, donateText, { 
      parse_mode: "MarkdownV2", 
      reply_markup: donateKeyboard 
    });
  }
}

// ============================================================
// ====== STREAMING SITE HELPERS ==============================
// ============================================================
function getSearchQuery(title) {
  let query = title
    .toLowerCase()
    .replace(/[′'’]/g, "'")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  
  return {
    hyphen: query.replace(/ /g, "-"),
    plus: query.replace(/ /g, "+"),
    encoded: encodeURIComponent(query),
  };
}

function getStreamingUrl(animeTitle) {
  return null;
}

function createStreamingKeyboard(animeTitle, animeId, trackCallbackData = null) {
  const rows = [];
  if (trackCallbackData) {
    rows.push([{ text: "📌 Track this anime", callback_data: trackCallbackData }]);
  }
  rows.push([{ text: "🎲 Similar Animes", callback_data: `similar_${animeId}` }]);
  rows.push([{ text: "💚 Support / Donate", callback_data: "show_donate" }]);
  return { inline_keyboard: rows };
}

function createAlertKeyboard(animeTitle) {
  const rows = [[{ text: "❌ Close", callback_data: "close_alert" }]];
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
            id title { romaji english } episodes status description coverImage { large } genres
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

async function getAnimeById(id) {
  try {
    const res = await axios.post(
      "https://graphql.anilist.co",
      {
        query: `query ($id: Int) {
          Media(id: $id, type: ANIME) {
            id title { romaji english } episodes status description coverImage { large } genres
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

function hasValidDubPremier(entry) {
  if (!entry || !entry.dubPremier) return false;
  return entry.dubPremier !== "0001-01-01T00:00:00Z";
}

// ============================================================
// ====== GET DUB FROM DUB_UPDATES COLLECTION =================
// ============================================================
async function getDubFromUpdatesCollection(anilistId, title) {
  try {
    const normalizedTitle = title.toLowerCase();
    const snapshot = await db.collection("dub_updates")
      .where("normalizedTitle", "==", normalizedTitle)
      .limit(1)
      .get();
    
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      const data = doc.data();
      console.log(`[DubCount] ✅ Found in dub_updates for "${title}" → ${data.episode || data.totalEpisodes || 'unknown'}`);
      return data;
    }
    return null;
  } catch (err) {
    console.log(`[DubCount] dub_updates query failed for ${title}:`, err.message);
    return null;
  }
}

// ============================================================
// ====== MASTER DUB LOOKUP ===================================
// ============================================================
async function getDubCount(anilistId, fallbackTitle) {
  try {
    const cacheDoc = await db.collection("dubCache").doc(String(anilistId)).get();
    
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      
      if (cached.dubEpisodes !== undefined && cached.dubEpisodes !== null) {
        console.log(`[DubCount] ✅ Using CACHED data for "${fallbackTitle}" → ${cached.dubEpisodes} eps dubbed`);
        
        return {
          dubEpisodes: cached.dubEpisodes,
          totalEpisodes: cached.totalEpisodes,
          nextEpDate: cached.nextEpisodeDate,
          isFinished: cached.isFinished || false,
        };
      }
    }
  } catch (err) {
    console.log(`[DubCount] Cache check failed for ${fallbackTitle}:`, err.message);
  }
  
  try {
    const updatesData = await getDubFromUpdatesCollection(anilistId, fallbackTitle);
    
    if (updatesData) {
      let dubEpisodes = updatesData.episode || updatesData.totalEpisodes || updatesData.dubEpisodes || null;
      let totalEpisodes = updatesData.totalEpisodes || updatesData.episodes || null;
      const isFinished = updatesData.status === "completed" || updatesData.isFinished === true;
      const nextEpDate = updatesData.nextEpisodeDate || updatesData.releaseDate || null;
      
      console.log(`[DubCount] ✅ Using dub_updates data for "${fallbackTitle}" → ${dubEpisodes} eps dubbed`);
      
      await db.collection("dubCache").doc(String(anilistId)).set({
        anilistId: anilistId,
        title: fallbackTitle,
        totalEpisodes: totalEpisodes,
        dubEpisodes: dubEpisodes,
        nextEpisodeDate: nextEpDate,
        isFinished: isFinished,
        dubStatus: isFinished ? "completed" : (dubEpisodes ? "ongoing" : "pending"),
        source: "dub_updates",
        lastUpdated: new Date(),
      }, { merge: true });
      
      return {
        dubEpisodes: dubEpisodes,
        totalEpisodes: totalEpisodes,
        nextEpDate: nextEpDate,
        isFinished: isFinished,
      };
    }
  } catch (err) {
    console.log(`[DubCount] dub_updates check failed for ${fallbackTitle}:`, err.message);
  }
  
  if (!process.env.ANIMESCHEDULE_KEY) return null;

  const entry = await getAnimeScheduleEntry(anilistId);
  
  if (!entry) {
    console.log(`[DubCount] no AnimeSchedule entry for "${fallbackTitle}"`);
    return null;
  }

  const isFinished = entry.status?.toLowerCase() === "finished";
  const hasDub = hasValidDubPremier(entry);
  const totalEpisodes = entry.episodes || 0;
  
  if (isFinished && hasDub && totalEpisodes > 0) {
    console.log(`[DubCount] "${fallbackTitle}" is a COMPLETED DUB → all ${totalEpisodes} episodes dubbed`);
    
    await db.collection("dubCache").doc(String(anilistId)).set({
      anilistId: anilistId,
      title: fallbackTitle,
      totalEpisodes: totalEpisodes,
      dubEpisodes: totalEpisodes,
      nextEpisode: null,
      nextEpisodeDate: null,
      isFinished: true,
      dubStatus: "completed",
      source: "animeschedule",
      lastUpdated: new Date(),
    }, { merge: true });
    
    return {
      dubEpisodes: totalEpisodes,
      totalEpisodes: totalEpisodes,
      nextEpDate: null,
      isFinished: true,
    };
  }

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
    
    await db.collection("dubCache").doc(String(anilistId)).set({
      anilistId: anilistId,
      title: fallbackTitle,
      totalEpisodes: match.episodes || entry?.episodes || 0,
      dubEpisodes: currentDubbed,
      nextEpisode: nextEpNum,
      nextEpisodeDate: nextEpDate,
      isFinished: false,
      dubStatus: "ongoing",
      source: "animeschedule",
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
    genres: anime.genres || []
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
// ====== SIMILAR ANIMES MESSAGE ==============================
// ============================================================
function formatSimilarMessage(similarData) {
  const { results, originalTitle } = similarData;
  
  if (results.length === 0) {
    return `🔍 No similar animes found for *${escMd(originalTitle)}*.`;
  }
  
  let message = `🎲 *Similar to ${escMd(originalTitle)}:*\n\n`;
  results.forEach((anime, index) => {
    const escapedTitle = escMd(anime.title);
    message += `${index + 1}\\. *${escapedTitle}*\n`;
    if (anime.episodes) message += `   📺 ${anime.episodes} episodes\n`;
    const searchCmd = escapedTitle.replace(/\\/g, "").replace(/\s+/g, "_");
    message += `   🔍 /search_${searchCmd}\n\n`;
  });
  message += `_Tap /search_<name> to search any anime_`;
  
  return message;
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
  `💚 /donate — Support the developer\n` +
  `❓ /help — Show this message\n\n` +
  `_Dub data: AnimeSchedule\\.net & MAL Forum_`;

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

bot.onText(/\/donate/, (msg) => {
  sendDonateMessage(msg.chat.id);
});

// ============================================================
// ====== /search - WITH FORCE REPLY ==========================
// ============================================================

bot.onText(/\/search$/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, "🔍 Please type the anime name you want to search for:", {
    reply_markup: { force_reply: true, selective: true }
  });
});

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
  const keyboard = createStreamingKeyboard(data.title, data.id, `track_${data.id}`);

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

// Handle /search_<title> from similar animes
bot.onText(/\/search_(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  let query = match[1].trim().replace(/_/g, " ");
  
  try {
    query = decodeURIComponent(query);
  } catch(e) {}
  
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
  const keyboard = createStreamingKeyboard(data.title, data.id, `track_${data.id}`);

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

bot.on("message", async (msg) => {
  if (msg.reply_to_message && msg.reply_to_message.text === "🔍 Please type the anime name you want to search for:") {
    const chatId = msg.chat.id;
    const query = msg.text.trim();
    
    if (!query || query.startsWith("/")) return;
    
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
    const keyboard = createStreamingKeyboard(data.title, data.id, `track_${data.id}`);

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
// ============================================================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  if (data === "close_alert" || data === "close_donate") {
    await bot.answerCallbackQuery(q.id, { text: "Closed" });
    try {
      await bot.deleteMessage(chatId, q.message.message_id);
    } catch (_) {}
    return;
  }

  if (data === "show_donate") {
    await bot.answerCallbackQuery(q.id);
    sendDonateMessage(chatId);
    return;
  }

  if (data === "upi_donate") {
    await bot.answerCallbackQuery(q.id, { 
      text: "UPI ID: clnishadaca@ybl\nOpen PhonePe/Google Pay and send donation.",
      show_alert: true 
    });
    return;
  }

  if (data.startsWith("similar_")) {
    await bot.answerCallbackQuery(q.id);
    const animeId = parseInt(data.split("_")[1]);
    
    const similarMsg = await bot.sendMessage(chatId, "🔍 Finding similar animes...");
    
    const similarData = await getSimilarAnimes(animeId);
    const similarText = formatSimilarMessage(similarData);
    
    await bot.editMessageText(similarText, {
      chat_id: chatId,
      message_id: similarMsg.message_id,
      parse_mode: "MarkdownV2"
    });
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
        
        const cacheDoc = await db.collection("dubCache").doc(String(tracked.id)).get();
        
        if (cacheDoc.exists) {
          const cached = cacheDoc.data();
          currentDub = cached.dubEpisodes;
          console.log(`[Alert] Using cached dub count for ${tracked.title}: ${currentDub}`);
        } else {
          const updatesData = await getDubFromUpdatesCollection(tracked.id, tracked.title);
          if (updatesData) {
            currentDub = updatesData.episode || updatesData.totalEpisodes || updatesData.dubEpisodes;
            console.log(`[Alert] Using dub_updates for ${tracked.title}: ${currentDub}`);
          } else {
            const entry = await getAnimeScheduleEntry(tracked.id);
            
            if (entry?.status?.toLowerCase() === "finished" && entry?.dubPremier && entry?.dubPremier !== "0001-01-01T00:00:00Z" && entry?.episodes > 0) {
              currentDub = entry.episodes;
            } else if (entry?.route) {
              const timetable = await getDubTimetable();
              const match = timetable.find((t) => t.route === entry.route);
              if (match) currentDub = Math.max(0, (match.episodeNumber || 1) - 1);
            }
          }
        }

        if (currentDub === null) continue;

        const lastAlerted = tracked.lastEpisodeAlerted ?? 0;

        if (currentDub > lastAlerted) {
          const alertKeyboard = createAlertKeyboard(tracked.title);
          
          await bot.sendMessage(
            userId,
            `🚨 *New Dubbed Episode Alert\\!*\n\n` +
            `🎬 *${escMd(tracked.title)}*\n\n` +
            `🇬🇧 Episode *${escMd(currentDub)}* is now available in English dub\\!\n\n` +
            `🔗 *Check your streaming service for availability*`,
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