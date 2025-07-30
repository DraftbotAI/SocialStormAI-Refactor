// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER
// Finds and downloads best-matching video from Pexels API
// MAX LOGGING EVERY STEP, Modular System Compatible
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

console.log('[10B][INIT] Pexels clip helper loaded.');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

if (!PEXELS_API_KEY) {
  console.error('[10B][FATAL] Missing PEXELS_API_KEY in environment!');
}

async function downloadPexelsVideoToLocal(url, outPath) {
  try {
    console.log(`[10B][DL] Downloading Pexels video: ${url} -> ${outPath}`);
    const response = await axios.get(url, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
      const stream = response.data.pipe(fs.createWriteStream(outPath));
      stream.on('finish', () => {
        console.log(`[10B][DL] Video saved to: ${outPath}`);
        resolve();
      });
      stream.on('error', (err) => {
        console.error('[10B][DL][ERR] Write error:', err);
        reject(err);
      });
    });
    return outPath;
  } catch (err) {
    console.error('[10B][DL][ERR] Failed to download Pexels video:', err);
    return null;
  }
}

/**
 * Finds and downloads best Pexels video for a given subject/scene.
 * @param {string} sceneText
 * @param {string} workDir  - Local job folder for saving video
 * @param {number} sceneIdx
 * @param {string} jobId
 * @returns {Promise<string|null>} Local .mp4 path, or null
 */
async function findPexelsClipForScene(sceneText, workDir, sceneIdx, jobId) {
  console.log(`[10B][PEXELS] findPexelsClipForScene | sceneText="${sceneText}" workDir="${workDir}" sceneIdx=${sceneIdx} jobId=${jobId}`);

  if (!PEXELS_API_KEY) {
    console.error('[10B][PEXELS][ERR] No Pexels API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(sceneText);
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=5`;
    console.log(`[10B][PEXELS] Searching: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });

    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      // Pick best file (prefer HD)
      const best = resp.data.videos[0];
      const file = best.video_files.find(f => f.quality === 'hd' && f.width >= 720) || best.video_files[0];
      if (file && file.link) {
        // Download to local
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-${uuidv4()}.mp4`);
        return await downloadPexelsVideoToLocal(file.link, outPath);
      }
    }
    console.log(`[10B][PEXELS] No match for "${sceneText}"`);
    return null;
  } catch (err) {
    console.error('[10B][PEXELS][ERR] findPexelsClipForScene failed:', err.response?.data || err);
    return null;
  }
}

module.exports = { findPexelsClipForScene };
