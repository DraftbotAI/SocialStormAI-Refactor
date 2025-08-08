// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER (VIDEOS + PHOTOS)
// Finds and downloads best-matching video or photo from Pixabay API
// MAX LOGGING EVERY STEP, Modular System Compatible
// Bulletproof: unique files, dedupe, valid output, crash-proof
// Scoring with universal strict/fuzzy/partial, no skips
// 2025-08: Video-first, vertical-preferred, photo fallback,
//          local downloads for both (so 5D can assertFileExists),
//          strong anti-dupe across URL + local path, timeouts,
//          landmark-mode culling (no random animals/people for landmarks),
//          query variants + single retry, and robust logging.
// Exports:
//   - findPixabayClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
//   - findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips)
// Returns rich objects { filePath, title, description, tags, provider, isVideo }.
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const {
  scoreSceneCandidate,
  SYNONYMS,
  GENERIC_SUBJECTS,
  LANDMARK_KEYWORDS,
  ANIMAL_TERMS,
  PERSON_TERMS,
} = require('./section10g-scene-scoring-helper.cjs');

console.log('[10C][INIT] Pixabay helper (video-first, vertical-preferred, landmark-mode, max logs) loaded.');

// === ENV KEYS ===
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || '';
if (!PIXABAY_API_KEY) {
  console.error('[10C][FATAL] Missing PIXABAY_API_KEY in environment!');
}

// === CONSTANTS / PREFS ===
const PROVIDER = 'pixabay';

const DOWNLOAD_MIN_BYTES_VIDEO = 2048;
const DOWNLOAD_MIN_BYTES_PHOTO = 1024;

const AXIOS_TIMEOUT_MS = Number(process.env.MATCHER_PROVIDER_TIMEOUT_MS || 12000);
const USER_AGENT = 'SocialStormAI/10C (Pixabay Helper)';

// Prefer vertical if possible (Shorts/Reels/TikTok)
const VERTICAL_ASPECT_TARGET = 9 / 16;
const VERTICAL_TOLERANCE = 0.20; // ±20%
const PREFER_VERTICAL = String(process.env.PIXABAY_PREFER_VERTICAL || '1') !== '0';
const VERTICAL_BONUS_VIDEO = 8;
const VERTICAL_BONUS_PHOTO = 4;

// Floors aligned with 10B/5D
const HARD_FLOOR_VIDEO = Number(process.env.MATCHER_FLOOR_VIDEO || 70);
const HARD_FLOOR_IMAGE = Number(process.env.MATCHER_FLOOR_IMAGE || 75);

// How many results to consider
const PER_PAGE_VIDEOS = Math.min(Number(process.env.PIXABAY_PER_PAGE_VIDEOS || 30), 80);
const PER_PAGE_PHOTOS = Math.min(Number(process.env.PIXABAY_PER_PAGE_PHOTOS || 30), 80);

// Query variants (keep tame to avoid rate limits)
const VIDEO_QUERY_VARIANTS = Math.min(Number(process.env.PIXABAY_VIDEO_VARIANTS || 2), 5);
const PHOTO_QUERY_VARIANTS = Math.min(Number(process.env.PIXABAY_PHOTO_VARIANTS || 2), 5);

// Optional global cap to avoid runaway memory from huge result sets
const MAX_RESULTS_RETURN = Math.min(Number(process.env.MATCHER_MAX_RESULTS || 35), 100);

// Landmark strict mode: block animals/people unless guard/ceremony context is detected
const STRICT_LANDMARK_MODE = String(process.env.PIXABAY_STRICT_LANDMARK_MODE || 'true').toLowerCase() !== 'false';

