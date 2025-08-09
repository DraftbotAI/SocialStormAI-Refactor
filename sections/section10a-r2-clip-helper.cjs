// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2)
// Exports: findR2ClipForScene (used by 5D) + getAllFiles (for scans)
// MAX LOGGING, parallel-safe, strict/fuzzy/partial scoring,
// underscore/dash aware, and hard anti-dupe that MUTATES usedClips.
// ===========================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

console.log('[10A][INIT] R2 clip helper loaded.');

// ---- ENV / CLIENT -----------------------------------------------------------
const R2_BUCKET =
  process.env.R2_BUCKET ||
  process.env.R2_LIBRARY_BUCKET; // legacy var supported

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_KEY = process.env.R2_KEY || process.env.R2_ACCESS_KEY_ID;
const R2_SECRET = process.env.R2_SECRET || process.env.R2_SECRET_ACCESS_KEY;

if (!R2_BUCKET || !R2_ENDPOINT || !R2_KEY || !R2_SECRET) {
  console.error('[10A][FATAL] Missing R2 env vars: R2_BUCKET|R2_LIBRARY_BUCKET, R2_ENDPOINT, R2_KEY, R2_SECRET');
  throw new Error('[10A] Missing R2 env vars');
}

// Prefixes to scan (comma-separated). Empty entry "" means ROOT.
const RAW_PREFIXES =
  (process.env.R2_LIBRARY_PREFIXES && process.env.R2_LIBRARY_PREFIXES.split(',')) ||
  (process.env.R2_LIBRARY_PREFIX ? [process.env.R2_LIBRARY_PREFIX] : null) ||
  ['', 'socialstorm-library/'];

const R2_PREFIXES = RAW_PREFIXES
  .map(p => (p || '').trim())
  .map(p => (p && !p.endsWith('/') ? `${p}/` : p));

const s3Client = new S3Client({
  endpoint: R2_ENDPOINT,
  region: 'auto',
  credentials: { accessKeyId: R2_KEY, secretAccessKey: R2_SECRET },
});

// ---- CONSTANTS --------------------------------------------------------------
const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.webm'];
const EXCLUDE_FRAGMENTS = [
  '/final/', '/hook/', '/mega/', '/jobs/', '/outro/', '/watermark/', '/temp/', '/thumbnails/', '/videos/'
];

// Canonical synonyms (extend as needed)
const CANONICAL_SYNONYMS = {
  manatee: ['manatees', 'sea cow', 'sea cows', 'west indian manatee', 'florida manatee', 'trichechus']
};

// ---- UTILS ------------------------------------------------------------------
function log(section, stage, msg, meta) {
  console.log(`[10A][${section}][${stage}] ${msg}`, meta || '');
}

