// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER (Video & Photo Search & Download)
// Exports:
//   - findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
//   - findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips, bestVideoScore?)
// Video-first: photos are used ONLY if they beat the best video by margin.
// Max logs, landmark-mode filters, anti-dupe, vertical-preferred, strict sizing.
// Ready for universal scoring (10G) + strict provider timeouts + single retry.
// Returns rich objects { filePath, title, description, tags, provider, isVideo, score }.
// No open-ended loops. Hard caps everywhere.
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const {
  scoreSceneCandidate,
  SYNONYMS,
  GENERIC_SUBJECTS,
  LANDMARK_KEYWORDS,
  ANIMAL_TERMS,
  PERSON_TERMS,
} = require('./section10g-scene-scoring-helper.cjs');

// ==== ENV / API ====
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';
if (!PEXELS_API_KEY) {
  console.error('[10B][FATAL] Missing PEXELS_API_KEY in env!');
}

console.log('[10B][INIT] Pexels helper (video-first, vertical-preferred, anti-dupe, landmark-mode) loaded.');

const PEXELS_VIDEO_URL = 'https://api.pexels.com/videos/search';
PEXELS_PHOTO_URL = 'https://api.pexels.com/v1/search';

// ==== CONSTANTS / TUNABLES ====
const MIN_BYTES_VIDEO = 2048;
const MIN_BYTES_PHOTO = 1024;

const MAX_PER_PAGE = Math.min(Number(process.env.PEXELS_PER_PAGE || 40), 80); // safety cap
const PAGES = Math.min(Number(process.env.PEXELS_PAGES || 2), 5);

const VERTICAL_ASPECT_TARGET = 9 / 16;
const VERTICAL_TOLERANCE = 0.20; // 20% wiggle (portrait-ish)

// Strict floors & knobs (kept in sync with 5D)
const HARD_FLOOR_VIDEO = Number(process.env.MATCHER_FLOOR_VIDEO || 70);
const HARD_FLOOR_IMAGE = Number(process.env.MATCHER_FLOOR_IMAGE || 75);
const PROVIDER_TIMEOUT_MS = Number(process.env.MATCHER_PROVIDER_TIMEOUT_MS || 12000);
const MAX_RESULTS_RETURN = Math.min(Number(process.env.MATCHER_MAX_RESULTS || 35), 100);

const PHOTO_BEATS_VIDEO_MARGIN = Number(process.env.PHOTO_BEATS_VIDEO_MARGIN || 5);
const STRICT_PHOTO_THRESHOLD = Number(process.env.STRICT_PHOTO_THRESHOLD || 90);

// Landmark mode toggle (block animals/people unless guard/ceremony context)
const STRICT_LANDMARK_MODE = String(process.env.PEXELS_STRICT_LANDMARK_MODE || 'true').toLowerCase() !== 'false';

// ==== SMALL UTILS ====
function ensureDir(dir) {
  try {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // no-op; subsequent writes will error and be logged
  }
}

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function alnumLower(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function containsAny(list, s) {
  const L = String(s || '').toLowerCase();
  return Array.isArray(list) && list.some(w => L.includes(String(w || '').toLowerCase()));
}

function isLandmarkSubject(subject) {
  return containsAny(LANDMARK_KEYWORDS, subject);
}

function makeQueryVariants(subject) {
  const q = String(subject || '').trim();
  if (!q) return [];

  // Proper noun bias + quoted exact search first
  const variants = new Set();
  variants.add(`"${q}"`);   // quoted exact
  variants.add(q);          // plain

  // Split & conjunction combos
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    variants.add(words.join(' '));
    variants.add(words.join(', '));
  }

  // Synonym expansion (10G)
  const tokens = words.map(w => w.toLowerCase());
  tokens.forEach(tok => {
    const syns = SYNONYMS[tok] || [];
    syns.slice(0, 3).forEach(s => {
      variants.add(`"${s}"`);
      variants.add(`${s}`);
      const rest = words.filter(w => w.toLowerCase() !== tok).join(' ');
      if (rest) variants.add(`${s} ${rest}`);
    });
  });

  // Remove pure generics
  const out = Array.from(variants).filter(v => !GENERIC_SUBJECTS.includes(alnumLower(v)));
  // Truncate overly long queries
  return out.map(v => (v.length > 80 ? v.slice(0, 80) : v));
}

