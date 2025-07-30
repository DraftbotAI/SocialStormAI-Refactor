// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Parallel Best-Pick)
// Launches R2, Pexels, Pixabay, Ken Burns in parallel
// Picks the best valid (existing, non-empty, not dupe) result
// MAX LOGGING EVERY STEP – No single-point failure!
// ===========================================================

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
const fs = require('fs');

console.log('[5D][INIT] Clip matcher orchestrator (parallel) loaded.');

/**
 * Find the best video for a scene by running all sources in parallel.
 * Returns: local file path (preferred order: R2, Pexels, Pixabay, Ken Burns)
 * But will pick *any* valid result if some fail. Zero single-point failure.
 *
 * @param {Object} opts
 *   @param {string} subject
 *   @param {number} sceneIdx
 *   @param {Array<string>} allSceneTexts
 *   @param {string} mainTopic
 *   @param {boolean} isMegaScene
 *   @param {Array<string>} usedClips
 *   @param {string} workDir
 *   @param {string} jobId
 * @returns {Promise<string|null>} Best video file path or null
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

  // Validate all required helpers
  if (!findR2ClipForScene || !findPexelsClipForScene || !findPixabayClipForScene || !fallbackKenBurnsVideo) {
    console.error('[5D][FATAL][HELPERS] One or more clip helpers not loaded!');
    return null;
  }

  let searchSubject = isMegaScene ? mainTopic : subject;
  if (isMegaScene) {
    console.log(`[5D][MEGA][${jobId}] Mega-scene: overriding subject to mainTopic "${mainTopic}"`);
  }

  // Helper to check if file is valid (exists, not empty, not dupe)
  function isValidClip(path) {
    if (!path) return false;
    if (usedClips && usedClips.includes(path)) {
      console.warn(`[5D][DUPLICATE][${jobId}] Skipping used clip: ${path}`);
      return false;
    }
    try {
      const exists = fs.existsSync(path);
      const size = exists ? fs.statSync(path).size : 0;
      if (!exists || size < 2048) {
        console.warn(`[5D][INVALID][${jobId}] File invalid or too small: ${path} (size: ${size})`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[5D][INVALID][${jobId}] File error: ${path}`, err);
      return false;
    }
  }

  // Start all source promises in parallel!
  const promises = [
    (async () => {
      try {
        const res = await findR2ClipForScene(searchSubject, workDir, sceneIdx, jobId, usedClips);
        if (res) console.log(`[5D][R2][${jobId}] Candidate: ${res}`);
        return res;
      } catch (e) {
        console.error(`[5D][R2][ERR][${jobId}]`, e);
        return null;
      }
    })(),
    (async () => {
      try {
        const res = await findPexelsClipForScene(searchSubject, workDir, sceneIdx, jobId, usedClips);
        if (res) console.log(`[5D][PEXELS][${jobId}] Candidate: ${res}`);
        return res;
      } catch (e) {
        console.error(`[5D][PEXELS][ERR][${jobId}]`, e);
        return null;
      }
    })(),
    (async () => {
      try {
        const res = await findPixabayClipForScene(searchSubject, workDir, sceneIdx, jobId, usedClips);
        if (res) console.log(`[5D][PIXABAY][${jobId}] Candidate: ${res}`);
        return res;
      } catch (e) {
        console.error(`[5D][PIXABAY][ERR][${jobId}]`, e);
        return null;
      }
    })(),
    (async () => {
      try {
        const res = await fallbackKenBurnsVideo(searchSubject, workDir, sceneIdx, jobId, usedClips);
        if (res) console.log(`[5D][KENBURNS][${jobId}] Candidate: ${res}`);
        return res;
      } catch (e) {
        console.error(`[5D][KENBURNS][ERR][${jobId}]`, e);
        return null;
      }
    })(),
  ];

  // Wait for all sources to return (no crash if one fails!)
  let results;
  try {
    results = await Promise.all(promises);
  } catch (err) {
    console.error(`[5D][PROMISE][ERR][${jobId}] Error in Promise.all:`, err);
    results = [];
  }

  // Preferred order: R2, then Pexels, then Pixabay, then Ken Burns
  const preferred = ['R2', 'Pexels', 'Pixabay', 'KenBurns'];
  let bestResult = null;
  for (let i = 0; i < results.length; i++) {
    const label = preferred[i] || `Source${i}`;
    const candidate = results[i];
    if (isValidClip(candidate)) {
      console.log(`[5D][PICK][${jobId}] Selected clip from ${label}: ${candidate}`);
      bestResult = candidate;
      break;
    } else if (candidate) {
      console.warn(`[5D][SKIP][${jobId}] Rejected invalid ${label} candidate: ${candidate}`);
    }
  }

  if (!bestResult) {
    console.error(`[5D][NO_MATCH][${jobId}] No valid clip found for "${searchSubject}" (scene ${sceneIdx + 1})`);
    return null;
  }

  return bestResult;
}

module.exports = { findClipForScene };
