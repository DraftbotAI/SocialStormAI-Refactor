// ===========================================================
// SECTION 5G: FINAL VIDEO ASSEMBLER & MUSIC/OUTRO
// Concats scenes, adds music, appends outro, validates output.
// SUPER MAX LOGGING AT EVERY STEP — NO SILENT FAILURES
// Aspect ratio fixed! Scenes always 9:16, never stretched.
// Enhanced: All FFmpeg uses -preset ultrafast for max speed
// ===========================================================

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');

console.log('[5G][INIT] Final video assembler loaded.');

// === STATIC ASSET PATH HELPERS ===
function getOutroPath() {
  const outroPath = path.join(__dirname, '..', 'public', 'video', 'outro.mp4');
  console.log('[5G][PATH][OUTRO] Using outro path:', outroPath);
  return outroPath;
}

// --- File Existence and Probe Utilities ---
function assertFile(file, minSize = 10240, label = 'FILE') {
  if (!fs.existsSync(file)) {
    throw new Error(`[5G][${label}][ERR] File does not exist: ${file}`);
  }
  const sz = fs.statSync(file).size;
  if (sz < minSize) {
    throw new Error(`[5G][${label}][ERR] File too small (${sz} bytes): ${file}`);
  }
}

async function logFileProbe(file, label = 'PROBE') {
  try {
    const stats = fs.statSync(file);
    console.log(`[5G][${label}][INFO] File: ${file} | Size: ${stats.size} bytes`);
    await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, md) => {
        if (err) {
          console.error(`[5G][${label}][FFPROBE][ERR] ${file}`, err);
          reject(err);
        } else {
          const format = md.format || {};
          const streams = md.streams || [];
          const v = streams.find(s => s.codec_type === 'video');
          const a = streams.find(s => s.codec_type === 'audio');
          console.log(`[5G][${label}][FFPROBE] duration=${format.duration} streams: video=${!!v} audio=${!!a} width=${v?.width} height=${v?.height}`);
          resolve();
        }
      });
    });
  } catch (err) {
    console.error(`[5G][${label}][FFPROBE][ERR2] ${file}`, err);
  }
}

// === FINAL VIDEO LOGIC ===
function getUniqueFinalName(prefix = 'final') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uuid = uuidv4();
  return `${prefix}-${timestamp}-${uuid}.mp4`;
}

/**
 * Ensures a video file has an audio stream; if not, adds silent audio.
 */
async function ensureAudioStream(videoPath, workDir) {
  console.log(`[5G][AUDIOFIX] ensureAudioStream called: ${videoPath}`);
  let audioStreamExists = false;
  try {
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, md) => err ? reject(err) : resolve(md));
    });
    audioStreamExists = (metadata.streams || []).some(s => s.codec_type === 'audio');
    console.log(`[5G][AUDIOFIX] Audio stream exists: ${audioStreamExists}`);
    await logFileProbe(videoPath, 'AUDIOFIX_ORIG');
  } catch (err) {
    console.error('[5G][AUDIOFIX][ERR] ffprobe failed:', err);
  }
  if (audioStreamExists) return videoPath;

  const fixedPath = path.resolve(workDir, `audiofix-${path.basename(videoPath)}`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input('anullsrc=channel_layout=stereo:sample_rate=44100')
      .inputOptions(['-f lavfi'])
      .outputOptions(['-shortest', '-c:v copy', '-c:a aac', '-b:a 128k', '-ar 44100', '-ac 2', '-pix_fmt yuv420p', '-y'])
      .save(fixedPath)
      .on('end', async () => {
        try {
          assertFile(fixedPath, 10240, 'AUDIOFIX_OUT');
          await logFileProbe(fixedPath, 'AUDIOFIX_OUT');
          console.log(`[5G][AUDIOFIX] Silent audio added: ${fixedPath}`);
          resolve(fixedPath);
        } catch (e) {
          console.error(`[5G][AUDIOFIX][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5G][AUDIOFIX][FFMPEG][ERR]`, err);
        if (stderr) console.error(`[5G][AUDIOFIX][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5G][AUDIOFIX][STDOUT]\n${stdout}`);
        reject(err);
      });
  });
}

