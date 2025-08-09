// ===========================================================
// SECTION 5F: VIDEO PROCESSING & AV COMBINER  (Hardened)
// Handles trimming, normalizing, silent audio, muxing narration onto video
// MAX LOGGING AT EVERY STEP, VIRAL PORTRAIT BLUR, NO STRETCH, NO BLACK BARS
// Scene logic: 0.5s pre-voice, +1s post-voice. Scene 1+2 can share video.
// Aspect always forced to 1080x1920 (portrait)
// Bulletproof: sanitize flaky inputs (MOV/partial MP4), retry trim once
// ===========================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');

console.log('[5F][INIT] Video processing & AV combiner loaded (hardened).');

const PORTRAIT_W = 1080;
const PORTRAIT_H = 1920;

// =====================
// UTILITY: ASSERT FILE
// =====================
function assertFile(file, minSize = 10240, label = 'FILE') {
  if (!file || typeof file !== 'string' || file.includes('s3://') || file.startsWith('http')) {
    throw new Error(`[5F][${label}][ERR] File is not a local file: ${file}`);
  }
  if (!fs.existsSync(file)) {
    throw new Error(`[5F][${label}][ERR] File does not exist: ${file}`);
  }
  const sz = fs.statSync(file).size;
  if (sz < minSize) {
    throw new Error(`[5F][${label}][ERR] File too small (${sz} bytes): ${file}`);
  }
  console.log(`[5F][${label}][OK] File exists (${sz} bytes): ${file}`);
}

// ======================
// UTILITY: GET DURATION
// ======================
async function getDuration(file) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) {
      console.error(`[5F][DURATION][ERR] File does not exist: ${file}`);
      return reject(new Error('File does not exist'));
    }
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) {
        console.error(`[5F][DURATION][ERR] ffprobe failed: ${file}`, err);
        return reject(err);
      }
      const duration = metadata && metadata.format ? Number(metadata.format.duration) : 0;
      if (!duration || isNaN(duration)) {
        console.error(`[5F][DURATION][ERR] Could not get duration: ${file}`);
        return reject(new Error('Duration not found'));
      }
      console.log(`[5F][DURATION][OK] ${file} duration: ${duration}`);
      resolve(duration);
    });
  });
}

