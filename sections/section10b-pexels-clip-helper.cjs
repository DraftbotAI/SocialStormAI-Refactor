// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER (Video & Photo Search & Download)
// Exports: 
//   - findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
//   - findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips)
// Bulletproof: always tries all options, never blocks on strict match
// Max logs at every step, accepts best available, NO silent fails
// Universal subject/object scoring, anti-dupe, anti-generic
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// === Universal scorer from Section 10G ===
let scoreSceneCandidate = null;
try {
  scoreSceneCandidate = require('./section10g-scene-scoring-helper.cjs').scoreSceneCandidate;
  console.log('[10B][INIT] Universal scene scorer loaded.');
} catch (e) {
  console.warn('[10B][INIT][WARN] Universal scene scorer NOT loaded, using fallback scoring.');
}

console.log('[10B][INIT] Pexels clip helper loaded.');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_API_KEY) {
  console.error('[10B][FATAL] Missing PEXELS_API_KEY in environment!');
}

// --- File validation ---
function isValidClip(filePath, jobId, minSize = 2048) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[10B][DL][${jobId}] File does not exist: ${filePath}`);
      return false;
    }
    const size = fs.statSync(filePath).size;
    if (size < minSize) {
      console.warn(`[10B][DL][${jobId}] File too small or broken: ${filePath} (${size} bytes)`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[10B][DL][${jobId}] File validation error:`, err);
    return false;
  }
}

// --- Download video from Pexels to local file ---
async function downloadPexelsVideoToLocal(url, outPath, jobId) {
  try {
    console.log(`[10B][DL][${jobId}] Downloading Pexels video: ${url} -> ${outPath}`);
    const response = await axios.get(url, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
      const stream = response.data.pipe(fs.createWriteStream(outPath));
      stream.on('finish', () => {
        console.log(`[10B][DL][${jobId}] Video saved to: ${outPath}`);
        resolve();
      });
      stream.on('error', (err) => {
        console.error('[10B][DL][ERR]', err);
        reject(err);
      });
    });
    if (!isValidClip(outPath, jobId)) {
      console.warn(`[10B][DL][${jobId}] Downloaded file is invalid/broken: ${outPath}`);
      return null;
    }
    return outPath;
  } catch (err) {
    console.error('[10B][DL][ERR]', err);
    return null;
  }
}

// --- Download photo from Pexels to local file ---
async function downloadPexelsPhotoToLocal(url, outPath, jobId) {
  try {
    console.log(`[10B][DL][${jobId}] Downloading Pexels photo: ${url} -> ${outPath}`);
    const response = await axios.get(url, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
      const stream = response.data.pipe(fs.createWriteStream(outPath));
      stream.on('finish', () => {
        console.log(`[10B][DL][${jobId}] Photo saved to: ${outPath}`);
        resolve();
      });
      stream.on('error', (err) => {
        console.error('[10B][DL][ERR]', err);
        reject(err);
      });
    });
    if (!isValidClip(outPath, jobId, 2048)) {
      console.warn(`[10B][DL][${jobId}] Downloaded photo file is invalid/broken: ${outPath}`);
      return null;
    }
    return outPath;
  } catch (err) {
    console.error('[10B][DL][ERR]', err);
    return null;
  }
}

// --- Anti-dupe check (checks both URL and basename) ---
function isDupe(fileUrl, usedClips = []) {
  if (!fileUrl) return false;
  const base = path.basename(fileUrl);
  return usedClips.some(u =>
    (typeof u === 'string') &&
    (
      u === fileUrl ||
      u === base ||
      fileUrl.endsWith(u) ||
      base === u
    )
  );
}

// --- SCORING WRAPPER: always uses the universal scorer if loaded ---
function scorePexelsVideo(video, file, subject, usedClips = [], scene = null) {
  if (typeof scoreSceneCandidate === 'function') {
    const candidate = {
      type: 'video',
      source: 'pexels',
      file: file.link,
      filename: path.basename(file.link),
      subject,
      pexelsFile: file,
      scene,
      isVideo: true
    };
    return scoreSceneCandidate(candidate, scene || subject, usedClips);
  }
  // Fallback score (only used if scorer fails to load, logs warning)
  return Math.random() * 100 - (isDupe(file.link, usedClips) ? 100 : 0);
}

function scorePexelsPhoto(photo, subject, usedClips = []) {
  if (typeof scoreSceneCandidate === 'function') {
    const candidate = {
      type: 'photo',
      source: 'pexels',
      file: photo.src.original,
      filename: path.basename(photo.src.original),
      subject,
      photo,
      isVideo: false
    };
    return scoreSceneCandidate(candidate, subject, usedClips);
  }
  // Fallback score (only used if scorer fails to load, logs warning)
  return Math.random() * 100 - (isDupe(photo.src.original, usedClips) ? 80 : 0);
}

/**
 * Finds and downloads the best Pexels video for a given subject/scene,
 * using strict/fuzzy/partial keyword matching. Will always pick the best result available.
 * @returns {Promise<string|null>} Local .mp4 path, or null
 */
