// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Bulletproof, Video-First, Anti-Dupe, Pro Helper Integration, MAX LOGS, MANATEE FIXED)
// Always returns something: R2, Pexels Video, Pixabay Video, Pexels Photo, Pixabay Photo, Unsplash image, or Ken Burns.
// Never repeats a clip/image in the same video unless absolutely unavoidable.
// MAX LOGS at every step. Handles edge cases: emotion, question, multi-subject, symbolic, repetition.
// ===========================================================

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene, findPexelsPhotoForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene, findPixabayPhotoForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { findUnsplashImageForScene } = require('./section10f-unsplash-image-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
const { cleanForFilename } = require('./section10e-upload-to-r2.cjs');
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');
const { extractSymbolicVisualSubject } = require('./section10h-symbolic-matcher.cjs');
const { extractEmotionActionVisual } = require('./section10i-emotion-action-helper.cjs');
const { extractQuestionVisual } = require('./section10j-question-fallback-helper.cjs');
const { extractMultiSubjectVisual } = require('./section10k-multi-subject-handler.cjs');
const { breakRepetition } = require('./section10l-repetition-blocker.cjs');
const fs = require('fs');
const path = require('path');

console.log('[5D][INIT] Clip matcher orchestrator (ALL-HELPERS, PHOTOS FALLBACK, ANTI-DUPE, EDGE CASES, MANATEE-PROOF) loaded.');

const GENERIC_SUBJECTS = [
  'face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something', 'body', 'eyes', 'kid', 'boy', 'girl', 'they', 'we', 'people', 'scene', 'child', 'children', 'sign', 'logo', 'text', 'skyline', 'dubai'
];

// --- Helper functions ---
function normalize(str) { return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function getMajorWords(subject) {
  return (subject || '')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !['the', 'of', 'and', 'in', 'on', 'with', 'to', 'is', 'for', 'at', 'by', 'as', 'a', 'an'].includes(w));
}
function looseSubjectMatch(filename, subject) {
  if (!filename || !subject) return false;
  const safeFile = cleanForFilename(filename).toLowerCase();
  const words = getMajorWords(subject);
  for (const word of words) {
    if (safeFile.includes(word)) return true;
  }
  return safeFile.includes(normalize(subject));
}
function strictSubjectMatch(filename, subject) {
  if (!filename || !subject) return false;
  const safeSubject = cleanForFilename(subject);
  const re = new RegExp(`(^|_|-)${safeSubject}(_|-|\\.|$)`, 'i');
  return re.test(cleanForFilename(filename));
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
function scoreCandidate(candidate, subject, isVideo = false, realMatchExists = false) {
  let score = 0;
  const cleanedSubject = normalize(subject);
  const words = getMajorWords(subject);
  if (!candidate || !candidate.path) return -9999;
  const basename = path.basename(candidate.path).toLowerCase();
  if (strictSubjectMatch(basename, subject)) score += 120;
  if (words.every(w => basename.includes(w))) score += 40;
  words.forEach(word => { if (basename.includes(word)) score += 8; });
  if (basename.includes(cleanedSubject)) score += 15;

  // >>>>>>>>>>>>>> HEAVY VIDEO BIAS <<<<<<<<<<<<<<<<
  if (isVideo) score += 120;         // MASSIVE boost for all videos!
  else score -= 60;                  // Penalize all images/photos.
  // >>>>>>>>>>>>>> END VIDEO BIAS <<<<<<<<<<<<<<<<<

  if (GENERIC_SUBJECTS.some(g => basename.includes(g))) score -= (realMatchExists ? 2000 : 200);
  if (/\b(sign|logo|text)\b/.test(basename)) score -= (realMatchExists ? 2000 : 200);
  if (candidate.used) score -= 5000;

  console.log(`[5D][SCORE] ${candidate.path} | subject="${subject}" | video=${isVideo ? 'Y' : 'N'} | score=${score}`);
  return score;
}

// --- Landmark context override (unchanged) ---
async function tryContextualLandmarkOverride(subject, mainTopic, usedClips, jobId) {
  if (!findR2ClipForScene.getAllFiles) return null;
  const LANDMARK_WORDS = [
    'statue of liberty', 'white house', 'empire state building', 'eiffel tower',
    'sphinx', 'great wall', 'mount rushmore', 'big ben', 'colosseum', 'machu picchu',
    'pyramids', 'chichen itza', 'louvre', 'taj mahal', 'notre dame', 'angkor wat',
    'leaning tower', 'buckingham palace', 'niagara falls', 'grand canyon', 'hollywood sign',
    'stonehenge', 'burj khalifa', 'golden gate bridge', 'petra', 'cristo redentor', 'opera house'
  ];
  const lowerSubj = (subject || '').toLowerCase();
  let foundLandmark = '';
  for (let landmark of LANDMARK_WORDS) {
    if (lowerSubj.includes(landmark)) {
      foundLandmark = landmark;
      break;
    }
  }
  if (!foundLandmark && mainTopic) {
    for (let landmark of LANDMARK_WORDS) {
      if (mainTopic.toLowerCase().includes(landmark)) {
        foundLandmark = landmark;
        break;
      }
    }
  }
  if (!foundLandmark) return null;
  try {
    const r2Files = await findR2ClipForScene.getAllFiles();
    for (const fname of r2Files) {
      if (usedClips.includes(fname)) continue;
      if (strictSubjectMatch(fname, foundLandmark)) {
        console.log(`[5D][CONTEXT][${jobId}] Landmark context override: "${foundLandmark}" => "${fname}"`);
        if (assertFileExists(fname, 'R2_CONTEXT_RESULT')) {
          usedClips.push(fname);
          return fname;
        }
      }
    }
  } catch (err) {
    console.error(`[5D][CONTEXT][${jobId}] Landmark context override failed:`, err);
  }
  return null;
}

// === MAIN MATCHER (VIDEO-FIRST, ONLY PHOTO IF *ALL* VIDEO SOURCES FAIL) ===
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
  categoryFolder,
  prevVisualSubjects = [],
}) {
  let searchSubject = subject;

  // --- Anchor subject logic (MEGA-SCENE + SCENE 1) ---
  if (isMegaScene || sceneIdx === 0) {
    let anchorSubjects = [];
    try {
      anchorSubjects = await extractVisualSubjects(megaSubject || mainTopic || allSceneTexts[0], mainTopic);
      anchorSubjects = anchorSubjects.filter(s => !!s && !GENERIC_SUBJECTS.includes(s.toLowerCase()));
    } catch (err) {
      anchorSubjects = [];
      console.error(`[5D][ANCHOR][${jobId}] Error extracting mega/anchor subject(s):`, err);
    }
    if (anchorSubjects && anchorSubjects.length) {
      searchSubject = anchorSubjects[0];
      console.log(`[5D][ANCHOR][${jobId}] (MANATEE-PROOF) Using best visual subject for anchor: "${searchSubject}"`);
    } else if (
      megaSubject && typeof megaSubject === 'string' &&
      megaSubject.length > 2 && !GENERIC_SUBJECTS.includes(megaSubject.toLowerCase())
    ) {
      searchSubject = megaSubject;
      console.log(`[5D][ANCHOR][${jobId}] Fallback to megaSubject for anchor: "${searchSubject}"`);
    } else if (
      mainTopic && typeof mainTopic === 'string' &&
      mainTopic.length > 2 && !GENERIC_SUBJECTS.includes(mainTopic.toLowerCase())
    ) {
      searchSubject = mainTopic;
      console.log(`[5D][ANCHOR][${jobId}] Fallback to mainTopic for anchor: "${searchSubject}"`);
    } else if (allSceneTexts && allSceneTexts.length > 0) {
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
  if (
    !findR2ClipForScene ||
    !findPexelsClipForScene ||
    !findPixabayClipForScene ||
    !findUnsplashImageForScene ||
    !findPexelsPhotoForScene ||
    !findPixabayPhotoForScene ||
    !fallbackKenBurnsVideo
  ) {
    console.error('[5D][FATAL][HELPERS] One or more clip helpers not loaded!');
    return null;
  }

  // === [A] MULTI-STRATEGY SUBJECT EXTRACTION (CONCRETE ONLY) ===
  let extractedSubjects = [];
  // Multi-Subject handler
  try {
    const multiVisual = await extractMultiSubjectVisual(searchSubject, mainTopic);
    if (multiVisual && !GENERIC_SUBJECTS.includes(multiVisual.toLowerCase())) {
      extractedSubjects.push(multiVisual);
      console.log(`[5D][SUBJECT][MULTI] ${multiVisual}`);
    }
  } catch (err) {
    console.error(`[5D][MULTI][${jobId}][ERR]`, err);
  }
  // Question fallback
  try {
    const questionVisual = await extractQuestionVisual(searchSubject, mainTopic);
    if (questionVisual && !GENERIC_SUBJECTS.includes(questionVisual.toLowerCase())) {
      extractedSubjects.push(questionVisual);
      console.log(`[5D][SUBJECT][QUESTION] ${questionVisual}`);
    }
  } catch (err) {
    console.error(`[5D][QUESTION][${jobId}][ERR]`, err);
  }
  // Symbolic/Abstract matcher
  try {
    const symbolicVisual = await extractSymbolicVisualSubject(searchSubject, mainTopic);
    if (symbolicVisual && !GENERIC_SUBJECTS.includes(symbolicVisual.toLowerCase())) {
      extractedSubjects.push(symbolicVisual);
      console.log(`[5D][SUBJECT][SYMBOLIC] ${symbolicVisual}`);
    }
  } catch (err) {
    console.error(`[5D][SYMBOLIC][${jobId}][ERR]`, err);
  }
  // Emotion/action/transition
  try {
    const emotionVisual = await extractEmotionActionVisual(searchSubject, mainTopic);
    if (emotionVisual && !GENERIC_SUBJECTS.includes(emotionVisual.toLowerCase())) {
      extractedSubjects.push(emotionVisual);
      console.log(`[5D][SUBJECT][EMOTION] ${emotionVisual}`);
    }
  } catch (err) {
    console.error(`[5D][EMOTION][${jobId}][ERR]`, err);
  }
  // Literal extractor (always last, most literal/concrete)
  try {
    const prioritized = await extractVisualSubjects(searchSubject, mainTopic);
    if (prioritized && prioritized.length) {
      prioritized.forEach(s => {
        if (s && !GENERIC_SUBJECTS.includes(s.toLowerCase())) extractedSubjects.push(s);
      });
      console.log(`[5D][SUBJECT][PRIORITIZED]`, prioritized);
    }
  } catch (err) {
    console.error(`[5D][LITERAL][${jobId}][ERR]`, err);
  }
  // Fallback to original subject if nothing left
  if (!extractedSubjects.length) extractedSubjects.push(searchSubject);
  // Dedup (keep order)
  extractedSubjects = [...new Set(extractedSubjects)];

  // === [B] REPETITION/VARIETY BLOCKER ===
  let finalSubjects = [];
  for (let sub of extractedSubjects) {
    try {
      const varied = await breakRepetition(sub, prevVisualSubjects || [], { maxRepeats: 2 });
      if (varied && !finalSubjects.includes(varied)) finalSubjects.push(varied);
    } catch (err) {
      finalSubjects.push(sub);
      console.error(`[5D][REPEAT][${jobId}][ERR]`, err);
    }
  }
  if (!finalSubjects.length) finalSubjects = [searchSubject];

  // === 0. Contextual strict R2 match (landmark override) ===
  const contextOverride = await tryContextualLandmarkOverride(finalSubjects[0], mainTopic, usedClips, jobId);
  if (contextOverride) return contextOverride;

  // ==============================
  // === VIDEO-FIRST MATCH LOOP ===
  // ==============================

  for (const subjectOption of finalSubjects) {
    // --- 1. R2 VIDEO ---
    if (findR2ClipForScene.getAllFiles) {
      const r2Files = await findR2ClipForScene.getAllFiles();
      for (const fname of r2Files) {
        if (
          !usedClips.includes(fname) &&
          (strictSubjectMatch(fname, subjectOption) || looseSubjectMatch(fname, subjectOption)) &&
          assertFileExists(fname, 'R2_RESULT')
        ) {
          usedClips.push(fname);
          console.log(`[5D][MATCH][${jobId}] R2 video found: ${fname}`);
          return fname;
        }
      }
    }

    // --- 2. PEXELS VIDEO ---
    try {
      let pexelsResult = await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      let candidatePath = (pexelsResult && pexelsResult.path) ? pexelsResult.path : pexelsResult;
      if (candidatePath && !usedClips.includes(candidatePath) && assertFileExists(candidatePath, 'PEXELS_RESULT')) {
        usedClips.push(candidatePath);
        console.log(`[5D][MATCH][${jobId}] Pexels video found: ${candidatePath}`);
        return candidatePath;
      }
    } catch (e) {
      console.error(`[5D][PEXELS][ERR][${jobId}]`, e);
    }

    // --- 3. PIXABAY VIDEO ---
    try {
      let pixabayResult = await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      let candidatePath = (pixabayResult && pixabayResult.path) ? pixabayResult.path : pixabayResult;
      if (candidatePath && !usedClips.includes(candidatePath) && assertFileExists(candidatePath, 'PIXABAY_RESULT')) {
        usedClips.push(candidatePath);
        console.log(`[5D][MATCH][${jobId}] Pixabay video found: ${candidatePath}`);
        return candidatePath;
      }
    } catch (e) {
      console.error(`[5D][PIXABAY][ERR][${jobId}]`, e);
    }
  }

  // ==============================
  // ==== PHOTO FALLBACK CHAIN  ===
  // ==============================

  for (const subjectOption of finalSubjects) {
    // --- 4. PEXELS PHOTO ---
    try {
      let pexelsPhoto = await findPexelsPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (pexelsPhoto && !usedClips.includes(pexelsPhoto) && assertFileExists(pexelsPhoto, 'PEXELS_PHOTO')) {
        usedClips.push(pexelsPhoto);
        console.log(`[5D][FALLBACK][${jobId}] Pexels photo fallback: ${pexelsPhoto}`);
        // Ken Burns it into a video!
        let kenBurnsResult = await fallbackKenBurnsVideo(pexelsPhoto, workDir, sceneIdx, jobId, usedClips);
        if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
          usedClips.push(kenBurnsResult);
          console.log(`[5D][KENBURNS][${jobId}] Ken Burns created: ${kenBurnsResult}`);
          return kenBurnsResult;
        }
        return pexelsPhoto;
      }
    } catch (e) {
      console.error(`[5D][PEXELS_PHOTO][ERR][${jobId}]`, e);
    }

    // --- 5. PIXABAY PHOTO ---
    try {
      let pixabayPhoto = await findPixabayPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (pixabayPhoto && !usedClips.includes(pixabayPhoto) && assertFileExists(pixabayPhoto, 'PIXABAY_PHOTO')) {
        usedClips.push(pixabayPhoto);
        console.log(`[5D][FALLBACK][${jobId}] Pixabay photo fallback: ${pixabayPhoto}`);
        let kenBurnsResult = await fallbackKenBurnsVideo(pixabayPhoto, workDir, sceneIdx, jobId, usedClips);
        if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
          usedClips.push(kenBurnsResult);
          console.log(`[5D][KENBURNS][${jobId}] Ken Burns created: ${kenBurnsResult}`);
          return kenBurnsResult;
        }
        return pixabayPhoto;
      }
    } catch (e) {
      console.error(`[5D][PIXABAY_PHOTO][ERR][${jobId}]`, e);
    }

    // --- 6. UNSPLASH PHOTO ---
    try {
      let unsplashResult = await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext);
      if (unsplashResult && !usedClips.includes(unsplashResult) && assertFileExists(unsplashResult, 'UNSPLASH_RESULT')) {
        usedClips.push(unsplashResult);
        console.log(`[5D][FALLBACK][${jobId}] Unsplash photo fallback: ${unsplashResult}`);
        let kenBurnsResult = await fallbackKenBurnsVideo(unsplashResult, workDir, sceneIdx, jobId, usedClips);
        if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
          usedClips.push(kenBurnsResult);
          console.log(`[5D][KENBURNS][${jobId}] Ken Burns created: ${kenBurnsResult}`);
          return kenBurnsResult;
        }
        return unsplashResult;
      }
    } catch (e) {
      console.error(`[5D][UNSPLASH][ERR][${jobId}]`, e);
    }
  }

  // --- ABSOLUTE FINAL R2 FALLBACK ---
  try {
    if (findR2ClipForScene.getAllFiles) {
      const r2Files = await findR2ClipForScene.getAllFiles();
      for (const fname of r2Files) {
        if (!usedClips.includes(fname) && assertFileExists(fname, 'R2_ANYFALLBACK')) {
          usedClips.push(fname);
          console.warn(`[5D][FINALFALLBACK][${jobId}] ABSOLUTE fallback, picking any available R2: ${fname}`);
          return fname;
        }
      }
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][${jobId}] Error during final R2 fallback:`, e);
  }
  // --- Final Ken Burns fallback on "landmark" ---
  try {
    let kenBurnsResult = await fallbackKenBurnsVideo('landmark', workDir, sceneIdx, jobId, usedClips);
    if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
      usedClips.push(kenBurnsResult);
      console.log(`[5D][FINALFALLBACK][${jobId}] KenBurns generic fallback: ${kenBurnsResult}`);
      return kenBurnsResult;
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][KENBURNS][${jobId}] Error during generic KenBurns fallback:`, e);
  }
  console.error(`[5D][NO_MATCH][${jobId}] No valid clip found for prioritized subjects (scene ${sceneIdx + 1}), even with all fallbacks`);
  return null;
}

module.exports = { findClipForScene };