// ===================================
// UTILITY: MP3 → WAV (for safe mux)
// ===================================
async function convertMp3ToWav(mp3Path, wavPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(mp3Path)
      .toFormat('wav')
      .audioFrequency(44100)
      .audioChannels(2)
      .on('start', cmd => console.log(`[5F][MP3->WAV][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][MP3->WAV][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(wavPath, 1000, 'WAV_OUT');
          console.log(`[5F][MP3->WAV] ✅ Converted: ${wavPath}`);
          resolve();
        } catch (e) {
          console.error(`[5F][MP3->WAV][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][MP3->WAV][ERR]`, err);
        if (stderr) console.error(`[5F][MP3->WAV][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][MP3->WAV][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(wavPath);
  });
}

// ============================================================
// SANITIZE: Re-encode flaky/partial inputs to clean H.264 MP4
// - Constant keyframe interval (gop=30 @ 30fps)
// - yuv420p, faststart, single video track, no audio
// ============================================================
async function sanitizeForTrim(inPath, outPath) {
  console.log(`[5F][SANITIZE][START] ${inPath} → ${outPath}`);
  assertFile(inPath, 4096, 'SANITIZE_SRC');

  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .inputOptions([
        '-y',
        '-analyzeduration', '200M',
        '-probesize', '200M',
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-err_detect', 'ignore_err'
      ])
      .outputOptions([
        '-map', '0:v:0',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'fastdecode',
        '-r', '30',
        '-g', '30',
        '-keyint_min', '30',
        '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-an',            // drop audio here; we mux narration later
        '-vsync', 'vfr',
        '-y'
      ])
      .on('start', cmd => console.log(`[5F][SANITIZE][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][SANITIZE][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'SANITIZE_OUT');
          console.log(`[5F][SANITIZE][OK] Clean MP4 ready: ${outPath}`);
          resolve();
        } catch (e) {
          console.error(`[5F][SANITIZE][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error('[5F][SANITIZE][ERR] FFmpeg sanitize failed:', err);
        if (stderr) console.error(`[5F][SANITIZE][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][SANITIZE][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(outPath);
  });
}

// ============================================================
// FILTER: Portrait + blurred background overlay (no stretch)
// ============================================================
function buildPortraitFilter() {
  // Foreground: scale into 1080x1920 with preserved AR + pad
  // Background: scaled to fill and heavily blurred; overlay center
  return [
    `[0:v]scale=${PORTRAIT_W}:${PORTRAIT_H}:force_original_aspect_ratio=decrease`,
    `pad=${PORTRAIT_W}:${PORTRAIT_H}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    'format=yuv420p',
    '[vmain];',
    `[0:v]scale=${PORTRAIT_W}:${PORTRAIT_H}`,
    'boxblur=32:2',
    '[bg];',
    '[bg][vmain]overlay=(W-w)/2:(H-h)/2,format=yuv420p'
  ].join(',');
}

// ============================================================
// TRIM FOR NARRATION (Scene 3+): 0.5s pre-voice, 1.0s post-voice
// Hardened: try once; on failure sanitize input then retry
// ============================================================
async function trimForNarration(inPath, outPath, audioDuration, options = {}) {
  let leadIn = 0.5, trailOut = 1.0, loop = false;
  if (typeof options === 'object' && options !== null) {
    leadIn = options.leadIn ?? 0.5;
    trailOut = options.trailOut ?? 1.0;
    loop = !!options.loop;
  }

  assertFile(inPath, 10000, 'TRIM_IN');

  const duration = Math.max(0.25, Number(audioDuration || 0) + leadIn + trailOut);
  console.log(`[5F][TRIM] in="${inPath}" → out="${outPath}" | ${duration}s | loop=${loop}`);

  const runTrim = src =>
    new Promise((resolve, reject) => {
      let cmd = ffmpeg(src)
        .inputOptions([
          '-y',
          '-analyzeduration', '200M',
          '-probesize', '200M',
          '-fflags', '+genpts+igndts+discardcorrupt',
          '-err_detect', 'ignore_err',
          ...(loop ? ['-stream_loop', '-1'] : [])
        ])
        .setStartTime(0)
        .setDuration(duration)
        .outputOptions([
          '-filter_complex', buildPortraitFilter(),
          '-r', '30',
          '-an',
          '-pix_fmt', 'yuv420p',
          '-vsync', 'vfr',
          '-g', '30',
          '-keyint_min', '30',
          '-sc_threshold', '0',
          '-movflags', '+faststart',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-tune', 'fastdecode',
          '-y'
        ])
        .on('start', c => console.log(`[5F][TRIM][CMD] ${c}`))
        .on('stderr', line => console.log(`[5F][TRIM][STDERR] ${line}`))
        .on('end', () => {
          try {
            assertFile(outPath, 10240, 'TRIM_OUT');
            console.log(`[5F][TRIM] ✅ Saved: ${outPath}`);
            resolve();
          } catch (e) {
            console.error(`[5F][TRIM][ERR] ${e.message}`);
            reject(e);
          }
        })
        .on('error', (err, stdout, stderr) => {
          console.error(`[5F][TRIM][ERR] FFmpeg trim failed:`, err);
          if (stderr) console.error(`[5F][TRIM][FFMPEG][STDERR]\n${stderr}`);
          if (stdout) console.log(`[5F][TRIM][FFMPEG][STDOUT]\n${stdout}`);
          reject(err);
        });

      cmd.save(outPath);
    });

  // 1st attempt
  try {
    await runTrim(inPath);
    return;
  } catch (firstErr) {
    console.warn(`[5F][TRIM][RETRY] First trim failed. Sanitizing and retrying... (${firstErr && firstErr.message})`);
  }

  // Sanitize & retry
  const sanitized = path.join(
    os.tmpdir(),
    `ssai-sanitized-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`
  );

  await sanitizeForTrim(inPath, sanitized);
  try {
    await runTrim(sanitized);
  } finally {
    try { fs.unlinkSync(sanitized); } catch (_) {}
  }
}

// ============================================================
// MUX: Sync narration over *trimmed* video (no offset)
// Uses WAV to avoid MP3 mux quirks
// ============================================================
async function muxVideoWithNarration(videoIn, audioIn, outPath) {
  assertFile(videoIn, 10000, 'MUX_VIDEO_IN');
  assertFile(audioIn, 10000, 'MUX_AUDIO_IN');

  const videoDur = await getDuration(videoIn);
  const audioDur = await getDuration(audioIn);
  console.log(`[5F][MUX] video="${videoIn}" (${videoDur}s) + audio="${audioIn}" (${audioDur}s) → ${outPath}`);

  const wavTemp = path.join(os.tmpdir(), `ssai-wav-${Date.now()}-${Math.floor(Math.random() * 999999)}.wav`);
  await convertMp3ToWav(audioIn, wavTemp);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoIn)
      .input(wavTemp)
      .inputOptions(['-y'])
      .outputOptions([
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-b:v', '2200k',
        '-b:a', '160k',
        '-ar', '44100',
        '-ac', '2',
        '-shortest',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y'
      ])
      .on('start', cmd => console.log(`[5F][MUX][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][MUX][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'MUX_OUT');
          console.log(`[5F][MUX] ✅ Muxed: ${outPath}`);
          try { fs.unlinkSync(wavTemp); } catch (_) {}
          resolve();
        } catch (e) {
          console.error(`[5F][MUX][ERR] ${e.message}`);
          try { fs.unlinkSync(wavTemp); } catch (_) {}
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error('[5F][MUX][ERR] FFmpeg mux failed:', err);
        if (stderr) console.error(`[5F][MUX][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][MUX][STDOUT]\n${stdout}`);
        try { fs.unlinkSync(wavTemp); } catch (_) {}
        reject(err);
      })
      .save(outPath);
  });
}

// ============================================================
// ADD SILENT AUDIO TO VIDEO (for Ken Burns, etc.)
// ============================================================
async function addSilentAudioTrack(inPath, outPath, duration) {
  assertFile(inPath, 10000, 'AUDIOLESS_IN');
  console.log(`[5F][AUDIO] Adding silent track: ${inPath} → ${outPath} (duration ~${duration}s)`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inPath)
      .input('anullsrc=channel_layout=stereo:sample_rate=44100')
      .inputOptions(['-f', 'lavfi', '-y'])
      .outputOptions([
        '-shortest',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ar', '44100',
        '-ac', '2',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
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
          console.error(`[5F][AUDIO][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error('[5F][AUDIO][ERR] FFmpeg failed:', err);
        if (stderr) console.error(`[5F][AUDIO][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][AUDIO][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(outPath);
  });
}

// ============================================================
// OPTIONAL: Split video for first two scenes (legacy helper)
// ============================================================
async function splitVideoForFirstTwoScenes(videoIn, audio1, audio2, outDir = path.dirname(videoIn)) {
  console.log(`[5F][SPLIT][START] Splitting "${videoIn}" for scenes 1+2...`);
  assertFile(videoIn, 10000, 'VIDEO_IN');
  assertFile(audio1, 10000, 'AUDIO1');
  assertFile(audio2, 10000, 'AUDIO2');

  const dur1 = await getDuration(audio1);
  const dur2 = await getDuration(audio2);

  const scene1Len = 0.5 + dur1 + 1.0;
  const scene2Len = 0.5 + dur2 + 1.0;

  let videoTotalLen = 0;
  try { videoTotalLen = await getDuration(videoIn); } catch (err) {
    console.error(`[5F][SPLIT][ERR] Could not get video duration: ${err}`);
  }

  const scene1Start = 0;
  const scene2Start = (videoTotalLen >= scene1Len + scene2Len) ? scene1Len : 0;

  const scene1Path = path.resolve(outDir, `scene1-${Date.now()}-${Math.floor(Math.random() * 99999)}.mp4`);
  const scene2Path = path.resolve(outDir, `scene2-${Date.now()}-${Math.floor(Math.random() * 99999)}.mp4`);

  const portraitFilter = buildPortraitFilter();

  // SCENE 1
  await new Promise((resolve, reject) => {
    ffmpeg(videoIn)
      .inputOptions(['-y', '-fflags', '+genpts+igndts+discardcorrupt', '-err_detect', 'ignore_err'])
      .setStartTime(scene1Start)
      .setDuration(scene1Len)
      .outputOptions([
        '-filter_complex', portraitFilter,
        '-r', '30',
        '-an',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'fastdecode',
        '-y'
      ])
      .on('start', cmd => console.log(`[5F][SPLIT][SCENE1][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][SPLIT][SCENE1][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(scene1Path, 10240, 'SCENE1');
          console.log(`[5F][SPLIT][SCENE1] ✅ Saved: ${scene1Path}`);
          resolve();
        } catch (e) { console.error(`[5F][SPLIT][SCENE1][ERR] ${e.message}`); reject(e); }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][SPLIT][SCENE1][ERR]`, err);
        if (stderr) console.error(`[5F][SPLIT][SCENE1][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][SPLIT][SCENE1][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(scene1Path);
  });

  // SCENE 2
  await new Promise((resolve, reject) => {
    ffmpeg(videoIn)
      .inputOptions(['-y', '-fflags', '+genpts+igndts+discardcorrupt', '-err_detect', 'ignore_err'])
      .setStartTime(scene2Start)
      .setDuration(scene2Len)
      .outputOptions([
        '-filter_complex', portraitFilter,
        '-r', '30',
        '-an',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'fastdecode',
        '-y'
      ])
      .on('start', cmd => console.log(`[5F][SPLIT][SCENE2][CMD] ${cmd}`))
      .on('stderr', line => console.log(`[5F][SPLIT][SCENE2][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(scene2Path, 10240, 'SCENE2');
          console.log(`[5F][SPLIT][SCENE2] ✅ Saved: ${scene2Path}`);
          resolve();
        } catch (e) { console.error(`[5F][SPLIT][SCENE2][ERR] ${e.message}`); reject(e); }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5F][SPLIT][SCENE2][ERR]`, err);
        if (stderr) console.error(`[5F][SPLIT][SCENE2][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5F][SPLIT][SCENE2][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(scene2Path);
  });

  return [scene1Path, scene2Path];
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
