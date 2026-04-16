// ============================================================
// ====== ANIME DUB TRACKER BOT — bot.js (FIXED DUB DATA) ====
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
  console.error("❌ BOT_TOKEN missing");
  process.exit(1);
}

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
// ====== ANIMESCHEDULE — STRATEGY 1: Query by AniList ID =====
// ============================================================
async function fetchByAnilistId(anilistId) {
  try {
    const res = await axios.get(
      "https://animeschedule.net/api/v3/anime",
      {
        params: { "anilist-ids": parseInt(anilistId) },
        headers: { Authorization: `Bearer ${process.env.ANIMESCHEDULE_KEY}` },
        timeout: 10000,
      }
    );

    // Log raw response so we can see what fields come back in Railway logs
    console.log(`[AnimeSchedule ID lookup] anilistId=${anilistId} results=${res.data?.length ?? 0}`);
    if (res.data?.length > 0) {
      console.log("[AnimeSchedule raw]", JSON.stringify(res.data[0]).slice(0, 400));
    }

    return res.data?.length > 0 ? res.data[0] : null;
  } catch (err) {
    console.error("AnimeSchedule ID lookup error:", err.response?.status, err.message);
    return null;
  }
}

// ============================================================
// ====== ANIMESCHEDULE — STRATEGY 2: Query by title text =====
// Fallback when AniList ID yields no result (e.g. very new
// or obscure shows not yet indexed by AnimeSchedule).
// ============================================================
async function fetchByTitle(title) {
  try {
    const res = await axios.get(
      "https://animeschedule.net/api/v3/anime",
      {
        params: { q: title },
        headers: { Authorization: `Bearer ${process.env.ANIMESCHEDULE_KEY}` },
        timeout: 10000,
      }
    );

    console.log(`[AnimeSchedule title lookup] q="${title}" results=${res.data?.length ?? 0}`);
    if (res.data?.length > 0) {
      console.log("[AnimeSchedule title raw]", JSON.stringify(res.data[0]).slice(0, 400));
    }

    return res.data?.length > 0 ? res.data[0] : null;
  } catch (err) {
    console.error("AnimeSchedule title lookup error:", err.response?.status, err.message);
    return null;
  }
}

// ============================================================
// ====== ANIMESCHEDULE — STRATEGY 3: Timetable dub check =====
// The timetable endpoint tracks CURRENTLY AIRING dubbed shows
// with real episode-by-episode timestamps. If strategies 1 & 2
// both fail, we scan the current dub timetable for a match.
// ============================================================
async function fetchFromTimetable(title) {
  try {
    const res = await axios.get(
      "https://animeschedule.net/api/v3/timetables/dub",
      {
        headers: { Authorization: `Bearer ${process.env.ANIMESCHEDULE_KEY}` },
        timeout: 10000,
      }
    );

    const timetable = res.data;
    if (!timetable || !Array.isArray(timetable)) return null;

    // Normalize title for fuzzy matching
    const normalize = (s) => s?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
    const needle = normalize(title);

    const match = timetable.find((entry) => {
      const haystack = normalize(entry.title || entry.route || "");
      return haystack.includes(needle) || needle.includes(haystack.slice(0, 10));
    });

    if (match) {
      console.log(`[AnimeSchedule timetable] matched "${match.title}" for query "${title}"`);
      console.log("[AnimeSchedule timetable raw]", JSON.stringify(match).slice(0, 400));
    } else {
      console.log(`[AnimeSchedule timetable] no match for "${title}"`);
    }

    return match || null;
  } catch (err) {
    console.error("AnimeSchedule timetable error:", err.response?.status, err.message);
    return null;
  }
}

// ============================================================
// ====== EXTRACT DUB EPISODES FROM ANIMESCHEDULE OBJECT ======
// The API uses camelCase. Known field names for dub count:
//   dubEpisodes       — number of dubbed episodes released
//   episodeCount      — total episode count
// If the field is missing entirely, the value is null (omitted
// when null per their docs).
// ============================================================
function extractDubEpisodes(entry) {
  if (!entry) return null;

  // Primary field
  if (typeof entry.dubEpisodes === "number") return entry.dubEpisodes;

  // Some entries use episodeCount when fully dubbed
  // Only use as fallback if show is FINISHED
  if (entry.status === "finished" && typeof entry.episodeCount === "number") {
    return entry.episodeCount;
  }

  return null;
}

