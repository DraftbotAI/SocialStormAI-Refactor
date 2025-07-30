// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER
// Finds and returns best-matching video from Pixabay API
// MAX LOGGING EVERY STEP
// ===========================================================

const axios = require('axios');
console.log('[10C][INIT] Pixabay clip helper loaded.');

const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

async function findPixabayClip(subject, sceneIdx, mainTopic) {
  console.log(`[10C][PIXABAY] findPixabayClip | subject="${subject}" sceneIdx=${sceneIdx} mainTopic="${mainTopic}"`);
  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=5`;
    const resp = await axios.get(url);
    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      const best = resp.data.hits[0];
      const maxRes = Object.values(best.videos).sort((a, b) => b.width - a.width)[0];
      if (maxRes && maxRes.url) {
        console.log(`[10C][PIXABAY] Found: ${maxRes.url}`);
        return maxRes.url;
      }
    }
    console.log(`[10C][PIXABAY] No match for "${subject}"`);
    return null;
  } catch (err) {
    console.error('[10C][PIXABAY][ERR] findPixabayClip failed:', err.response?.data || err);
    return null;
  }
}

module.exports = { findPixabayClip };