function cleanForFilename(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function normalizeForMatch(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeToken(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeStem(key) {
  const stem = normalizeToken(path.basename(key, path.extname(key)));
  return stem.split(' ').filter(Boolean);
}

function majorWords(subject = '') {
  return String(subject)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
}

function hasVideoExt(key = '') {
  return VIDEO_EXTS.includes(path.extname(key).toLowerCase());
}

function keyLooksExcluded(key = '') {
  const lk = key.toLowerCase();
  return EXCLUDE_FRAGMENTS.some(f => lk.includes(f));
}

function dupeKeyFor(key = '') {
  const norm = normalizeToken(key);
  const stem = normalizeToken(path.basename(key, path.extname(key)));
  return `${norm}|${stem}`;
}

function expandSubject(subject = '') {
  const primary = normalizeToken(subject);
  const set = new Set([primary]);
  const syns = CANONICAL_SYNONYMS[primary];
  if (syns) syns.forEach(v => set.add(normalizeToken(v)));
  if (primary.endsWith('s')) set.add(primary.slice(0, -1));
  else set.add(`${primary}s`);
  return Array.from(set).filter(Boolean);
}

// ---- MATCH HELPERS ----------------------------------------------------------
function strictSubjectMatch(filename, subject) {
  if (!filename || !subject) return false;
  const safeSubject = cleanForFilename(subject);
  const re = new RegExp(`(^|_|-)${safeSubject}(_|-|\\.|$)`, 'i');
  return re.test(cleanForFilename(filename));
}

function fuzzyMatch(filename, subject) {
  if (!filename || !subject) return false;
  const fn = normalizeForMatch(filename);
  const words = majorWords(subject);
  return words.length && words.every(w => fn.includes(w));
}

function partialMatch(filename, subject) {
  if (!filename || !subject) return false;
  const fn = normalizeForMatch(filename);
  const words = majorWords(subject);
  return words.some(w => fn.includes(w));
}

function scoreR2Match(filename, subject, expansions = []) {
  if (!filename || !subject) return -99999;

  const fn = normalizeForMatch(filename);
  const subj = normalizeForMatch(subject);
  const tokens = tokenizeStem(filename);
  let score = 0;

  // Strong token hits from expansions (e.g., "manatee" / "sea cow")
  for (const exp of expansions) {
    if (!exp) continue;
    if (tokens.includes(exp)) score += 35;         // exact token hit
    else if (fn.includes(exp)) score += 15;        // substring
  }

  if (strictSubjectMatch(filename, subject)) score += 100;
  if (fuzzyMatch(filename, subject)) score += 35;
  if (partialMatch(filename, subject)) score += 15;

  if (subj && fn.includes(subj)) score += 12;      // phrase bonus

  // Each major word +5
  for (const w of majorWords(subject)) {
    if (fn.includes(w)) score += 5;
  }

  // Portrait-ish hints
  if (/_portrait\.(mp4|mov|m4v|webm)$/i.test(filename) || fn.includes('9 16') || fn.includes('shorts') || fn.includes('tiktok')) {
    score += 8;
  }

  // Prefer shorter stems (tighter match)
  score -= Math.min(40, fn.length);

  return score;
}

// ---- LISTING ---------------------------------------------------------------
async function listAllUnderPrefix(prefix = '', jobId = '') {
  const keys = [];
  let ContinuationToken;
  let round = 0;

  do {
    round++;
    log('LIST', 'REQUEST', `Bucket="${R2_BUCKET}" Prefix="${prefix}" Round=${round} CT=${ContinuationToken || '∅'}`);
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      ContinuationToken,
      MaxKeys: 1000
    });
    const res = await s3Client.send(cmd);
    (res.Contents || []).forEach(o => o?.Key && keys.push(o.Key));
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    log('LIST', 'PAGE_OK', `Got ${res.Contents?.length || 0} keys (cumulative ${keys.length})`);
  } while (ContinuationToken);

  return keys;
}

async function getAllFiles(prefixOverride = null, jobId = 'STATIC') {
  const prefixes = typeof prefixOverride === 'string' ? [prefixOverride] : R2_PREFIXES;
  log('LIST', 'START', `Scanning ${prefixes.length} prefix(es)`, { prefixes });

  const agg = [];
  for (const p of prefixes) {
    try {
      const page = await listAllUnderPrefix(p, jobId);
      agg.push(...page);
    } catch (err) {
      log('LIST', 'ERR', `Prefix "${p}" failed`, { error: String(err && err.message || err) });
    }
  }
  const uniq = Array.from(new Set(agg));
  log('LIST', 'DONE', `Unique keys found: ${uniq.length}`);
  return uniq;
}

// ---- FILE VALIDATION --------------------------------------------------------
function isValidClip(filePath, jobId) {
  try {
    if (!fs.existsSync(filePath)) {
      log('FILE', 'MISS', `Not found`, { filePath, jobId });
      return false;
    }
    const size = fs.statSync(filePath).size;
    if (size < 2048) {
      log('FILE', 'SMALL', `Too small`, { filePath, size, jobId });
      return false;
    }
    return true;
  } catch (err) {
    log('FILE', 'ERR', `Validation exception`, { error: String(err) });
    return false;
  }
}

// ---- usedClips helpers (Array or Set) --------------------------------------
function usedAdd(usedClips, v) {
  if (!v) return;
  if (usedClips instanceof Set) usedClips.add(v);
  else if (Array.isArray(usedClips)) { if (!usedClips.includes(v)) usedClips.push(v); }
}
function usedHas(usedClips, v) {
  if (!v) return false;
  if (usedClips instanceof Set) return usedClips.has(v);
  if (Array.isArray(usedClips)) return usedClips.includes(v);
  return false;
}
function alreadyUsed(usedClips, key) {
  const base = path.basename(key);
  const dk = dupeKeyFor(key);
  return usedHas(usedClips, key) || usedHas(usedClips, base) || usedHas(usedClips, dk);
}

// ---- CORE -------------------------------------------------------------------
/**
 * Find and download the best R2 clip for a subject.
 * Mutates usedClips to prevent repeats (adds dupeKey, key, basename).
 * @returns {Promise<string|null>} local file path
 */
async function findR2ClipForScene(subject, workDir, sceneIdx = 0, jobId = '', usedClips = []) {
  log('START', 'CTX', 'findR2ClipForScene', { subject, sceneIdx, jobId, workDir });

  if (!subject || typeof subject !== 'string') {
    log('START', 'ERR', 'Invalid subject', { subject });
    return null;
  }

  // 1) List keys once
  let keys = [];
  try {
    keys = await getAllFiles(null, jobId);
  } catch (err) {
    log('LIST', 'ERR', 'getAllFiles failed', { error: String(err && err.message || err) });
    return null;
  }

  if (!keys.length) {
    log('START', 'WARN', 'No keys in bucket');
    return null;
  }

  // 2) Filter to candidate videos under allowed paths
  const candidates = keys.filter(k => k && hasVideoExt(k) && !keyLooksExcluded(k));
  if (!candidates.length) {
    log('FILTER', 'WARN', 'No video candidates after filtering');
    return null;
  }

  // 3) Score by strict/fuzzy/partial + synonyms
  const expansions = expandSubject(subject);
  const scored = [];

  for (const key of candidates) {
    if (alreadyUsed(usedClips, key)) {
      log('SKIP', 'USED', 'Key already used this job', { key });
      continue;
    }
    const score = scoreR2Match(key, subject, expansions);
    scored.push({ key, score });
  }

  if (!scored.length) {
    log('SCORE', 'EMPTY', 'All candidates filtered out by usedClips or none scored');
    return null;
  }

  scored.sort((a, b) => b.score - a.score);

  // Log Top-5 for visibility
  const top5 = scored.slice(0, 5).map((s, i) => ({ rank: i + 1, key: s.key, score: s.score }));
  log('SCORE', 'TOP5', 'Top candidates', top5);

  const best = scored[0];
  if (!best || !best.key) {
    log('SCORE', 'ERR', 'No best candidate after sort');
    return null;
  }

  const base = path.basename(best.key);
  const dk = dupeKeyFor(best.key);

  // Mark as used immediately (prevents echo repeats across scenes)
  usedAdd(usedClips, best.key);
  usedAdd(usedClips, base);
  usedAdd(usedClips, dk);

  // 4) Download (parallel-safe name)
  const unique = uuidv4();
  const ext = path.extname(best.key).toLowerCase() || '.mp4';
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2-${unique}${ext}`);

  log('DL', 'START', 'Downloading', { key: best.key, outPath, score: best.score });

  try {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: best.key }));
    await new Promise((resolve, reject) => {
      const stream = resp.Body;
      const fileStream = fs.createWriteStream(outPath);
      stream.pipe(fileStream);
      let resolved = false;
      const done = (err) => { if (!resolved) { resolved = true; err ? reject(err) : resolve(); } };
      stream.on('end', () => done());
      stream.on('error', (e) => { log('DL', 'ERR', 'Stream error', { error: String(e) }); done(e); });
      fileStream.on('finish', () => done());
      fileStream.on('error', (e) => { log('DL', 'ERR', 'Write error', { error: String(e) }); done(e); });
    });
  } catch (err) {
    log('DL', 'ERR', 'GetObject failed', { error: String(err && err.message || err), key: best.key });
    return null;
  }

  if (!isValidClip(outPath, jobId)) {
    log('DL', 'BAD', 'Downloaded file invalid', { outPath });
    return null;
  }

  log('DL', 'OK', 'Downloaded', { outPath });
  return outPath;
}

// ---- STATIC export for scans ------------------------------------------------
async function _getAllFilesStatic(prefixOverride) {
  try {
    const files = await getAllFiles(prefixOverride, 'STATIC');
    const vids = files.filter(k => hasVideoExt(k));
    log('STATIC', 'SUMMARY', `Total video keys`, { count: vids.length });
    return vids;
  } catch (err) {
    log('STATIC', 'ERR', 'getAllFiles failed', { error: String(err && err.message || err) });
    return [];
  }
}

// Keep compatibility: findR2ClipForScene.getAllFiles
findR2ClipForScene.getAllFiles = _getAllFilesStatic;

module.exports = {
  findR2ClipForScene,
  getAllFiles
};
