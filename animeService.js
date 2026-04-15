const axios = require("axios");

// ================= ANILIST =================
async function getAniListData(search) {
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

// ================= CONSUMET =================
async function getConsumetData(search) {
  try {
    const res = await axios.get(
      `https://api.consumet.org/anime/gogoanime/${search}`
    );

    return res.data;

  } catch (err) {
    return null;
  }
}

// ================= MERGED DATA =================
async function getFullAnimeData(search) {
  const ani = await getAniListData(search);
  const con = await getConsumetData(search);

  if (!ani) return null;

  // 🔥 merge logic
  return {
    title: ani.title.romaji,
    totalEpisodes: ani.episodes,
    score: ani.averageScore,
    status: ani.status,
    image: ani.coverImage.large,

    // extra from consumet
    consumetEpisodes: con?.episodes?.length || null,

    // 🔥 your custom dub logic (basic)
    dubEpisodes: Math.floor((con?.episodes?.length || 0) * 0.6), // estimate

    nextDubPrediction: "7 days (estimated)"
  };
}

module.exports = { getFullAnimeData };