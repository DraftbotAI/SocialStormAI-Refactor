// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (10Z Choices → Video-first)
// Simple, fast, literal: up to three scene options → video; else
// best image → Ken Burns → keep moving. No recursion, no churn.
//
// What this does (2025-08 "Simple Picker" patch):
// - Uses 10Z to generate up to THREE literal scene choices per line.
// - For each choice (ordered), tries: R2 (keys) → Pexels video → Pixabay video.
// - If no video hits, tries: Pexels photo → Pixabay photo → Unsplash photo.
// - Converts the best image to a short Ken Burns video and returns that.
// - Strong de-dupe (job-wide), landmark hard-negatives (no dog/monkey photobombs).
// - Central scoring via 10G; hard floors; strict time budgets.
// - Progress hooks are kept; never throws; always logs.
// - R2-any fallback at the very end (so we never block the job).
//
// Env knobs (sane defaults):
// - MATCHER_FLOOR_VIDEO (default 92), MATCHER_FLOOR_IMAGE (88)
// - MATCHER_PROVIDER_TIMEOUT_MS (10000), MATCHER_TIME_BUDGET_MS (16000)
// - MATCHER_ALLOW_RAW_IMAGE (false)
// - MATCHER_MAX_CHOICE_TERMS (3)
// - 10Z can run with GPT disabled and still return heuristics fast.
// ===========================================================

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// -----------------------------
// Providers (strictly required)
// -----------------------------
const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const {
  findPexelsClipForScene,
  findPexelsPhotoForScene
} = require('./section10b-pexels-clip-helper.cjs');
const {
  findPixabayClipForScene,
  findPixabayPhotoForScene
} = require('./section10c-pixabay-clip-helper.cjs');

// -----------------------------
// Ken Burns image → video helpers (soft-required but strongly recommended)
// -----------------------------
let makeKenBurnsVideoFromImage = null;
let preprocessImageToJpeg = null;
let staticImageToVideo = null;
try {
  ({
    makeKenBurnsVideoFromImage,
    preprocessImageToJpeg,
    staticImageToVideo,
  } = require('./section10d-kenburns-image-helper.cjs'));
  console.log('[5D][INIT] 10D Ken Burns helpers loaded.');
} catch {
  console.warn('[5D][INIT][WARN] 10D Ken Burns helpers not found. KB fallback disabled.');
}

// -----------------------------
// 10Z: simple three-option generator (required for this flow)
// Be flexible about filename & export names to avoid deploy breakage.
// -----------------------------
let generateSceneChoices = null;
try {
  // preferred filename used in your repo
  const z = require('./section10z-three-option-helper.cjs');
  generateSceneChoices = z.generateSceneChoices || z.generateThreeOptions || z.generateOptions || z.generate;
  if (generateSceneChoices) {
    console.log('[5D][INIT] 10Z helper loaded from section10z-three-option-helper.cjs');
  } else {
    throw new Error('Exports missing on section10z-three-option-helper.cjs');
  }
} catch (e1) {
  try {
    // alternate name some branches used earlier
    const z2 = require('./section10z-choice-directives.cjs');
    generateSceneChoices = z2.generateSceneChoices || z2.generateThreeOptions || z2.generateOptions || z2.generate;
    if (generateSceneChoices) {
      console.log('[5D][INIT] 10Z helper loaded from section10z-choice-directives.cjs');
    } else {
      throw new Error('Exports missing on section10z-choice-directives.cjs');
    }
  } catch (e2) {
    console.error('[5D][INIT][FATAL] 10Z helper not found in either filename.');
  }
}

// -----------------------------
// Optional Unsplash (work with either file name)
// -----------------------------
let unsplashModule = null;
try {
  unsplashModule = require('./section10f-unsplash-image-helper.cjs');
  console.log('[5D][INIT] 10F Unsplash (image-helper) loaded.');
} catch {
  try {
    unsplashModule = require('./section10f-unsplash-helper.cjs');
    console.log('[5D][INIT] 10F Unsplash (helper) loaded.');
  } catch {
    console.warn('[5D][INIT][WARN] Unsplash helper not found. Proceeding without it.');
  }
}