// ===========================================================
// Small Utils
// ===========================================================
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function alnumLower(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function containsAny(list, s) {
  const L = String(s || '').toLowerCase();
  return (list || []).some(w => L.includes(String(w).toLowerCase()));
}

function isLandmarkSubject(subject) {
  return containsAny(LANDMARK_KEYWORDS, subject);
}

function normalizeKey(x) {
  return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function isLikelyPortrait(w, h) {
  if (!w || !h) return false;
  const ratio = w / h;
  return Math.abs(ratio - VERTICAL_ASPECT_TARGET) <= VERTICAL_TOLERANCE || ratio < 0.8;
}

function usedHas(usedClips = [], keyOrPath = '') {
  if (!keyOrPath) return false;
  const key = String(keyOrPath);
  const base = path.basename(key);
  if (usedClips instanceof Set) {
    return usedClips.has(key) || usedClips.has(base) || usedClips.has(normalizeKey(key));
  }
  return (usedClips || []).some(u =>
    u === key ||
    u === base ||
    String(key).endsWith(String(u)) ||
    normalizeKey(u) === normalizeKey(key)
  );
}

function usedAdd(usedClips = [], keyOrPath = '') {
  if (!keyOrPath) return;
  const key = String(keyOrPath);
  const base = path.basename(key);
  const norm = normalizeKey(key);
  if (usedClips instanceof Set) {
    usedClips.add(key); usedClips.add(base); usedClips.add(norm);
  } else if (Array.isArray(usedClips)) {
    if (!usedHas(usedClips, key)) usedClips.push(key);
    if (!usedHas(usedClips, base)) usedClips.push(base);
    if (!usedHas(usedClips, norm)) usedClips.push(norm);
  }
}

function isValidLocal(filePath, minBytes) {
  try {
    if (!filePath) return false;
    if (!fs.existsSync(filePath)) return false;
    const sz = fs.statSync(filePath).size;
    return sz >= (minBytes || 1);
  } catch {
    return false;
  }
}

async function streamDownload(url, outPath, jobId, minBytes) {
  try {
    ensureDir(path.dirname(outPath));
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: AXIOS_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT }
    });

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(outPath);
      response.data.pipe(ws);
      response.data.on('error', reject);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    if (!isValidLocal(outPath, minBytes)) {
      console.warn(`[10C][DL][${jobId}] Downloaded file invalid/broken: ${outPath}`);
      return null;
    }
    console.log(`[10C][DL][${jobId}] Saved: ${outPath}`);
    return outPath;
  } catch (err) {
    const st = err?.response?.status;
    if (st) {
      console.error(`[10C][DL][${jobId}][HTTP ${st}] ${url}`);
    } else {
      console.error(`[10C][DL][${jobId}][ERR]`, err?.message || err);
    }
    return null;
  }
}

function ensureMp4(outPath) {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === '.mp4') return outPath;
  return `${outPath}.mp4`;
}

function subjectString(subject) {
  if (typeof subject === 'string') return subject;
  if (Array.isArray(subject)) return String(subject[0] || '');
  if (subject && typeof subject === 'object') return String(subject.subject || subject.main || '');
  return '';
}

function makeQueryVariants(subject, maxVariants) {
  const q = String(subject || '').trim();
  if (!q) return [];

  const variants = new Set();
  variants.add(q);                 // base
  variants.add(q.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()); // cleaned

  // quoted exact (Pixabay ignores quotes but we keep for parity/logging)
  variants.add(`"${q}"`);

  // synonym expansion (light)
  const words = q.split(/\s+/).filter(Boolean);
  words.forEach(tok => {
    const syns = SYNONYMS[tok.toLowerCase()] || [];
    syns.slice(0, 2).forEach(s => {
      variants.add(s);
      const rest = words.filter(w => w.toLowerCase() !== tok.toLowerCase()).join(' ');
      if (rest) variants.add(`${s} ${rest}`);
    });
  });

  const out = Array.from(variants)
    .map(v => (v.length > 80 ? v.slice(0, 80) : v))
    .filter(v => !GENERIC_SUBJECTS.includes(alnumLower(v)));

  return out.slice(0, Math.max(1, maxVariants || 1));
}

// Landmark culling helpers
function landmarkCullFromText(str) {
  const text = String(str || '').toLowerCase();

  const hasAnimal = containsAny(ANIMAL_TERMS, text);
  const hasPerson = containsAny(PERSON_TERMS, text);

  // Allow ceremonial humans near landmarks
  const allowedHumanContext = /\b(guard|guards|soldier|soldiers|ceremony|changing of the guard)\b/.test(text);
  const looksLandmarky = containsAny(LANDMARK_KEYWORDS, text);

  if ((hasAnimal || hasPerson) && !(allowedHumanContext && looksLandmarky)) {
    return false;
  }
  return true;
}

