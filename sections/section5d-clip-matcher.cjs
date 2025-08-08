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
  const kb = require('./section10d-kenburns-image-helper.cjs');
  makeKenBurnsVideoFromImage = kb.makeKenBurnsVideoFromImage;
  preprocessImageToJpeg = kb.preprocessImageToJpeg;
  staticImageToVideo = kb.staticImageToVideo;
  console.log('[5D][INIT] 10D Ken Burns image helper loaded.');
} catch (e) {
  console.warn('[5D][INIT][WARN] 10D Ken Burns helper missing; image→video fallback will be limited.');
}

// -----------------------------
// Upload helper (optional; for raw asset archival if needed)
// -----------------------------
let uploader = null;
try {
  uploader = require('./section10e-upload-to-r2.cjs');
  console.log('[5D][INIT] 10E Upload helper loaded.');
} catch {
  // optional
}

// -----------------------------
// Unsplash (optional image source)
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
    // optional
  }
}

// -----------------------------
// 10G scorer (strict floors applied here too)
// -----------------------------
const {
  scoreSceneCandidate,
  LANDMARK_KEYWORDS,
  ANIMAL_TERMS,
  PERSON_TERMS,
} = require('./section10g-scene-scoring-helper.cjs');

// -----------------------------
// 10Z scene-choice generator (this was mismatched before)
// We now accept ANY of these exported names:
//   - generateSceneChoices (preferred by 5D)
//   - getLiteralSceneOptions (actual current 10Z export)
//   - generateThreeOptions / generateOptions / generate
// -----------------------------
let generateSceneChoices = null;
try {
  const z = require('./section10z-three-option-helper.cjs');
  generateSceneChoices =
    z.generateSceneChoices ||
    z.getLiteralSceneOptions ||
    z.generateThreeOptions ||
    z.generateOptions ||
    z.generate;
  if (typeof generateSceneChoices === 'function') {
    console.log('[5D][INIT] 10Z helper loaded from section10z-three-option-helper.cjs');
  } else {
    throw new Error('Exports missing on section10z-three-option-helper.cjs');
  }
} catch (e1) {
  try {
    const z2 = require('./section10z-choice-directives.cjs');
    generateSceneChoices =
      z2.generateSceneChoices ||
      z2.getLiteralSceneOptions ||
      z2.generateThreeOptions ||
      z2.generateOptions ||
      z2.generate;
    if (typeof generateSceneChoices === 'function') {
      console.log('[5D][INIT] 10Z helper loaded from section10z-choice-directives.cjs');
    } else {
      throw new Error('Exports missing on section10z-choice-directives.cjs');
    }
  } catch (e2) {
    console.error('[5D][INIT][FATAL] 10Z helper not found in either filename.');
  }
}

// ===========================================================
// CONSTANTS
// ===========================================================
const HARD_FLOOR_VIDEO = Number(process.env.MATCHER_FLOOR_VIDEO || 92);
const HARD_FLOOR_IMAGE = Number(process.env.MATCHER_FLOOR_IMAGE || 88);
const PROVIDER_TIMEOUT_MS = Number(process.env.MATCHER_PROVIDER_TIMEOUT_MS || 12000);
const TIME_BUDGET_MS = Number(process.env.MATCHER_TIME_BUDGET_MS || 16000);
const ALLOW_RAW_IMAGE = String(process.env.MATCHER_ALLOW_RAW_IMAGE || 'false').toLowerCase() === 'true';
const MAX_CHOICE_TERMS = Math.min(Number(process.env.MATCHER_MAX_CHOICE_TERMS || 3), 5);

// ===========================================================
// SMALL UTILS
// ===========================================================
function now() { return Date.now(); }

