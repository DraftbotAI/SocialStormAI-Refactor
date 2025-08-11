// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2) — CONNECTIVITY FIX + MULTI-PULL
// Exports:
//   - findR2ClipForScene(subject, workDir, sceneIdx?, jobId?, usedClips?)
//   - findTopNR2ClipsForSubject(subject, workDir, opts)
//   - findR2ClipForScene.getAllFiles()
// GOAL: List + download from R2 reliably. Added top-N parallel downloader.
// Single-file edit only.
//
// Env it honors:
//   R2_LIBRARY_BUCKET (e.g., "socialstorm-library")
//   R2_ENDPOINT (optional; if missing, we try R2_ACCOUNT_ID)
//   R2_ACCOUNT_ID (used to build endpoint if R2_ENDPOINT missing)
//   R2_KEY or R2_ACCESS_KEY_ID
//   R2_SECRET or R2_SECRET_ACCESS_KEY
// ===========================================================

const {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

console.log('[10A][INIT] R2 clip helper loaded.');

// ---------- ENV + ENDPOINT HANDLING ----------
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_ENDPOINT_ENV = process.env.R2_ENDPOINT || '';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_KEY = process.env.R2_KEY || process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET = process.env.R2_SECRET || process.env.R2_SECRET_ACCESS_KEY || '';

function buildEndpoint() {
  if (R2_ENDPOINT_ENV) return R2_ENDPOINT_ENV.trim();
  if (R2_ACCOUNT_ID) {
    // Standard R2 S3-compatible endpoint
    return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }
  return '';
}

const R2_ENDPOINT = buildEndpoint();

if (!R2_LIBRARY_BUCKET || !R2_ENDPOINT || !R2_KEY || !R2_SECRET) {
  console.error('[10A][FATAL] Missing one or more R2 env variables.', {
    R2_LIBRARY_BUCKET: !!R2_LIBRARY_BUCKET,
    R2_ENDPOINT_present: !!R2_ENDPOINT,
    R2_KEY_present: !!R2_KEY,
    R2_SECRET_present: !!R2_SECRET,
    hint: 'Need R2_LIBRARY_BUCKET + (R2_ENDPOINT or R2_ACCOUNT_ID) + R2_KEY + R2_SECRET',
  });
  throw new Error('[10A][FATAL] Missing R2 env vars!');
}

const s3Client = new S3Client({
  endpoint: R2_ENDPOINT,
  region: 'auto',
  forcePathStyle: true, // Important for R2
  credentials: {
    accessKeyId: R2_KEY,
    secretAccessKey: R2_SECRET,
  },
});

// ---------- Helpers ----------
function cleanForFilename(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function majorWords(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 2 &&
        !['the', 'of', 'and', 'in', 'on', 'with', 'to', 'is', 'for', 'at', 'by', 'as', 'a', 'an'].includes(w)
    );
}

function fuzzyMatch(filename, subject) {
  if (!filename || !subject) return false;
  const fn = normalizeForMatch(filename);
  const words = majorWords(subject);
  return words.length && words.every((word) => fn.includes(word));
}
function partialMatch(filename, subject) {
  if (!filename || !subject) return false;
  const fn = normalizeForMatch(filename);
  const words = majorWords(subject);
  return words.some((word) => fn.includes(word));
}
function strictSubjectMatch(filename, subject) {
  if (!filename || !subject) return false;
  const safeSubject = cleanForFilename(subject);
  const re = new RegExp(`(^|_|-)${safeSubject}(_|-|\\.|$)`, 'i');
  return re.test(cleanForFilename(filename));
}

function scoreR2Match(filename, subject) {
  if (!filename || !subject) return -99999;
  let score = 0;
  const fn = normalizeForMatch(filename);
  const subj = normalizeForMatch(subject);

  if (strictSubjectMatch(filename, subject)) score += 100; // strict
  if (fuzzyMatch(filename, subject)) score += 35; // fuzzy
  if (partialMatch(filename, subject)) score += 15; // partial
  if (fn.includes(subj) && subj.length > 2) score += 12; // phrase
  majorWords(subject).forEach((w) => {
    if (fn.includes(w)) score += 5;
  });
  if (/_portrait\.(mp4|mov)$/.test(filename) || fn.includes('9 16') || fn.includes('shorts') || fn.includes('tiktok')) {
    score += 8;
  }
  const nums = filename.match(/\d+/g) || [];
  nums.forEach((n) => {
    if (Number(n) > 2020) score += 2;
  });

  // prefer shorter basenames
  const base = path.basename(fn);
  score -= base.length;

  return score;
}

function isValidClip(filePath, jobId) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[10A][R2][${jobId}] File does not exist: ${filePath}`);
      return false;
    }
    const size = fs.statSync(filePath).size;
    if (size < 2048) {
      console.warn(
        `[10A][R2][${jobId}] File too small or broken: ${filePath} (${size} bytes)`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[10A][R2][${jobId}] File validation error:`, err);
    return false;
  }
}

