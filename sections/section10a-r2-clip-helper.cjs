// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2) — 2025-08-09
// Exports:
//   - findR2ClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
//   - getAllFiles(prefixOverride?)  // for diagnostics / orchestration
//
// What’s fixed/added:
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
//
// Notes:
//   - This module downloads the selected key to workDir with a unique name.
//   - If you want signed-URL streaming instead of download, say the word.
// ===========================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ---------- ENV & CLIENT ----------
console.log('[10A][INIT] R2 clip helper loaded.');

const R2_BUCKET =
  process.env.R2_BUCKET ||
  process.env.R2_LIBRARY_BUCKET; // legacy compatibility

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_KEY = process.env.R2_KEY || process.env.R2_ACCESS_KEY_ID;
const R2_SECRET = process.env.R2_SECRET || process.env.R2_SECRET_ACCESS_KEY;

if (!R2_BUCKET || !R2_ENDPOINT || !R2_KEY || !R2_SECRET) {
  console.error('[10A][FATAL] Missing one or more R2 env variables! Expect R2_BUCKET, R2_ENDPOINT, R2_KEY, R2_SECRET.');
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
  if (meta) console.log(base, meta);
  else console.log(base);
}

function normalizeToken(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemName(key) {
  const base = path.basename(key, path.extname(key));
  return normalizeToken(base);
}

function buildDupeKey(key) {
  return `${normalizeToken(key)}|${stemName(key)}`;
}

function hasVideoExt(key) {
  const ext = path.extname(key || '').toLowerCase();
  return VIDEO_EXTS.includes(ext);
}

function keyLooksExcluded(key) {
  const lk = (key || '').toLowerCase();
  return EXCLUDE_FRAGMENTS.some(f => lk.includes(f));
}

function expandSubject(subject) {
  const primary = normalizeToken(subject);
  const expansions = new Set([primary]);
  const syns = CANONICAL_SYNONYMS[primary];
  if (syns) syns.forEach(s => expansions.add(normalizeToken(s)));
  if (primary.endsWith('s')) expansions.add(primary.slice(0, -1));
  else expansions.add(`${primary}s`);
  return Array.from(expansions).filter(Boolean);
}

// ---------- LISTING ----------
async function listAllUnderPrefix(prefix, jobId) {
  let ContinuationToken = undefined;
  const all = [];
  let page = 0;

  while (true) {
    page++;
    log('LIST', 'REQUEST', `Bucket=${R2_BUCKET} Prefix="${prefix}" Page=${page} CT=${ContinuationToken || '∅'}`);
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      ContinuationToken,
      MaxKeys: 1000,
    });

    const res = await s3Client.send(cmd);
    const contents = res.Contents || [];
    contents.forEach(o => all.push(o.Key));
    log('LIST', 'PAGE_OK', `Got ${contents.length} keys this page.`);

    if (res.IsTruncated && res.NextContinuationToken) {
      ContinuationToken = res.NextContinuationToken;
    } else {
      break;
    }
  }

  log('LIST', 'DONE', `Total keys under "${prefix}": ${all.length}`);
  return all;
}

async function getAllFiles(prefixOverride, jobId = 'STATIC') {
  // If a single override is provided, only scan that; else scan configured list
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
  const used = Array.isArray(usedClips) ? new Set(usedClips.map(String)) : (usedClips || new Set());

  log(section, 'BEGIN', `R2 search`, { subject: subjectNorm, expansions, jobId, prefixes: R2_PREFIXES });

  if (!subjectNorm) {
    log(section, 'ERR', 'Empty subject provided.');
    return null;
  }

  let keys;
  try {
    keys = await getAllFiles(undefined, jobId);
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
  let best = null;
  const seen = new Set();

  for (const key of candidates) {
    const dupeKey = buildDupeKey(key);
    if (seen.has(dupeKey)) continue;
    seen.add(dupeKey);

    // respect job-level de-dupe
    const base = path.basename(key);
    if (used.has(dupeKey) || used.has(key) || used.has(base)) {
      log(section, 'SKIP_USED', 'Key already used in this job', { key });
      continue;
    }

    const stem = stemName(key); // normalized file stem
    const tokens = new Set(stem.split(' ').filter(Boolean));

    // filename/expansion boost
    let filenameBoost = 0;
    for (const exp of expansions) {
      if (tokens.has(exp)) filenameBoost = Math.max(filenameBoost, 20); // exact token
      else if (stem.includes(exp)) filenameBoost = Math.max(filenameBoost, 10); // substring
    }

    // base score: count of expansion hits in stem (simple but effective)
    let baseScore = 0;
    for (const exp of expansions) {
      if (tokens.has(exp)) baseScore += 30;
      else if (stem.includes(exp)) baseScore += 12;
    }

    // prefer shorter stems a bit (tighter match)
    const lengthPenalty = Math.min(20, Math.floor(stem.length / 10));

    const score = baseScore + filenameBoost - lengthPenalty;

    log(section, 'SCORE', 'Candidate', { key, stem, baseScore, filenameBoost, lengthPenalty, score });

    if (!best || score > best.score) {
      best = { key, score, stem };
    }
  }

  if (!best) {
    log(section, 'NO_MATCH', `No acceptable match for "${subjectNorm}".`);
    return null;
  }

  // mark as used for caller (by multiple forms)
  const chosenDupeKey = buildDupeKey(best.key);
  used.add(chosenDupeKey);
  used.add(best.key);
  used.add(path.basename(best.key));

  log(section, 'SELECT', 'Chosen R2 key', { key: best.key, score: best.score });

  // Download to workDir with unique name (parallel-safe)
  const unique = uuidv4();
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2-${unique}${path.extname(best.key).toLowerCase() || '.mp4'}`);

  try {
    const getCmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: best.key });
    const resp = await s3Client.send(getCmd);

    await new Promise((resolve, reject) => {
      const stream = resp.Body;
      const fileStream = fs.createWriteStream(outPath);
      stream.pipe(fileStream);
      stream.on('end', resolve);
      stream.on('error', reject);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
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

// Static export (diagnostics)
findR2ClipForScene.getAllFiles = async function(prefixOverride) {
  try {
    const keys = await getAllFiles(prefixOverride, 'STATIC');
    const mp4s = keys.filter(k => hasVideoExt(k));
    log('STATIC', 'SUMMARY', `getAllFiles: ${mp4s.length} video keys`);
    return mp4s;
  } catch (err) {
    log('STATIC', 'ERR', 'getAllFiles failed', { error: String(err && err.message || err) });
    return [];
  }
};

module.exports = { findR2ClipForScene, getAllFiles };
