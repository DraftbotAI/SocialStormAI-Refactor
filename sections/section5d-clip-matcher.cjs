// ============================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Loosest, Bulletproof)
// Always returns something: video, image, Ken Burns, or any available.
// Never loops forever. Max logs at each fallback step.
// ============================================================

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

// --- NEW: mark winners as used (path, basename, provider url/name) IN PLACE ---
function markUsedInPlace(usedClips, candidate = {}) {
  try {
    if (!Array.isArray(usedClips)) return;
    const p = candidate.path || candidate.filePath || '';
    const b = p ? path.basename(p) : '';
    const u = candidate.meta?.url || candidate.url || '';
    const n = candidate.meta?.originalName || candidate.filename || '';

    const add = v => { if (v && !usedClips.includes(v)) usedClips.push(v); };
    add(p); add(b); add(u); add(n);
  } catch (_) {}
}

// --- NEW: helper to check if candidate already used ---
function isUsed(usedClips, candidatePath, meta = {}) {
  if (!Array.isArray(usedClips)) return false;
  const base = candidatePath ? path.basename(candidatePath) : '';
  const url  = meta?.url || '';
  return usedClips.includes(candidatePath) || (base && usedClips.includes(base)) || (url && usedClips.includes(url));
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

  // Anchor logic: for the hook/mega scene, lock to the true topic.
  if (isMegaScene || sceneIdx === 0) {
    if (megaSubject && typeof megaSubject === 'string' && megaSubject.length > 2 && !GENERIC_SUBJECTS.includes(megaSubject.toLowerCase())) {
      searchSubject = megaSubject;
      console.log(`[5D][ANCHOR][${jobId}] Using megaSubject for first/mega-scene: "${searchSubject}"`);
    } else if (mainTopic && typeof mainTopic === 'string' && mainTopic.length > 2 && !GENERIC_SUBJECTS.includes(mainTopic.toLowerCase())) {
      searchSubject = mainTopic;
      console.log(`[5D][ANCHOR][${jobId}] Fallback to mainTopic for mega-scene: "${searchSubject}"`);
    } else {
      searchSubject = allSceneTexts?.[0] || subject;
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

  // Extract prioritized subjects (strict → symbolic → general)
  let prioritizedSubjects = [];
  try {
    prioritizedSubjects = await extractVisualSubjects(searchSubject, mainTopic);
    console.log(`[5D][GPT][${jobId}] Prioritized visual subjects for scene ${sceneIdx + 1}:`, prioritizedSubjects);
  } catch (err) {
    console.error(`[5D][GPT][${jobId}][ERR] Error extracting prioritized subjects:`, err);
    prioritizedSubjects = [searchSubject, mainTopic].filter(Boolean);
  }

  // Try each prioritized subject once (no recursion; no loops)
  for (const subjectOption of prioritizedSubjects) {
    if (!subjectOption || subjectOption.length < 2) continue;

    const scoredCandidates = [];

    // === 1) R2 (download + score) ===
    try {
      // R2 helper downloads best match for the subject and returns local path
      const r2Local = await findR2ClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (r2Local && assertFileExists(r2Local, 'R2_RESULT')) {
        if (isUsed(usedClips, r2Local)) {
          console.log(`[5D][R2][${jobId}] Skipping used R2 candidate: ${path.basename(r2Local)}`);
        } else {
          const r2Score = scoreSceneCandidate(
            {
              filename: path.basename(r2Local),
              filePath: r2Local,
              tags: [],
              title: path.basename(r2Local),
              description: ''
            },
            subjectOption,
            usedClips
          );
          console.log(`[5D][R2][${jobId}] Candidate score for "${subjectOption}": ${r2Score}`);
          scoredCandidates.push({ source: 'r2', path: r2Local, score: r2Score, meta: {} });
        }
      } else {
        console.log(`[5D][R2][${jobId}] No local R2 candidate for "${subjectOption}"`);
      }
    } catch (err) {
      console.error(`[5D][R2][ERR][${jobId}]`, err);
    }

    // === 2) Pexels ===
    try {
      const pxRes = await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      const pxPath = (pxRes && pxRes.path) ? pxRes.path : pxRes;
      const pxMeta = (pxRes && pxRes.meta) ? pxRes.meta : {};

      if (pxPath && assertFileExists(pxPath, 'PEXELS_RESULT')) {
        if (isUsed(usedClips, pxPath, pxMeta)) {
          console.log(`[5D][PEXELS][${jobId}] Skipping used Pexels candidate: ${path.basename(pxPath)}`);
        } else {
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
      }
    } catch (e) {
      console.error(`[5D][PEXELS][ERR][${jobId}]`, e);
    }

    // === 3) Pixabay ===
    try {
      const pbRes = await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      const pbPath = (pbRes && pbRes.path) ? pbRes.path : pbRes;
      const pbMeta = (pbRes && pbRes.meta) ? pbRes.meta : {};

      if (pbPath && assertFileExists(pbPath, 'PIXABAY_RESULT')) {
        if (isUsed(usedClips, pbPath, pbMeta)) {
          console.log(`[5D][PIXABAY][${jobId}] Skipping used Pixabay candidate: ${path.basename(pbPath)}`);
        } else {
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
      }
    } catch (e) {
      console.error(`[5D][PIXABAY][ERR][${jobId}]`, e);
    }

    // === Decide winner across sources ===
    if (scoredCandidates.length) {
      // Small tiebreak so equal scores don't always pick the first
      scoredCandidates.sort((a, b) => (b.score - a.score) || (Math.random() - 0.5));
      const winner = scoredCandidates[0];
      console.log(`[5D][PICK][${jobId}] Winner across sources for "${subjectOption}" => ${winner.source.toUpperCase()} | score=${winner.score} | path=${winner.path}`);

      // ✅ mark as used IN PLACE (prevents repeats incl. mega-scene next line)
      markUsedInPlace(usedClips, {
        path: winner.path,
        meta: winner.meta || {},
        filename: path.basename(winner.path)
      });

      // Track for ingestion if caller wants to archive raw provider assets
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
      const unsplashResult = await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext);
      if (unsplashResult && !isUsed(usedClips, unsplashResult) && assertFileExists(unsplashResult, 'UNSPLASH_RESULT')) {
        console.log(`[5D][PICK][${jobId}] Unsplash image (loose): ${unsplashResult}`);
        markUsedInPlace(usedClips, { path: unsplashResult, filename: path.basename(unsplashResult) });
        return unsplashResult;
      }
    } catch (e) {
      console.error(`[5D][UNSPLASH][ERR][${jobId}]`, e);
    }

    try {
      const kenBurnsResult = await fallbackKenBurnsVideo(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (kenBurnsResult && !isUsed(usedClips, kenBurnsResult) && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
        console.log(`[5D][PICK][${jobId}] KenBurns fallback (loose): ${kenBurnsResult}`);
        markUsedInPlace(usedClips, { path: kenBurnsResult, filename: path.basename(kenBurnsResult) });
        return kenBurnsResult;
      }
    } catch (e) {
      console.error(`[5D][KENBURNS][ERR][${jobId}]`, e);
    }
  }

  // === Safe R2 fallback (no remote->local assumption) ===
  // Try one last R2 pull with the mainTopic or the original searchSubject.
  try {
    const hailMarySubject = mainTopic || searchSubject || 'landmark';
    console.warn(`[5D][FINALFALLBACK][${jobId}] Attempting final R2 pull with subject="${hailMarySubject}"`);
    const r2Local = await findR2ClipForScene(hailMarySubject, workDir, sceneIdx, jobId, usedClips);
    if (r2Local && assertFileExists(r2Local, 'R2_FINAL')) {
      markUsedInPlace(usedClips, { path: r2Local, filename: path.basename(r2Local) });
      console.warn(`[5D][FINALFALLBACK][${jobId}] Using R2 fallback: ${r2Local}`);
      return r2Local;
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][R2][${jobId}] Error during final R2 attempt:`, e);
  }

  // === Ken Burns generic last resort ===
  console.error(`[5D][NO_MATCH][${jobId}] No valid clip found for scene ${sceneIdx + 1} after all fallbacks.`);
  try {
    const kenBurnsResult = await fallbackKenBurnsVideo('landmark', workDir, sceneIdx, jobId, usedClips);
    if (kenBurnsResult && assertFileExists(kenBurnsResult, 'KENBURNS_RESULT')) {
      console.log(`[5D][FINALFALLBACK][${jobId}] KenBurns generic fallback: ${kenBurnsResult}`);
      markUsedInPlace(usedClips, { path: kenBurnsResult, filename: path.basename(kenBurnsResult) });
      return kenBurnsResult;
    }
  } catch (e) {
    console.error(`[5D][FINALFALLBACK][KENBURNS][${jobId}] Error during generic KenBurns fallback:`, e);
  }

  return null;
}

module.exports = { findClipForScene };
