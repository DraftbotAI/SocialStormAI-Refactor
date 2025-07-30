// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER
// Finds and downloads best-matching video from Pixabay API
// MAX LOGGING EVERY STEP, Modular System Compatible
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

console.log('[10C][INIT] Pixabay clip helper loaded.');

const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

if (!PIXABAY_API_KEY) {
  console.error('[10C][FATAL] Missing PIXABAY_API_KEY in environment!');
}

async function downloadPixabayVideoToLocal(url, outPath) {
  try {
    console.log(`[10C][DL] Downloading Pixabay video: ${url} -> ${outPath}`);
    const response = await axios.get(url, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
      const stream = response.data.pipe(fs.createWriteStream(outPath));
      stream.on('finish', () => {
        console.log(`[10C][DL] Video saved to: ${outPath}`);
        resolve();
      });
      stream.on('error', (err) => {
        console.error('[10C][DL][ERR] Write error:', err);
        reject(err);
      });
    });
    return outPath;
  } catch (err) {
    console.error('[10C][DL][ERR] Failed to download Pixabay video:', err);
    return null;
  }
}

/**
 * Finds and downloads best Pixabay video for a given subject/scene.
 * @param {string} sceneText
 * @param {string} workDir  - Local job folder for saving video
 * @param {number} sceneIdx
 * @param {string} jobId
 * @returns {Promise<string|null>} Local .mp4 path, or null
 */
async function findPixabayClipForScene(sceneText, workDir, sceneIdx, jobId) {
  console.log(`[10C][PIXABAY] findPixabayClipForScene | sceneText="${sceneText}" workDir="${workDir}" sceneIdx=${sceneIdx} jobId=${jobId}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No Pixabay API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(sceneText);
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=5`;
    console.log(`[10C][PIXABAY] Searching: ${url}`);
    const resp = await axios.get(url);

    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      // Pick best video (prefer highest res)
      const best = resp.data.hits[0];
      const maxRes = Object.values(best.videos).sort((a, b) => b.width - a.width)[0];
      if (maxRes && maxRes.url) {
        // Download to local
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${uuidv4()}.mp4`);
        return await downloadPixabayVideoToLocal(maxRes.url, outPath);
      }
    }
    console.log(`[10C][PIXABAY] No match for "${sceneText}"`);
    return null;
  } catch (err) {
    console.error('[10C][PIXABAY][ERR] findPixabayClipForScene failed:', err.response?.data || err);
    return null;
  }
}

module.exports = { findPixabayClipForScene };
