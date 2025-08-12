// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2)
// Exports: findR2ClipForScene (used by 5D) + getAllFiles (for parallel dedupe/scan)
// MAX LOGGING EVERY STEP, Modular System Compatible
// Parallel safe: no temp file collisions, NO silent fails
// 2024-08: Fuzzy/partial/strict scoring, normalized folders/files, pro matching
// ===========================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

console.log('[10A][INIT] R2 clip helper loaded.');

const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_KEY = process.env.R2_KEY || process.env.R2_ACCESS_KEY_ID;
const R2_SECRET = process.env.R2_SECRET || process.env.R2_SECRET_ACCESS_KEY;

if (!R2_LIBRARY_BUCKET || !R2_ENDPOINT || !R2_KEY || !R2_SECRET) {
  console.error('[10A][FATAL] Missing one or more R2 env variables!');
  throw new Error('[10A][FATAL] Missing R2 env vars!');
}

const s3Client = new S3Client({
  endpoint: R2_ENDPOINT,
  region: 'auto',
  credentials: {
    accessKeyId: R2_KEY,
    secretAccessKey: R2_SECRET,
  }
});

// --- Normalization helpers ---
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

// NEW: normalized “stem” for dedupe (basename, no extension, separators→spaces)
function stemFromKey(key) {
  const base = (key || '').split('/').pop() || '';
  const noExt = base.replace(/\.[a-z0-9]+$/i, '');
  const stem = normalizeForMatch(noExt);
  return stem;
}

// --- Main: List all files in R2 (with full path relative to bucket root) ---
async function listAllFilesInR2(prefix = '', jobId = '') {
  let files = [];
  let continuationToken;
  let round = 0;
  try {
    do {
      round++;
      console.log(`[10A][R2][${jobId}] Listing R2 files, round ${round}...`);
      const cmd = new ListObjectsV2Command({
        Bucket: R2_LIBRARY_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const resp = await s3Client.send(cmd);
      if (resp && resp.Contents) {
        files.push(...resp.Contents.map(obj => obj.Key));
      }
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);
    console.log(`[10A][R2][${jobId}] Listed ${files.length} files from R2.`);
    return files;
  } catch (err) {
    console.error(`[10A][R2][${jobId}][ERR] List error:`, err);
    return [];
  }
}

// --- Major words extraction ---
function majorWords(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
}

// --- Scoring function for filename match ---
function scoreR2Match(filename, subject) {
  if (!filename || !subject) return -99999;
  let score = 0;

  // UPDATED: normalize using basename without extension; separators→spaces
  const base = (filename || '').split('/').pop() || '';
  const noExt = base.replace(/\.[a-z0-9]+$/i, '');
  const fn = normalizeForMatch(noExt);
  const subj = normalizeForMatch(subject);

  // 1. Strict match: subject as full word in filename (bonus)
  if (strictSubjectMatch(filename, subject)) score += 100;
  // 2. Fuzzy match: all major words somewhere in filename
  if (fuzzyMatch(filename, subject)) score += 35;
  // 3. Partial match: any major word in filename
  if (partialMatch(filename, subject)) score += 15;
  // 4. Exact phrase somewhere in filename (bonus)
  if (fn.includes(subj) && subj.length > 2) score += 12;
  // 5. Each major word that appears, +5
  majorWords(subject).forEach(word => {
    if (fn.includes(word)) score += 5;
  });
  // 6. Prefer portrait (ends in _portrait.mp4 or has 9_16, tiktok, shorts)
  if (/_portrait\.mp4$/i.test(base) || fn.includes('9 16') || fn.includes('shorts') || fn.includes('tiktok')) score += 8;
  // 7. Prefer recent (higher-numbered files)
  const nums = base.match(/\d+/g) || [];
  nums.forEach(n => { if (Number(n) > 2020) score += 2; });
  // 8. Prefer shorter filenames (tighter match)
  score -= fn.length;

  return score;
}

// --- Fuzzy/partial/strict match helpers ---
function fuzzyMatch(filename, subject) {
  if (!filename || !subject) return false;
  const base = (filename || '').split('/').pop() || '';
  const noExt = base.replace(/\.[a-z0-9]+$/i, '');
  const fn = normalizeForMatch(noExt);
  const words = majorWords(subject);
  return words.length && words.every(word => fn.includes(word));
}
function partialMatch(filename, subject) {
  if (!filename || !subject) return false;
  const base = (filename || '').split('/').pop() || '';
  const noExt = base.replace(/\.[a-z0-9]+$/i, '');
  const fn = normalizeForMatch(noExt);
  const words = majorWords(subject);
  return words.some(word => fn.includes(word));
}
function strictSubjectMatch(filename, subject) {
  if (!filename || !subject) return false;
  const safeSubject = cleanForFilename(subject);
  const re = new RegExp(`(^|_|-)${safeSubject}(_|-|\\.|$)`, 'i');
  return re.test(cleanForFilename(filename));
}

// --- FILE VALIDATOR: Ensures file exists and is >2kb (not broken)
function isValidClip(filePath, jobId) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[10A][R2][${jobId}] File does not exist: ${filePath}`);
      return false;
    }
    const size = fs.statSync(filePath).size;
    if (size < 2048) {
      console.warn(`[10A][R2][${jobId}] File too small or broken: ${filePath} (${size} bytes)`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[10A][R2][${jobId}] File validation error:`, err);
    return false;
  }
}

