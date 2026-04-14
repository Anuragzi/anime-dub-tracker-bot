const axios = require("axios");
const cron = require("node-cron");
const admin = require("firebase-admin");
const db = require("./firebase");
const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

console.log("🚀 Bot is running");

// ================= STATE =================
const userState = new Map();

// ================= ANILIST API =================
async function getAnimeInfo(search) {
  try {
    const query = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          title { romaji }
          episodes
          status
          averageScore
          description
          coverImage { large }
          nextAiringEpisode { episode }
        }
      }
    `;

    const res = await axios.post("https://graphql.anilist.co", {
      query,
      variables: { search }
    });

    const anime = res.data.data.Media;
    if (!anime) return null;

    return {
      title: anime.title.romaji,
      episodes: anime.episodes,
      status: anime.status,
      score: anime.averageScore,
      synopsis: anime.description,
      image: anime.coverImage.large,
      nextEpisode: anime.nextAiringEpisode?.episode || null
    };

  } catch (err) {
    console.log(err.message);
    return null;
  }
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await db.collection("users").doc(String(chatId)).set({
    chatId
  }, { merge: true });

  bot.sendMessage(chatId, "Welcome to Anime Dub Tracker 🚀", {
    reply_markup: {
      keyboard: [
        ["📺 Track Anime", "📋 My List"],
        ["❌ Untrack Anime", "🔎 Search"]
      ],
      resize_keyboard: true
    }
  });
});

// ================= MESSAGE HANDLER =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  // ---------- TRACK ----------
  if (text === "📺 Track Anime") {
    userState.set(chatId, { step: "track" });
    return bot.sendMessage(chatId, "✍️ Write Anime Name (e.g. Naruto)");
  }

  // ---------- SEARCH ----------
  if (text === "🔎 Search") {
    userState.set(chatId, { step: "search" });
    return bot.sendMessage(chatId, "🔎 Write Anime Name (e.g. One Piece)");
  }

  // ---------- MY LIST ----------
  if (text === "📋 My List") {
    const user = await db.collection("users").doc(String(chatId)).get();
    const data = user.data();

    if (!data?.animeList?.length) {
      return bot.sendMessage(chatId, "📭 No anime tracked yet");
    }

    const buttons = data.animeList.map(a => ([{
      text: a,
      callback_data: `info_${a}`
    }]));

    return bot.sendMessage(chatId, "📋 Your Anime List:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // ---------- UNTRACK ----------
  if (text === "❌ Untrack Anime") {
    const user = await db.collection("users").doc(String(chatId)).get();
    const data = user.data();

    if (!data?.animeList?.length) {
      return bot.sendMessage(chatId,
        '❌ You aren’t tracking any anime!\nUse Track button.'
      );
    }

    if (data.animeList.length === 1) {
      const anime = data.animeList[0];

      await db.collection("users").doc(String(chatId)).update({
        animeList: admin.firestore.FieldValue.arrayRemove(anime)
      });

      return bot.sendMessage(chatId, `❌ Untracked: ${anime}`);
    }

    const buttons = data.animeList.map(a => ([{
      text: a,
      callback_data: `untrack_${a}`
    }]));

    return bot.sendMessage(chatId, "Select anime to untrack:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // ---------- TRACK INPUT ----------
  const state = userState.get(chatId);

  if (state?.step === "track") {
    const anime = text.trim();

    const info = await getAnimeInfo(anime);
    userState.delete(chatId);

    if (!info) {
      return bot.sendMessage(chatId,
        "❌ No Anime Found🔴 Please Check Spelling"
      );
    }

    await db.collection("users").doc(String(chatId)).set({
      chatId,
      animeList: admin.firestore.FieldValue.arrayUnion(anime.toLowerCase()),
      [`progress.${anime.toLowerCase()}`]: {
        lastEpisode: 0
      }
    }, { merge: true });

    return bot.sendMessage(chatId, `📌 Now tracking ${info.title}`);
  }

  // ---------- SEARCH INPUT ----------
  if (state?.step === "search") {
    const anime = text.trim();

    const info = await getAnimeInfo(anime);
    userState.delete(chatId);

    if (!info) {
      return bot.sendMessage(chatId,
        "❌ No Anime Found🔴 Please Check Spelling"
      );
    }

    return bot.sendPhoto(chatId, info.image, {
      caption:
        `🎬 *${info.title}*\n\n` +
        `⭐ Score: ${info.score}\n` +
        `📺 Episodes: ${info.episodes}\n` +
        `📡 Status: ${info.status}\n` +
        `⏭️ Next Episode: ${info.nextEpisode || "N/A"}\n\n` +
        `${info.synopsis?.slice(0, 200)}...`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{
            text: "📌 Track Anime",
            callback_data: `track_${anime.toLowerCase()}`
          }]
        ]
      }
    });
  }
});

// ================= CALLBACK HANDLER =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // ---------- TRACK ----------
  if (data.startsWith("track_")) {
    const anime = data.replace("track_", "");

    const info = await getAnimeInfo(anime);

    if (!info) {
      return bot.sendMessage(chatId, "❌ Anime not found");
    }

    await db.collection("users").doc(String(chatId)).set({
      chatId,
      animeList: admin.firestore.FieldValue.arrayUnion(anime)
    }, { merge: true });

    return bot.sendMessage(chatId, `📌 Now tracking ${info.title}`);
  }

  // ---------- UNTRACK ----------
  if (data.startsWith("untrack_")) {
    const anime = data.replace("untrack_", "");

    await db.collection("users").doc(String(chatId)).update({
      animeList: admin.firestore.FieldValue.arrayRemove(anime)
    });

    return bot.sendMessage(chatId, `❌ Untracked: ${anime}`);
  }

  // ---------- INFO ----------
  if (data.startsWith("info_")) {
    const anime = data.replace("info_", "");

    const info = await getAnimeInfo(anime);

    if (!info) {
      return bot.sendMessage(chatId, "❌ Not found");
    }

    return bot.sendPhoto(chatId, info.image, {
      caption:
        `🎬 *${info.title}*\n\n` +
        `⭐ Score: ${info.score}\n` +
        `📺 Episodes: ${info.episodes}\n` +
        `📡 Status: ${info.status}\n` +
        `⏭️ Next EP: ${info.nextEpisode || "N/A"}\n\n` +
        `${info.synopsis?.slice(0, 200)}...`,
      parse_mode: "Markdown"
    });
  }
});

// ================= AUTO EPISODE CHECK =================
cron.schedule("0 * * * *", async () => {
  console.log("🔔 Checking anime updates...");

  const users = await db.collection("users").get();

  users.forEach(async (doc) => {
    const data = doc.data();
    if (!data.animeList) return;

    for (let anime of data.animeList) {
      const info = await getAnimeInfo(anime);
      if (!info?.nextEpisode) continue;

      const last = data.progress?.[anime]?.lastEpisode || 0;

      if (info.nextEpisode > last) {
        await db.collection("users").doc(doc.id).set({
          [`progress.${anime}.lastEpisode`]: info.nextEpisode
        }, { merge: true });

        bot.sendMessage(
          data.chatId,
          `🔔 New Episode Released!\n\n🎬 ${info.title}\n📺 Episode ${info.nextEpisode}`
        );
      }
    }
  });
});