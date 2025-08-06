// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER
// Finds and downloads best-matching video from Pixabay API
// MAX LOGGING EVERY STEP, Modular System Compatible
// Bulletproof: unique files, dedupe, valid output, crash-proof
// 2024-08: Scoring with strict/fuzzy/partial keyword filter, no skips
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// === Universal scorer import stub (ready to wire) ===
let scoreSceneCandidate = null;
try {
  scoreSceneCandidate = require('./section10g-scene-scoring-helper.cjs').scoreSceneCandidate;
  console.log('[10C][INIT] Universal scene scorer loaded.');
} catch (e) {
  // Not fatal, fallback to local scoring logic for now
  console.warn('[10C][INIT][WARN] Universal scene scorer NOT loaded, using local scoring.');
}

console.log('[10C][INIT] Pixabay clip helper loaded.');

const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
if (!PIXABAY_API_KEY) {
  console.error('[10C][FATAL] Missing PIXABAY_API_KEY in environment!');
}

// --- Utility: Query normalization & keyword helpers ---
function cleanQuery(str) {
  if (!str) return '';
  return str.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
}
function getKeywords(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s\-]+/)
    .filter(w => w.length > 2);
}
function majorWords(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
}
function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Match helpers (handles underscores, loose matches, etc) ---
function strictSubjectMatchPixabay(filename, subject) {
  if (!filename || !subject) return false;
  const safeSubject = cleanQuery(subject).replace(/\s+/g, '_');
  const re = new RegExp(`(^|_|-)${safeSubject}(_|-|\\.|$)`, 'i');
  return re.test(filename.replace(/ /g, '_'));
}
function fuzzyMatchPixabay(filename, subject) {
  if (!filename || !subject) return false;
  const fn = normalizeForMatch(filename);
  const words = majorWords(subject);
  return words.length && words.every(word => fn.includes(word));
}
function partialMatchPixabay(filename, subject) {
  if (!filename || !subject) return false;
  const fn = normalizeForMatch(filename);
  const words = majorWords(subject);
  return words.some(word => fn.includes(word));
}

// --- Dedupe (anti-repeat) ---
function isDupePixabay(url, usedClips = []) {
  if (!url) return false;
  return usedClips.some(u =>
    typeof u === 'string' && (
      u === url ||
      u.endsWith(path.basename(url)) ||
      u.includes(url) ||
      url.includes(u)
    )
  );
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

// --- Scoring (strict > fuzzy > partial > fallback, anti-dupe!) ---
// Uses universal scorer if present, else local fallback
function scorePixabayMatch(hit, vid, subject, usedClips = [], scene = null) {
  if (typeof scoreSceneCandidate === 'function') {
    // Use the universal scoring system (10G)
    const candidate = {
      type: 'video',
      source: 'pixabay',
      file: vid.url,
      filename: path.basename(vid.url),
      subject,
      pixabayHit: hit,
      pixabayVid: vid,
      scene,
    };
    return scoreSceneCandidate(candidate, scene || { subject });
  }

  // --- Local fallback scoring logic ---
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);
  const filename = (vid.url || '').split('/').pop();

  // Deduplication (anti-repeat) – penalize any kind of dupe
  if (isDupePixabay(vid.url, usedClips)) score -= 100;

  // Score subject in filename (strict > fuzzy > partial)
  if (strictSubjectMatchPixabay(filename, subject)) score += 90;
  else if (fuzzyMatchPixabay(filename, subject)) score += 28;
  else if (partialMatchPixabay(filename, subject)) score += 14;

  // Metadata keyword/phrase
  const fields = [
    ...(hit.tags ? hit.tags.split(',').map(t => t.trim()) : []),
    hit.user || '',
    hit.pageURL || '',
    vid.url || ''
  ].join(' ').toLowerCase();

  if (fields.includes(cleanedSubject) && cleanedSubject.length > 2) score += 45;
  if (subjectWords.every(w => fields.includes(w)) && subjectWords.length > 1) score += 25;
  subjectWords.forEach(word => { if (fields.includes(word)) score += 5; });

  // Aspect/size
  if (vid.height > vid.width) score += 8; // Portrait
  if (vid.width > vid.height) score += 6; // Landscape
  if (vid.height >= 720) score += 7;
  score += Math.floor(vid.width / 120);

  // Penalize very short
  if (hit.duration && hit.duration < 4) score -= 8;
  if (hit.id && Number(hit.id) > 1000000) score += 2;

  // Bonus: shorter filename, newer id, better match
  score -= filename.length;
  return score;
}

/**
 * Finds and downloads best-scoring Pixabay video for a subject/scene.
 * All normalization, strict/fuzzy/partial, deduping, logging, crash-proof.
 * @param {string|object} subject         Main scene subject (string or scene object with .subject)
 * @param {string} workDir         Local job folder for saving video
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {Array<string>} usedClips Paths/URLs already used
 * @returns {Promise<string|null>} Local .mp4 path, or null
 */
async function findPixabayClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  // Accept scene object OR raw subject string (backward compatible)
  const scene = typeof subject === 'object' && subject.subject ? subject : { subject };
  console.log(`[10C][PIXABAY][${jobId}] findPixabayClipForScene | subject="${scene.subject}" | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No Pixabay API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(cleanQuery(scene.subject)).slice(0, 100);
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=15`;
    console.log(`[10C][PIXABAY][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url);

    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      let scored = [];
      for (const hit of resp.data.hits) {
        const videoCandidates = Object.values(hit.videos || {});
        for (const vid of videoCandidates) {
          // Do NOT add to scored if dupe
          if (isDupePixabay(vid.url, usedClips)) {
            console.log(`[10C][PIXABAY][${jobId}][DUPE] Skipping duplicate file: ${vid.url}`);
            continue;
          }
          const score = scorePixabayMatch(hit, vid, scene.subject, usedClips, scene);
          scored.push({ hit, vid, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 7).forEach((s, i) =>
        console.log(`[10C][PIXABAY][${jobId}][CANDIDATE][${i + 1}] ${s.vid.url} | score=${s.score} | size=${s.vid.width}x${s.vid.height}`)
      );

      // Always pick the best available, even if score is low
      let best = scored.find(s => s.score > 15) || scored[0];
      if (!best && scored.length > 0) best = scored[0];
      if (best) {
        console.log(`[10C][PIXABAY][${jobId}][PICKED] Selected: ${best.vid.url} | score=${best.score}`);
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${uuidv4()}.mp4`);
        const resultPath = await downloadPixabayVideoToLocal(best.vid.url, outPath, jobId);
        if (resultPath) return resultPath;
        // If download fails, try next best (not implemented here, fallback handled by 5D)
      } else {
        console.warn(`[10C][PIXABAY][${jobId}] No Pixabay videos matched subject, but candidates were returned.`);
      }
    } else {
      console.log(`[10C][PIXABAY][${jobId}] No Pixabay video results found for "${scene.subject}"`);
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

module.exports = { findPixabayClipForScene };