function ensureDir(dir) {
  try { if (dir) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function usedHas(usedClips, keyOrPath) {
  const key = String(keyOrPath || '');
  const base = path.basename(key);
  if (usedClips instanceof Set) return usedClips.has(key) || usedClips.has(base) || usedClips.has(key.toLowerCase());
  if (Array.isArray(usedClips)) {
    const L = usedClips.map(String);
    return L.includes(key) || L.includes(base) || L.includes(key.toLowerCase());
  }
  return false;
}
function usedAdd(usedClips, keyOrPath) {
  const key = String(keyOrPath || '');
  const base = path.basename(key);
  if (usedClips instanceof Set) {
    usedClips.add(key); usedClips.add(base); usedClips.add(key.toLowerCase());
  } else if (Array.isArray(usedClips)) {
    if (!usedHas(usedClips, key)) usedClips.push(key);
    if (!usedHas(usedClips, base)) usedClips.push(base);
    const norm = key.toLowerCase();
    if (!usedHas(usedClips, norm)) usedClips.push(norm);
  }
}

function dedupeByPath(arr = []) {
  const seen = new Set();
  const out = [];
  for (const c of arr) {
    const p = (c && (c.path || c.filePath || c.url)) ? (c.path || c.filePath || c.url) : null;
    if (!p) continue;
    const key = String(p).toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
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

function withTimeout(promise, ms, label = 'provider') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[5D][TIMEOUT] ${label} exceeded ${ms}ms`)), ms);
    Promise.resolve(promise).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ===========================================================
// CANDIDATE GATHERING
// ===========================================================
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
    const p = await withTimeout(findPexelsClipForScene(term, workDir, sceneIdx, jobId, usedClips), PROVIDER_TIMEOUT_MS, 'Pexels.video');
    if (p && p.filePath && !usedHas(usedClips, p.filePath)) {
      const c = { path: p.filePath, source: 'PEXELS', isVideo: true, subject: term, provider: 'pexels', title: p.title, description: p.description, tags: p.tags };
      if (!landmarkMode || landmarkCull(c)) out.push(c);
    }
  } catch (err) {
    console.warn(`[5D][PEXELS][${jobId}] video err:`, err?.message || err);
  }

  // Pixabay video
  try {
    const x = await withTimeout(findPixabayClipForScene(term, workDir, sceneIdx, jobId, usedClips), PROVIDER_TIMEOUT_MS, 'Pixabay.video');
    if (x && x.filePath && !usedHas(usedClips, x.filePath)) {
      const c = { path: x.filePath, source: 'PIXABAY', isVideo: true, subject: term, provider: 'pixabay', title: x.title, description: x.description, tags: x.tags };
      if (!landmarkMode || landmarkCull(c)) out.push(c);
    }
  } catch (err) {
    console.warn(`[5D][PIXABAY][${jobId}] video err:`, err?.message || err);
  }

  return out;
}

async function gatherImageCandidates(term, workDir, sceneIdx, jobId, usedClips, landmarkMode) {
  const out = [];

  // Pexels photo
  try {
    const p = await withTimeout(findPexelsPhotoForScene(term, workDir, sceneIdx, jobId, usedClips), PROVIDER_TIMEOUT_MS, 'Pexels.photo');
    if (p && p.filePath && !usedHas(usedClips, p.filePath)) {
      const c = { path: p.filePath, source: 'PEXELS', isVideo: false, subject: term, provider: 'pexels', title: p.title, description: p.description, tags: p.tags };
      if (!landmarkMode || landmarkCull(c)) out.push(c);
    }
  } catch (err) {
    console.warn(`[5D][PEXELS][${jobId}] photo err:`, err?.message || err);
  }

  // Pixabay photo
  try {
    const x = await withTimeout(findPixabayPhotoForScene(term, workDir, sceneIdx, jobId, usedClips), PROVIDER_TIMEOUT_MS, 'Pixabay.photo');
    if (x && x.filePath && !usedHas(usedClips, x.filePath)) {
      const c = { path: x.filePath, source: 'PIXABAY', isVideo: false, subject: term, provider: 'pixabay', title: x.title, description: x.description, tags: x.tags };
      if (!landmarkMode || landmarkCull(c)) out.push(c);
    }
  } catch (err) {
    console.warn(`[5D][PIXABAY][${jobId}] photo err:`, err?.message || err);
  }

  // Unsplash (optional)
  try {
    if (unsplashModule && typeof unsplashModule.findUnsplashImageForScene === 'function') {
      const u = await withTimeout(unsplashModule.findUnsplashImageForScene(term, workDir, sceneIdx, jobId, usedClips), PROVIDER_TIMEOUT_MS, 'Unsplash.photo');
      if (u && u.filePath && !usedHas(usedClips, u.filePath)) {
        const hit = { path: u.filePath, source: 'UNSPLASH', title: u.title, description: u.description, tags: u.tags };
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
  jobContext = {},
  workDir = '',
  categoryFolder = ''
}) {
  const jobId = jobContext?.jobId || uuidv4();
  ensureDir(workDir);
  if (!jobContext._matcherCache) jobContext._matcherCache = new Map();

  const cacheKey = `S${sceneIdx}-${String(subject?.primary || subject || '').toLowerCase()}-${mainTopic}`;
  if (jobContext._matcherCache.has(cacheKey)) {
    const cached = jobContext._matcherCache.get(cacheKey);
    console.log(`[5D][CACHE][HIT][${jobId}]`, cached);
    return cached?.path || null;
  }

  const sceneStart = now();
  const progress = (ctx, idx, pct, msg, extra = {}) => {
    try {
      if (ctx?.onProgress) ctx.onProgress({ stage: 'matcher', sceneIdx: idx, pct, msg, ...extra });
    } catch (_) {}
  };

  // ----- Build choices for this line -----
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
    const back = (subject || line || '').toString().trim();
    if (back) choices.push(back);
  }

  // Landmark awareness: if topic/line smells like landmark, nuke person/animal-y prompts
  const landmarkTopic = isLandmarkTokened(mainTopic) || isLandmarkTokened(line);
  if (landmarkTopic) {
    const banned = new Set([...ANIMAL_TERMS, ...PERSON_TERMS].map(String));
    const pre = choices.slice();
    choices = choices.filter(c => {
      const L = String(c).toLowerCase();
      // keep only if it contains a landmark token OR contains none of the banned tokens
      const hasLandmarkWord = containsAny(LANDMARK_KEYWORDS, L);
      const hasBanned = [...banned].some(w => L.includes(w));
      return hasLandmarkWord || !hasBanned;
    });
    if (!choices.length) {
      // fallback: use main topic as the single literal choice
      if (mainTopic) choices = [mainTopic];
    }
    console.log('[5D][10Z][LANDMARK_FILTER]', { before: pre, after: choices });
  }

  console.log(`[5D][CHOICES][S${sceneIdx}][${jobId}]`, choices);

  // ---------- TRY VIDEOS ----------
  for (const [idx, term] of choices.entries()) {
    if ((now() - sceneStart) > TIME_BUDGET_MS) {
      console.warn(`[5D][TIME][${jobId}][S${sceneIdx}] Budget exceeded before video step.`);
      break;
    }
    const landmarkMode = isLandmarkTokened(term) || landmarkTopic;
    progress(jobContext, sceneIdx, 78, `matcher:choice${idx + 1}-video`);

    let videoCandidates = await gatherVideoCandidates(term, workDir, sceneIdx, jobId, usedClips, landmarkMode, categoryFolder);

    // Score & filter
    videoCandidates = dedupeByPath(videoCandidates).map(c => ({
      ...c,
      score: scoreSceneCandidate(c, term, usedClips, /*realMatchExists=*/true),
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
      const best = imageCandidates[0];
      if (!ALLOW_RAW_IMAGE && typeof makeKenBurnsVideoFromImage === 'function') {
        const kbOut = path.join(workDir, `scene${sceneIdx + 1}-kb-${uuidv4().slice(0, 8)}.mp4`);
        const kb = await makeKenBurnsVideoFromImage(best.path, kbOut, { jobId, sceneIdx });
        if (kb && fs.existsSync(kbOut)) {
          usedAdd(usedClips, kbOut);
          jobContext._matcherCache.set(cacheKey, { path: kbOut, type: 'video', score: best.score });
          console.log(`[5D][RESULT][KB][${jobId}]`, { path: kbOut, from: best.path, score: best.score });
          progress(jobContext, sceneIdx, 90, 'matcher:kenburns');
          return kbOut;
        }
      } else if (ALLOW_RAW_IMAGE) {
        usedAdd(usedClips, best.path);
        jobContext._matcherCache.set(cacheKey, { path: best.path, type: 'image', score: best.score });
        console.log(`[5D][RESULT][IMAGE][${jobId}]`, { path: best.path, score: best.score });
        progress(jobContext, sceneIdx, 88, 'matcher:image');
        return best.path;
      }
    }
  }

  // ---------- Last resort: any R2 fallback to avoid total null ----------
  try {
    const any = await withTimeout(findR2ClipForScene.getAllFiles ? findR2ClipForScene.getAllFiles(mainTopic || subject || '', categoryFolder) : [], 4000, 'R2.anyFallback');
    if (Array.isArray(any) && any.length) {
      const fallback = any.find(k => !usedHas(usedClips, k));
      if (fallback) {
        console.warn(`[5D][R2_FALLBACK][${jobId}] Using last-resort R2 key: ${fallback}`);
        usedAdd(usedClips, fallback);
        progress(jobContext, sceneIdx, 86, 'matcher:r2-any-fallback');
        jobContext._matcherCache.set(cacheKey, { path: fallback, type: 'video', score: 0 });
        return fallback; // R2 key
      }
    } else {
      console.warn('[5D][R2_FALLBACK] No R2 keys available for fallback.');
    }
  } catch (err) {
    console.error(`[5D][R2_FALLBACK][${jobId}][ERR]`, err);
  }

  console.error(`[5D][NO_MATCH][${jobId}] No match found for scene ${sceneIdx + 1}`);
  progress(jobContext, sceneIdx, 92, 'matcher:none');
  return null;
}

module.exports = { findClipForScene };
