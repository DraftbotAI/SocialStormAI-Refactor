// ===========================================================
// SECTION 5G: FINAL VIDEO ASSEMBLER & MUSIC/OUTRO
// Concats scenes, adds music, appends outro, validates output.
// SUPER MAX LOGGING AT EVERY STEP — NO SILENT FAILURES
// Aspect ratio fixed! Scenes always 9:16, never stretched.
// Enhanced: All FFmpeg uses -preset ultrafast for max speed
// Includes bulletproofScenes for size/audio normalization
// AI music mood selection + random song per mood!
// ===========================================================

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');

// --- Music mood selector helper ---
const { getRandomMusicFileForMood } = require('./music-moods.cjs'); // <-- NEW

console.log('[5G][INIT] Final video assembler loaded.');

function getOutroPath() {
  const outroPath = path.join(__dirname, '..', 'public', 'video', 'outro.mp4');
  console.log('[5G][PATH][OUTRO] Using outro path:', outroPath);
  return outroPath;
}

function getUniqueFinalName(prefix = 'final') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uuid = uuidv4();
  return `${prefix}-${timestamp}-${uuid}.mp4`;
}

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

// BULLETPROOF: Ensures every scene is 1080x1920, yuv420p, has audio
async function bulletproofScenes(sceneFiles, refInfo, getVideoInfo, standardizeVideo) {
  console.log('[5G][BULLETPROOF] bulletproofScenes called.');
  const fixed = [];
  for (let i = 0; i < sceneFiles.length; ++i) {
    const file = sceneFiles[i];
    let needsFix = false;
    let vinfo;
    try {
      vinfo = await getVideoInfo(file);
      // Must be 1080x1920 portrait, must have audio
      if (
        !vinfo ||
        vinfo.width !== 1080 ||
        vinfo.height !== 1920 ||
        !vinfo.hasVideo ||
        !vinfo.hasAudio
      ) {
        needsFix = true;
        console.warn(`[5G][BULLETPROOF][WARN] Scene at idx ${i} is invalid:`, vinfo);
      }
    } catch (e) {
      needsFix = true;
      console.warn(`[5G][BULLETPROOF][BUG] Scene at idx ${i} probe failed:`, e);
    }
    if (needsFix) {
      // Force fix to proper output
      const fixedPath = file.replace(/\.mp4$/, `-fixed.mp4`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(file)
          .outputOptions([
            '-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
            '-pix_fmt yuv420p',
            '-c:v libx264',
            '-c:a aac',
            '-ar 44100',
            '-ac 2',
            '-b:a 128k',
            '-preset ultrafast',
            '-y'
          ])
          .save(fixedPath)
          .on('end', async () => {
            try {
              assertFile(fixedPath, 10240, `BULLETPROOF_FIXED_${i}`);
              await logFileProbe(fixedPath, `BULLETPROOF_FIXED_${i}`);
              console.log(`[5G][BULLETPROOF] Fixed scene: ${fixedPath}`);
              resolve();
            } catch (e) {
              console.error(`[5G][BULLETPROOF][ERR] ${e.message}`);
              reject(e);
            }
          })
          .on('error', (err, stdout, stderr) => {
            console.error(`[5G][BULLETPROOF][FFMPEG][ERR]`, err);
            if (stderr) console.error(`[5G][BULLETPROOF][STDERR]\n${stderr}`);
            if (stdout) console.log(`[5G][BULLETPROOF][STDOUT]\n${stdout}`);
            reject(err);
          });
      });
      fixed.push(fixedPath);
    } else {
      fixed.push(file);
    }
  }
  console.log(`[5G][BULLETPROOF] ${fixed.length} valid scenes returned.`);
  return fixed;
}

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

async function concatScenes(sceneFiles, workDir) {
  console.log(`[5G][CONCAT] concatScenes called with ${sceneFiles.length} files:`);
  sceneFiles.forEach((file, i) => console.log(`[5G][CONCAT][IN] ${i + 1}: ${file}`));

  // Bulletproof: auto-normalize every file to 1080x1920, yuv420p, audio
  let fixedScenes = await bulletproofScenes(
    sceneFiles,
    null,
    async (file) => {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(file, (err, md) => {
          if (err) return reject(err);
          const v = (md.streams || []).find(s => s.codec_type === 'video');
          const a = (md.streams || []).find(s => s.codec_type === 'audio');
          resolve({
            width: v?.width,
            height: v?.height,
            hasVideo: !!v,
            hasAudio: !!a
          });
        });
      });
    },
    null
  );

  // Ensure all have audio (as final fix)
  fixedScenes = await Promise.all(fixedScenes.map(f => ensureAudioStream(f, workDir)));

  const listFile = path.resolve(workDir, 'list.txt');
  fs.writeFileSync(listFile, fixedScenes.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const concatFile = path.resolve(workDir, getUniqueFinalName('concat'));

  for (let i = 0; i < fixedScenes.length; i++) {
    try { assertFile(fixedScenes[i], 10240, `CONCAT_SCENE_${i + 1}`); } catch (e) { console.error(e.message); }
    await logFileProbe(fixedScenes[i], `CONCAT_SCENE_${i + 1}`);
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

// === AI Music Mood Selector + Random Song ===
async function selectMusicFileForScript(script, gptDetectMood) {
  try {
    // Detect mood using your GPT helper function (user must implement this function in their GPT code)
    const detectedMood = await gptDetectMood(script); // Example: "suspense"
    console.log('[5G][MUSIC][AI] Detected mood from GPT:', detectedMood);
    const musicPath = getRandomMusicFileForMood(detectedMood);
    if (musicPath) {
      console.log('[5G][MUSIC][AI] Selected random music file:', musicPath);
      return musicPath;
    } else {
      console.warn('[5G][MUSIC][AI][WARN] No music file found for detected mood:', detectedMood);
      return null;
    }
  } catch (err) {
    console.error('[5G][MUSIC][AI][ERR] Mood detection or file select failed:', err);
    return null;
  }
}

async function overlayMusic(videoPath, musicPath, outPath) {
  console.log(`[5G][MUSIC] overlayMusic called: video="${videoPath}" music="${musicPath}" out="${outPath}"`);

  try {
    await logFileProbe(videoPath, 'MUSIC_VIDEO');
    await logFileProbe(musicPath, 'MUSIC_MUSIC');
  } catch (e) {
    console.warn('[5G][MUSIC][PROBE][WARN] Could not probe input durations.');
  }

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

async function appendOutro(mainPath, outroPath, outPath, workDir) {
  if (!outroPath) outroPath = getOutroPath();
  if (!outPath) outPath = path.resolve(workDir, getUniqueFinalName('final-with-outro'));

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

module.exports = {
  concatScenes,
  ensureAudioStream,
  overlayMusic,
  appendOutro,
  getOutroPath,
  getUniqueFinalName,
  bulletproofScenes,
  // New export for AI music selection:
  selectMusicFileForScript
};
