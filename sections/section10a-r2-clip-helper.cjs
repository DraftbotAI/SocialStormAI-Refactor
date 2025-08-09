// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2)
// Exports:
//   - findR2ClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
//   - getAllFiles(prefixOverride?)  // diagnostics / orchestration
//
// What’s inside:
//   • Scans MULTIPLE prefixes (root + "socialstorm-library/").
//     - Env: R2_LIBRARY_PREFIXES=",,socialstorm-library/"
//       (empty entry means ROOT). Also supports legacy R2_LIBRARY_PREFIX.
//   • Works with either env style:
//       R2_BUCKET (preferred)  OR  legacy R2_LIBRARY_BUCKET
//   • Case-insensitive filename token matching with punctuation cleanup.
//   • Subject expansions (synonyms) — includes MANATEE family.
//   • Video-only filter: .mp4, .mov, .m4v, .webm
//   • Strong filename token BOOST so "manatee" wins.
//   • De-dupe by normalized key + stem; respects usedClips (Set or Array).
//   • MAX LOGGING. No silent fails.
//   • S3 client uses forcePathStyle for Cloudflare R2 compatibility.
// ===========================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

console.log('[10A][INIT] R2 clip helper loaded.');

// ---------- ENV & CLIENT ----------
const R2_BUCKET =
  process.env.R2_BUCKET ||
  process.env.R2_LIBRARY_BUCKET; // legacy compatibility

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_KEY = process.env.R2_KEY || process.env.R2_ACCESS_KEY_ID;
const R2_SECRET = process.env.R2_SECRET || process.env.R2_SECRET_ACCESS_KEY;

if (!R2_BUCKET || !R2_ENDPOINT || !R2_KEY || !R2_SECRET) {
  console.error('[10A][FATAL] Missing one or more R2 env variables! Expect R2_BUCKET|R2_LIBRARY_BUCKET, R2_ENDPOINT, R2_KEY, R2_SECRET.');
  throw new Error('[10A][FATAL] Missing R2 env vars!');
}

// Prefix configuration
// Preferred: comma-separated list. Empty entry "" means ROOT.
const RAW_PREFIXES =
  (process.env.R2_LIBRARY_PREFIXES && process.env.R2_LIBRARY_PREFIXES.split(',')) ||
  (process.env.R2_LIBRARY_PREFIX ? [process.env.R2_LIBRARY_PREFIX] : null) ||
  // Default: scan ROOT and socialstorm-library/
  ['', 'socialstorm-library/'];

const R2_PREFIXES = RAW_PREFIXES
  .map(p => (p || '').trim())
  .map(p => (p && !p.endsWith('/') ? `${p}/` : p)); // normalize to always end with "/" unless root

const s3Client = new S3Client({
  endpoint: R2_ENDPOINT,
  region: 'auto',
  forcePathStyle: true, // important for Cloudflare R2
  credentials: { accessKeyId: R2_KEY, secretAccessKey: R2_SECRET },
});

// ---------- CONSTANTS ----------
const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.webm'];
const EXCLUDE_FRAGMENTS = [
  '/final/', '/hook/', '/mega/', '/jobs/', '/outro/', '/watermark/', '/temp/', '/thumbnails/', '/videos/'
];

// Canonical subject expansions (add more as needed)
const CANONICAL_SYNONYMS = {
  manatee: ['manatees', 'sea cow', 'sea cows', 'west indian manatee', 'trichechus', 'florida manatee'],
};

// ---------- UTILS ----------
function log(section, stage, msg, meta = undefined) {
  const base = `[10A][${section}][${stage}] ${msg}`;
  if (meta !== undefined) console.log(base, meta);
  else console.log(base);
}

