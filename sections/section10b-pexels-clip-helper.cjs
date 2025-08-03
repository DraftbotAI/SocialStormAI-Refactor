// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER
// Finds and downloads best-matching video from Pexels API
// MAX LOGGING EVERY STEP, Modular System Compatible
// Parallel-safe: unique file output per job/scene
// 2024-08: Upgraded scoring, logging, and multi-word matching
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

// --- Utility: Defensive keyword cleaning for Pexels queries ---
function cleanQuery(str) {
  if (!str) return '';
  return str.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
}

function getKeywords(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s\-]+/)
    .filter(w => w.length > 2);
}

// --- File validation ---
function isValidClip(filePath, jobId) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[10B][DL][${jobId}] File does not exist: ${filePath}`);
      return false;
    }
    const size = fs.statSync(filePath).size;
    if (size < 2048) {
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

// --- Scoring function: Smartest possible match (phrase, keywords, aspect, etc) ---
function scorePexelsMatch(video, file, subject, usedClips = []) {
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);

  // Main filename/description for scoring (title, tags, and user, if present)
  const fields = [
    (video?.user?.name || ''),
    (video?.url || ''),
    (file?.link || ''),
    (file?.file_type || ''),
    ...(video?.tags ? video.tags.map(t => t.title || t) : [])
  ].join(' ').toLowerCase();

  // Phrase match
  if (fields.includes(cleanedSubject)) score += 60;

  // All words present
  const allWordsPresent = subjectWords.every(w => fields.includes(w));
  if (allWordsPresent && subjectWords.length > 1) score += 30;

  // Each individual keyword present
  subjectWords.forEach(word => {
    if (fields.includes(word)) score += 5;
  });

  // Aspect ratio: prefer portrait (9:16), then 16:9
  if (file.width > file.height) score += 10; // Landscape slightly preferred for shorts (background blur)
  if (file.width / file.height > 1.4 && file.width / file.height < 2.0) score += 6; // 16:9-ish
  if (file.height / file.width > 1.7 && file.height / file.width < 2.1) score += 12; // 9:16 portrait perfect

  // Video quality/length
  score += file.height >= 720 ? 5 : 0;
  score += file.file_type === 'video/mp4' ? 2 : 0;
  score += Math.floor(file.width / 120);

  // Penalize used/duplicate clips
  if (usedClips && usedClips.some(u => u.includes(file.link) || file.link.includes(u))) {
    score -= 100;
  }

  // Penalize very short clips
  if (video.duration && video.duration < 4) score -= 8;

  // Slight bonus for popular Pexels video IDs (higher ID is newer/higher quality)
  if (video.id && Number(video.id) > 1000000) score += 2;

  return score;
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
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=10`;
    console.log(`[10B][PEXELS][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });

    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      let scored = [];
      for (const video of resp.data.videos) {
        const files = (video.video_files || []).filter(f => f.file_type === 'video/mp4');
        for (const file of files) {
          const score = scorePexelsMatch(video, file, subject, usedClips);
          scored.push({ video, file, score });
        }
      }
      // Sort high to low, log all
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 7).forEach((s, i) =>
        console.log(`[10B][PEXELS][${jobId}][CANDIDATE][${i + 1}] ${s.file.link} | score=${s.score} | duration=${s.video.duration}s | size=${s.file.width}x${s.file.height}`)
      );

      const best = scored[0];
      if (best && best.score >= 20) {
        const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-${uuidv4()}.mp4`);
        return await downloadPexelsVideoToLocal(best.file.link, outPath, jobId);
      }
      console.warn(`[10B][PEXELS][${jobId}] No strong Pexels match found for "${subject}" (best score: ${best ? best.score : 'none'})`);
    } else {
      console.log(`[10B][PEXELS][${jobId}] No Pexels video results found for "${subject}"`);
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

module.exports = { findPexelsClipForScene };
