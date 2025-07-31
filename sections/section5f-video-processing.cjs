// ===========================================================
// SECTION 5F: VIDEO PROCESSING & AV COMBINER
// Handles trimming, normalizing, silent audio, muxing narration onto video
// MAX LOGGING AT EVERY STEP
// Enhanced: Mega-scene (multi-line audio) support
// Improved: Trims 0.5s BEFORE voice, ends 1s AFTER voice ends
// ===========================================================

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

console.log('[5F][INIT] Video processing & AV combiner loaded.');

function assertFile(file, minSize = 10240, label = 'FILE') {
  if (!fs.existsSync(file)) {
    throw new Error(`[5F][${label}][ERR] File does not exist: ${file}`);
  }
  const sz = fs.statSync(file).size;
  if (sz < minSize) {
    throw new Error(`[5F][${label}][ERR] File too small (${sz} bytes): ${file}`);
  }
}

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

/**
 * Trims a video file for a scene: starts 0.5s before audio, ends 1s after audio.
 */
async function trimForNarration(inPath, outPath, audioDuration, leadIn = 0.5, trailOut = 1.0) {
  let videoStart = Math.max(0, 0 - leadIn); // normally 0, could allow per-clip offset in future
  let duration = audioDuration + leadIn + trailOut;
  videoStart = 0; // Always start at the beginning unless you want to add "late entry"
  console.log(`[5F][TRIM] trimForNarration: in="${inPath}" out="${outPath}" start=${videoStart}s duration=${duration}s`);
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .setStartTime(videoStart)
      .setDuration(duration)
      .outputOptions([
        '-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1'
      ])
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
 * Muxes a narration audio file onto a video file, using 0.5s lead-in, 1.0s trail-out.
 */
async function muxVideoWithNarration(videoIn, audioIn, outPath) {
  console.log(`[5F][MUX] muxVideoWithNarration called: video="${videoIn}" audio="${audioIn}" out="${outPath}"`);
  let audioDuration = 0;
  try {
    audioDuration = await getDuration(audioIn);
    console.log(`[5F][MUX] Detected audio duration: ${audioDuration}s`);
  } catch (err) {
    throw new Error(`[5F][MUX][ERR] Cannot get audio duration: ${err}`);
  }
  // Trim video: 0.5s before, 1.0s after audio
  const trimmedVideo = path.resolve(path.dirname(outPath), `tmp-trimmed-scene-${Date.now()}.mp4`);
  try {
    await trimForNarration(videoIn, trimmedVideo, audioDuration, 0.5, 1.0);
    console.log(`[5F][MUX] Trimmed video for narration: ${trimmedVideo}`);
  } catch (err) {
    console.error(`[5F][MUX][ERR] Failed to trim video`, err);
    throw err;
  }
  // Mux audio to trimmed video
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(trimmedVideo)
      .input(audioIn)
      .outputOptions([
        '-shortest', // Stops when shortest stream ends (voice)
        '-c:v copy',
        '-c:a aac',
        '-y'
      ])
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
          if (fs.existsSync(trimmedVideo)) {
            fs.unlinkSync(trimmedVideo);
            console.log(`[5F][MUX][CLEANUP] Deleted trimmed temp video: ${trimmedVideo}`);
          }
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
 * Handles "mega-scene" (scene 1+2): trims video 0.5s before, 1s after voice, perfect for viral hooks.
 */
async function muxMegaSceneWithNarration(videoIn, audioIn, outPath) {
  console.log(`[5F][MEGA] muxMegaSceneWithNarration called: video="${videoIn}" audio="${audioIn}" out="${outPath}"`);
  let audioDuration = 0;
  try {
    audioDuration = await getDuration(audioIn);
    console.log(`[5F][MEGA] Detected audio duration for mega-scene: ${audioDuration}s`);
  } catch (err) {
    throw new Error(`[5F][MEGA][ERR] Cannot get audio duration for mega-scene: ${err}`);
  }
  const trimmedVideo = path.resolve(path.dirname(outPath), `tmp-trimmed-megascene-${Date.now()}.mp4`);
  try {
    await trimForNarration(videoIn, trimmedVideo, audioDuration, 0.5, 1.0);
    console.log(`[5F][MEGA] Trimmed main subject video for mega-scene: ${trimmedVideo}`);
  } catch (err) {
    console.error(`[5F][MEGA][ERR] Failed to trim mega-scene video`, err);
    throw err;
  }
  try {
    await muxVideoWithNarration(trimmedVideo, audioIn, outPath);
    console.log(`[5F][MEGA] Muxed merged mega-scene audio to trimmed video: ${outPath}`);
    if (fs.existsSync(trimmedVideo)) {
      fs.unlinkSync(trimmedVideo);
      console.log(`[5F][MEGA][CLEANUP] Deleted trimmed temp video: ${trimmedVideo}`);
    }
  } catch (err) {
    console.error(`[5F][MEGA][ERR] Failed to mux mega-scene audio/video`, err);
    throw err;
  }
}

// Silent audio helper remains, unchanged:
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

module.exports = {
  getDuration,
  trimForNarration,
  addSilentAudioTrack,
  muxVideoWithNarration,
  muxMegaSceneWithNarration
};
