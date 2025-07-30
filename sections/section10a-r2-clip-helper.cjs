// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2)
// Finds and returns best-matching video from your R2 bucket
// MAX LOGGING EVERY STEP, Modular System Compatible
// ===========================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

console.log('[10A][INIT] R2 clip helper loaded.');

// --- ENV VALIDATION ---
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
  console.log(`[10A][NORMALIZE] "${str}" -> "${norm}"`);
  return norm;
}

async function listAllFilesInR2(prefix = '') {
  let files = [];
  let continuationToken;
  let round = 0;
  try {
    do {
      round++;
      console.log(`[10A][R2] Listing R2 files, round ${round}...`);
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
    console.log(`[10A][R2] Listed ${files.length} files from R2.`);
    return files;
  } catch (err) {
    console.error('[10A][R2][ERR] List error:', err);
    return [];
  }
}

// --- MAIN: Find and Download Clip ---
/**
 * Finds the best-matching video in R2 and downloads it to local workDir.
 * @param {string} sceneText
 * @param {string} workDir  - Where to save the clip locally
 * @param {number} sceneIdx
 * @param {string} jobId
 * @returns {Promise<string|null>} Local video path (or null if not found)
 */
async function findR2ClipForScene(sceneText, workDir, sceneIdx, jobId) {
  console.log(`[10A][R2] findR2ClipForScene | sceneText="${sceneText}" workDir="${workDir}" sceneIdx=${sceneIdx} jobId=${jobId}`);
  try {
    // 1. List all files in the bucket
    const files = await listAllFilesInR2('');
    if (!files.length) {
      console.warn('[10A][R2][WARN] No files found in R2 bucket!');
      return null;
    }

    // 2. Try for a match (normalized)
    const normQuery = normalize(sceneText);
    let best = null;
    for (let file of files) {
      if (normalize(file).includes(normQuery) && file.endsWith('.mp4')) {
        best = file;
        break;
      }
    }
    if (!best) {
      console.log(`[10A][R2] No R2 match for "${sceneText}"`);
      return null;
    }

    // 3. Download the file to the job's workDir
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2.mp4`);
    if (fs.existsSync(outPath)) {
      console.log(`[10A][R2] File already downloaded: ${outPath}`);
      return outPath;
    }
    console.log(`[10A][R2] Downloading R2 clip: ${best} -> ${outPath}`);

    const getCmd = new GetObjectCommand({ Bucket: R2_LIBRARY_BUCKET, Key: best });
    const resp = await s3Client.send(getCmd);

    await new Promise((resolve, reject) => {
      const stream = resp.Body;
      const fileStream = fs.createWriteStream(outPath);
      stream.pipe(fileStream);
      stream.on('end', resolve);
      stream.on('error', (err) => {
        console.error('[10A][R2][ERR] Stream error during download:', err);
        reject(err);
      });
      fileStream.on('finish', () => {
        console.log(`[10A][R2] Clip downloaded to: ${outPath}`);
        resolve();
      });
      fileStream.on('error', (err) => {
        console.error('[10A][R2][ERR] Write error during download:', err);
        reject(err);
      });
    });

    // 4. Return the local path
    return outPath;

  } catch (err) {
    console.error('[10A][R2][ERR] findR2ClipForScene failed:', err);
    return null;
  }
}

module.exports = { findR2ClipForScene };
