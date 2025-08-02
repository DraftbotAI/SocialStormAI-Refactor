// ===========================================================
// SECTION 5F: VIDEO PROCESSING & AV COMBINER
// Handles trimming, normalizing, silent audio, muxing narration onto video
// MAX LOGGING AT EVERY STEP, VIRAL PORTRAIT BLUR, NO STRETCH, NO BLACK BARS
// Scene logic: 0.5s pre-voice, +1s post-voice. Scene 1+2 share video, different lines.
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
// SCENE BUILDER: Slices video for scene 1 & 2 (shared clip, two lines)
// Returns [scene1Path, scene2Path] with perfect splits and offsets
// ============================================================
async function splitVideoForFirstTwoScenes(
  videoIn, 
  audio1, 
  audio2, 
  outDir = path.dirname(videoIn)
) {
  console.log(`[5F][SPLIT][START] Splitting "${videoIn}" for scenes 1+2, two voice lines...`);
  // Get durations of both voice lines
  const dur1 = await getDuration(audio1);
  const dur2 = await getDuration(audio2);

  // Scene lengths with offsets
  const scene1Len = 0.5 + dur1 + 1.0;
  const scene2Len = 0.5 + dur2 + 1.0;

  // Outputs
  const scene1Path = path.resolve(outDir, `scene1-${Date.now()}-${Math.floor(Math.random()*99999)}.mp4`);
  const scene2Path = path.resolve(outDir, `scene2-${Date.now()}-${Math.floor(Math.random()*99999)}.mp4`);

  // 1. Scene 1: [0, scene1Len]
  await new Promise((resolve, reject) => {
    ffmpeg(videoIn)
      .inputOptions(['-y'])
      .setStartTime(0)
      .setDuration(scene1Len)
      .outputOptions([
        '-filter_complex',
        "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[vmain];" +
        "[0:v]scale=1080:1920,boxblur=32:2[bg];" +
        "[bg][vmain]overlay=(W-w)/2:(H-h)/2,format=yuv420p",
        '-r 30',
        '-an',
        '-pix_fmt yuv420p',
        '-y'
      ])
      .on('start', cmd => console.log(`[5F][SPLIT][SCENE1][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][SPLIT][SCENE1][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(scene1Path, 10240, 'SCENE1');
          console.log(`[5F][SPLIT][SCENE1] ✅ Saved: ${scene1Path}`);
          resolve();
        } catch (e) {
          console.error(`[5F][SPLIT][SCENE1][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][SPLIT][SCENE1][ERR] FFmpeg error during trim:`, err);
        if (stderr) console.error(`[5F][SPLIT][SCENE1][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][SPLIT][SCENE1][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(scene1Path);
  });

  // 2. Scene 2: [scene1Len, scene1Len+scene2Len]
  await new Promise((resolve, reject) => {
    ffmpeg(videoIn)
      .inputOptions(['-y'])
      .setStartTime(scene1Len)
      .setDuration(scene2Len)
      .outputOptions([
        '-filter_complex',
        "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[vmain];" +
        "[0:v]scale=1080:1920,boxblur=32:2[bg];" +
        "[bg][vmain]overlay=(W-w)/2:(H-h)/2,format=yuv420p",
        '-r 30',
        '-an',
        '-pix_fmt yuv420p',
        '-y'
      ])
      .on('start', cmd => console.log(`[5F][SPLIT][SCENE2][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][SPLIT][SCENE2][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(scene2Path, 10240, 'SCENE2');
          console.log(`[5F][SPLIT][SCENE2] ✅ Saved: ${scene2Path}`);
          resolve();
        } catch (e) {
          console.error(`[5F][SPLIT][SCENE2][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][SPLIT][SCENE2][ERR] FFmpeg error during trim:`, err);
        if (stderr) console.error(`[5F][SPLIT][SCENE2][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][SPLIT][SCENE2][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(scene2Path);
  });

  return [scene1Path, scene2Path, scene1Len, scene2Len];
}

// ============================================================
// TRIM FOR NARRATION (Scene 3+): 0.5s pre-voice, 1.0s post-voice
// ============================================================
async function trimForNarration(inPath, outPath, audioDuration, leadIn = 0.5, trailOut = 1.0) {
  const duration = audioDuration + leadIn + trailOut;
  console.log(`[5F][TRIM] in="${inPath}" → out="${outPath}" | trim to ${duration}s`);
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .inputOptions(['-y'])
      .setStartTime(0)
      .setDuration(duration)
      .outputOptions([
        '-filter_complex',
        "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[vmain];" +
        "[0:v]scale=1080:1920,boxblur=32:2[bg];" +
        "[bg][vmain]overlay=(W-w)/2:(H-h)/2,format=yuv420p",
        '-r 30',
        '-an',
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
// MUX: Syncs narration over video with 0.5s offset, pads audio to fit video
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
  // Final video should already be trimmed
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoIn)
      .input(audioIn)
      .inputOptions(['-y'])
      // Add -itsoffset for 0.5s delayed narration
      .inputOption('-itsoffset 0.5')
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
          resolve();
        } catch (e) {
          console.error(`[5F][MUX][ERR] Final mux validation failed: ${e.message}`);
          return reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][MUX][ERR] FFmpeg mux failed:`, err);
        if (stderr) console.error(`[5F][MUX][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][MUX][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(outPath);
  });
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
  splitVideoForFirstTwoScenes
};
