// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR
// Tries R2, then Pexels, then Pixabay, then Ken Burns fallback
// All helpers are required from section10a/b/c/d
// MAX LOGGING EVERY STEP
// Enhanced: Mega-scene support, dedupe
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
 * @param {Object} opts
 *   @param {string} subject - Clean visual subject
 *   @param {number} sceneIdx - Scene number (0-based)
 *   @param {Array<string>} allSceneTexts - All script lines (context)
 *   @param {string} mainTopic - Main script topic (context)
 *   @param {boolean} isMegaScene - true if this is the hook+main scene
 *   @param {Array<string>} usedClips - All already-used clip URLs/paths
 * @returns {Promise<string|null>} Video URL or local path
 */
async function findClipForScene({
  subject,
  sceneIdx,
  allSceneTexts,
  mainTopic,
  isMegaScene = false,
  usedClips = [],
}) {
  console.log(`[5D][MATCH] findClipForScene | sceneIdx=${sceneIdx} | subject="${subject}" | mainTopic="${mainTopic}" | isMegaScene=${isMegaScene}`);
  if (usedClips && usedClips.length) {
    console.log(`[5D][MATCH] Used clips so far: ${JSON.stringify(usedClips)}`);
  }

  // --- For mega-scene, always use main topic as subject ---
  let searchSubject = isMegaScene ? mainTopic : subject;
  if (isMegaScene) {
    console.log(`[5D][MEGA] Mega-scene detected. Overriding subject to mainTopic: "${mainTopic}"`);
  }

  // Dedupe logic: If a clip is found in usedClips, skip it and try the next-best match.
  // The R2, Pexels, and Pixabay helpers should accept a usedClips/exclude list if possible.
  // If not, filter after.

  // 1. Try R2 first
  try {
    const r2Url = await findR2Clip(searchSubject, sceneIdx, mainTopic, usedClips);
    if (r2Url && !usedClips.includes(r2Url)) {
      console.log(`[5D][R2] Matched: ${r2Url}`);
      return r2Url;
    } else if (r2Url) {
      console.warn(`[5D][R2] R2 match "${r2Url}" was already used. Skipping.`);
    } else {
      console.log(`[5D][R2] No match for "${searchSubject}"`);
    }
  } catch (err) {
    console.error('[5D][R2][ERR] Error in findR2Clip:', err);
  }

  // 2. Try Pexels
  try {
    const pexelsUrl = await findPexelsClip(searchSubject, sceneIdx, mainTopic, usedClips);
    if (pexelsUrl && !usedClips.includes(pexelsUrl)) {
      console.log(`[5D][PEXELS] Matched: ${pexelsUrl}`);
      return pexelsUrl;
    } else if (pexelsUrl) {
      console.warn(`[5D][PEXELS] Pexels match "${pexelsUrl}" was already used. Skipping.`);
    } else {
      console.log(`[5D][PEXELS] No match for "${searchSubject}"`);
    }
  } catch (err) {
    console.error('[5D][PEXELS][ERR] Error in findPexelsClip:', err);
  }

  // 3. Try Pixabay
  try {
    const pixabayUrl = await findPixabayClip(searchSubject, sceneIdx, mainTopic, usedClips);
    if (pixabayUrl && !usedClips.includes(pixabayUrl)) {
      console.log(`[5D][PIXABAY] Matched: ${pixabayUrl}`);
      return pixabayUrl;
    } else if (pixabayUrl) {
      console.warn(`[5D][PIXABAY] Pixabay match "${pixabayUrl}" was already used. Skipping.`);
    } else {
      console.log(`[5D][PIXABAY] No match for "${searchSubject}"`);
    }
  } catch (err) {
    console.error('[5D][PIXABAY][ERR] Error in findPixabayClip:', err);
  }

  // 4. Fallback: Ken Burns pan video from image
  try {
    const kenBurnsPath = await fallbackKenBurnsVideo(searchSubject, usedClips);
    if (kenBurnsPath && !usedClips.includes(kenBurnsPath)) {
      console.log(`[5D][KENBURNS] Fallback image video created: ${kenBurnsPath}`);
      return kenBurnsPath;
    } else if (kenBurnsPath) {
      console.warn(`[5D][KENBURNS] Ken Burns fallback "${kenBurnsPath}" was already used. Skipping.`);
    } else {
      console.log(`[5D][KENBURNS] No fallback video created for "${searchSubject}"`);
    }
  } catch (err) {
    console.error('[5D][KENBURNS][ERR] Fallback failed:', err);
  }

  // Final fail
  console.warn(`[5D][NO MATCH] No clip found for "${searchSubject}" (scene ${sceneIdx + 1})`);
  return null;
}

module.exports = { findClipForScene };
