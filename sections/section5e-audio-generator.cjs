// ===========================================================
// SECTION 5E: AUDIO GENERATOR
// Handles scene audio generation, narration, and audio utilities.
// MAX LOGGING AT EVERY STEP
// ===========================================================

const fs = require('fs');
const path = require('path');

// Import TTS helpers (Polly, ElevenLabs, etc)
const { generateSceneAudio } = require('./section5a-tts-helpers.cjs');

console.log('[5E][INIT] Audio generator loaded.');

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

/**
 * Utility: (Future) Batch-generate audio for all scenes in parallel.
 * (Not used in the serial version, but ready for scaling.)
 * @param {Array<{text: string, id: string}>} scenes
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
      await createSceneAudio(s.text, voiceId, outPath, provider);
      results.push(outPath);
    } catch (err) {
      console.error(`[5E][BATCH][ERR] Audio failed for scene ${i + 1} (${s.text.slice(0, 30)}...)`, err);
      results.push(null); // Or handle errors as needed
    }
  }
  console.log(`[5E][BATCH] batchGenerateSceneAudio complete.`);
  return results;
}

module.exports = {
  createSceneAudio,
  isAudioValid,
  batchGenerateSceneAudio,
};
