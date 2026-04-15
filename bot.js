// ============================================================
// ====== ANIME DUB TRACKER BOT — bot.js (FULLY FIXED) =======
// ============================================================

// ====== LOAD ENV ======
require("dotenv").config();

// ====== EXPRESS (RAILWAY KEEP-ALIVE) ======
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("🚀 Anime Dub Tracker Bot is running!"));
app.listen(process.env.PORT || 3000, () =>
  console.log("✅ Express server live on port", process.env.PORT || 3000)
);

// ====== IMPORTS ======
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cron = require("node-cron");
const admin = require("firebase-admin");

// ============================================================
// ====== FIREBASE INIT (merged from your firebase.js) ========
// ============================================================
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
  console.error("❌ FIREBASE_KEY env variable is missing or invalid JSON");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
console.log("✅ Firebase connected");

// ============================================================
// ====== BOT INIT ============================================
// ============================================================
if (!process.env.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing from environment variables");
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
bot.getMe().then((me) => console.log(`🤖 Bot running as @${me.username}`));

// ============================================================
// ====== SAFE LOG (prevents Railway log rate limits) =========
// ============================================================
let lastLog = 0;
function safeLog(msg) {
  if (Date.now() - lastLog > 15000) {
    console.log(msg);
    lastLog = Date.now();
  }
}

// ============================================================
// ====== UTILS ===============================================
// ============================================================

// Strips HTML tags from AniList synopsis
function cleanText(text) {
  if (!text) return "No synopsis available.";
  return text.replace(/<[^>]*>/g, "").trim().slice(0, 350);
}

// Escapes MarkdownV2 special characters for Telegram
// FIX Bug #8: Prevents Telegram parse errors on special chars
function escMd(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// ============================================================
// ====== ANILIST — SEARCH BY NAME ============================
// ============================================================
async function getAnimeBySearch(search) {
  try {
    const query = `
      query ($search: String) {
        Media(search: $search, type: ANIME, isAdult: false) {
          id
          title { romaji english }
          episodes
          status
          description
          averageScore
          coverImage { large }
          nextAiringEpisode { airingAt episode }
        }
      }`;

    const res = await axios.post(
      "https://graphql.anilist.co",
      { query, variables: { search } },
      { timeout: 10000 }
    );
    return res.data.data.Media;
  } catch (err) {
    console.error("AniList search error:", err.message);
    return null;
  }
}

// ============================================================
// ====== ANILIST — FETCH BY NUMERIC ID =======================
// FIX Bug #1 & #6: Old code passed numeric ID to a name-based
// search query. Now uses a proper id-based AniList query.
// ============================================================
async function getAnimeById(anilistId) {
  try {
    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          title { romaji english }
          episodes
          status
          description
          averageScore
          coverImage { large }
          nextAiringEpisode { airingAt episode }
        }
      }`;

    const res = await axios.post(
      "https://graphql.anilist.co",
      { query, variables: { id: parseInt(anilistId) } },
      { timeout: 10000 }
    );
    return res.data.data.Media;
  } catch (err) {
    console.error("AniList ID fetch error:", err.message);
    return null;
  }
}

// ============================================================
// ====== CONSUMET — REAL DUB DATA ============================
// Merged from your animeService.js. Falls back gracefully.
// ============================================================
async function getConsumetDubData(title) {
  try {
    const res = await axios.get(
      `https://api.consumet.org/anime/gogoanime/${encodeURIComponent(title + " dub")}`,
      { timeout: 10000 }
    );
    const results = res.data?.results;
    if (!results || results.length === 0) return null;

    // Prefer results explicitly labelled as dubbed
    const dubbed = results.find((r) =>
      r.title?.toLowerCase().includes("dub")
    );
    return dubbed || null;
  } catch {
    // Consumet is often rate-limited or down — fail silently
    return null;
  }
}

// ============================================================
// ====== DUB INFO (Consumet first, fallback estimate) ========
// ============================================================
async function getDubInfo(anime) {
  const title = anime.title?.english || anime.title?.romaji || "";
  const totalEpisodes = anime.episodes || 12;

  const conData = await getConsumetDubData(title);

  if (conData?.episodeCount) {
    return {
      dubEpisodes: conData.episodeCount,
      pattern: "Weekly (Consumet live data)",
    };
  }

  // Fallback: safe placeholder
  return {
    dubEpisodes: Math.min(12, totalEpisodes),
    pattern: "Weekly (estimated)",
  };
}

