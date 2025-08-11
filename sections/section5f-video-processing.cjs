// ===========================================================
// SECTION 5F: VIDEO PROCESSING & AV COMBINER (2025-08 FIX2)
// Handles trimming, normalizing, silent audio, muxing narration onto video
// MAX LOGGING AT EVERY STEP, VIRAL PORTRAIT BLUR, NO STRETCH, NO BLACK BARS
// Scene logic: 0.5s pre-voice, +1.0s post-voice by default
// Aspect 1080x1920 portrait, 30fps, yuv420p, faststart
// Bulletproof: trim in filtergraph (no mid-GOP seek), CFR output
// CHANGE: replace deprecated/contradictory `-vsync 2` with `-fps_mode cfr`
//
// 2025-08 hotfix:
// - Foreground path now uses `force_original_aspect_ratio=decrease` before pad,
//   plus a safety crop after overlay to prevent "Padded dimensions smaller than input".
// ===========================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');

const TAG = '[5F]';
console.log(`${TAG}[INIT] Video processing & AV combiner loaded.`);

// =====================
// UTILITY: ASSERT FILE
// =====================
function assertFile(file, minSize = 10240, label = 'FILE') {
  if (!file || typeof file !== 'string' || file.includes('s3://') || file.startsWith('http')) {
    throw new Error(`${TAG}[${label}][ERR] File is not a local file: ${file}`);
  }
  if (!fs.existsSync(file)) {
    throw new Error(`${TAG}[${label}][ERR] File does not exist: ${file}`);
  }
  const sz = fs.statSync(file).size;
  if (sz < minSize) {
    throw new Error(`${TAG}[${label}][ERR] File too small (${sz} bytes): ${file}`);
  }
  console.log(`${TAG}[${label}][OK] ${file} (${sz} bytes)`);
}

// ======================
// UTILITY: GET DURATION
// ======================
async function getDuration(file) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) {
      console.error(`${TAG}[DURATION][ERR] File does not exist: ${file}`);
      return reject(new Error('File does not exist'));
    }
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) {
        console.error(`${TAG}[DURATION][ERR] ffprobe failed for: ${file}`, err);
        return reject(err);
      }
      const duration = metadata?.format?.duration || 0;
      if (!duration || isNaN(duration)) {
        console.error(`${TAG}[DURATION][ERR] Could not get duration: ${file}`);
        return reject(new Error('Duration not found'));
      }
      console.log(`${TAG}[DURATION][OK] ${path.basename(file)} = ${duration.toFixed(3)}s`);
      resolve(duration);
    });
  });
}

