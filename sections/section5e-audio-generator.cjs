// ===========================================================
// SECTION 5E: AUDIO GENERATOR
// Handles scene audio generation, narration, and audio utilities.
// MAX LOGGING AT EVERY STEP
// Enhanced: Mega-scene (multi-line) audio support
// ===========================================================

const fs = require('fs');
const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

// Import TTS helpers (Polly, ElevenLabs, etc)
const { generateSceneAudio } = require('./section5a-tts-helpers.cjs');

console.log('[5E][INIT] Audio generator loaded.');

// === Single scene audio (one line) ===
/**
 * Generates narration audio for a given scene, using the correct provider.
 * Handles output paths, checks output validity, and logs every step.
 * @param {string} sceneText - Text to speak
 * @param {string} voiceId - TTS voice ID
 * @param {string} outPath - Where to save MP3
 * @param {string} provider - TTS provider name (polly/elevenlabs)
 * @returns {Promise<string>} - Resolves to outPath if successful
 */
async function createSceneAudio(sceneText, voiceId, outPath, provider) {
  console.log(`[5E][AUDIOGEN] createSceneAudio called: text="${sceneText}" | voiceId=${voiceId} | outPath=${outPath} | provider=${provider}`);
  try {
    await generateSceneAudio(sceneText, voiceId, outPath, provider);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
      throw new Error(`[5E][AUDIOGEN][ERR] Audio file not created or too small: ${outPath}`);
    }
    console.log(`[5E][AUDIOGEN] Audio successfully created: ${outPath}`);
    return outPath;
  } catch (err) {
    console.error(`[5E][AUDIOGEN][ERR] Failed to generate scene audio for "${sceneText}" [${voiceId}]`, err);
    throw err;
  }
}

// === Mega-scene (multi-line) audio generation ===
/**
 * Generates and merges audio for all lines in a mega-scene (e.g., hook+main).
 * @param {Array<string>} texts - Texts for each line (e.g., [hook, main subject])
 * @param {string} voiceId - TTS voice ID
 * @param {string} outPath - Output path for merged audio
 * @param {string} provider - TTS provider name
 * @param {string} tmpDir - Temp working directory for intermediate files
 * @returns {Promise<string>} - Path to merged audio
 */
async function createMegaSceneAudio(texts, voiceId, outPath, provider, tmpDir) {
  console.log(`[5E][MEGA] createMegaSceneAudio called: ${texts.length} lines, voiceId=${voiceId}, provider=${provider}, outPath=${outPath}`);
  if (!Array.isArray(texts) || !texts.length) {
    throw new Error('[5E][MEGA][ERR] No texts provided for mega-scene audio.');
  }

  const partPaths = [];
  for (let i = 0; i < texts.length; i++) {
    const partPath = path.resolve(tmpDir, `mega-part${i + 1}-${Date.now()}.mp3`);
    try {
      await createSceneAudio(texts[i], voiceId, partPath, provider);
      partPaths.push(partPath);
    } catch (err) {
      console.error(`[5E][MEGA][ERR] Audio failed for mega-part ${i + 1} (${texts[i].slice(0, 40)}...)`, err);
      throw err;
    }
  }

  // Optionally, add 0.1s silence gap between clips for clarity
  let listFile = path.resolve(tmpDir, `mega-concat-list-${Date.now()}.txt`);
  let silencePath = path.resolve(tmpDir, `mega-silence-100ms.mp3`);
  let silenceCreated = false;

  try {
    // Create 100ms silence file if needed (ffmpeg)
    if (partPaths.length > 1) {
      const silenceCmd = `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 0.10 -q:a 9 -acodec libmp3lame "${silencePath}" -y`;
      await exec(silenceCmd);
      silenceCreated = fs.existsSync(silencePath);
      console.log(`[5E][MEGA] Silence file created: ${silencePath} (${silenceCreated ? 'OK' : 'FAIL'})`);
    }

    // Build concat list file
    let concatParts = [];
    for (let i = 0; i < partPaths.length; i++) {
      concatParts.push(`file '${partPaths[i]}'`);
      if (i < partPaths.length - 1 && silenceCreated) {
        concatParts.push(`file '${silencePath}'`);
      }
    }
    fs.writeFileSync(listFile, concatParts.join('\n'), 'utf8');
    console.log(`[5E][MEGA] Concat list for mega-scene:\n${concatParts.join('\n')}`);

    // Concat with ffmpeg
    const concatCmd = `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${outPath}" -y`;
    console.log(`[5E][MEGA] Running ffmpeg concat command:\n${concatCmd}`);
    await exec(concatCmd);

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
      throw new Error(`[5E][MEGA][ERR] Mega audio file not created or too small: ${outPath}`);
    }
    console.log(`[5E][MEGA] Mega-scene audio successfully created: ${outPath}`);
    // Cleanup temp files
    for (const f of [...partPaths, listFile, silenceCreated ? silencePath : null]) {
      if (f && fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    }
    return outPath;
  } catch (err) {
    console.error(`[5E][MEGA][ERR] Failed during concat/cleanup for mega-scene audio`, err);
    throw err;
  }
}

// === Utility: Checks if an audio file exists and is valid. ===
/**
 * Utility: Checks if an audio file exists and is valid.
 * @param {string} audioPath
 * @returns {boolean}
 */
function isAudioValid(audioPath) {
  try {
    if (!fs.existsSync(audioPath)) {
      console.log(`[5E][CHECK] isAudioValid: ${audioPath} does not exist.`);
      return false;
    }
    const sz = fs.statSync(audioPath).size;
    const valid = sz > 1024;
    console.log(`[5E][CHECK] isAudioValid: ${audioPath} (${sz} bytes) → ${valid}`);
    return valid;
  } catch (err) {
    console.warn(`[5E][CHECK][ERR] isAudioValid error:`, err);
    return false;
  }
}

// === Batch generator: handles both mega and single scenes ===
/**
 * Batch-generate audio for all scenes (mega and single).
 * Each scene object: { id, texts: [str], ... }
 * @param {Array<{id: string, texts: string[]}>} scenes
 * @param {string} voiceId
 * @param {string} provider
 * @param {string} workDir
 * @returns {Promise<Array<string>>} Array of audio file paths
 */
async function batchGenerateSceneAudio(scenes, voiceId, provider, workDir) {
  console.log(`[5E][BATCH] batchGenerateSceneAudio called: ${scenes.length} scenes, voice=${voiceId}, provider=${provider}`);
  const results = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const outPath = path.resolve(workDir, `${s.id || `scene${i + 1}`}-audio.mp3`);
    try {
      if (Array.isArray(s.texts) && s.texts.length > 1) {
        // Mega-scene
        await createMegaSceneAudio(s.texts, voiceId, outPath, provider, workDir);
        console.log(`[5E][BATCH] Mega-scene audio created for scene ${i + 1}: ${outPath}`);
      } else if (Array.isArray(s.texts) && s.texts.length === 1) {
        await createSceneAudio(s.texts[0], voiceId, outPath, provider);
        console.log(`[5E][BATCH] Single-scene audio created for scene ${i + 1}: ${outPath}`);
      } else {
        throw new Error('[5E][BATCH][ERR] Scene texts missing or invalid');
      }
      results.push(outPath);
    } catch (err) {
      console.error(`[5E][BATCH][ERR] Audio failed for scene ${i + 1}: ID=${s.id}`, err);
      results.push(null);
    }
  }
  console.log(`[5E][BATCH] batchGenerateSceneAudio complete.`);
  return results;
}

module.exports = {
  createSceneAudio,
  createMegaSceneAudio,
  isAudioValid,
  batchGenerateSceneAudio,
};
