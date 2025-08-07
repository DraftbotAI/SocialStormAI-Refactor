// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Smart, Video-Preferred, No Duplicates, Max Logs)
// Always returns something: R2, Pexels Video, Pixabay Video, Pexels Photo, Pixabay Photo, Unsplash image, or Ken Burns.
// Never repeats a clip/image in the same video unless absolutely unavoidable.
// Scores and ranks all candidates, always prefers video in case of tie.
// Handles edge cases: emotion, question, multi-subject, symbolic, repetition.
// Bulletproofed to instantly log missing/broken helpers (no more silent fail).
// Fully compatible with object/array/string subject logic.
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
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');
const fs = require('fs');
const path = require('path');

console.log('[5D][INIT] Smart, Video-Preferred, No-Dupe Clip Matcher loaded.');

// === DEBUG: Verify all helpers are loaded ===
(() => {
  const helpers = {
    findR2ClipForScene,
    findPexelsClipForScene,
    findPexelsPhotoForScene,
    findPixabayClipForScene,
    findPixabayPhotoForScene,
    findUnsplashImageForScene,
    fallbackKenBurnsVideo,
    scoreSceneCandidate
  };
  Object.entries(helpers).forEach(([name, fn]) => {
    if (typeof fn !== 'function') {
      console.error(`[5D][FATAL][HELPER MISSING] "${name}" is type:`, typeof fn, fn === undefined ? '(undefined)' : '(not a function)');
    } else {
      console.log(`[5D][HELPER][OK] ${name}`);
    }
  });
})();

const GENERIC_SUBJECTS = [
  'face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something', 'body', 'eyes', 'kid', 'boy', 'girl', 'they', 'we', 'people', 'scene', 'child', 'children', 'sign', 'logo', 'text', 'skyline', 'dubai'
];

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

