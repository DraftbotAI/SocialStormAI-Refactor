// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Ultimate Best-Visual, No Generic Dupe Fallback)
// Always returns the BEST: R2, Pexels, Pixabay, Unsplash (photo or KB video).
// No repeats or generics if a real subject match exists. Max logs, no endless fallback.
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

console.log('[5D][INIT] Clip matcher orchestrator (BEST-VISUAL, NO-GENERIC-DUPES) loaded.');

const GENERIC_SUBJECTS = [
  'face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something', 'body', 'eyes', 'kid', 'boy', 'girl', 'they', 'we', 'people', 'scene', 'child', 'children', 'sign', 'logo', 'text'
];

// Normalize for loose matching
function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getMajorWords(subject) {
  return (subject || '')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
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

// --- Scoring: Block generic, dupe, and sign/irrelevant clips if real match exists ---
function scoreCandidate(candidate, subject, isVideo = false, realMatchExists = false) {
  let score = 0;
  const cleanedSubject = normalize(subject);
  const words = getMajorWords(subject);

  if (!candidate || !candidate.path) return -9999;
  const basename = path.basename(candidate.path).toLowerCase();

  // Strict subject in filename: big win
  if (strictSubjectMatch(basename, subject)) score += 120;

  // All words present (loose match): good
  if (words.every(w => basename.includes(w))) score += 40;

  // Any word present
  words.forEach(word => { if (basename.includes(word)) score += 8; });

  // Raw subject string present
  if (basename.includes(cleanedSubject)) score += 15;

  // Prefer HD (only for video)
  if (isVideo) score += 10;

  // Prefer video, but only if tie or close
  if (isVideo) score += 10;

  // Massive penalty if generic/irrelevant, *unless* there is nothing better
  if (GENERIC_SUBJECTS.some(g => basename.includes(g))) score -= (realMatchExists ? 2000 : 200);

  // Penalty for 'sign', 'logo', 'text'
  if (/\b(sign|logo|text)\b/.test(basename)) score -= (realMatchExists ? 2000 : 200);

  // Lower score if file was used
  if (candidate.used) score -= 5000;

  return score;
}

// --- Helper: Try contextual landmark override (strict R2) ---
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

// === Main Matcher ===
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

  // --- Anchor subject logic (first scene, mega-scene, etc.) ---
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
  if (!findR2ClipForScene || !findPexelsClipForScene || !findPixabayClipForScene || !findUnsplashImageForScene || !fallbackKenBurnsVideo) {
    console.error('[5D][FATAL][HELPERS] One or more clip helpers not loaded!');
    return null;
  }
  let prioritizedSubjects = [];
  try {
    prioritizedSubjects = await extractVisualSubjects(searchSubject, mainTopic);
    console.log(`[5D][GPT][${jobId}] Prioritized visual subjects for scene ${sceneIdx + 1}:`, prioritizedSubjects);
  } catch (err) {
    console.error(`[5D][GPT][${jobId}][ERR] Error extracting prioritized subjects:`, err);
    prioritizedSubjects = [searchSubject, mainTopic];
  }

  // === 0. Contextual strict R2 match (landmark override) ===
  const contextOverride = await tryContextualLandmarkOverride(searchSubject, mainTopic, usedClips, jobId);
  if (contextOverride) return contextOverride;

  // === 1. Aggregate all candidates (videos and Unsplash photo), score hard ===
  let bestCandidate = null;
  let allCandidates = [];
  let realMatchExists = false;

  for (const subjectOption of prioritizedSubjects) {
    if (!subjectOption || subjectOption.length < 2) continue;

    // --- R2 strict ---
    if (findR2ClipForScene.getAllFiles) {
      const r2Files = await findR2ClipForScene.getAllFiles();
      for (const fname of r2Files) {
        if (!usedClips.includes(fname) && strictSubjectMatch(fname, subjectOption) && assertFileExists(fname, 'R2_RESULT')) {
          allCandidates.push({ path: fname, source: 'R2', isVideo: true, subject: subjectOption, used: false });
        }
      }
    }

    // --- R2 loose ---
    if (findR2ClipForScene.getAllFiles) {
      const r2Files = await findR2ClipForScene.getAllFiles();
      for (const fname of r2Files) {
        if (!usedClips.includes(fname) && looseSubjectMatch(fname, subjectOption) && assertFileExists(fname, 'R2_RESULT')) {
          allCandidates.push({ path: fname, source: 'R2', isVideo: true, subject: subjectOption, used: false });
        }
      }
    }

    // --- Pexels video ---
    try {
      let pexelsResult = await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      let candidatePath = (pexelsResult && pexelsResult.path) ? pexelsResult.path : pexelsResult;
      if (candidatePath && !usedClips.includes(candidatePath) && assertFileExists(candidatePath, 'PEXELS_RESULT')) {
        allCandidates.push({ path: candidatePath, source: 'PEXELS', isVideo: true, subject: subjectOption, used: false });
      }
    } catch (e) {
      console.error(`[5D][PEXELS][ERR][${jobId}]`, e);
    }

    // --- Pixabay video ---
    try {
      let pixabayResult = await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      let candidatePath = (pixabayResult && pixabayResult.path) ? pixabayResult.path : pixabayResult;
      if (candidatePath && !usedClips.includes(candidatePath) && assertFileExists(candidatePath, 'PIXABAY_RESULT')) {
        allCandidates.push({ path: candidatePath, source: 'PIXABAY', isVideo: true, subject: subjectOption, used: false });
      }
    } catch (e) {
      console.error(`[5D][PIXABAY][ERR][${jobId}]`, e);
    }

    // --- Unsplash photo ---
    try {
      let unsplashResult = await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext);
      if (unsplashResult && !usedClips.includes(unsplashResult) && assertFileExists(unsplashResult, 'UNSPLASH_RESULT')) {
        allCandidates.push({ path: unsplashResult, source: 'UNSPLASH', isVideo: false, subject: subjectOption, used: false });
      }
    } catch (e) {
      console.error(`[5D][UNSPLASH][ERR][${jobId}]`, e);
    }
  }

  // --- Remove any used clips ---
  allCandidates = allCandidates.filter(c => !usedClips.includes(c.path));

  // --- Determine if any real (non-generic, non-sign, non-dupe) match exists ---
  for (const c of allCandidates) {
    const basename = path.basename(c.path).toLowerCase();
    if (
      !GENERIC_SUBJECTS.some(g => basename.includes(g)) &&
      !/\b(sign|logo|text)\b/.test(basename)
    ) {
      realMatchExists = true;
      break;
    }
  }

  // --- Score all candidates (block/penalize generic/dupe if real exists) ---
  for (let candidate of allCandidates) {
    candidate.score = scoreCandidate(candidate, candidate.subject, candidate.isVideo, realMatchExists);
  }

  // --- Sort descending by score, prefer video on tie ---
  allCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.isVideo !== a.isVideo) return b.isVideo ? 1 : -1; // prefer video on tie
    return 0;
  });

  // --- Log all candidates for debug ---
  allCandidates.forEach((c, i) => {
    console.log(`[5D][CANDIDATE][${jobId}][#${i+1}] ${c.source} | ${c.path} | Score: ${c.score} | Video: ${c.isVideo ? 'Y' : 'N'}`);
  });

  // --- Pick winner ---
  bestCandidate = allCandidates.length ? allCandidates[0] : null;

  if (bestCandidate && bestCandidate.score > -1000) {
    const isGeneric = GENERIC_SUBJECTS.some(g => path.basename(bestCandidate.path).toLowerCase().includes(g));
    if (realMatchExists && isGeneric) {
      console.warn(`[5D][BLOCK][${jobId}] BLOCKED generic/irrelevant fallback: ${bestCandidate.path}`);
      // Try next best candidate that is NOT generic/irrelevant
      const nextReal = allCandidates.find(c => {
        const b = path.basename(c.path).toLowerCase();
        return !GENERIC_SUBJECTS.some(g => b.includes(g)) && !/\b(sign|logo|text)\b/.test(b);
      });
      if (nextReal) {
        bestCandidate = nextReal;
        console.log(`[5D][PICK][${jobId}] Promoted to real match: ${bestCandidate.path}`);
      } else {
        // Only option left is generic, allow as absolute last resort
        console.warn(`[5D][GENERIC][${jobId}] Only generic fallback left: ${bestCandidate.path}`);
      }
    }

    usedClips.push(bestCandidate.path);

    // If photo, run Ken Burns fallback (guaranteed video output)
    if (!bestCandidate.isVideo) {
      try {
        let kenBurnsResult = await fallbackKenBurnsVideo(bestCandidate.path, workDir, sceneIdx, jobId, usedClips);
        if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
          console.log(`[5D][KENBURNS][${jobId}] Ken Burns created: ${kenBurnsResult}`);
          usedClips.push(kenBurnsResult);
          return kenBurnsResult;
        }
      } catch (e) {
        console.error(`[5D][KENBURNS][ERR][${jobId}] Error running Ken Burns for Unsplash image:`, e);
        return bestCandidate.path;
      }
    } else {
      return bestCandidate.path;
    }
  }

  // --- Absolute last resort: fallback logic as before ---
  try {
    if (findR2ClipForScene.getAllFiles) {
      const r2Files = await findR2ClipForScene.getAllFiles();
      for (const fname of r2Files) {
        if (!usedClips.includes(fname) && assertFileExists(fname, 'R2_ANYFALLBACK')) {
          console.warn(`[5D][FINALFALLBACK][${jobId}] ABSOLUTE fallback, picking any available R2: ${fname}`);
          usedClips.push(fname);
          return fname;
        }
      }
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][${jobId}] Error during final R2 fallback:`, e);
  }

  try {
    let kenBurnsResult = await fallbackKenBurnsVideo('landmark', workDir, sceneIdx, jobId, usedClips);
    if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
      console.log(`[5D][FINALFALLBACK][${jobId}] KenBurns generic fallback: ${kenBurnsResult}`);
      usedClips.push(kenBurnsResult);
      return kenBurnsResult;
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][KENBURNS][${jobId}] Error during generic KenBurns fallback:`, e);
  }

  console.error(`[5D][NO_MATCH][${jobId}] No valid clip found for prioritized subjects (scene ${sceneIdx + 1}), even with all fallbacks`);
  return null;
}

module.exports = { findClipForScene };