/**
 * Concatenate all scene files (each with voice) into a single video.
 * Ensures proper aspect ratio and audio. (ALWAYS runs ensureAudioStream on each clip before concat.)
 */
async function concatScenes(sceneFiles, workDir) {
  console.log(`[5G][CONCAT] concatScenes called with ${sceneFiles.length} files:`);
  sceneFiles.forEach((file, i) => console.log(`[5G][CONCAT][IN] ${i+1}: ${file}`));

  // --- Ensure every file has audio before concat! ---
  const fixedScenes = await Promise.all(sceneFiles.map(f => ensureAudioStream(f, workDir)));
  const listFile = path.resolve(workDir, 'list.txt');
  fs.writeFileSync(listFile, fixedScenes.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const concatFile = path.resolve(workDir, getUniqueFinalName('concat'));

  // Pre-concat check for all scene files
  for (let i = 0; i < fixedScenes.length; i++) {
    try { assertFile(fixedScenes[i], 10240, `CONCAT_SCENE_${i+1}`); } catch(e) { console.error(e.message); }
    await logFileProbe(fixedScenes[i], `CONCAT_SCENE_${i+1}`);
  }

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v libx264',
        '-c:a aac',
        '-movflags +faststart',
        '-preset ultrafast',
        // Aspect ratio fix: Always 9:16, never stretched
        '-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1'
      ])
      .save(concatFile)
      .on('end', async () => {
        try {
          assertFile(concatFile, 10240, 'CONCAT_OUT');
          await logFileProbe(concatFile, 'CONCAT_OUT');
          console.log(`[5G][CONCAT] Scenes concatenated: ${concatFile}`);
          resolve(concatFile);
        } catch (e) {
          console.error(`[5G][CONCAT][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5G][CONCAT][FFMPEG][ERR]`, err);
        if (stderr) console.error(`[5G][CONCAT][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5G][CONCAT][STDOUT]\n${stdout}`);
        reject(err);
      });
  });
}

/**
 * Overlay music on the FINAL video with correct volume mixing.
 */
async function overlayMusic(videoPath, musicPath, outPath) {
  console.log(`[5G][MUSIC] overlayMusic called: video="${videoPath}" music="${musicPath}" out="${outPath}"`);

  try {
    await logFileProbe(videoPath, 'MUSIC_VIDEO');
    await logFileProbe(musicPath, 'MUSIC_MUSIC');
  } catch (e) {
    console.warn('[5G][MUSIC][PROBE][WARN] Could not probe input durations.');
  }

  // Proper volume: voice=1.0, music=0.16
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(musicPath)
      .complexFilter([
        '[0:a]volume=1.0[a0]',
        '[1:a]volume=0.16[a1]',
        '[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]'
      ])
      .outputOptions([
        '-map', '0:v',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-shortest',
        '-y'
      ])
      .save(outPath)
      .on('end', async () => {
        try {
          assertFile(outPath, 10240, 'MUSIC_OUT');
          await logFileProbe(outPath, 'MUSIC_OUT');
          console.log(`[5G][MUSIC] Music overlay complete: ${outPath}`);
          resolve(outPath);
        } catch (e) {
          console.error(`[5G][MUSIC][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5G][MUSIC][FFMPEG][ERR]`, err);
        if (stderr) console.error(`[5G][MUSIC][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5G][MUSIC][STDOUT]\n${stdout}`);
        reject(err);
      });
  });
}

/**
 * Append outro (video+audio) to the final video.
 */
