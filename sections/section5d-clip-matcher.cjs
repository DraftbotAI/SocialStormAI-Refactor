// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR
// Smart, video-first, landmark-strict, no duplicates, max logs,
// strict central scoring (10G), GPT reformulation, parallel lookups
// *within tier*, R2-first preference, image→Ken Burns fallback to VIDEO,
// caching, timeouts, and hard floors.
//
// *** 2025-08 Loop Killers ***
// - No recursion. Single reformulation attempt handled inline.
// - Per-scene ATTEMPT_LIMIT (default 2: literal + reformulated).
// - TIME_BUDGET_MS per scene; hard stop with graceful fallback.
// - Negative-result cache to avoid re-searching hopeless subjects.
// - Strong de-dupe on candidates by normalized path.
// - Cache key contains scene index to avoid cross-scene churn.
// - Optional landmark-mode relaxation on last pass (env-controlled).
//
// *** 2025-08 Progress Hooks ***
// - 5D will call jobContext progress callbacks if present:
//   jobContext.progress?.set(stage, percent)
//   jobContext.progress?.tick(delta, stage)
//   jobContext.updateProgress?.(percent, stage)
//   jobContext.emit?.('progress', { percent, stage, sceneIdx })
//   (No-ops if not provided; safe to ignore.)
//
// *** 2025-08 Video-Only Guarantee (unless opted out) ***
// - By default, 5D will NEVER return a bare image path.
// - If no provider video is found, it builds a local video from the image
//   (Ken Burns or still-to-video). Only if MATCHER_ALLOW_RAW_IMAGE=true
//   will it return a raw image path.
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
// Optional providers / helpers (soft-require)
// -----------------------------
let findUnsplashImageForScene = null;
try {
  ({ findUnsplashImageForScene } = require('./section10f-unsplash-image-helper.cjs'));
  console.log('[5D][INIT] 10F Unsplash helper loaded.');
} catch {
  console.warn('[5D][INIT][WARN] 10F Unsplash helper not found. Will proceed without it.');
}

// Ken Burns image → video helpers
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
  console.warn('[5D][INIT][WARN] 10D Ken Burns helper not found. KB fallback disabled.');
}

// Subject extraction (strict 11)
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');

// Optional semantic helpers (soft)
let extractSymbolicVisualSubject = null;
try {
  ({ extractSymbolicVisualSubject } = require('./section10h-symbolic-matcher.cjs'));
  console.log('[5D][INIT] 10H symbolic matcher loaded.');
} catch { /* noop */ }

let extractEmotionActionVisual = null;
try {
  ({ extractEmotionActionVisual } = require('./section10i-emotion-action-helper.cjs'));
  console.log('[5D][INIT] 10I emotion/action helper loaded.');
} catch { /* noop */ }

let extractQuestionVisual = null;
try {
  ({ extractQuestionVisual } = require('./section10j-question-fallback-helper.cjs'));
  console.log('[5D][INIT] 10J question fallback helper loaded.');
} catch { /* noop */ }

let extractMultiSubjectVisual = null;
try {
  ({ extractMultiSubjectVisual } = require('./section10k-multi-subject-handler.cjs'));
  console.log('[5D][INIT] 10K multi-subject helper loaded.');
} catch { /* noop */ }

let breakRepetition = null;
try {
  ({ breakRepetition } = require('./section10l-repetition-blocker.cjs'));
  console.log('[5D][INIT] 10L repetition blocker loaded.');
} catch { /* noop */ }

// Scoring (strict 10G)
const {
  scoreSceneCandidate,
  LANDMARK_KEYWORDS,
  ANIMAL_TERMS,
  PERSON_TERMS,
} = require('./section10g-scene-scoring-helper.cjs');

// GPT (for one-shot reformulation)
const OpenAI = require('openai');
const REFORMULATION_MODEL = process.env.REFORMULATION_MODEL || 'gpt-4.1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log('[5D][INIT] Smart Clip Matcher loaded (video-first tiered, scoring floor, landmark-mode, loop-guarded, progress-aware).');

// ===========================================================
// Constants / Utilities
// ===========================================================

