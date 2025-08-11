// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2)
// Exports: findR2ClipForScene (used by 5D) + getAllFiles (for scans)
// MAX LOGGING, parallel-safe, strict/fuzzy/partial scoring,
// underscore/dash aware.
//
// 2025-08 (surgical):
// - Subject gate detects canonical topic inside long sentences
//   (e.g., "Manatees are..." -> adds "manatee" + synonyms).
// - Exclude our own rendered assets by filename (hookmux/final-with-outro/etc).
// - **Used-clip filtering REMOVED** (5D enforces within-job de-dupe).
//
// Env knobs:
//   SS_R2_MIN_SCORE (default: 0)
//   SS_R2_REQUIRE_SUBJECT (default: true)
//   R2_BUCKET or R2_LIBRARY_BUCKET, R2_ENDPOINT, R2_KEY, R2_SECRET
//   R2_LIBRARY_PREFIXES (comma-separated) or R2_LIBRARY_PREFIX
// ===========================================================

'use strict';

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('node:fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

console.log('[10A][INIT] R2 clip helper loaded. [ALLOW][USED] This helper does NOT filter/mutate usedClips; 5D enforces within-job de-dupe.');

// ---- ENV / CLIENT -----------------------------------------------------------
const R2_BUCKET =
  process.env.R2_BUCKET ||
  process.env.R2_LIBRARY_BUCKET; // legacy var supported

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_KEY = process.env.R2_KEY || process.env.R2_ACCESS_KEY_ID;
const R2_SECRET = process.env.R2_SECRET || process.env.R2_SECRET_ACCESS_KEY;

if (!R2_BUCKET || !R2_ENDPOINT || !R2_KEY || !R2_SECRET) {
  // Consider logging to a file or external service in addition to console.error
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
  // Path-based blocks (lowercase)
  '/final/', '/hook/', '/mega/', '/jobs/', '/outro/', '/watermark/', '/temp/', '/thumbnails/', '/videos/'
];

// filename-based blocks (exclude our own renders wherever they live)
const NAME_EXCLUDE_RE = /(hookmux|final-with-outro|socialstorm-final|with-outro|watermark)/i;

// Canonical synonyms (extend as needed)
const CANONICAL_SYNONYMS = {
  manatee: ['manatees', 'sea cow', 'sea cows', 'west indian manatee', 'florida manatee', 'trichechus', 'trichechus manatus']
};

// Subject gating env controls
const R2_MIN_SCORE = Number.isFinite(parseInt(process.env.SS_R2_MIN_SCORE, 10))
  ? parseInt(process.env.SS_R2_MIN_SCORE, 10)
  : 0; // Consider increasing the default if irrelevant clips are being selected
const R2_REQUIRE_SUBJECT = (process.env.SS_R2_REQUIRE_SUBJECT || 'true').toLowerCase() !== 'false';

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
  if (EXCLUDE_FRAGMENTS.some(f => lk.includes(f))) return true;
  const base = path.basename(lk);
  return NAME_EXCLUDE_RE.test(base); // block by name (e.g., hookmux)
}

// --- canonical-aware subject expansion ---
function expandSubject(subject = '') {
  const primary = normalizeToken(subject);
  const set = new Set();

  // If canonical root or its synonyms appear inside the subject sentence,
  // add the root + its synonyms explicitly (ensures "manatee" is present).
  for (const [root, syns] of Object.entries(CANONICAL_SYNONYMS)) {
    const rootHit = primary.includes(root);
    const synHit = syns.some(s => primary.includes(normalizeToken(s)));
    if (rootHit || synHit) {
      set.add(root);
      syns.forEach(v => set.add(normalizeToken(v)));
    }
  }

  // plural/singular variants
  for (const v of Array.from(set)) {
    if (v.endsWith('s')) set.add(v.slice(0, -1));
    else set.add(`${v}s`);
  }

  // Minimal majors from the sentence
  for (const w of majorWords(subject)) set.add(w);

  const result = Array.from(set).filter(Boolean);
  log('SUBJECT', 'EXPAND', `Expansions for "${subject}"`, { expansions: result });
  return result;
}

// Canonical tokens (roots/synonyms only) for strict gating
function canonicalTokensFromSubject(subject = '') {
  const primary = normalizeToken(subject);
  const set = new Set();
  for (const [root, syns] of Object.entries(CANONICAL_SYNONYMS)) {
    const rootHit = primary.includes(root);
    const synHit = syns.some(s => primary.includes(normalizeToken(s)));
    if (rootHit || synHit) {
      set.add(root);
      syns.forEach(v => set.add(normalizeToken(v)));
    }
  }
  // plural/singular variants
  for (const v of Array.from(set)) {
    if (v.endsWith('s')) set.add(v.slice(0, -1));
    else set.add(`${v}s`);
  }
  const canonical = Array.from(set).filter(Boolean);
  log('SUBJECT', 'CANON', `Canonical tokens for "${subject}"`, { canonical });
  return canonical;
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

// Subject presence gate (pre-download)
function subjectPresentInKey(key = '', expansions = []) {
  if (!key || !expansions || !expansions.length) return false;
  const fn = normalizeForMatch(key);
  const toks = tokenizeStem(key);
  return expansions.some(exp => toks.includes(exp) || fn.includes(exp));
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

// ---- CORE -------------------------------------------------------------------
/**
 * Find and download the best R2 clip for a subject.
 * NOTE: This helper does NOT filter or mutate usedClips. 5D enforces within-job de-dupe.
 * @returns {Promise<string|null>} local file path
 */
async function findR2ClipForScene(subject, workDir, sceneIdx = 0, jobId = '', /* usedClips = [] */) {
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
  const canonical = canonicalTokensFromSubject(subject); // strict gate tokens
  const scored = [];

  for (const key of candidates) {
    const score = scoreR2Match(key, subject, expansions);
    scored.push({ key, score });
  }

  if (!scored.length) {
    log('SCORE', 'EMPTY', 'No candidates could be scored');
    return null;
  }

  // Sort/show visibility Top-5
  scored.sort((a, b) => b.score - a.score);
  const top5 = scored.slice(0, 5).map((s, i) => ({ rank: i + 1, key: s.key, score: s.score }));
  log('SCORE', 'TOP5', 'Top candidates', top5);

  // 3b) Subject/min-score gate (pre-download)
  let filtered = scored.filter(s => typeof s.score === 'number' && s.score >= R2_MIN_SCORE);

  if (R2_REQUIRE_SUBJECT) {
    // Use canonical tokens if we detected a canonical subject; otherwise fall back to expansions.
    const gateTokens = (canonical && canonical.length) ? canonical : expansions;
    const pre = filtered.length;
    filtered = gateTokens.length ? filtered.filter(s => subjectPresentInKey(s.key, gateTokens)) : filtered;
    if (!filtered.length) {
      log('FILTER', 'SUBJECT_NONE', `No on-subject R2 keys after gate for "${subject}" (minScore=${R2_MIN_SCORE}, pre=${pre})`);
    }
  }

  if (!filtered.length) {
    log('FILTER', 'NONE', `No acceptable R2 candidates for "${subject}". Handing back to 5D.`);
    return null; // let 5D try providers/KB
  }

  // Prefer highest score among filtered
  filtered.sort((a, b) => b.score - a.score);
  const best = filtered[0];
  if (!best || !best.key) {
    log('SCORE', 'ERR', 'No best candidate after subject/min-score filter');
    return null;
  }

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