// ======================
// UTILITY: CONVERT MP3→WAV
// ======================
async function convertMp3ToWav(mp3Path, wavPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(mp3Path)
      .audioChannels(1)
      .audioFrequency(48000)
      .toFormat('wav')
      .on('start', cmd => console.log(`${TAG}[MP3->WAV][CMD] ${cmd}`))
      .on('stderr', line => console.log(`${TAG}[MP3->WAV][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(wavPath, 1000, 'WAV_OUT');
          console.log(`${TAG}[MP3->WAV][OK] ${wavPath}`);
          resolve();
        } catch (e) {
          console.error(`${TAG}[MP3->WAV][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`${TAG}[MP3->WAV][ERR]`, err);
        if (stderr) console.error(`${TAG}[MP3->WAV][STDERR]\n${stderr}`);
        if (stdout) console.log(`${TAG}[MP3->WAV][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(wavPath);
  });
}

// ============================================================
// INTERNAL: Build portrait trim+blur graph (CFR, no mid-GOP seek)
// ============================================================
function buildPortraitTrimFilter(startSec, endSec, totalDur, tailSec) {
  const s = Math.max(0, Number(startSec) || 0);
  const e = Math.max(s, Number(endSec) || s);
  const dur = Math.max(0.2, Number(totalDur) || (e - s));
  const tail = Math.max(0, Number(tailSec) || 0);

  // Notes:
  // - Background: scale with "increase" then crop to guaranteed 1080x1920, add blur.
  // - Foreground: scale with "decrease" so result is <= 1080x1920, then pad to exact 1080x1920.
  //   This avoids "Padded dimensions cannot be smaller than input" when source is taller than 1920.
  // - Safety crop after overlay to guard against rounding anomalies.
  return [
    `[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v0]`,
    `[v0]split=2[v1][v2]`,
    // Background (blurred fill)
    `[v1]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=32:2[bg]`,
    // Foreground (content): fit inside, then pad
    `[v2]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[fg]`,
    // Composite + safety crop + tpad tail + trim to dur
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,` +
      `crop='min(iw,1080)':'min(ih,1920)':(iw-1080)/2:(ih-1920)/2,` +
      `format=yuv420p,` +
      `tpad=stop_mode=clone:stop_duration=${tail.toFixed(3)},` +
      `trim=0:${dur.toFixed(3)},setpts=N/FRAME_RATE/TB[vout]`
  ].join(';');
}

// ============================================================
// SCENE 1+2 SPLIT (shared clip, two lines) – CFR, no -vsync
// ============================================================
async function splitVideoForFirstTwoScenes(videoIn, audio1, audio2, outDir = path.dirname(videoIn)) {
  console.log(`${TAG}[SPLIT][START] "${videoIn}" + two voice lines`);
  assertFile(videoIn, 10000, 'VIDEO_IN');
  assertFile(audio1, 10000, 'AUDIO1');
  assertFile(audio2, 10000, 'AUDIO2');

  const dur1 = await getDuration(audio1);
  const dur2 = await getDuration(audio2);

  const head = 0.5;
  const tail = 1.0;
  const scene1Len = head + dur1 + tail;
  const scene2Len = head + dur2 + tail;

  let videoTotalLen = 0;
  try { videoTotalLen = await getDuration(videoIn); } catch {}

  const scene1Start = 0;
  const scene2Start = (videoTotalLen >= scene1Len + scene2Len) ? scene1Len : 0;

  const scene1Path = path.resolve(outDir, `scene1-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
  const scene2Path = path.resolve(outDir, `scene2-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);

  await new Promise((resolve, reject) => {
    const filter = buildPortraitTrimFilter(scene1Start, scene1Start + scene1Len, scene1Len, tail);
    ffmpeg(videoIn)
      .inputOptions(['-y'])
      .outputOptions([
        '-filter_complex', filter,
        '-map', '[vout]',
        '-r', '30',
        '-fps_mode', 'cfr',
        '-an',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y'
      ])
      .on('start', cmd => console.log(`${TAG}[SPLIT][SCENE1][CMD] ${cmd}`))
      .on('stderr', line => console.log(`${TAG}[SPLIT][SCENE1][STDERR] ${line}`))
      .on('end', () => {
        try { assertFile(scene1Path, 10240, 'SCENE1_OUT'); console.log(`${TAG}[SPLIT][SCENE1][OK] ${scene1Path}`); resolve(); }
        catch (e) { console.error(`${TAG}[SPLIT][SCENE1][ERR] ${e.message}`); reject(e); }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`${TAG}[SPLIT][SCENE1][ERR]`, err);
        if (stderr) console.error(`${TAG}[SPLIT][SCENE1][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`${TAG}[SPLIT][SCENE1][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(scene1Path);
  });

  await new Promise((resolve, reject) => {
    const filter = buildPortraitTrimFilter(scene2Start, scene2Start + scene2Len, scene2Len, tail);
    ffmpeg(videoIn)
      .inputOptions(['-y'])
      .outputOptions([
        '-filter_complex', filter,
        '-map', '[vout]',
        '-r', '30',
        '-fps_mode', 'cfr',
        '-an',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y'
      ])
      .on('start', cmd => console.log(`${TAG}[SPLIT][SCENE2][CMD] ${cmd}`))
      .on('stderr', line => console.log(`${TAG}[SPLIT][SCENE2][STDERR] ${line}`))
      .on('end', () => {
        try { assertFile(scene2Path, 10240, 'SCENE2_OUT'); console.log(`${TAG}[SPLIT][SCENE2][OK] ${scene2Path}`); resolve(); }
        catch (e) { console.error(`${TAG}[SPLIT][SCENE2][ERR] ${e.message}`); reject(e); }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`${TAG}[SPLIT][SCENE2][ERR]`, err);
        if (stderr) console.error(`${TAG}[SPLIT][SCENE2][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`${TAG}[SPLIT][SCENE2][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(scene2Path);
  });

  return [scene1Path, scene2Path];
}

// ============================================================
// TRIM FOR NARRATION (Scene 3+): CFR, no -vsync, loop optional
// ============================================================
async function trimForNarration(inPath, outPath, audioDuration, options = {}) {
  let leadIn = 0.5, trailOut = 1.0, loop = false;
  if (typeof options === 'object' && options !== null) {
    leadIn = options.leadIn ?? 0.5;
    trailOut = options.trailOut ?? 1.0;
    loop = !!options.loop;
  }

  assertFile(inPath, 10000, 'TRIM_IN');

  const duration = leadIn + Number(audioDuration || 0) + trailOut;
  console.log(`${TAG}[TRIM][START] in="${inPath}" → out="${outPath}" | target=${duration.toFixed(3)}s (head=${leadIn}s tail=${trailOut}s) loop=${loop}`);

  const filter = buildPortraitTrimFilter(0, duration, duration, trailOut);

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inPath).inputOptions(['-y']);
    if (loop) {
      cmd = cmd.inputOptions(['-stream_loop', '-1']);
      console.log(`${TAG}[TRIM][LOOP] Enabled for ${inPath}`);
    }

    cmd
      .outputOptions([
        '-filter_complex', filter,
        '-map', '[vout]',
        '-r', '30',
        '-fps_mode', 'cfr',
        '-an',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y'
      ])
      .on('start', c => console.log(`${TAG}[TRIM][CMD] ${c}`))
      .on('stderr', line => console.log(`${TAG}[TRIM][STDERR] ${line}`))
      .on('end', () => {
        try { assertFile(outPath, 10240, 'TRIM_OUT'); console.log(`${TAG}[TRIM][OK] ${outPath}`); resolve(); }
        catch (e) { console.error(`${TAG}[TRIM][ERR] ${e.message}`); reject(e); }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`${TAG}[TRIM][ERR]`, err);
        if (stderr) console.error(`${TAG}[TRIM][FFMPEG][STDERR]\n${stderr}`);
        if (stdout) console.log(`${TAG}[TRIM][FFMPEG][STDOUT]\n${stdout}`);
        reject(err);
      })
      .save(outPath);
  });
}

// ============================================================
// MUX: narration over trimmed video — CFR audio resample, no -vsync
// ============================================================
async function muxVideoWithNarration(videoIn, audioIn, outPath) {
  assertFile(videoIn, 10000, 'MUX_VIDEO_IN');
  assertFile(audioIn, 10000, 'MUX_AUDIO_IN');

  const videoDur = await getDuration(videoIn);
  const audioDur = await getDuration(audioIn);
  console.log(`${TAG}[MUX][START] video="${videoIn}" (${videoDur.toFixed(3)}s), audio="${audioIn}" (${audioDur.toFixed(3)}s) → "${outPath}"`);

  const wavTemp = path.join(os.tmpdir(), `ssai-wav-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
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
        '-t', videoDur.toFixed(3),
        '-filter:a', 'aresample=async=1',
        '-r', '30',
        '-fps_mode', 'cfr',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-preset', 'veryfast',
        '-y'
      ])
      .on('start', cmd => console.log(`${TAG}[MUX][CMD] ${cmd}`))
      .on('stderr', line => console.log(`${TAG}[MUX][STDERR] ${line}`))
      .on('end', () => {
        try {
          assertFile(outPath, 10240, 'MUX_OUT');
          console.log(`${TAG}[MUX][OK] ${outPath}`);
          try { fs.unlinkSync(wavTemp); } catch {}
          resolve();
        } catch (e) {
          console.error(`${TAG}[MUX][ERR] Validation failed: ${e.message}`);
          try { fs.unlinkSync(wavTemp); } catch {}
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`${TAG}[MUX][ERR]`, err);
        if (stderr) console.error(`${TAG}[MUX][STDERR]\n${stderr}`);
        if (stdout) console.log(`${TAG}[MUX][STDOUT]\n${stdout}`);
        try { fs.unlinkSync(wavTemp); } catch {}
        reject(err);
      })
      .save(outPath);
  });
}

// ============================================================
// ADD SILENT AUDIO (Ken Burns / image videos) — unchanged
// ============================================================
async function addSilentAudioTrack(inPath, outPath, duration) {
  assertFile(inPath, 10000, 'SILENT_IN');
  console.log(`${TAG}[AUDIO][START] Add silent track: ${inPath} → ${outPath} (t=${duration})`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inPath)
      .input('anullsrc=channel_layout=stereo:sample_rate=48000')
      .inputOptions(['-f', 'lavfi'])
      .outputOptions([
        '-shortest',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y'
      ])
      .duration(duration)
      .on('start', cmd => console.log(`${TAG}[AUDIO][CMD] ${cmd}`))
      .on('stderr', line => console.log(`${TAG}[AUDIO][STDERR] ${line}`))
      .on('end', () => {
        try { assertFile(outPath, 10240, 'AUDIO_OUT'); console.log(`${TAG}[AUDIO][OK] ${outPath}`); resolve(); }
        catch (e) { console.error(`${TAG}[AUDIO][ERR] ${e.message}`); reject(e); }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`${TAG}[AUDIO][ERR]`, err);
        if (stderr) console.error(`${TAG}[AUDIO][STDERR]\n${stderr}`);
        if (stdout) console.log(`${TAG}[AUDIO][STDOUT]\n${stdout}`);
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
