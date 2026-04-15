require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cron = require("node-cron");

// ====== BOT INIT ======
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ====== STATE ======
const userState = new Map();

// ====== DATABASE (temporary in-memory) ======
const userTracking = new Map(); 
// structure: userId => [{ title, lastEpisodeAlerted }]

// ====== LOG CONTROL (FIX RAILWAY ISSUE) ======
let lastLog = 0;
function safeLog(msg) {
  const now = Date.now();
  if (now - lastLog > 15000) { // log only every 15 sec
    console.log(msg);
    lastLog = now;
  }
}

// ====== ANILIST FETCH ======
async function getAnimeBasic(search) {
  try {
    const query = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          title { romaji }
          episodes
          status
          averageScore
          coverImage { large }
        }
      }
    `;

    const res = await axios.post("https://graphql.anilist.co", {
      query,
      variables: { search }
    });

    return res.data.data.Media;
  } catch (err) {
    return null;
  }
}

// ====== FAKE DUB DATA (Replace with Consumet later) ======
async function getDubData(title) {
  // You can later replace this with Consumet API
  return {
    dubEpisodes: Math.floor(Math.random() * 12) + 1,
    totalEpisodes: 24,
    pattern: "Weekly (Sunday)",
  };
}

// ====== SMART PREDICTION ======
function predictNextEpisode(dubEpisodes) {
  const nextEpisode = dubEpisodes + 1;

  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + 7);

  return {
    nextEpisode,
    nextDate: nextDate.toDateString()
  };
}

// ====== MAIN DATA FUNCTION ======
async function getFullAnimeData(search) {
  const basic = await getAnimeBasic(search);
  if (!basic) return null;

  const dub = await getDubData(basic.title.romaji);

  const prediction = predictNextEpisode(dub.dubEpisodes);

  return {
    title: basic.title.romaji,
    image: basic.coverImage.large,
    score: basic.averageScore,
    totalEpisodes: basic.episodes,

    dubEpisodes: dub.dubEpisodes,
    pattern: dub.pattern,

    nextEpisode: prediction.nextEpisode,
    nextDate: prediction.nextDate
  };
}

// ====== SEARCH HANDLER ======
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  const info = await getFullAnimeData(query);

  if (!info) {
    return bot.sendMessage(chatId, "❌ Anime not found");
  }

  const text = `
🎬 *${info.title}*

🇬🇧 Dub Episodes: ${info.dubEpisodes}/${info.totalEpisodes}
📊 Pattern: ${info.pattern}

⏭ Next Episode: ${info.nextEpisode}
📅 Expected: ${info.nextDate}
`;

  bot.sendPhoto(chatId, info.image, {
    caption: text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📌 Track", callback_data: `track_${info.title}` }]
      ]
    }
  });
});

// ====== BUTTON HANDLER ======
bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("track_")) {
    const title = data.replace("track_", "");

    if (!userTracking.has(chatId)) {
      userTracking.set(chatId, []);
    }

    const list = userTracking.get(chatId);

    if (!list.find(a => a.title === title)) {
      list.push({ title, lastEpisodeAlerted: 0 });
    }

    bot.sendMessage(chatId, `✅ Tracking ${title}`);
  }
});

// ====== MY LIST ======
bot.onText(/\/mylist/, (msg) => {
  const chatId = msg.chat.id;

  const list = userTracking.get(chatId) || [];

  if (list.length === 0) {
    return bot.sendMessage(chatId, "📭 Your list is empty");
  }

  let text = "📌 Your Tracked Anime:\n\n";
  list.forEach((a, i) => {
    text += `${i + 1}. ${a.title}\n`;
  });

  bot.sendMessage(chatId, text);
});

// ====== SMART ALERT SYSTEM (NO SPAM) ======
cron.schedule("*/30 * * * *", async () => {
  safeLog("Checking updates...");

  for (let [userId, list] of userTracking.entries()) {
    for (let anime of list) {
      const info = await getFullAnimeData(anime.title);

      if (!info) continue;

      // ALERT ONLY IF NEW EPISODE
      if (info.dubEpisodes > anime.lastEpisodeAlerted) {
        anime.lastEpisodeAlerted = info.dubEpisodes;

        bot.sendMessage(userId, `
🚨 *New Dub Episode Released!*

🎬 ${info.title}
🎉 Episode ${info.dubEpisodes} is now available!
        `, { parse_mode: "Markdown" });
      }
    }
  }
});