// ============================================================
// ====== PREDICTION ENGINE ===================================
// ============================================================
function predictNext(anime, dubEpisodes) {
  const nextEpisode = dubEpisodes + 1;

  // Use AniList's real next airing timestamp if available
  if (anime.nextAiringEpisode?.airingAt) {
    const d = new Date(anime.nextAiringEpisode.airingAt * 1000);
    return { nextEpisode, nextDate: d.toDateString() };
  }

  // Fallback: +7 days
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + 7);
  return { nextEpisode, nextDate: nextDate.toDateString() };
}

// ============================================================
// ====== BUILD FULL ANIME OBJECT =============================
// ============================================================
function buildAnimeData(anime, dub) {
  const next = predictNext(anime, dub.dubEpisodes);
  return {
    id: anime.id,                                       // always a NUMBER
    title: anime.title.english || anime.title.romaji,
    image: anime.coverImage?.large || null,
    episodes: anime.episodes || "?",
    status: anime.status || "UNKNOWN",
    synopsis: cleanText(anime.description),
    dubEpisodes: dub.dubEpisodes,
    pattern: dub.pattern,
    nextEpisode: next.nextEpisode,
    nextDate: next.nextDate,
  };
}

// ============================================================
// ====== FIREBASE HELPERS ====================================
// ============================================================

async function getTrackedList(userId) {
  try {
    const doc = await db.collection("users").doc(String(userId)).get();
    if (!doc.exists) return [];
    return doc.data().tracking || [];
  } catch (err) {
    console.error("Firebase getTrackedList error:", err.message);
    return [];
  }
}

async function saveTrackedList(userId, list) {
  try {
    await db
      .collection("users")
      .doc(String(userId))
      .set({ tracking: list }, { merge: true });
  } catch (err) {
    console.error("Firebase saveTrackedList error:", err.message);
  }
}

// FIX Bug #5: Now stores title + dubEpisodes alongside id.
// Old code only stored { id, lastEpisodeAlerted: 0 } which
// made /mylist unable to display anything useful.
async function trackAnime(userId, animeData) {
  const list = await getTrackedList(userId);
  const exists = list.find((a) => a.id === animeData.id);
  if (exists) return false; // already tracked

  list.push({
    id: animeData.id,                           // NUMBER
    title: animeData.title,                     // stored for /mylist display
    dubEpisodes: animeData.dubEpisodes,         // stored for alert diffing
    lastEpisodeAlerted: animeData.dubEpisodes,  // start from current, not 0
  });

  await saveTrackedList(userId, list);
  return true;
}

async function untrackAnime(userId, animeId) {
  const list = await getTrackedList(userId);
  const filtered = list.filter((a) => a.id !== parseInt(animeId));
  await saveTrackedList(userId, filtered);
}

async function updateLastAlerted(userId, animeId, episode) {
  const list = await getTrackedList(userId);
  const item = list.find((a) => a.id === parseInt(animeId));
  if (item) {
    item.lastEpisodeAlerted = episode;
    item.dubEpisodes = episode;
    await saveTrackedList(userId, list);
  }
}

// ============================================================
// ====== FORMAT SEARCH MESSAGE ===============================
// ============================================================
function formatAnimeMessage(data) {
  const statusEmoji = {
    FINISHED: "✅",
    RELEASING: "📡",
    NOT_YET_RELEASED: "🔜",
    CANCELLED: "❌",
  };
  const statusIcon = statusEmoji[data.status] || "❓";

  return (
    `🎬 *${escMd(data.title)}*\n\n` +
    `📺 Total Episodes: *${escMd(data.episodes)}* ${statusIcon}\n` +
    `🇬🇧 Dubbed Episodes: *${escMd(data.dubEpisodes)}*\n` +
    `📊 Release Pattern: ${escMd(data.pattern)}\n\n` +
    `⏭ Next Dub Ep: *Ep ${escMd(data.nextEpisode)}*\n` +
    `📅 Est\\. Date: ${escMd(data.nextDate)}\n\n` +
    `📖 *Synopsis:*\n${escMd(data.synopsis)}`
  );
}

