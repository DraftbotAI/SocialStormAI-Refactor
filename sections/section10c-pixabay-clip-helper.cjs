// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER
// Finds and downloads best-matching video from Pixabay API
// MAX LOGGING EVERY STEP, Modular System Compatible
// Bulletproof: unique files, dedupe, valid output, crash-proof
// 2024-08: Strict subject keyword filter, zero skips
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

function getKeywords(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s\-]+/)
    .filter(w => w.length > 2);
}

// --- Strict subject present: ALL keywords in metadata ---
function strictSubjectPresentPixabay(fields, subject) {
  const subjectWords = getKeywords(subject);
  if (!subjectWords.length) return false;
  return subjectWords.every(w => fields.includes(w));
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

// --- Scoring: Only score if strict subject present in fields ---
function scorePixabayMatch(hit, vid, subject, usedClips = []) {
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);

  // Phrase/keyword fields for scoring
  const fields = [
    ...(hit.tags ? hit.tags.split(',').map(t => t.trim()) : []),
    hit.user || '',
    hit.pageURL || '',
    vid.url || ''
  ].join(' ').toLowerCase();

  // Only score if ALL subject words present
  if (!strictSubjectPresentPixabay(fields, subject)) {
    score -= 9999; // Hard reject
    return score;
  }

  // Strong full phrase match
  if (fields.includes(cleanedSubject) && cleanedSubject.length > 2) score += 50;

  // All words present
  const allWordsPresent = subjectWords.every(w => fields.includes(w));
  if (allWordsPresent && subjectWords.length > 1) score += 25;

  // Each keyword match
  subjectWords.forEach(word => {
    if (fields.includes(word)) score += 5;
  });

  // Aspect/size: prefer portrait/landscape, HD+
  if (vid.width > vid.height) score += 10; // Landscape
  if (vid.height / vid.width > 1.7 && vid.height > 1000) score += 12; // Portrait, tall
  if (vid.height >= 720) score += 5;
  score += Math.floor(vid.width / 120);

  // Penalize used/duplicate clips
  if (usedClips && usedClips.some(u => vid.url && (u.includes(vid.url) || vid.url.includes(u)))) {
    score -= 100;
  }

  // Penalize very short videos
  if (hit.duration && hit.duration < 4) score -= 6;

  // Slight bonus for more recent/popular videos (higher id)
  if (hit.id && Number(hit.id) > 1000000) score += 2;

  return score;
}

/**
 * Finds and downloads best Pixabay video for a given subject/scene,
 * scoring by resolution, aspect, deduping, and strict subject filtering.
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
    // Enforce 100 char limit for Pixabay
    const cappedQuery = query.length > 100 ? query.slice(0, 100) : query;
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${cappedQuery}&per_page=10`;
    console.log(`[10C][PIXABAY][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url);

    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      let scored = [];
      for (const hit of resp.data.hits) {
        const videoCandidates = Object.values(hit.videos || {});
        for (const vid of videoCandidates) {
          const score = scorePixabayMatch(hit, vid, subject, usedClips);
          scored.push({ hit, vid, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 7).forEach((s, i) =>
        console.log(`[10C][PIXABAY][${jobId}][CANDIDATE][${i + 1}] ${s.vid.url} | score=${s.score} | size=${s.vid.width}x${s.vid.height}`)
      );

      const best = scored[0];
      // Only accept if not a reject and score high enough
      if (best && best.score >= 18) {
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${uuidv4()}.mp4`);
        return await downloadPixabayVideoToLocal(best.vid.url, outPath, jobId);
      }
      console.warn(`[10C][PIXABAY][${jobId}] No strict Pixabay match found for "${subject}" (best score: ${best ? best.score : 'none'})`);
    } else {
      console.log(`[10C][PIXABAY][${jobId}] No Pixabay video results found for "${subject}"`);
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
