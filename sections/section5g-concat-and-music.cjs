// ===========================================================
// SECTION 5G: FINAL VIDEO ASSEMBLER & MUSIC/OUTRO
// Concats scenes, adds music, appends outro, validates output.
// MAX LOGGING AT EVERY STEP
// ===========================================================

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

console.log('[5G][INIT] Final video assembler loaded.');

/**
 * Concatenate all scene files into a single video.
 * @param {Array<string>} sceneFiles - Ordered array of .mp4s (scenes)
 * @param {string} workDir - Temporary working directory (for lists, outputs)
 * @returns {Promise<string>} Path to concat .mp4
 */
async function concatScenes(sceneFiles, workDir) {
  console.log(`[5G][CONCAT] concatScenes called with ${sceneFiles.length} files.`);
  const listFile = path.resolve(workDir, 'list.txt');
  fs.writeFileSync(
    listFile,
    sceneFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
  );
  const concatFile = path.resolve(workDir, 'concat.mp4');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
      .save(concatFile)
      .on('end', () => {
        if (!fs.existsSync(concatFile) || fs.statSync(concatFile).size < 10240) {
          console.error(`[5G][CONCAT][ERR] Output missing/too small after concat: ${concatFile}`);
          return reject(new Error('Concat output missing or too small!'));
        }
        console.log(`[5G][CONCAT] Scenes concatenated: ${concatFile}`);
        resolve(concatFile);
      })
      .on('error', (err) => {
        console.error(`[5G][CONCAT][ERR] FFmpeg error during concat:`, err);
        reject(err);
      });
  });
}

/**
 * Ensures a video file has an audio stream; if not, adds silent audio.
 * @param {string} videoPath
 * @param {string} workDir
 * @returns {Promise<string>} Path to audio-fixed .mp4
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
  } catch (err) {
    console.error('[5G][AUDIOFIX][ERR] ffprobe failed:', err);
  }
  if (audioStreamExists) return videoPath;

  // Add silent audio if missing
  const fixedPath = path.resolve(workDir, 'concat-audio.mp4');
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input('anullsrc=channel_layout=stereo:sample_rate=44100')
      .inputOptions(['-f lavfi'])
      .outputOptions(['-shortest', '-c:v copy', '-c:a aac', '-y'])
      .save(fixedPath)
      .on('end', () => {
        if (!fs.existsSync(fixedPath) || fs.statSync(fixedPath).size < 10240) {
          console.error(`[5G][AUDIOFIX][ERR] Output missing/too small after silent audio: ${fixedPath}`);
          return reject(new Error('Audio-fix output missing or too small!'));
        }
        console.log(`[5G][AUDIOFIX] Silent audio added: ${fixedPath}`);
        resolve(fixedPath);
      })
      .on('error', (err) => {
        console.error(`[5G][AUDIOFIX][ERR] FFmpeg error during audio-fix:`, err);
        reject(err);
      });
  });
}

/**
 * Overlays music on a video using FFmpeg amix filter.
 * @param {string} videoPath - Input .mp4 (must have audio)
 * @param {string} musicPath - Input music .mp3/.wav
 * @param {string} outPath - Output .mp4
 * @returns {Promise<string>} Path to music-mixed .mp4
 */
async function overlayMusic(videoPath, musicPath, outPath) {
  console.log(`[5G][MUSIC] overlayMusic called: video="${videoPath}" music="${musicPath}" out="${outPath}"`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(musicPath)
      .complexFilter('[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[mixa]')
      .outputOptions(['-map', '0:v', '-map', '[mixa]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y'])
      .save(outPath)
      .on('end', () => {
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10240) {
          console.error(`[5G][MUSIC][ERR] Output missing/too small after music overlay: ${outPath}`);
          return reject(new Error('Music overlay output missing or too small!'));
        }
        console.log(`[5G][MUSIC] Music overlay complete: ${outPath}`);
        resolve(outPath);
      })
      .on('error', (err) => {
        console.error(`[5G][MUSIC][ERR] FFmpeg error during music overlay:`, err);
        reject(err);
      });
  });
}

/**
 * Appends outro to the video via FFmpeg concat.
 * @param {string} mainPath - Main video path (.mp4)
 * @param {string} outroPath - Outro video path (.mp4)
 * @param {string} outPath - Output final .mp4
 * @returns {Promise<void>}
 */
async function appendOutro(mainPath, outroPath, outPath, workDir) {
  console.log(`[5G][OUTRO] appendOutro called: main="${mainPath}" outro="${outroPath}" out="${outPath}"`);
  const listFile = path.resolve(workDir, 'list2.txt');
  fs.writeFileSync(listFile, [
    `file '${mainPath.replace(/'/g, "'\\''")}'`,
    `file '${outroPath.replace(/'/g, "'\\''")}'`
  ].join('\n'));
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
      .save(outPath)
      .on('end', () => {
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10240) {
          console.error(`[5G][OUTRO][ERR] Output missing/too small after outro append: ${outPath}`);
          return reject(new Error('Outro output missing or too small!'));
        }
        console.log(`[5G][OUTRO] Outro appended: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[5G][OUTRO][ERR] FFmpeg error during outro append:`, err);
        reject(err);
      });
  });
}

/**
 * Bulletproofs (validates) a set of scene videos against a reference.
 * Can be expanded for codec/pixel_fmt checks.
 * @param {Array<string>} sceneFiles
 * @param {Object} refInfo - Reference info (width, height, codec, pix_fmt)
 * @param {function} getVideoInfo - Async video info probe
 * @param {function} standardizeVideo - Async video format fixer
 * @returns {Promise<void>}
 */
async function bulletproofScenes(sceneFiles, refInfo, getVideoInfo, standardizeVideo) {
  console.log('[5G][BULLETPROOF] bulletproofScenes called.');
  for (let i = 0; i < sceneFiles.length; i++) {
    try {
      const info = await getVideoInfo(sceneFiles[i]);
      const v = (info.streams || []).find(s => s.codec_type === 'video');
      const a = (info.streams || []).find(s => s.codec_type === 'audio');
      const needsFix =
        !v ||
        v.codec_name !== refInfo.codec_name ||
        v.width !== refInfo.width ||
        v.height !== refInfo.height ||
        v.pix_fmt !== refInfo.pix_fmt ||
        !a;
      if (needsFix) {
        const fixedPath = sceneFiles[i].replace(/\.mp4$/, '-fixed.mp4');
        await standardizeVideo(sceneFiles[i], fixedPath, refInfo);
        fs.renameSync(fixedPath, sceneFiles[i]);
        console.log(`[5G][BULLETPROOF] Fixed scene ${i + 1} video: ${sceneFiles[i]}`);
      } else {
        console.log(`[5G][BULLETPROOF] Scene ${i + 1} validated OK`);
      }
    } catch (err) {
      console.error(`[5G][BULLETPROOF][ERR] Validation failed for scene ${i + 1}`, err);
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
};
