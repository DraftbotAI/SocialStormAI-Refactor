/* ===========================================================
   SECTION 1: SETUP & DEPENDENCIES (Modular)
   -----------------------------------------------------------
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

// --- GOD-TIER LOGGING for audio/video helpers ---

// Get audio duration in seconds using ffprobe
const getAudioDuration = (audioPath) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][getAudioDuration] Called with: ${audioPath}`);
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        console.error(`[SECTION1][HELPER][getAudioDuration] ffprobe error for ${audioPath}:`, err);
        return reject(err);
      }
      if (!metadata || !metadata.format || typeof metadata.format.duration !== 'number') {
        console.error(`[SECTION1][HELPER][getAudioDuration] Invalid metadata for ${audioPath}:`, metadata);
        return reject(new Error('Invalid ffprobe metadata'));
      }
      console.log(`[SECTION1][HELPER][getAudioDuration] Success. Duration: ${metadata.format.duration}s`);
      resolve(metadata.format.duration);
    });
  });
};

// Trim video to duration
const trimVideo = (inPath, outPath, duration, seek = 0) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][trimVideo] Trimming ${inPath} to ${duration}s, outPath: ${outPath}, seek: ${seek}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    ffmpeg(inPath)
      .setStartTime(seek)
      .setDuration(duration)
      .output(outPath)
      .on('end', () => {
        console.log(`[SECTION1][HELPER][trimVideo] Trim complete: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[SECTION1][HELPER][trimVideo] Error:`, err);
        reject(err);
      })
      .run();
  });
};

// Normalize to 9x16, blurred background
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
      .output(outPath)
      .on('end', () => {
        console.log(`[SECTION1][HELPER][normalizeTo9x16Blurred] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[SECTION1][HELPER][normalizeTo9x16Blurred] Error:`, err);
        reject(err);
      })
      .run();
  });
};

// Add silent audio track if needed
const addSilentAudioTrack = (inPath, outPath, duration) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][addSilentAudioTrack] Adding silent audio to ${inPath} (duration: ${duration}s) -> ${outPath}`);
    ffmpeg()
      .input(inPath)
      .input('anullsrc=channel_layout=stereo:sample_rate=44100')
      .inputOptions(['-f lavfi'])
      .outputOptions(['-shortest', '-c:v copy', '-c:a aac', '-y'])
      .save(outPath)
      .on('end', () => {
        console.log(`[SECTION1][HELPER][addSilentAudioTrack] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[SECTION1][HELPER][addSilentAudioTrack] Error:`, err);
        reject(err);
      });
  });
};

// Mux video with narration audio
const muxVideoWithNarration = (videoPath, audioPath, outPath, duration) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][muxVideoWithNarration] Combining video ${videoPath} + audio ${audioPath} → ${outPath} (duration: ${duration}s)`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-shortest', '-y'])
      .save(outPath)
      .on('end', () => {
        console.log(`[SECTION1][HELPER][muxVideoWithNarration] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[SECTION1][HELPER][muxVideoWithNarration] Error:`, err);
        reject(err);
      });
  });
};

// Standardize video to match reference info
const standardizeVideo = (inputPath, outPath, refInfo) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][standardizeVideo] Standardizing ${inputPath} to match reference:`, refInfo);
    const args = [
      '-vf', `scale=${refInfo.width}:${refInfo.height},format=${refInfo.pix_fmt}`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-pix_fmt', refInfo.pix_fmt,
      '-y'
    ];
    ffmpeg(inputPath)
      .outputOptions(args)
      .save(outPath)
      .on('end', () => {
        console.log(`[SECTION1][HELPER][standardizeVideo] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[SECTION1][HELPER][standardizeVideo] Error:`, err);
        reject(err);
      });
  });
};

// Get info about a video
const getVideoInfo = (filePath) => {
  return new Promise((resolve, reject) => {
    console.log(`[SECTION1][HELPER][getVideoInfo] Getting info for: ${filePath}`);
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`[SECTION1][HELPER][getVideoInfo] ffprobe error:`, err);
        return reject(err);
      }
      console.log(`[SECTION1][HELPER][getVideoInfo] Info for ${filePath}:`, JSON.stringify(metadata));
      resolve(metadata);
    });
  });
};

// Pick music by mood (stub)
const pickMusicForMood = (mood) => {
  console.log(`[SECTION1][HELPER][pickMusicForMood] Picking music for mood: ${mood}`);
  return null; // Implement as needed
};

// SAFE CLEANUP FUNCTION
function cleanupJob(jobId) {
  try {
    console.log(`[SECTION1][CLEANUP] Starting cleanup for job: ${jobId}`);
    if (progress[jobId]) {
      delete progress[jobId];
      console.log(`[SECTION1][CLEANUP] Progress entry deleted for job: ${jobId}`);
    }
    const jobDir = path.join(__dirname, '..', 'renders', jobId);
    if (fs.existsSync(jobDir)) {
      fsExtra.removeSync(jobDir);
      console.log(`[SECTION1][CLEANUP] Removed temp folder: ${jobDir}`);
    }
  } catch (err) {
    console.warn(`[SECTION1][WARN] Cleanup failed for job ${jobId}:`, err);
  }
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
  cleanupJob
};
