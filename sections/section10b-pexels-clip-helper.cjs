// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER
// Finds and returns best-matching video from Pexels API
// MAX LOGGING EVERY STEP
// ===========================================================

const axios = require('axios');
console.log('[10B][INIT] Pexels clip helper loaded.');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function findPexelsClip(subject, sceneIdx, mainTopic) {
  console.log(`[10B][PEXELS] findPexelsClip | subject="${subject}" sceneIdx=${sceneIdx} mainTopic="${mainTopic}"`);
  if (!PEXELS_API_KEY) {
    console.error('[10B][PEXELS][ERR] No API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=5`;
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      const best = resp.data.videos[0];
      const file = best.video_files.find(f => f.quality === 'hd') || best.video_files[0];
      if (file && file.link) {
        console.log(`[10B][PEXELS] Found: ${file.link}`);
        return file.link;
      }
    }
    console.log(`[10B][PEXELS] No match for "${subject}"`);
    return null;
  } catch (err) {
    console.error('[10B][PEXELS][ERR] findPexelsClip failed:', err.response?.data || err);
    return null;
  }
}

module.exports = { findPexelsClip };
