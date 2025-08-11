// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER (Video + Photo Search & Download)
// Exports:
//   - findPixabayClipForScene(subject, workDir, sceneIdx, jobId)  // returns { path, meta } or null
//   - findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId) // returns { path, meta } or null
//
// Design:
//  - Bulletproof input normalization (fixes str.replace crash)
//  - Vertical-first preference for short-form
//  - Safe streamed downloads with size guard
//  - Max logging; no silent failures
//
// De-dupe policy:
//  - NONE here. 5D enforces within-job de-dupe.
//
// Notes:
//  - Pixabay videos endpoint: /api/videos/
//  - Pixabay photos endpoint: /api/?image_type=photo
//  - Orientation filter exists for photos (orientation=vertical) but not videos.
// ===========================================================

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const AGENT = new https.Agent({ keepAlive: true });

const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
if (!PIXABAY_API_KEY) {
  console.error('[10C][FATAL] Missing PIXABAY_API_KEY in environment!');
}

// Tunables
const PIXABAY_VIDEO_PER_PAGE = Number(process.env.SS_PIXABAY_VIDEO_PER_PAGE || 15);
const PIXABAY_PHOTO_PER_PAGE = Number(process.env.SS_PIXABAY_PHOTO_PER_PAGE || 12);
const PIXABAY_MIN_PROVIDER_SCORE = Number(process.env.SS_PIXABAY_MIN_SCORE || 28);
const MAX_DOWNLOAD_BYTES = Number(process.env.SS_PIXABAY_MAX_DL || 800 * 1024 * 1024); // 800MB guard
const TARGET_MAX_HEIGHT = Number(process.env.SS_PIXABAY_MAX_H || 1920);
const TARGET_MAX_WIDTH  = Number(process.env.SS_PIXABAY_MAX_W || 1080);

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
    .slice(0, 80) || 'pixabay';
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
      console.error(`[10C][${label}][ERR] File does not exist: ${file}`);
      return false;
    }
    const size = fs.statSync(file).size;
    if (size < minBytes) {
      console.error(`[10C][${label}][ERR] File too small (${size} bytes): ${file}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[10C][${label}][ERR]`, e);
    return false;
  }
}

// ---------------------
// HTTP helpers
// ---------------------
function pixabayClient() {
  return axios.create({
    baseURL: 'https://pixabay.com',
    timeout: 15000,
    headers: {
      'User-Agent': 'SocialStormAI/10C (Pixabay Helper)',
      Accept: 'application/json'
    },
    httpsAgent: AGENT,
    validateStatus: s => s >= 200 && s < 500
  });
}

