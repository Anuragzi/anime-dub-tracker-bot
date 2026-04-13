const axios = require("axios");
const cron = require("node-cron");
const admin = require("firebase-admin");
const db = require("./firebase");

async function getAnimeInfo(search) {
  try {
    const query = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          title {
            romaji
          }
          episodes
          status
          averageScore
          description
          coverImage {
            large
          }
          nextAiringEpisode {
            episode
            airingAt
          }
        }
      }
    `;

    const res = await axios.post("https://graphql.anilist.co", {
      query,
      variables: { search }
    });

    const anime = res.data.data.Media;

    if (!anime) return null; // ✅ IMPORTANT

    return {
      title: anime.title.romaji,
      episodes: anime.episodes,
      status: anime.status,
      score: anime.averageScore,
      synopsis: anime.description,
      image: anime.coverImage.large,
      nextEpisode: anime.nextAiringEpisode?.episode
    };

  } catch (err) {
    console.log("AniList error:", err.response?.data || err.message);
    return null;
  }
}


console.log("New Code Is Running");
const TelegramBot = require('node-telegram-bot-api');

const token = "7696335583:AAFxOQ9tS1KGmvszb0xNcpjAigfBxJmiinQ";

const bot = new TelegramBot(token, { polling: true });

// store users
const users = new Set();

// when someone starts bot
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  db.collection("users").doc(String(chatId)).set({
    chatId: chatId
  }, { merge: true });

  bot.sendMessage(chatId, "Welcome to Anime Dub Tracker 🚀", {
    reply_markup: {
      keyboard: [
        ["📺 Track Anime", "📋 My List"],
        ["❌ Untrack Anime"]
      ],
      resize_keyboard: true
    }
  });
});


// store every user
bot.on("message", async (msg) => {
  const userId = msg.chat.id;

  await db.collection("users").doc(userId.toString()).set({
    id: userId
  });

  console.log("User saved:", userId);
});

// 🔥 BROADCAST COMMAND (only you use this)
bot.onText(/\/anime (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1];

  const ADMIN_ID = 5096633005; // your ID

  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, "❌ Not allowed");
  }

  const [animeName, ...rest] = text.split(" ");
  const message = rest.join(" ");

  try {
    const usersSnapshot = await db.collection("users").get();

    usersSnapshot.forEach((doc) => {
      const user = doc.data();

      if (user.animeList && user.animeList.includes(animeName.toLowerCase())) {
        bot.sendMessage(user.chatId, `📢 ${animeName.toUpperCase()} UPDATE:\n${message}`);
      }
    });

    bot.sendMessage(chatId, "✅ Targeted update sent!");
  } catch (err) {
    console.log(err);
  }
});

bot.onText(/\/track (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const anime = match[1].toLowerCase();

  try {
    await db.collection("users").doc(String(chatId)).set({
      chatId: chatId,
      animeList: admin.firestore.FieldValue.arrayUnion(anime)
    }, { merge: true });

    bot.sendMessage(chatId, `✅ You are now tracking: ${anime}`);
  } catch (err) {
    console.log(err);
    bot.sendMessage(chatId, "❌ Error tracking anime");
  }
});


cron.schedule("*/5 * * * *", async () => {
  console.log("⏳ Checking for updates...");

  // 🔥 TEMP: fake update (we replace later with real API)
  

  try {
    const usersSnapshot = await db.collection("users").get();

    usersSnapshot.forEach((doc) => {
      const user = doc.data();

      if (user.animeList && user.animeList.includes(animeName)) {
        bot.sendMessage(
          user.chatId,
          `📢 ${animeName.toUpperCase()} UPDATE:\n${updateMessage}`
        );
      }
    });

    console.log("✅ Auto update sent");
  } catch (err) {
    console.log(err);
  }
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  const res = await axios.get(`https://api.jikan.moe/v4/anime?q=${query}`);
  const results = res.data.data.slice(0, 5);

  results.forEach(anime => {
    bot.sendMessage(chatId, `🎬 ${anime.title}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Track", callback_data: `track_${anime.title.romaji}` }]
        ]
      }
    });
  });
});

bot.onText(/\/untrack (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const anime = match[1].toLowerCase();

  try {
    await db.collection("users").doc(String(chatId)).update({
      animeList: admin.firestore.FieldValue.arrayRemove(anime)
    });

    bot.sendMessage(chatId, `❌ Removed: ${anime}`);
  } catch (err) {
    console.log(err);
    bot.sendMessage(chatId, "Error removing anime");
  }
});


bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("track_")) {
    const anime = data.replace("track_", "").trim();

    try {
      const info = await getAnimeInfo(anime);

      if (info) {
        bot.sendPhoto(chatId, info.image, {
          caption:
            `🎬 *${info.title}*\n\n` +
            `⭐ Score: ${info.score}\n` +
            `📺 Episodes: ${info.episodes}\n` +
            `📡 Status: ${info.status}\n` +
            `⏭️ Next EP: ${info.nextEpisode || "N/A"}\n\n` +
            `${info.synopsis?.slice(0, 200)}...`,
          parse_mode: "Markdown"
        });
      } else {
        bot.sendMessage(chatId, "❌ Anime not found");
      }

    } catch (error) {
      console.log(error);
      bot.sendMessage(chatId, "⚠️ Error fetching anime info");
    }
  }
});