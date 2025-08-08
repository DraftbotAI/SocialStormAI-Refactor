// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Canonicals + Staged Queries + Scene Directives)
// Smart, video-first, entity-strict, no duplicates, max logs.
// Central scoring (10G). Uses 10M to normalize subjects and
// build staged search queries: Feature/Action → Canonical → Synonyms.
// Supports manual scene directives (options / mustShow / overrideSubject / overrideFeature / alternates / forceClip).
// R2-first, then Pexels/Pixabay; image→Ken Burns → still-to-video fallback.
//
// *** 2025-08 Loop Killers ***
// - No recursion. One optional GPT reformulation attempt.
// - Per-scene ATTEMPT_LIMIT (default 2: canonical + reformulated).
// - TIME_BUDGET_MS per scene; hard stop with graceful fallback.
// - Negative-result cache to avoid re-searching hopeless subjects.
// - Strong de-dupe on candidates by normalized path.
// - Cache key contains scene index to avoid cross-scene churn.
//
// *** 2025-08 Video-Only Guarantee (unless opted out) ***
// - By default, never returns a raw image path. It creates a local video.
//   Set MATCHER_ALLOW_RAW_IMAGE=true to allow raw image returns.
//
// *** Progress Hooks ***
// - jobContext.progress?.set(stage, percent)
// - jobContext.progress?.tick(delta, stage)
// - jobContext.updateProgress?.(percent, stage)
// - jobContext.emit?.('progress', { percent, stage, sceneIdx })
// ===========================================================

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// -----------------------------
// Canonical Subjects (10M)
// -----------------------------
const {
  resolveCanonicalSubject,
  getQueryStagesForSubject,
  getEntityMetadata,
  isSameCanonical,
} = require('./section10m-canonical-subjects.cjs');

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
  console.warn('[5D][INIT][WARN] 10F Unsplash helper not found. Proceeding without it.');
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

// Strict visual subject extractor (11)
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

// Scoring (10G)
const {
  scoreSceneCandidate,
  LANDMARK_KEYWORDS,
  ANIMAL_TERMS,
  PERSON_TERMS,
} = require('./section10g-scene-scoring-helper.cjs');

// GPT (optional, one-shot reformulation)
const OpenAI = require('openai');
const REFORMULATION_MODEL = process.env.REFORMULATION_MODEL || 'gpt-4.1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log('[5D][INIT] Clip Matcher loaded (10M canonicals, staged queries, manual directives, video-first, hard floors, loop-guarded, progress-aware).');

// ===========================================================
// Constants / Utilities
// ===========================================================

const HARD_FLOOR_VIDEO = Number(process.env.MATCHER_FLOOR_VIDEO || 92);
const HARD_FLOOR_IMAGE = Number(process.env.MATCHER_FLOOR_IMAGE || 88);
const PROVIDER_TIMEOUT_MS = Number(process.env.MATCHER_PROVIDER_TIMEOUT_MS || 10000);

const ATTEMPT_LIMIT = Math.max(1, Number(process.env.MATCHER_ATTEMPT_LIMIT || 2)); // canonical + reformulated
const TIME_BUDGET_MS = Math.max(4000, Number(process.env.MATCHER_TIME_BUDGET_MS || 16000));
const MAX_SUBJECT_OPTIONS = Math.max(1, Number(process.env.MATCHER_MAX_SUBJECT_OPTIONS || 5));

const ALLOW_RAW_IMAGE = String(process.env.MATCHER_ALLOW_RAW_IMAGE || 'false').toLowerCase() === 'true';