// NEW: Dedupe by normalized stem, prefer .mp4 (logs: NORM/DEDUP/PREF)
function dedupeByStemPreferMp4(files, jobId = '') {
  const groups = new Map();
  for (const f of files) {
    const stem = stemFromKey(f);
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(f);
  }
  const chosen = [];
  for (const [stem, arr] of groups.entries()) {
    if (arr.length > 1) {
      console.log(`[10A][DEDUP][${jobId}] Stem "${stem}" has ${arr.length} variants.`);
    }
    // Prefer .mp4 among variants
    const mp4s = arr.filter(x => x.toLowerCase().endsWith('.mp4'));
    let pick;
    if (mp4s.length) {
      // Deterministic pick: shortest path, then lexicographically
      pick = mp4s.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
      if (arr.length > 1) {
        console.log(`[10A][PREF][${jobId}] Preferring .mp4 for stem "${stem}": ${pick}`);
      }
    } else {
      pick = arr.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    }
    if (arr.length > 1) {
      const dropped = arr.filter(x => x !== pick);
      console.log(`[10A][DEDUP][${jobId}] Keeping: ${pick} | Dropped: ${JSON.stringify(dropped)}`);
    }
    console.log(`[10A][NORM][${jobId}] ${pick} → stem="${stem}"`);
    chosen.push(pick);
  }
  return chosen;
}

/**
 * Finds the *best-scoring* video in R2 for the subject, using strict, fuzzy, or partial match (in that order).
 * ALWAYS returns the best available candidate (never null if any .mp4 exists).
 * @param {string} subject
 * @param {string} workDir
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {string[]} usedClips
 * @returns {Promise<string|null>} Local video path (or null if not found)
 */
