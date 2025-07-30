// ===========================================================
// SECTION 5F: VIDEO PROCESSING & AV COMBINER
// Handles trimming, normalizing, silent audio, muxing narration onto video
// MAX LOGGING AT EVERY STEP
// Enhanced: Mega-scene (multi-line audio) support
// ===========================================================

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

console.log('[5F][INIT] Video processing & AV combiner loaded.');

// Helper: Defensive file existence/size check
function assertFile(file, minSize = 10240, label = 'FILE') {
  if (!fs.existsSync(file)) {
    throw new Error(`[5F][${label}][ERR] File does not exist: ${file}`);
  }
  const sz = fs.statSync(file).size;
  if (sz < minSize) {
    throw new Error(`[5F][${label}][ERR] File too small (${sz} bytes): ${file}`);
  }
}

/**
 * Trims a video file to a specific duration.
 */
async function trimVideo(inPath, outPath, duration, start = 0) {
  console.log(`[5F][TRIM] trimVideo called: in="${inPath}" out="${outPath}" duration=${duration}s start=${start}`);
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .setStartTime(start)
      .setDuration(duration)
      .output(outPath)
      .on('start', (cmd) => {
        console.log(`[5F][TRIM][CMD] ${cmd}`);
      })
      .on('stderr', (line) => {
        console.log(`[5F][TRIM][STDERR] ${line}`);
      })
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'TRIM_OUT');
          console.log(`[5F][TRIM] Trimmed video saved: ${outPath}`);
          resolve();
        } catch (e) {
          console.error(`[5F][TRIM][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][TRIM][ERR] FFmpeg error during trim:`, err);
        if (stderr) console.error(`[5F][TRIM][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][TRIM][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .run();
  });
}

/**
 * Normalizes a video to 9:16 aspect ratio with blurred background (TikTok style).
 */
async function normalizeTo9x16Blurred(inPath, outPath, width = 1080, height = 1920) {
  console.log(`[5F][NORM] normalizeTo9x16Blurred called: in="${inPath}" out="${outPath}" size=${width}x${height}`);
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .complexFilter([
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[main];` +
        `[0:v]scale=${width}:${height},boxblur=20:1[blur];` +
        `[blur][main]overlay=(W-w)/2:(H-h)/2,crop=${width}:${height}`
      ])
      .outputOptions(['-c:a copy'])
      .on('start', (cmd) => {
        console.log(`[5F][NORM][CMD] ${cmd}`);
      })
      .on('stderr', (line) => {
        console.log(`[5F][NORM][STDERR] ${line}`);
      })
      .output(outPath)
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'NORM_OUT');
          console.log(`[5F][NORM] Normalized 9x16 video saved: ${outPath}`);
          resolve();
        } catch (e) {
          console.error(`[5F][NORM][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][NORM][ERR] FFmpeg error during normalization:`, err);
        if (stderr) console.error(`[5F][NORM][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][NORM][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .run();
  });
}

/**
 * Adds a silent audio track to a video (if missing).
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
      .on('start', (cmd) => {
        console.log(`[5F][AUDIO][CMD] ${cmd}`);
      })
      .on('stderr', (line) => {
        console.log(`[5F][AUDIO][STDERR] ${line}`);
      })
      .save(outPath)
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'AUDIO_OUT');
          console.log(`[5F][AUDIO] Silent audio added to video: ${outPath}`);
          resolve();
        } catch (e) {
          console.error(`[5F][AUDIO][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][AUDIO][ERR] FFmpeg error during silent audio add:`, err);
        if (stderr) console.error(`[5F][AUDIO][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][AUDIO][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      });
  });
}

/**
 * Muxes a narration audio file onto a video file, preserving duration.
 */
async function muxVideoWithNarration(videoIn, audioIn, outPath, duration) {
  console.log(`[5F][MUX] muxVideoWithNarration called: video="${videoIn}" audio="${audioIn}" out="${outPath}" duration=${duration}`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoIn)
      .input(audioIn)
      .outputOptions(['-shortest', '-c:v copy', '-c:a aac', '-y'])
      .on('start', (cmd) => {
        console.log(`[5F][MUX][CMD] ${cmd}`);
      })
      .on('stderr', (line) => {
        console.log(`[5F][MUX][STDERR] ${line}`);
      })
      .save(outPath)
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'MUX_OUT');
          console.log(`[5F][MUX] Muxed narration onto video: ${outPath}`);
          resolve();
        } catch (e) {
          console.error(`[5F][MUX][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][MUX][ERR] FFmpeg error during mux:`, err);
        if (stderr) console.error(`[5F][MUX][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][MUX][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      });
  });
}

/**
 * Handles "mega-scene" (scene 1+2) — trims video to total audio length,
 * muxes the merged audio, and ensures all steps are logged.
 */
async function muxMegaSceneWithNarration(videoIn, audioIn, outPath) {
  console.log(`[5F][MEGA] muxMegaSceneWithNarration called: video="${videoIn}" audio="${audioIn}" out="${outPath}"`);

  // Get total audio duration using ffprobe
  const getAudioDuration = (file) => {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, metadata) => {
        if (err) {
          console.error(`[5F][MEGA][ERR] Failed to ffprobe audio: ${file}`, err);
          return reject(err);
        }
        const duration = metadata && metadata.format ? metadata.format.duration : 0;
        if (!duration || isNaN(duration)) {
          console.error(`[5F][MEGA][ERR] Could not get duration from audio: ${file}`);
          return reject(new Error('Audio duration not found'));
        }
        resolve(duration);
      });
    });
  };

  let audioDuration = 0;
  try {
    audioDuration = await getAudioDuration(audioIn);
    console.log(`[5F][MEGA] Detected audio duration for mega-scene: ${audioDuration}s`);
  } catch (err) {
    throw new Error(`[5F][MEGA][ERR] Cannot get audio duration for mega-scene: ${err}`);
  }

  // Trim input video to exact audio duration (if needed)
  const trimmedVideo = path.resolve(path.dirname(outPath), `tmp-trimmed-megascene-${Date.now()}.mp4`);
  try {
    await trimVideo(videoIn, trimmedVideo, audioDuration, 0);
    console.log(`[5F][MEGA] Trimmed main subject video for mega-scene: ${trimmedVideo}`);
  } catch (err) {
    console.error(`[5F][MEGA][ERR] Failed to trim mega-scene video`, err);
    throw err;
  }

  // Mux merged audio to trimmed video
  try {
    await muxVideoWithNarration(trimmedVideo, audioIn, outPath, audioDuration);
    console.log(`[5F][MEGA] Muxed merged mega-scene audio to trimmed video: ${outPath}`);
    // Cleanup
    if (fs.existsSync(trimmedVideo)) {
      fs.unlinkSync(trimmedVideo);
      console.log(`[5F][MEGA][CLEANUP] Deleted trimmed temp video: ${trimmedVideo}`);
    }
  } catch (err) {
    console.error(`[5F][MEGA][ERR] Failed to mux mega-scene audio/video`, err);
    throw err;
  }
}

module.exports = {
  trimVideo,
  normalizeTo9x16Blurred,
  addSilentAudioTrack,
  muxVideoWithNarration,
  muxMegaSceneWithNarration,
};
