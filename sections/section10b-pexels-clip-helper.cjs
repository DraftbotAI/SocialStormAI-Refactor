// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER (Video Search & Download)
// Exports: findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
// Bulletproof: always tries all options, never blocks on strict match
// Max logs at every step, accepts best available, NO silent fails
// 2024-08: Ready for universal scoring, anti-dupe, anti-generic
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// === Universal scorer import stub (ready to wire) ===
let scoreSceneCandidate = null;
try {
  scoreSceneCandidate = require('./section10g-scene-scoring-helper.cjs').scoreSceneCandidate;
  console.log('[10B][INIT] Universal scene scorer loaded.');
} catch (e) {
  // Not fatal, fallback to local scoring logic for now
  console.warn('[10B][INIT][WARN] Universal scene scorer NOT loaded, using local scoring.');
}

console.log('[10B][INIT] Pexels clip helper loaded.');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_API_KEY) {
  console.error('[10B][FATAL] Missing PEXELS_API_KEY in environment!');
}

// --- Normalization helpers ---
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
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function majorWords(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
}
function fuzzyMatch(text, subject) {
  const txt = normalize(text);
  const words = majorWords(subject);
  return words.length && words.every(word => txt.includes(word));
}
function partialMatch(text, subject) {
  const txt = normalize(text);
  const words = majorWords(subject);
  return words.some(word => txt.includes(word));
}
function strictSubjectPresent(text, subject) {
  const subjectWords = getKeywords(subject);
  if (!subjectWords.length) return false;
  return subjectWords.every(w => text.includes(w));
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

// --- Anti-dupe check ---
function isDupe(fileUrl, usedClips = []) {
  if (!fileUrl) return false;
  return usedClips.some(u =>
    (typeof u === 'string') &&
    (
      u === fileUrl ||
      u.endsWith(path.basename(fileUrl)) ||
      u.includes(fileUrl) ||
      fileUrl.includes(u)
    )
  );
}

// --- Scoring function: now accepts fuzzy, partial, and strict matches ---
// Will use universal scorer if present, else fallback to local
function scorePexelsMatch(video, file, subject, usedClips = [], scene = null) {
  if (typeof scoreSceneCandidate === 'function') {
    // Use the universal scoring system (10G)
    const candidate = {
      type: 'video',
      source: 'pexels',
      file: file.link,
      filename: path.basename(file.link),
      subject,
      video,
      pexelsFile: file,
      scene,
    };
    return scoreSceneCandidate(candidate, scene || { subject });
  }

  // --- Local fallback scoring (legacy logic) ---
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);

  // Main fields for matching/scoring
  const fields = [
    (video?.user?.name || ''),
    (video?.url || ''),
    (file?.link || ''),
    (file?.file_type || ''),
    ...(video?.tags ? video.tags.map(t => t.title || t) : []),
    (video?.description || ''),
    (video?.title || '')
  ].join(' ').toLowerCase();

  // STRONG: All words present
  if (strictSubjectPresent(fields, subject)) score += 40;
  // FUZZY: All major words in any order
  if (fuzzyMatch(fields, subject)) score += 25;
  // PARTIAL: Any major word present
  if (partialMatch(fields, subject)) score += 10;
  // PHRASE match bonus
  if (fields.includes(cleanedSubject) && cleanedSubject.length > 2) score += 12;

  // Each individual keyword present
  subjectWords.forEach(word => {
    if (fields.includes(word)) score += 3;
  });

  // Aspect ratio: prefer portrait (9:16), then 16:9
  if (file.height > file.width) score += 11;
  if (file.width / file.height > 1.4 && file.width / file.height < 2.0) score += 5;
  if (file.height / file.width > 1.7 && file.height / file.width < 2.1) score += 6;

  // Video quality/length
  score += file.height >= 720 ? 2 : 0;
  score += file.file_type === 'video/mp4' ? 2 : 0;
  score += Math.floor(file.width / 120);

  // Penalize used/duplicate clips (url, id, basename)
  if (isDupe(file.link, usedClips)) score -= 100;

  // Penalize very short clips
  if (video.duration && video.duration < 4) score -= 6;

  // Slight bonus for popular Pexels video IDs (higher ID = newer/higher quality)
  if (video.id && Number(video.id) > 1000000) score += 2;

  return score;
}

/**
 * Finds and downloads the best Pexels video for a given subject/scene,
 * using strict/fuzzy/partial keyword matching. Will always pick the best result available.
 * @param {string|object} subject - Main scene subject (string or scene object with .subject)
 * @param {string} workDir - Local job folder for saving video
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {Array<string>} usedClips - Paths/URLs already used
 * @returns {Promise<string|null>} Local .mp4 path, or null
 */
async function findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  // Accept scene object OR raw subject string (backward compatible)
  const scene = typeof subject === 'object' && subject.subject ? subject : { subject };
  console.log(`[10B][PEXELS][${jobId}] findPexelsClipForScene | subject="${scene.subject}" | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  if (!PEXELS_API_KEY) {
    console.error('[10B][PEXELS][ERR] No Pexels API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(cleanQuery(scene.subject));
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=15`;
    console.log(`[10B][PEXELS][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });

    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      let scored = [];
      for (const video of resp.data.videos) {
        const files = (video.video_files || []).filter(f => f.file_type === 'video/mp4');
        for (const file of files) {
          // Do NOT add to scored if dupe
          if (isDupe(file.link, usedClips)) {
            console.log(`[10B][PEXELS][${jobId}][DUPE] Skipping duplicate file: ${file.link}`);
            continue;
          }
          const score = scorePexelsMatch(video, file, scene.subject, usedClips, scene);
          scored.push({ video, file, score });
        }
      }
      // Sort high to low, log all
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 7).forEach((s, i) =>
        console.log(`[10B][PEXELS][${jobId}][CANDIDATE][${i + 1}] ${s.file.link} | score=${s.score} | duration=${s.video.duration}s | size=${s.file.width}x${s.file.height}`)
      );

      // === Block irrelevants if a strong match exists ===
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
        // If download fails, try next best (not implemented yet — possible TODO)
      } else {
        console.warn(`[10B][PEXELS][${jobId}] No Pexels videos matched subject, but candidates were returned.`);
      }
    } else {
      console.log(`[10B][PEXELS][${jobId}] No Pexels video results found for "${scene.subject}"`);
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