function isLikelyPortrait(w, h) {
  if (!w || !h) return false;
  const ratio = w / h; // < 1 => portrait
  return Math.abs(ratio - VERTICAL_ASPECT_TARGET) <= VERTICAL_TOLERANCE || ratio < 0.8;
}

function usedHas(usedClips = [], keyOrPath = '') {
  if (!keyOrPath) return false;
  const key = String(keyOrPath);
  const base = path.basename(key);
  if (usedClips instanceof Set) {
    return usedClips.has(key) || usedClips.has(base) || usedClips.has(normalize(key));
  }
  return (usedClips || []).some(u => {
    const v = String(u);
    return v === key || v === base || key.endsWith(v) || normalize(v) === normalize(key);
  });
}

function usedAdd(usedClips = [], keyOrPath = '') {
  if (!keyOrPath) return;
  const key = String(keyOrPath);
  const base = path.basename(key);
  if (usedClips instanceof Set) {
    usedClips.add(key);
    usedClips.add(base);
    usedClips.add(normalize(key));
  } else if (Array.isArray(usedClips)) {
    if (!usedHas(usedClips, key)) usedClips.push(key);
    if (!usedHas(usedClips, base)) usedClips.push(base);
    const norm = normalize(key);
    if (!usedHas(usedClips, norm)) usedClips.push(norm);
  }
}

function fileOk(p, minBytes) {
  try {
    return fs.existsSync(p) && fs.statSync(p).size >= minBytes;
  } catch {
    return false;
  }
}

async function downloadFile(url, outPath, jobId, addAuthHeader = false) {
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      headers: addAuthHeader ? { Authorization: PEXELS_API_KEY } : undefined,
      timeout: PROVIDER_TIMEOUT_MS,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: s => s >= 200 && s < 300,
    });

    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(outPath);
      response.data.pipe(fileStream);
      response.data.on('error', (err) => {
        console.error(`[10B][${jobId}][DOWNLOAD][ERR] Stream error:`, err);
        reject(err);
      });
      fileStream.on('error', (err) => {
        console.error(`[10B][${jobId}][DOWNLOAD][ERR] File write error:`, err);
        reject(err);
      });
      fileStream.on('finish', resolve);
    });

    return outPath;
  } catch (err) {
    console.error(`[10B][${jobId}][DOWNLOAD][ERR] ${url}`, err?.response?.status, err?.message);
    return null;
  }
}

function pickBestVideoFile(videoFiles = []) {
  if (!Array.isArray(videoFiles) || !videoFiles.length) return null;

  // Prefer portrait & highest height; else largest pixels
  const portrait = videoFiles
    .filter(v => v && v.width && v.height && isLikelyPortrait(v.width, v.height))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (portrait.length) return portrait[0];

  return videoFiles
    .filter(v => v && v.width && v.height)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
}