// --- Landmark context override ---
async function tryContextualLandmarkOverride(subject, mainTopic, usedClips, jobId) {
  if (!findR2ClipForScene.getAllFiles) return null;
  const LANDMARK_WORDS = [
    'statue of liberty', 'white house', 'empire state building', 'eiffel tower',
    'sphinx', 'great wall', 'mount rushmore', 'big ben', 'colosseum', 'machu picchu',
    'pyramids', 'chichen itza', 'louvre', 'taj mahal', 'notre dame', 'angkor wat',
    'leaning tower', 'buckingham palace', 'niagara falls', 'grand canyon', 'hollywood sign',
    'stonehenge', 'burj khalifa', 'golden gate bridge', 'petra', 'cristo redentor', 'opera house'
  ];
  const toTest = [subject, mainTopic].filter(Boolean).map(s => (typeof s === 'string' ? s.toLowerCase() : ''));

  let foundLandmark = '';
  for (let landmark of LANDMARK_WORDS) {
    for (const test of toTest) {
      if (test && test.includes(landmark)) {
        foundLandmark = landmark;
        break;
      }
    }
    if (foundLandmark) break;
  }
  if (!foundLandmark) return null;
  try {
    const r2Files = await findR2ClipForScene.getAllFiles();
    for (const fname of r2Files) {
      if (usedClips.includes(fname)) continue;
      if (fname.toLowerCase().includes(foundLandmark.replace(/\s+/g, '_'))) {
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

// === MAIN MATCHER ===
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
      anchorSubjects = anchorSubjects.filter(s => !!s && !GENERIC_SUBJECTS.includes((typeof s === 'string' ? s.toLowerCase() : '')));
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
  if (!searchSubject || (typeof searchSubject === 'string' && GENERIC_SUBJECTS.includes(searchSubject.toLowerCase()))) {
    if (mainTopic && !GENERIC_SUBJECTS.includes(mainTopic.toLowerCase())) {
      searchSubject = mainTopic;
      console.log(`[5D][FALLBACK][${jobId}] Subject was generic, using mainTopic: "${searchSubject}"`);
    } else if (allSceneTexts && allSceneTexts.length > 0) {
      searchSubject = allSceneTexts[0];
      console.log(`[5D][FALLBACK][${jobId}] Subject was generic, using first scene text: "${searchSubject}"`);
    }
  }
  if (!searchSubject || (typeof searchSubject === 'string' && searchSubject.length < 2)) {
    console.error(`[5D][FATAL][${jobId}] No valid subject for scene ${sceneIdx + 1}.`);
    return null;
  }
  if (forceClipPath) {
    console.log(`[5D][FORCE][${jobId}] Forcing clip path: ${forceClipPath}`);
    if (assertFileExists(forceClipPath, 'FORCE_CLIP')) return forceClipPath;
    return null;
  }

  // === [A] VERIFY HELPERS ===
  const missingHelpers = [];
  [
    ['findR2ClipForScene', findR2ClipForScene],
    ['findPexelsClipForScene', findPexelsClipForScene],
    ['findPixabayClipForScene', findPixabayClipForScene],
    ['findUnsplashImageForScene', findUnsplashImageForScene],
    ['findPexelsPhotoForScene', findPexelsPhotoForScene],
    ['findPixabayPhotoForScene', findPixabayPhotoForScene],
    ['fallbackKenBurnsVideo', fallbackKenBurnsVideo],
    ['scoreSceneCandidate', scoreSceneCandidate]
  ].forEach(([name, fn]) => {
    if (typeof fn !== 'function') missingHelpers.push(name);
  });
  if (missingHelpers.length) {
    console.error('[5D][FATAL][HELPERS] The following helpers are missing or not functions:', missingHelpers.join(', '));
    return null;
  }

  // === [B] MULTI-STRATEGY SUBJECT EXTRACTION ===
  let extractedSubjects = [];
  try {
    const multiVisual = await extractMultiSubjectVisual(searchSubject, mainTopic);
    if (multiVisual && !GENERIC_SUBJECTS.includes(multiVisual.toLowerCase())) {
      extractedSubjects.push(multiVisual);
      console.log(`[5D][SUBJECT][MULTI] ${multiVisual}`);
    }
  } catch (err) { console.error(`[5D][MULTI][${jobId}][ERR]`, err); }
  try {
    const questionVisual = await extractQuestionVisual(searchSubject, mainTopic);
    if (questionVisual && !GENERIC_SUBJECTS.includes(questionVisual.toLowerCase())) {
      extractedSubjects.push(questionVisual);
      console.log(`[5D][SUBJECT][QUESTION] ${questionVisual}`);
    }
  } catch (err) { console.error(`[5D][QUESTION][${jobId}][ERR]`, err); }
  try {
    const symbolicVisual = await extractSymbolicVisualSubject(searchSubject, mainTopic);
    if (symbolicVisual && !GENERIC_SUBJECTS.includes(symbolicVisual.toLowerCase())) {
      extractedSubjects.push(symbolicVisual);
      console.log(`[5D][SUBJECT][SYMBOLIC] ${symbolicVisual}`);
    }
  } catch (err) { console.error(`[5D][SYMBOLIC][${jobId}][ERR]`, err); }
  try {
    const emotionVisual = await extractEmotionActionVisual(searchSubject, mainTopic);
    if (emotionVisual && !GENERIC_SUBJECTS.includes(emotionVisual.toLowerCase())) {
      extractedSubjects.push(emotionVisual);
      console.log(`[5D][SUBJECT][EMOTION] ${emotionVisual}`);
    }
  } catch (err) { console.error(`[5D][EMOTION][${jobId}][ERR]`, err); }
  try {
    const prioritized = await extractVisualSubjects(searchSubject, mainTopic);
    if (prioritized && prioritized.length) {
      prioritized.forEach(s => {
        if (s && !GENERIC_SUBJECTS.includes((typeof s === 'string' ? s.toLowerCase() : ''))) extractedSubjects.push(s);
      });
      console.log(`[5D][SUBJECT][PRIORITIZED]`, prioritized);
    }
  } catch (err) { console.error(`[5D][LITERAL][${jobId}][ERR]`, err); }
  if (!extractedSubjects.length) extractedSubjects.push(searchSubject);
  extractedSubjects = [...new Set(extractedSubjects)];

  // === [C] REPETITION/VARIETY BLOCKER ===
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

  // === [D] Gather ALL candidates (video then photo, separate selection) ===
  let videoCandidates = [];
  let imageCandidates = [];
  for (const subjectOption of finalSubjects) {
    // --- R2 videos ---
    if (findR2ClipForScene.getAllFiles) {
      const r2Files = await findR2ClipForScene.getAllFiles();
      for (const fname of r2Files) {
        if (!usedClips.includes(fname) && assertFileExists(fname, 'R2_RESULT')) {
          videoCandidates.push({
            path: fname,
            source: 'R2',
            isVideo: true,
            subject: subjectOption,
            used: usedClips.includes(fname)
          });
        }
      }
    }
    // --- Pexels video ---
    try {
      let pexelsResult = await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      let candidatePath = (pexelsResult && pexelsResult.path) ? pexelsResult.path : pexelsResult;
      if (candidatePath && !usedClips.includes(candidatePath) && assertFileExists(candidatePath, 'PEXELS_RESULT')) {
        videoCandidates.push({
          path: candidatePath,
          source: 'PEXELS_VIDEO',
          isVideo: true,
          subject: subjectOption,
          used: usedClips.includes(candidatePath)
        });
      }
    } catch (e) { console.error(`[5D][PEXELS][${jobId}][ERR]`, e); }
    // --- Pixabay video ---
    try {
      let pixabayResult = await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      let candidatePath = (pixabayResult && pixabayResult.path) ? pixabayResult.path : pixabayResult;
      if (candidatePath && !usedClips.includes(candidatePath) && assertFileExists(candidatePath, 'PIXABAY_RESULT')) {
        videoCandidates.push({
          path: candidatePath,
          source: 'PIXABAY_VIDEO',
          isVideo: true,
          subject: subjectOption,
          used: usedClips.includes(candidatePath)
        });
      }
    } catch (e) { console.error(`[5D][PIXABAY][${jobId}][ERR]`, e); }
    // === PHOTOS (with fallback) ===
    // --- Pexels photo ---
    try {
      let pexelsPhoto = await findPexelsPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (pexelsPhoto && !usedClips.includes(pexelsPhoto) && assertFileExists(pexelsPhoto, 'PEXELS_PHOTO')) {
        imageCandidates.push({
          path: pexelsPhoto,
          source: 'PEXELS_PHOTO',
          isVideo: false,
          subject: subjectOption,
          used: usedClips.includes(pexelsPhoto)
        });
      }
    } catch (e) { console.error(`[5D][PEXELS_PHOTO][${jobId}][ERR]`, e); }
    // --- Pixabay photo ---
    try {
      let pixabayPhoto = await findPixabayPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (pixabayPhoto && !usedClips.includes(pixabayPhoto) && assertFileExists(pixabayPhoto, 'PIXABAY_PHOTO')) {
        imageCandidates.push({
          path: pixabayPhoto,
          source: 'PIXABAY_PHOTO',
          isVideo: false,
          subject: subjectOption,
          used: usedClips.includes(pixabayPhoto)
        });
      }
    } catch (e) { console.error(`[5D][PIXABAY_PHOTO][${jobId}][ERR]`, e); }
    // --- Unsplash photo ---
    try {
      let unsplashResult = await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext);
      if (unsplashResult && !usedClips.includes(unsplashResult) && assertFileExists(unsplashResult, 'UNSPLASH_RESULT')) {
        imageCandidates.push({
          path: unsplashResult,
          source: 'UNSPLASH',
          isVideo: false,
          subject: subjectOption,
          used: usedClips.includes(unsplashResult)
        });
      }
    } catch (e) { console.error(`[5D][UNSPLASH][${jobId}][ERR]`, e); }
  }

  // --- Score and sort videos ---
  let realVideoExists = videoCandidates.length > 0;
  for (let candidate of videoCandidates) {
    candidate.score = scoreSceneCandidate(candidate, candidate.subject, usedClips, realVideoExists);
  }
  videoCandidates.sort((a, b) => b.score - a.score);

  // --- Score and sort images (only if no video is available) ---
  for (let candidate of imageCandidates) {
    candidate.score = scoreSceneCandidate(candidate, candidate.subject, usedClips, realVideoExists);
  }
  imageCandidates.sort((a, b) => b.score - a.score);

  // --- Log all candidates for debug ---
  videoCandidates.forEach((c, i) => {
    console.log(`[5D][CANDIDATE][VIDEO][${jobId}][#${i + 1}] ${c.source} | ${c.path} | Score: ${c.score}`);
  });
  imageCandidates.forEach((c, i) => {
    console.log(`[5D][CANDIDATE][IMAGE][${jobId}][#${i + 1}] ${c.source} | ${c.path} | Score: ${c.score}`);
  });

  // --- Pick best video if available ---
  if (videoCandidates.length > 0) {
    let bestVideo = videoCandidates[0];
    usedClips.push(bestVideo.path); // Mark as used!
    console.log(`[5D][RESULT][VIDEO][${jobId}] Best video selected: ${bestVideo.path}`);
    return bestVideo.path;
  }

  // --- If no videos, fallback to best image (Ken Burns) ---
  if (imageCandidates.length > 0) {
    let bestImage = imageCandidates[0];
    usedClips.push(bestImage.path);
    let kenBurnsResult = await fallbackKenBurnsVideo(bestImage.path, workDir, sceneIdx, jobId, usedClips);
    if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
      usedClips.push(kenBurnsResult);
      console.log(`[5D][RESULT][KENBURNS][${jobId}] Ken Burns created from image: ${kenBurnsResult}`);
      return kenBurnsResult;
    }
    // If Ken Burns fails, return the static image as last resort
    console.log(`[5D][RESULT][IMAGE_STATIC][${jobId}] Fallback to static image: ${bestImage.path}`);
    return bestImage.path;
  }

  // --- Final R2 fallback ---
  if (findR2ClipForScene.getAllFiles) {
    const r2Files = await findR2ClipForScene.getAllFiles();
    for (const fname of r2Files) {
      if (!usedClips.includes(fname) && assertFileExists(fname, 'R2_ANYFALLBACK')) {
        usedClips.push(fname);
        console.log(`[5D][RESULT][R2_ANYFALLBACK][${jobId}] Fallback video: ${fname}`);
        return fname;
      }
    }
  }
  // --- Final Ken Burns fallback (generic landmark image if nothing else) ---
  let kenBurnsResult = await fallbackKenBurnsVideo('landmark', workDir, sceneIdx, jobId, usedClips);
  if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
    usedClips.push(kenBurnsResult);
    console.log(`[5D][RESULT][KENBURNS_LANDMARK][${jobId}] Final fallback Ken Burns: ${kenBurnsResult}`);
    return kenBurnsResult;
  }
  console.error(`[5D][NO_MATCH][${jobId}] No valid clip found for prioritized subjects (scene ${sceneIdx + 1}), even with all fallbacks`);
  return null;
}

module.exports = { findClipForScene };
