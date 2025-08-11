// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER (Video + Photo Search & Download)
// Exports:
//   - findPexelsClipForScene(subject, workDir, sceneIdx, jobId)  // returns {path, meta} or null
//   - findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId) // returns {path, meta} or null
//
// Design:
//  - Ultra-robust input normalization (fixes str.replace crash)
//  - Vertical-first video picking (Shorts/Reels/TikTok format)
//  - Conservative file sizes; chooses sane resolution variants
//  - Streamed download with content-length sanity checks
//  - Max logging; no silent failures
//
// De-dupe policy:
//  - NONE here. 5D enforces within-job de-dupe.
// ===========================================================

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const AGENT = new https.Agent({ keepAlive: true });

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_API_KEY) {
  console.error('[10B][FATAL] Missing PEXELS_API_KEY in environment!');
}

// Tunables
const PEXELS_VIDEO_PER_PAGE = Number(process.env.SS_PEXELS_VIDEO_PER_PAGE || 15);
const PEXELS_PHOTO_PER_PAGE = Number(process.env.SS_PEXELS_PHOTO_PER_PAGE || 12);
const PEXELS_MIN_PROVIDER_SCORE = Number(process.env.SS_PEXELS_MIN_SCORE || 28);
const MAX_DOWNLOAD_BYTES = Number(process.env.SS_PEXELS_MAX_DL || 800 * 1024 * 1024); // 800MB guard
const TARGET_MAX_HEIGHT = Number(process.env.SS_PEXELS_MAX_H || 1920);
const TARGET_MAX_WIDTH  = Number(process.env.SS_PEXELS_MAX_W || 1080);

// ---------------------
// Utility / Normalizers
// ---------------------
function cleanQuery(str) {
  // Bulletproof coercion; prevents "str.replace is not a function"
  const s = String(str ?? '').trim();
  if (!s) return '';
  return s.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();
}

function safeBaseName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\-\s_\.]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'pexels';
}

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function majorWords(subject) {
  return String(subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w =>
      w.length > 2 &&
      !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w)
    );
}

function strictSubjectPresent(haystack, subject) {
  const a = normalize(haystack).split(' ');
  const b = majorWords(subject);
  return b.length && b.every(w => a.includes(w));
}

function partialSubjectPresent(haystack, subject) {
  const txt = normalize(haystack);
  const words = majorWords(subject);
  return words.some(w => txt.includes(w));
}