// -----------------------------
// Scoring (10G) and landmark guards
// -----------------------------
const {
  scoreSceneCandidate,
  LANDMARK_KEYWORDS,
  ANIMAL_TERMS,
  PERSON_TERMS,
} = require('./section10g-scene-scoring-helper.cjs');

console.log('[5D][INIT] Simple Picker clip matcher loaded (10Z choices → video-first → KB fallback).');

// ===========================================================
// Constants / Utilities
// ===========================================================

const HARD_FLOOR_VIDEO = Number(process.env.MATCHER_FLOOR_VIDEO || 92);
const HARD_FLOOR_IMAGE = Number(process.env.MATCHER_FLOOR_IMAGE || 88);
const PROVIDER_TIMEOUT_MS = Number(process.env.MATCHER_PROVIDER_TIMEOUT_MS || 10000);
const TIME_BUDGET_MS = Math.max(4000, Number(process.env.MATCHER_TIME_BUDGET_MS || 16000));
const MAX_CHOICE_TERMS = Math.max(1, Number(process.env.MATCHER_MAX_CHOICE_TERMS || 3));
const ALLOW_RAW_IMAGE = String(process.env.MATCHER_ALLOW_RAW_IMAGE || 'false').toLowerCase() === 'true';

function now() { return Date.now(); }

function normKey(p) {
  if (!p) return '';
  try {
    const base = path.basename(String(p)).toLowerCase().trim();
    return base.replace(/\s+/g, '_').replace(/[^a-z0-9._-]/g, '');
  } catch {
    return String(p).toLowerCase().trim();
  }
}

function usedHas(usedClips, p) {
  const k = normKey(p);
  if (!k) return false;
  if (usedClips instanceof Set) return usedClips.has(k) || usedClips.has(p);
  if (Array.isArray(usedClips)) return usedClips.includes(k) || usedClips.includes(p);
  return false;
}

function usedAdd(usedClips, p) {
  const k = normKey(p);
  if (!k) return;
  try {
    if (usedClips instanceof Set) {
      usedClips.add(k);
      usedClips.add(p);
    } else if (Array.isArray(usedClips)) {
      if (!usedClips.includes(k)) usedClips.push(k);
      if (!usedClips.includes(p)) usedClips.push(p);
    }
  } catch (e) {
    console.error('[5D][USED][ERR] Failed to add used clip:', e);
  }
}