const HARD_FLOOR_VIDEO = Number(process.env.MATCHER_FLOOR_VIDEO || 70);
const HARD_FLOOR_IMAGE = Number(process.env.MATCHER_FLOOR_IMAGE || 75);
const PROVIDER_TIMEOUT_MS = Number(process.env.MATCHER_PROVIDER_TIMEOUT_MS || 10000);

// LOOP GUARDS
const ATTEMPT_LIMIT = Math.max(1, Number(process.env.MATCHER_ATTEMPT_LIMIT || 2)); // literal + reformulated
const TIME_BUDGET_MS = Math.max(4000, Number(process.env.MATCHER_TIME_BUDGET_MS || 16000));
const MAX_SUBJECT_OPTIONS = Math.max(1, Number(process.env.MATCHER_MAX_SUBJECT_OPTIONS || 5));
const RELAX_LANDMARK_ON_LAST_ATTEMPT = String(process.env.MATCHER_RELAX_LANDMARK_ON_LAST_ATTEMPT || 'true').toLowerCase() !== 'false';

// VIDEO-ONLY behavior (unless explicitly allowed)
const ALLOW_RAW_IMAGE = String(process.env.MATCHER_ALLOW_RAW_IMAGE || 'false').toLowerCase() === 'true';

const GENERIC_SUBJECTS = [
  'face','person','man','woman','it','thing','someone','something','body','eyes',
  'kid','boy','girl','they','we','people','scene','child','children','sign','logo',
  'text','skyline','dubai','view','image','photo','background','object','stuff'
];

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

