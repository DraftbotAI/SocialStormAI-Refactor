// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR
// Tries R2, then Pexels, then Pixabay, then Ken Burns fallback
// All helpers are required from section10a/b/c/d
// MAX LOGGING EVERY STEP
// Enhanced: Mega-scene support, dedupe, traceability
// ===========================================================

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene } = require('./section10c-pixabay-clip-helper.cjs');
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
 *   @param {string} workDir - Directory for storing downloaded clips (REQUIRED)
 *   @param {string} jobId - Job identifier (for max logging)
 * @returns {Promise<string|null>} Video file path or remote URL
 */
async function findClipForScene({
  subject,
  sceneIdx,
  allSceneTexts,
  mainTopic,
  isMegaScene = false,
  usedClips = [],
  workDir,
  jobId
}) {
  console.log(`[5D][MATCH][${jobId}] findClipForScene | sceneIdx=${sceneIdx} | subject="${subject}" | mainTopic="${mainTopic}" | isMegaScene=${isMegaScene} | workDir=${workDir}`);

  if (usedClips && usedClips.length) {
    console.log(`[5D][MATCH][${jobId}] Used clips so far: ${JSON.stringify(usedClips)}`);
  }

  // Defensive: Ensure helpers exist
  if (!findR2ClipForScene || !findPexelsClipForScene || !findPixabayClipForScene || !fallbackKenBurnsVideo) {
    console.error('[5D][FATAL][HELPERS] One or more clip helpers not loaded!');
    return null;
  }

  // --- For mega-scene, always use main topic as subject ---
  let searchSubject = isMegaScene ? mainTopic : subject;
  if (isMegaScene) {
    console.log(`[5D][MEGA][${jobId}] Mega-scene detected. Overriding subject to mainTopic: "${mainTopic}"`);
  }

  // 1. Try R2 first
  try {
    const r2Path = await findR2ClipForScene(
      searchSubject, workDir, sceneIdx, jobId, usedClips
    );
    if (r2Path && !usedClips.includes(r2Path)) {
      console.log(`[5D][R2][${jobId}] Matched: ${r2Path}`);
      return r2Path;
    } else if (r2Path) {
      console.warn(`[5D][R2][${jobId}] R2 match "${r2Path}" was already used. Skipping.`);
    } else {
      console.log(`[5D][R2][${jobId}] No R2 match for "${searchSubject}"`);
    }
  } catch (err) {
    console.error(`[5D][R2][ERR][${jobId}] Error in findR2ClipForScene:`, err);
  }

  // 2. Try Pexels
  try {
    const pexelsPath = await findPexelsClipForScene(
      searchSubject, workDir, sceneIdx, jobId, usedClips
    );
    if (pexelsPath && !usedClips.includes(pexelsPath)) {
      console.log(`[5D][PEXELS][${jobId}] Matched: ${pexelsPath}`);
      return pexelsPath;
    } else if (pexelsPath) {
      console.warn(`[5D][PEXELS][${jobId}] Pexels match "${pexelsPath}" was already used. Skipping.`);
    } else {
      console.log(`[5D][PEXELS][${jobId}] No Pexels match for "${searchSubject}"`);
    }
  } catch (err) {
    console.error(`[5D][PEXELS][ERR][${jobId}] Error in findPexelsClipForScene:`, err);
  }

  // 3. Try Pixabay
  try {
    const pixabayPath = await findPixabayClipForScene(
      searchSubject, workDir, sceneIdx, jobId, usedClips
    );
    if (pixabayPath && !usedClips.includes(pixabayPath)) {
      console.log(`[5D][PIXABAY][${jobId}] Matched: ${pixabayPath}`);
      return pixabayPath;
    } else if (pixabayPath) {
      console.warn(`[5D][PIXABAY][${jobId}] Pixabay match "${pixabayPath}" was already used. Skipping.`);
    } else {
      console.log(`[5D][PIXABAY][${jobId}] No Pixabay match for "${searchSubject}"`);
    }
  } catch (err) {
    console.error(`[5D][PIXABAY][ERR][${jobId}] Error in findPixabayClipForScene:`, err);
  }

  // 4. Fallback: Ken Burns pan video from image
  try {
    const kenBurnsPath = await fallbackKenBurnsVideo(
      searchSubject, workDir, sceneIdx, jobId, usedClips
    );
    if (kenBurnsPath && !usedClips.includes(kenBurnsPath)) {
      console.log(`[5D][KENBURNS][${jobId}] Fallback image video created: ${kenBurnsPath}`);
      return kenBurnsPath;
    } else if (kenBurnsPath) {
      console.warn(`[5D][KENBURNS][${jobId}] Ken Burns fallback "${kenBurnsPath}" was already used. Skipping.`);
    } else {
      console.log(`[5D][KENBURNS][${jobId}] No fallback video created for "${searchSubject}"`);
    }
  } catch (err) {
    console.error(`[5D][KENBURNS][ERR][${jobId}] Fallback failed:`, err);
  }

  // Final fail
  console.warn(`[5D][NO MATCH][${jobId}] No clip found for "${searchSubject}" (scene ${sceneIdx + 1})`);
  return null;
}

module.exports = { findClipForScene };