const GENERIC_SUBJECTS = [
  'face','person','man','woman','it','thing','someone','something','body','eyes',
  'kid','boy','girl','they','we','people','scene','child','children','sign','logo',
  'text','skyline','view','image','photo','background','object','stuff'
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
// GPT one-shot reformulation (optional)
// ===========================================================
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

// ===========================================================
// Manual Directive Utilities
// ===========================================================
function pickSceneDirective(sceneIdx, jobContext) {
  // Accept from multiple places for flexibility
  const pools = [
    jobContext?.sceneDirectives,
    jobContext?.payload?.sceneDirectives,
    jobContext?.overrides?.sceneDirectives,
    jobContext?.sceneOverrides,
  ].filter(Boolean);

  for (const pool of pools) {
    const hit = Array.isArray(pool)
      ? pool.find(x => Number(x?.sceneIdx) === Number(sceneIdx))
      : (pool && pool[sceneIdx]); // map form
    if (hit) return hit;
  }
  return null;
}

function buildOverrideStageFromDirective(directive) {
  // Priority: explicit options[] (ordered), else (mustShow + feature + alternates)
  const terms = [];
  if (Array.isArray(directive?.options) && directive.options.length) {
    directive.options.forEach(t => t && terms.push(String(t)));
  } else {
    const must = directive?.mustShow || directive?.overrideSubject;
    const feat = directive?.overrideFeature || directive?.feature;
    const alts = Array.isArray(directive?.alternates) ? directive.alternates : [];
    if (must && feat) terms.push(`${must} ${feat}`);
    if (must) terms.push(String(must));
    if (feat) terms.push(String(feat));
    alts.forEach(a => a && terms.push(String(a)));
  }
  const cleaned = Array.from(new Set(terms.map(t => String(t).trim()).filter(Boolean)));
  if (!cleaned.length) return null;
  return { stage: 'OVERRIDE', terms: cleaned };
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
  progress(jobContext, sceneIdx, 70, 'matcher:start');

  // Ensure job-scoped caches
  if (!jobContext._matcherCache) jobContext._matcherCache = new Map();           // positive cache
  if (!jobContext._matcherMisses) jobContext._matcherMisses = new Set();         // negative cache (subject|scene)
  if (!jobContext._matcherAttempts) jobContext._matcherAttempts = new Map();     // attempt count per scene

  const attemptKey = `scene${sceneIdx}`;
  const prevAttempts = Number(jobContext._matcherAttempts.get(attemptKey) || 0);
  jobContext._matcherAttempts.set(attemptKey, prevAttempts);

  // ---- Forced clip short-circuit ----
  const directive = pickSceneDirective(sceneIdx, jobContext);
  if (forceClipPath || (directive && directive.forceClip)) {
    const forced = forceClipPath || directive.forceClip;
    console.log(`[5D][FORCE][${jobId}] Forced clip: ${forced}`);
    progress(jobContext, sceneIdx, 92, 'matcher:forced');
    return forced;
  }

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

  // =========================================================
  // Canonical normalization & staged query generation (10M)
  // + Manual Directive Stage (if provided)
  // =========================================================
  const strictExtract = await normalizeWith10M(
    directive?.overrideSubject || directive?.mustShow || searchSubject,
    mainTopic,
    prevVisualSubjects
  );

  let queryStages = getQueryStagesForSubject({
    ...strictExtract,
    // gently incorporate directive feature/alternates into 10M seed
    featureOrAction: directive?.overrideFeature || directive?.feature || strictExtract?.featureOrAction || '',
    // alternates handled by normalizeWith10M/10M internally
  });

  const overrideStage = buildOverrideStageFromDirective(directive || {});
  if (overrideStage) {
    // OVERRIDE runs first, and preserves the given order strictly
    queryStages = [overrideStage, ...queryStages];
    console.log('[5D][DIRECTIVES][OVERRIDE_STAGE]', overrideStage);
  }

  console.log('[5D][10M][RESOLVED]', strictExtract);
  console.log('[5D][10M][STAGES]', queryStages);

  // Caching key (scene-scoped to avoid cross-scene churn)
  const cacheKey = `${sceneIdx}|${normKey(JSON.stringify(queryStages))}|${categoryFolder || 'misc'}`;
  if (jobContext._matcherCache.has(cacheKey)) {
    const cached = jobContext._matcherCache.get(cacheKey);
    console.log(`[5D][CACHE][HIT][${jobId}] key=${cacheKey} → ${cached?.path || '(no path)'}`);
    if (cached && cached.path && !usedHas(usedClips, cached.path)) {
      usedAdd(usedClips, cached.path);
      progress(jobContext, sceneIdx, 93, 'matcher:cache-hit');
      return cached.path;
    }
  }

  const missKey = `${sceneIdx}|${normKey(JSON.stringify(strictExtract))}`;
  if (jobContext._matcherMisses.has(missKey)) {
    console.warn(`[5D][MISS-CACHE][${jobId}][S${sceneIdx}] Skipping re-search for hopeless subject "${strictExtract?.canonical}"`);
  }

  // =========================================================
  // Attempts: 1) canonical/override, 2) optional GPT reformulation (single pass)
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

    // For attempt > 0, try reformulation ONCE (layered atop canonical)
    let stagesThisAttempt = queryStages;
    if (attempt > 0 && !reformulatedOnce) {
      const seed =
        (overrideStage?.terms?.[0]) ||
        (queryStages?.[0]?.terms?.[0]) ||
        strictExtract?.canonical ||
        String(searchSubject || '');
      const reformulated = (await gptReformulateSubject(seed, mainTopic, jobId)) || backupKeywordExtraction(seed);
      reformulatedOnce = true;
      if (reformulated && reformulated.trim().length > 0) {
        const altExtract = await normalizeWith10M(reformulated, mainTopic, prevVisualSubjects);
        const altStages = getQueryStagesForSubject(altExtract);
        // Keep any override stage, then use alt stages (A/B/C)
        stagesThisAttempt = overrideStage ? [overrideStage, ...altStages] : altStages;
        console.log(`[5D][REFORM_USED][${jobId}] Attempt ${attempt + 1} with: "${reformulated}"`);
        console.log('[5D][REFORM_STAGES]', stagesThisAttempt);
      } else {
        console.log(`[5D][REFORM_SKIPPED][${jobId}] Attempt ${attempt + 1} (no better reformulation).`);
      }
    }

    attempt++;
    jobContext._matcherAttempts.set(attemptKey, attempt);

    // =========================================================
    // Run staged search: OVERRIDE? → A (feature/action) → B (canonical) → C (synonyms)
    // Within each stage: R2 → Pexels → Pixabay (videos first), then images.
    // =========================================================
    const stageOrder = ['OVERRIDE', 'A', 'B', 'C'];
    for (const stage of stageOrder) {
      const stageObj = (stagesThisAttempt || []).find(s => s.stage === stage);
      const terms = (stageObj?.terms || []).slice(0, MAX_SUBJECT_OPTIONS);
      if (!terms.length) continue;

      const stageLabel = ({ OVERRIDE: 'override', A: 'feature', B: 'canonical', C: 'synonym' }[stage]) || 'stage';
      console.log(`[5D][STAGE][${jobId}] ${stage} (${stageLabel}) terms:`, terms);

      // Search for VIDEOS first
      let videoCandidates = [];
      for (const term of terms) {
        if ((now() - sceneStart) > TIME_BUDGET_MS) break;
        const landmarkMode = isLandmarkTokened(term) || isLandmarkTokened(mainTopic);

        progress(jobContext, sceneIdx, 80, `matcher:${stageLabel}-video`);
        const vids = await gatherVideoCandidates(term, workDir, sceneIdx, jobId, usedClips, landmarkMode, categoryFolder);
        videoCandidates.push(...vids);
      }

      // Score + filter + sort videos
      progress(jobContext, sceneIdx, 88, `matcher:${stageLabel}-score-video`);
      videoCandidates = dedupeByPath(videoCandidates).map(c => ({
        ...c,
        // *** improvement: pass entire strictExtract so 10G can leverage full 10M context ***
        score: scoreSceneCandidate(c, strictExtract || (subject || searchSubject), usedClips, true),
      })).filter(c => c.score >= HARD_FLOOR_VIDEO).sort((a, b) => b.score - a.score);

      console.log(`[5D][CANDS][VIDEO][${stage}] TOP3`, videoCandidates.slice(0, 3).map(c => ({ path: c.path, src: c.source, score: c.score })));

      if (videoCandidates.length) {
        const best = videoCandidates[0];
        usedAdd(usedClips, best.path);
        jobContext._matcherCache.set(cacheKey, { path: best.path, type: 'video', score: best.score });
        console.log(`[5D][RESULT][VIDEO][${jobId}]`, { path: best.path, source: best.source, score: best.score, stage });
        progress(jobContext, sceneIdx, 92, `matcher:${stageLabel}-video-selected`, { source: best.source });
        lastResultPath = best.path;
        break; // stop at first good video
      }

      // No videos → try IMAGES (only if time allows and still empty)
      let imageCandidates = [];
      for (const term of terms) {
        if ((now() - sceneStart) > TIME_BUDGET_MS) break;
        const landmarkMode = isLandmarkTokened(term) || isLandmarkTokened(mainTopic);

        progress(jobContext, sceneIdx, 84, `matcher:${stageLabel}-image`);
        const imgs = await gatherImageCandidates(term, workDir, sceneIdx, jobId, usedClips, landmarkMode);
        imageCandidates.push(...imgs);
      }

      progress(jobContext, sceneIdx, 88, `matcher:${stageLabel}-score-image`);
      imageCandidates = dedupeByPath(imageCandidates).map(c => ({
        ...c,
        // *** improvement: pass entire strictExtract so 10G can leverage full 10M context ***
        score: scoreSceneCandidate(c, strictExtract || (subject || searchSubject), usedClips, false),
      })).filter(c => c.score >= HARD_FLOOR_IMAGE).sort((a, b) => b.score - a.score);

      console.log(`[5D][CANDS][IMAGE][${stage}] TOP3`, imageCandidates.slice(0, 3).map(c => ({ path: c.path, src: c.source, score: c.score })));

      if (imageCandidates.length) {
        // Build KB video immediately (video-only guarantee)
        const bestImg = imageCandidates[0];
        console.log(`[5D][RESULT][IMAGE->KB][${jobId}]`, { path: bestImg.path, source: bestImg.source, score: bestImg.score, stage });
        progress(jobContext, sceneIdx, 90, `matcher:${stageLabel}-kb-build`);

        const kbVid = await kenBurnsVideoFromImagePath(bestImg.path, workDir, sceneIdx, jobId);
        if (kbVid && assertLocalFileExists(kbVid, 'KB_OUT', 2048)) {
          usedAdd(usedClips, bestImg.path);
          jobContext._matcherCache.set(cacheKey, { path: kbVid, type: 'kb', score: bestImg.score });
          lastResultPath = kbVid;
          progress(jobContext, sceneIdx, 92, `matcher:${stageLabel}-kb-ok`);
          break; // accept KB video and move on
        }

        // KB failed → still-to-video fallback
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
              progress(jobContext, sceneIdx, 92, `matcher:${stageLabel}-still-ok`);
              break;
            }
          } catch (e) {
            console.error('[5D][STILL][ERR]', e);
          }
        }

        if (ALLOW_RAW_IMAGE) {
          console.warn(`[5D][IMAGE_FALLBACK][${jobId}] Returning raw image path (ALLOW_RAW_IMAGE=true).`);
          jobContext._matcherCache.set(cacheKey, { path: bestImg.path, type: 'image', score: bestImg.score });
          lastResultPath = bestImg.path;
          progress(jobContext, sceneIdx, 92, `matcher:${stageLabel}-image-fallback`);
          break;
        } else {
          console.warn(`[5D][IMAGE_FALLBACK][${jobId}] Suppressing raw image return (ALLOW_RAW_IMAGE=false). Trying next stage or attempt.`);
        }
      }

      // If this stage produced a result, stop stages
      if (lastResultPath) break;
    } // end stage loop

    if (lastResultPath) break;

    // mark miss if last attempt
    const onLastAttempt = (attempt >= ATTEMPT_LIMIT);
    if (onLastAttempt) jobContext._matcherMisses.add(missKey);
  } // end attempts

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

  console.error(`[5D][NO_MATCH][${jobId}] No match found for scene ${sceneIdx + 1}`);
  progress(jobContext, sceneIdx, 92, 'matcher:none');
  return null;
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
  if (findUnsplashImageForScene) {
    try {
      const res = await withTimeout(
        findUnsplashImageForScene(term, workDir, sceneIdx, jobId, usedClips, {}),
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
    } catch (err) {
      console.error(`[5D][UNSPLASH][${jobId}][ERR]`, err?.message || err);
    }
  }

  return out;
}

