// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER (VIDEOS + PHOTOS)
// Finds and downloads best-matching video or photo from Pixabay API
// MAX LOGGING EVERY STEP, Modular System Compatible
// Bulletproof: unique files, dedupe, valid output, crash-proof
// Scoring with universal strict/fuzzy/partial, no skips
// 2025-08: Video-first, vertical-preferred, photo fallback,
//          local downloads for both (so 5D can assertFileExists),
//          strong anti-dupe across URL + local path, timeouts,
//          and robust logging.
// Exports:
//   - findPixabayClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
//   - findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips)
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');

console.log('[10C][INIT] Pixabay clip helper loaded (video-first, vertical preferred, max logs).');

// === ENV KEYS ===
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || '';
if (!PIXABAY_API_KEY) {
  console.error('[10C][FATAL] Missing PIXABAY_API_KEY in environment!');
}

// === CONSTANTS / PREFS ===
const DOWNLOAD_MIN_BYTES = 2048;
const AXIOS_TIMEOUT_MS = 20000;
const USER_AGENT = 'SocialStormAI/10C (Pixabay Helper)';

// Prefer vertical if possible (Shorts/Reels/TikTok)
const PREFER_VERTICAL = (process.env.PIXABAY_PREFER_VERTICAL || '1') === '1';
// Score bump for vertical-ish clips
const VERTICAL_BONUS = 8;

// === FILE VALIDATION ===
function isValidLocal(filePath) {
  try {
    if (!filePath) return false;
    if (!fs.existsSync(filePath)) return false;
    const sz = fs.statSync(filePath).size;
    return sz >= DOWNLOAD_MIN_BYTES;
  } catch {
    return false;
  }
}

// === ANTI-DUPE ===
function looksUsedPixabay(needle, usedClips = []) {
  if (!needle) return false;
  const base = path.basename(String(needle));
  return usedClips.some(u => {
    if (!u) return false;
    const ub = path.basename(String(u));
    return u === needle || ub === base || String(needle).endsWith(String(u)) || String(u).endsWith(String(needle));
  });
}

function markUsed(usedClips, ...items) {
  items.filter(Boolean).forEach(i => {
    if (!looksUsedPixabay(i, usedClips)) usedClips.push(i);
  });
}

// === DOWNLOAD UTILITIES ===
async function streamDownload(url, outPath, jobId, headers = {}) {
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: AXIOS_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT, ...headers }
    });

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(outPath);
      response.data.pipe(ws);
      response.data.on('error', reject);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    if (!isValidLocal(outPath)) {
      console.warn(`[10C][DL][${jobId}] Downloaded file invalid/broken: ${outPath}`);
      return null;
    }
    console.log(`[10C][DL][${jobId}] Saved: ${outPath}`);
    return outPath;
  } catch (err) {
    if (err?.response?.status) {
      console.error(`[10C][DL][${jobId}][HTTP ${err.response.status}] ${url}`);
    } else {
      console.error(`[10C][DL][${jobId}][ERR]`, err?.message || err);
    }
    return null;
  }
}

// Force .mp4 extension for videos (Pixabay links may not clearly end with .mp4)
function ensureMp4(outPath) {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === '.mp4') return outPath;
  return `${outPath}.mp4`;
}

// === SUBJECT NORMALIZATION ===
function subjectString(subject) {
  if (typeof subject === 'string') return subject;
  if (Array.isArray(subject)) return String(subject[0] || '');
  if (subject && typeof subject === 'object') return String(subject.subject || subject.main || '');
  return '';
}

// === PIXABAY SEARCH HELPERS ===
function buildVideoCandidatesFromHit(hit, subject, usedClips, scene) {
  // hit.videos has keys like large, medium, small, tiny; each has url,width,height,size
  const variants = Object.values(hit?.videos || {}).filter(Boolean);
  return variants
    .filter(v => v.url && !looksUsedPixabay(v.url, usedClips))
    .map(v => {
      const isVertical = (v.height || 0) > (v.width || 0);
      const base = {
        type: 'video',
        source: 'pixabay',
        file: v.url,
        filename: path.basename(v.url),
        subject,
        pixabayHit: hit,
        pixabayVid: v,
        scene,
        isVideo: true,
        width: v.width || null,
        height: v.height || null,
        duration: hit?.duration || null, // sometimes present for video API
      };
      let score = 0;
      try {
        score = scoreSceneCandidate(base, scene || subject, usedClips, /*realVideoExists=*/true);
        if (isVertical && PREFER_VERTICAL) score += VERTICAL_BONUS;
      } catch (e) {
        // If scoring helper fails for some reason, keep a sane baseline
        score = (isVertical ? 55 : 45);
      }
      return { ...base, score, _isVertical: isVertical };
    });
}

