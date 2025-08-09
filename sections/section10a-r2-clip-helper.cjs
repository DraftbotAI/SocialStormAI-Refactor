// =============================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2) — Filename-Strict
// ============================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

console.log('[10A][INIT] Loaded R2 clip helper.');

const R2_BUCKET =
  process.env.R2_BUCKET ||
  process.env.R2_LIBRARY_BUCKET;

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_KEY = process.env.R2_KEY || process.env.R2_ACCESS_KEY_ID;
const R2_SECRET = process.env.R2_SECRET || process.env.R2_SECRET_ACCESS_KEY;

if (!R2_BUCKET || !R2_ENDPOINT || !R2_KEY || !R2_SECRET) {
  throw new Error('[10A][FATAL] Missing R2 env vars!');
}

// Default: root and socialstorm-library/
const RAW_PREFIXES =
  (process.env.R2_LIBRARY_PREFIXES && process.env.R2_LIBRARY_PREFIXES.split(',')) ||
  (process.env.R2_LIBRARY_PREFIX ? [process.env.R2_LIBRARY_PREFIX] : null) ||
  ['', 'socialstorm-library/'];

const R2_PREFIXES = RAW_PREFIXES.map(p => (p || '').trim()).map(p => (p && !p.endsWith('/') ? `${p}/` : p));

const s3Client = new S3Client({
  endpoint: R2_ENDPOINT,
  region: 'auto',
  credentials: { accessKeyId: R2_KEY, secretAccessKey: R2_SECRET },
});

const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.webm'];
const EXCLUDE_FRAGMENTS = [
  '/final/', '/hook/', '/mega/', '/jobs/', '/outro/', '/watermark/', '/temp/', '/thumbnails/', '/videos/'
];

const CANONICAL_SYNONYMS = {
  manatee: ['manatees', 'sea cow', 'sea cows', 'west indian manatee', 'trichechus', 'florida manatee'],
};

function log(section, stage, msg, meta) {
  console.log(`[10A][${section}][${stage}] ${msg}`, meta || '');
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
  return normalizeToken(path.basename(key, path.extname(key)));
}

function buildDupeKey(key) {
  return `${normalizeToken(key)}|${stemName(key)}`;
}

function hasVideoExt(key) {
  return VIDEO_EXTS.includes(path.extname(key || '').toLowerCase());
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

async function listAllUnderPrefix(prefix) {
  let ContinuationToken;
  const all = [];
  let page = 0;
  do {
    page++;
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      ContinuationToken,
      MaxKeys: 1000,
    });
    const res = await s3Client.send(cmd);
    (res.Contents || []).forEach(o => all.push(o.Key));
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    log('LIST', 'PAGE', `Prefix="${prefix}" Page=${page} got ${res.Contents?.length || 0} keys`);
  } while (ContinuationToken);
  return all;
}

async function getAllFiles(prefixOverride) {
  const prefixes = typeof prefixOverride === 'string' ? [prefixOverride] : R2_PREFIXES;
  let agg = [];
  for (const p of prefixes) {
    try {
      agg.push(...(await listAllUnderPrefix(p)));
    } catch (err) {
      log('LIST', 'ERR', `Prefix "${p}" failed`, { error: String(err) });
    }
  }
  return Array.from(new Set(agg));
}

function isValidFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).size >= 2048;
  } catch {
    return false;
  }
}

async function findR2ClipForScene(subject, workDir, sceneIdx = 0, jobId = '', usedClips = []) {
  const section = `SCENE${sceneIdx}`;
  const subjectNorm = normalizeToken(subject);
  const expansions = expandSubject(subjectNorm);
  const used = Array.isArray(usedClips) ? new Set(usedClips.map(String)) : (usedClips || new Set());

  log(section, 'BEGIN', 'R2 search', { subject: subjectNorm, expansions });

  if (!subjectNorm) return null;

  let keys;
  try {
    keys = await getAllFiles();
  } catch (err) {
    log(section, 'ERR', 'List keys failed', { error: String(err) });
    return null;
  }

  const candidates = keys.filter(k => k && !keyLooksExcluded(k) && hasVideoExt(k));
  if (!candidates.length) return null;

  let best = null;
  const seen = new Set();

  for (const key of candidates) {
    const dupeKey = buildDupeKey(key);
    if (seen.has(dupeKey)) continue;
    seen.add(dupeKey);

    const base = path.basename(key);
    if (used.has(dupeKey) || used.has(key) || used.has(base)) continue;

    const stem = stemName(key);
    const tokens = new Set(stem.split(' ').filter(Boolean));

    let filenameBoost = 0;
    for (const exp of expansions) {
      if (tokens.has(exp)) filenameBoost = Math.max(filenameBoost, 20);
      else if (stem.includes(exp)) filenameBoost = Math.max(filenameBoost, 10);
    }

    let baseScore = 0;
    for (const exp of expansions) {
      if (tokens.has(exp)) baseScore += 30;
      else if (stem.includes(exp)) baseScore += 12;
    }

    const lengthPenalty = Math.min(20, Math.floor(stem.length / 10));
    const score = baseScore + filenameBoost - lengthPenalty;

    if (!best || score > best.score) {
      best = { key, score, stem };
    }
  }

  if (!best) return null;

  used.add(buildDupeKey(best.key));
  used.add(best.key);
  used.add(path.basename(best.key));

  const unique = uuidv4();
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2-${unique}${path.extname(best.key).toLowerCase() || '.mp4'}`);

  try {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: best.key }));
    await new Promise((resolve, reject) => {
      const stream = resp.Body;
      const fileStream = fs.createWriteStream(outPath);
      stream.pipe(fileStream);
      stream.on('end', resolve);
      stream.on('error', reject);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    if (!isValidFile(outPath)) return null;

    log(section, 'OK', 'Downloaded', { outPath });
    return outPath;
  } catch (err) {
    log(section, 'ERR', 'Download failed', { error: String(err) });
    return null;
  }
}

findR2ClipForScene.getAllFiles = getAllFiles;

module.exports = { findR2ClipForScene, getAllFiles };