async function appendOutro(mainPath, outroPath, outPath, workDir) {
  if (!outroPath) {
    outroPath = getOutroPath();
  }
  if (!outPath) {
    outPath = path.resolve(workDir, getUniqueFinalName('final-with-outro'));
  }
  console.log(`[5G][OUTRO] appendOutro called: main="${mainPath}" outro="${outroPath}" out="${outPath}"`);
  await logFileProbe(mainPath, 'OUTRO_MAIN');
  await logFileProbe(outroPath, 'OUTRO_OUTRO');

  const listFile = path.resolve(workDir, 'list2.txt');
  fs.writeFileSync(listFile, [
    `file '${mainPath.replace(/'/g, "'\\''")}'`,
    `file '${outroPath.replace(/'/g, "'\\''")}'`
  ].join('\n'));

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v libx264',
        '-c:a aac',
        '-movflags +faststart',
        '-preset ultrafast'
      ])
      .save(outPath)
      .on('end', async () => {
        try {
          assertFile(outPath, 10240, 'OUTRO_OUT');
          await logFileProbe(outPath, 'OUTRO_OUT');
          console.log(`[5G][OUTRO] Outro appended: ${outPath}`);
          resolve(outPath);
        } catch (e) {
          console.error(`[5G][OUTRO][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5G][OUTRO][FFMPEG][ERR]`, err);
        if (stderr) console.error(`[5G][OUTRO][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5G][OUTRO][STDOUT]\n${stdout}`);
        reject(err);
      });
  });
}

/**
 * Bulletproof scenes: ensure proper video/audio format, shape, stream.
 */
async function bulletproofScenes(sceneFiles, refInfo, getVideoInfo, standardizeVideo, workDir = '/tmp') {
  console.log('[5G][BULLETPROOF] bulletproofScenes called.');
  if (!refInfo || typeof refInfo !== 'object') {
    console.error('[5G][BULLETPROOF][FATAL] refInfo missing or not an object! Using default safe values.');
    refInfo = {};
  }
  if (!refInfo.codec_name) { console.warn('[5G][BULLETPROOF][WARN] Missing codec_name, defaulting to h264'); refInfo.codec_name = 'h264'; }
  if (!refInfo.width)      { console.warn('[5G][BULLETPROOF][WARN] Missing width, defaulting to 1080'); refInfo.width = 1080; }
  if (!refInfo.height)     { console.warn('[5G][BULLETPROOF][WARN] Missing height, defaulting to 1920'); refInfo.height = 1920; }
  if (!refInfo.pix_fmt)    { console.warn('[5G][BULLETPROOF][WARN] Missing pix_fmt, defaulting to yuv420p'); refInfo.pix_fmt = 'yuv420p'; }

  console.log('[5G][BULLETPROOF][INFO] Using refInfo:', JSON.stringify(refInfo));

  for (let i = 0; i < sceneFiles.length; i++) {
    const origPath = sceneFiles[i];
    try {
      await logFileProbe(origPath, `BULLETPROOF_SCENE_${i+1}`);
      assertFile(origPath, 10240, `BULLETPROOF_SCENE_${i+1}`);

      let fixedPath = origPath;
      fixedPath = await ensureAudioStream(fixedPath, workDir);

      const info = await getVideoInfo(fixedPath);
      const v = (info.streams || []).find(s => s.codec_type === 'video');
      const a = (info.streams || []).find(s => s.codec_type === 'audio');
      const needsFix =
        !v ||
        (v.codec_name !== refInfo.codec_name) ||
        (v.width !== refInfo.width) ||
        (v.height !== refInfo.height) ||
        (v.pix_fmt !== refInfo.pix_fmt) ||
        !a;

      if (needsFix) {
        console.warn(`[5G][BULLETPROOF][WARN] Scene ${i+1} format mismatch or missing stream. Attempting to standardize.`);
        const fixedOut = origPath.replace(/\.mp4$/, '-fixed.mp4');
        await standardizeVideo(fixedPath, fixedOut, refInfo);
        fs.renameSync(fixedOut, origPath);
        console.log(`[5G][BULLETPROOF] Standardized scene ${i+1}: ${origPath}`);
      } else {
        console.log(`[5G][BULLETPROOF] Scene ${i+1} validated OK`);
      }
    } catch (err) {
      console.error(`[5G][BULLETPROOF][ERR] Validation failed for scene ${i+1}`, err);
      throw err;
    }
  }
  console.log('[5G][BULLETPROOF] All scenes validated.');
}

module.exports = {
  concatScenes,
  ensureAudioStream,
  overlayMusic,
  appendOutro,
  bulletproofScenes,
  getOutroPath,
  getUniqueFinalName
};