// ============================================================
// ====== /start & /help ======================================
// ============================================================
const welcomeText =
  `👋 *Welcome to Anime Dub Tracker\\!*\n\n` +
  `Track English dubbed episodes and get notified automatically\\.\n\n` +
  `*Commands:*\n` +
  `🔍 /search \\<name\\> — Search for an anime\n` +
  `📋 /mylist — View and manage your tracked anime\n` +
  `❓ /help — Show this message`;

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, welcomeText, { parse_mode: "MarkdownV2" });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, welcomeText, { parse_mode: "MarkdownV2" });
});

// ============================================================
// ====== /search =============================================
// ============================================================
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1].trim();

  // Send "Searching..." placeholder
  const placeholder = await bot.sendMessage(
    chatId,
    `🔍 Searching for *${escMd(query)}*\\.\\.\\.`,
    { parse_mode: "MarkdownV2" }
  );

  const anime = await getAnimeBySearch(query);

  // Always clean up placeholder
  await bot.deleteMessage(chatId, placeholder.message_id).catch(() => {});

  if (!anime) {
    return bot.sendMessage(
      chatId,
      "❌ Anime not found\\. Try a different name\\.",
      { parse_mode: "MarkdownV2" }
    );
  }

  const dub = await getDubInfo(anime);
  const data = buildAnimeData(anime, dub);
  const caption = formatAnimeMessage(data);

  const keyboard = {
    inline_keyboard: [
      [{ text: "📌 Track this anime", callback_data: `track_${data.id}` }],
    ],
  };

  // FIX Bug #8: try/catch on sendPhoto — falls back to text if image fails
  try {
    await bot.sendPhoto(chatId, data.image, {
      caption,
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error("sendPhoto failed, falling back to text:", err.message);
    await bot.sendMessage(chatId, caption, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    });
  }
});

// ============================================================
// ====== /mylist =============================================
// FIX Bug #1: Old code called getAnime(item.id) which used a
// name-based search with a numeric ID — always returned null.
// Now reads stored title/dubEpisodes directly from Firestore.
// ============================================================
bot.onText(/\/mylist/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const list = await getTrackedList(userId);

  if (list.length === 0) {
    return bot.sendMessage(
      chatId,
      "📭 *Your list is empty\\!*\n\nUse /search to find anime to track\\.",
      { parse_mode: "MarkdownV2" }
    );
  }

  // Build message text
  let text = `📋 *Your Tracked Anime \\(${escMd(list.length)}\\):*\n\n`;
  list.forEach((item, i) => {
    text += `${i + 1}\\. *${escMd(item.title)}* — 🇬🇧 Ep *${escMd(item.dubEpisodes)}*\n`;
  });
  text += `\n_Tap a button below to untrack_`;

  // One untrack button per anime
  const keyboard = list.map((item) => [
    {
      text: `🗑 Untrack: ${item.title}`,
      callback_data: `untrack_${item.id}`,
    },
  ]);

  bot.sendMessage(chatId, text, {
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: keyboard },
  });
});

