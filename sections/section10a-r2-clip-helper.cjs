// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2)
// Exports: findR2ClipForScene (used by 5D) + getAllFiles (for parallel dedupe/scan)
// MAX LOGGING EVERY STEP, Modular System Compatible
// Now uses universal scoreSceneCandidate from 10G (pro match, anti-dupe, anti-generic)
// 2024-08: Strict, fuzzy, and partial match, never dupe, never silent fail
// ===========================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// === Universal scorer from Section 10G ===
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');

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

/**
 * Finds the *best-scoring* video in R2 for the subject, using universal scorer (Section 10G)
 * NEVER returns a dupe; NEVER picks generic/irrelevant if a real match exists.
 * If nothing, returns null (upstream fallback handles images, etc)
 * @param {object|string} scene  // { subject, matchPhrases, ... } OR subject string
 * @param {string} workDir
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {string[]} usedClips
 * @returns {Promise<string|null>} Local video path (or null if not found)
 */
async function findR2ClipForScene(scene, workDir, sceneIdx = 0, jobId = '', usedClips = []) {
  // --- Accept plain string for backward compatibility ---
  let subject = (typeof scene === 'string') ? scene : scene?.subject || '';
  let matchPhrases = (typeof scene === 'object' && scene.matchPhrases) ? scene.matchPhrases : [];
  if (!subject || typeof subject !== 'string') {
    console.error(`[10A][R2][${jobId}] No valid subject for R2 lookup! Input:`, scene);
    return null;
  }

  console.log(`[10A][R2][${jobId}] findR2ClipForScene | subject="${subject}" | sceneIdx=${sceneIdx} | workDir="${workDir}" | usedClips=${JSON.stringify(usedClips)}`);

  try {
    const files = await listAllFilesInR2('', jobId);
    if (!files.length) {
      console.warn(`[10A][R2][${jobId}][WARN] No files found in R2 bucket!`);
      return null;
    }

    // Only .mp4s, never a usedClip (basename or full R2 key)
    const mp4Files = files.filter(f =>
      f.endsWith('.mp4') &&
      !usedClips.some(u => f.endsWith(u) || f === u || path.basename(f) === u)
    );
    if (!mp4Files.length) {
      console.warn(`[10A][R2][${jobId}] No .mp4 files found in R2 bucket!`);
      return null;
    }

    // Build candidate objects for scoring
    const candidates = mp4Files.map(f => ({
      type: 'video',
      source: 'r2',
      file: f,
      filename: path.basename(f),
      subject,
      matchPhrases,
      scene: (typeof scene === 'object') ? scene : { subject, matchPhrases },
    }));

    // Score with universal helper (Section 10G)
    const scored = candidates.map(candidate => ({
      ...candidate,
      score: scoreSceneCandidate(candidate, candidate.scene)
    }));

    // Log all candidates (even if zero strong matches)
    if (scored.length === 0) {
      console.log(`[10A][R2][${jobId}][CANDIDATE] No .mp4 candidates to score.`);
    } else {
      scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .forEach((s, i) => console.log(`[10A][R2][${jobId}][CANDIDATE][${i + 1}] ${s.file} | score=${s.score}`));
    }

    // Filter out true irrelevants (score <20) IF a strong match exists (score >=80)
    const maxScore = Math.max(...scored.map(s => s.score));
    const hasGoodMatch = maxScore >= 80;
    let eligible = scored;
    if (hasGoodMatch) {
      eligible = scored.filter(s => s.score >= 20);
      if (eligible.length < scored.length) {
        console.log(`[10A][R2][${jobId}] [FILTER] Blocked ${scored.length - eligible.length} irrelevants — real match exists.`);
      }
    }

    eligible.sort((a, b) => b.score - a.score);
    const best = eligible[0];

    if (!best || typeof best.file !== 'string') {
      console.warn(`[10A][R2][${jobId}] [FALLBACK][FATAL] No suitable candidates for subject "${subject}". Aborting.`);
      return null;
    }

    // Deduplication log
    if (usedClips.includes(best.file) || usedClips.includes(path.basename(best.file))) {
      console.warn(`[10A][R2][${jobId}][DEDUPE_BLOCK] Skipped candidate already used in this video: ${best.file}`);
      return null;
    }

    // Log how/why this candidate was chosen
    if (best.score >= 100) {
      console.log(`[10A][R2][${jobId}][SELECTED][STRICT] ${best.file} | score=${best.score}`);
    } else if (best.score >= 80) {
      console.log(`[10A][R2][${jobId}][SELECTED][STRONG] ${best.file} | score=${best.score}`);
    } else if (best.score >= 35) {
      console.log(`[10A][R2][${jobId}][SELECTED][FUZZY] ${best.file} | score=${best.score}`);
    } else if (best.score >= 20) {
      console.log(`[10A][R2][${jobId}][SELECTED][PARTIAL] ${best.file} | score=${best.score}`);
    } else {
      console.warn(`[10A][R2][${jobId}][FALLBACK][LAST_RESORT] No strong match, using best available: ${best.file} | score=${best.score}`);
    }

    // Download logic (always download to local workDir, uniquely named for dedupe)
    const unique = uuidv4();
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2-${unique}.mp4`);
    if (fs.existsSync(outPath) && isValidClip(outPath, jobId)) {
      console.log(`[10A][R2][${jobId}] File already downloaded: ${outPath}`);
      return outPath;
    }
    console.log(`[10A][R2][${jobId}] Downloading R2 clip: ${best.file} -> ${outPath}`);

    // Download from R2
    const getCmd = new GetObjectCommand({ Bucket: R2_LIBRARY_BUCKET, Key: best.file });
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