function landmarkCullCandidate(candidate) {
  const text = [
    candidate.url,
    candidate.title,
    candidate.description,
    Array.isArray(candidate.tags) ? candidate.tags.join(' ') : '',
    candidate.source,
    candidate.provider
  ].filter(Boolean).join(' ');
  return landmarkCullFromText(text);
}

// ===========================================================
// Build candidates
// ===========================================================
function buildVideoCandidatesFromHit(hit, subject, usedClips, sceneText) {
  // Pixabay video hit example: hit.videos = { large:{url,width,height,size}, medium:{...}, small:{...}, tiny:{...} }
  const variants = Object.values(hit?.videos || {}).filter(Boolean);
  return variants
    .filter(v => v.url && !usedHas(usedClips, v.url))
    .map(v => {
      const isVertical = (v.height || 0) > (v.width || 0);
      const tags = (hit?.tags ? String(hit.tags).split(',').map(t => t.trim()) : []) || [];
      const base = {
        type: 'video',
        provider: PROVIDER,
        source: PROVIDER,
        url: v.url,
        filename: path.basename(v.url),
        width: v.width || null,
        height: v.height || null,
        duration: hit?.duration || null,
        title: `Pixabay video ${hit?.id || 'unknown'}`,
        description: `Pixabay variant (${Object.keys(hit?.videos || {}).find(k => hit.videos[k] === v) || 'n/a'})`,
        tags,
        subject,
        isVideo: true,
        sceneText
      };
      let score = 0;
      try {
        score = scoreSceneCandidate(base, sceneText || subject, usedClips, /*realMatchExists=*/true);
        if (PREFER_VERTICAL && isVertical) score += VERTICAL_BONUS_VIDEO;
      } catch {
        score = isVertical ? 55 : 45;
      }
      return { ...base, score, _isVertical: isVertical };
    });
}

function buildPhotoCandidate(hit, subject, usedClips, sceneText) {
  const url = hit?.largeImageURL || hit?.webformatURL || hit?.previewURL || null;
  if (!url || usedHas(usedClips, url)) return null;

  const tags = (hit?.tags ? String(hit.tags).split(',').map(t => t.trim()) : []) || [];

  const base = {
    type: 'photo',
    provider: PROVIDER,
    source: PROVIDER,
    url,
    filename: path.basename(url),
    width: hit?.imageWidth || null,
    height: hit?.imageHeight || null,
    title: `Pixabay photo ${hit?.id || 'unknown'}`,
    description: `Pixabay photo`,
    tags,
    subject,
    isVideo: false,
    sceneText
  };

  let score = 0;
  try {
    score = scoreSceneCandidate(base, sceneText || subject, usedClips, /*realMatchExists=*/false);
    if (PREFER_VERTICAL && base.height && base.width && base.height > base.width) {
      score += VERTICAL_BONUS_PHOTO;
    }
  } catch {
    score = 35;
  }

  return { ...base, score };
}

// ===========================================================
// API helpers
// ===========================================================
async function pixabayVideoSearch(query, perPage, jobId) {
  const q = encodeURIComponent(String(query || '').replace(/[^\w\s]/g, ' ').trim()).slice(0, 100);
  const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${q}&per_page=${perPage}&order=popular`;
  console.log(`[10C][API][VIDEO][${jobId}] GET ${url}`);
  const resp = await axios.get(url, {
    timeout: AXIOS_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT }
  });
  return Array.isArray(resp?.data?.hits) ? resp.data.hits : [];
}

async function pixabayPhotoSearch(query, perPage, jobId, portraitPreferred) {
  const q = encodeURIComponent(String(query || '').replace(/[^\w\s]/g, ' ').trim()).slice(0, 100);
  const orientation = portraitPreferred ? '&orientation=vertical' : '';
  const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${q}&image_type=photo&per_page=${perPage}&order=popular${orientation}`;
  console.log(`[10C][API][PHOTO][${jobId}] GET ${url}`);
  const resp = await axios.get(url, {
    timeout: AXIOS_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT }
  });
  return Array.isArray(resp?.data?.hits) ? resp.data.hits : [];
}