function cleanForFilename(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function normalizeToken(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, ' ')
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

function stemName(key) {
  const base = path.basename(key, path.extname(key));
  return normalizeToken(base);
}

function buildDupeKey(key) {
  return `${normalizeToken(key)}|${stemName(key)}`;
}

function hasVideoExt(key = '') {
  return VIDEO_EXTS.includes(path.extname(key).toLowerCase());
}

function keyLooksExcluded(key = '') {
  const lk = key.toLowerCase();
  return EXCLUDE_FRAGMENTS.some(f => lk.includes(f));
}

function expandSubject(subject = '') {
  const primary = normalizeToken(subject);
  const expansions = new Set([primary]);
  const syns = CANONICAL_SYNONYMS[primary];
  if (syns) syns.forEach(s => expansions.add(normalizeToken(s)));
  if (primary.endsWith('s')) expansions.add(primary.slice(0, -1));
  else expansions.add(`${primary}s`);
  return Array.from(expansions).filter(Boolean);
}

// ---------- MATCH HELPERS ----------
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
  return words.length && words.every(word => fn.includes(word));
}

function partialMatch(filename, subject) {
  if (!filename || !subject) return false;
  const fn = normalizeForMatch(filename);
  const words = majorWords(subject);
  return words.some(word => fn.includes(word));
}

function scoreR2Match(filename, subject, expansions = []) {
  if (!filename || !subject) return -99999;

  const fn = normalizeForMatch(filename);
  const subj = normalizeForMatch(subject);
  const tokens = new Set(tokenizeStem(filename));
  let score = 0;

  // Strong token hits from expansions (e.g., "manatee" / "sea cow")
  for (const exp of expansions) {
    if (!exp) continue;
    if (tokens.has(exp)) score += 35;         // exact token
    else if (fn.includes(exp)) score += 15;   // substring
  }

  if (strictSubjectMatch(filename, subject)) score += 100;
  if (fuzzyMatch(filename, subject)) score += 35;
  if (partialMatch(filename, subject)) score += 15;

  if (subj && fn.includes(subj)) score += 12; // phrase bonus

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

// ---------- LISTING ----------
async function listAllUnderPrefix(prefix = '', jobId = '') {
  const keys = [];
  let ContinuationToken;
  let round = 0;

  do {
    round++;
    log('LIST', 'REQUEST', `Bucket=${R2_BUCKET} Prefix="${prefix}" Round=${round} CT=${ContinuationToken || '∅'}`);
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      ContinuationToken,
      MaxKeys: 1000,
    });

    const res = await s3Client.send(cmd);
    const contents = res.Contents || [];
    contents.forEach(o => o?.Key && keys.push(o.Key));
    log('LIST', 'PAGE_OK', `Got ${contents.length} keys this page.`);

    if (res.IsTruncated && res.NextContinuationToken) {
      ContinuationToken = res.NextContinuationToken;
    } else {
      ContinuationToken = undefined;
    }
  } while (ContinuationToken);

  log('LIST', 'DONE', `Total keys under "${prefix}": ${keys.length}`);
  return keys;
}

async function getAllFiles(prefixOverride = null, jobId = 'STATIC') {
  const prefixes = typeof prefixOverride === 'string' ? [prefixOverride] : R2_PREFIXES;
  log('LIST', 'START', `Scanning ${prefixes.length} prefix(es)`, { prefixes });

  const agg = [];
  for (const p of prefixes) {
    try {
      const keys = await listAllUnderPrefix(p, jobId);
      agg.push(...keys);
    } catch (err) {
      log('LIST', 'ERR', `Prefix "${p}" failed to list`, { error: String(err && err.message || err) });
    }
  }
  // unique
  const uniq = Array.from(new Set(agg));
  log('LIST', 'AGG', `Aggregated unique keys: ${uniq.length}`);
  return uniq;
}

// ---------- FILE IO ----------
function isValidFile(p) {
  try {
    if (!fs.existsSync(p)) return false;
    const size = fs.statSync(p).size;
    return size >= 2048;
  } catch {
    return false;
  }
}

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

// ---------- usedClips helpers (Array or Set) ----------
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
  const dk = buildDupeKey(key);
  return usedHas(usedClips, key) || usedHas(usedClips, base) || usedHas(usedClips, dk);
}

// ---------- CORE ----------
/**
 * @param {string} subject
 * @param {string} workDir
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {Set<string>|string[]} usedClips  // keys or basenames already used
 * @returns {Promise<string|null>}          // local path to downloaded clip
 */