async function findR2ClipForScene(subject, workDir, sceneIdx = 0, jobId = '', usedClips = []) {
  console.log(`[10A][R2][${jobId}] findR2ClipForScene | subject="${subject}" | sceneIdx=${sceneIdx} | workDir="${workDir}" | usedClips=${JSON.stringify(usedClips)}`);

  if (!subject || typeof subject !== 'string') {
    console.error(`[10A][R2][${jobId}] No valid subject passed!`);
    return null;
  }

  try {
    const files = await listAllFilesInR2('', jobId);
    if (!files.length) {
      console.warn(`[10A][R2][${jobId}][WARN] No files found in R2 bucket!`);
      return null;
    }

    // NEW: Dedupe by stem (pref .mp4), then proceed
    const deduped = dedupeByStemPreferMp4(files, jobId);

    // Only .mp4s, and skip any used clips (by key or by stem)
    const usedStems = new Set((usedClips || []).map(stemFromKey));
    let mp4Files = deduped.filter(f => f.toLowerCase().endsWith('.mp4'));

    // Respect legacy usedClips matching + new stem-level skip
    mp4Files = mp4Files.filter(f => {
      if ((usedClips || []).some(u => f.endsWith(u) || f === u)) {
        console.log(`[10A][SKIP][USED] Key already used this job { key: '${f}' }`);
        return false;
      }
      const stem = stemFromKey(f);
      if (usedStems.has(stem)) {
        console.log(`[10A][SKIP][USED_STEM] Stem already used this job { stem: '${stem}', key: '${f}' }`);
        return false;
      }
      return true;
    });

    if (!mp4Files.length) {
      console.warn(`[10A][R2][${jobId}] No .mp4 files available after dedupe/used-filter!`);
      return null;
    }

    // Score all files for this subject
    const scored = mp4Files.map(f => ({
      file: f,
      score: scoreR2Match(f, subject)
    }));

    // Log top candidates with normalized stems
    scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .forEach((s, i) => console.log(`[10A][R2][${jobId}][CANDIDATE][${i + 1}] ${s.file} | score=${s.score} | stem="${stemFromKey(s.file)}"`));

    // Take the highest-scoring file ALWAYS, even if score is negative (as last resort)
    let best = scored[0];
    if (!best || typeof best.file !== 'string') {
      console.warn(`[10A][R2][${jobId}] [FALLBACK][FATAL] No candidates for subject "${subject}". Aborting.`);
      return null;
    }

    // Log whether this is strict/fuzzy/partial/last-resort
    if (best.score >= 100) {
      console.log(`[10A][R2][${jobId}][SELECTED][STRICT] ${best.file} | score=${best.score}`);
    } else if (best.score >= 35) {
      console.log(`[10A][R2][${jobId}][SELECTED][FUZZY] ${best.file} | score=${best.score}`);
    } else if (best.score >= 1) {
      console.log(`[10A][R2][${jobId}][SELECTED][PARTIAL] ${best.file} | score=${best.score}`);
    } else {
      console.warn(`[10A][R2][${jobId}][FALLBACK][LAST_RESORT] No strong match, using best available: ${best.file} | score=${best.score}`);
    }

    const bestFile = best.file;

    // Unique filename for every download attempt (parallel safe)
    const unique = uuidv4();
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2-${unique}.mp4`);
    if (fs.existsSync(outPath) && isValidClip(outPath, jobId)) {
      console.log(`[10A][R2][${jobId}] File already downloaded: ${outPath}`);
      return outPath;
    }
    console.log(`[10A][R2][${jobId}] Downloading R2 clip: ${bestFile} -> ${outPath}`);

    const getCmd = new GetObjectCommand({ Bucket: R2_LIBRARY_BUCKET, Key: bestFile });
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
        console.log(`[10A][R2][${jobId}] Clip downloaded to: ${outPath}`);
        resolve();
      });
      fileStream.on('error', (err) => {
        console.error(`[10A][R2][${jobId}][ERR] Write error during download:`, err);
        reject(err);
      });
    });

    if (!isValidClip(outPath, jobId)) {
      console.warn(`[10A][R2][${jobId}] Downloaded file is invalid/broken: ${outPath}`);
      return null;
    }

    return outPath;

  } catch (err) {
    console.error(`[10A][R2][${jobId}][ERR] findR2ClipForScene failed:`, err);
    return null;
  }
}

// === Static export for advanced dedupe (used by 5D) ===
findR2ClipForScene.getAllFiles = async function() {
  try {
    const files = await listAllFilesInR2('', 'STATIC');
    const mp4s = files.filter(f => f.endsWith('.mp4'));
    console.log(`[10A][STATIC] getAllFiles: Found ${mp4s.length} mp4s in R2.`);
    return mp4s;
  } catch (err) {
    console.error('[10A][STATIC][ERR] getAllFiles failed:', err);
    return [];
  }
};

module.exports = { findR2ClipForScene };