function assertFileExists(file, label = 'FILE', minBytes = 4096) {
  try {
    if (!file || !fs.existsSync(file)) {
      console.error(`[10B][${label}][ERR] File does not exist: ${file}`);
      return false;
    }
    const size = fs.statSync(file).size;
    if (size < minBytes) {
      console.error(`[10B][${label}][ERR] File too small (${size} bytes): ${file}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[10B][${label}][ERR]`, e);
    return false;
  }
}

// ---------------------
// HTTP helpers
// ---------------------
function pexelsClient() {
  return axios.create({
    baseURL: 'https://api.pexels.com',
    timeout: 15000,
    headers: {
      Authorization: PEXELS_API_KEY,
      'User-Agent': 'SocialStormAI/10B (Pexels Helper)',
      Accept: 'application/json'
    },
    httpsAgent: AGENT,
    validateStatus: s => s >= 200 && s < 500
  });
}

async function downloadStream(url, outPath, jobId) {
  console.log(`[10B][DL][${jobId}] Downloading ${url} -> ${outPath}`);
  const writer = fs.createWriteStream(outPath);

  const resp = await axios.get(url, {
    responseType: 'stream',
    timeout: 300000,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    headers: { 'User-Agent': 'SocialStormAI/10B (Downloader)' },
    httpsAgent: AGENT,
    validateStatus: s => s >= 200 && s < 400,
  });

  const contentLength = Number(resp.headers['content-length'] || 0);
  if (contentLength && contentLength > MAX_DOWNLOAD_BYTES) {
    writer.close?.();
    try { fs.unlinkSync(outPath); } catch {}
    throw new Error(`[10B][DL][${jobId}] Refusing huge file (${contentLength} bytes) from ${url}`);
  }

  await new Promise((resolve, reject) => {
    resp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  // Sanity check
  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  console.log(`[10B][DL][${jobId}] Done. Size=${size} bytes`);
  if (size === 0) {
    try { fs.unlinkSync(outPath); } catch {}
    throw new Error(`[10B][DL][${jobId}] Zero-byte file after download: ${outPath}`);
  }
  return outPath;
}

// ---------------------
// Pexels Video Search
// ---------------------
function buildVideoQueryURL(query, page = 1) {
  const q = encodeURIComponent(query);
  // Pexels videos endpoint doesn't have explicit orientation=portrait param;
  // we’ll filter by width/height from video_files after fetch.
  return `/videos/search?query=${q}&per_page=${PEXELS_VIDEO_PER_PAGE}&page=${page}`;
}

function scoreVideoCandidate(item, subject) {
  // item fields (per Pexels): id, url, image, duration, video_files[], video_pictures[], user{ name }
  const titleish = `${item.url || ''} ${item.user?.name || ''}`.trim();
  let score = 0;

  // Subject presence
  if (strictSubjectPresent(titleish, subject)) score += 60;
  else if (partialSubjectPresent(titleish, subject)) score += 30;

  // Duration sweet spot (3s–25s)
  const d = Number(item.duration || 0);
  if (d >= 3 && d <= 25) score += 25;
  else if (d > 25 && d <= 40) score += 10;
  else score -= 10;

  // Orientation preference (portrait)
  const bestFile = chooseBestVideoFile(item.video_files);
  if (bestFile._portrait) score += 35;

  // Resolution sanity
  if (bestFile.height && bestFile.height <= 2160) score += 10;

  return { providerScore: score, bestFile };
}

function chooseBestVideoFile(files = []) {
  // Prefer mp4 vertical close to 1080x1920, next best vertical > square, else highest sane res
  const mp4s = files.filter(f => /mp4/i.test(f.file_type || f.quality || f.link || ''));
  if (!mp4s.length) return { link: null, width: 0, height: 0, _portrait: false };

  const withShape = mp4s.map(f => {
    const width = Number(f.width || 0);
    const height = Number(f.height || 0);
    const portrait = height > width;
    return { ...f, width, height, _portrait: portrait };
  });

  // Score by closeness to target while preferring portrait
  function closeness(f) {
    const dw = Math.abs((f.width || 0) - TARGET_MAX_WIDTH);
    const dh = Math.abs((f.height || 0) - TARGET_MAX_HEIGHT);
    const shapeBonus = f._portrait ? 500 : 0;
    return -(dw + dh) + shapeBonus;
  }

  withShape.sort((a, b) => closeness(b) - closeness(a));
  return withShape[0] || { link: null, width: 0, height: 0, _portrait: false };
}

async function searchPexelsVideos(query, page = 1) {
  const url = buildVideoQueryURL(query, page);
  console.log(`[10B][PEXELS][Q] ${url}`);
  const cli = pexelsClient();
  const resp = await cli.get(url);
  if (resp.status >= 400) {
    console.error('[10B][PEXELS][HTTP_ERR]', resp.status, resp.data || '');
    return { ok: false, items: [] };
  }
  const items = Array.isArray(resp.data?.videos) ? resp.data.videos : [];
  console.log(`[10B][PEXELS][RES] videos=${items.length}`);
  return { ok: true, items };
}

// ---------------------
// Pexels Photo Search
// ---------------------
function buildPhotoQueryURL(query, page = 1) {
  const q = encodeURIComponent(query);
  // Using portrait orientation for image fallbacks
  return `/v1/search?query=${q}&per_page=${PEXELS_PHOTO_PER_PAGE}&orientation=portrait&page=${page}`;
}

async function searchPexelsPhotos(query, page = 1) {
  const url = buildPhotoQueryURL(query, page);
  console.log(`[10B][PEXELS-PHOTO][Q] ${url}`);
  const cli = pexelsClient();
  const resp = await cli.get(url);
  if (resp.status >= 400) {
    console.error('[10B][PEXELS-PHOTO][HTTP_ERR]', resp.status, resp.data || '');
    return { ok: false, items: [] };
  }
  const items = Array.isArray(resp.data?.photos) ? resp.data.photos : [];
  console.log(`[10B][PEXELS-PHOTO][RES] photos=${items.length}`);
  return { ok: true, items };
}

// ---------------------
// Public: find video
// ---------------------
async function findPexelsClipForScene(subject, workDir, sceneIdx, jobId) {
  try {
    const qRaw = cleanQuery(subject);
    const q = qRaw || cleanQuery(String(subject && subject.subject || ''));

    console.log(`[10B][PEXELS][${jobId}] findPexelsClipForScene | subject="${q}" | sceneIdx=${sceneIdx}`);
    if (!q) {
      console.warn(`[10B][PEXELS][${jobId}] Empty subject after normalization; skipping.`);
      return null;
    }
    if (!PEXELS_API_KEY) {
      console.warn('[10B][PEXELS][WARN] No API key; skipping provider.');
      return null;
    }
    if (!workDir) {
      console.warn('[10B][PEXELS][WARN] No workDir provided; skipping provider.');
      return null;
    }

    // Try up to 2 pages max for speed
    const all = [];
    for (let page = 1; page <= 2; page++) {
      const r = await searchPexelsVideos(q, page);
      if (!r.ok) break;
      all.push(...r.items);
      if (r.items.length < PEXELS_VIDEO_PER_PAGE) break; // last page
    }
    if (!all.length) {
      console.log(`[10B][PEXELS][${jobId}] No videos for "${q}".`);
      return null;
    }

    // Score, then pick top
    const scored = all.map(item => {
      const { providerScore, bestFile } = scoreVideoCandidate(item, q);
      return { item, bestFile, providerScore };
    }).sort((a, b) => b.providerScore - a.providerScore);

    const top = scored[0];
    if (!top || !top.bestFile?.link) {
      console.log(`[10B][PEXELS][${jobId}] No usable file variant for "${q}".`);
      return null;
    }
    if (top.providerScore < PEXELS_MIN_PROVIDER_SCORE) {
      console.log(`[10B][PEXELS][${jobId}] Provider score too low: ${top.providerScore} < ${PEXELS_MIN_PROVIDER_SCORE}`);
      return null;
    }

    // Download
    const base = safeBaseName(q);
    const id = top.item.id || 'vid';
    const outFile = path.join(workDir, `scene${(sceneIdx ?? 'x')}-pexels-${id}-${base}-${uuidv4().slice(0,8)}.mp4`);

    await downloadStream(top.bestFile.link, outFile, jobId);

    if (!assertFileExists(outFile, 'PEXELS_DOWNLOAD', 8192)) {
      console.error(`[10B][PEXELS][${jobId}] Download failed sanity check for "${q}".`);
      return null;
    }

    // Return shape expected by 5D
    const meta = {
      provider: 'pexels',
      id: top.item.id,
      url: top.item.url,
      filename: path.basename(outFile),
      originalName: path.basename(outFile),
      author: top.item.user?.name || '',
      width: top.bestFile.width || 0,
      height: top.bestFile.height || 0,
      duration: Number(top.item.duration || 0),
      portrait: !!top.bestFile._portrait,
      score: top.providerScore,
    };

    console.log(`[10B][PEXELS][PICK][${jobId}] score=${top.providerScore} file=${outFile} (${meta.width}x${meta.height}, ${meta.duration}s, portrait=${meta.portrait})`);
    return { path: outFile, meta };
  } catch (err) {
    if (err?.response?.data) {
      console.error('[10B][PEXELS][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10B][PEXELS][ERR]', err);
    }
    return null;
  }
}

// ---------------------
// Public: find photo
// ---------------------
async function findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId /* usedClips ignored */) {
  try {
    const q = cleanQuery(subject);
    console.log(`[10B][PEXELS-PHOTO][${jobId}] findPexelsPhotoForScene | subject="${q}" | sceneIdx=${sceneIdx}`);
    if (!q) {
      console.warn(`[10B][PEXELS-PHOTO][${jobId}] Empty subject after normalization; skipping.`);
      return null;
    }
    if (!PEXELS_API_KEY) {
      console.warn('[10B][PEXELS-PHOTO][WARN] No API key; skipping provider.');
      return null;
    }
    if (!workDir) {
      console.warn('[10B][PEXELS-PHOTO][WARN] No workDir provided; skipping provider.');
      return null;
    }

    // Try 1 page only (images are lower tier; KB helper can re-query as needed)
    const r = await searchPexelsPhotos(q, 1);
    if (!r.ok || !r.items.length) {
      console.log(`[10B][PEXELS-PHOTO][${jobId}] No photos for "${q}".`);
      return null;
    }

    // Simple scoring: portrait & subject presence in alt/photographer
    const scored = r.items.map(p => {
      const altish = `${p.alt || ''} ${p.photographer || ''}`;
      let score = 0;
      if (strictSubjectPresent(altish, q)) score += 50;
      else if (partialSubjectPresent(altish, q)) score += 25;
      const portrait = (p.width && p.height) ? (p.height > p.width) : true;
      if (portrait) score += 25;
      return { p, portrait, score };
    }).sort((a, b) => b.score - a.score);

    const top = scored[0];
    const bestUrl = (top?.p?.src?.large2x || top?.p?.src?.large || top?.p?.src?.portrait || top?.p?.src?.original || top?.p?.src?.medium);
    if (!bestUrl) {
      console.log(`[10B][PEXELS-PHOTO][${jobId}] No usable image variant for "${q}".`);
      return null;
    }

    const base = safeBaseName(q);
    const id = top.p.id || 'img';
    const outFile = path.join(workDir, `scene${(sceneIdx ?? 'x')}-pexelsphoto-${id}-${base}-${uuidv4().slice(0,8)}.jpg`);

    await downloadStream(bestUrl, outFile, jobId);
    if (!assertFileExists(outFile, 'PEXELS_PHOTO_DOWNLOAD', 4096)) {
      console.error(`[10B][PEXELS-PHOTO][${jobId}] Download failed sanity check for "${q}".`);
      return null;
    }

    const meta = {
      provider: 'pexels',
      id: top.p.id,
      url: top.p.url,
      filename: path.basename(outFile),
      originalName: path.basename(outFile),
      author: top.p.photographer || '',
      width: Number(top.p.width || 0),
      height: Number(top.p.height || 0),
      portrait: !!top.portrait,
      score: top.score,
    };

    console.log(`[10B][PEXELS-PHOTO][PICK][${jobId}] score=${top.score} file=${outFile} (${meta.width}x${meta.height}, portrait=${meta.portrait})`);
    return { path: outFile, meta };
  } catch (err) {
    if (err?.response?.data) {
      console.error('[10B][PEXELS-PHOTO][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10B][PEXELS-PHOTO][ERR]', err);
    }
    return null;
  }
}

module.exports = {
  findPexelsClipForScene,
  findPexelsPhotoForScene,
};