async function findR2ClipForScene(subject, workDir, sceneIdx = 0, jobId = '', usedClips = []) {
  const section = `SCENE${sceneIdx}`;
  const subjectNorm = normalizeToken(subject);
  const expansions = expandSubject(subjectNorm);

  log(section, 'BEGIN', `R2 search`, { subject: subjectNorm, expansions, jobId, prefixes: R2_PREFIXES });

  if (!subjectNorm) {
    log(section, 'ERR', 'Empty subject provided.');
    return null;
  }

  let keys;
  try {
    keys = await getAllFiles(null, jobId);
  } catch (err) {
    log(section, 'ERR_LIST', 'Failed to list keys', { error: String(err && err.message || err) });
    return null;
  }

  // Filter library candidates
  const candidates = keys.filter(k => {
    if (!k) return false;
    if (keyLooksExcluded(k)) return false;
    if (!hasVideoExt(k)) return false;
    return true;
  });

  if (!candidates.length) {
    log(section, 'NO_CANDIDATES', 'No video keys in R2 after filtering.');
    return null;
  }

  // Score candidates (filename token boost)
  const scored = [];
  for (const key of candidates) {
    if (alreadyUsed(usedClips, key)) {
      log(section, 'SKIP_USED', 'Key already used in this job', { key });
      continue;
    }
    const score = scoreR2Match(key, subjectNorm, expansions);
    scored.push({ key, score });
  }

  if (!scored.length) {
    log(section, 'NO_MATCH', `No acceptable match for "${subjectNorm}" after used-filter.`);
    return null;
  }

  scored.sort((a, b) => (b.score - a.score));

  // Log Top-5 for visibility
  const top5 = scored.slice(0, 5).map((s, i) => ({ rank: i + 1, key: s.key, score: s.score }));
  log(section, 'SCORE_TOP5', 'Top candidates', top5);

  const best = scored[0];

  // mark as used for caller (by multiple forms)
  const chosenDupeKey = buildDupeKey(best.key);
  usedAdd(usedClips, chosenDupeKey);
  usedAdd(usedClips, best.key);
  usedAdd(usedClips, path.basename(best.key));

  log(section, 'SELECT', 'Chosen R2 key', { key: best.key, score: best.score });

  // Download to workDir with unique name (parallel-safe)
  const unique = uuidv4();
  const outExt = path.extname(best.key).toLowerCase() || '.mp4';
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2-${unique}${outExt}`);

  try {
    const getCmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: best.key });
    const resp = await s3Client.send(getCmd);

    await new Promise((resolve, reject) => {
      const stream = resp.Body;
      const fileStream = fs.createWriteStream(outPath);
      stream.pipe(fileStream);
      let resolved = false;
      const done = (err) => { if (!resolved) { resolved = true; err ? reject(err) : resolve(); } };
      stream.on('end', () => done());
      stream.on('error', (e) => { log(section, 'ERR_DOWNLOAD', 'Stream error', { error: String(e) }); done(e); });
      fileStream.on('finish', () => done());
      fileStream.on('error', (e) => { log(section, 'ERR_DOWNLOAD', 'Write error', { error: String(e) }); done(e); });
    });

    if (!isValidFile(outPath)) {
      log(section, 'ERR_FILE', 'Downloaded file invalid/small', { outPath });
      return null;
    }

    log(section, 'OK', 'Downloaded R2 clip', { outPath });
    return outPath;
  } catch (err) {
    log(section, 'ERR_DOWNLOAD', 'Failed to download selected key', { error: String(err && err.message || err), key: best.key });
    return null;
  }
}

// ---------- STATIC export for scans ----------
async function _getAllFilesStatic(prefixOverride) {
  try {
    const keys = await getAllFiles(prefixOverride, 'STATIC');
    const vids = keys.filter(k => hasVideoExt(k));
    log('STATIC', 'SUMMARY', `Video keys`, { count: vids.length });
    return vids;
  } catch (err) {
    log('STATIC', 'ERR', 'getAllFiles failed', { error: String(err && err.message || err) });
    return [];
  }
}

// Keep compatibility: findR2ClipForScene.getAllFiles for callers like 5D
findR2ClipForScene.getAllFiles = _getAllFilesStatic;

module.exports = {
  findR2ClipForScene,
  getAllFiles
};
