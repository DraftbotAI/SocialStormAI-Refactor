// ===========================================================
// SECTION 5F: VIDEO PROCESSING & AV COMBINER
// Handles trimming, normalizing, silent audio, muxing narration onto video
// MAX LOGGING AT EVERY STEP, VIRAL PORTRAIT BLUR, NO STRETCH, NO BLACK BARS
// Aspect always forced to 1080x1920 (portrait)
// ===========================================================

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

console.log('[5F][INIT] Video processing & AV combiner loaded.');

// =====================
// UTILITY: ASSERT FILE
// =====================
function assertFile(file, minSize = 10240, label = 'FILE') {
  if (!fs.existsSync(file)) {
    throw new Error(`[5F][${label}][ERR] File does not exist: ${file}`);
  }
  const sz = fs.statSync(file).size;
  if (sz < minSize) {
    throw new Error(`[5F][${label}][ERR] File too small (${sz} bytes): ${file}`);
  }
}

// ======================
// UTILITY: GET DURATION
// ======================
async function getDuration(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) {
        console.error(`[5F][DURATION][ERR] Failed to ffprobe: ${file}`, err);
        return reject(err);
      }
      const duration = metadata && metadata.format ? metadata.format.duration : 0;
      if (!duration || isNaN(duration)) {
        console.error(`[5F][DURATION][ERR] Could not get duration: ${file}`);
        return reject(new Error('Duration not found'));
      }
      resolve(duration);
    });
  });
}

