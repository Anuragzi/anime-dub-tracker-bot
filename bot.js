// ============================================================
// ====== ANIME DUB TRACKER BOT — bot.js =====================
// ====== FIXED: HTML parsing, no 409 conflict ================
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
if (!process.env.BOT_TOKEN) { 
  console.error("❌ BOT_TOKEN missing"); 
  process.exit(1); 
}
if (!process.env.ANIMESCHEDULE_KEY) console.warn("⚠️ ANIMESCHEDULE_KEY not set");

// ============================================================
// ====== FIX 409 CONFLICT - Proper webhook cleanup ===========
// ============================================================
async function initBot() {
  console.log("🔧 Initializing bot...");
  
  // Delete webhook and drop pending updates
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/deleteWebhook`, {
      drop_pending_updates: true
    });
    console.log("✅ Webhook deleted");
  } catch (err) {
    console.log("Webhook delete error:", err.message);
  }
  
  // Wait a bit for Telegram to process
  await sleep(2000);
  
  // Create bot with polling options to prevent conflicts
  const bot = new TelegramBot(process.env.BOT_TOKEN, { 
    polling: {
      interval: 300,
      autoStart: false,
      params: {
        timeout: 10
      }
    }
  });
  
  // Start polling with error handling
  bot.startPolling();
  console.log("✅ Polling started");
  
  return bot;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Global bot variable
let bot;

// Start bot
initBot().then(async (b) => {
  bot = b;
  
  bot.getMe().then((me) => console.log(`🤖 Bot: @${me.username}`));
  
  await bot.setMyCommands([
    { command: "search",  description: "🔍 Search for an anime by title" },
    { command: "mylist",  description: "📋 View your tracked anime list" },
    { command: "donate",  description: "💚 Support the developer" },
    { command: "help",    description: "❓ Show help message" },
    { command: "start",   description: "👋 Start the bot" },
  ]).then(() => console.log("✅ Command menu set successfully!"));
  
  // Setup all handlers
  setupHandlers();
  
  console.log("✅ Bot started successfully!");
}).catch(err => {
  console.error("❌ Failed to start bot:", err.message);
  process.exit(1);
});

// ====== UTILS ======
function cleanText(t) {
  if (!t) return "No synopsis available.";
  return t.replace(/<[^>]*>/g, "").trim().slice(0, 350);
}

// HTML escape (much simpler than Markdown)
function htmlEscape(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeText(text) {
  return (text || "").toString().toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// ============================================================
// ====== DONATE MESSAGE (HTML - NO PARSING ISSUES) ===========
// ============================================================
async function sendDonateMessage(chatId, editMessageId = null) {
  const donateText = 
    `💚 <b>Support Anime Dub Tracker</b>\n\n` +
    `If you find this bot useful, please consider supporting its development.\n\n` +
    `📱 <b>UPI ID:</b> <code>clnishadaca@ybl</code>\n\n` +
    `Thank you for your support! 🙏`;

  const donateKeyboard = {
    inline_keyboard: [
      [{ text: "❌ Close", callback_data: "close_donate" }]
    ]
  };
  
  try {
    if (editMessageId) {
      await bot.editMessageText(donateText, {
        chat_id: chatId,
        message_id: editMessageId,
        parse_mode: "HTML",
        reply_markup: donateKeyboard
      });
    } else {
      await bot.sendMessage(chatId, donateText, { 
        parse_mode: "HTML", 
        reply_markup: donateKeyboard 
      });
    }
  } catch (err) {
    console.error("Donate error:", err.message);
    // Fallback without HTML
    await bot.sendMessage(chatId, donateText.replace(/<[^>]*>/g, ''));
  }
}

// ============================================================
// ====== KEYBOARD (NO SIMILAR ANIMES) ========================
// ============================================================
function createStreamingKeyboard(animeTitle, animeId, trackCallbackData = null) {
  const rows = [];
  if (trackCallbackData) {
    rows.push([{ text: "📌 Track this anime", callback_data: trackCallbackData }]);
  }
  rows.push([{ text: "💚 Donate", callback_data: "show_donate" }]);
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
// ====== ANIMESCHEDULE API ===================================
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
      console.log(`[AS /anime] id=${anilistId} route="${entry.route}" status="${entry.status}" episodes=${entry.episodes}`);
    }
    return entry || null;
  } catch (err) {
    console.error(`[AS /anime] error: ${err.message}`);
    return null;
  }
}

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
    }
    return entries;
  } catch (err) {
    console.error(`[AS timetable] error: ${err.message}`);
    return [];
  }
}

async function getDubFromUpdatesCollection(anilistId, title) {
  try {
    const normalizedTitle = title.toLowerCase();
    const snapshot = await db.collection("dub_updates")
      .where("normalizedTitle", "==", normalizedTitle)
      .limit(1)
      .get();
    
    if (!snapshot.empty) {
      const data = snapshot.docs[0].data();
      return data;
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function getDubCount(anilistId, fallbackTitle) {
  try {
    const cacheDoc = await db.collection("dubCache").doc(String(anilistId)).get();
    
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      if (cached.dubEpisodes !== undefined && cached.dubEpisodes !== null) {
        return {
          dubEpisodes: cached.dubEpisodes,
          totalEpisodes: cached.totalEpisodes,
          nextEpDate: cached.nextEpisodeDate,
          isFinished: cached.isFinished || false,
        };
      }
    }
  } catch (err) {}
  
  try {
    const updatesData = await getDubFromUpdatesCollection(anilistId, fallbackTitle);
    if (updatesData) {
      let dubEpisodes = updatesData.episode || updatesData.totalEpisodes || updatesData.dubEpisodes || null;
      let totalEpisodes = updatesData.totalEpisodes || updatesData.episodes || null;
      const isFinished = updatesData.status === "completed";
      
      await db.collection("dubCache").doc(String(anilistId)).set({
        anilistId: anilistId,
        title: fallbackTitle,
        totalEpisodes: totalEpisodes,
        dubEpisodes: dubEpisodes,
        isFinished: isFinished,
        lastUpdated: new Date(),
      }, { merge: true });
      
      return {
        dubEpisodes: dubEpisodes,
        totalEpisodes: totalEpisodes,
        nextEpDate: null,
        isFinished: isFinished,
      };
    }
  } catch (err) {}

  if (!process.env.ANIMESCHEDULE_KEY) return null;

  const entry = await getAnimeScheduleEntry(anilistId);
  if (!entry) return null;

  const isFinished = entry.status?.toLowerCase() === "finished";
  const totalEpisodes = entry.episodes || 0;
  
  if (isFinished && entry.dubPremier && totalEpisodes > 0) {
    await db.collection("dubCache").doc(String(anilistId)).set({
      anilistId: anilistId,
      title: fallbackTitle,
      totalEpisodes: totalEpisodes,
      dubEpisodes: totalEpisodes,
      isFinished: true,
      lastUpdated: new Date(),
    }, { merge: true });
    
    return {
      dubEpisodes: totalEpisodes,
      totalEpisodes: totalEpisodes,
      nextEpDate: null,
      isFinished: true,
    };
  }

  const timetable = await getDubTimetable();
  let match = null;

  if (entry?.route) {
    match = timetable.find((t) => {
      const routeValueT = normalizeText(t.route || t.slug);
      return routeValueT && routeValueT === normalizeText(entry.route);
    });
  }

  if (!match) {
    match = timetable.find((t) => {
      if (t.anilistId && parseInt(t.anilistId) === parseInt(anilistId)) return true;
      if (t.anilist_id && parseInt(t.anilist_id) === parseInt(anilistId)) return true;
      return false;
    });
  }

  if (match) {
    const nextEpNum = match.episodeNumber || 0;
    const currentDubbed = Math.max(0, nextEpNum - 1);
    
    await db.collection("dubCache").doc(String(anilistId)).set({
      anilistId: anilistId,
      title: fallbackTitle,
      totalEpisodes: match.episodes || entry?.episodes || 0,
      dubEpisodes: currentDubbed,
      isFinished: false,
      lastUpdated: new Date(),
    }, { merge: true });

    return {
      dubEpisodes: currentDubbed,
      totalEpisodes: match.episodes || entry?.episodes || null,
      nextEpDate: null,
      isFinished: false,
    };
  }

  return null;
}

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
// ====== FORMAT SEARCH RESULT MESSAGE (HTML) =================
// ============================================================
function formatAnimeMessage(data) {
  const statusLabel = {
    FINISHED: "Finished ✅",
    RELEASING: "Currently Airing 📡",
    NOT_YET_RELEASED: "Not Yet Released 🔜",
    CANCELLED: "Cancelled ❌",
  };

  const title = htmlEscape(data.title);
  const synopsis = htmlEscape(data.synopsis);
  const status = htmlEscape(statusLabel[data.status] || data.status);
  const totalEp = data.episodes ? htmlEscape(String(data.episodes)) : "Unknown";
  
  let dubLine;
  if (!data.dubFound) {
    dubLine = `Not currently tracked (no English dub scheduled)`;
  } else if (data.isFinished) {
    dubLine = `All <b>${htmlEscape(String(data.dubEpisodes))}</b> episodes available in English dub ✅`;
  } else if (data.dubEpisodes === 0) {
    dubLine = `Dub not started yet — Ep 1 coming soon`;
  } else {
    dubLine = `<b>${htmlEscape(String(data.dubEpisodes))}</b> episode${data.dubEpisodes === 1 ? "" : "s"} available in English dub`;
  }

  return (
    `🎬 <b>${title}</b>\n\n` +
    `📺 Total Episodes: ${totalEp}\n` +
    `📊 Status: ${status}\n\n` +
    `🇬🇧 <b>English Dub:</b>\n${dubLine}\n\n` +
    `📖 <b>Synopsis:</b>\n${synopsis}`
  );
}

function buildMyListMessage(list) {
  let text = `📋 <b>Your Tracked Anime (${list.length})</b>\n\n`;
  list.forEach((item, i) => {
    const dub = (item.dubEpisodes != null)
      ? `Ep <b>${htmlEscape(String(item.dubEpisodes))}</b> dubbed`
      : "Dub unknown";
    text += `${i + 1}. <b>${htmlEscape(item.title)}</b> — 🇬🇧 ${dub}\n`;
  });
  text += `\n<i>Tap below to untrack</i>`;
  const keyboard = list.map((item) => [
    { text: `🗑 Untrack: ${item.title}`, callback_data: `untrack_${item.id}` },
  ]);
  return { text, keyboard };
}

// ============================================================
// ====== COMMAND HANDLERS ====================================
// ============================================================
const welcomeText =
  `👋 <b>Welcome to Anime Dub Tracker!</b>\n\n` +
  `I show you how many English dubbed episodes are out right now, and alert you the moment a new dubbed episode drops.\n\n` +
  `<b>Commands:</b>\n` +
  `🔍 /search &lt;name&gt; — Search for an anime\n` +
  `📋 /mylist — View and manage your tracked anime\n` +
  `💚 /donate — Support the developer\n` +
  `❓ /help — Show this message\n\n` +
  `<i>Dub data: AnimeSchedule.net &amp; MAL Forum</i>`;

function setupHandlers() {
  
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, welcomeText, {
      parse_mode: "HTML",
      reply_markup: { remove_keyboard: true },
    }).catch(err => console.error("Start error:", err.message));
  });
  
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, welcomeText, {
      parse_mode: "HTML",
      reply_markup: { remove_keyboard: true },
    }).catch(err => console.error("Help error:", err.message));
  });

  bot.onText(/\/donate/, (msg) => {
    sendDonateMessage(msg.chat.id);
  });

  // ====== /search - WITH FORCE REPLY ======
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
      `🔍 Searching for <b>${htmlEscape(query)}</b>...`,
      { parse_mode: "HTML" }
    );

    const anime = await getAnimeBySearch(query);
    await bot.deleteMessage(chatId, placeholder.message_id).catch(() => {});

    if (!anime) {
      return bot.sendMessage(chatId, "❌ Anime not found. Try a different spelling.", {
        parse_mode: "HTML",
      });
    }

    const data = await buildAnimeData(anime);
    const caption = formatAnimeMessage(data);
    const keyboard = createStreamingKeyboard(data.title, data.id, `track_${data.id}`);

    try {
      if (data.image) {
        await bot.sendPhoto(chatId, data.image, {
          caption, 
          parse_mode: "HTML", 
          reply_markup: keyboard,
        });
      } else throw new Error("no image");
    } catch {
      await bot.sendMessage(chatId, caption, { 
        parse_mode: "HTML", 
        reply_markup: keyboard,
      });
    }
  });

  // Handle reply to search prompt
  bot.on("message", async (msg) => {
    if (msg.reply_to_message && msg.reply_to_message.text === "🔍 Please type the anime name you want to search for:") {
      const chatId = msg.chat.id;
      const query = msg.text.trim();
      
      if (!query || query.startsWith("/")) return;
      
      const placeholder = await bot.sendMessage(chatId,
        `🔍 Searching for <b>${htmlEscape(query)}</b>...`,
        { parse_mode: "HTML" }
      );

      const anime = await getAnimeBySearch(query);
      await bot.deleteMessage(chatId, placeholder.message_id).catch(() => {});

      if (!anime) {
        return bot.sendMessage(chatId, "❌ Anime not found. Try a different spelling.", {
          parse_mode: "HTML",
        });
      }

      const data = await buildAnimeData(anime);
      const caption = formatAnimeMessage(data);
      const keyboard = createStreamingKeyboard(data.title, data.id, `track_${data.id}`);

      try {
        if (data.image) {
          await bot.sendPhoto(chatId, data.image, {
            caption, 
            parse_mode: "HTML", 
            reply_markup: keyboard,
          });
        } else throw new Error("no image");
      } catch {
        await bot.sendMessage(chatId, caption, { 
          parse_mode: "HTML", 
          reply_markup: keyboard,
        });
      }
    }
  });

  // ====== /mylist ======
  bot.onText(/\/mylist/, async (msg) => {
    const list = await getTrackedList(msg.from.id);
    if (list.length === 0) {
      return bot.sendMessage(msg.chat.id,
        "📭 Your list is empty!\n\nUse /search to find anime to track.",
        { parse_mode: "HTML" }
      );
    }
    const { text, keyboard } = buildMyListMessage(list);
    bot.sendMessage(msg.chat.id, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    }).catch(err => console.error("Mylist error:", err.message));
  });

  // ====== CALLBACK QUERY ======
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
      await sendDonateMessage(chatId);
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
            "📭 Your list is now empty!\n\nUse /search to find anime to track.",
            { chat_id: chatId, message_id: q.message.message_id, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
          );
        } else {
          const { text, keyboard } = buildMyListMessage(newList);
          await bot.editMessageText(text, {
            chat_id: chatId, message_id: q.message.message_id,
            parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard },
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

  // ====== ALERT CRON (every 30 min) ======
  cron.schedule("*/30 * * * *", async () => {
    console.log("🔔 Checking for new dubbed episodes...");

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
          } else {
            const updatesData = await getDubFromUpdatesCollection(tracked.id, tracked.title);
            if (updatesData) {
              currentDub = updatesData.episode || updatesData.totalEpisodes || updatesData.dubEpisodes;
            }
          }

          if (currentDub === null) continue;

          const lastAlerted = tracked.lastEpisodeAlerted ?? 0;

          if (currentDub > lastAlerted) {
            const alertKeyboard = createAlertKeyboard(tracked.title);
            
            await bot.sendMessage(
              userId,
              `🚨 <b>New Dubbed Episode Alert!</b>\n\n` +
              `🎬 <b>${htmlEscape(tracked.title)}</b>\n\n` +
              `🇬🇧 Episode <b>${htmlEscape(String(currentDub))}</b> is now available in English dub!\n\n` +
              `🔗 Check your streaming service for availability`,
              { 
                parse_mode: "HTML",
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
}

// ============================================================
// ====== GLOBAL ERROR HANDLERS ===============================
// ============================================================
bot?.on("polling_error", (err) => console.error("Polling error:", err.message));
process.on("unhandledRejection", (r) => console.error("Unhandled rejection:", r));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err.message));