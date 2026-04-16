// ============================================================
// ====== ANIME DUB TRACKER BOT — bot.js (FULL REWRITE) ======
// ============================================================
// KEY CHANGES FROM PREVIOUS VERSION:
//  - Removed persistent bottom keyboard buttons entirely
//  - Real dub episode count from AnimeSchedule.net API v3
//  - Removed all "next episode prediction" (not needed)
//  - Alerts fire the moment a new dubbed episode is detected
//  - All previous bugs (#1–#9) remain fixed
// ============================================================

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
// ====== FIREBASE INIT =======================================
// ============================================================
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
  console.error("❌ FIREBASE_KEY env variable is missing or invalid JSON");
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log("✅ Firebase connected");

// ============================================================
// ====== BOT INIT ============================================
// ============================================================
if (!process.env.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing from environment variables");
  process.exit(1);
}

// NOTE: Make sure ANIMESCHEDULE_KEY is set in Railway env vars
// Get your free API key at: https://animeschedule.net/users/<yourname>/settings/api
if (!process.env.ANIMESCHEDULE_KEY) {
  console.warn("⚠️  ANIMESCHEDULE_KEY not set — dub counts will be estimated");
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
bot.getMe().then((me) => console.log(`🤖 Bot running as @${me.username}`));

// ============================================================
// ====== SAFE LOG ============================================
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
function cleanText(text) {
  if (!text) return "No synopsis available.";
  return text.replace(/<[^>]*>/g, "").trim().slice(0, 350);
}

// Escapes all MarkdownV2 special characters for Telegram
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
          coverImage { large }
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
          coverImage { large }
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
// ====== ANIMESCHEDULE.NET — REAL DUB EPISODE COUNT ==========
// Docs: https://animeschedule.net/api/v3/documentation/anime
//
// This is the ONLY place dub counts come from.
// We query by AniList ID so it matches exactly.
// The API returns `dubEpisodes` — the actual number of
// English dubbed episodes released so far.
// ============================================================
async function getRealDubCount(anilistId) {
  if (!process.env.ANIMESCHEDULE_KEY) return null;

  try {
    const res = await axios.get(
      `https://animeschedule.net/api/v3/anime`,
      {
        params: {
          "anilist-ids": parseInt(anilistId),
        },
        headers: {
          Authorization: `Bearer ${process.env.ANIMESCHEDULE_KEY}`,
        },
        timeout: 10000,
      }
    );

    const results = res.data;
    if (!results || results.length === 0) return null;

    const anime = results[0];

    // dubEpisodes = how many English dub episodes have been released
    // episodeCount = total episodes of the show
    return {
      dubEpisodes: anime.dubEpisodes ?? null,
      episodeCount: anime.episodeCount ?? null,
      route: anime.route ?? null,   // slug for animeschedule.net link
    };
  } catch (err) {
    console.error("AnimeSchedule API error:", err.message);
    return null;
  }
}

// ============================================================
// ====== BUILD FULL ANIME OBJECT =============================
// dubEpisodes comes from AnimeSchedule (real data).
// Falls back to null so we show "Unknown" instead of a lie.
// ============================================================
async function buildAnimeData(anime) {
  const schedData = await getRealDubCount(anime.id);

  const totalEpisodes = anime.episodes || schedData?.episodeCount || null;
  const dubEpisodes = schedData?.dubEpisodes ?? null; // null = unknown

  return {
    id: anime.id,
    title: anime.title.english || anime.title.romaji,
    image: anime.coverImage?.large || null,
    episodes: totalEpisodes,
    status: anime.status || "UNKNOWN",
    synopsis: cleanText(anime.description),
    dubEpisodes,                           // REAL count or null
    dubSource: schedData ? "AnimeSchedule.net" : "Unavailable",
    scheduleRoute: schedData?.route || null,
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

async function trackAnime(userId, data) {
  const list = await getTrackedList(userId);
  const exists = list.find((a) => a.id === data.id);
  if (exists) return false;

  list.push({
    id: data.id,                                  // number
    title: data.title,
    dubEpisodes: data.dubEpisodes,
    lastEpisodeAlerted: data.dubEpisodes ?? 0,    // start from NOW, not 0
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
// ====== FORMAT MESSAGE ======================================
// Removed: Release Pattern, Next Episode, Est. Date
// Added: accurate dub count with data source label
// ============================================================
function formatAnimeMessage(data) {
  const statusLabel = {
    FINISHED: "Finished ✅",
    RELEASING: "Currently Airing 📡",
    NOT_YET_RELEASED: "Not Yet Released 🔜",
    CANCELLED: "Cancelled ❌",
  };

  const dubLine =
    data.dubEpisodes !== null
      ? `*${escMd(data.dubEpisodes)}* episodes dubbed so far`
      : `Unknown \\(data unavailable\\)`;

  const totalLine =
    data.episodes
      ? `*${escMd(data.episodes)}* episodes total`
      : "Unknown";

  return (
    `🎬 *${escMd(data.title)}*\n\n` +
    `📺 Total Episodes: ${totalLine}\n` +
    `📊 Status: ${escMd(statusLabel[data.status] || data.status)}\n\n` +
    `🇬🇧 *English Dub: ${dubLine}*\n` +
    `🔎 Source: ${escMd(data.dubSource)}\n\n` +
    `📖 *Synopsis:*\n${escMd(data.synopsis)}`
  );
}

// ============================================================
// ====== BUILD /mylist MESSAGE + KEYBOARD ====================
// ============================================================
function buildMyListMessage(list) {
  let text = `📋 *Your Tracked Anime \\(${escMd(list.length)}\\):*\n\n`;

  list.forEach((item, i) => {
    const dub =
      item.dubEpisodes !== null && item.dubEpisodes !== undefined
        ? `Ep *${escMd(item.dubEpisodes)}* dubbed`
        : "Dub count unknown";
    text += `${i + 1}\\. *${escMd(item.title)}* — 🇬🇧 ${dub}\n`;
  });

  text += `\n_Tap below to untrack an anime_`;

  const keyboard = list.map((item) => [
    {
      text: `🗑 Untrack: ${item.title}`,
      callback_data: `untrack_${item.id}`,
    },
  ]);

  return { text, keyboard };
}

// ============================================================
// ====== /start & /help ======================================
// NOTE: No reply_markup keyboard here — removes bottom buttons
// ============================================================
const welcomeText =
  `👋 *Welcome to Anime Dub Tracker\\!*\n\n` +
  `I track *real* English dub episode counts and alert you when new dubbed episodes drop\\.\n\n` +
  `*Commands:*\n` +
  `🔍 /search \\<name\\> — Search for an anime\n` +
  `📋 /mylist — View and manage your tracked anime\n` +
  `❓ /help — Show this message\n\n` +
  `_Dub data powered by AnimeSchedule\\.net_`;

bot.onText(/\/start/, (msg) => {
  // reply_markup: { remove_keyboard: true } removes any old sticky keyboard
  bot.sendMessage(msg.chat.id, welcomeText, {
    parse_mode: "MarkdownV2",
    reply_markup: { remove_keyboard: true },
  });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, welcomeText, {
    parse_mode: "MarkdownV2",
    reply_markup: { remove_keyboard: true },
  });
});

// ============================================================
// ====== /search =============================================
// ============================================================
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1].trim();

  const placeholder = await bot.sendMessage(
    chatId,
    `🔍 Searching for *${escMd(query)}*\\.\\.\\.`,
    { parse_mode: "MarkdownV2" }
  );

  const anime = await getAnimeBySearch(query);
  await bot.deleteMessage(chatId, placeholder.message_id).catch(() => {});

  if (!anime) {
    return bot.sendMessage(
      chatId,
      "❌ Anime not found\\. Try a different spelling\\.",
      { parse_mode: "MarkdownV2" }
    );
  }

  const data = await buildAnimeData(anime);
  const caption = formatAnimeMessage(data);

  // Only inline button — no sticky keyboard
  const keyboard = {
    inline_keyboard: [
      [{ text: "📌 Track this anime", callback_data: `track_${data.id}` }],
    ],
  };

  try {
    if (data.image) {
      await bot.sendPhoto(chatId, data.image, {
        caption,
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
      });
    } else {
      throw new Error("No image");
    }
  } catch {
    // Fallback: text only if image fails
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

  const { text, keyboard } = buildMyListMessage(list);

  bot.sendMessage(chatId, text, {
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: keyboard },
  });
});

// ============================================================
// ====== CALLBACK QUERY HANDLER ==============================
// ============================================================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  // ── TRACK ──────────────────────────────────────────────────
  if (data.startsWith("track_")) {
    const animeId = parseInt(data.split("_")[1]);

    const anime = await getAnimeById(animeId);
    if (!anime) {
      await bot.answerCallbackQuery(q.id, {
        text: "❌ Could not fetch anime data. Try again.",
        show_alert: true,
      });
      return;
    }

    const animeData = await buildAnimeData(anime);
    const added = await trackAnime(userId, animeData);

    if (added) {
      await bot.answerCallbackQuery(q.id, {
        text: `✅ "${animeData.title}" is now being tracked!`,
        show_alert: true,
      });

      // Swap Track button → ✅ Tracked
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

    // Rebuild list message in-place
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
        const { text, keyboard } = buildMyListMessage(newList);
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

  // ── NOOP (already tracked button) ──────────────────────────
  if (data.startsWith("noop_")) {
    await bot.answerCallbackQuery(q.id, {
      text: "Already tracked ✅",
      show_alert: false,
    });
    return;
  }

  // ── FALLBACK ───────────────────────────────────────────────
  await bot.answerCallbackQuery(q.id, { text: "Unknown action." });
});

// ============================================================
// ====== ALERT SYSTEM (cron every 30 min) ====================
// Reads every tracked user from Firestore.
// For each anime, fetches the REAL current dub count.
// If dubEpisodes > lastEpisodeAlerted → new episode → alert.
// ============================================================
cron.schedule("*/30 * * * *", async () => {
  safeLog("🔔 Checking for new dubbed episodes...");

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

    for (const tracked of list) {
      try {
        // Get real dub count from AnimeSchedule
        const schedData = await getRealDubCount(tracked.id);
        if (!schedData) continue;

        const currentDubCount = schedData.dubEpisodes;
        if (currentDubCount === null || currentDubCount === undefined) continue;

        const lastAlerted = tracked.lastEpisodeAlerted ?? 0;

        if (currentDubCount > lastAlerted) {
          // 🚨 New dubbed episode detected!
          const newEpisode = currentDubCount;

          await bot.sendMessage(
            userId,
            `🚨 *New Dubbed Episode Alert\\!*\n\n` +
              `🎬 *${escMd(tracked.title)}*\n\n` +
              `🇬🇧 Episode *${escMd(newEpisode)}* is now available in English dub\\!\n\n` +
              `_Use /mylist to manage your tracked anime_`,
            { parse_mode: "MarkdownV2" }
          );

          await updateLastAlerted(userId, tracked.id, newEpisode);
        }
      } catch (err) {
        console.error(`Alert error for anime ${tracked.id}:`, err.message);
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