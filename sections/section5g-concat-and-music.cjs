// ===========================================================
// SECTION 5G: FINAL VIDEO ASSEMBLER & MUSIC/OUTRO
// Concats scenes, adds music, appends outro, validates output.
// SUPER MAX LOGGING EVERY STEP — NO SILENT FAILURES
// All FFmpeg uses -preset ultrafast for max speed
// BulletproofScenes for size/audio normalization
// Never repeats same song twice! AI mood detection fallback!
// 2024-08: PRO — Always 9:16 output, validated output, logging
// 2025-08: FIX — overlayMusic now always writes to a *file*
//              inside workDir (prevents "Invalid argument" when
//              a directory path is accidentally passed). Also
//              accepts a Promise for musicPath and resolves it.
//              appendOutro is now backward-compatible with
//              (main, workDir, jobId) *or* (main, outro, out, workDir).
// ===========================================================

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');

// === Load music moods (if available) ===
let musicMoods = null;
try {
  musicMoods = require('./music-moods.cjs');
  console.log('[5G][INIT] Loaded music-moods.cjs for AI mood detection and non-repeating music.');
} catch (err) {
  console.warn('[5G][INIT][WARN] music-moods.cjs not found. Falling back to internal logic.');
}

console.log('[5G][INIT] Final video assembler loaded.');

