/* =============================================================
   SECTION 1: SETUP & DEPENDENCIES (Modular)
   ------------------------------------------------------------
   - Loads env, modules, API keys, and paths
   - Configures AWS, Cloudflare R2, OpenAI, FFmpeg
   - Exports helpers, configs, and global state
   - God-tier logging at every step
   =========================================================== */

console.log('\n========== [BOOTING SERVER] ==========');
console.log('[SECTION1][INIT] Booting SocialStormAI backend (Section 1: setup)...');
console.log('[SECTION1][INFO] Loading dependencies...');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const util = require('util');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[SECTION1][INFO] FFmpeg path set to:', ffmpegPath);

const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const AWS = require('aws-sdk');

// === OPENAI CLIENT SETUP ===
let openai;
try {
  const OpenAI = require('openai');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  console.log('[SECTION1][INFO] OpenAI client initialized.');
} catch (err) {
  console.error('[SECTION1][FATAL] OpenAI client setup failed:', err);
  process.exit(1);
}

// === R2 / S3 BUCKETS & CLIENT SETUP ===
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_VIDEOS_BUCKET = process.env.R2_VIDEOS_BUCKET || 'socialstorm-videos';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;

const s3Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});
console.log('[SECTION1][INFO] Cloudflare R2 S3Client initialized.');
console.log('[SECTION1][INFO] R2_LIBRARY_BUCKET:', R2_LIBRARY_BUCKET);
console.log('[SECTION1][INFO] R2_VIDEOS_BUCKET:', R2_VIDEOS_BUCKET);
console.log('[SECTION1][INFO] R2_ENDPOINT:', R2_ENDPOINT);

const JOBS_DIR = path.join(__dirname, '..', 'jobs');
console.log('[SECTION1][INFO] Dependencies loaded.');

// === ENVIRONMENT VALIDATION ===
const requiredEnvVars = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'R2_LIBRARY_BUCKET',
  'R2_VIDEOS_BUCKET',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'OPENAI_API_KEY'
];
const missingEnv = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error('[SECTION1][FATAL] Missing environment variables:', missingEnv);
  process.exit(1);
}
console.log('[SECTION1][INFO] All required environment variables are present.');

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1'
});
console.log('[SECTION1][INFO] AWS SDK configured for Polly, region:', process.env.AWS_REGION);

// Express App — exported for main entry if needed
const app = express();

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

const progress = {};
console.log('[SECTION1][INFO] Progress tracker initialized.');

// ===================== UTILITY FUNCTIONS =====================

function assertFile(file, label = 'FILE') {
  try {
    if (!fs.existsSync(file)) throw new Error(`[SECTION1][${label}][ERR] File does not exist: ${file}`);
    const sz = fs.statSync(file).size;
    if (sz < 10240) throw new Error(`[SECTION1][${label}][ERR] File too small (${sz} bytes): ${file}`);
    return true;
  } catch (e) {
    console.error(e.message);
    return false;
  }
}

// --- AUDIO/VIDEO DEFENSE HELPERS ---