async function findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  // Pass object/array/string subject directly to scoring logic!
  const scene = subject;
  let logSubject = (typeof subject === 'object' && subject.subject) ? subject.subject : subject;
  console.log(`[10B][PEXELS][${jobId}] findPexelsClipForScene | subject="${logSubject}" | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  if (!PEXELS_API_KEY) {
    console.error('[10B][PEXELS][ERR] No Pexels API key set!');
    return null;
  }
  try {
    // If subject is object/array, use main for query, but pass full subject to scoring
    let queryStr = (typeof subject === 'object' && subject.subject) ? subject.subject : (Array.isArray(subject) ? subject[0] : subject);
    const query = encodeURIComponent(String(queryStr || '').replace(/[^\w\s]/gi, '').trim());
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=15`;
    console.log(`[10B][PEXELS][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });

    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      let scored = [];
      for (const video of resp.data.videos) {
        const files = (video.video_files || []).filter(f => f.file_type === 'video/mp4');
        for (const file of files) {
          if (isDupe(file.link, usedClips)) {
            console.log(`[10B][PEXELS][${jobId}][DUPE] Skipping duplicate file: ${file.link}`);
            continue;
          }
          const score = scorePexelsVideo(video, file, scene, usedClips, scene);
          scored.push({ video, file, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 7).forEach((s, i) =>
        console.log(`[10B][PEXELS][${jobId}][CANDIDATE][${i + 1}] ${s.file.link} | score=${s.score} | duration=${s.video.duration}s | size=${s.file.width}x${s.file.height}`)
      );
      const maxScore = scored.length ? scored[0].score : -999;
      const hasGoodMatch = maxScore >= 80;
      let eligible = scored;
      if (hasGoodMatch) {
        eligible = scored.filter(s => s.score >= 20);
        if (eligible.length < scored.length) {
          console.log(`[10B][PEXELS][${jobId}] [FILTER] Blocked ${scored.length - eligible.length} irrelevants — real match exists.`);
        }
      }
      let best = eligible.find(s => s.score > 5) || eligible[0];
      if (!best && eligible.length > 0) best = eligible[0];
      if (best) {
        console.log(`[10B][PEXELS][${jobId}][PICKED] Selected: ${best.file.link} | score=${best.score}`);
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-${uuidv4()}.mp4`);
        const resultPath = await downloadPexelsVideoToLocal(best.file.link, outPath, jobId);
        if (resultPath) return resultPath;
      } else {
        console.warn(`[10B][PEXELS][${jobId}] No Pexels videos matched subject, but candidates were returned.`);
      }
    } else {
      console.log(`[10B][PEXELS][${jobId}] No Pexels video results found for "${logSubject}"`);
    }
    return null;
  } catch (err) {
    if (err.response?.data) {
      console.error('[10B][PEXELS][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10B][PEXELS][ERR]', err);
    }
    return null;
  }
}

/**
 * Finds and downloads the best Pexels photo for a given subject/scene,
 * using strict/fuzzy/partial keyword matching. Returns path to the saved photo or null.
 * @returns {Promise<string|null>} Local image file path, or null
 */
async function findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  const scene = subject;
  let logSubject = (typeof subject === 'object' && subject.subject) ? subject.subject : subject;
  console.log(`[10B][PEXELS_PHOTO][${jobId}] findPexelsPhotoForScene | subject="${logSubject}" | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  if (!PEXELS_API_KEY) {
    console.error('[10B][PEXELS_PHOTO][ERR] No Pexels API key set!');
    return null;
  }
  try {
    let queryStr = (typeof subject === 'object' && subject.subject) ? subject.subject : (Array.isArray(subject) ? subject[0] : subject);
    const query = encodeURIComponent(String(queryStr || '').replace(/[^\w\s]/gi, '').trim());
    const url = `https://api.pexels.com/v1/search?query=${query}&per_page=15`;
    console.log(`[10B][PEXELS_PHOTO][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });

    if (resp.data && resp.data.photos && resp.data.photos.length > 0) {
      let scored = [];
      for (const photo of resp.data.photos) {
        if (isDupe(photo.src.original, usedClips)) {
          console.log(`[10B][PEXELS_PHOTO][${jobId}][DUPE] Skipping duplicate photo: ${photo.src.original}`);
          continue;
        }
        const score = scorePexelsPhoto(photo, scene, usedClips);
        scored.push({ photo, score });
      }
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 7).forEach((s, i) =>
        console.log(`[10B][PEXELS_PHOTO][${jobId}][CANDIDATE][${i + 1}] ${s.photo.src.original} | score=${s.score} | size=${s.photo.width}x${s.photo.height}`)
      );
      let best = scored.find(s => s.score > 5) || scored[0];
      if (!best && scored.length > 0) best = scored[0];
      if (best) {
        console.log(`[10B][PEXELS_PHOTO][${jobId}][PICKED] Selected: ${best.photo.src.original} | score=${best.score}`);
        const ext = path.extname(best.photo.src.original) || '.jpg';
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-photo-${uuidv4()}${ext}`);
        const resultPath = await downloadPexelsPhotoToLocal(best.photo.src.original, outPath, jobId);
        if (resultPath) return resultPath;
      } else {
        console.warn(`[10B][PEXELS_PHOTO][${jobId}] No Pexels photos matched subject, but candidates were returned.`);
      }
    } else {
      console.log(`[10B][PEXELS_PHOTO][${jobId}] No Pexels photo results found for "${logSubject}"`);
    }
    return null;
  } catch (err) {
    if (err.response?.data) {
      console.error('[10B][PEXELS_PHOTO][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10B][PEXELS_PHOTO][ERR]', err);
    }
    return null;
  }
}

module.exports = { findPexelsClipForScene, findPexelsPhotoForScene };