// ============================================================
// SCENE TRIM + BLUR: Always portrait 1080x1920, viral style!
// ============================================================
async function trimForNarration(inPath, outPath, audioDuration, leadIn = 0.5, trailOut = 1.0) {
  const duration = audioDuration + leadIn + trailOut;
  console.log(`[5F][TRIM] in="${inPath}" → out="${outPath}" | trim to ${duration}s`);
  // Command ensures viral blur with 9:16 output, with sharp video centered
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .inputOptions(['-y'])
      .setStartTime(0)
      .setDuration(duration)
      .outputOptions([
        '-filter_complex',
        // Viral portrait + blur + sharp center, for ANY source aspect ratio
        [
          "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease," +
          "pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[vmain];" + // Main sharp
          "[0:v]scale=1080:1920,boxblur=32:2[bg];" + // Massive blur
          "[bg][vmain]overlay=(W-w)/2:(H-h)/2,format=yuv420p"
        ].join(""),
        '-r 30',
        '-an', // Remove original audio
        '-pix_fmt yuv420p',
        '-y'
      ])
      .on('start', cmd => console.log(`[5F][TRIM][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][TRIM][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'TRIM_OUT');
          console.log(`[5F][TRIM] ✅ Trimmed video saved: ${outPath}`);
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
      .save(outPath);
  });
}

// ============================================================
// SCENE MUX: Mux sharp portrait video (trimmed) with narration
// ============================================================
async function muxVideoWithNarration(videoIn, audioIn, outPath) {
  console.log(`[5F][MUX] muxVideoWithNarration: video="${videoIn}", audio="${audioIn}", out="${outPath}"`);
  let audioDuration;
  try {
    audioDuration = await getDuration(audioIn);
    console.log(`[5F][MUX] Voiceover duration = ${audioDuration}s`);
  } catch (err) {
    throw new Error(`[5F][MUX][ERR] Cannot get audio duration: ${err}`);
  }

  const trimmedVideo = path.resolve(path.dirname(outPath), `tmp-trimmed-scene-${Date.now()}-${Math.floor(Math.random()*99999)}.mp4`);
  let trimDone = false;

  try {
    await trimForNarration(videoIn, trimmedVideo, audioDuration, 0.5, 1.0);
    trimDone = true;
  } catch (err) {
    throw new Error(`[5F][MUX][ERR] Failed to trim video for narration: ${err}`);
  }

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(trimmedVideo)
      .input(audioIn)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        '-c:v libx264',
        '-c:a aac',
        '-b:v 2200k',
        '-b:a 160k',
        '-shortest',
        '-preset ultrafast',
        '-pix_fmt yuv420p',
        '-y'
      ])
      .on('start', cmd => console.log(`[5F][MUX][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][MUX][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'MUX_OUT');
          console.log(`[5F][MUX] ✅ Muxed video saved: ${outPath}`);
        } catch (e) {
          console.error(`[5F][MUX][ERR] Final mux validation failed: ${e.message}`);
          return reject(e);
        }
        try {
          if (trimDone && fs.existsSync(trimmedVideo)) {
            fs.unlinkSync(trimmedVideo);
            console.log(`[5F][MUX][CLEANUP] Deleted temp file: ${trimmedVideo}`);
          }
        } catch (e) {
          console.warn(`[5F][MUX][WARN] Could not delete temp trimmed file: ${trimmedVideo}`, e);
        }
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][MUX][ERR] FFmpeg mux failed:`, err);
        if (stderr) console.error(`[5F][MUX][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][MUX][STDOUT]\n${stdout}`);
        try {
          if (trimDone && fs.existsSync(trimmedVideo)) {
            fs.unlinkSync(trimmedVideo);
            console.log(`[5F][MUX][CLEANUP] Deleted temp file after error: ${trimmedVideo}`);
          }
        } catch (e) {}
        reject(err);
      })
      .save(outPath);
  });
}

// ============================================================
// MEGA-SCENE MUX: For hook + main scene (multi-line audio)
// ============================================================
async function muxMegaSceneWithNarration(videoIn, audioIn, outPath) {
  console.log(`[5F][MEGA] muxMegaSceneWithNarration: video="${videoIn}", audio="${audioIn}", out="${outPath}"`);
  let audioDuration;
  try {
    audioDuration = await getDuration(audioIn);
    console.log(`[5F][MEGA] Narration duration: ${audioDuration}s`);
  } catch (err) {
    throw new Error(`[5F][MEGA][ERR] Cannot get duration: ${err}`);
  }

  const trimmedVideo = path.resolve(path.dirname(outPath), `tmp-trimmed-megascene-${Date.now()}-${Math.floor(Math.random()*99999)}.mp4`);
  let trimDone = false;

  try {
    await trimForNarration(videoIn, trimmedVideo, audioDuration, 0.5, 1.0);
    trimDone = true;
    await muxVideoWithNarration(trimmedVideo, audioIn, outPath);
    if (trimDone && fs.existsSync(trimmedVideo)) {
      fs.unlinkSync(trimmedVideo);
      console.log(`[5F][MEGA][CLEANUP] Deleted temp file: ${trimmedVideo}`);
    }
    console.log(`[5F][MEGA] ✅ Mega-scene complete and cleaned up.`);
  } catch (err) {
    console.error(`[5F][MEGA][ERR] Mega-scene failed:`, err);
    try {
      if (trimDone && fs.existsSync(trimmedVideo)) {
        fs.unlinkSync(trimmedVideo);
        console.log(`[5F][MEGA][CLEANUP] Deleted temp file after error: ${trimmedVideo}`);
      }
    } catch (e) {}
    throw err;
  }
}

// ============================================================
// ADD SILENT AUDIO TO VIDEO (for Ken Burns, image videos)
// ============================================================
async function addSilentAudioTrack(inPath, outPath, duration) {
  console.log(`[5F][AUDIO] Adding silent audio: ${inPath} → ${outPath} (duration: ${duration})`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inPath)
      .input('anullsrc=channel_layout=stereo:sample_rate=44100')
      .inputOptions(['-f lavfi'])
      .outputOptions([
        '-shortest',
        '-c:v copy',
        '-c:a aac',
        '-pix_fmt yuv420p',
        '-y'
      ])
      .duration(duration)
      .on('start', cmd => console.log(`[5F][AUDIO][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][AUDIO][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'AUDIO_OUT');
          console.log(`[5F][AUDIO] ✅ Silent audio added: ${outPath}`);
          resolve();
        } catch (e) {
          console.error(`[5F][AUDIO][ERR] Validation failed: ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][AUDIO][ERR] FFmpeg silent audio failed:`, err);
        if (stderr) console.error(`[5F][AUDIO][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][AUDIO][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(outPath);
  });
}

// ===================
// MODULE EXPORTS
// ===================
module.exports = {
  getDuration,
  trimForNarration,
  addSilentAudioTrack,
  muxVideoWithNarration,
  muxMegaSceneWithNarration
};