// Ensures mp4 has AAC 44100Hz stereo, yuv420p video (bulletproof for concat)
const standardizeVideo = (inputPath, outPath, refInfo) => {
  return new Promise((resolve, reject) => {
    let pixFmt = (refInfo && refInfo.pix_fmt) ? refInfo.pix_fmt : 'yuv420p';
    let width = (refInfo && refInfo.width) ? refInfo.width : 1080;
    let height = (refInfo && refInfo.height) ? refInfo.height : 1920;
    if (!refInfo || typeof refInfo !== 'object') {
      console.warn(`[SECTION1][HELPER][standardizeVideo][WARN] refInfo missing, defaulting to 1080x1920, yuv420p`);
    } else {
      if (!refInfo.pix_fmt) {
        console.warn(`[SECTION1][HELPER][standardizeVideo][WARN] refInfo.pix_fmt was undefined, defaulting to 'yuv420p'`);
      }
      if (!refInfo.width || !refInfo.height) {
        console.warn(`[SECTION1][HELPER][standardizeVideo][WARN] refInfo.width/height missing, defaulting to 1080x1920`);
      }
    }

    console.log(`[SECTION1][HELPER][standardizeVideo][START] Standardizing ${inputPath} to ${width}x${height}, pix_fmt=${pixFmt}, out=${outPath}`);
    console.log(`[SECTION1][HELPER][standardizeVideo][DEBUG] Full refInfo:`, refInfo);

    if (!assertFile(inputPath, 'STANDARDIZE_INPUT')) {
      return reject(new Error(`[SECTION1][HELPER][standardizeVideo] Input file missing or too small: ${inputPath}`));
    }

    // H.264 video, AAC 128k, yuv420p, 1080x1920, stereo 44100Hz audio
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .size(`${width}x${height}`)
      .outputOptions([
        '-pix_fmt', pixFmt,
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        '-movflags', '+faststart',
        '-y'
      ])
      .on('start', (cmd) => {
        console.log(`[SECTION1][HELPER][standardizeVideo][CMD] ${cmd}`);
      })
      .on('stderr', (line) => {
        console.log(`[SECTION1][HELPER][standardizeVideo][STDERR] ${line}`);
      })
      .on('end', () => {
        console.log(`[SECTION1][HELPER][standardizeVideo][END] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[SECTION1][HELPER][standardizeVideo][ERR] ${err}`);
        if (stderr) console.error(`[SECTION1][HELPER][standardizeVideo][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[SECTION1][HELPER][standardizeVideo][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(outPath);
  });
};

// Add silent AAC 44100Hz stereo audio if missing
const addSilentAudioTrack = (inPath, outPath, duration = 3) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][addSilentAudioTrack] Adding silent audio to ${inPath} (duration: ${duration}s) -> ${outPath}`);
    ffmpeg()
      .input(inPath)
      .input('anullsrc=channel_layout=stereo:sample_rate=44100')
      .inputOptions(['-f lavfi'])
      .outputOptions([
        '-shortest',
        '-c:v copy',
        '-c:a aac',
        '-b:a 128k',
        '-ar 44100',
        '-ac 2',
        '-pix_fmt yuv420p',
        '-y'
      ])
      .on('start', (cmd) => {
        console.log(`[SECTION1][HELPER][addSilentAudioTrack][CMD] ${cmd}`);
      })
      .on('stderr', (line) => {
        console.log(`[SECTION1][HELPER][addSilentAudioTrack][STDERR] ${line}`);
      })
      .on('end', () => {
        console.log(`[SECTION1][HELPER][addSilentAudioTrack][END] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[SECTION1][HELPER][addSilentAudioTrack][ERR] ${err}`);
        if (stderr) console.error(`[SECTION1][HELPER][addSilentAudioTrack][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[SECTION1][HELPER][addSilentAudioTrack][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(outPath);
  });
};

// --- Other Helper Functions ---

const getAudioDuration = (audioPath) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][getAudioDuration] Called with: ${audioPath}`);
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        console.error(`[SECTION1][HELPER][getAudioDuration][ERR] ffprobe error for ${audioPath}:`, err);
        return reject(err);
      }
      if (!metadata || !metadata.format || typeof metadata.format.duration !== 'number') {
        console.error(`[SECTION1][HELPER][getAudioDuration][ERR] Invalid metadata for ${audioPath}:`, metadata);
        return reject(new Error('Invalid ffprobe metadata'));
      }
      console.log(`[SECTION1][HELPER][getAudioDuration][OK] Duration: ${metadata.format.duration}s`);
      resolve(metadata.format.duration);
    });
  });
};

const trimVideo = (inPath, outPath, duration, seek = 0) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][trimVideo] Trimming ${inPath} to ${duration}s, outPath: ${outPath}, seek: ${seek}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    ffmpeg(inPath)
      .setStartTime(seek)
      .setDuration(duration)
      .output(outPath)
      .on('start', (cmd) => {
        console.log(`[SECTION1][HELPER][trimVideo][CMD] ${cmd}`);
      })
      .on('stderr', (line) => {
        console.log(`[SECTION1][HELPER][trimVideo][STDERR] ${line}`);
      })
      .on('end', () => {
        console.log(`[SECTION1][HELPER][trimVideo][END] Complete: ${outPath}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[SECTION1][HELPER][trimVideo][ERR] ${err}`);
        if (stderr) console.error(`[SECTION1][HELPER][trimVideo][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[SECTION1][HELPER][trimVideo][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .run();
  });
};

const normalizeTo9x16Blurred = (inPath, outPath, width, height) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][normalizeTo9x16Blurred] Normalizing ${inPath} to ${width}x${height}, output: ${outPath}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    ffmpeg(inPath)
      .complexFilter([
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[main];` +
        `[0:v]scale=${width}:${height},boxblur=20:1[blur];` +
        `[blur][main]overlay=(W-w)/2:(H-h)/2,crop=${width}:${height}`
      ])
      .outputOptions(['-c:a copy'])
      .on('start', (cmd) => {
        console.log(`[SECTION1][HELPER][normalizeTo9x16Blurred][CMD] ${cmd}`);
      })
      .on('stderr', (line) => {
        console.log(`[SECTION1][HELPER][normalizeTo9x16Blurred][STDERR] ${line}`);
      })
      .output(outPath)
      .on('end', () => {
        console.log(`[SECTION1][HELPER][normalizeTo9x16Blurred][END] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[SECTION1][HELPER][normalizeTo9x16Blurred][ERR] ${err}`);
        if (stderr) console.error(`[SECTION1][HELPER][normalizeTo9x16Blurred][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[SECTION1][HELPER][normalizeTo9x16Blurred][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .run();
  });
};

const muxVideoWithNarration = (videoPath, audioPath, outPath, duration) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][muxVideoWithNarration] Combining video ${videoPath} + audio ${audioPath} → ${outPath} (duration: ${duration}s)`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-b:a 128k',
        '-ar 44100',
        '-ac 2',
        '-shortest',
        '-pix_fmt yuv420p',
        '-y'
      ])
      .on('start', (cmd) => {
        console.log(`[SECTION1][HELPER][muxVideoWithNarration][CMD] ${cmd}`);
      })
      .on('stderr', (line) => {
        console.log(`[SECTION1][HELPER][muxVideoWithNarration][STDERR] ${line}`);
      })
      .save(outPath)
      .on('end', () => {
        console.log(`[SECTION1][HELPER][muxVideoWithNarration][END] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[SECTION1][HELPER][muxVideoWithNarration][ERR] ${err}`);
        if (stderr) console.error(`[SECTION1][HELPER][muxVideoWithNarration][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[SECTION1][HELPER][muxVideoWithNarration][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      });
  });
};

const getVideoInfo = (filePath) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][getVideoInfo] Getting info for: ${filePath}`);
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`[SECTION1][HELPER][getVideoInfo][ERR] ffprobe error:`, err);
        return reject(err);
      }
      console.log(`[SECTION1][HELPER][getVideoInfo][OK] Info for ${filePath}:`, JSON.stringify(metadata));
      resolve(metadata);
    });
  });
};

