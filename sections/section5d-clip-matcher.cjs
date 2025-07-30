// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR
// Tries R2, then Pexels, then Pixabay, then Ken Burns fallback
// All helpers are required from section10a/b/c/d
// MAX LOGGING EVERY STEP
// ===========================================================

const { findR2Clip } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClip } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClip } = require('./section10c-pixabay-clip-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');

console.log('[5D][INIT] Clip matcher orchestrator loaded.');

/**
 * Finds the best video for a scene by source priority:
 *  1. Cloudflare R2
 *  2. Pexels video
 *  3. Pixabay video
 *  4. Ken Burns pan fallback (if all else fails)
 * @param {string} subject - Clean visual subject
 * @param {number} sceneIdx - Scene number (0-based)
 * @param {Array<string>} allSceneTexts - All script lines (context)
 * @param {string} mainTopic - Main script topic (context)
 * @returns {Promise<string|null>} Video URL or local path
 */
async function findClipForScene(subject, sceneIdx, allSceneTexts, mainTopic) {
  console.log(`[5D][MATCH] findClipForScene | subject="${subject}" | sceneIdx=${sceneIdx} | mainTopic="${mainTopic}"`);

  // 1. Try R2 first
  try {
    const r2Url = await findR2Clip(subject, sceneIdx, mainTopic);
    if (r2Url) {
      console.log(`[5D][R2] Matched: ${r2Url}`);
      return r2Url;
    }
  } catch (err) {
    console.error('[5D][R2][ERR] Error in findR2Clip:', err);
  }

  // 2. Try Pexels
  try {
    const pexelsUrl = await findPexelsClip(subject, sceneIdx, mainTopic);
    if (pexelsUrl) {
      console.log(`[5D][PEXELS] Matched: ${pexelsUrl}`);
      return pexelsUrl;
    }
  } catch (err) {
    console.error('[5D][PEXELS][ERR] Error in findPexelsClip:', err);
  }

  // 3. Try Pixabay
  try {
    const pixabayUrl = await findPixabayClip(subject, sceneIdx, mainTopic);
    if (pixabayUrl) {
      console.log(`[5D][PIXABAY] Matched: ${pixabayUrl}`);
      return pixabayUrl;
    }
  } catch (err) {
    console.error('[5D][PIXABAY][ERR] Error in findPixabayClip:', err);
  }

  // 4. Fallback: Ken Burns pan video from image
  try {
    const kenBurnsPath = await fallbackKenBurnsVideo(subject);
    if (kenBurnsPath) {
      console.log(`[5D][KENBURNS] Fallback image video created: ${kenBurnsPath}`);
      return kenBurnsPath;
    }
  } catch (err) {
    console.error('[5D][KENBURNS][ERR] Fallback failed:', err);
  }

  // Final fail
  console.warn(`[5D][NO MATCH] No clip found for "${subject}" (scene ${sceneIdx + 1})`);
  return null;
}

module.exports = { findClipForScene };