async function downloadStream(url, outPath, jobId) {
  console.log(`[10C][DL][${jobId}] Downloading ${url} -> ${outPath}`);
  const writer = fs.createWriteStream(outPath);

  const resp = await axios.get(url, {
    responseType: 'stream',
    timeout: 300000,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    headers: { 'User-Agent': 'SocialStormAI/10C (Downloader)' },
    httpsAgent: AGENT,
    validateStatus: s => s >= 200 && s < 400,
  });

  const contentLength = Number(resp.headers['content-length'] || 0);
  if (contentLength && contentLength > MAX_DOWNLOAD_BYTES) {
    writer.close?.();
    try { fs.unlinkSync(outPath); } catch {}
    throw new Error(`[10C][DL][${jobId}] Refusing huge file (${contentLength} bytes) from ${url}`);
  }

  await new Promise((resolve, reject) => {
    resp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  console.log(`[10C][DL][${jobId}] Done. Size=${size} bytes`);
  if (size === 0) {
    try { fs.unlinkSync(outPath); } catch {}
    throw new Error(`[10C][DL][${jobId}] Zero-byte file after download: ${outPath}`);
  }
  return outPath;
}

// ---------------------
// Pixabay Video Search
// ---------------------
function buildVideoQueryURL(query, page = 1) {
  const q = encodeURIComponent(query);
  // safesearch=true to avoid NSFW; order=popular helps relevance
  return `/api/videos/?key=${PIXABAY_API_KEY}&q=${q}&per_page=${PIXABAY_VIDEO_PER_PAGE}&page=${page}&safesearch=true&order=popular`;
}

async function searchPixabayVideos(query, page = 1) {
  const url = buildVideoQueryURL(query, page);
  console.log(`[10C][PIXABAY][Q] ${url}`);
  const cli = pixabayClient();
  const resp = await cli.get(url);
  if (resp.status >= 400) {
    console.error('[10C][PIXABAY][HTTP_ERR]', resp.status, resp.data || '');
    return { ok: false, items: [] };
  }
  const items = Array.isArray(resp.data?.hits) ? resp.data.hits : [];
  console.log(`[10C][PIXABAY][RES] videos=${items.length}`);
  return { ok: true, items };
}

function flattenVideoFiles(hit) {
  // Pixabay structure: hit.videos = { large:{url,width,height,size}, medium:{...}, small:{...}, tiny:{...} }
  const buckets = hit?.videos || {};
  const entries = [];
  for (const [label, v] of Object.entries(buckets)) {
    if (!v?.url) continue;
    const width = Number(v.width || 0);
    const height = Number(v.height || 0);
    entries.push({ label, url: v.url, width, height, size: Number(v.size || 0), _portrait: height > width });
  }
  return entries;
}

function chooseBestVideoFile(hit) {
  const variants = flattenVideoFiles(hit);
  if (!variants.length) return { url: null, width: 0, height: 0, _portrait: false, label: '' };

  // Prefer portrait close to 1080x1920, else best overall near target
  function closeness(f) {
    const dw = Math.abs((f.width || 0) - TARGET_MAX_WIDTH);
    const dh = Math.abs((f.height || 0) - TARGET_MAX_HEIGHT);
    const shapeBonus = f._portrait ? 500 : 0;
    return -(dw + dh) + shapeBonus;
  }

  variants.sort((a, b) => closeness(b) - closeness(a));
  return variants[0];
}

function scoreVideoCandidate(hit, subject) {
  // hit: { id, pageURL, tags, duration, user, videos{...} }
  const titleish = `${hit.pageURL || ''} ${hit.tags || ''} ${hit.user || ''}`.trim();
  let score = 0;

  // Subject presence (tags are useful on Pixabay)
  if (strictSubjectPresent(titleish, subject)) score += 60;
  else if (partialSubjectPresent(titleish, subject)) score += 30;

  // Duration sweet spot (3s–25s) – Pixabay doesn't always include duration; treat missing as neutral
  const d = Number(hit.duration || 0);
  if (d) {
    if (d >= 3 && d <= 25) score += 25;
    else if (d > 25 && d <= 40) score += 10;
    else score -= 10;
  }

  // Orientation preference (portrait)
  const best = chooseBestVideoFile(hit);
  if (best._portrait) score += 35;

  // Resolution sanity
  if (best.height && best.height <= 2160) score += 10;

  return { providerScore: score, bestFile: best };
}

// ---------------------
// Pixabay Photo Search
// ---------------------
function buildPhotoQueryURL(query, page = 1) {
  const q = encodeURIComponent(query);
  // orientation=vertical to prefer portrait; safesearch + popular order
  return `/api/?key=${PIXABAY_API_KEY}&q=${q}&image_type=photo&orientation=vertical&per_page=${PIXABAY_PHOTO_PER_PAGE}&page=${page}&safesearch=true&order=popular`;
}

async function searchPixabayPhotos(query, page = 1) {
  const url = buildPhotoQueryURL(query, page);
  console.log(`[10C][PIXABAY-PHOTO][Q] ${url}`);
  const cli = pixabayClient();
  const resp = await cli.get(url);
  if (resp.status >= 400) {
    console.error('[10C][PIXABAY-PHOTO][HTTP_ERR]', resp.status, resp.data || '');
    return { ok: false, items: [] };
  }
  const items = Array.isArray(resp.data?.hits) ? resp.data.hits : [];
  console.log(`[10C][PIXABAY-PHOTO][RES] photos=${items.length}`);
  return { ok: true, items };
}

// ---------------------
// Public: find video
// ---------------------
async function findPixabayClipForScene(subject, workDir, sceneIdx, jobId) {
  try {
    const qRaw = cleanQuery(subject);
    const q = qRaw || cleanQuery(String(subject && subject.subject || ''));

    console.log(`[10C][PIXABAY][${jobId}] findPixabayClipForScene | subject="${q}" | sceneIdx=${sceneIdx}`);
    if (!q) {
      console.warn(`[10C][PIXABAY][${jobId}] Empty subject after normalization; skipping.`);
      return null;
    }
    if (!PIXABAY_API_KEY) {
      console.warn('[10C][PIXABAY][WARN] No API key; skipping provider.');
      return null;
    }
    if (!workDir) {
      console.warn('[10C][PIXABAY][WARN] No workDir provided; skipping provider.');
      return null;
    }

    // Try up to 2 pages max for speed
    const all = [];
    for (let page = 1; page <= 2; page++) {
      const r = await searchPixabayVideos(q, page);
      if (!r.ok) break;
      all.push(...r.items);
      if (r.items.length < PIXABAY_VIDEO_PER_PAGE) break; // last page
    }
    if (!all.length) {
      console.log(`[10C][PIXABAY][${jobId}] No videos for "${q}".`);
      return null;
    }

    // Score & pick
    const scored = all.map(hit => {
      const { providerScore, bestFile } = scoreVideoCandidate(hit, q);
      return { hit, bestFile, providerScore };
    }).sort((a, b) => b.providerScore - a.providerScore);

    const top = scored[0];
    if (!top || !top.bestFile?.url) {
      console.log(`[10C][PIXABAY][${jobId}] No usable file variant for "${q}".`);
      return null;
    }
    if (top.providerScore < PIXABAY_MIN_PROVIDER_SCORE) {
      console.log(`[10C][PIXABAY][${jobId}] Provider score too low: ${top.providerScore} < ${PIXABAY_MIN_PROVIDER_SCORE}`);
      return null;
    }

    const base = safeBaseName(q);
    const id = top.hit.id || 'vid';
    const outFile = path.join(workDir, `scene${(sceneIdx ?? 'x')}-pixabay-${id}-${base}-${uuidv4().slice(0,8)}.mp4`);

    await downloadStream(top.bestFile.url, outFile, jobId);

    if (!assertFileExists(outFile, 'PIXABAY_DOWNLOAD', 8192)) {
      console.error(`[10C][PIXABAY][${jobId}] Download failed sanity check for "${q}".`);
      return null;
    }

    const meta = {
      provider: 'pixabay',
      id: top.hit.id,
      url: top.hit.pageURL,
      filename: path.basename(outFile),
      originalName: path.basename(outFile),
      author: top.hit.user || '',
      width: top.bestFile.width || 0,
      height: top.bestFile.height || 0,
      duration: Number(top.hit.duration || 0),
      portrait: !!top.bestFile._portrait,
      score: top.providerScore,
      label: top.bestFile.label || '',
    };

    console.log(`[10C][PIXABAY][PICK][${jobId}] score=${top.providerScore} file=${outFile} (${meta.width}x${meta.height}, ${meta.duration || 0}s, portrait=${meta.portrait})`);
    return { path: outFile, meta };
  } catch (err) {
    if (err?.response?.data) {
      console.error('[10C][PIXABAY][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10C][PIXABAY][ERR]', err);
    }
    return null;
  }
}

// ---------------------
// Public: find photo
// ---------------------
async function findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId /* usedClips ignored */) {
  try {
    const q = cleanQuery(subject);
    console.log(`[10C][PIXABAY-PHOTO][${jobId}] findPixabayPhotoForScene | subject="${q}" | sceneIdx=${sceneIdx}`);
    if (!q) {
      console.warn(`[10C][PIXABAY-PHOTO][${jobId}] Empty subject after normalization; skipping.`);
      return null;
    }
    if (!PIXABAY_API_KEY) {
      console.warn('[10C][PIXABAY-PHOTO][WARN] No API key; skipping provider.');
      return null;
    }
    if (!workDir) {
      console.warn('[10C][PIXABAY-PHOTO][WARN] No workDir provided; skipping provider.');
      return null;
    }

    // Try 1 page; images are lower tier (Ken Burns helper may re-query)
    const r = await searchPixabayPhotos(q, 1);
    if (!r.ok || !r.items.length) {
      console.log(`[10C][PIXABAY-PHOTO][${jobId}] No photos for "${q}".`);
      return null;
    }

    // Score: subject presence in tags; portrait orientation bonus
    const scored = r.items.map(p => {
      const titleish = `${p.tags || ''} ${p.user || ''}`.trim();
      let score = 0;
      if (strictSubjectPresent(titleish, q)) score += 50;
      else if (partialSubjectPresent(titleish, q)) score += 25;
      const portrait = (p.imageHeight && p.imageWidth) ? (p.imageHeight > p.imageWidth) : true; // vertical-only query already helps
      if (portrait) score += 25;
      const url = p.largeImageURL || p.webformatURL || p.previewURL;
      return { p, url, portrait, score };
    }).sort((a, b) => b.score - a.score);

    const top = scored[0];
    if (!top?.url) {
      console.log(`[10C][PIXABAY-PHOTO][${jobId}] No usable image variant for "${q}".`);
      return null;
    }

    const base = safeBaseName(q);
    const id = top.p.id || 'img';
    const outFile = path.join(workDir, `scene${(sceneIdx ?? 'x')}-pixabayphoto-${id}-${base}-${uuidv4().slice(0,8)}.jpg`);

    await downloadStream(top.url, outFile, jobId);
    if (!assertFileExists(outFile, 'PIXABAY_PHOTO_DOWNLOAD', 4096)) {
      console.error(`[10C][PIXABAY-PHOTO][${jobId}] Download failed sanity check for "${q}".`);
      return null;
    }

    const meta = {
      provider: 'pixabay',
      id: top.p.id,
      url: top.p.pageURL,
      filename: path.basename(outFile),
      originalName: path.basename(outFile),
      author: top.p.user || '',
      width: Number(top.p.imageWidth || 0),
      height: Number(top.p.imageHeight || 0),
      portrait: !!top.portrait,
      score: top.score,
    };

    console.log(`[10C][PIXABAY-PHOTO][PICK][${jobId}] score=${top.score} file=${outFile} (${meta.width}x${meta.height}, portrait=${meta.portrait})`);
    return { path: outFile, meta };
  } catch (err) {
    if (err?.response?.data) {
      console.error('[10C][PIXABAY-PHOTO][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10C][PIXABAY-PHOTO][ERR]', err);
    }
    return null;
  }
}

module.exports = {
  findPixabayClipForScene,
  findPixabayPhotoForScene,
};