function assertLocalFileExists(file, label = 'FILE', minSize = 8192) {
  try {
    if (!file) return false;
    const s = String(file);
    if (s.startsWith('http://') || s.startsWith('https://')) return true;
    if (!fs.existsSync(s)) {
      console.warn(`[5D][${label}][SKIP_ASSERT] Not local yet (remote/R2 or temp missing): ${s}`);
      return true;
    }
    const stat = fs.statSync(s);
    if (!stat.isFile()) {
      console.error(`[5D][${label}][ERR] Exists but not a file: ${s}`);
      return false;
    }
    if (stat.size < minSize) {
      console.error(`[5D][${label}][ERR] Too small (${stat.size} bytes): ${s}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[5D][${label}][ERR] Exception on assert:`, err);
    return false;
  }
}

function containsAny(list, s) {
  const L = String(s || '').toLowerCase();
  return list.some(w => L.includes(String(w).toLowerCase()));
}

function isLandmarkTokened(text) {
  const s = String(text || '').toLowerCase();
  return containsAny(LANDMARK_KEYWORDS, s);
}

// Landmark hard-negative filter (pre-score cull)
function landmarkCull(candidate) {
  const text = [
    candidate.path,
    candidate.title,
    candidate.description,
    candidate.tags ? candidate.tags.join(' ') : '',
    candidate.source,
    candidate.provider
  ].filter(Boolean).join(' ').toLowerCase();

  const hasAnimal = containsAny(ANIMAL_TERMS, text);
  const hasPerson = containsAny(PERSON_TERMS, text);

  const allowedHumanContext = /\b(guard|guards|soldier|soldiers|ceremony|changing of the guard)\b/.test(text);
  const looksLandmarky = containsAny(LANDMARK_KEYWORDS, text);

  if ((hasAnimal || hasPerson) && !(allowedHumanContext && looksLandmarky)) {
    return false;
  }
  return true;
}

function dedupeByPath(arr) {
  const seen = new Set();
  const out = [];
  for (const c of arr) {
    const k = normKey(c.path);
    if (k && !seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}

function asPathAndSource(res, sourceTag) {
  const p = res?.filePath || res?.path || res;
  return p ? {
    path: p,
    source: sourceTag,
    title: res?.title,
    description: res?.description,
    tags: res?.tags,
    provider: res?.provider,
    isVideo: !!res?.isVideo,
    subject: res?.subject
  } : null;
}

// ---------- Progress helpers (best-effort, no-op if not wired) ----------
function progress(jobContext, sceneIdx, percent, stage, extra = {}) {
  try {
    if (!jobContext) return;
    if (jobContext.progress?.set) jobContext.progress.set(stage, percent, { sceneIdx, ...extra });
    if (jobContext.progress?.tick && typeof percent === 'number') jobContext.progress.tick(0, stage);
    if (jobContext.updateProgress) jobContext.updateProgress(percent, stage, { sceneIdx, ...extra });
    if (jobContext.emit) jobContext.emit('progress', { percent, stage, sceneIdx, ...extra });
  } catch (_) { /* swallow */ }
}

// ===========================================================
// Ken Burns (image → local video)
// ===========================================================
async function kenBurnsVideoFromImagePath(imgPath, workDir, sceneIdx, jobId) {
  if (!makeKenBurnsVideoFromImage || !preprocessImageToJpeg || !staticImageToVideo) {
    console.warn('[5D][KENBURNS][WARN] 10D helpers missing; cannot build Ken Burns video.');
    return null;
  }
  try {
    const safeDir = workDir || path.join(__dirname, '..', 'jobs', `kb-${jobId || 'job'}`);
    if (!fs.existsSync(safeDir)) fs.mkdirSync(safeDir, { recursive: true });

    const prepped = path.join(safeDir, `kb-prepped-${uuidv4()}.jpg`);
    await preprocessImageToJpeg(imgPath, prepped, jobId);

    const outVid = path.join(safeDir, `kbvid-${uuidv4()}.mp4`);
    await makeKenBurnsVideoFromImage(prepped, outVid, 5, jobId);

    if (!assertLocalFileExists(outVid, 'KENBURNS_OUT', 2048)) {
      await staticImageToVideo(prepped, outVid, 5, jobId);
    }
    console.log(`[5D][KENBURNS][${jobId}] Built local KB video from image: ${outVid}`);
    return outVid;
  } catch (err) {
    console.error(`[5D][KENBURNS][${jobId}][ERR] Could not build KB from image (${imgPath}).`, err);
    return null;
  }
}

// ===========================================================
// Helpers: gather candidates per provider/tier with timeouts
// ===========================================================
async function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`[TIMEOUT] ${label} after ${ms}ms`)), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    clearTimeout(t);
    return result;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function gatherVideoCandidates(term, workDir, sceneIdx, jobId, usedClips, landmarkMode, categoryFolder) {
  const out = [];

  // R2 first (keys only)
  try {
    if (typeof findR2ClipForScene.getAllFiles === 'function') {
      const r2Files = await withTimeout(
        findR2ClipForScene.getAllFiles(term, categoryFolder),
        PROVIDER_TIMEOUT_MS,
        'R2.getAllFiles'
      );
      for (const key of r2Files || []) {
        if (usedHas(usedClips, key)) continue;
        const c = { path: key, source: 'R2', isVideo: true, subject: term, provider: 'r2' };
        if (!landmarkMode || landmarkCull(c)) out.push(c);
      }
      console.log(`[5D][R2][${jobId}] +${(r2Files || []).length} candidates for "${term}"`);
    }
  } catch (err) {
    console.error(`[5D][R2][${jobId}][ERR]`, err?.message || err);
  }

  // Pexels video
  try {
    const res = await withTimeout(
      findPexelsClipForScene(term, workDir, sceneIdx, jobId, usedClips),
      PROVIDER_TIMEOUT_MS,
      'PEXELS_VIDEO'
    );
    const hit = asPathAndSource(res, 'PEXELS_VIDEO');
    if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PEXELS_VIDEO_RESULT')) {
      if (!landmarkMode || landmarkCull(hit)) {
        hit.isVideo = true;
        hit.provider = hit.provider || 'pexels';
        out.push(hit);
      }
    }
  } catch (err) {
    console.error(`[5D][PEXELS_VIDEO][${jobId}][ERR]`, err?.message || err);
  }

  // Pixabay video
  try {
    const res = await withTimeout(
      findPixabayClipForScene(term, workDir, sceneIdx, jobId, usedClips),
      PROVIDER_TIMEOUT_MS,
      'PIXABAY_VIDEO'
    );
    const hit = asPathAndSource(res, 'PIXABAY_VIDEO');
    if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PIXABAY_VIDEO_RESULT')) {
      if (!landmarkMode || landmarkCull(hit)) {
        hit.isVideo = true;
        hit.provider = hit.provider || 'pixabay';
        out.push(hit);
      }
    }
  } catch (err) {
    console.error(`[5D][PIXABAY_VIDEO][${jobId}][ERR]`, err?.message || err);
  }

  return out;
}