// ============================================================
// ====== MASTER DUB LOOKUP — tries all 3 strategies ==========
// ============================================================
async function getRealDubCount(anilistId, title) {
  if (!process.env.ANIMESCHEDULE_KEY) return null;

  // Strategy 1: AniList ID lookup (most accurate)
  let entry = await fetchByAnilistId(anilistId);
  let dubEpisodes = extractDubEpisodes(entry);

  // Strategy 2: Title text search
  if (dubEpisodes === null) {
    entry = await fetchByTitle(title);
    dubEpisodes = extractDubEpisodes(entry);
  }

  // Strategy 3: Live dub timetable scan
  if (dubEpisodes === null) {
    entry = await fetchFromTimetable(title);
    dubEpisodes = extractDubEpisodes(entry);
  }

  if (dubEpisodes === null) {
    console.log(`[DubLookup] All 3 strategies failed for "${title}" (id=${anilistId})`);
    return null;
  }

  return {
    dubEpisodes,
    episodeCount: entry?.episodeCount ?? null,
    route: entry?.route ?? null,
  };
}

// ============================================================
// ====== BUILD FULL ANIME OBJECT =============================
// ============================================================
async function buildAnimeData(anime) {
  const title = anime.title.english || anime.title.romaji;
  const schedData = await getRealDubCount(anime.id, title);

  const totalEpisodes = anime.episodes || schedData?.episodeCount || null;
  const dubEpisodes = schedData?.dubEpisodes ?? null;

  return {
    id: anime.id,
    title,
    image: anime.coverImage?.large || null,
    episodes: totalEpisodes,
    status: anime.status || "UNKNOWN",
    synopsis: cleanText(anime.description),
    dubEpisodes,
    dubSource: dubEpisodes !== null ? "AnimeSchedule.net" : "Not found",
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
      ? `*${escMd(data.dubEpisodes)}* episode${data.dubEpisodes === 1 ? "" : "s"} dubbed so far`
      : `Not available in English dub yet \\(or not tracked\\)`;

  const totalLine = data.episodes ? `*${escMd(data.episodes)}*` : "Unknown";

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
// ====== BUILD /mylist MESSAGE ===============================
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
    { text: `🗑 Untrack: ${item.title}`, callback_data: `untrack_${item.id}` },
  ]);

  return { text, keyboard };
}

// ============================================================
// ====== /start & /help ======================================
// ============================================================
const welcomeText =
  `👋 *Welcome to Anime Dub Tracker\\!*\n\n` +
  `I track *real* English dub episode counts and alert you the moment new dubbed episodes drop\\.\n\n` +
  `*Commands:*\n` +
  `🔍 /search \\<name\\> — Search for an anime\n` +
  `📋 /mylist — View and manage your tracked anime\n` +
  `❓ /help — Show this message\n\n` +
  `_Dub data powered by AnimeSchedule\\.net_`;

bot.onText(/\/start/, (msg) => {
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
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "✅ Tracked!", callback_data: `noop_${animeId}` }]] },
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

  // ── NOOP ───────────────────────────────────────────────────
  if (data.startsWith("noop_")) {
    await bot.answerCallbackQuery(q.id, { text: "Already tracked ✅", show_alert: false });
    return;
  }

  await bot.answerCallbackQuery(q.id, { text: "Unknown action." });
});

// ============================================================
// ====== ALERT SYSTEM (cron every 30 min) ====================
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
        const schedData = await getRealDubCount(tracked.id, tracked.title);
        if (!schedData) continue;

        const currentDub = schedData.dubEpisodes;
        if (currentDub === null || currentDub === undefined) continue;

        const lastAlerted = tracked.lastEpisodeAlerted ?? 0;

        if (currentDub > lastAlerted) {
          await bot.sendMessage(
            userId,
            `🚨 *New Dubbed Episode Alert\\!*\n\n` +
              `🎬 *${escMd(tracked.title)}*\n\n` +
              `🇬🇧 Episode *${escMd(currentDub)}* is now available in English dub\\!\n\n` +
              `_Use /mylist to manage your tracked anime_`,
            { parse_mode: "MarkdownV2" }
          );

          await updateLastAlerted(userId, tracked.id, currentDub);
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