// ============================================================
// ====== CALLBACK QUERY HANDLER ==============================
// FIX Bug #2: ID now always parsed to INT consistently
// FIX Bug #3: Untrack button fully implemented
// FIX Bug #7: answerCallbackQuery always called in every path
// ============================================================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  // ── TRACK ──────────────────────────────────────────────────
  if (data.startsWith("track_")) {
    const animeId = parseInt(data.split("_")[1]); // FIX Bug #2: always INT

    const anime = await getAnimeById(animeId);   // FIX Bug #2: use ID query
    if (!anime) {
      await bot.answerCallbackQuery(q.id, {
        text: "❌ Could not fetch anime data. Try again.",
        show_alert: true,
      });
      return;
    }

    const dub = await getDubInfo(anime);
    const animeData = buildAnimeData(anime, dub);

    const added = await trackAnime(userId, animeData); // FIX Bug #5: stores full data

    if (added) {
      await bot.answerCallbackQuery(q.id, {
        text: `✅ "${animeData.title}" added to your list!`,
        show_alert: true,
      });

      // Replace "Track" button with "✅ Tracked!" so user sees confirmation
      try {
        await bot.editMessageReplyMarkup(
          {
            inline_keyboard: [
              [{ text: "✅ Tracked!", callback_data: `noop_${animeId}` }],
            ],
          },
          { chat_id: chatId, message_id: q.message.message_id }
        );
      } catch (_) {}
    } else {
      await bot.answerCallbackQuery(q.id, {
        text: "📌 Already in your list!",
        show_alert: false,
      });
    }
    return;
  }

  // ── UNTRACK ────────────────────────────────────────────────
  if (data.startsWith("untrack_")) {
    const animeId = parseInt(data.split("_")[1]);

    await untrackAnime(userId, animeId);

    await bot.answerCallbackQuery(q.id, {
      text: "🗑 Removed from your list.",
      show_alert: false,
    });

    // Rebuild /mylist message in-place
    const newList = await getTrackedList(userId);

    try {
      if (newList.length === 0) {
        await bot.editMessageText(
          "📭 *Your list is now empty\\!*\n\nUse /search to find anime to track\\.",
          {
            chat_id: chatId,
            message_id: q.message.message_id,
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: [] },
          }
        );
      } else {
        let text = `📋 *Your Tracked Anime \\(${escMd(newList.length)}\\):*\n\n`;
        newList.forEach((item, i) => {
          text += `${i + 1}\\. *${escMd(item.title)}* — 🇬🇧 Ep *${escMd(item.dubEpisodes)}*\n`;
        });
        text += `\n_Tap a button below to untrack_`;

        const keyboard = newList.map((item) => [
          {
            text: `🗑 Untrack: ${item.title}`,
            callback_data: `untrack_${item.id}`,
          },
        ]);

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: q.message.message_id,
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: keyboard },
        });
      }
    } catch (_) {}
    return;
  }

  // ── NOOP (✅ Tracked! button — intentionally does nothing) ──
  if (data.startsWith("noop_")) {
    await bot.answerCallbackQuery(q.id, {
      text: "Already tracked ✅",
      show_alert: false,
    });
    return;
  }

  // ── FALLBACK — always answer to kill spinner (Bug #7 fix) ──
  await bot.answerCallbackQuery(q.id, { text: "Unknown action." });
});

// ============================================================
// ====== ALERT SYSTEM (cron every 30 min) ====================
// FIX Bug #6: Old code called getFullAnime(anime.id) which
// passed the numeric ID as a search string — always failed.
// Now uses getAnimeById() for correct ID-based fetching.
// ============================================================
cron.schedule("*/30 * * * *", async () => {
  safeLog("🔔 Running dub episode check...");

  let snapshot;
  try {
    snapshot = await db.collection("users").get();
  } catch (err) {
    console.error("Firestore read error during cron:", err.message);
    return;
  }

  for (const doc of snapshot.docs) {
    const userId = doc.id;
    const list = doc.data().tracking || [];

    for (const anime of list) {
      try {
        const fresh = await getAnimeById(anime.id); // FIX Bug #6
        if (!fresh) continue;

        const dub = await getDubInfo(fresh);

        if (dub.dubEpisodes > anime.lastEpisodeAlerted) {
          const title = fresh.title.english || fresh.title.romaji;

          await bot.sendMessage(
            userId,
            `🚨 *New Dubbed Episode Alert\\!*\n\n` +
              `🎬 *${escMd(title)}*\n` +
              `🇬🇧 Episode *${escMd(dub.dubEpisodes)}* is now available dubbed\\!\n\n` +
              `_Use /mylist to manage your tracked anime_`,
            { parse_mode: "MarkdownV2" }
          );

          // Update Firestore so we don't alert twice for same episode
          await updateLastAlerted(userId, anime.id, dub.dubEpisodes);
        }
      } catch (err) {
        console.error(`Alert error for anime ${anime.id}:`, err.message);
      }
    }
  }
});

// ============================================================
// ====== GLOBAL ERROR HANDLERS (prevent crashes) =============
// ============================================================
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
});