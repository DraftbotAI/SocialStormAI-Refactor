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

// Utility: Defensive keyword cleaning for Pexels queries
function cleanQuery(str) {
  if (!str) return '';
  // Remove quotes, weird chars, and extra spaces
  return str.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
}

// --- Download video from Pexels to local file ---
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
 * Finds and downloads the best Pexels video for a given subject/scene,
 * using context, deduping, and max logging.
 * @param {string} subject - Main scene subject (clean, descriptive)
 * @param {string} workDir - Local job folder for saving video
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {Array<string>} usedClips - Paths/URLs already used
 * @returns {Promise<string|null>} Local .mp4 path, or null
 */
async function findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  console.log(`[10B][PEXELS][${jobId}] findPexelsClipForScene | subject="${subject}" | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  if (!PEXELS_API_KEY) {
    console.error('[10B][PEXELS][ERR] No Pexels API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(cleanQuery(subject));
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=8`;
    console.log(`[10B][PEXELS][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });

    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      // Score and filter results for best match
      let best = null;
      let bestScore = -1;
      const scores = [];
      for (const video of resp.data.videos) {
        // Prefer HD, then max duration, then closest aspect ratio to 9:16 or 16:9
        const file = video.video_files.find(f => f.quality === 'hd' && f.width >= 720) || video.video_files[0];
        if (!file || !file.link) continue;

        // Score: penalize duplicates, prefer long videos, prefer portrait/landscape based on aspect
        let score = 0;
        if (file.width > file.height) score += 10; // Landscape preferred
        if (file.width / file.height > 1.4 && file.width / file.height < 2.0) score += 5; // 16:9-ish
        score += file.height >= 720 ? 3 : 0;
        score += file.file_type === 'video/mp4' ? 1 : 0;
        score += Math.floor(file.width / 100);

        // Check for dupe
        if (usedClips && usedClips.some(u => u.includes(file.link) || file.link.includes(u))) {
          score -= 100;
        }

        scores.push({ file, score });
        if (score > bestScore) {
          best = file;
          bestScore = score;
        }
      }
      scores.sort((a, b) => b.score - a.score);
      console.log(`[10B][PEXELS][${jobId}] Top Pexels file scores:`, scores.slice(0, 3).map(s => ({ url: s.file.link, score: s.score })));

      if (best && best.link && bestScore >= 0) {
        // Download to local
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-${uuidv4()}.mp4`);
        return await downloadPexelsVideoToLocal(best.link, outPath);
      }
    }
    console.log(`[10B][PEXELS][${jobId}] No video match found for "${subject}"`);
    return null;
  } catch (err) {
    // Log actual error payload from Pexels if present
    if (err.response?.data) {
      console.error('[10B][PEXELS][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10B][PEXELS][ERR]', err);
    }
    return null;
  }
}

module.exports = { findPexelsClipForScene };