// Hard negative filters in landmark mode
function landmarkCullFromText(str) {
  const text = String(str || '').toLowerCase();

  const hasAnimal = containsAny(ANIMAL_TERMS, text);
  const hasPerson = containsAny(PERSON_TERMS, text);

  // Allow ceremonial humans at famous landmarks
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

// ==== PAGED SEARCH HELPERS (with single retry) ====
async function pexelsSearchPaged(url, paramsBase, label, jobId) {
  let out = [];
  for (let page = 1; page <= PAGES; page++) {
    try {
      const params = { ...paramsBase, page, per_page: MAX_PER_PAGE };
      const res = await axios.get(url, {
        params,
        headers: { Authorization: PEXELS_API_KEY },
        timeout: PROVIDER_TIMEOUT_MS,
        validateStatus: s => s >= 200 && s < 300,
      });
      const items = (res.data && (label === 'video' ? res.data.videos : res.data.photos)) || [];
      console.log(`[10B][${label.toUpperCase()}][${jobId}] page=${page} got=${items.length}`);
      out.push(...items);
      if (!items.length) break; // stop if empty page
    } catch (err) {
      const status = err?.response?.status;
      console.error(`[10B][${label.toUpperCase()}][${jobId}][ERR] page=${page}`, status, err?.message);
      // Lightweight single retry on 429/5xx
      if (status === 429 || (status >= 500 && status <= 599)) {
        try {
          console.log(`[10B][${label.toUpperCase()}][${jobId}] retrying page=${page} after backoff...`);
          await new Promise(r => setTimeout(r, 600));
          const params = { ...paramsBase, page, per_page: MAX_PER_PAGE };
          const res2 = await axios.get(url, {
            params,
            headers: { Authorization: PEXELS_API_KEY },
            timeout: PROVIDER_TIMEOUT_MS,
            validateStatus: s => s >= 200 && s < 300,
          });
          const items2 = (res2.data && (label === 'video' ? res2.data.videos : res2.data.photos)) || [];
          console.log(`[10B][${label.toUpperCase()}][${jobId}] (retry) page=${page} got=${items2.length}`);
          out.push(...items2);
          if (!items2.length) break;
        } catch (err2) {
          console.error(`[10B][${label.toUpperCase()}][${jobId}][ERR][retry] page=${page}`, err2?.response?.status, err2?.message);
          break;
        }
      } else {
        break; // avoid any loop
      }
    }
    if (out.length >= MAX_RESULTS_RETURN) break; // global cap
  }
  return out;
}

// ==== SCORE WRAPPERS ====
function scoreVideoCandidate(c, subject, usedClips) {
  return scoreSceneCandidate(c, subject, usedClips, /*realMatchExists=*/true);
}

function scorePhotoCandidate(c, subject, usedClips) {
  return scoreSceneCandidate(c, subject, usedClips, /*realMatchExists=*/false);
}

// ===========================================================
// INTERNAL: collect top candidates across multiple query variants
// ===========================================================
async function collectPexelsVideos(subject, jobId) {
  const variants = makeQueryVariants(subject);
  console.log(`[10B][VIDEO][${jobId}] Query variants:`, variants);

  let all = [];
  for (const v of variants) {
    const rows = await pexelsSearchPaged(PEXELS_VIDEO_URL, { query: v, orientation: 'portrait' }, 'video', jobId);
    if (rows?.length) {
      rows.forEach(r => (r.__variant = v));
      all.push(...rows);
    }
    if (all.length >= MAX_RESULTS_RETURN) break;
  }
  // de-dupe by id
  const map = new Map();
  for (const vid of all) map.set(String(vid.id), vid);
  return Array.from(map.values());
}

async function collectPexelsPhotos(subject, jobId) {
  const variants = makeQueryVariants(subject);
  console.log(`[10B][PHOTO][${jobId}] Query variants:`, variants);

  let all = [];
  for (const v of variants) {
    const rows = await pexelsSearchPaged(PEXELS_PHOTO_URL, { query: v, orientation: 'portrait' }, 'photo', jobId);
    if (rows?.length) {
      rows.forEach(r => (r.__variant = v));
      all.push(...rows);
    }
    if (all.length >= MAX_RESULTS_RETURN) break;
  }
  // de-dupe by id
  const map = new Map();
  for (const p of all) map.set(String(p.id), p);
  return Array.from(map.values());
}

// ===========================================================
// MAIN VIDEO FINDER (VIDEO-FIRST)
// Returns { filePath, title, description, tags, provider:'pexels', isVideo:true, score } or null
// ===========================================================
async function findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  if (!PEXELS_API_KEY) {
    console.error('[10B][FATAL] No PEXELS_API_KEY!');
    return null;
  }
  if (!workDir) {
    console.error('[10B][VIDEO][FATAL] workDir is required.');
    return null;
  }

  const q = String(subject || '').trim();
  if (!q) {
    console.error(`[10B][VIDEO][${jobId}] Empty subject.`);
    return null;
  }

  console.log(`[10B][VIDEO][${jobId}] Searching Pexels videos for: "${q}" (pages=${PAGES}, per_page=${MAX_PER_PAGE})`);

  // 1) Fetch across variants
  const videos = await collectPexelsVideos(q, jobId);
  if (!videos.length) {
    console.warn(`[10B][VIDEO][${jobId}] No videos found for "${q}"`);
    return null;
  }

  const landmarkMode = STRICT_LANDMARK_MODE && isLandmarkSubject(q);

  // 2) Build candidates and score
  const candidates = [];
  for (const video of videos) {
    const bestFile = pickBestVideoFile(video.video_files || []);
    if (!bestFile || !bestFile.link) continue;

    const url = bestFile.link;
    const w = bestFile.width || video.width;
    const h = bestFile.height || video.height;
    const dur = video.duration;

    if (usedHas(usedClips, url) || usedHas(usedClips, String(video.id))) continue;

    const titleLike = video.url || `pexels-${video.id}`;
    const tags = Array.isArray(video.tags) ? video.tags : [];

    const item = {
      pexelsId: video.id,
      url,
      width: w,
      height: h,
      duration: dur,
      photographer: video.user && video.user.name,
      title: titleLike,
      description: `Pexels video ${video.id} (${video.__variant || 'base'})`,
      tags,
      subject: q,
      isVideo: true,
      provider: 'pexels',
      path: null,
      filename: `pexels_${video.id}.mp4`,
      source: 'pexels'
    };

    if (landmarkMode && !landmarkCullCandidate(item)) {
      console.log(`[10B][VIDEO][${jobId}][CULL][LANDMARK] drop id=${video.id} due to animal/person noise`);
      continue;
    }

    item.score = scoreVideoCandidate(item, q, usedClips);
    candidates.push(item);
  }

  if (!candidates.length) {
    console.warn(`[10B][VIDEO][${jobId}] No usable video candidates after filtering.`);
    return null;
  }

  // Prefer portrait, then score
  candidates.sort((a, b) => {
    const pa = isLikelyPortrait(a.width, a.height) ? 1 : 0;
    const pb = isLikelyPortrait(b.width, b.height) ? 1 : 0;
    if (pa !== pb) return pb - pa;        // portrait-first
    return b.score - a.score;             // then score
  });

  // Apply hard floor
  const viable = candidates.filter(c => c.score >= HARD_FLOOR_VIDEO);
  if (!viable.length) {
    console.warn(`[10B][VIDEO][${jobId}] All candidates fell below floor=${HARD_FLOOR_VIDEO}.`);
    return null;
  }

  // Log top 10
  viable.slice(0, 10).forEach((c, i) => {
    console.log(
      `[10B][VIDEO][${jobId}][CANDIDATE][${i + 1}] id=${c.pexelsId} ` +
      `score=${c.score} w=${c.width} h=${c.height} dur=${c.duration}s portrait=${isLikelyPortrait(c.width, c.height)}`
    );
  });

  const best = viable[0];
  const filename = best.filename || `pexels_${best.pexelsId}.mp4`;
  ensureDir(workDir);
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-${filename}`);

  // 3) Download (don’t re-download if valid)
  if (!fileOk(outPath, MIN_BYTES_VIDEO)) {
    console.log(`[10B][VIDEO][${jobId}] Downloading Pexels video → ${outPath}`);
    const dl = await downloadFile(best.url, outPath, jobId /* CDN; no auth for file URL */);
    if (!dl || !fileOk(outPath, MIN_BYTES_VIDEO)) {
      console.warn(`[10B][VIDEO][${jobId}] Download failed/invalid for ${best.url}`);
      return null;
    }
  } else {
    console.log(`[10B][VIDEO][${jobId}] Video already present: ${outPath}`);
  }

  best.path = outPath;

  // Track to avoid reuse across scenes
  usedAdd(usedClips, outPath);
  usedAdd(usedClips, best.url);
  usedAdd(usedClips, String(best.pexelsId));

  console.log(`[10B][VIDEO][${jobId}] Selected video id=${best.pexelsId} score=${best.score} path=${outPath}`);
  return {
    filePath: outPath,
    title: best.title,
    description: best.description,
    tags: best.tags,
    provider: 'pexels',
    isVideo: true,
    score: best.score,
  };
}

// ===========================================================
// PHOTO FINDER (ONLY IF STRICTLY BETTER THAN VIDEO)
// Returns { filePath, title, description, tags, provider:'pexels', isVideo:false, score } or null
// ===========================================================
async function findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips = [], bestVideoScore = 0) {
  if (!PEXELS_API_KEY) {
    console.error('[10B][FATAL] No PEXELS_API_KEY!');
    return null;
  }
  if (!workDir) {
    console.error('[10B][PHOTO][FATAL] workDir is required.');
    return null;
  }
  const q = String(subject || '').trim();
  if (!q) {
    console.error(`[10B][PHOTO][${jobId}] Empty subject.`);
    return null;
  }

  console.log(`[10B][PHOTO][${jobId}] Searching Pexels photos for: "${q}" (pages=${PAGES}, per_page=${MAX_PER_PAGE})`);

  // 1) Fetch across variants
  const photos = await collectPexelsPhotos(q, jobId);
  if (!photos.length) {
    console.warn(`[10B][PHOTO][${jobId}] No photos found for "${q}"`);
    return null;
  }

  const landmarkMode = STRICT_LANDMARK_MODE && isLandmarkSubject(q);

  // 2) Build candidates and score
  const candidates = [];
  for (const photo of photos) {
    const url =
      (photo.src && (photo.src.large2x || photo.src.original || photo.src.large)) || null;
    if (!url) continue;

    const w = photo.width;
    const h = photo.height;

    if (usedHas(usedClips, url) || usedHas(usedClips, String(photo.id))) continue;

    const item = {
      pexelsId: photo.id,
      url,
      width: w,
      height: h,
      photographer: photo.photographer,
      title: photo.url || `pexels-photo-${photo.id}`,
      description: `Pexels photo ${photo.id} (${photo.__variant || 'base'})`,
      tags: [], // reserved for downstream enrichment
      subject: q,
      isVideo: false,
      provider: 'pexels',
      path: null,
      source: 'pexels'
    };

    if (landmarkMode && !landmarkCullCandidate(item)) {
      console.log(`[10B][PHOTO][${jobId}][CULL][LANDMARK] drop id=${photo.id} due to animal/person noise`);
      continue;
    }

    item.score = scorePhotoCandidate(item, q, usedClips);
    candidates.push(item);
  }

  if (!candidates.length) {
    console.warn(`[10B][PHOTO][${jobId}] No usable photo candidates after filtering.`);
    return null;
  }

  // Prefer portrait photos for 9:16 and then score
  candidates.sort((a, b) => {
    const pa = isLikelyPortrait(a.width, a.height) ? 1 : 0;
    const pb = isLikelyPortrait(b.width, b.height) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return b.score - a.score;
  });

  // Apply hard floor
  const viable = candidates.filter(c => c.score >= HARD_FLOOR_IMAGE);
  if (!viable.length) {
    console.warn(`[10B][PHOTO][${jobId}] All candidates fell below floor=${HARD_FLOOR_IMAGE}.`);
    return null;
  }

  // Log top 10
  viable.slice(0, 10).forEach((c, i) => {
    console.log(
      `[10B][PHOTO][${jobId}][CANDIDATE][${i + 1}] id=${c.pexelsId} ` +
      `score=${c.score} w=${c.width} h=${c.height} portrait=${isLikelyPortrait(c.width, c.height)}`
    );
  });

  const best = viable[0];

  // 3) Enforce "photo only if better than video" policy
  const photoBeatsVideo =
    (best.score >= (bestVideoScore || 0) + PHOTO_BEATS_VIDEO_MARGIN) ||
    (best.score >= STRICT_PHOTO_THRESHOLD && (bestVideoScore || 0) < Math.max(80, HARD_FLOOR_VIDEO));

  if (!photoBeatsVideo) {
    console.log(
      `[10B][PHOTO][${jobId}] Skipping photo. bestPhoto=${best.score} vs bestVideo=${bestVideoScore} ` +
      `(margin=${PHOTO_BEATS_VIDEO_MARGIN}, strict=${STRICT_PHOTO_THRESHOLD})`
    );
    return null;
  }

  ensureDir(workDir);
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-photo-${best.pexelsId}.jpg`);

  if (!fileOk(outPath, MIN_BYTES_PHOTO)) {
    console.log(`[10B][PHOTO][${jobId}] Downloading Pexels photo → ${outPath}`);
    const dl = await downloadFile(best.url, outPath, jobId /* CDN; no auth for file URL */);
    if (!dl || !fileOk(outPath, MIN_BYTES_PHOTO)) {
      console.warn(`[10B][PHOTO][${jobId}] Download failed/invalid for ${best.url}`);
      return null;
    }
  } else {
    console.log(`[10B][PHOTO][${jobId}] Photo already present: ${outPath}`);
  }

  best.path = outPath;
  usedAdd(usedClips, outPath);
  usedAdd(usedClips, best.url);
  usedAdd(usedClips, String(best.pexelsId));

  console.log(`[10B][PHOTO][${jobId}] Selected photo id=${best.pexelsId} score=${best.score} path=${outPath}`);
  return {
    filePath: outPath,
    title: best.title,
    description: best.description,
    tags: best.tags,
    provider: 'pexels',
    isVideo: false,
    score: best.score,
  };
}

module.exports = {
  findPexelsClipForScene,
  findPexelsPhotoForScene
};