async function gatherImageCandidates(term, workDir, sceneIdx, jobId, usedClips, landmarkMode) {
  const out = [];

  // Pexels photo
  try {
    const res = await withTimeout(
      findPexelsPhotoForScene(term, workDir, sceneIdx, jobId, usedClips),
      PROVIDER_TIMEOUT_MS,
      'PEXELS_PHOTO'
    );
    const hit = asPathAndSource(res, 'PEXELS_PHOTO');
    if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PEXELS_PHOTO_RESULT', 4096)) {
      if (!landmarkMode || landmarkCull(hit)) {
        hit.isVideo = false;
        hit.provider = hit.provider || 'pexels';
        out.push(hit);
      }
    }
  } catch (err) {
    console.error(`[5D][PEXELS_PHOTO][${jobId}][ERR]`, err?.message || err);
  }

  // Pixabay photo
  try {
    const res = await withTimeout(
      findPixabayPhotoForScene(term, workDir, sceneIdx, jobId, usedClips),
      PROVIDER_TIMEOUT_MS,
      'PIXABAY_PHOTO'
    );
    const hit = asPathAndSource(res, 'PIXABAY_PHOTO');
    if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PIXABAY_PHOTO_RESULT', 4096)) {
      if (!landmarkMode || landmarkCull(hit)) {
        hit.isVideo = false;
        hit.provider = hit.provider || 'pixabay';
        out.push(hit);
      }
    }
  } catch (err) {
    console.error(`[5D][PIXABAY_PHOTO][${jobId}][ERR]`, err?.message || err);
  }

  // Unsplash photo (optional)
  try {
    if (unsplashModule?.findUnsplashImageForScene) {
      const res = await withTimeout(
        unsplashModule.findUnsplashImageForScene(term, workDir, sceneIdx, jobId, usedClips, {}),
        PROVIDER_TIMEOUT_MS,
        'UNSPLASH'
      );
      const hit = asPathAndSource(res, 'UNSPLASH');
      if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'UNSPLASH_RESULT', 4096)) {
        if (!landmarkMode || landmarkCull(hit)) {
          hit.isVideo = false;
          hit.provider = hit.provider || 'unsplash';
          out.push(hit);
        }
      }
    }
  } catch (err) {
    console.warn('[5D][UNSPLASH][SKIP]', err?.message || err);
  }

  return out;
}

// ===========================================================
// MAIN
// ===========================================================
/**
 * Chooses the best visual for a scene via 10Z three choices:
 *  - Returns:
 *      • R2 key string (downloaded later by 5B),
 *      • Local video path (provider download or Ken Burns output),
 *      • null (if absolutely nothing found).
 */