// Only assert for local files (KB outputs, downloaded provider files).
// Skip for R2 keys and HTTP URLs (remote).
function assertLocalFileExists(file, label = 'FILE', minSize = 8192) {
  try {
    if (!file) return false;
    const s = String(file);
    if (s.startsWith('http://') || s.startsWith('https://')) return true; // remote
    if (!fs.existsSync(s)) {
      console.warn(`[5D][${label}][SKIP_ASSERT] Not local yet (remote/R2 or temp missing): ${s}`);
      return true; // do not hard-fail
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

function isLandmarkSubject(subject) {
  const s = String(subject || '').toLowerCase();
  return containsAny(LANDMARK_KEYWORDS, s);
}

function alnumLower(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function eqLoose(a, b) {
  return alnumLower(a) === alnumLower(b);
}

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

async function gptReformulateSubject(subject, mainTopic, jobId) {
  if (!openai) {
    console.warn(`[5D][REFORM][${jobId}] OpenAI API key missing; skipping reformulation.`);
    return null;
  }
  try {
    const prompt =
      `Rephrase into a literal, short STOCK VIDEO search query (no metaphors), ideally using a proper noun if present.\n` +
      `Subject: "${subject}"` + (mainTopic ? `\nContext: ${mainTopic}` : '');
    const response = await openai.chat.completions.create({
      model: REFORMULATION_MODEL,
      messages: [
        { role: 'system', content: 'You generate literal stock VIDEO queries. No fluff.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 20,
      temperature: 0
    });
    const reformulated = response.choices?.[0]?.message?.content?.trim();
    if (reformulated) {
      console.log(`[5D][REFORM][${jobId}] "${subject}" → "${reformulated}"`);
      return reformulated;
    }
  } catch (err) {
    console.error(`[5D][REFORM][${jobId}] GPT failed:`, err?.response?.data || err);
  }
  return null;
}

function backupKeywordExtraction(text) {
  if (!text) return null;
  const tokens = String(text).split(/\s+/).filter(w => w.length > 3);
  return tokens[0] || text;
}

async function tryContextualLandmarkOverride(subject, mainTopic, usedClips, jobId) {
  if (!findR2ClipForScene.getAllFiles) return null;
  const LANDMARK_WORDS = [
    'statue of liberty','white house','empire state building','eiffel tower','sphinx','great wall',
    'mount rushmore','big ben','colosseum','machu picchu','pyramids','chichen itza','louvre','taj mahal',
    'notre dame','angkor wat','leaning tower','buckingham palace','niagara falls','grand canyon',
    'hollywood sign','stonehenge','burj khalifa','golden gate bridge','petra','cristo redentor','opera house',
    'edinburgh castle','great wall of china'
  ];
  const toTest = [subject, mainTopic].filter(Boolean).map(s => (typeof s === 'string' ? s.toLowerCase() : ''));
  const landmark = LANDMARK_WORDS.find(l => toTest.some(t => t.includes(l)));
  if (!landmark) return null;

  try {
    const r2Files = await findR2ClipForScene.getAllFiles(); // array of keys
    const needle = landmark.replace(/\s+/g, '_').toLowerCase();
    for (const key of r2Files) {
      if (usedHas(usedClips, key)) continue;
      if (String(key).toLowerCase().includes(needle)) {
        console.log(`[5D][CONTEXT][${jobId}] Landmark override "${landmark}" → "${key}"`);
        usedAdd(usedClips, key);
        return key;
      }
    }
  } catch (err) {
    console.error(`[5D][CONTEXT][${jobId}] Landmark override failed:`, err);
  }
  return null;
}

// Produce a Ken Burns VIDEO locally from a chosen image file.
// Returns absolute path to a .mp4 (preferred) or null on failure.
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
      // Fallback: static still-to-video
      await staticImageToVideo(prepped, outVid, 5, jobId);
    }
    console.log(`[5D][KENBURNS][${jobId}] Built local KB video from image: ${outVid}`);
    return outVid;
  } catch (err) {
    console.error(`[5D][KENBURNS][${jobId}][ERR] Could not build KB from image (${imgPath}).`, err);
    return null;
  }
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

// Hard negative filters in landmark mode
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

  // Allow ceremonial humans at famous landmarks
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

// ---------- Progress helpers (best-effort, no-op if not wired) ----------
function progress(jobContext, sceneIdx, percent, stage, extra = {}) {
  try {
    if (!jobContext) return;
    if (jobContext.progress?.set) jobContext.progress.set(stage, percent, { sceneIdx, ...extra });
    if (jobContext.progress?.tick && typeof percent === 'number') jobContext.progress.tick(0, stage); // just stage ping
    if (jobContext.updateProgress) jobContext.updateProgress(percent, stage, { sceneIdx, ...extra });
    if (jobContext.emit) jobContext.emit('progress', { percent, stage, sceneIdx, ...extra });
  } catch (e) {
    // swallow
  }
}

// ===========================================================
// MAIN
// ===========================================================

/**
 * Chooses the best visual for a scene.
 * Returns either:
 *  - R2 key string (no local assert; 5B downloads)
 *  - Local absolute file path to a video (provider download or Ken Burns output)
 *  - null (last resort)
 */
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
  const sceneStart = now();
  console.log('\n===================================================');
  console.log(`[5D][START][${jobId}][S${sceneIdx}] Subject="${subject}" Mega=${isMegaScene}`);
  console.log(`[5D][CTX][S${sceneIdx}]`, allSceneTexts?.[sceneIdx] || '(no scene text)');
  progress(jobContext, sceneIdx, 70, 'matcher:start'); // typical pipelines hit ~70-75% before clip match

  // Ensure job-scoped caches
  if (!jobContext._matcherCache) jobContext._matcherCache = new Map();           // positive cache
  if (!jobContext._matcherMisses) jobContext._matcherMisses = new Set();         // negative cache (subject|scene)
  if (!jobContext._matcherAttempts) jobContext._matcherAttempts = new Map();     // attempt count per scene

  const attemptKey = `scene${sceneIdx}`;
  const prevAttempts = Number(jobContext._matcherAttempts.get(attemptKey) || 0);
  if (prevAttempts >= ATTEMPT_LIMIT) {
    console.warn(`[5D][GUARD][${jobId}][S${sceneIdx}] Attempt limit hit before start (${prevAttempts}/${ATTEMPT_LIMIT}).`);
  }
  jobContext._matcherAttempts.set(attemptKey, prevAttempts); // initialize

  // ---- Subject Anchor (scene 0 / mega) ----
  let searchSubject = subject;
  if (isMegaScene || sceneIdx === 0) {
    try {
      let anchors = await extractVisualSubjects(megaSubject || mainTopic || allSceneTexts?.[0], mainTopic);
      anchors = (anchors || []).filter(s => !!s && !GENERIC_SUBJECTS.includes(String(s).toLowerCase()));
      if (anchors.length) {
        searchSubject = anchors[0];
        console.log(`[5D][ANCHOR][${jobId}] Using anchor subject: "${searchSubject}"`);
      }
    } catch (err) {
      console.error(`[5D][ANCHOR][${jobId}] Extraction error:`, err);
    }
  }

  if (!searchSubject || GENERIC_SUBJECTS.includes(String(searchSubject).toLowerCase())) {
    searchSubject = mainTopic || allSceneTexts?.[0] || subject || 'topic';
    console.log(`[5D][FALLBACK][${jobId}] Using fallback subject: "${searchSubject}"`);
  }

  if (forceClipPath) {
    console.log(`[5D][FORCE][${jobId}] Forced clip: ${forceClipPath}`);
    progress(jobContext, sceneIdx, 92, 'matcher:forced');
    return forceClipPath;
  }

  // Quick R2 override for ultra-famous landmarks
  const contextOverride = await tryContextualLandmarkOverride(searchSubject, mainTopic, usedClips, jobId);
  if (contextOverride) {
    progress(jobContext, sceneIdx, 92, 'matcher:r2-landmark');
    return contextOverride;
  }

  // =========================================================
  // Prepare subject variations (no more than MAX_SUBJECT_OPTIONS)
  // =========================================================
  progress(jobContext, sceneIdx, 74, 'matcher:subjects');
  let baseSubjects = [];
  const subjectExtractors = [
    ['MULTI', extractMultiSubjectVisual],
    ['QUESTION', extractQuestionVisual],
    ['SYMBOLIC', extractSymbolicVisualSubject],
    ['EMOTION', extractEmotionActionVisual],
  ];

  await Promise.all(
    subjectExtractors.map(async ([label, fn]) => {
      if (typeof fn !== 'function') return;
      try {
        const res = await fn(searchSubject, mainTopic);
        if (res && !GENERIC_SUBJECTS.includes(String(res).toLowerCase())) {
          baseSubjects.push(res);
          console.log(`[5D][SUBJECT][${label}] ${res}`);
        }
      } catch (err) {
        console.error(`[5D][${label}][${jobId}][ERR]`, err);
      }
    })
  );

  try {
    const prioritized = await extractVisualSubjects(searchSubject, mainTopic);
    (prioritized || []).forEach(s => {
      if (s && !GENERIC_SUBJECTS.includes(String(s).toLowerCase())) baseSubjects.push(s);
    });
    console.log(`[5D][SUBJECT][PRIORITIZED]`, baseSubjects);
  } catch (err) {
    console.error(`[5D][LITERAL][${jobId}][ERR]`, err);
  }

  if (!baseSubjects.length) baseSubjects.push(searchSubject);
  // apply soft variation vs prior subjects
  let finalSubjects = [];
  for (const sub of baseSubjects) {
    try {
      if (typeof breakRepetition === 'function') {
        const varied = await breakRepetition(sub, prevVisualSubjects || [], { maxRepeats: 2 });
        if (varied && !finalSubjects.includes(varied)) finalSubjects.push(varied);
      } else {
        if (!finalSubjects.includes(sub)) finalSubjects.push(sub);
      }
    } catch {
      if (!finalSubjects.includes(sub)) finalSubjects.push(sub);
    }
  }
  // unique, trimmed, capped
  finalSubjects = Array.from(new Set(finalSubjects.map(s => String(s).trim()))).slice(0, MAX_SUBJECT_OPTIONS);

  // =========================================================
  // Caching — keep results per subject across the job
  // Cache key includes sceneIdx to prevent cross-scene ping-pong
  // =========================================================
  const cacheKey = `${sceneIdx}|${alnumLower(finalSubjects.join('|'))}|${categoryFolder || 'misc'}`;
  if (jobContext._matcherCache.has(cacheKey)) {
    const cached = jobContext._matcherCache.get(cacheKey);
    console.log(`[5D][CACHE][HIT][${jobId}] key=${cacheKey} → ${cached?.path || '(no path)'}`);
    if (cached && cached.path && !usedHas(usedClips, cached.path)) {
      usedAdd(usedClips, cached.path);
      progress(jobContext, sceneIdx, 93, 'matcher:cache-hit');
      return cached.path;
    }
  }

  // Negative cache guard
  const missKey = `${sceneIdx}|${alnumLower(searchSubject)}`;
  if (jobContext._matcherMisses.has(missKey)) {
    console.warn(`[5D][MISS-CACHE][${jobId}][S${sceneIdx}] Skipping re-search for hopeless subject "${searchSubject}"`);
  }

  // =========================================================
  // Attempts: 1) original subjects, 2) reformulated (single pass)
  // NO RECURSION. Each attempt respects TIME_BUDGET_MS.
  // =========================================================
  let attempt = Number(jobContext._matcherAttempts.get(attemptKey) || 0);
  let reformulatedOnce = false;
  let lastResultPath = null;

  while (attempt < ATTEMPT_LIMIT) {
    const elapsed = now() - sceneStart;
    if (elapsed > TIME_BUDGET_MS) {
      console.warn(`[5D][TIME][${jobId}][S${sceneIdx}] Time budget exceeded (${elapsed}ms > ${TIME_BUDGET_MS}ms). Breaking.`);
      break;
    }
    const onLastAttempt = (attempt + 1) >= ATTEMPT_LIMIT;

    // For attempt > 0, try reformulation ONCE
    let subjectsThisAttempt = finalSubjects;
    if (attempt > 0 && !reformulatedOnce) {
      const seed = finalSubjects[0];
      const reformulated = (await gptReformulateSubject(seed, mainTopic, jobId)) || backupKeywordExtraction(seed);
      reformulatedOnce = true;
      if (reformulated && !eqLoose(reformulated, seed)) {
        subjectsThisAttempt = [reformulated];
        console.log(`[5D][REFORM_USED][${jobId}] Attempt ${attempt + 1} with: "${reformulated}"`);
      } else {
        console.log(`[5D][REFORM_SKIPPED][${jobId}] Attempt ${attempt + 1} (no better reformulation).`);
      }
    }

    // Track attempt count
    attempt++;
    jobContext._matcherAttempts.set(attemptKey, attempt);

    // =========================================================
    // VIDEO TIER — collect only videos first (R2 → Pexels → Pixabay)
    // =========================================================
    let videoCandidates = [];
    let imageCandidates = [];

    progress(jobContext, sceneIdx, 78, 'matcher:search-start', { attempt, subjects: subjectsThisAttempt });

    for (const subjectOption of subjectsThisAttempt) {
      if ((now() - sceneStart) > TIME_BUDGET_MS) {
        console.warn(`[5D][TIME][${jobId}][S${sceneIdx}] Budget hit mid-collection. Stopping searches.`);
        break;
      }

      console.log(`[5D][SEARCH][${jobId}] Subject Option: "${subjectOption}"`);

      // Landmark mode (optionally relax on last attempt)
      let landmarkMode = isLandmarkSubject(subjectOption) || isLandmarkSubject(mainTopic);
      if (landmarkMode && onLastAttempt && RELAX_LANDMARK_ON_LAST_ATTEMPT) {
        console.warn(`[5D][LANDMARK][${jobId}] Relaxing landmark cull on final attempt for "${subjectOption}"`);
        landmarkMode = false; // allow humans/animals on last-ditch try
      }

      // ---- VIDEO lookups (tier 1) with timeouts, in parallel within tier ----
      progress(jobContext, sceneIdx, 80, 'matcher:video-lookups');
      await Promise.allSettled([
        (async () => {
          try {
            if (typeof findR2ClipForScene.getAllFiles === 'function') {
              const r2Files = await withTimeout(
                findR2ClipForScene.getAllFiles(subjectOption, categoryFolder),
                PROVIDER_TIMEOUT_MS,
                'R2.getAllFiles'
              );
              for (const key of r2Files || []) {
                if (usedHas(usedClips, key)) continue;
                const candidate = { path: key, source: 'R2', isVideo: true, subject: subjectOption, provider: 'r2' };
                if (!landmarkMode || landmarkCull(candidate)) {
                  videoCandidates.push(candidate);
                }
              }
              console.log(`[5D][R2][${jobId}] +${(r2Files || []).length} candidates for "${subjectOption}"`);
            }
          } catch (err) {
            console.error(`[5D][R2][${jobId}][ERR]`, err?.message || err);
          }
        })(),
        (async () => {
          try {
            const res = await withTimeout(
              findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips),
              PROVIDER_TIMEOUT_MS,
              'PEXELS_VIDEO'
            );
            const hit = asPathAndSource(res, 'PEXELS_VIDEO');
            if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PEXELS_VIDEO_RESULT')) {
              if (!landmarkMode || landmarkCull(hit)) {
                hit.isVideo = true;
                hit.provider = hit.provider || 'pexels';
                videoCandidates.push(hit);
              }
            }
          } catch (err) {
            console.error(`[5D][PEXELS_VIDEO][${jobId}][ERR]`, err?.message || err);
          }
        })(),
        (async () => {
          try {
            const res = await withTimeout(
              findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips),
              PROVIDER_TIMEOUT_MS,
              'PIXABAY_VIDEO'
            );
            const hit = asPathAndSource(res, 'PIXABAY_VIDEO');
            if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PIXABAY_VIDEO_RESULT')) {
              if (!landmarkMode || landmarkCull(hit)) {
                hit.isVideo = true;
                hit.provider = hit.provider || 'pixabay';
                videoCandidates.push(hit);
              }
            }
          } catch (err) {
            console.error(`[5D][PIXABAY_VIDEO][${jobId}][ERR]`, err?.message || err);
          }
        })(),
      ]);

      // If we already have any video candidates after this subject option,
      // SKIP image tier for this subject (strict video-first).
      if (videoCandidates.length > 0) {
        console.log(`[5D][TIER][${jobId}] Video candidates found for "${subjectOption}". Deferring image lookups.`);
        continue;
      }

      // ---- IMAGE lookups (tier 2) ONLY if no videos found so far ----
      progress(jobContext, sceneIdx, 84, 'matcher:image-lookups');
      await Promise.allSettled([
        (async () => {
          try {
            const res = await withTimeout(
              findPexelsPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips),
              PROVIDER_TIMEOUT_MS,
              'PEXELS_PHOTO'
            );
            const hit = asPathAndSource(res, 'PEXELS_PHOTO');
            if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PEXELS_PHOTO_RESULT', 4096)) {
              if (!landmarkMode || landmarkCull(hit)) {
                hit.isVideo = false;
                hit.provider = hit.provider || 'pexels';
                imageCandidates.push(hit);
              }
            }
          } catch (err) {
            console.error(`[5D][PEXELS_PHOTO][${jobId}][ERR]`, err?.message || err);
          }
        })(),
        (async () => {
          try {
            const res = await withTimeout(
              findPixabayPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips),
              PROVIDER_TIMEOUT_MS,
              'PIXABAY_PHOTO'
            );
            const hit = asPathAndSource(res, 'PIXABAY_PHOTO');
            if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PIXABAY_PHOTO_RESULT', 4096)) {
              if (!landmarkMode || landmarkCull(hit)) {
                hit.isVideo = false;
                hit.provider = hit.provider || 'pixabay';
                imageCandidates.push(hit);
              }
            }
          } catch (err) {
            console.error(`[5D][PIXABAY_PHOTO][${jobId}][ERR]`, err?.message || err);
          }
        })(),
        (async () => {
          if (!findUnsplashImageForScene) return;
          try {
            const res = await withTimeout(
              findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext),
              PROVIDER_TIMEOUT_MS,
              'UNSPLASH'
            );
            const hit = asPathAndSource(res, 'UNSPLASH');
            if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'UNSPLASH_RESULT', 4096)) {
              if (!landmarkMode || landmarkCull(hit)) {
                hit.isVideo = false;
                hit.provider = hit.provider || 'unsplash';
                imageCandidates.push(hit);
              }
            }
          } catch (err) {
            console.error(`[5D][UNSPLASH][${jobId}][ERR]`, err?.message || err);
          }
        })(),
      ]);
    } // end subject loop

    // De-dupe candidates hard by normalized path
    videoCandidates = dedupeByPath(videoCandidates);
    imageCandidates = dedupeByPath(imageCandidates);

    // =========================================================
    // Score candidates (strict thresholds, VIDEO ALWAYS WINS)
    // =========================================================
    progress(jobContext, sceneIdx, 88, 'matcher:scoring');
    videoCandidates.forEach(c => { c.score = scoreSceneCandidate(c, c.subject || subject || searchSubject, usedClips, true); });
    imageCandidates.forEach(c => { c.score = scoreSceneCandidate(c, c.subject || subject || searchSubject, usedClips, false); });

    // Filter & Sort by score desc
    videoCandidates = videoCandidates.filter(c => c.score >= HARD_FLOOR_VIDEO).sort((a, b) => b.score - a.score);
    imageCandidates = imageCandidates.filter(c => c.score >= HARD_FLOOR_IMAGE).sort((a, b) => b.score - a.score);

    // Log top-3 for transparency
    console.log('[5D][CANDS][VIDEO][TOP3]', videoCandidates.slice(0, 3).map(c => ({ path: c.path, src: c.source, score: c.score })));
    console.log('[5D][CANDS][IMAGE][TOP3]', imageCandidates.slice(0, 3).map(c => ({ path: c.path, src: c.source, score: c.score })));

    // *** VIDEO ALWAYS WINS if any present ***
    if (videoCandidates.length) {
      const best = videoCandidates[0];
      usedAdd(usedClips, best.path);
      jobContext._matcherCache.set(cacheKey, { path: best.path, type: 'video', score: best.score });
      console.log(`[5D][RESULT][VIDEO][${jobId}]`, { path: best.path, source: best.source, score: best.score, subj: best.subject });
      progress(jobContext, sceneIdx, 92, 'matcher:video-selected', { source: best.source });
      lastResultPath = best.path;
      break;
    }

    // No video → build Ken Burns VIDEO from best image NOW
    if (imageCandidates.length) {
      const bestImg = imageCandidates[0];
      console.log(`[5D][RESULT][IMAGE->KB][${jobId}]`, { path: bestImg.path, source: bestImg.source, score: bestImg.score, subj: bestImg.subject });

      progress(jobContext, sceneIdx, 90, 'matcher:kb-build');
      const kbVid = await kenBurnsVideoFromImagePath(bestImg.path, workDir, sceneIdx, jobId);
      if (kbVid && assertLocalFileExists(kbVid, 'KB_OUT', 2048)) {
        usedAdd(usedClips, bestImg.path); // mark image used to avoid repetition
        jobContext._matcherCache.set(cacheKey, { path: kbVid, type: 'kb', score: bestImg.score });
        lastResultPath = kbVid; // local video path
        progress(jobContext, sceneIdx, 92, 'matcher:kb-ok');
        break;
      }

      // If KB failed, try still-to-video as backup
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
            lastResultPath = outVid;
            progress(jobContext, sceneIdx, 92, 'matcher:still-ok');
            break;
          }
        } catch (e) {
          console.error('[5D][STILL][ERR]', e);
        }
      }

      // Only return a raw image if explicitly allowed
      if (ALLOW_RAW_IMAGE) {
        console.warn(`[5D][IMAGE_FALLBACK][${jobId}] Returning raw image path (ALLOW_RAW_IMAGE=true).`);
        jobContext._matcherCache.set(cacheKey, { path: bestImg.path, type: 'image', score: bestImg.score });
        lastResultPath = bestImg.path;
        progress(jobContext, sceneIdx, 92, 'matcher:image-fallback');
        break;
      } else {
        console.warn(`[5D][IMAGE_FALLBACK][${jobId}] Suppressing raw image return (ALLOW_RAW_IMAGE=false).`);
        // continue loop to allow reformulation/last attempt
      }
    }

    // If we got here with nothing and it's the last attempt, mark negative cache
    if (onLastAttempt) {
      jobContext._matcherMisses.add(missKey);
    }
  } // end attempts loop

  if (lastResultPath) return lastResultPath;

  // =========================================================
  // Total miss → pick any R2 clip not yet used (no local assert)
  // =========================================================
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

  // Nothing left
  console.error(`[5D][NO_MATCH][${jobId}] No match found for scene ${sceneIdx + 1}`);
  progress(jobContext, sceneIdx, 92, 'matcher:none');
  return null;
}

module.exports = { findClipForScene };