// ===========================================================
// 10M Normalization glue
// ===========================================================
async function normalizeWith10M(subjectInput, mainTopic, prevVisualSubjects) {
  try {
    // Pull optional alt signals (symbolic/question/emotion/multi)
    const altCandidates = [];
    const softHelpers = [
      ['MULTI', extractMultiSubjectVisual],
      ['QUESTION', extractQuestionVisual],
      ['SYMBOLIC', extractSymbolicVisualSubject],
      ['EMOTION', extractEmotionActionVisual],
    ];
    await Promise.all(softHelpers.map(async ([label, fn]) => {
      if (typeof fn !== 'function') return;
      try {
        const res = await fn(subjectInput, mainTopic);
        if (res && !GENERIC_SUBJECTS.includes(String(res).toLowerCase())) {
          altCandidates.push(res);
          console.log(`[5D][SUBJECT][${label}]`, res);
        }
      } catch (err) {
        console.error(`[5D][${label}][ERR]`, err);
      }
    }));

    // Prioritized strict extractor from Section 11
    const prioritized = await extractVisualSubjects(subjectInput, mainTopic);
    const merged = [
      ...(prioritized || []),
      ...altCandidates,
      subjectInput
    ].filter(Boolean);

    // Repetition breaker (soft)
    let chosen = merged[0];
    if (typeof breakRepetition === 'function') {
      const varied = await breakRepetition(chosen, prevVisualSubjects || [], { maxRepeats: 2 });
      if (varied) chosen = varied;
    }

    // Feed into 10M resolver
    const resolved = resolveCanonicalSubject({
      primary: chosen,
      alternates: merged.slice(1, MAX_SUBJECT_OPTIONS),
    });
    return resolved;
  } catch (e) {
    console.error('[5D][10M][ERR] Normalization failed:', e);
    // fall back minimal
    return resolveCanonicalSubject(subjectInput);
  }
}

module.exports = { findClipForScene };