// Light retry wrapper for 429/5xx
async function withRetry(fn, label, jobId) {
  try {
    return await fn();
  } catch (err) {
    const st = err?.response?.status;
    console.error(`[10C][API][${label}][${jobId}][ERR]`, st || '', err?.message || err);
    if (st === 429 || (st >= 500 && st <= 599)) {
      console.log(`[10C][API][${label}][${jobId}] retrying after brief backoff...`);
      await new Promise(r => setTimeout(r, 600));
      try {
        return await fn();
      } catch (err2) {
        console.error(`[10C][API][${label}][${jobId}][ERR][retry]`, err2?.response?.status || '', err2?.message || err2);
        return [];
      }
    }
    return [];
  }
}

// ===========================================================
// MAIN VIDEO FINDER (VIDEO-FIRST)
// Returns { filePath, title, description, tags, provider:'pixabay', isVideo:true } or null
// ===========================================================
async function findPixabayClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  const q = subjectString(subject);
  console.log(`[10C][START][VIDEO][${jobId}] subject="${q}" scene=${sceneIdx}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][VIDEO][ERR] No Pixabay API key set!');
    return null;
  }
  if (!q || q.length < 2) {
    console.warn(`[10C][VIDEO][${jobId}] Empty/short subject; skipping.`);
    return null;
  }

  const variants = makeQueryVariants(q, VIDEO_QUERY_VARIANTS);
  console.log(`[10C][VIDEO][${jobId}] Query variants:`, variants);

  const landmarkMode = STRICT_LANDMARK_MODE && isLandmarkSubject(q);

  let allHits = [];
  for (const v of variants) {
    const rows = await withRetry(() => pixabayVideoSearch(v, PER_PAGE_VIDEOS, jobId), `VIDEO(${v})`, jobId);
    if (rows?.length) {
      rows.forEach(h => (h.__variant = v));
      allHits.push(...rows);
      if (allHits.length >= MAX_RESULTS_RETURN) break;
    }
  }

  if (!allHits.length) {
    console.warn(`[10C][VIDEO][${jobId}] No video results for "${q}"`);
    return null;
  }

  // Build & score variants
  let candidates = [];
  for (const hit of allHits) {
    const sceneText = q; // subject as scene focus
    const cs = buildVideoCandidatesFromHit(hit, q, usedClips, sceneText);
    for (const c of cs) {
      if (landmarkMode && !landmarkCullCandidate(c)) {
        console.log(`[10C][VIDEO][${jobId}][CULL][LANDMARK] drop ${c.url}`);
        continue;
      }
      candidates.push(c);
      if (candidates.length >= MAX_RESULTS_RETURN) break;
    }
    if (candidates.length >= MAX_RESULTS_RETURN) break;
  }

  if (!candidates.length) {
    console.warn(`[10C][VIDEO][${jobId}] No viable video variants after filtering/culling.`);
    return null;
  }

  // Sort: portrait first, then score, then resolution
  candidates.sort((a, b) => {
    const pa = a._isVertical ? 1 : 0;
    const pb = b._isVertical ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ds = b.score - a.score;
    if (ds !== 0) return ds;
    const areaA = (a.width || 0) * (a.height || 0);
    const areaB = (b.width || 0) * (b.height || 0);
    return areaB - areaA;
  });

  // Apply hard floor
  const viable = candidates.filter(c => c.score >= HARD_FLOOR_VIDEO);
  if (!viable.length) {
    console.warn(`[10C][VIDEO][${jobId}] All candidates fell below floor=${HARD_FLOOR_VIDEO}.`);
    return null;
  }

  viable.slice(0, 10).forEach((c, i) => {
    console.log(`[10C][VIDEO][${jobId}][CANDIDATE][${i + 1}] score=${c.score} ${c.width}x${c.height} vertical=${c._isVertical ? 'Y' : 'N'} url=${c.url}`);
  });

  const best = viable[0];

  // Download to local
  const unique = uuidv4();
  const rawOut = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${unique}`);
  const outPath = ensureMp4(rawOut);

  console.log(`[10C][VIDEO][${jobId}] Downloading → ${outPath}`);
  const local = await streamDownload(best.url, outPath, jobId, DOWNLOAD_MIN_BYTES_VIDEO);
  if (!local) return null;

  usedAdd(usedClips, best.url);
  usedAdd(usedClips, local);

  console.log(`[10C][VIDEO][${jobId}][SELECTED] ${local} | score=${best.score}`);

  return {
    filePath: local,
    title: best.title,
    description: best.description,
    tags: best.tags,
    provider: PROVIDER,
    isVideo: true,
  };
}

