// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Loose Matching, No Dupe Loop)
// Launches R2, Pexels, Pixabay, Unsplash, Ken Burns in parallel
// Picks the best valid (existing, non-empty, not dupe) result
// MAX LOGGING EVERY STEP – No single-point failure!
// Upgraded: Mega-scene anchoring for visual continuity
// Dedupes all clips used per job. Bulletproof R2 matching.
// R2 ingestion is now queued, not blocking, with categoryFolder!
// 2024-08: GPT SUBJECT MATCHING — Prioritized, multi-tiered fallback
// Bulletproof: Only returns existing absolute local files. No bucket keys!
// ===========================================================

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { findUnsplashImageForScene } = require('./section10f-unsplash-image-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
const { cleanForFilename } = require('./section10e-upload-to-r2.cjs');
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');
const fs = require('fs');
const path = require('path');

console.log('[5D][INIT] Clip matcher orchestrator (looser match) loaded.');

const GENERIC_SUBJECTS = [
  'face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something', 'body', 'eyes', 'kid', 'boy', 'girl', 'they', 'we', 'people', 'scene', 'child', 'children'
];

// --- Looser subject match: Accepts ANY good part of the subject, not just exact ---
function subjectInFilename(filename, subject) {
  if (!filename || !subject) return false;
  const safeName = cleanForFilename(filename).toLowerCase();
  const subjectStr = cleanForFilename(subject).toLowerCase();
  if (!subjectStr || subjectStr.length < 2) return false;
  // Split subject into parts, filter stopwords
  const stopwords = new Set(['the','of','and','in','on','with','to','is','for','at','by','as','a','an','from','about','into','over','under','across']);
  const parts = subjectStr.split(/[\s_\-\.]+/).filter(p => p && p.length > 2 && !stopwords.has(p));
  // Try to match any strong part (longest first)
  for (const part of parts.sort((a,b)=>b.length-a.length)) {
    if (safeName.includes(part)) {
      return true;
    }
  }
  // Fallback: substring match if everything else fails (at least 4 chars)
  if (safeName.includes(subjectStr.slice(0, Math.max(4,subjectStr.length/2)))) {
    return true;
  }
  return false;
}

function assertFileExists(file, label = 'FILE', minSize = 10240) {
  try {
    if (!file || !fs.existsSync(file)) {
      console.error(`[5D][${label}][ERR] File does not exist: ${file}`);
      return false;
    }
    const sz = fs.statSync(file).size;
    if (sz < minSize) {
      console.error(`[5D][${label}][ERR] File too small (${sz} bytes): ${file}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[5D][${label}][ERR] Exception on assert:`, err);
    return false;
  }
}

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
  categoryFolder
}) {
  let searchSubject = subject;

  // --- Mega-scene & scene 1 anchoring ---
  if (isMegaScene || sceneIdx === 0) {
    if (megaSubject && typeof megaSubject === 'string' && megaSubject.length > 2 && !GENERIC_SUBJECTS.includes(megaSubject.toLowerCase())) {
      searchSubject = megaSubject;
      console.log(`[5D][ANCHOR][${jobId}] Using megaSubject for first/mega-scene: "${searchSubject}"`);
    } else if (mainTopic && typeof mainTopic === 'string' && mainTopic.length > 2 && !GENERIC_SUBJECTS.includes(mainTopic.toLowerCase())) {
      searchSubject = mainTopic;
      console.log(`[5D][ANCHOR][${jobId}] Fallback to mainTopic for mega-scene: "${searchSubject}"`);
    } else {
      searchSubject = allSceneTexts[0];
      console.log(`[5D][ANCHOR][${jobId}] Final fallback to first scene text: "${searchSubject}"`);
    }
  }

  if (!searchSubject || GENERIC_SUBJECTS.includes((searchSubject || '').toLowerCase())) {
    if (mainTopic && !GENERIC_SUBJECTS.includes(mainTopic.toLowerCase())) {
      searchSubject = mainTopic;
      console.log(`[5D][FALLBACK][${jobId}] Subject was generic, using mainTopic: "${searchSubject}"`);
    } else if (allSceneTexts && allSceneTexts.length > 0) {
      searchSubject = allSceneTexts[0];
      console.log(`[5D][FALLBACK][${jobId}] Subject was generic, using first scene text: "${searchSubject}"`);
    }
  }

  if (!searchSubject || searchSubject.length < 2) {
    console.error(`[5D][FATAL][${jobId}] No valid subject for scene ${sceneIdx + 1}.`);
    return null;
  }

  if (forceClipPath) {
    console.log(`[5D][FORCE][${jobId}] Forcing clip path: ${forceClipPath}`);
    if (assertFileExists(forceClipPath, 'FORCE_CLIP')) return forceClipPath;
    return null;
  }

  if (usedClips && usedClips.length) {
    console.log(`[5D][MATCH][${jobId}] Used clips so far: ${JSON.stringify(usedClips)}`);
  }

  // --- Validate helpers ---
  if (!findR2ClipForScene || !findPexelsClipForScene || !findPixabayClipForScene || !findUnsplashImageForScene || !fallbackKenBurnsVideo) {
    console.error('[5D][FATAL][HELPERS] One or more clip helpers not loaded!');
    return null;
  }

  // === NEW: GPT-powered prioritized visual subject extraction ===
  let prioritizedSubjects = [];
  try {
    prioritizedSubjects = await extractVisualSubjects(searchSubject, mainTopic);
    console.log(`[5D][GPT][${jobId}] Prioritized visual subjects for scene ${sceneIdx + 1}:`, prioritizedSubjects);
  } catch (err) {
    console.error(`[5D][GPT][${jobId}][ERR] Error extracting prioritized subjects:`, err);
    prioritizedSubjects = [searchSubject, mainTopic];
  }

  // === For each prioritized subject, try every source until a match is found ===
  for (const subjectOption of prioritizedSubjects) {
    if (!subjectOption || subjectOption.length < 2) continue;

    // --- Dedicated R2 clip search: Loose subject enforcement! ---
    async function findDedupedR2ClipLoose(searchPhrase, usedClipsArr) {
      try {
        const r2Files = await findR2ClipForScene.getAllFiles
          ? await findR2ClipForScene.getAllFiles()
          : [];
        let found = null;
        console.log(`[5D][R2][${jobId}] Searching (loose) for subject: "${searchPhrase}"`);
        for (const fname of r2Files) {
          const base = path.basename(fname);
          if (usedClipsArr.includes(fname)) {
            console.log(`[5D][R2][${jobId}] SKIP used: "${base}"`);
            continue;
          }
          if (subjectInFilename(base, searchPhrase)) {
            found = fname;
            console.log(`[5D][R2][${jobId}] LOOSE MATCH: "${base}" loosely matches "${searchPhrase}"`);
            break;
          }
        }
        if (!found) {
          console.log(`[5D][R2][${jobId}] No valid loose subject match for: "${searchPhrase}"`);
        }
        if (found && assertFileExists(found, 'R2_RESULT')) return found;
        return null;
      } catch (err) {
        console.error(`[5D][R2][ERR][${jobId}] Error during loose R2 matching:`, err);
        return null;
      }
    }

    // --- R2 is always preferred, loose subject required ---
    let r2Result = null;
    if (findR2ClipForScene.getAllFiles) {
      r2Result = await findDedupedR2ClipLoose(subjectOption, usedClips);
      if (r2Result) {
        console.log(`[5D][PICK][${jobId}] R2 loose subject match: ${r2Result}`);
        return r2Result;
      }
      console.log(`[5D][FALLBACK][${jobId}] No loose R2 found, trying Pexels/Pixabay/Unsplash.`);
    } else {
      try {
        r2Result = await findR2ClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
        if (r2Result && !usedClips.includes(r2Result) && subjectInFilename(r2Result, subjectOption) && assertFileExists(r2Result, 'R2_RESULT')) {
          console.log(`[5D][PICK][${jobId}] R2 legacy loose subject match: ${r2Result}`);
          return r2Result;
        }
      } catch (e) {
        console.error(`[5D][R2][ERR][${jobId}]`, e);
      }
      console.log(`[5D][FALLBACK][${jobId}] No loose R2 found, trying Pexels/Pixabay/Unsplash.`);
    }

    // --- Try Pexels (loose subject in description/tags) ---
    let pexelsResult = null;
    try {
      pexelsResult = await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      const candidatePath = (pexelsResult && pexelsResult.path) ? pexelsResult.path : pexelsResult;
      if (candidatePath && !usedClips.includes(candidatePath) && assertFileExists(candidatePath, 'PEXELS_RESULT')) {
        let valid = false;
        if (pexelsResult.meta && Array.isArray(pexelsResult.meta.tags)) {
          valid = pexelsResult.meta.tags.some(tag => subjectInFilename(tag, subjectOption));
        } else if (typeof candidatePath === 'string') {
          valid = subjectInFilename(candidatePath, subjectOption);
        }
        if (valid) {
          console.log(`[5D][PICK][${jobId}] Pexels loose subject match: ${candidatePath}`);
          if (jobContext && Array.isArray(jobContext.clipsToIngest)) {
            jobContext.clipsToIngest.push({
              localPath: candidatePath,
              subject: subjectOption,
              sceneIdx,
              source: 'pexels',
              categoryFolder
            });
            console.log(`[5D][QUEUE][${jobId}] Queued Pexels clip for R2 upload:`, candidatePath, '→', categoryFolder);
          }
          return candidatePath;
        } else {
          console.warn(`[5D][PEXELS][${jobId}] Pexels clip rejected (no subject match): ${candidatePath}`);
        }
      }
    } catch (e) {
      console.error(`[5D][PEXELS][ERR][${jobId}]`, e);
    }

    // --- Try Pixabay (loose subject in description/tags) ---
    let pixabayResult = null;
    try {
      pixabayResult = await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      const candidatePath = (pixabayResult && pixabayResult.path) ? pixabayResult.path : pixabayResult;
      if (candidatePath && !usedClips.includes(candidatePath) && assertFileExists(candidatePath, 'PIXABAY_RESULT')) {
        let valid = false;
        if (pixabayResult.meta && Array.isArray(pixabayResult.meta.tags)) {
          valid = pixabayResult.meta.tags.some(tag => subjectInFilename(tag, subjectOption));
        } else if (typeof candidatePath === 'string') {
          valid = subjectInFilename(candidatePath, subjectOption);
        }
        if (valid) {
          console.log(`[5D][PICK][${jobId}] Pixabay loose subject match: ${candidatePath}`);
          if (jobContext && Array.isArray(jobContext.clipsToIngest)) {
            jobContext.clipsToIngest.push({
              localPath: candidatePath,
              subject: subjectOption,
              sceneIdx,
              source: 'pixabay',
              categoryFolder
            });
            console.log(`[5D][QUEUE][${jobId}] Queued Pixabay clip for R2 upload:`, candidatePath, '→', categoryFolder);
          }
          return candidatePath;
        } else {
          console.warn(`[5D][PIXABAY][${jobId}] Pixabay clip rejected (no subject match): ${candidatePath}`);
        }
      }
    } catch (e) {
      console.error(`[5D][PIXABAY][ERR][${jobId}]`, e);
    }

    // --- Try Unsplash (image fallback, not video, loose match) ---
    let unsplashResult = null;
    try {
      unsplashResult = await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext);
      if (unsplashResult && !usedClips.includes(unsplashResult) && assertFileExists(unsplashResult, 'UNSPLASH_RESULT')) {
        if (subjectInFilename(unsplashResult, subjectOption)) {
          console.log(`[5D][PICK][${jobId}] Unsplash image loose subject match: ${unsplashResult}`);
          return unsplashResult;
        } else {
          console.warn(`[5D][UNSPLASH][${jobId}] Unsplash image rejected (no subject match): ${unsplashResult}`);
        }
      }
    } catch (e) {
      console.error(`[5D][UNSPLASH][ERR][${jobId}]`, e);
    }

    // --- Final fallback: Ken Burns still (loose subject in file/image name) ---
    let kenBurnsResult = null;
    try {
      kenBurnsResult = await fallbackKenBurnsVideo(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (kenBurnsResult && !usedClips.includes(kenBurnsResult) && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
        if (subjectInFilename(kenBurnsResult, subjectOption)) {
          console.log(`[5D][PICK][${jobId}] KenBurns fallback loose subject match: ${kenBurnsResult}`);
          return kenBurnsResult;
        } else {
          console.warn(`[5D][KENBURNS][${jobId}] KenBurns fallback rejected (no subject match): ${kenBurnsResult}`);
        }
      }
    } catch (e) {
      console.error(`[5D][KENBURNS][ERR][${jobId}]`, e);
    }
  }

  // === If nothing at all was found ===
  console.error(`[5D][NO_MATCH][${jobId}] No valid clip found for prioritized subjects (scene ${sceneIdx + 1})`);
  return null;
}

module.exports = { findClipForScene };
