// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2) - UPGRADED 2024-08
// Exports: findR2ClipForScene (used by 5D) + getAllFiles (for parallel dedupe/scan)
// MAX LOGGING EVERY STEP, Modular, Video-Preferred, Anti-Dupe, Multi-Angle
// Uses universal scoreSceneCandidate from 10G (pro match, anti-generic, pro-topic)
// Never silent fail. Smart fallback if no strong match.
// ===========================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');

console.log('[10A][INIT] R2 clip helper (video-first, max logs, multi-angle) loaded.');

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

// ============================
// FILE UTILITIES
// ============================

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

// Ensures file exists and is >2kb (not broken)
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

// ============================
// SUBJECT AND PHRASE EXTRACTOR
// ============================
function extractSubjectAndPhrases(scene) {
  if (typeof scene === 'string') return { subject: scene, matchPhrases: [] };
  if (Array.isArray(scene)) {
    const strItems = scene.map(x => typeof x === 'string' ? x : (x.subject || '')).filter(Boolean);
    return {
      subject: strItems[0] || '',
      matchPhrases: strItems.slice(1)
    };
  }
  if (scene && typeof scene === 'object') {
    const subject =
      scene.subject ||
      scene.main ||
      (scene.visual && scene.visual.subject) ||
      '';
    let matchPhrases = [];
    if (Array.isArray(scene.matchPhrases)) matchPhrases = scene.matchPhrases;
    else if (Array.isArray(scene.tokens)) matchPhrases = scene.tokens;
    return { subject, matchPhrases };
  }
  return { subject: '', matchPhrases: [] };
}

// ============================
// MAIN MATCHER (VIDEO-FIRST)
// ============================