async function findClipForScene({
  subject,
  sceneIdx,
  allSceneTexts,
  mainTopic,
  usedClips = [],
  workDir,
  jobId,
  jobContext = {},
  categoryFolder,
}) {
  const sceneStart = now();
  console.log('\n===================================================');
  console.log(`[5D][START][${jobId}][S${sceneIdx}] Subject="${subject}"`);
  console.log(`[5D][CTX][S${sceneIdx}]`, allSceneTexts?.[sceneIdx] || '(no scene text)');
  progress(jobContext, sceneIdx, 70, 'matcher:start');

  // Ensure job-scoped caches
  if (!jobContext._matcherCache) jobContext._matcherCache = new Map();

  // ----- 10Z: get up to 3 literal choices for this line -----
  const line = String(allSceneTexts?.[sceneIdx] || subject || '').trim();
  let choices = [];
  try {
    if (typeof generateSceneChoices === 'function') {
      const z = await generateSceneChoices({
        sceneLine: line,
        mainTopic: mainTopic || '',
        maxChoices: MAX_CHOICE_TERMS,
        jobId,
      });
      choices = (Array.isArray(z) ? z : [])
        .map(s => String(s || '').trim())
        .filter(Boolean)
        .slice(0, MAX_CHOICE_TERMS);
    } else {
      console.warn('[5D][10Z][WARN] generateSceneChoices not available; falling back to raw line.');
    }
  } catch (e) {
    console.error('[5D][10Z][ERR]', e?.message || e);
  }

  // Fallback: at least try the raw subject/line
  if (!choices.length) {
    const back = (subject || line || mainTopic || 'topic').trim();
    if (back) choices = [back];
  }

  // Cache key (per-scene + choices + category)
  const cacheKey = `${sceneIdx}|${choices.map(c => c.toLowerCase()).join('|')}|${categoryFolder || 'misc'}`;
  const cached = jobContext._matcherCache.get(cacheKey);
  if (cached && cached.path && !usedHas(usedClips, cached.path)) {
    console.log(`[5D][CACHE][HIT][${jobId}]`, cached);
    usedAdd(usedClips, cached.path);
    progress(jobContext, sceneIdx, 93, 'matcher:cache-hit');
    return cached.path;
  }

  console.log(`[5D][CHOICES][${jobId}]`, choices);

  // ---------- For each choice: videos first ----------
  for (const [idx, term] of choices.entries()) {
    if ((now() - sceneStart) > TIME_BUDGET_MS) {
      console.warn(`[5D][TIME][${jobId}][S${sceneIdx}] Budget exceeded; stopping search.`);
      break;
    }
    const landmarkMode = isLandmarkTokened(term) || isLandmarkTokened(mainTopic);
    progress(jobContext, sceneIdx, 80, `matcher:choice${idx + 1}-video`);

    let videoCandidates = await gatherVideoCandidates(term, workDir, sceneIdx, jobId, usedClips, landmarkMode, categoryFolder);

    // score, filter, sort
    videoCandidates = dedupeByPath(videoCandidates).map(c => ({
      ...c,
      score: scoreSceneCandidate(c, term, usedClips, true),
    })).filter(c => c.score >= HARD_FLOOR_VIDEO).sort((a, b) => b.score - a.score);

    console.log(`[5D][CANDS][VIDEO][${term}] TOP3`, videoCandidates.slice(0, 3).map(c => ({ path: c.path, src: c.source, score: c.score })));

    if (videoCandidates.length) {
      const best = videoCandidates[0];
      usedAdd(usedClips, best.path);
      jobContext._matcherCache.set(cacheKey, { path: best.path, type: 'video', score: best.score });
      console.log(`[5D][RESULT][VIDEO][${jobId}]`, { path: best.path, source: best.source, score: best.score, term });
      progress(jobContext, sceneIdx, 92, `matcher:choice${idx + 1}-video-selected`, { source: best.source });
      return best.path;
    }
  }

  // ---------- If no video for any choice: try images then KB ----------
  for (const [idx, term] of choices.entries()) {
    if ((now() - sceneStart) > TIME_BUDGET_MS) {
      console.warn(`[5D][TIME][${jobId}][S${sceneIdx}] Budget exceeded before image step.`);
      break;
    }
    const landmarkMode = isLandmarkTokened(term) || isLandmarkTokened(mainTopic);
    progress(jobContext, sceneIdx, 84, `matcher:choice${idx + 1}-image`);

    let imageCandidates = await gatherImageCandidates(term, workDir, sceneIdx, jobId, usedClips, landmarkMode);

    imageCandidates = dedupeByPath(imageCandidates).map(c => ({
      ...c,
      score: scoreSceneCandidate(c, term, usedClips, false),
    })).filter(c => c.score >= HARD_FLOOR_IMAGE).sort((a, b) => b.score - a.score);

    console.log(`[5D][CANDS][IMAGE][${term}] TOP3`, imageCandidates.slice(0, 3).map(c => ({ path: c.path, src: c.source, score: c.score })));

    if (imageCandidates.length) {
      const bestImg = imageCandidates[0];
      console.log(`[5D][RESULT][IMAGE->KB][${jobId}]`, { path: bestImg.path, source: bestImg.source, score: bestImg.score, term });
      progress(jobContext, sceneIdx, 90, `matcher:choice${idx + 1}-kb-build`);

      const kbVid = await kenBurnsVideoFromImagePath(bestImg.path, workDir, sceneIdx, jobId);
      if (kbVid && assertLocalFileExists(kbVid, 'KB_OUT', 2048)) {
        usedAdd(usedClips, bestImg.path);
        jobContext._matcherCache.set(cacheKey, { path: kbVid, type: 'kb', score: bestImg.score });
        progress(jobContext, sceneIdx, 92, `matcher:choice${idx + 1}-kb-ok`);
        return kbVid;
      }

      // KB failed → still-to-video fallback if available
      if (makeKenBurnsVideoFromImage && staticImageToVideo && preprocessImageToJpeg) {
        try {
          const safeDir = workDir || path.join(__dirname, '..', 'jobs', `kb-${jobId || 'job'}`);
          if (!fs.existsSync(safeDir)) fs.mkdirSync(safeDir, { recursive: true });
          const prepped = path.join(safeDir, `kb-prepped-${uuidv4()}.jpg`);
          await preprocessImageToJpeg(bestImg.path, prepped, jobId);
          const outVid = path.join(safeDir, `stillvid-${uuidv4()}.mp4`);
          await staticImageToVideo(prepped, outVid, 5, jobId);
          if (assertLocalFileExists(outVid, 'STILL_OUT', 2048)) {
            usedAdd(usedClips, bestImg.path);
            jobContext._matcherCache.set(cacheKey, { path: outVid, type: 'kb-still', score: bestImg.score });
            progress(jobContext, sceneIdx, 92, `matcher:choice${idx + 1}-still-ok`);
            return outVid;
          }
        } catch (e) {
          console.error('[5D][STILL][ERR]', e);
        }
      }

      if (ALLOW_RAW_IMAGE) {
        console.warn(`[5D][IMAGE_FALLBACK][${jobId}] Returning raw image path (ALLOW_RAW_IMAGE=true).`);
        jobContext._matcherCache.set(cacheKey, { path: bestImg.path, type: 'image', score: bestImg.score });
        progress(jobContext, sceneIdx, 92, `matcher:choice${idx + 1}-image-fallback`);
        return bestImg.path;
      } else {
        console.warn(`[5D][IMAGE_FALLBACK][${jobId}] Raw image suppressed (ALLOW_RAW_IMAGE=false). Trying next choice.`);
      }
    }
  }

  // ---------- Total miss → pick any unused R2 clip so we don't block ----------
  progress(jobContext, sceneIdx, 92, 'matcher:r2-any-fallback');
  if (typeof findR2ClipForScene.getAllFiles === 'function') {
    try {
      const r2Files = await findR2ClipForScene.getAllFiles();
      const fallback = (r2Files || []).find(f => !usedHas(usedClips, f));
      if (fallback) {
        console.warn(`[5D][FALLBACK][${jobId}] Using first-available R2 clip: ${fallback}`);
        usedAdd(usedClips, fallback);
        jobContext._matcherCache.set(cacheKey, { path: fallback, type: 'video', score: 0 });
        return fallback; // R2 key
      }
    } catch (err) {
      console.error(`[5D][R2_FALLBACK][${jobId}][ERR]`, err);
    }
  }

  console.error(`[5D][NO_MATCH][${jobId}] No match found for scene ${sceneIdx + 1}`);
  progress(jobContext, sceneIdx, 92, 'matcher:none');
  return null;
}

module.exports = { findClipForScene };
