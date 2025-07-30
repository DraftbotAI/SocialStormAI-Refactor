// ===========================================================
// SECTION 5F: VIDEO PROCESSING & AV COMBINER
// Handles trimming, normalizing, silent audio, muxing narration onto video
// MAX LOGGING AT EVERY STEP
// ===========================================================

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

console.log('[5F][INIT] Video processing & AV combiner loaded.');

/**
 * Trims a video file to a specific duration.
 * @param {string} inPath - Input video path
 * @param {string} outPath - Output trimmed video path
 * @param {number} duration - Trim duration in seconds
 * @param {number} [start=0] - Start time in seconds
 * @returns {Promise<void>}
 */
async function trimVideo(inPath, outPath, duration, start = 0) {
  console.log(`[5F][TRIM] trimVideo called: in="${inPath}" out="${outPath}" duration=${duration}s start=${start}`);
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .setStartTime(start)
      .setDuration(duration)
      .output(outPath)
      .on('end', () => {
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10240) {
          console.error(`[5F][TRIM][ERR] Output missing/too small after trim: ${outPath}`);
          return reject(new Error(`Trimmed video missing: ${outPath}`));
        }
        console.log(`[5F][TRIM] Trimmed video saved: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[5F][TRIM][ERR] FFmpeg error during trim:`, err);
        reject(err);
      })
      .run();
  });
}

/**
 * Normalizes a video to 9:16 aspect ratio with blurred background (TikTok style).
 * @param {string} inPath - Input video path
 * @param {string} outPath - Output normalized video path
 * @param {number} width
 * @param {number} height
 * @returns {Promise<void>}
 */
async function normalizeTo9x16Blurred(inPath, outPath, width = 1080, height = 1920) {
  console.log(`[5F][NORM] normalizeTo9x16Blurred called: in="${inPath}" out="${outPath}" size=${width}x${height}`);
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .videoFilter([
        // Blurred background, then overlay original in center
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,boxblur=10:1,setsar=1`,
        `[bg];movie=${inPath},scale=${width}:${height}:force_original_aspect_ratio=decrease,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,crop=${width}:${height}`
      ])
      .output(outPath)
      .on('end', () => {
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10240) {
          console.error(`[5F][NORM][ERR] Output missing/too small after normalization: ${outPath}`);
          return reject(new Error(`Normalized video missing: ${outPath}`));
        }
        console.log(`[5F][NORM] Normalized 9x16 video saved: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[5F][NORM][ERR] FFmpeg error during normalization:`, err);
        reject(err);
      })
      .run();
  });
}

/**
 * Adds a silent audio track to a video (if missing).
 * @param {string} inPath - Input video path
 * @param {string} outPath - Output path
 * @param {number} duration - Duration for the silent audio
 * @returns {Promise<void>}
 */
async function addSilentAudioTrack(inPath, outPath, duration) {
  console.log(`[5F][AUDIO] addSilentAudioTrack called: in="${inPath}" out="${outPath}" duration=${duration}`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inPath)
      .input('anullsrc=channel_layout=stereo:sample_rate=44100')
      .inputOptions(['-f lavfi'])
      .outputOptions(['-shortest', '-c:v copy', '-c:a aac', '-y'])
      .duration(duration)
      .save(outPath)
      .on('end', () => {
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10240) {
          console.error(`[5F][AUDIO][ERR] Output missing/too small after silent audio add: ${outPath}`);
          return reject(new Error(`Silent-audio video missing: ${outPath}`));
        }
        console.log(`[5F][AUDIO] Silent audio added to video: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[5F][AUDIO][ERR] FFmpeg error during silent audio add:`, err);
        reject(err);
      });
  });
}

/**
 * Muxes a narration audio file onto a video file, preserving duration.
 * @param {string} videoIn - Input video path
 * @param {string} audioIn - Narration audio path
 * @param {string} outPath - Output path
 * @param {number} duration - Output duration (seconds)
 * @returns {Promise<void>}
 */
async function muxVideoWithNarration(videoIn, audioIn, outPath, duration) {
  console.log(`[5F][MUX] muxVideoWithNarration called: video="${videoIn}" audio="${audioIn}" out="${outPath}" duration=${duration}`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoIn)
      .input(audioIn)
      .outputOptions(['-shortest', '-c:v copy', '-c:a aac', '-y'])
      .save(outPath)
      .on('end', () => {
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10240) {
          console.error(`[5F][MUX][ERR] Output missing/too small after mux: ${outPath}`);
          return reject(new Error(`Muxed scene missing: ${outPath}`));
        }
        console.log(`[5F][MUX] Muxed narration onto video: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[5F][MUX][ERR] FFmpeg error during mux:`, err);
        reject(err);
      });
  });
}

module.exports = {
  trimVideo,
  normalizeTo9x16Blurred,
  addSilentAudioTrack,
  muxVideoWithNarration,
};
