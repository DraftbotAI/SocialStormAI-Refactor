// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER (Video & Photo Search & Download)
// Exports:
//   - findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
//   - findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips)
// Video-first: photos are used ONLY if they beat the best video by margin.
// Max logs, anti-dupe (URL & filename), vertical-preferred, strict sizing.
// Ready for universal scoring (10G).
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');

// ==== ENV / API ====
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';
if (!PEXELS_API_KEY) {
  console.error('[10B][FATAL] Missing PEXELS_API_KEY in env!');
}

console.log('[10B][INIT] Pexels helper (video-first, vertical-preferred, anti-dupe) loaded.');

const PEXELS_VIDEO_URL = 'https://api.pexels.com/videos/search';
const PEXELS_PHOTO_URL = 'https://api.pexels.com/v1/search';

// ==== CONSTANTS / TUNABLES ====
const MIN_BYTES_VIDEO = 2048;
const MIN_BYTES_PHOTO = 1024;
const MAX_PER_PAGE = 40;             // ask for more to improve hit-rate
const PAGES = 2;                      // pull up to ~80 results/video or photo
const PHOTO_BEATS_VIDEO_MARGIN = 5;   // photo must be strictly better than video by this many points
const STRICT_PHOTO_THRESHOLD = 90;    // or extremely strong photo and weak video
const VERTICAL_ASPECT_TARGET = 9 / 16;
const VERTICAL_TOLERANCE = 0.20;      // allow 20% aspect wiggle (portrait-ish)

// ==== SMALL UTILS ====
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function isLikelyPortrait(w, h) {
  if (!w || !h) return false;
  const ratio = w / h;
  // Portrait if ratio is within tolerance around 9:16 (0.5625)
  return Math.abs(ratio - VERTICAL_ASPECT_TARGET) <= VERTICAL_TOLERANCE || ratio < 0.8;
}

function alreadyUsed(usedClips = [], keyOrPath = '') {
  if (!keyOrPath) return false;
  const base = path.basename(keyOrPath);
  return usedClips.some(u => u === keyOrPath || u === base || String(keyOrPath).endsWith(String(u)));
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
      headers: addAuthHeader ? { Authorization: PEXELS_API_KEY } : undefined
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

  // Prefer portrait-ish & highest height; else fall back to overall largest resolution
  const portrait = videoFiles
    .filter(v => v && v.width && v.height && isLikelyPortrait(v.width, v.height))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (portrait.length) return portrait[0];

  // Fallback: pick highest resolution total pixels
  return videoFiles
    .filter(v => v && v.width && v.height)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
}

// ==== PAGED SEARCH HELPERS ====
async function pexelsSearchPaged(url, paramsBase, label, jobId) {
  let out = [];
  for (let page = 1; page <= PAGES; page++) {
    try {
      const params = { ...paramsBase, page, per_page: MAX_PER_PAGE };
      const res = await axios.get(url, {
        params,
        headers: { Authorization: PEXELS_API_KEY }
      });
      const items = (res.data && (label === 'video' ? res.data.videos : res.data.photos)) || [];
      console.log(`[10B][${label.toUpperCase()}][${jobId}] page=${page} got=${items.length}`);
      out.push(...items);
      if (!items.length) break; // no need to continue if empty page
    } catch (err) {
      console.error(`[10B][${label.toUpperCase()}][${jobId}][ERR] page=${page}`, err?.response?.status, err?.message);
      break; // don't loop forever on repeated errors
    }
  }
  return out;
}

// ==== SCORE WRAPPERS ====
function scoreVideoCandidate(c, subject, usedClips) {
  // video candidates get the "isRealVideo" bonus
  return scoreSceneCandidate(c, subject, usedClips, /*isRealVideo=*/true);
}

function scorePhotoCandidate(c, subject, usedClips) {
  return scoreSceneCandidate(c, subject, usedClips, /*isRealVideo=*/false);
}

