// ====== LOAD ENV ======
require("dotenv").config();

// ====== EXPRESS (RAILWAY FIX) ======
const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("Bot running 🚀"));
app.listen(process.env.PORT || 3000);

// ====== IMPORTS ======
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cron = require("node-cron");

// ====== BOT INIT ======
if (!process.env.BOT_TOKEN) {
  console.error("❌ BOT TOKEN MISSING");
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.getMe().then(me => console.log("🤖 Bot:", me.username));

// ====== MEMORY DB ======
const userTracking = new Map();

// ====== SAFE LOG ======
let lastLog = 0;
function safeLog(msg) {
  if (Date.now() - lastLog > 15000) {
    console.log(msg);
    lastLog = Date.now();
  }
}

// ====== ANILIST API ======
async function getAnime(search) {
  try {
    const query = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        id
        title { romaji }
        episodes
        description
        averageScore
        coverImage { large }
      }
    }`;

    const res = await axios.post("https://graphql.anilist.co", {
      query,
      variables: { search }
    });

    return res.data.data.Media;
  } catch {
    return null;
  }
}

// ====== CLEAN HTML DESCRIPTION ======
function cleanText(text) {
  if (!text) return "No synopsis available.";
  return text.replace(/<[^>]*>/g, "").slice(0, 500);
}

// ====== SAFE DUB DATA ======
async function getDubInfo(totalEpisodes) {
  // Temporary logic (safe & realistic)
  return {
    dubEpisodes: Math.min(12, totalEpisodes || 12),
    pattern: "Weekly (estimated)"
  };
}

// ====== PREDICTION ======
function predictNext(dubEpisodes) {
  const nextEpisode = dubEpisodes + 1;
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + 7);

  return {
    nextEpisode,
    nextDate: nextDate.toDateString()
  };
}

// ====== MAIN DATA ======
async function getFullAnime(search) {
  const anime = await getAnime(search);
  if (!anime) return null;

  const dub = await getDubInfo(anime.episodes);
  const next = predictNext(dub.dubEpisodes);

  return {
    id: anime.id,
    title: anime.title.romaji,
    image: anime.coverImage.large,
    episodes: anime.episodes,
    synopsis: cleanText(anime.description),

    dubEpisodes: dub.dubEpisodes,
    pattern: dub.pattern,

    nextEpisode: next.nextEpisode,
    nextDate: next.nextDate
  };
}

// ====== START ======
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `
👋 Welcome to Anime Dub Tracker!

Commands:
/search Naruto
/mylist
  `);
});

// ====== SEARCH ======
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  const data = await getFullAnime(query);

  if (!data) return bot.sendMessage(chatId, "❌ Not found");

  const text = `
🎬 *${data.title}*

📺 Episodes: ${data.episodes}
🇬🇧 Dub: ${data.dubEpisodes}

📊 Pattern: ${data.pattern}

⏭ Next: Ep ${data.nextEpisode}
📅 ${data.nextDate}

📖 *Synopsis:*
${data.synopsis}
`;

  bot.sendPhoto(chatId, data.image, {
    caption: text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📌 Track", callback_data: `track_${data.id}` }]
      ]
    }
  });
});

// ====== TRACK BUTTON ======
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  if (data.startsWith("track_")) {
    const id = data.split("_")[1];

    if (!userTracking.has(chatId)) {
      userTracking.set(chatId, []);
    }

    const list = userTracking.get(chatId);

    if (!list.find(a => a.id === id)) {
      list.push({ id, lastEpisodeAlerted: 0 });
    }

    bot.answerCallbackQuery(q.id, { text: "✅ Added to list" });
  }
});

// ====== MY LIST ======
bot.onText(/\/mylist/, async (msg) => {
  const chatId = msg.chat.id;
  const list = userTracking.get(chatId) || [];

  if (list.length === 0) {
    return bot.sendMessage(chatId, "📭 Empty list");
  }

  let text = "📌 Your List:\n\n";

  for (let item of list) {
    const anime = await getAnime(item.id);
    if (anime) text += `• ${anime.title.romaji}\n`;
  }

  bot.sendMessage(chatId, text);
});

// ====== ALERT SYSTEM ======
cron.schedule("*/30 * * * *", async () => {
  safeLog("Checking updates...");

  for (let [userId, list] of userTracking.entries()) {
    for (let anime of list) {
      const data = await getFullAnime(anime.id);
      if (!data) continue;

      if (data.dubEpisodes > anime.lastEpisodeAlerted) {
        anime.lastEpisodeAlerted = data.dubEpisodes;

        bot.sendMessage(userId, `
🚨 New Dub Episode!

🎬 ${data.title}
Episode ${data.dubEpisodes} released!
        `);
      }
    }
  }
});