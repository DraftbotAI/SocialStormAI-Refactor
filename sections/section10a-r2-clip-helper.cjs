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

// --- ENHANCED SCENE SELECTION LOGIC ---
// Matches by strict phrase, partial, fuzzy, and then fallback to keyword
function scoreR2Match(file, subject, extraPhrases = []) {
  const normFile = normalize(file);
  const normSubject = normalize(subject);

  // 1. Exact phrase match
  if (normFile === normSubject) return 100;

  // 2. File contains normalized subject (strong partial)
  if (normFile.includes(normSubject)) return 80;

  // 3. Any extra phrase matches (topic, alt wording)
  for (let p of extraPhrases) {
    if (normFile.includes(normalize(p))) return 60;
  }

  // 4. Loose keyword match (any word from subject)
  for (let word of normSubject.split(/[^a-z0-9]+/)) {
    if (word.length > 3 && normFile.includes(word)) return 40;
  }

  // 5. Weak match
  return 0;
}

/**
 * Finds the best-matching video in R2 and downloads it to local workDir.
 * Enhanced: Scores all clips, chooses best, avoids duplicates, logs all steps.
 * @param {object} opts
 *   @param {string} opts.subject - The main phrase/subject (e.g., "Eiffel Tower")
 *   @param {string[]} [opts.extraPhrases] - Extra keywords/phrases for fallback matching
 *   @param {string[]} [opts.usedClips] - Already used R2 keys (prevent dupe)
 *   @param {string} opts.workDir  - Local work dir
 *   @param {number} opts.sceneIdx
 *   @param {string} opts.jobId
 * @returns {Promise<string|null>} Local video path (or null if not found)
 */
async function findR2Clip(opts) {
  const {
    subject,
    extraPhrases = [],
    usedClips = [],
    workDir,
    sceneIdx = 0,
    jobId = ''
  } = opts || {};

  console.log(`[10A][R2] findR2Clip | subject="${subject}" | extraPhrases=${JSON.stringify(extraPhrases)} | usedClips=${JSON.stringify(usedClips)} | workDir="${workDir}" | sceneIdx=${sceneIdx} | jobId=${jobId}`);

  if (!subject || typeof subject !== 'string') {
    console.error('[10A][ERR] No valid subject passed!');
    return null;
  }

  try {
    // 1. List all files in the bucket
    const files = await listAllFilesInR2('');
    if (!files.length) {
      console.warn('[10A][R2][WARN] No files found in R2 bucket!');
      return null;
    }

    // 2. Filter out already used clips, only look at mp4s
    const mp4Files = files.filter(f => f.endsWith('.mp4') && !usedClips.includes(f));

    // 3. Score all files for best match
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

    allScores.sort((a, b) => b.score - a.score);
    console.log('[10A][R2][SCORES] Top R2 file scores:', allScores.slice(0, 5));

    if (!bestFile || bestScore < 40) {
      console.log(`[10A][R2] No strong R2 match for "${subject}" (best score: ${bestScore})`);
      return null;
    }

    // 4. Download the file to the job's workDir
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2.mp4`);
    if (fs.existsSync(outPath)) {
      console.log(`[10A][R2] File already downloaded: ${outPath}`);
      return outPath;
    }
    console.log(`[10A][R2] Downloading R2 clip: ${bestFile} -> ${outPath}`);

    const getCmd = new GetObjectCommand({ Bucket: R2_LIBRARY_BUCKET, Key: bestFile });
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

    // 5. Return the local path
    return outPath;

  } catch (err) {
    console.error('[10A][R2][ERR] findR2Clip failed:', err);
    return null;
  }
}

module.exports = findR2Clip;
