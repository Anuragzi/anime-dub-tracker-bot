const axios = require("axios");
const cron = require("node-cron");
const admin = require("firebase-admin");
const db = require("./firebase");
const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

console.log("🚀 Bot is running");

// ================== ANILIST FUNCTION ==================
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
          }
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
      nextEpisode: anime.nextAiringEpisode?.episode || "N/A"
    };

  } catch (err) {
    console.log("AniList error:", err.response?.data || err.message);
    return null;
  }
}

// ================== START ==================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await db.collection("users").doc(String(chatId)).set({
    chatId
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

// ================== SEARCH ==================
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  try {
    const res = await axios.post("https://graphql.anilist.co", {
      query: `
        query ($search: String) {
          Page(perPage: 5) {
            media(search: $search, type: ANIME) {
              title {
                romaji
              }
            }
          }
        }
      `,
      variables: { search: query }
    });

    const results = res.data.data.Page.media;

    if (!results.length) {
      return bot.sendMessage(chatId, "❌ No results found");
    }

    results.forEach(anime => {
      bot.sendMessage(chatId, `🎬 ${anime.title.romaji}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Track", callback_data: `track_${anime.title.romaji}` }]
          ]
        }
      });
    });

  } catch (err) {
    console.log(err);
    bot.sendMessage(chatId, "⚠️ Error searching anime");
  }
});

// ================== TRACK ==================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("track_")) {
    const anime = data.replace("track_", "").trim();

    try {
      await db.collection("users").doc(String(chatId)).set({
        chatId,
        animeList: admin.firestore.FieldValue.arrayUnion(anime.toLowerCase())
      }, { merge: true });

      const info = await getAnimeInfo(anime);

      if (!info) {
        return bot.sendMessage(chatId, "❌ Anime not found");
      }

      bot.sendPhoto(chatId, info.image, {
        caption:
          `🎬 *${info.title}*\n\n` +
          `⭐ Score: ${info.score}\n` +
          `📺 Episodes: ${info.episodes}\n` +
          `📡 Status: ${info.status}\n` +
          `⏭️ Next EP: ${info.nextEpisode}\n\n` +
          `${info.synopsis?.slice(0, 200)}...`,
        parse_mode: "Markdown"
      });

    } catch (err) {
      console.log(err);
      bot.sendMessage(chatId, "⚠️ Error tracking anime");
    }
  }
});

// ================== UNTRACK ==================
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

// ================== AUTO CHECK (SAFE) ==================
cron.schedule("0 * * * *", async () => {
  console.log("⏳ Checking updates...");

  // (We will add real update logic later)
});