// =================== PICK MUSIC FOR MOOD (DEFAULT HARDCODED) ===================
/**
 * Always returns first .mp3 file from 'upbeat_energetic_pop' for now.
 * To make it mood-aware later, just switch the subfolder based on input.
 */
function pickMusicForMood(scriptOrMood, workDir) {
  const musicDir = path.resolve(__dirname, '..', 'public', 'assets', 'music_library', 'upbeat_energetic_pop');
  try {
    const files = fs.readdirSync(musicDir).filter(f => f.endsWith('.mp3'));
    if (files.length > 0) {
      const chosen = path.join(musicDir, files[0]);
      console.log('[SECTION1][pickMusicForMood][DEFAULT] Using:', chosen);
      return chosen;
    }
    console.warn('[SECTION1][pickMusicForMood][WARN] No .mp3 files found in upbeat_energetic_pop!');
    return null;
  } catch (err) {
    console.error('[SECTION1][pickMusicForMood][ERR] Failed to read music folder:', err);
    return null;
  }
}

// === SPLIT SCRIPT TO SCENES FUNCTION ===
function splitScriptToScenes(script) {
  console.log(`[SECTION1][HELPER][splitScriptToScenes] Splitting script into scenes, length: ${script ? script.length : 0}`);
  if (!script || typeof script !== 'string') {
    console.warn('[SECTION1][HELPER][splitScriptToScenes][WARN] Invalid script input.');
    return [];
  }
  const scenes = script.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  console.log(`[SECTION1][HELPER][splitScriptToScenes][OK] Scenes count: ${scenes.length}`);
  return scenes;
}

console.log('[SECTION1][COMPLETE] All dependencies, helpers, and logging functions loaded.');

// ===================== EXPORTS =====================
console.log('[SECTION1][EXPORT] Exporting all Section 1 helpers, configs, and shared state.');

module.exports = {
  express,
  cors,
  axios,
  path,
  fs,
  fsExtra,
  util,
  uuidv4,
  ffmpeg,
  ffmpegPath,
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  AWS,
  openai,
  R2_LIBRARY_BUCKET,
  R2_VIDEOS_BUCKET,
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  s3Client,
  JOBS_DIR,
  app,
  progress,
  getAudioDuration,
  trimVideo,
  normalizeTo9x16Blurred,
  addSilentAudioTrack,
  muxVideoWithNarration,
  standardizeVideo,
  getVideoInfo,
  pickMusicForMood,
  splitScriptToScenes, // No cleanupJob export here anymore!
};