function buildPhotoCandidate(hit, subject, usedClips) {
  const url =
    hit?.largeImageURL ||
    hit?.webformatURL ||
    hit?.previewURL ||
    null;

  if (!url || looksUsedPixabay(url, usedClips)) return null;

  const base = {
    type: 'photo',
    source: 'pixabay',
    file: url,
    filename: path.basename(url),
    subject,
    hit,
    isVideo: false,
    width: hit?.imageWidth || null,
    height: hit?.imageHeight || null
  };

  let score = 0;
  try {
    score = scoreSceneCandidate(base, subject, usedClips, /*realVideoExists=*/false);
    // Very rough portrait preference for photos (if metadata exists)
    if (PREFER_VERTICAL && base.height && base.width && base.height > base.width) {
      score += Math.floor(VERTICAL_BONUS / 2);
    }
  } catch {
    score = 35; // fallback minimal score
  }

  return { ...base, score };
}

// ===========================================================
// MAIN VIDEO FINDER
// ===========================================================
async function findPixabayClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  const q = subjectString(subject);
  console.log(`[10C][PIXABAY][${jobId}] findPixabayClipForScene | subject="${q}" | sceneIdx=${sceneIdx}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No Pixabay API key set!');
    return null;
  }
  if (!q || q.length < 2) {
    console.warn(`[10C][PIXABAY][${jobId}] Empty/short subject; skipping.`);
    return null;
  }

  try {
    const query = encodeURIComponent(q.replace(/[^\w\s]/g, ' ').trim()).slice(0, 100);
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=20&order=popular`;
    console.log(`[10C][PIXABAY][${jobId}] GET ${url}`);

    const resp = await axios.get(url, {
      timeout: AXIOS_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT }
    });

    const hits = resp?.data?.hits || [];
    if (!hits.length) {
      console.log(`[10C][PIXABAY][${jobId}] No video results for "${q}"`);
      return null;
    }

    // Build + score all variants from all hits
    let all = [];
    for (const hit of hits) {
      const cs = buildVideoCandidatesFromHit(hit, q, usedClips, subject);
      all.push(...cs);
    }

    if (!all.length) {
      console.log(`[10C][PIXABAY][${jobId}] No viable video variants after filtering/dupe check.`);
      return null;
    }

    // Sort by score desc; tie-breaker: vertical then larger area
    all.sort((a, b) => {
      const ds = b.score - a.score;
      if (ds !== 0) return ds;
      if (PREFER_VERTICAL && (b._isVertical - a._isVertical) !== 0) return (b._isVertical ? 1 : 0) - (a._isVertical ? 1 : 0);
      const areaA = (a.width || 0) * (a.height || 0);
      const areaB = (b.width || 0) * (b.height || 0);
      return areaB - areaA;
    });

    // Log top candidates
    all.slice(0, 8).forEach((c, i) => {
      console.log(`[10C][PIXABAY][${jobId}][CANDIDATE][${i + 1}] ${c.file} | score=${c.score} | ${c.width}x${c.height} | vertical=${c._isVertical ? 'Y' : 'N'}`);
    });

    // Pick the first candidate above a reasonable threshold, else best available
    const best = all.find(c => c.score >= 45) || all[0];
    if (!best) {
      console.warn(`[10C][PIXABAY][${jobId}] No candidate selected after scoring.`);
      return null;
    }

    if (looksUsedPixabay(best.file, usedClips)) {
      console.warn(`[10C][PIXABAY][${jobId}] Top candidate already used, seeking alternative...`);
      const alt = all.find(c => !looksUsedPixabay(c.file, usedClips));
      if (!alt) {
        console.warn(`[10C][PIXABAY][${jobId}] No alternative candidate available post-dedupe.`);
        return null;
      }
      return await downloadPixabayVideo(alt, workDir, sceneIdx, jobId, usedClips);
    }

    return await downloadPixabayVideo(best, workDir, sceneIdx, jobId, usedClips);
  } catch (err) {
    if (err?.response?.data) {
      console.error('[10C][PIXABAY][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10C][PIXABAY][ERR]', err?.message || err);
    }
    return null;
  }
}