// ---------- R2 LISTING ----------
async function listAllFilesInR2(prefix = '', jobId = '') {
  let files = [];
  let continuationToken = undefined;
  let round = 0;

  try {
    do {
      round++;
      console.log(
        `[10A][R2][${jobId}] Listing R2 files (round ${round}) prefix="${prefix}" token=${!!continuationToken}`
      );

      const cmd = new ListObjectsV2Command({
        Bucket: R2_LIBRARY_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const resp = await s3Client.send(cmd);

      if (resp && Array.isArray(resp.Contents)) {
        for (const obj of resp.Contents) {
          if (!obj || !obj.Key) continue;
          files.push(obj.Key);
        }
      }

      continuationToken = resp && resp.NextContinuationToken ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    console.log(`[10A][R2][${jobId}] Listed ${files.length} files from R2.`);
    return files;
  } catch (err) {
    console.error(`[10A][R2][${jobId}][ERR] List error:`, {
      message: err?.message,
      name: err?.name,
      code: err?.$metadata?.httpStatusCode,
    });
    return [];
  }
}

// ---------- Optional connectivity probe (runs once per process) ----------
let probed = false;
async function probeOnce() {
  if (probed) return;
  probed = true;
  try {
    const sample = await listAllFilesInR2('', 'PROBE');
    const head = sample.slice(0, 5);
    console.log(
      `[10A][R2][PROBE] Endpoint OK="${R2_ENDPOINT}". Bucket="${R2_LIBRARY_BUCKET}". First keys:`,
      head
    );
  } catch (e) {
    console.error('[10A][R2][PROBE][ERR] Could not list from R2:', e?.message || e);
  }
}
probeOnce();

// ---------- Internal: filter eligible keys ----------
const EXCLUDED_PREFIXES = [
  'jobs/',
  'final/',
  'videos/',
  'outro/',
  'hook/',
  'mega/',
  'thumb/',
  'thumbnails/',
  'tmp/',
  'cache/',
];
function isEligibleR2Key(key, usedClips = []) {
  if (!key) return false;
  const lower = String(key).toLowerCase();
  const ext = path.extname(lower);
  if (!['.mp4', '.mov'].includes(ext)) return false;
  if (EXCLUDED_PREFIXES.some((p) => lower.startsWith(p))) return false;

  const base = path.basename(lower);
  const stem = base.replace(/\.[a-z0-9]+$/, '');
  const usedHit = (usedClips || []).some((u) => {
    const uLower = String(u || '').toLowerCase();
    const uBase = path.basename(uLower);
    const uStem = uBase.replace(/\.[a-z0-9]+$/, '');
    return uLower === lower || uBase === base || uStem === stem;
  });
  if (usedHit) return false;

  return true;
}

// ---------- Internal: download a single R2 key ----------
async function downloadR2KeyTo(workDir, key, jobId) {
  const ext = (path.extname(key).toLowerCase() || '.mp4');
  const outPath = path.join(workDir, `r2-${uuidv4()}${ext}`);
  console.log(`[10A][R2][${jobId}] Downloading key -> ${key} -> ${outPath}`);

  const getCmd = new GetObjectCommand({ Bucket: R2_LIBRARY_BUCKET, Key: key });
  const resp = await s3Client.send(getCmd);

  await new Promise((resolve, reject) => {
    const stream = resp.Body;
    const fileStream = fs.createWriteStream(outPath);
    stream.pipe(fileStream);
    stream.on('end', resolve);
    stream.on('error', (err) => {
      console.error(`[10A][R2][${jobId}][ERR] Stream error during download:`, err);
      reject(err);
    });
    fileStream.on('finish', () => {
      console.log(`[10A][R2][${jobId}] Downloaded: ${outPath}`);
      resolve();
    });
    fileStream.on('error', (err) => {
      console.error(`[10A][R2][${jobId}][ERR] Write error during download:`, err);
      reject(err);
    });
  });

  if (!isValidClip(outPath, jobId)) {
    console.warn(`[10A][R2][${jobId}] Downloaded file invalid: ${outPath}`);
    return null;
  }
  return outPath;
}

// ---------- MAIN: Find + Download best single clip ----------
/**
 * Finds the *best-scoring* video in R2 for the subject.
 * Returns a local path to the downloaded file, or null if none.
 *
 * @param {string} subject
 * @param {string} workDir
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {string[]} usedClips - array of keys or basenames already used
 * @returns {Promise<string|null>}
 */
async function findR2ClipForScene(subject, workDir, sceneIdx = 0, jobId = '', usedClips = []) {
  console.log(
    `[10A][R2][${jobId}] findR2ClipForScene | subject="${subject}" | sceneIdx=${sceneIdx} | workDir="${workDir}" | usedClips=${JSON.stringify(
      usedClips
    )}`
  );

  if (!subject || typeof subject !== 'string') {
    console.error(`[10A][R2][${jobId}] No valid subject passed!`);
    return null;
  }

  try {
    const allKeys = await listAllFilesInR2('', jobId);
    if (!allKeys.length) {
      console.warn(`[10A][R2][${jobId}][WARN] No files found in R2 bucket!`);
      return null;
    }

    const eligible = allKeys.filter((k) => isEligibleR2Key(k, usedClips));
    if (!eligible.length) {
      console.warn(`[10A][R2][${jobId}] No eligible video files found in R2 after filtering.`);
      return null;
    }

    // Score all candidates
    const scored = eligible.map((k) => ({
      key: k,
      base: path.basename(k),
      score: scoreR2Match(path.basename(k), subject),
    }));

    // Sort by score desc and log top candidates
    scored.sort((a, b) => b.score - a.score);
    scored.slice(0, 10).forEach((s, i) =>
      console.log(`[10A][R2][${jobId}][CANDIDATE][${i + 1}] ${s.key} | score=${s.score}`)
    );

    const best = scored[0];
    if (!best) {
      console.warn(`[10A][R2][${jobId}] No candidates after scoring for subject "${subject}".`);
      return null;
    }

    if (best.score >= 100) {
      console.log(`[10A][R2][${jobId}][SELECTED][STRICT] ${best.key} | score=${best.score}`);
    } else if (best.score >= 35) {
      console.log(`[10A][R2][${jobId}][SELECTED][FUZZY] ${best.key} | score=${best.score}`);
    } else if (best.score >= 1) {
      console.log(`[10A][R2][${jobId}][SELECTED][PARTIAL] ${best.key} | score=${best.score}`);
    } else {
      console.warn(
        `[10A][R2][${jobId}][FALLBACK][LAST_RESORT] No strong match, using best available: ${best.key} | score=${best.score}`
      );
    }

    // Download to unique path
    const outPath = await downloadR2KeyTo(workDir, best.key, jobId);
    return outPath;
  } catch (err) {
    console.error(`[10A][R2][${jobId}][ERR] findR2ClipForScene failed:`, {
      message: err?.message,
      name: err?.name,
      code: err?.$metadata?.httpStatusCode,
    });
    return null;
  }
}

// ---------- NEW: Find + Download Top-N clips in parallel ----------
/**
 * Find the top N R2 clips for a subject, score by filename, then download in parallel (capped).
 * Returns [{ key, path, score }] for successful downloads (ordered by score desc).
 *
 * @param {string} subject
 * @param {string} workDir
 * @param {Object} opts
 * @param {number} opts.N - how many to attempt (default 5)
 * @param {string[]} opts.usedClips - keys/basenames already used (default [])
 * @param {string} opts.jobId - job id for logging (default '')
 * @param {number} opts.minScore - minimum score threshold (default -999)
 * @param {number} opts.maxConcurrency - parallel download cap (default 3)
 */
async function findTopNR2ClipsForSubject(
  subject,
  workDir,
  {
    N = 5,
    usedClips = [],
    jobId = '',
    minScore = -999,
    maxConcurrency = 3,
  } = {}
) {
  console.log(`[10A][POOL][${jobId}] findTopNR2ClipsForSubject | subject="${subject}" N=${N} minScore=${minScore} maxConc=${maxConcurrency}`);

  if (!subject || typeof subject !== 'string') {
    console.error(`[10A][POOL][${jobId}] Invalid subject`);
    return [];
  }

  try {
    const allKeys = await listAllFilesInR2('', jobId);
    if (!allKeys.length) {
      console.warn(`[10A][POOL][${jobId}] No files in R2.`);
      return [];
    }

    const eligible = allKeys.filter((k) => isEligibleR2Key(k, usedClips));
    if (!eligible.length) {
      console.warn(`[10A][POOL][${jobId}] No eligible files after filtering.`);
      return [];
    }

    const scored = eligible.map((k) => ({
      key: k,
      base: path.basename(k),
      score: scoreR2Match(path.basename(k), subject),
    }));

    scored.sort((a, b) => b.score - a.score);

    // Log a table of top 12
    scored.slice(0, 12).forEach((s, i) =>
      console.log(`[10A][POOL][${jobId}][CANDIDATE][${i + 1}] ${s.key} | score=${s.score}`)
    );

    const selected = scored.filter(s => s.score >= minScore).slice(0, N);
    if (!selected.length) {
      console.warn(`[10A][POOL][${jobId}] No candidates met minScore=${minScore}.`);
      return [];
    }

    console.log(`[10A][POOL][${jobId}] Selected top ${selected.length} for download.`);

    // Concurrency-limited downloads (batching)
    const results = [];
    for (let i = 0; i < selected.length; i += Math.max(1, maxConcurrency)) {
      const batch = selected.slice(i, i + Math.max(1, maxConcurrency));
      console.log(`[10A][POOL][${jobId}] Download batch ${i + 1}..${i + batch.length} of ${selected.length}`);
      const settled = await Promise.allSettled(
        batch.map(async (item) => {
          const localPath = await downloadR2KeyTo(workDir, item.key, jobId);
          if (localPath) {
            return { key: item.key, path: localPath, score: item.score };
          }
          return null;
        })
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value && s.value.path) {
          results.push(s.value);
        } else if (s.status === 'rejected') {
          console.error(`[10A][POOL][${jobId}][ERR] Batch item failed:`, s.reason);
        }
      }
    }

    // Keep results ordered by score desc
    results.sort((a, b) => b.score - a.score);
    console.log(`[10A][POOL][${jobId}] Downloaded ${results.length}/${selected.length} successfully.`);
    return results;
  } catch (err) {
    console.error(`[10A][POOL][${jobId}][ERR]`, err);
    return [];
  }
}

// === Static export for advanced dedupe (used by 5D) ===
findR2ClipForScene.getAllFiles = async function () {
  try {
    const files = await listAllFilesInR2('', 'STATIC');
    const vids = files.filter((f) => /\.(mp4|mov)$/i.test(f));
    console.log(`[10A][STATIC] getAllFiles: Found ${vids.length} video files in R2.`);
    return vids;
  } catch (err) {
    console.error('[10A][STATIC][ERR] getAllFiles failed:', err);
    return [];
  }
};

module.exports = { findR2ClipForScene, findTopNR2ClipsForSubject };