// ===========================================================
// MAIN VIDEO FINDER (VIDEO-FIRST)
// ===========================================================
async function findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  if (!PEXELS_API_KEY) {
    console.error('[10B][FATAL] No PEXELS_API_KEY!');
    return null;
  }
  const q = String(subject || '').trim();
  if (!q) {
    console.error('[10B][VIDEO][${jobId}] Empty subject.');
    return null;
  }

  console.log(`[10B][VIDEO][${jobId}] Searching Pexels for videos: "${q}" (pages=${PAGES}, per_page=${MAX_PER_PAGE})`);

  // 1) Fetch multiple pages of videos
  const videos = await pexelsSearchPaged(PEXELS_VIDEO_URL, { query: q }, 'video', jobId);
  if (!videos.length) {
    console.warn(`[10B][VIDEO][${jobId}] No videos found for "${q}"`);
    return null;
  }

  // 2) Build candidates and score
  const candidates = [];
  for (const video of videos) {
    const bestFile = pickBestVideoFile(video.video_files || []);
    if (!bestFile || !bestFile.link) continue;

    const url = bestFile.link;
    const w = bestFile.width || video.width;
    const h = bestFile.height || video.height;
    const dur = video.duration;

    // reject if clearly already used (by URL or id)
    if (alreadyUsed(usedClips, url) || alreadyUsed(usedClips, String(video.id))) continue;

    const item = {
      pexelsId: video.id,
      url,
      width: w,
      height: h,
      duration: dur,
      photographer: video.user && video.user.name,
      title: video.url,
      tags: video.tags || [],
      subject: q,
      isVideo: true,
      path: null
    };

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

  // Log top 10
  candidates.slice(0, 10).forEach((c, i) => {
    console.log(
      `[10B][VIDEO][${jobId}][CANDIDATE][${i + 1}] id=${c.pexelsId} ` +
      `score=${c.score} w=${c.width} h=${c.height} dur=${c.duration}s portrait=${isLikelyPortrait(c.width, c.height)}`
    );
  });

  const best = candidates[0];
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-${best.pexelsId}.mp4`);

  // 3) Download (don’t re-download if valid)
  if (!fileOk(outPath, MIN_BYTES_VIDEO)) {
    console.log(`[10B][VIDEO][${jobId}] Downloading Pexels video → ${outPath}`);
    const dl = await downloadFile(best.url, outPath, jobId /* no auth header for direct file URL */);
    if (!dl || !fileOk(outPath, MIN_BYTES_VIDEO)) {
      console.warn(`[10B][VIDEO][${jobId}] Download failed/invalid for ${best.url}`);
      return null;
    }
  } else {
    console.log(`[10B][VIDEO][${jobId}] Video already present: ${outPath}`);
  }

  best.path = outPath;
  // Track both the file path and the remote URL/id for de-dupe across scenes
  usedClips.push(outPath);
  usedClips.push(best.url);
  usedClips.push(String(best.pexelsId));

  console.log(`[10B][VIDEO][${jobId}] Selected video id=${best.pexelsId} score=${best.score} path=${outPath}`);
  return outPath;
}

// ===========================================================
// PHOTO FINDER (ONLY IF STRICTLY BETTER THAN VIDEO)
// ===========================================================
async function findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips = [], bestVideoScore = 0) {
  if (!PEXELS_API_KEY) {
    console.error('[10B][FATAL] No PEXELS_API_KEY!');
    return null;
  }
  const q = String(subject || '').trim();
  if (!q) {
    console.error('[10B][PHOTO][${jobId}] Empty subject.');
    return null;
  }

  console.log(`[10B][PHOTO][${jobId}] Searching Pexels Photos: "${q}" (pages=${PAGES}, per_page=${MAX_PER_PAGE})`);

  // 1) Fetch multiple pages of photos
  const photos = await pexelsSearchPaged(PEXELS_PHOTO_URL, { query: q }, 'photo', jobId);
  if (!photos.length) {
    console.warn(`[10B][PHOTO][${jobId}] No photos found for "${q}"`);
    return null;
  }

  // 2) Build candidates and score
  const candidates = [];
  for (const photo of photos) {
    const url =
      (photo.src && (photo.src.large2x || photo.src.original || photo.src.large)) || null;
    if (!url) continue;

    const w = photo.width;
    const h = photo.height;

    // reject if clearly already used
    if (alreadyUsed(usedClips, url) || alreadyUsed(usedClips, String(photo.id))) continue;

    const item = {
      pexelsId: photo.id,
      url,
      width: w,
      height: h,
      photographer: photo.photographer,
      subject: q,
      isVideo: false,
      path: null
    };

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

  // Log top 10
  candidates.slice(0, 10).forEach((c, i) => {
    console.log(
      `[10B][PHOTO][${jobId}][CANDIDATE][${i + 1}] id=${c.pexelsId} ` +
      `score=${c.score} w=${c.width} h=${c.height} portrait=${isLikelyPortrait(c.width, c.height)}`
    );
  });

  const best = candidates[0];

  // 3) Enforce "photo only if better than video" policy
  const photoBeatsVideo =
    (best.score >= bestVideoScore + PHOTO_BEATS_VIDEO_MARGIN) ||
    (best.score >= STRICT_PHOTO_THRESHOLD && bestVideoScore < 80);

  if (!photoBeatsVideo) {
    console.log(
      `[10B][PHOTO][${jobId}] Skipping photo. bestPhoto=${best.score} vs bestVideo=${bestVideoScore} ` +
      `(margin=${PHOTO_BEATS_VIDEO_MARGIN}, strict=${STRICT_PHOTO_THRESHOLD})`
    );
    return null;
  }

  const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-photo-${best.pexelsId}.jpg`);

  if (!fileOk(outPath, MIN_BYTES_PHOTO)) {
    console.log(`[10B][PHOTO][${jobId}] Downloading Pexels photo → ${outPath}`);
    const dl = await downloadFile(best.url, outPath, jobId /* no auth header for direct file URL */);
    if (!dl || !fileOk(outPath, MIN_BYTES_PHOTO)) {
      console.warn(`[10B][PHOTO][${jobId}] Download failed/invalid for ${best.url}`);
      return null;
    }
  } else {
    console.log(`[10B][PHOTO][${jobId}] Photo already present: ${outPath}`);
  }

  best.path = outPath;
  usedClips.push(outPath);
  usedClips.push(best.url);
  usedClips.push(String(best.pexelsId));

  console.log(`[10B][PHOTO][${jobId}] Selected photo id=${best.pexelsId} score=${best.score} path=${outPath}`);
  return outPath;
}

module.exports = {
  findPexelsClipForScene,
  findPexelsPhotoForScene
};