// ===========================================================
// PHOTO FALLBACK FINDER
// Returns { filePath, title, description, tags, provider:'pixabay', isVideo:false } or null
// ===========================================================
async function findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  const q = subjectString(subject);
  console.log(`[10C][START][PHOTO][${jobId}] subject="${q}" scene=${sceneIdx}`);

  if (!PIXABAY_API_KEY) {
    console.warn('[10C][PHOTO][ERR] No Pixabay API key set!');
    return null;
  }
  if (!q || q.length < 2) {
    console.warn(`[10C][PHOTO][${jobId}] Empty/short subject; skipping.`);
    return null;
  }

  const variants = makeQueryVariants(q, PHOTO_QUERY_VARIANTS);
  console.log(`[10C][PHOTO][${jobId}] Query variants:`, variants);

  const landmarkMode = STRICT_LANDMARK_MODE && isLandmarkSubject(q);

  let allHits = [];
  for (const v of variants) {
    const rows = await withRetry(() => pixabayPhotoSearch(v, PER_PAGE_PHOTOS, jobId, PREFER_VERTICAL), `PHOTO(${v})`, jobId);
    if (rows?.length) {
      rows.forEach(h => (h.__variant = v));
      allHits.push(...rows);
      if (allHits.length >= MAX_RESULTS_RETURN) break;
    }
  }

  if (!allHits.length) {
    console.warn(`[10C][PHOTO][${jobId}] No photo results for "${q}"`);
    return null;
  }

  let candidates = [];
  for (const hit of allHits) {
    const c = buildPhotoCandidate(hit, q, usedClips, q);
    if (!c) continue;
    if (landmarkMode && !landmarkCullCandidate(c)) {
      console.log(`[10C][PHOTO][${jobId}][CULL][LANDMARK] drop ${c.url}`);
      continue;
    }
    candidates.push(c);
    if (candidates.length >= MAX_RESULTS_RETURN) break;
  }

  if (!candidates.length) {
    console.warn(`[10C][PHOTO][${jobId}] No viable photo candidates after filtering/culling.`);
    return null;
  }

  // Sort by score desc; tie-breaker: portrait and larger area
  candidates.sort((a, b) => {
    const ds = b.score - a.score;
    if (ds !== 0) return ds;
    const pa = (a.height || 0) > (a.width || 0) ? 1 : 0;
    const pb = (b.height || 0) > (b.width || 0) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const areaA = (a.width || 0) * (a.height || 0);
    const areaB = (b.width || 0) * (b.height || 0);
    return areaB - areaA;
  });

  // Hard floor for images
  const viable = candidates.filter(c => c.score >= HARD_FLOOR_IMAGE);
  if (!viable.length) {
    console.warn(`[10C][PHOTO][${jobId}] All candidates fell below floor=${HARD_FLOOR_IMAGE}.`);
    return null;
  }

  viable.slice(0, 10).forEach((c, i) => {
    console.log(`[10C][PHOTO][${jobId}][CANDIDATE][${i + 1}] score=${c.score} ${c.width || '?'}x${c.height || '?'} url=${c.url}`);
  });

  const best = viable[0];

  // Download to local JPG
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-photo-${uuidv4()}.jpg`);
  console.log(`[10C][PHOTO][${jobId}] Downloading → ${outPath}`);
  const local = await streamDownload(best.url, outPath, jobId, DOWNLOAD_MIN_BYTES_PHOTO);
  if (!local) return null;

  usedAdd(usedClips, best.url);
  usedAdd(usedClips, local);

  console.log(`[10C][PHOTO][${jobId}][SELECTED] ${local} | score=${best.score}`);

  return {
    filePath: local,
    title: best.title,
    description: best.description,
    tags: best.tags,
    provider: PROVIDER,
    isVideo: false,
  };
}

module.exports = {
  findPixabayClipForScene,
  findPixabayPhotoForScene
};
