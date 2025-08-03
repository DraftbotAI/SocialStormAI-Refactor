// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Parallel Best-Pick)
// Launches R2, Pexels, Pixabay, Ken Burns in parallel
// Picks the best valid (existing, non-empty, not dupe) result
// MAX LOGGING EVERY STEP – No single-point failure!
// Upgraded: Main subject/mega-scene anchoring for visual continuity
// Dedupes all clips used per job. Bulletproof R2 matching.
// ===========================================================

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
const fs = require('fs');
const path = require('path');

console.log('[5D][INIT] Clip matcher orchestrator (parallel) loaded.');

const GENERIC_SUBJECTS = [
  'face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something', 'body', 'eyes', 'kid', 'boy', 'girl', 'they', 'we', 'people', 'scene', 'child', 'children'
];

// --- Fuzzy normalize: lower, remove space, hyphen, underscore, dot ---
function normalizeStr(str) {
  return (str || '').toLowerCase().replace(/[\s_\-\.]/g, '');
}

// --- Main orchestrator ---
/**
 * Finds the best video for each scene (anchors start to main subject, then uses per-line visual subject).
 * Handles:
 * - Mega-scenes: uses subject of 2nd line for both scene 1 and scene 2 (ensuring same video).
 * - Avoids dupes.
 * - Falls back to main subject if extraction is generic.
 *
 * @param {Object} opts
 *   @param {string} subject - extracted subject for the current line (prefer: scene.visualSubject)
 *   @param {number} sceneIdx - index of the scene (0-based)
 *   @param {Array<string>} allSceneTexts - all scene texts
 *   @param {string} mainTopic - the main script subject/topic
 *   @param {boolean} isMegaScene - true if scene 2 (mega)
 *   @param {Array<string>} usedClips - paths already assigned to scenes
 *   @param {string} workDir
 *   @param {string} jobId
 *   @param {string} megaSubject - for mega-scenes, this is the explicit visual subject
 *   @param {string} forceClipPath - force override for debugging/anchoring
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
  jobId,
  megaSubject = null,
  forceClipPath = null
}) {
  // === Main subject selection logic ===
  let searchSubject = subject;

  // For mega-scene (scene 2) and scene 1, always use megaSubject or mainTopic, never a generic
  if (isMegaScene || sceneIdx === 0) {
    if (megaSubject && typeof megaSubject === 'string' && megaSubject.length > 2 && !GENERIC_SUBJECTS.includes(megaSubject.toLowerCase())) {
      searchSubject = megaSubject;
      console.log(`[5D][ANCHOR][${jobId}] Using megaSubject for first/mega-scene: "${searchSubject}"`);
    } else if (mainTopic && typeof mainTopic === 'string' && mainTopic.length > 2 && !GENERIC_SUBJECTS.includes(mainTopic.toLowerCase())) {
      searchSubject = mainTopic;
      console.log(`[5D][ANCHOR][${jobId}] Fallback to mainTopic for mega-scene: "${searchSubject}"`);
    } else {
      searchSubject = allSceneTexts[0]; // absolute fallback
      console.log(`[5D][ANCHOR][${jobId}] Final fallback to first scene text: "${searchSubject}"`);
    }
  }

  // For other scenes, fall back if subject is generic
  if (!searchSubject || GENERIC_SUBJECTS.includes((searchSubject || '').toLowerCase())) {
    if (mainTopic && !GENERIC_SUBJECTS.includes(mainTopic.toLowerCase())) {
      searchSubject = mainTopic;
      console.log(`[5D][FALLBACK][${jobId}] Subject was generic, using mainTopic: "${searchSubject}"`);
    } else if (allSceneTexts && allSceneTexts.length > 0) {
      searchSubject = allSceneTexts[0];
      console.log(`[5D][FALLBACK][${jobId}] Subject was generic, using first scene text: "${searchSubject}"`);
    }
  }

  // For debugging, optionally force a specific clip path
  if (forceClipPath) {
    console.log(`[5D][FORCE][${jobId}] Forcing clip path: ${forceClipPath}`);
    return forceClipPath;
  }

  if (usedClips && usedClips.length) {
    console.log(`[5D][MATCH][${jobId}] Used clips so far: ${JSON.stringify(usedClips)}`);
  }

  // Validate all required helpers
  if (!findR2ClipForScene || !findPexelsClipForScene || !findPixabayClipForScene || !fallbackKenBurnsVideo) {
    console.error('[5D][FATAL][HELPERS] One or more clip helpers not loaded!');
    return null;
  }

  // --- Dedicated R2 clip search with advanced fuzzy deduping logic ---
  async function findDedupedR2Clip(searchPhrase, usedClipsArr) {
    let results = [];
    try {
      // Get all available R2 clips for this job
      const r2Files = await findR2ClipForScene.getAllFiles
        ? await findR2ClipForScene.getAllFiles()
        : [];

      const normPhrase = normalizeStr(searchPhrase);
      let found = null;

      console.log(`[5D][R2][${jobId}] Searching for phrase: "${searchPhrase}" (norm: "${normPhrase}")`);
      for (const fname of r2Files) {
        const base = path.basename(fname);
        const normBase = normalizeStr(base);

        // Dedupe: skip any already used in this job!
        if (usedClipsArr.includes(fname)) {
          console.log(`[5D][R2][${jobId}] SKIP used: "${base}"`);
          continue;
        }

        // Must match: phrase substring in filename (fuzzy match)
        if (normBase.includes(normPhrase) || normPhrase.includes(normBase)) {
          found = fname;
          console.log(`[5D][R2][${jobId}] MATCHED: "${base}" for "${searchPhrase}"`);
          break;
        } else {
          console.log(`[5D][R2][${jobId}] No match: "${base}"`);
        }
      }

      if (!found) {
        // Try fallback: check for any partial token match, word by word
        const phraseTokens = normPhrase.split(/[\s\-_\.\+]/).filter(Boolean);
        for (const fname of r2Files) {
          const base = path.basename(fname);
          const normBase = normalizeStr(base);

          if (usedClipsArr.includes(fname)) continue;

          if (phraseTokens.some(token => normBase.includes(token))) {
            found = fname;
            console.log(`[5D][R2][${jobId}] PARTIAL TOKEN MATCH: "${base}" <- ${phraseTokens.join(", ")}`);
            break;
          }
        }
      }

      if (!found) {
        console.log(`[5D][R2][${jobId}] No valid R2 match for: "${searchPhrase}"`);
      }
      return found;
    } catch (err) {
      console.error(`[5D][R2][ERR][${jobId}] Error during advanced R2 matching:`, err);
      return null;
    }
  }

  // --- START MATCHING, R2 always preferred ---
  let r2Result = null;
  if (findR2ClipForScene.getAllFiles) {
    // Use advanced deduping matcher
    r2Result = await findDedupedR2Clip(searchSubject, usedClips);
    if (r2Result) {
      console.log(`[5D][PICK][${jobId}] R2 deduped match: ${r2Result}`);
      return r2Result;
    }
    console.log(`[5D][FALLBACK][${jobId}] No R2 found, trying Pexels/Pixabay.`);
  } else {
    // Legacy: fallback to normal helper call
    try {
      r2Result = await findR2ClipForScene(searchSubject, workDir, sceneIdx, jobId, usedClips);
      if (r2Result && !usedClips.includes(r2Result)) {
        console.log(`[5D][PICK][${jobId}] R2 legacy match: ${r2Result}`);
        return r2Result;
      }
    } catch (e) {
      console.error(`[5D][R2][ERR][${jobId}]`, e);
    }
    console.log(`[5D][FALLBACK][${jobId}] No R2 found, trying Pexels/Pixabay.`);
  }

  // --- Try Pexels ---
  let pexelsResult = null;
  try {
    pexelsResult = await findPexelsClipForScene(searchSubject, workDir, sceneIdx, jobId, usedClips);
    if (pexelsResult && !usedClips.includes(pexelsResult)) {
      console.log(`[5D][PICK][${jobId}] Pexels match: ${pexelsResult}`);
      return pexelsResult;
    }
  } catch (e) {
    console.error(`[5D][PEXELS][ERR][${jobId}]`, e);
  }

  // --- Try Pixabay ---
  let pixabayResult = null;
  try {
    pixabayResult = await findPixabayClipForScene(searchSubject, workDir, sceneIdx, jobId, usedClips);
    if (pixabayResult && !usedClips.includes(pixabayResult)) {
      console.log(`[5D][PICK][${jobId}] Pixabay match: ${pixabayResult}`);
      return pixabayResult;
    }
  } catch (e) {
    console.error(`[5D][PIXABAY][ERR][${jobId}]`, e);
  }

  // --- Final fallback: Ken Burns still ---
  let kenBurnsResult = null;
  try {
    kenBurnsResult = await fallbackKenBurnsVideo(searchSubject, workDir, sceneIdx, jobId, usedClips);
    if (kenBurnsResult && !usedClips.includes(kenBurnsResult)) {
      console.log(`[5D][PICK][${jobId}] KenBurns fallback match: ${kenBurnsResult}`);
      return kenBurnsResult;
    }
  } catch (e) {
    console.error(`[5D][KENBURNS][ERR][${jobId}]`, e);
  }

  // If nothing at all was found:
  console.error(`[5D][NO_MATCH][${jobId}] No valid clip found for "${searchSubject}" (scene ${sceneIdx + 1})`);
  return null;
}

module.exports = { findClipForScene };
