// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER
// Finds and downloads best-matching video from Pixabay API
// MAX LOGGING EVERY STEP, Modular System Compatible
// Bulletproof: unique files, dedupe, valid output, crash-proof
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

// --- Utility: Clean query for Pixabay ---
function cleanQuery(str) {
  if (!str) return '';
  return str.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
}

// --- File validation ---
function isValidClip(path, jobId) {
  try {
    if (!fs.existsSync(path)) {
      console.warn(`[10C][DL][${jobId}] File does not exist: ${path}`);
      return false;
    }
    const size = fs.statSync(path).size;
    if (size < 2048) {
      console.warn(`[10C][DL][${jobId}] File too small or broken: ${path} (${size} bytes)`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[10C][DL][${jobId}] File validation error:`, err);
    return false;
  }
}

// --- Download video from Pixabay to local file ---
async function downloadPixabayVideoToLocal(url, outPath, jobId) {
  try {
    console.log(`[10C][DL][${jobId}] Downloading Pixabay video: ${url} -> ${outPath}`);
    const response = await axios.get(url, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
      const stream = response.data.pipe(fs.createWriteStream(outPath));
      stream.on('finish', () => {
        console.log(`[10C][DL][${jobId}] Video saved to: ${outPath}`);
        resolve();
      });
      stream.on('error', (err) => {
        console.error('[10C][DL][ERR]', err);
        reject(err);
      });
    });
    if (!isValidClip(outPath, jobId)) {
      console.warn(`[10C][DL][${jobId}] Downloaded file is invalid/broken: ${outPath}`);
      return null;
    }
    return outPath;
  } catch (err) {
    console.error('[10C][DL][ERR]', err);
    return null;
  }
}

/**
 * Finds and downloads best Pixabay video for a given subject/scene,
 * scoring by resolution, aspect, deduping, and full trace logging.
 * @param {string} subject         Main scene subject (clean, descriptive)
 * @param {string} workDir         Local job folder for saving video
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {Array<string>} usedClips Paths/URLs already used
 * @returns {Promise<string|null>} Local .mp4 path, or null
 */
async function findPixabayClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  console.log(`[10C][PIXABAY][${jobId}] findPixabayClipForScene | subject="${subject}" | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No Pixabay API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(cleanQuery(subject));
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=8`;
    console.log(`[10C][PIXABAY][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url);

    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      // Score and filter results for best match
      let best = null;
      let bestScore = -1;
      const scores = [];

      for (const hit of resp.data.hits) {
        // Prefer max resolution, then aspect (landscape), then dedupe
        const videoCandidates = Object.values(hit.videos);
        for (const vid of videoCandidates) {
          let score = 0;
          score += Math.floor(vid.width / 100);
          if (vid.height >= 720) score += 2;
          if (vid.width > vid.height) score += 2;
          // Deduplication check (inclusive both ways)
          if (vid.url && usedClips && usedClips.some(u => u.includes(vid.url) || vid.url.includes(u))) score -= 100;
          scores.push({ vid, score });
          if (score > bestScore) {
            best = vid;
            bestScore = score;
          }
        }
      }
      scores.sort((a, b) => b.score - a.score);
      console.log(`[10C][PIXABAY][${jobId}] Top Pixabay file scores:`, scores.slice(0, 3).map(s => ({ url: s.vid.url, score: s.score })));

      if (best && best.url && bestScore >= 0) {
        // Always unique per job/scene/clip
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${uuidv4()}.mp4`);
        return await downloadPixabayVideoToLocal(best.url, outPath, jobId);
      }
    }
    console.log(`[10C][PIXABAY][${jobId}] No video match found for "${subject}"`);
    return null;
  } catch (err) {
    // Log actual error payload from Pixabay if present
    if (err.response?.data) {
      console.error('[10C][PIXABAY][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10C][PIXABAY][ERR]', err);
    }
    return null;
  }
}

module.exports = { findPixabayClipForScene };