async function downloadPixabayVideo(candidate, workDir, sceneIdx, jobId, usedClips) {
  const unique = uuidv4();
  const rawOut = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${unique}`);
  const outPath = ensureMp4(rawOut);

  console.log(`[10C][DL][${jobId}] Downloading video (${candidate.width}x${candidate.height}, score=${candidate.score}): ${candidate.file}`);
  const local = await streamDownload(candidate.file, outPath, jobId);
  if (!local) return null;

  // Mark both remote URL and local path as used to prevent re-use across modules
  markUsed(usedClips, candidate.file, local);
  console.log(`[10C][PIXABAY][${jobId}][SELECTED] ${local} | score=${candidate.score}`);
  return local;
}

// ===========================================================
// PHOTO FALLBACK FINDER (downloads local JPG)
// ===========================================================
async function findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  const q = subjectString(subject);
  console.log(`[10C][PIXABAY-PHOTO][${jobId}] findPixabayPhotoForScene | subject="${q}" | sceneIdx=${sceneIdx}`);

  if (!PIXABAY_API_KEY) {
    console.warn('[10C][PIXABAY-PHOTO][ERR] No Pixabay API key set!');
    return null;
  }
  if (!q || q.length < 2) {
    console.warn(`[10C][PIXABAY-PHOTO][${jobId}] Empty/short subject; skipping.`);
    return null;
  }

  try {
    const query = encodeURIComponent(q.replace(/[^\w\s]/g, ' ').trim()).slice(0, 100);
    // Prefer vertical orientation for photos if possible
    const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query}&image_type=photo&per_page=30&order=popular${PREFER_VERTICAL ? '&orientation=vertical' : ''}`;
    console.log(`[10C][PIXABAY-PHOTO][${jobId}] GET ${url}`);

    const resp = await axios.get(url, {
      timeout: AXIOS_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT }
    });

    const hits = resp?.data?.hits || [];
    if (!hits.length) {
      console.log(`[10C][PIXABAY-PHOTO][${jobId}] No photo results for "${q}"`);
      return null;
    }

    const candidates = [];
    for (const hit of hits) {
      const cand = buildPhotoCandidate(hit, q, usedClips);
      if (cand) candidates.push(cand);
    }

    if (!candidates.length) {
      console.log(`[10C][PIXABAY-PHOTO][${jobId}] No viable photo candidates after filtering/dupe check.`);
      return null;
    }

    // Sort by score desc; tie-breaker: larger portrait-ish first
    candidates.sort((a, b) => {
      const ds = b.score - a.score;
      if (ds !== 0) return ds;
      const areaA = (a.width || 0) * (a.height || 0);
      const areaB = (b.width || 0) * (b.height || 0);
      return areaB - areaA;
    });

    candidates.slice(0, 8).forEach((c, i) => {
      console.log(`[10C][PIXABAY-PHOTO][${jobId}][CANDIDATE][${i + 1}] ${c.file} | score=${c.score} | ${c.width || '?'}x${c.height || '?'}`);
    });

    const best = candidates.find(c => c.score >= 38) || candidates[0];
    if (!best) {
      console.warn(`[10C][PIXABAY-PHOTO][${jobId}] No candidate selected after scoring.`);
      return null;
    }

    if (looksUsedPixabay(best.file, usedClips)) {
      console.warn(`[10C][PIXABAY-PHOTO][${jobId}] Top photo already used; trying alternative...`);
      const alt = candidates.find(c => !looksUsedPixabay(c.file, usedClips));
      if (!alt) {
        console.warn(`[10C][PIXABAY-PHOTO][${jobId}] No alternative photo available post-dedupe.`);
        return null;
      }
      return await downloadPixabayPhoto(alt, workDir, sceneIdx, jobId, usedClips);
    }

    return await downloadPixabayPhoto(best, workDir, sceneIdx, jobId, usedClips);
  } catch (err) {
    if (err?.response?.data) {
      console.error('[10C][PIXABAY-PHOTO][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10C][PIXABAY-PHOTO][ERR]', err?.message || err);
    }
    return null;
  }
}

async function downloadPixabayPhoto(candidate, workDir, sceneIdx, jobId, usedClips) {
  const unique = uuidv4();
  // Keep extension .jpg (Pixabay photo URLs are JPEGs)
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-photo-${unique}.jpg`);

  console.log(`[10C][DL][${jobId}] Downloading photo (score=${candidate.score}): ${candidate.file}`);
  const local = await streamDownload(candidate.file, outPath, jobId);
  if (!local) return null;

  markUsed(usedClips, candidate.file, local);
  console.log(`[10C][PIXABAY-PHOTO][${jobId}][SELECTED] ${local} | score=${candidate.score}`);
  return local;
}

module.exports = {
  findPixabayClipForScene,
  findPixabayPhotoForScene
};