// === Static Asset Paths ===
function getOutroPath() {
  const outroPath = path.join(__dirname, '..', 'public', 'assets', 'outro.mp4');
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
  return true;
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

// === Bulletproof scenes (format/audio normalization) ===
async function bulletproofScenes(sceneFiles, refInfo, getVideoInfo, standardizeVideo, sceneClipMetaList = null) {
  console.log('[5G][BULLETPROOF] bulletproofScenes called.');
  const fixed = [];
  for (let i = 0; i < sceneFiles.length; ++i) {
    const file = sceneFiles[i];
    let needsFix = false;
    let vinfo;
    try {
      vinfo = await getVideoInfo(file);
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
      const fixedPath = file.replace(/\.mp4$/, `-fixed-${uuidv4()}.mp4`);
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
      if (sceneClipMetaList) sceneClipMetaList[i].localFilePath = fixedPath;
    } else {
      fixed.push(file);
      if (sceneClipMetaList) sceneClipMetaList[i].localFilePath = file;
    }
  }
  console.log(`[5G][BULLETPROOF] ${fixed.length} valid scenes returned.`);
  return fixed;
}

// === Ensure every video has audio stream (not just silence) ===
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

  const fixedPath = path.resolve(workDir, `audiofix-${path.basename(videoPath, '.mp4')}-${uuidv4()}.mp4`);
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

// === Bulletproof single file (force to proper audio/video params for outro concat) ===
async function bulletproofFile(inputPath, workDir, label) {
  const output = path.join(workDir, `${path.basename(inputPath, '.mp4')}-bp-${uuidv4()}.mp4`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
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
      .save(output)
      .on('end', async () => {
        try {
          assertFile(output, 10240, label || 'BPFILE');
          await logFileProbe(output, label || 'BPFILE');
          console.log(`[5G][BPFILE] Bulletproofed ${inputPath} -> ${output}`);
          resolve(output);
        } catch (e) {
          console.error(`[5G][BPFILE][ERR] ${e.message}`);
          reject(e);
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5G][BPFILE][ERR]`, err);
        if (stderr) console.error(`[5G][BPFILE][STDERR]\n${stderr}`);
        if (stdout) console.log(`[5G][BPFILE][STDOUT]\n${stdout}`);
        reject(err);
      });
  });
}

// ============================================
// MAIN CONCAT: Output is 1080x1920 (portrait, shorts format)
// ============================================
/**
 * Concat scenes, returns final concat file path.
 * @param {string[]} sceneFiles - Array of scene .mp4s
 * @param {string} workDir
 * @param {Object[]} sceneClipMetaList - Optional: metadata list per scene
 * @returns {Promise<string>}
 */
async function concatScenes(sceneFiles, workDir, sceneClipMetaList = null) {
  console.log(`[5G][CONCAT] concatScenes called with ${sceneFiles.length} files:`);
  sceneFiles.forEach((file, i) => console.log(`[5G][CONCAT][IN] ${i + 1}: ${file}`));

  // Normalize/repair scenes
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
    null,
    sceneClipMetaList
  );

  // Ensure all have audio
  fixedScenes = await Promise.all(fixedScenes.map(f => ensureAudioStream(f, workDir)));

  const listFile = path.resolve(workDir, 'list.txt');
  fs.writeFileSync(listFile, fixedScenes.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), { encoding: 'utf8' });

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
        '-ar 44100',
        '-ac 2',
        '-b:a 128k',
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

// === Async Scene Clip Archiver Hook (call this from 5H job cleanup) ===
async function postProcessSceneClipArchiving(sceneClipMetaList, asyncArchiveFn) {
  if (!Array.isArray(sceneClipMetaList) || !sceneClipMetaList.length) {
    console.warn('[5G][ARCHIVE][WARN] No sceneClipMetaList provided.');
    return;
  }
  if (typeof asyncArchiveFn !== 'function') {
    console.warn('[5G][ARCHIVE][WARN] No asyncArchiveFn provided.');
    return;
  }
  console.log(`[5G][ARCHIVE][START] Archiving ${sceneClipMetaList.length} scene clips to R2...`);
  for (let i = 0; i < sceneClipMetaList.length; i++) {
    const meta = sceneClipMetaList[i];
    try {
      await asyncArchiveFn(meta);
      console.log(`[5G][ARCHIVE][OK] Archived scene ${i + 1}/${sceneClipMetaList.length}:`, meta.localFilePath);
    } catch (err) {
      console.error(`[5G][ARCHIVE][ERR] Failed to archive scene ${i + 1}:`, meta.localFilePath, err);
    }
  }
  console.log('[5G][ARCHIVE][DONE] All scene clips processed.');
}

// === Outro appender (bulletproof, compat with both signatures) ===
// Supports:
//   appendOutro(mainPath, workDir, jobId?)                            // (used by 5B)
//   appendOutro(mainPath, outroPath, outPath, workDir)                // original form
async function appendOutro(mainPath, arg2, arg3, arg4) {
  let outroPath = null;
  let outPath = null;
  let workDir = null;

  // Heuristic: if arg2 exists and is a directory => (main, workDir, jobId?)
  if (arg2 && typeof arg2 === 'string' && fs.existsSync(arg2) && fs.statSync(arg2).isDirectory()) {
    workDir = arg2;
    outroPath = getOutroPath();
    outPath = path.resolve(workDir, getUniqueFinalName('final-with-outro'));
  } else {
    // original style
    outroPath = arg2 || getOutroPath();
    outPath = arg3 || path.resolve(arg4 || path.dirname(mainPath), getUniqueFinalName('final-with-outro'));
    workDir = arg4 || path.dirname(outroPath);
  }

  console.log(`[5G][OUTRO] appendOutro called: main="${mainPath}" outro="${outroPath}" out="${outPath}"`);
  await logFileProbe(mainPath, 'OUTRO_MAIN');
  await logFileProbe(outroPath, 'OUTRO_OUTRO');

  if (!fs.existsSync(mainPath) || !fs.existsSync(outroPath)) {
    throw new Error(`[5G][OUTRO][ERR] Main or outro video missing! main: ${mainPath} exists? ${fs.existsSync(mainPath)}, outro: ${outroPath} exists? ${fs.existsSync(outroPath)}`);
  }

  // Bulletproof both files for concat audio/video params
  const bpMain = await bulletproofFile(mainPath, workDir, 'BP_MAIN');
  const bpOutro = await bulletproofFile(outroPath, workDir, 'BP_OUTRO');

  // Always use a fresh concat list for FFmpeg concat demuxer
  const listFile = path.resolve(workDir, 'list2.txt');
  fs.writeFileSync(listFile, [
    `file '${bpMain.replace(/'/g, "'\\''")}'`,
    `file '${bpOutro.replace(/'/g, "'\\''")}'`
  ].join('\n'), { encoding: 'utf8' });

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v libx264',
        '-c:a aac',
        '-ar 44100',
        '-ac 2',
        '-b:a 128k',
        '-movflags +faststart',
        '-preset ultrafast',
        '-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1'
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

// === Music overlay (now always writes its own OUT path inside workDir) ===
// Accepts either a string path, null (skip), or a Promise that resolves to a path.
async function overlayMusic(videoPath, musicPathMaybe, workDir) {
  console.log(`[5G][MUSIC] overlayMusic called: video="${videoPath}" music="${musicPathMaybe}" workDir="${workDir}"`);

  // Resolve Promise if the caller forgot to await pickMusicForMood
  if (musicPathMaybe && typeof musicPathMaybe.then === 'function') {
    try {
      musicPathMaybe = await musicPathMaybe;
      console.log('[5G][MUSIC] Resolved musicPath Promise →', musicPathMaybe);
    } catch (e) {
      console.warn('[5G][MUSIC][WARN] Failed to resolve musicPath Promise. Skipping music.', e);
      return videoPath; // no music overlay
    }
  }

  // If no track was provided/resolved, skip overlay gracefully
  if (!musicPathMaybe) {
    console.warn('[5G][MUSIC][WARN] No music track provided. Skipping music overlay.');
    return videoPath;
  }

  // Validate inputs and log probes
  try {
    await logFileProbe(videoPath, 'MUSIC_VIDEO');
    await logFileProbe(musicPathMaybe, 'MUSIC_MUSIC');
  } catch (e) {
    console.warn('[5G][MUSIC][PROBE][WARN] Could not probe input durations.');
  }

  // Ensure music path exists, otherwise skip
  if (!fs.existsSync(musicPathMaybe)) {
    console.warn('[5G][MUSIC][WARN] Music file not found:', musicPathMaybe, '— skipping overlay.');
    return videoPath;
  }

  // Always produce an explicit OUTPUT FILE in workDir
  const outPath = path.resolve(
    workDir || path.dirname(videoPath),
    `${path.basename(videoPath, '.mp4')}-music-${uuidv4()}.mp4`
  );
  console.log('[5G][MUSIC] Output file will be:', outPath);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(musicPathMaybe)
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
        '-ar', '44100',
        '-ac', '2',
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

// === Main Mood Picker (non-repeating/random) ===
let _lastTrack = null;
/**
 * pickMusicForMood: Detects mood (via music-moods if present, else fallback), then randomizes and prevents repeats.
 * @param {string} script - Full script text for mood detection
 * @param {string} workDir - Work directory for job (for logging/future)
 * @returns {string} Full path to music file, or null
 */
async function pickMusicForMood(script, workDir) {
  let detectedMood;
  try {
    if (musicMoods && typeof musicMoods.detectMusicMood === 'function') {
      detectedMood = musicMoods.detectMusicMood(script);
      console.log(`[5G][MUSIC][AI] Mood detected (music-moods): "${detectedMood}"`);
    } else {
      detectedMood = simpleDetectMood(script);
      console.log(`[5G][MUSIC][FALLBACK] Mood detected (fallback): "${detectedMood}"`);
    }
  } catch (err) {
    detectedMood = 'motivation_inspiration_uplifting';
    console.warn('[5G][MUSIC][MOOD][ERR] Mood detection failed, defaulting.');
  }

  let chosen;
  if (musicMoods && typeof musicMoods.getRandomMusicFileForMood === 'function') {
    chosen = musicMoods.getRandomMusicFileForMood(detectedMood, _lastTrack);
  } else {
    chosen = getRandomMusicFileForMood(detectedMood, _lastTrack);
  }
  if (!chosen) {
    console.warn(`[5G][MUSIC][MOOD][WARN] No music found for mood "${detectedMood}".`);
    return null;
  }
  _lastTrack = chosen;
  return chosen;
}

// === Simple Fallback Mood Detector (basic keyword rules) ===
function simpleDetectMood(script) {
  const txt = (script || '').toLowerCase();
  if (/excite|amazing|funny|lol|hilarious|shocking/.test(txt)) return 'funny_quirky_whimsical';
  if (/sad|heart|emotional|tear|loss|cry/.test(txt)) return 'sad_emotional_reflective';
  if (/mystery|ghost|secret|hidden|unsolved|dark/.test(txt)) return 'spooky_creepy_mystery_horror';
  if (/motivat|inspir|success|achiev|overcome|dream|goal/.test(txt)) return 'motivation_inspiration_uplifting';
  if (/calm|relax|chill|soothing|gentle/.test(txt)) return 'lofi_chill_ambient';
  if (/danger|intense|epic|battle|action|fight/.test(txt)) return 'action_sports_intense';
  if (/fact|info|knowledge|history/.test(txt)) return 'news_documentary_neutral';
  if (/historic|history|empire|war/.test(txt)) return 'historical';
  if (/pop|upbeat|energetic/.test(txt)) return 'upbeat_energetic_pop';
  if (/cinematic|epic|adventure/.test(txt)) return 'cinematic_epic_adventure';
  if (/fantasy|magic|wizard|dragon/.test(txt)) return 'fantasy_magical';
  if (/nature|ocean|forest|animal|mountain|tree/.test(txt)) return 'nature_ambient_relaxing';
  if (/corporate|business|office|meeting|education|lesson/.test(txt)) return 'corporate_educational_explainer';
  if (/game|arcade|8-bit|retro/.test(txt)) return 'retro_8-bit_gaming';
  if (/tech|ai|future|robot|science|space/.test(txt)) return 'science_tech_futuristic';
  // Default fallback
  return 'motivation_inspiration_uplifting';
}

// === Minimal fallback (if no music-moods) ===
function getRandomMusicFileForMood(mood, lastTrack = null) {
  const musicDir = path.join(__dirname, '..', 'public', 'assets', 'music_library', mood);
  let files = [];
  try {
    files = fs.readdirSync(musicDir).filter(f => /\.(mp3|wav|aac)$/i.test(f));
  } catch (e) {
    console.warn('[5G][MUSIC][FOLDER][WARN] Could not read music dir:', musicDir, e.message);
    files = [];
  }
  if (!files.length) {
    if (mood !== 'motivation_inspiration_uplifting') return getRandomMusicFileForMood('motivation_inspiration_uplifting', lastTrack);
    // fallback: any
    const rootMusic = path.join(__dirname, '..', 'public', 'assets', 'music_library');
    let allMusic = [];
    try {
      fs.readdirSync(rootMusic).forEach(dir => {
        const dirPath = path.join(rootMusic, dir);
        if (fs.statSync(dirPath).isDirectory()) {
          allMusic = allMusic.concat(
            fs.readdirSync(dirPath).filter(f => /\.(mp3|wav|aac)$/i.test(f)).map(f => path.join(dirPath, f))
          );
        }
      });
    } catch (err) {}
    if (allMusic.length) {
      let pick = allMusic;
      if (lastTrack && allMusic.length > 1) pick = allMusic.filter(f => path.basename(f) !== path.basename(lastTrack));
      const chosen = pick[Math.floor(Math.random() * pick.length)];
      console.log(`[5G][MUSIC][FALLBACK] Picked ANY track: ${chosen}`);
      return chosen;
    }
    console.warn(`[5G][MUSIC][FALLBACK][ERR] No music files at all!`);
    return null;
  }
  // Avoid lastTrack if possible
  let candidates = files;
  if (lastTrack && files.length > 1) {
    candidates = files.filter(f => f !== path.basename(lastTrack));
    if (!candidates.length) candidates = files;
  }
  const idx = Math.floor(Math.random() * candidates.length);
  const chosen = path.join(musicDir, candidates[idx]);
  console.log(`[5G][MUSIC][RANDOM][PICK] Mood="${mood}" Picked: ${chosen} (lastTrack=${lastTrack})`);
  return chosen;
}

// === Extra Export: (16:9/9:16 quick thumbnail/video formatters) ===
async function create16x9FromInput(inputPath, outputPath) {
  console.log(`[5G][FORMAT][16x9] Creating 16:9 output from: ${inputPath}`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
      .complexFilter([
        "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[fg];" +
        "[0:v]scale=1280:720:force_original_aspect_ratio=increase,boxblur=40:1[bg];" +
        "[bg][fg]overlay=(W-w)/2:(H-h)/2,crop=1280:720"
      ])
      .outputOptions([
        '-c:v libx264',
        '-preset ultrafast',
        '-crf 22',
        '-c:a copy',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-y'
      ])
      .save(outputPath)
      .on('end', () => {
        console.log(`[5G][FORMAT][16x9] Output written: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5G][FORMAT][16x9][ERR]`, err);
        reject(err);
      });
  });
}

async function create9x16FromInput(inputPath, outputPath) {
  console.log(`[5G][FORMAT][9x16] Creating 9:16 output from: ${inputPath}`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
      .complexFilter([
        "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[fg];" +
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,boxblur=40:1[bg];" +
        "[bg][fg]overlay=(W-w)/2:(H-h)/2,crop=1080:1920"
      ])
      .outputOptions([
        '-c:v libx264',
        '-preset ultrafast',
        '-crf 22',
        '-c:a copy',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-y'
      ])
      .save(outputPath)
      .on('end', () => {
        console.log(`[5G][FORMAT][9x16] Output written: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[5G][FORMAT][9x16][ERR]`, err);
        reject(err);
      });
  });
}

// ============================================
// MODULE EXPORTS
// ============================================
module.exports = {
  concatScenes, // (sceneFiles, workDir, sceneClipMetaList)
  ensureAudioStream,
  overlayMusic, // (videoPath, musicPathOrPromiseOrNull, workDir)
  appendOutro,  // compat: (main, workDir, jobId?) OR (main, outro, out, workDir)
  getOutroPath,
  getUniqueFinalName,
  bulletproofScenes,
  pickMusicForMood,
  getRandomMusicFileForMood,
  simpleDetectMood,
  create16x9FromInput,
  create9x16FromInput,
  postProcessSceneClipArchiving
};
