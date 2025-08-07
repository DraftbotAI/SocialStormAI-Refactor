// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER (VIDEOS + PHOTOS)
// Finds and downloads best-matching video or photo from Pixabay API
// MAX LOGGING EVERY STEP, Modular System Compatible
// Bulletproof: unique files, dedupe, valid output, crash-proof
// Scoring with universal strict/fuzzy/partial, no skips
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// === Universal scorer import (required!) ===
let scoreSceneCandidate = null;
try {
  scoreSceneCandidate = require('./section10g-scene-scoring-helper.cjs').scoreSceneCandidate;
  console.log('[10C][INIT] Universal scene scorer loaded.');
} catch (e) {
  console.warn('[10C][INIT][WARN] Universal scene scorer NOT loaded, using fallback scoring.');
}

console.log('[10C][INIT] Pixabay clip helper loaded.');

const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
if (!PIXABAY_API_KEY) {
  console.error('[10C][FATAL] Missing PIXABAY_API_KEY in environment!');
}

// --- File validation ---
function isValidClip(filePath, jobId) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[10C][DL][${jobId}] File does not exist: ${filePath}`);
      return false;
    }
    const size = fs.statSync(filePath).size;
    if (size < 2048) {
      console.warn(`[10C][DL][${jobId}] File too small or broken: ${filePath} (${size} bytes)`);
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

// --- Anti-dupe: Checks both full URL and basename ---
function isDupePixabay(url, usedClips = []) {
  if (!url) return false;
  const base = path.basename(url);
  return usedClips.some(u =>
    typeof u === 'string' && (
      u === url ||
      u === base ||
      url.endsWith(u) ||
      base === u
    )
  );
}

// --- Universal scoring: Always uses global scorer if loaded ---
function scorePixabayVideo(hit, vid, subject, usedClips = [], scene = null) {
  if (typeof scoreSceneCandidate === 'function') {
    const candidate = {
      type: 'video',
      source: 'pixabay',
      file: vid.url,
      filename: path.basename(vid.url),
      subject,
      pixabayHit: hit,
      pixabayVid: vid,
      scene,
      isVideo: true
    };
    return scoreSceneCandidate(candidate, scene || subject, usedClips);
  }
  // Fallback: random if global scorer missing (should almost never happen)
  return Math.random() * 100 - (isDupePixabay(vid.url, usedClips) ? 100 : 0);
}

function scorePixabayPhoto(hit, subject, usedClips = []) {
  if (typeof scoreSceneCandidate === 'function') {
    const candidate = {
      type: 'photo',
      source: 'pixabay',
      file: hit.largeImageURL,
      filename: path.basename(hit.largeImageURL),
      subject,
      hit,
      isVideo: false
    };
    return scoreSceneCandidate(candidate, subject, usedClips);
  }
  return Math.random() * 100 - (isDupePixabay(hit.largeImageURL, usedClips) ? 80 : 0);
}

/**
 * Finds and downloads best-scoring Pixabay video for a subject/scene.
 * All normalization, strict/fuzzy/partial, deduping, logging, crash-proof.
 * @param {string|object|array} subject         Main scene subject (string/object/array)
 * @param {string} workDir         Local job folder for saving video
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {Array<string>} usedClips Paths/URLs already used
 * @returns {Promise<string|null>} Local .mp4 path, or null
 */
async function findPixabayClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  // Accept subject as string, object, or array (universal)
  const scene = subject;
  let logSubject = (typeof subject === 'object' && subject.subject) ? subject.subject : subject;
  console.log(`[10C][PIXABAY][${jobId}] findPixabayClipForScene | subject="${logSubject}" | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No Pixabay API key set!');
    return null;
  }
  try {
    let queryStr = (typeof subject === 'object' && subject.subject) ? subject.subject : (Array.isArray(subject) ? subject[0] : subject);
    const query = encodeURIComponent(String(queryStr || '').replace(/[^\w\s]/gi, '').trim()).slice(0, 100);
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=15`;
    console.log(`[10C][PIXABAY][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url);

    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      let scored = [];
      for (const hit of resp.data.hits) {
        const videoCandidates = Object.values(hit.videos || {});
        for (const vid of videoCandidates) {
          if (isDupePixabay(vid.url, usedClips)) {
            console.log(`[10C][PIXABAY][${jobId}][DUPE] Skipping duplicate file: ${vid.url}`);
            continue;
          }
          const score = scorePixabayVideo(hit, vid, scene, usedClips, scene);
          scored.push({ hit, vid, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 7).forEach((s, i) =>
        console.log(`[10C][PIXABAY][${jobId}][CANDIDATE][${i + 1}] ${s.vid.url} | score=${s.score} | size=${s.vid.width}x${s.vid.height}`)
      );

      let best = scored.find(s => s.score > 15) || scored[0];
      if (!best && scored.length > 0) best = scored[0];
      if (best) {
        console.log(`[10C][PIXABAY][${jobId}][PICKED] Selected: ${best.vid.url} | score=${best.score}`);
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${uuidv4()}.mp4`);
        const resultPath = await downloadPixabayVideoToLocal(best.vid.url, outPath, jobId);
        if (resultPath) return resultPath;
      } else {
        console.warn(`[10C][PIXABAY][${jobId}] No Pixabay videos matched subject, but candidates were returned.`);
      }
    } else {
      console.log(`[10C][PIXABAY][${jobId}] No Pixabay video results found for "${logSubject}"`);
    }
    return null;
  } catch (err) {
    if (err.response?.data) {
      console.error('[10C][PIXABAY][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10C][PIXABAY][ERR]', err);
    }
    return null;
  }
}

// --- FIND PIXABAY PHOTO FOR SCENE ---
async function findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  if (!PIXABAY_API_KEY) {
    console.warn('[10C][PIXABAY-PHOTO][ERR] No Pixabay API key set!');
    return null;
  }
  try {
    let queryStr = (typeof subject === 'object' && subject.subject) ? subject.subject : (Array.isArray(subject) ? subject[0] : subject);
    const query = encodeURIComponent(String(queryStr || '').replace(/[^\w\s]/gi, '').trim()).slice(0, 90);
    const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query}&image_type=photo&per_page=12&orientation=vertical`;
    console.log(`[10C][PIXABAY-PHOTO][${jobId}] Request: ${url}`);
    const resp = await axios.get(url, { timeout: 12000 });
    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      let scored = [];
      for (const hit of resp.data.hits) {
        if (isDupePixabay(hit.largeImageURL, usedClips)) {
          console.log(`[10C][PIXABAY-PHOTO][${jobId}] Skipping duplicate photo: ${hit.largeImageURL}`);
          continue;
        }
        const score = scorePixabayPhoto(hit, subject, usedClips);
        scored.push({ hit, score });
      }
      scored.sort((a, b) => b.score - a.score);
      let best = scored.find(s => s.score > 10) || scored[0];
      if (!best && scored.length > 0) best = scored[0];
      if (best) {
        console.log(`[10C][PIXABAY-PHOTO][${jobId}][PICKED] ${best.hit.largeImageURL} | score=${best.score}`);
        return best.hit.largeImageURL;
      }
    }
    console.log(`[10C][PIXABAY-PHOTO][${jobId}] No Pixabay photos found for "${subject}"`);
    return null;
  } catch (err) {
    if (err.response?.data) {
      console.error('[10C][PIXABAY-PHOTO][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10C][PIXABAY-PHOTO][ERR]', err);
    }
    return null;
  }
}

module.exports = {
  findPixabayClipForScene,
  findPixabayPhotoForScene
};
