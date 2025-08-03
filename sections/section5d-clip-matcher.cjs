// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Parallel Best-Pick)
// Launches R2, Pexels, Pixabay, Unsplash, Ken Burns in parallel
// Picks the best valid (existing, non-empty, not dupe) result
// MAX LOGGING EVERY STEP – No single-point failure!
// Upgraded: Main subject/mega-scene anchoring for visual continuity
// Dedupes all clips used per job. Bulletproof R2 matching.
// R2 ingestion is now queued, not blocking, with categoryFolder!
// ===========================================================

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { findUnsplashImageForScene } = require('./section10f-unsplash-image-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
const { cleanForFilename } = require('./section10e-upload-to-r2.cjs');
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
 * - Queues new external matches for post-job R2 ingestion with correct categoryFolder.
 * jobContext must have a clipsToIngest array for post-job R2 uploads!
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
  forceClipPath = null,
  jobContext = {},
  categoryFolder // <--- must be passed in from your orchestrator!
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
  if (!findR2ClipForScene || !findPexelsClipForScene || !findPixabayClipForScene || !findUnsplashImageForScene || !fallbackKenBurnsVideo) {
    console.error('[5D][FATAL][HELPERS] One or more clip helpers not loaded!');
    return null;
  }

  // --- Dedicated R2 clip search with advanced fuzzy deduping logic ---
  async function findDedupedR2Clip(searchPhrase, usedClipsArr) {
    try {
      const r2Files = await findR2ClipForScene.getAllFiles
        ? await findR2ClipForScene.getAllFiles()
        : [];
      const normPhrase = normalizeStr(searchPhrase);
      let found = null;
      console.log(`[5D][R2][${jobId}] Searching for phrase: "${searchPhrase}" (norm: "${normPhrase}")`);
      for (const fname of r2Files) {
        const base = path.basename(fname);
        const normBase = normalizeStr(base);
        if (usedClipsArr.includes(fname)) {
          console.log(`[5D][R2][${jobId}] SKIP used: "${base}"`);
          continue;
        }
        if (normBase.includes(normPhrase) || normPhrase.includes(normBase)) {
          found = fname;
          console.log(`[5D][R2][${jobId}] MATCHED: "${base}" for "${searchPhrase}"`);
          break;
        } else {
          console.log(`[5D][R2][${jobId}] No match: "${base}"`);
        }
      }
      if (!found) {
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
    r2Result = await findDedupedR2Clip(searchSubject, usedClips);
    if (r2Result) {
      console.log(`[5D][PICK][${jobId}] R2 deduped match: ${r2Result}`);
      return r2Result;
    }
    console.log(`[5D][FALLBACK][${jobId}] No R2 found, trying Pexels/Pixabay/Unsplash.`);
  } else {
    try {
      r2Result = await findR2ClipForScene(searchSubject, workDir, sceneIdx, jobId, usedClips);
      if (r2Result && !usedClips.includes(r2Result)) {
        console.log(`[5D][PICK][${jobId}] R2 legacy match: ${r2Result}`);
        return r2Result;
      }
    } catch (e) {
      console.error(`[5D][R2][ERR][${jobId}]`, e);
    }
    console.log(`[5D][FALLBACK][${jobId}] No R2 found, trying Pexels/Pixabay/Unsplash.`);
  }

  // --- Try Pexels ---
  let pexelsResult = null;
  try {
    pexelsResult = await findPexelsClipForScene(searchSubject, workDir, sceneIdx, jobId, usedClips);
    if (pexelsResult && !usedClips.includes(pexelsResult)) {
      console.log(`[5D][PICK][${jobId}] Pexels match: ${pexelsResult}`);
      // === NEW: Queue for post-job R2 ingestion, do not upload now!
      if (jobContext && Array.isArray(jobContext.clipsToIngest)) {
        jobContext.clipsToIngest.push({
          localPath: pexelsResult,
          subject: searchSubject,
          sceneIdx,
          source: 'pexels',
          categoryFolder
        });
        console.log(`[5D][QUEUE][${jobId}] Queued Pexels clip for R2 upload:`, pexelsResult, '→', categoryFolder);
      }
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
      // === NEW: Queue for post-job R2 ingestion, do not upload now!
      if (jobContext && Array.isArray(jobContext.clipsToIngest)) {
        jobContext.clipsToIngest.push({
          localPath: pixabayResult,
          subject: searchSubject,
          sceneIdx,
          source: 'pixabay',
          categoryFolder
        });
        console.log(`[5D][QUEUE][${jobId}] Queued Pixabay clip for R2 upload:`, pixabayResult, '→', categoryFolder);
      }
      return pixabayResult;
    }
  } catch (e) {
    console.error(`[5D][PIXABAY][ERR][${jobId}]`, e);
  }

  // --- Try Unsplash (image fallback, not video) ---
  let unsplashResult = null;
  try {
    unsplashResult = await findUnsplashImageForScene(searchSubject, workDir, sceneIdx, jobId, usedClips, jobContext);
    if (unsplashResult && !usedClips.includes(unsplashResult)) {
      console.log(`[5D][PICK][${jobId}] Unsplash image fallback match: ${unsplashResult}`);
      // (Already queued in helper if jobContext given)
      return unsplashResult;
    }
  } catch (e) {
    console.error(`[5D][UNSPLASH][ERR][${jobId}]`, e);
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
