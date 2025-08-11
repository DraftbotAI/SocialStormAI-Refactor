// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Loosest, Bulletproof)
// Always returns something: video, image, Ken Burns, or any available.
// Never loops forever. Max logs at each fallback step.
// ===========================================================

const { findR2ClipForScene, findTopNR2ClipsForSubject } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { findUnsplashImageForScene } = require('./section10f-unsplash-image-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
const { cleanForFilename } = require('./section10e-upload-to-r2.cjs');
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');
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

  // Ensure jobContext.r2Pools exists for R2-first pooling
  if (!jobContext.r2Pools) jobContext.r2Pools = {};

  // Try all prioritized subjects, loose mode
  for (const subjectOption of prioritizedSubjects) {
    if (!subjectOption || subjectOption.length < 2) continue;

    // === R2-FIRST using a subject-scoped pool (small change) ===
    try {
      const poolKey = normalize(subjectOption);
      if (!jobContext.r2Pools[poolKey] || jobContext.r2Pools[poolKey].length === 0) {
        console.log(`[5D][R2POOL][${jobId}] Pool empty for "${subjectOption}". Fetching top-N from R2...`);
        const pool = await findTopNR2ClipsForSubject(subjectOption, workDir, {
          N: 4,
          usedClips,
          jobId,
          minScore: -999,
          maxConcurrency: 3,
        });
        jobContext.r2Pools[poolKey] = Array.isArray(pool) ? pool.slice() : [];
        console.log(`[5D][R2POOL][${jobId}] Pool populated for "${subjectOption}": ${jobContext.r2Pools[poolKey].length} items`);
      }

      // Shift one good local path from the pool
      while (jobContext.r2Pools[poolKey] && jobContext.r2Pools[poolKey].length) {
        const next = jobContext.r2Pools[poolKey].shift(); // { key, path, score }
        if (!next || !next.path) continue;

        // Skip if already used (compare by path + basename)
        const base = path.basename(next.path.toLowerCase());
        const already = usedClips.some(u => {
          const uLower = String(u || '').toLowerCase();
          return uLower === next.path.toLowerCase() || path.basename(uLower) === base;
        });
        if (already) {
          console.log(`[5D][R2POOL][${jobId}] Skipping already-used: ${next.path}`);
          continue;
        }

        if (assertFileExists(next.path, 'R2_POOL_RESULT')) {
          console.log(`[5D][PICK][${jobId}] R2 pool pick: ${next.path} (score=${next.score})`);
          return next.path;
        } else {
          console.warn(`[5D][R2POOL][${jobId}] Pool item missing/invalid, continuing: ${next.path}`);
        }
      }
      console.log(`[5D][R2POOL][${jobId}] No usable items in pool for "${subjectOption}". Proceeding to providers.`);
    } catch (e) {
      console.error(`[5D][R2POOL][ERR][${jobId}]`, e);
    }

    // --- Try Pexels, Pixabay, Unsplash with loose match ---
    let sources = [
      { fn: findPexelsClipForScene, label: 'PEXELS', meta: 'meta' },
      { fn: findPixabayClipForScene, label: 'PIXABAY', meta: 'meta' }
    ];

    for (const src of sources) {
      try {
        let result = await src.fn(subjectOption, workDir, sceneIdx, jobId, usedClips);
        const candidatePath = (result && result.path) ? result.path : result;
        if (candidatePath && !usedClips.includes(candidatePath) && assertFileExists(candidatePath, src.label + '_RESULT')) {
          // Loose match: accept if ANY major word from subject appears in filename/tags
          let valid = false;
          if (result && result.meta && Array.isArray(result.meta.tags)) {
            valid = result.meta.tags.some(tag => getMajorWords(subjectOption).some(word => tag.toLowerCase().includes(word)));
          } else if (typeof candidatePath === 'string') {
            valid = looseSubjectMatch(candidatePath, subjectOption);
          }
          // Existing behavior preserved: accept even if imperfect (prevents empty scenes)
          if (valid || true) {
            console.log(`[5D][PICK][${jobId}] ${src.label} subject match: ${candidatePath}`);
            if (jobContext && Array.isArray(jobContext.clipsToIngest)) {
              jobContext.clipsToIngest.push({
                localPath: candidatePath,
                subject: subjectOption,
                sceneIdx,
                source: src.label.toLowerCase(),
                categoryFolder
              });
            }
            return candidatePath;
          } else {
            console.warn(`[5D][${src.label}][${jobId}] ${src.label} clip rejected (no subject match): ${candidatePath}`);
          }
        }
      } catch (e) {
        console.error(`[5D][${src.label}][ERR][${jobId}]`, e);
      }
    }

    // --- Unsplash: always loose, just check for unused image
    try {
      let unsplashResult = await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext);
      if (unsplashResult && !usedClips.includes(unsplashResult) && assertFileExists(unsplashResult, 'UNSPLASH_RESULT')) {
        console.log(`[5D][PICK][${jobId}] Unsplash image (loose): ${unsplashResult}`);
        return unsplashResult;
      }
    } catch (e) {
      console.error(`[5D][UNSPLASH][ERR][${jobId}]`, e);
    }

    // --- Ken Burns (final fallback, always returns an image)
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

  // === If absolutely nothing was found, pick any unused R2 file ===
  try {
    if (findR2ClipForScene.getAllFiles) {
      const r2Files = await findR2ClipForScene.getAllFiles();
      for (const fname of r2Files) {
        // Note: these are keys, not local files; keep behavior but validate only if present locally
        if (!usedClips.includes(fname) && assertFileExists(fname, 'R2_ANYFALLBACK')) {
          console.warn(`[5D][FINALFALLBACK][${jobId}] ABSOLUTE fallback, picking any available R2: ${fname}`);
          return fname;
        }
      }
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][${jobId}] Error during final R2 fallback:`, e);
  }

  // Still nothing!
  console.error(`[5D][NO_MATCH][${jobId}] No valid clip found for prioritized subjects (scene ${sceneIdx + 1}), even with all fallbacks`);
  // Instead of returning null, let's try one last Ken Burns with a generic prompt:
  try {
    let kenBurnsResult = await fallbackKenBurnsVideo('landmark', workDir, sceneIdx, jobId, usedClips);
    if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
      console.log(`[5D][FINALFALLBACK][${jobId}] KenBurns generic fallback: ${kenBurnsResult}`);
      return kenBurnsResult;
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][KENBURNS][${jobId}] Error during generic KenBurns fallback:`, e);
  }

  // If literally nothing, return null
  return null;
}

module.exports = { findClipForScene };
