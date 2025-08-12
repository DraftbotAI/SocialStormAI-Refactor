// ===========================================================
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

// Stem for per-video dedupe (basename, no extension, separators→spaces, lowercase)
function stemFromPath(p) {
  try {
    const base = (p || '').split('/').pop() || '';
    const noExt = base.replace(/\.[a-z0-9]+$/i, '');
    return noExt.toLowerCase().replace(/[\s_\-\.]+/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// NEW: derive a stable provider ID from filename when meta.id is missing
function deriveProviderId(filePath, label = '') {
  try {
    const base = (filePath || '').split('/').pop() || '';
    const lower = base.toLowerCase();

    // Pexels patterns: pexels-<id>, pexels_video_<id>, pexels-<id>-*, etc.
    let m =
      lower.match(/pexels[^0-9]*?(\d{4,})/) ||
      lower.match(/pexels[-_ ]?(video)?[-_ ]?(\d{4,})/);
    if (m) {
      const id = String(m[1] || m[2]);
      console.log(`[5D][ID][DERIVE] (${label}) from filename "${base}" -> ${id}`);
      return id;
    }

    // Pixabay patterns: pixabay[-_]video[-_]<id>, pixabay_<id>, etc.
    m =
      lower.match(/pixabay[^0-9]*?(\d{4,})/) ||
      lower.match(/pixabay[-_ ]?(video|vid)?[-_ ]?(\d{4,})/);
    if (m) {
      const id = String(m[1] || m[2]);
      console.log(`[5D][ID][DERIVE] (${label}) from filename "${base}" -> ${id}`);
      return id;
    }

    // Generic: longest run of digits (>=4) in basename
    const nums = lower.match(/\d{4,}/g);
    if (nums && nums.length) {
      // choose the longest, then first
      const id = nums.sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
      console.log(`[5D][ID][DERIVE] (${label}) generic digits from "${base}" -> ${id}`);
      return id;
    }
  } catch (e) {
    // ignore
  }
  return null;
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

  // Build per-video used stems from passed-in usedClips (current job only)
  const usedStems = new Set((usedClips || []).map(stemFromPath).filter(Boolean));
  // Track provider clip IDs per job to avoid repeating the same Pexels/Pixabay asset
  const usedSourceIds = jobContext && jobContext._usedSourceIds instanceof Set
    ? jobContext._usedSourceIds
    : new Set();
  jobContext._usedSourceIds = usedSourceIds;

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

    // === 1. Try R2, loose mode ===
    async function findDedupedR2ClipLoose(searchPhrase, usedClipsArr) {
      try {
        const r2Files = await findR2ClipForScene.getAllFiles
          ? await findR2ClipForScene.getAllFiles()
          : [];
        let found = null;

        // a) Strict match first
        for (const fname of r2Files) {
          const stem = stemFromPath(fname);
          if (usedClipsArr.includes(fname)) {
            console.log(`[5D][R2][${jobId}][SKIP][USED_KEY] ${fname}`);
            continue;
          }
          if (usedStems.has(stem)) {
            console.log(`[5D][R2][${jobId}][DUPE][SKIP] stem already used: "${stem}" (${fname})`);
            continue;
          }
          if (strictSubjectMatch(fname, searchPhrase)) {
            found = fname;
            console.log(`[5D][R2][${jobId}] STRICT MATCH: "${fname}"`);
            break;
          }
        }
        // b) Loose match: any major word or substring
        if (!found) {
          for (const fname of r2Files) {
            const stem = stemFromPath(fname);
            if (usedClipsArr.includes(fname)) {
              console.log(`[5D][R2][${jobId}][SKIP][USED_KEY] ${fname}`);
              continue;
            }
            if (usedStems.has(stem)) {
              console.log(`[5D][R2][${jobId}][DUPE][SKIP] stem already used: "${stem}" (${fname})`);
              continue;
            }
            if (looseSubjectMatch(fname, searchPhrase)) {
              found = fname;
              console.log(`[5D][R2][${jobId}] LOOSE MATCH: "${fname}"`);
              break;
            }
          }
        }
        // c) Any unused file as last resort
        if (!found && r2Files.length) {
          for (const fname of r2Files) {
            const stem = stemFromPath(fname);
            if (usedClipsArr.includes(fname)) {
              console.log(`[5D][R2][${jobId}][SKIP][USED_KEY] ${fname}`);
              continue;
            }
            if (usedStems.has(stem)) {
              console.log(`[5D][R2][${jobId}][DUPE][SKIP] stem already used: "${stem}" (${fname})`);
              continue;
            }
            found = fname;
            console.log(`[5D][R2][${jobId}] FALLBACK: Picking available unused: "${fname}"`);
            break;
          }
        }
        if (found && assertFileExists(found, 'R2_RESULT')) return found;
        return null;
      } catch (err) {
        console.error(`[5D][R2][ERR][${jobId}] Error during R2 matching:`, err);
        return null;
      }
    }

    let r2Result = null;
    if (findR2ClipForScene.getAllFiles) {
      r2Result = await findDedupedR2ClipLoose(subjectOption, usedClips);
      if (r2Result) {
        const stem = stemFromPath(r2Result);
        usedClips.push(r2Result);
        usedStems.add(stem);
        console.log(`[5D][DUPE][ADD][${jobId}] Added stem="${stem}" key="${r2Result}"`);
        console.log(`[5D][PICK][${jobId}] R2 subject match: ${r2Result}`);
        return r2Result;
      }
      console.log(`[5D][FALLBACK][${jobId}] No R2 found, trying Pexels/Pixabay/Unsplash.`);
    }

    // --- Try Pexels, Pixabay with loose match ---
    let sources = [
      { fn: findPexelsClipForScene, label: 'PEXELS', meta: 'meta' },
      { fn: findPixabayClipForScene, label: 'PIXABAY', meta: 'meta' }
    ];

    for (const src of sources) {
      try {
        let result = await src.fn(subjectOption, workDir, sceneIdx, jobId, usedClips);
        const candidatePath = (result && result.path) ? result.path : result;

        // Skip if provider returned an ID we've already used this job
        let candId = result && result.meta && (result.meta.id || result.meta.sourceId) ? String(result.meta.id || result.meta.sourceId) : null;
        if (!candId) {
          // NEW: derive ID from filename if meta missing
          candId = deriveProviderId(candidatePath, src.label);
        }
        if (candId && usedSourceIds.has(candId)) {
          console.log(`[5D][${src.label}][${jobId}][ID][SKIP] providerId already used: "${candId}" (${candidatePath})`);
          continue;
        }

        if (candidatePath && assertFileExists(candidatePath, src.label + '_RESULT')) {
          const candStem = stemFromPath(candidatePath);
          if (usedStems.has(candStem)) {
            console.log(`[5D][${src.label}][${jobId}][DUPE][SKIP] stem already used: "${candStem}" (${candidatePath})`);
            continue;
          }
          // Loose match: accept if ANY major word from subject appears in filename/tags
          let valid = false;
          if (result && result.meta && Array.isArray(result.meta.tags)) {
            valid = result.meta.tags.some(tag => getMajorWords(subjectOption).some(word => tag.toLowerCase().includes(word)));
          } else if (typeof candidatePath === 'string') {
            valid = looseSubjectMatch(candidatePath, subjectOption);
          }
          // **Loose policy**: accept first available (still respecting de-dupe)
          if (valid || true) {
            usedClips.push(candidatePath);
            usedStems.add(candStem);
            if (candId) {
              usedSourceIds.add(candId);
              console.log(`[5D][${src.label}][${jobId}][ID][ADD] providerId="${candId}"`);
            }
            console.log(`[5D][DUPE][ADD][${jobId}] Added stem="${candStem}" path="${candidatePath}"`);
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
      if (unsplashResult && assertFileExists(unsplashResult, 'UNSPLASH_RESULT')) {
        const candStem = stemFromPath(unsplashResult);
        if (usedStems.has(candStem)) {
          console.log(`[5D][UNSPLASH][${jobId}][DUPE][SKIP] stem already used: "${candStem}" (${unsplashResult})`);
        } else {
          usedClips.push(unsplashResult);
          usedStems.add(candStem);
          console.log(`[5D][DUPE][ADD][${jobId}] Added stem="${candStem}" path="${unsplashResult}"`);
          console.log(`[5D][PICK][${jobId}] Unsplash image (loose): ${unsplashResult}`);
          return unsplashResult;
        }
      }
    } catch (e) {
      console.error(`[5D][UNSPLASH][ERR][${jobId}]`, e);
    }

    // --- Ken Burns (final fallback, always returns an image)
    try {
      let kenBurnsResult = await fallbackKenBurnsVideo(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
        const candStem = stemFromPath(kenBurnsResult);
        if (usedStems.has(candStem)) {
          console.log(`[5D][KENBURNS][${jobId}][DUPE][SKIP] stem already used: "${candStem}" (${kenBurnsResult})`);
        } else {
          usedClips.push(kenBurnsResult);
          usedStems.add(candStem);
          console.log(`[5D][DUPE][ADD][${jobId}] Added stem="${candStem}" path="${kenBurnsResult}"`);
          console.log(`[5D][PICK][${jobId}] KenBurns fallback (loose): ${kenBurnsResult}`);
          return kenBurnsResult;
        }
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
        const stem = stemFromPath(fname);
        if (usedClips.includes(fname)) {
          console.log(`[5D][R2][${jobId}][SKIP][USED_KEY] ${fname}`);
          continue;
        }
        if (usedStems.has(stem)) {
          console.log(`[5D][R2][${jobId}][DUPE][SKIP] stem already used: "${stem}" (${fname})`);
          continue;
        }
        if (assertFileExists(fname, 'R2_ANYFALLBACK')) {
          usedClips.push(fname);
          usedStems.add(stem);
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
      const candStem = stemFromPath(kenBurnsResult);
      if (!usedStems.has(candStem)) {
        usedClips.push(kenBurnsResult);
        usedStems.add(candStem);
        console.log(`[5D][DUPE][ADD][${jobId}] Added stem="${candStem}" path="${kenBurnsResult}"`);
      }
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