async function findR2ClipForScene(scene, workDir, sceneIdx = 0, jobId = '', usedClips = []) {
  const { subject, matchPhrases } = extractSubjectAndPhrases(scene);

  if (!subject || typeof subject !== 'string' || subject.length < 2) {
    console.error(`[10A][R2][${jobId}] No valid subject for R2 lookup! Input:`, scene);
    return null;
  }

  console.log(`[10A][R2][${jobId}] findR2ClipForScene | subject="${subject}" | sceneIdx=${sceneIdx} | workDir="${workDir}" | usedClips=${JSON.stringify(usedClips)}`);

  try {
    // === 1. List all mp4 files from R2 (with path info for category logic)
    const files = await listAllFilesInR2('', jobId);
    if (!files.length) {
      console.warn(`[10A][R2][${jobId}][WARN] No files found in R2 bucket!`);
      return null;
    }

    // === 2. Only .mp4s, never a usedClip (basename or full R2 key)
    const mp4Files = files.filter(f =>
      f.endsWith('.mp4') &&
      !usedClips.some(u => f.endsWith(u) || f === u || path.basename(f) === u)
    );
    if (!mp4Files.length) {
      console.warn(`[10A][R2][${jobId}] No .mp4 files found in R2 bucket!`);
      return null;
    }

    // === 3. Candidate building with advanced keyword/topic/cat/angle logic
    const keywords = [subject, ...(matchPhrases || [])].map(k => typeof k === 'string' ? k.toLowerCase().replace(/[^a-z0-9_ ]+/gi, '') : '').filter(Boolean);
    // Try category prioritization based on folder name
    const catFolders = ['lore_history_mystery_horror','sports_fitness','cars_vehicles','animals_primates','misc'];
    let relevantFiles = mp4Files;

    // Optional: prioritize files in topic-aligned folders
    for (let folder of catFolders) {
      if (subject.toLowerCase().includes(folder.replace(/_/g, ' '))) {
        relevantFiles = mp4Files.filter(f => f.includes(folder));
        if (relevantFiles.length) break;
      }
    }

    // === 4. Build candidates array
    const candidates = relevantFiles.map(f => {
      // Extract "topic" and "angle" from filename
      const base = path.basename(f, '.mp4');
      const [topicPart, ...rest] = base.split('_');
      return {
        type: 'video',
        source: 'r2',
        path: f,
        filename: path.basename(f),
        subject,
        matchPhrases,
        category: catFolders.find(cat => f.includes(cat)) || 'misc',
        topic: topicPart,
        angle: rest.join('_'),
        scene,
        isVideo: true
      };
    });

    // === 5. Score with universal helper (Section 10G)
    const scored = candidates.map(candidate => ({
      ...candidate,
      score: scoreSceneCandidate(candidate, candidate.scene, usedClips)
    }));

    if (scored.length === 0) {
      console.log(`[10A][R2][${jobId}][CANDIDATE] No .mp4 candidates to score.`);
    } else {
      scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .forEach((s, i) => console.log(`[10A][R2][${jobId}][CANDIDATE][${i + 1}] ${s.path} | score=${s.score}`));
    }

    // === 6. Prefer "multi-angle" / non-duplicate for same topic
    const multiAngle = scored.filter(s => s.topic === subject.toLowerCase().replace(/ /g, '_'));
    if (multiAngle.length) {
      multiAngle.sort((a, b) => b.score - a.score);
      const bestAngle = multiAngle[0];
      if (bestAngle && bestAngle.score >= 35 && !usedClips.includes(bestAngle.path)) {
        console.log(`[10A][R2][${jobId}][MULTIANGLE][SELECTED] ${bestAngle.path} | score=${bestAngle.score}`);
        return await downloadAndValidate(bestAngle.path, workDir, sceneIdx, jobId, usedClips);
      }
    }

    // === 7. Filter out true irrelevants (score <20) IF a strong match exists (score >=80)
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

    if (!best || typeof best.path !== 'string') {
      console.warn(`[10A][R2][${jobId}] [FALLBACK][FATAL] No suitable candidates for subject "${subject}". Aborting.`);
      return null;
    }

    // Deduplication log
    if (usedClips.includes(best.path) || usedClips.includes(path.basename(best.path))) {
      console.warn(`[10A][R2][${jobId}][DEDUPE_BLOCK] Skipped candidate already used in this video: ${best.path}`);
      return null;
    }

    // Log why this candidate was chosen
    if (best.score >= 100) {
      console.log(`[10A][R2][${jobId}][SELECTED][STRICT] ${best.path} | score=${best.score}`);
    } else if (best.score >= 80) {
      console.log(`[10A][R2][${jobId}][SELECTED][STRONG] ${best.path} | score=${best.score}`);
    } else if (best.score >= 35) {
      console.log(`[10A][R2][${jobId}][SELECTED][FUZZY] ${best.path} | score=${best.score}`);
    } else if (best.score >= 20) {
      console.log(`[10A][R2][${jobId}][SELECTED][PARTIAL] ${best.path} | score=${best.score}`);
    } else {
      console.warn(`[10A][R2][${jobId}][FALLBACK][LAST_RESORT] No strong match, using best available: ${best.path} | score=${best.score}`);
    }

    // === 8. Download and return local path
    return await downloadAndValidate(best.path, workDir, sceneIdx, jobId, usedClips);

  } catch (err) {
    console.error(`[10A][R2][${jobId}][ERR] findR2ClipForScene failed:`, err);
    return null;
  }
}

// --- Helper: Download, validate, and return local path
async function downloadAndValidate(r2Key, workDir, sceneIdx, jobId, usedClips) {
  const unique = uuidv4();
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2-${unique}.mp4`);
  if (fs.existsSync(outPath) && isValidClip(outPath, jobId)) {
    console.log(`[10A][R2][${jobId}] File already downloaded: ${outPath}`);
    return outPath;
  }
  console.log(`[10A][R2][${jobId}] Downloading R2 clip: ${r2Key} -> ${outPath}`);

  const getCmd = new GetObjectCommand({ Bucket: R2_LIBRARY_BUCKET, Key: r2Key });
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

  usedClips.push(r2Key);
  return outPath;
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
