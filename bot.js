// ============================================================
// ====== ANIME DUB TRACKER BOT — FINAL STABLE VERSION =======
// ============================================================

require("dotenv").config();

// ====== EXPRESS ======
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("🚀 Bot running"));
app.listen(process.env.PORT || 3000);

// ====== IMPORTS ======
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cron = require("node-cron");
const admin = require("firebase-admin");

// ====== FIREBASE ======
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ====== BOT ======
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ====== UTILS ======
const cleanText = (t) =>
  t ? t.replace(/<[^>]*>/g, "").slice(0, 350) : "No synopsis.";

const esc = (t) =>
  String(t || "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");

// ============================================================
// ====== ANILIST =============================================
// ============================================================
async function getAnime(search) {
  const q = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      title { romaji english }
      episodes
      status
      description
      coverImage { large }
    }
  }`;

  const res = await axios.post("https://graphql.anilist.co", {
    query: q,
    variables: { search },
  });

  return res.data.data.Media;
}

// ============================================================
// ====== ANIMESCHEDULE FIXED ================================
// ============================================================

async function fetchAnimeSchedule(id, title) {
  try {
    // 1️⃣ Try AniList ID
    let res = await axios.get(
      "https://animeschedule.net/api/v3/anime",
      {
        params: { "anilist-ids": id },
        headers: { Authorization: process.env.ANIMESCHEDULE_KEY },
      }
    );

    let list = res.data?.data;

    if (!list || list.length === 0) {
      // 2️⃣ fallback title
      res = await axios.get(
        "https://animeschedule.net/api/v3/anime",
        {
          params: { q: title },
          headers: { Authorization: process.env.ANIMESCHEDULE_KEY },
        }
      );
      list = res.data?.data;
    }

    if (!list || list.length === 0) return null;

    return list[0];
  } catch (e) {
    return null;
  }
}

// ====== EXTRACT DUB ======
function getDub(entry) {
  if (!entry) return null;

  if (typeof entry?.episodes?.dub === "number")
    return entry.episodes.dub;

  if (typeof entry?.dubEpisodes === "number")
    return entry.dubEpisodes;

  if (entry.status === "finished" && entry.episodeCount)
    return entry.episodeCount;

  return null;
}

// ============================================================
// ====== BUILD DATA ==========================================
// ============================================================
async function build(anime) {
  const title = anime.title.english || anime.title.romaji;

  const sched = await fetchAnimeSchedule(anime.id, title);

  const dub = getDub(sched);

  return {
    id: anime.id,
    title,
    image: anime.coverImage?.large,
    episodes: anime.episodes || sched?.episodeCount,
    status: anime.status,
    synopsis: cleanText(anime.description),
    dub,
  };
}

// ============================================================
// ====== FIREBASE ============================================
// ============================================================
async function getList(uid) {
  const doc = await db.collection("users").doc(uid).get();
  return doc.exists ? doc.data().list || [] : [];
}

async function saveList(uid, list) {
  await db.collection("users").doc(uid).set({ list });
}

// ============================================================
// ====== SEARCH ==============================================
// ============================================================
bot.onText(/\/search (.+)/, async (msg, m) => {
  const chatId = msg.chat.id;
  const anime = await getAnime(m[1]);

  if (!anime) return bot.sendMessage(chatId, "Not found");

  const data = await build(anime);

  const text =
    `🎬 *${esc(data.title)}*\n\n` +
    `📺 Episodes: ${esc(data.episodes || "Unknown")}\n` +
    `🇬🇧 Dub: ${esc(data.dub ?? "Unavailable")}\n\n` +
    `📖 ${esc(data.synopsis)}`;

  bot.sendPhoto(chatId, data.image, {
    caption: text,
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📌 Track", callback_data: `t_${data.id}` }],
      ],
    },
  });
});

// ============================================================
// ====== TRACK ===============================================
// ============================================================
bot.on("callback_query", async (q) => {
  const uid = String(q.from.id);
  const id = parseInt(q.data.split("_")[1]);

  const anime = await getAnime(id);
  const data = await build(anime);

  let list = await getList(uid);

  if (!list.find((a) => a.id === id)) {
    list.push({
      id,
      title: data.title,
      dub: data.dub || 0,
    });
    await saveList(uid, list);
  }

  bot.answerCallbackQuery(q.id, { text: "Tracked ✅" });
});

// ============================================================
// ====== ALERT SYSTEM ========================================
// ============================================================
cron.schedule("*/30 * * * *", async () => {
  const users = await db.collection("users").get();

  for (const doc of users.docs) {
    const uid = doc.id;
    const list = doc.data().list || [];

    for (const anime of list) {
      const sched = await fetchAnimeSchedule(anime.id, anime.title);
      const dub = getDub(sched);

      if (dub && dub > anime.dub) {
        bot.sendMessage(
          uid,
          `🚨 New Dub!\n${anime.title} EP ${dub}`
        );

        anime.dub = dub;
      }
    }

    await saveList(uid, list);
  }
});

// ============================================================
// ====== ERROR HANDLING ======================================
// ============================================================
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});