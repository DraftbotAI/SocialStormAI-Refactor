// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2)
// Exports: findR2ClipForScene (used by 5D) + getAllFiles (for parallel dedupe/scan)
// MAX LOGGING EVERY STEP, Modular System Compatible
// Parallel safe: no temp file collisions
// Upgraded 2024-08: Smarter matching, phrase/keyword scoring, logs, static export
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

// === UTILS ===
function normalize(str) {
  return String(str)
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function getKeywords(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, '')
    .split(/[\s\-]+/)
    .filter(w => w.length > 2);
}

// === BULLETPROOF: List all files in R2 ===
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

// === MATCHING: Score for each file based on subject/keywords ===
function scoreR2Match(file, subject, extraPhrases = []) {
  const normFile = normalize(file);
  const normSubject = normalize(subject);
  let score = 0;

  // Exact full match
  if (normFile === normSubject) return 100;

  // Strong phrase match
  if (normFile.includes(normSubject)) score += 80;

  // All keywords present
  const subjectWords = getKeywords(subject);
  let wordsMatched = 0;
  for (let word of subjectWords) {
    if (normFile.includes(word)) wordsMatched++;
  }
  if (wordsMatched === subjectWords.length && subjectWords.length > 1) score += 60;

  // Partial/keyword fallback
  if (wordsMatched > 0) score += 10 * wordsMatched;

  // Extra phrases boost
  for (let p of extraPhrases) {
    if (normFile.includes(normalize(p))) score += 15;
  }
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
      console.warn(`[10A][R2][${jobId}] File too small or broken: ${filePath} (${size} bytes)`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[10A][R2][${jobId}] File validation error:`, err);
    return false;
  }
}

/**
 * Finds the best-matching video in R2 and downloads it to local workDir.
 * Used by 5D as findR2ClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
 * @param {string} subject
 * @param {string} workDir
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {string[]} usedClips
 * @param {string[]} [extraPhrases] - additional keywords to match
 * @returns {Promise<string|null>} Local video path (or null if not found)
 */
async function findR2ClipForScene(subject, workDir, sceneIdx = 0, jobId = '', usedClips = [], extraPhrases = []) {
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

    // Only .mp4s, skip any usedClips (allow both basename and full key in usedClips)
    const mp4Files = files.filter(f =>
      f.endsWith('.mp4') && !usedClips.some(u => f.endsWith(u) || f === u)
    );

    // Score all files (and log details)
    let bestScore = -1;
    let bestFile = null;
    let allScores = [];

    for (let file of mp4Files) {
      const score = scoreR2Match(file, subject, extraPhrases);
      allScores.push({ file, score });
      if (score > bestScore) {
        bestScore = score;
        bestFile = file;
      }
    }

    // Sort by score descending for debugging
    allScores.sort((a, b) => b.score - a.score);
    console.log(`[10A][R2][${jobId}][SCORES] Top R2 file scores for "${subject}":`);
    allScores.slice(0, 10).forEach((s, i) =>
      console.log(`  [${i + 1}] ${s.file} -> ${s.score}`)
    );

    // Choose only files with a "good" match (score >= 50)
    if (!bestFile || bestScore < 50) {
      console.log(`[10A][R2][${jobId}] No strong R2 match for "${subject}" (best score: ${bestScore})`);
      return null;
    }

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
