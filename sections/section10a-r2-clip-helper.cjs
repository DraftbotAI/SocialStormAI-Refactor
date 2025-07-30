// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2)
// Exports: findR2ClipForScene (used by 5D)
// MAX LOGGING EVERY STEP, Modular System Compatible
// ===========================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

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

// --- UTILS ---
function normalize(str) {
  const norm = String(str)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .replace(/[^a-z0-9]/g, '');
  return norm;
}

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

// --- ENHANCED SCENE SELECTION LOGIC ---
function scoreR2Match(file, subject, extraPhrases = []) {
  const normFile = normalize(file);
  const normSubject = normalize(subject);

  if (normFile === normSubject) return 100;
  if (normFile.includes(normSubject)) return 80;
  for (let p of extraPhrases) {
    if (normFile.includes(normalize(p))) return 60;
  }
  for (let word of normSubject.split(/[^a-z0-9]+/)) {
    if (word.length > 3 && normFile.includes(word)) return 40;
  }
  return 0;
}

/**
 * Finds the best-matching video in R2 and downloads it to local workDir.
 * Used by 5D as findR2ClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
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

    // Only .mp4s, skip any usedClips (allow both basename and full key in usedClips)
    const mp4Files = files.filter(f =>
      f.endsWith('.mp4') && !usedClips.some(u => f.endsWith(u) || f === u)
    );

    // Score all files
    let bestScore = -1;
    let bestFile = null;
    let allScores = [];

    for (let file of mp4Files) {
      const score = scoreR2Match(file, subject, []);
      allScores.push({ file, score });
      if (score > bestScore) {
        bestScore = score;
        bestFile = file;
      }
    }

    allScores.sort((a, b) => b.score - a.score);
    console.log(`[10A][R2][${jobId}][SCORES] Top R2 file scores:`, allScores.slice(0, 5));

    if (!bestFile || bestScore < 40) {
      console.log(`[10A][R2][${jobId}] No strong R2 match for "${subject}" (best score: ${bestScore})`);
      return null;
    }

    // Download to job's workDir
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2.mp4`);
    if (fs.existsSync(outPath)) {
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

    return outPath;

  } catch (err) {
    console.error(`[10A][R2][${jobId}][ERR] findR2ClipForScene failed:`, err);
    return null;
  }
}

module.exports = { findR2ClipForScene };
