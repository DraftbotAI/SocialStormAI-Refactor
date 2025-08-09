// ============================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Loosest, Bulletproof)
// Always returns something: video, image, Ken Burns, or any available.
// Never loops forever. Max logs at each fallback step.
// ===========================================================

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { findUnsplashImageForScene } = require('./section10f-unsplash-image-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
const { cleanForFilename } = require('./section10e-upload-to-r2.cjs');
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');
const fs = require('fs');
const path = require('path');

console.log('[5D][INIT] Clip matcher orchestrator (bulletproof, loose) loaded.');

const GENERIC_SUBJECTS = [
  'face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something', 'body', 'eyes', 'kid', 'boy', 'girl', 'they', 'we', 'people', 'scene', 'child', 'children'
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

// Checks if ANY major word from subject appears in filename
function looseSubjectMatch(filename, subject) {
  if (!filename || !subject) return false;
  const safeFile = cleanForFilename(filename).toLowerCase();
  const words = getMajorWords(subject);
  for (const word of words) {
    if (safeFile.includes(word)) return true;
  }
  // As a last resort, partial substring
  return safeFile.includes(normalize(subject));
}

// Strict match (for priority order)
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

  // Anchor logic
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

  // Try all prioritized subjects, loose mode
  for (const subjectOption of prioritizedSubjects) {
    if (!subjectOption || subjectOption.length < 2) continue;

    // Collect candidates from all sources, then pick the best by 10G.
    const scoredCandidates = [];

    // === 1. R2 (download + score) ===
    try {
      // Use the smarter 10A to select & download best R2 candidate for the subject
      const r2Local = await findR2ClipForScene(subjectOption, workDir, sceneIdx, jobId, new Set(usedClips));
      if (r2Local && assertFileExists(r2Local, 'R2_RESULT')) {
        const r2Score = scoreSceneCandidate(
          {
            filename: path.basename(r2Local),
            filePath: r2Local,
            tags: [], // filenames in R2 usually contain the subject tokens
            title: path.basename(r2Local),
            description: ''
          },
          subjectOption,
          usedClips
        );
        console.log(`[5D][R2][${jobId}] Candidate score for "${subjectOption}": ${r2Score}`);
        scoredCandidates.push({ source: 'r2', path: r2Local, score: r2Score });
      } else {
        console.log(`[5D][R2][${jobId}] No local R2 candidate for "${subjectOption}"`);
      }
    } catch (err) {
      console.error(`[5D][R2][ERR][${jobId}]`, err);
    }

    // --- 2. Pexels ---
    try {
      const pxRes = await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      const pxPath = (pxRes && pxRes.path) ? pxRes.path : pxRes;
      const pxMeta = (pxRes && pxRes.meta) ? pxRes.meta : {};

      if (pxPath && !usedClips.includes(pxPath) && assertFileExists(pxPath, 'PEXELS_RESULT')) {
        const filenameForScoring =
          pxMeta.originalName || pxMeta.filename || pxMeta.url || path.basename(pxPath);

        const score10G = scoreSceneCandidate(
          {
            filename: filenameForScoring,
            filePath: pxPath,
            tags: pxMeta.tags || pxMeta.keywords || [],
            title: pxMeta.title || '',
            description: pxMeta.description || '',
          },
          subjectOption,
          usedClips
        );

        const providerScore = typeof pxRes?.score === 'number'
          ? pxRes.score
          : (typeof pxMeta.score === 'number' ? pxMeta.score : null);

        const finalScore = providerScore !== null ? Math.max(score10G, providerScore) : score10G;

        console.log(`[5D][PEXELS][${jobId}] Scores -> 10G:${score10G}${providerScore !== null ? ` | Provider:${providerScore}` : ''} | file="${filenameForScoring}"`);
        scoredCandidates.push({ source: 'pexels', path: pxPath, score: finalScore, meta: pxMeta });
      }
    } catch (e) {
      console.error(`[5D][PEXELS][ERR][${jobId}]`, e);
    }

    // --- 3. Pixabay ---
    try {
      const pbRes = await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      const pbPath = (pbRes && pbRes.path) ? pbRes.path : pbRes;
      const pbMeta = (pbRes && pbRes.meta) ? pbRes.meta : {};

      if (pbPath && !usedClips.includes(pbPath) && assertFileExists(pbPath, 'PIXABAY_RESULT')) {
        const filenameForScoring =
          pbMeta.originalName || pbMeta.filename || pbMeta.url || path.basename(pbPath);

        const score10G = scoreSceneCandidate(
          {
            filename: filenameForScoring,
            filePath: pbPath,
            tags: pbMeta.tags || pbMeta.keywords || [],
            title: pbMeta.title || '',
            description: pbMeta.description || '',
          },
          subjectOption,
          usedClips
        );

        const providerScore = typeof pbRes?.score === 'number'
          ? pbRes.score
          : (typeof pbMeta.score === 'number' ? pbMeta.score : null);

        const finalScore = providerScore !== null ? Math.max(score10G, providerScore) : score10G;

        console.log(`[5D][PIXABAY][${jobId}] Scores -> 10G:${score10G}${providerScore !== null ? ` | Provider:${providerScore}` : ''} | file="${filenameForScoring}"`);
        scoredCandidates.push({ source: 'pixabay', path: pbPath, score: finalScore, meta: pbMeta });
      }
    } catch (e) {
      console.error(`[5D][PIXABAY][ERR][${jobId}]`, e);
    }

    // === Decide winner across sources ===
    if (scoredCandidates.length) {
      scoredCandidates.sort((a, b) => b.score - a.score);
      const winner = scoredCandidates[0];
      console.log(`[5D][PICK][${jobId}] Winner across sources for "${subjectOption}" => ${winner.source.toUpperCase()} | score=${winner.score} | path=${winner.path}`);

      if (jobContext && Array.isArray(jobContext.clipsToIngest)) {
        jobContext.clipsToIngest.push({
          localPath: winner.path,
          subject: subjectOption,
          sceneIdx,
          source: winner.source,
          categoryFolder
        });
      }
      return winner.path;
    }

    // --- If nothing from video sources, try Unsplash then Ken Burns ---
    try {
      let unsplashResult = await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext);
      if (unsplashResult && !usedClips.includes(unsplashResult) && assertFileExists(unsplashResult, 'UNSPLASH_RESULT')) {
        console.log(`[5D][PICK][${jobId}] Unsplash image (loose): ${unsplashResult}`);
        return unsplashResult;
      }
    } catch (e) {
      console.error(`[5D][UNSPLASH][ERR][${jobId}]`, e);
    }

    try {
      let kenBurnsResult = await fallbackKenBurnsVideo(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (kenBurnsResult && !usedClips.includes(kenBurnsResult) && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
        console.log(`[5D][PICK][${jobId}] KenBurns fallback (loose): ${kenBurnsResult}`);
        return kenBurnsResult;
      }
    } catch (e) {
      console.error(`[5D][KENBURNS][ERR][${jobId}]`, e);
    }
  }

  // === Absolute R2 fallback ===
  try {
    if (findR2ClipForScene.getAllFiles) {
      const r2Files = await findR2ClipForScene.getAllFiles();
      for (const fname of r2Files) {
        if (!usedClips.includes(fname) && assertFileExists(fname, 'R2_ANYFALLBACK')) {
          console.warn(`[5D][FINALFALLBACK][${jobId}] ABSOLUTE fallback, picking any available R2: ${fname}`);
          return fname;
        }
      }
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][${jobId}] Error during final R2 fallback:`, e);
  }

  console.error(`[5D][NO_MATCH][${jobId}] No valid clip found for prioritized subjects (scene ${sceneIdx + 1}), even with all fallbacks`);
  try {
    let kenBurnsResult = await fallbackKenBurnsVideo('landmark', workDir, sceneIdx, jobId, usedClips);
    if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
      console.log(`[5D][FINALFALLBACK][${jobId}] KenBurns generic fallback: ${kenBurnsResult}`);
      return kenBurnsResult;
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][KENBURNS][${jobId}] Error during generic KenBurns fallback:`, e);
  }

  return null;
}

module.exports = { findClipForScene };
