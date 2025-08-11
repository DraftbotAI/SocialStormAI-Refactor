// ============================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (R2-first, De-dupe, Strict Species Gate)
// Always returns the best available visual: R2 video → Pexels video → Pixabay video → Ken Burns fallback.
// Within-job de-dupe enforced via jobContext.usedClipKeys (Set). No cross-job dedupe.
// R2-first short-circuit: if R2 yields a non-duplicate that passes the subject gate, we pick it immediately.
// Strict species gate for animals (exact only) unless SS_SUBJECT_STRICT=0, which allows synonyms via 10G scoring.
// MAX LOGGING. No recursion. No infinite loops.
// Exports: findClipForScene(opts)
// ============================================================

const path = require('path');
const fs = require('fs');

// Providers
const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');

// Subject + scoring
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');

// =============================
// ENV / MODE FLAGS
// =============================
const SUBJECT_STRICT = String(process.env.SS_SUBJECT_STRICT || '1') !== '0'; // default strict

// =============================
// Small utilities
// =============================
function safe(s) { return (s ?? '').toString(); }
function low(s) { return safe(s).toLowerCase(); }

function isHttpUrl(s) { return /^https?:\/\//i.test(safe(s)); }
function isR2Key(s) {
  const v = safe(s);
  return !isHttpUrl(v) && v.includes('/') && !fs.existsSync(v); // heuristic for "bucket key"
}

function fileStem(p) {
  const b = path.basename(safe(p));
  return b.replace(/\.[a-z0-9]+$/i, '');
}

// Normalize clip key with provider prefix and aggressive normalization
function normalizeClipKey(src) {
  const s = safe(src).trim();
  const base = path.basename(s.split('?')[0]);
  const stem = fileStem(s);
  const lowered = low(s);
  const variants = new Set([
    lowered,
    lowered.replace(/[^a-z0-9]+/g, ''), // aggressive normalization
    low(base),
    low(base).replace(/[^a-z0-9]+/g, ''), // aggressive normalization
    low(stem),
    low(stem).replace(/[^a-z0-9]+/g, ''), // aggressive normalization
  ]);

  // Provider-tagged variants to further reduce collisions
  variants.add(`r2:${lowered}`);
  variants.add(`url:${lowered}`);
  variants.add(`base:${low(base)}`);
  variants.add(`stem:${low(stem)}`);

  return variants;
}

function markUsed(jobContext, src, tag = '') {
  const variants = normalizeClipKey(src);
  for (const v of variants) jobContext.usedClipKeys.add(v);
  console.log(`[5D][DEDUPE][ADD] ${tag} added ${variants.size} keys for: ${src}`);
}

function isUsed(jobContext, src) {
  const variants = normalizeClipKey(src);
  for (const v of variants) {
    if (jobContext.usedClipKeys.has(v)) {
      return true;
    }
  }
  return false;
}

function guessProvider(src) {
  const s = safe(src);
  if (s.includes('pexels')) return 'pexels';
  if (s.includes('pixabay')) return 'pixabay';
  return 'r2';
}

function isAnimalWord(word) {
  const w = low(word);
  // Fast common set — detailed mapping handled in 10G scoring. Keep this minimal to avoid dupe-hell.
  return /\b(manatee|sea\s*cow|dolphin|whale|shark|seal|otter|cat|dog|monkey|lion|tiger|bear|eagle|elephant|giraffe|panda|koala|hippo|rhinoceros|rhino|penguin|wolf|fox|owl|cow|horse|zebra|camel)\b/.test(w);
}

function canonicalAnimal(word) {
  const w = low(word).trim();
  if (/\bsea\s*cow\b/.test(w)) return 'manatee';
  if (/\brhino|rhinoceros\b/.test(w)) return 'rhino';
  return w;
}

// Subject gate logic:
// - If primarySubject exists and is an animal, enforce species gate.
//   * STRICT mode (default): require canonical species token to appear in candidate name/key.
//   * NON-STRICT (SS_SUBJECT_STRICT=0): allow synonyms; 10G scoring will adjudicate.
// - If primarySubject empty → allow (we’ll rely on scoring & order).
function passesSubjectGate(candidateSrc, primarySubject, mainTopic) {
  const src = low(candidateSrc);
  const subject = low(primarySubject || '');
  const topic = low(mainTopic || '');

  if (!subject && !topic) {
    console.log('[5D][SUBJECT-GATE] No subject/topic set → pass.');
    return true;
  }

  // Prefer the explicit subject; fall back to mainTopic
  const chosen = subject || topic;

  // Animal strictness
  const animalGate = isAnimalWord(chosen);
  if (!animalGate) {
    // Non-animal → gate is advisory; rely on scoring.
    console.log('[5D][SUBJECT-GATE] Non-animal subject → pass (will rely on 10G scoring).');
    return true;
  }

  const canon = canonicalAnimal(chosen);
  if (SUBJECT_STRICT) {
    const ok = src.includes(canon);
    console.log(`[5D][SUBJECT-GATE] STRICT animal gate on "${canon}" → ${ok ? 'PASS' : 'FAIL'}. Source="${candidateSrc}"`);
    return ok;
  } else {
    // relaxed animal gate: allow synonyms; scoring decides
    const ok = (src.includes(canon) || src.includes('sea_cow') || src.includes('sea cow'));
    console.log(`[5D][SUBJECT-GATE] RELAXED animal gate on "${canon}" (synonyms allowed) → ${ok ? 'PASS' : 'SOFT-PASS (score)'} Source="${candidateSrc}"`);
    return true; // allow; scoring will penalize if too far
  }
}

// Score helper wrapper with rich logs (safe even if 10G changes)
async function scoreCandidateWrapper({ candidateSrc, subject, mainTopic, sceneIdx, isMegaScene }) {
  try {
    const score = await scoreSceneCandidate({
      candidatePathOrUrl: candidateSrc,
      subject,
      mainTopic,
      sceneIdx,
      isMegaScene,
      allowSynonyms: !SUBJECT_STRICT,
    });
    console.log(`[5D][SCORE] src="${candidateSrc}" → score=${score}`);
    return Number(score) || 0;
  } catch (e) {
    console.warn('[5D][SCORE][WARN] scoreSceneCandidate error; defaulting to 0:', e?.message || e);
    return 0;
  }
}

// Attempt helper with robust signature handling (object or string)
async function callProvider(fn, primarySubject, mainTopic, sceneIdx, jobId, categoryFolder) {
  try {
    // Preferred: object signature
    return await fn({
      subject: primarySubject,
      mainTopic,
      sceneIdx,
      jobId,
      categoryFolder,
      allowSynonyms: !SUBJECT_STRICT,
    });
  } catch (e1) {
    try {
      // Fallback: pass a string
      return await fn(primarySubject || mainTopic || '');
    } catch (e2) {
      console.warn(`[5D][PROVIDER][WARN] Provider call failed both signatures. ${fn.name}:`, e1?.message || e1, e2?.message || e2);
      return null;
    }
  }
}

// Normalize any provider return into a single candidate string, or null
function normalizeProviderResult(res) {
  if (!res) return null;
  if (typeof res === 'string') return res;
  if (Array.isArray(res)) {
    // take first string-ish entry
    for (const r of res) {
      if (typeof r === 'string' && r) return r;
      if (r && typeof r === 'object') {
        if (typeof r.url === 'string') return r.url;
        if (typeof r.path === 'string') return r.path;
        if (typeof r.key === 'string') return r.key;
      }
    }
    return null;
  }
  if (typeof res === 'object') {
    return res.url || res.path || res.key || null;
  }
  return null;
}

// ============================================================
// Core: findClipForScene
// ============================================================
async function findClipForScene(opts) {
  const {
    subject,
    sceneIdx = 0,
    allSceneTexts = [],
    mainTopic = '',
    isMegaScene = false,
    workDir = '',
    jobId = 'nojob',
    jobContext = { usedClipKeys: new Set(), kbUsedCount: 0 },
    categoryFolder = 'misc',
  } = opts || {};

  const primarySubject = subject || mainTopic || '';
  const strictNote = SUBJECT_STRICT ? 'STRICT' : 'RELAXED';
  console.log(`\n[5D][BEGIN][${jobId}] Scene=${sceneIdx+1} subject="${primarySubject}" mainTopic="${mainTopic}" mode=${strictNote} category=${categoryFolder}`);
  console.log(`[5D][DEDUPE][${jobId}] usedClipKeys size=${jobContext.usedClipKeys?.size || 0}`);

  // ===========================
  // 1) R2-FIRST: short-circuit
  // ===========================
  try {
    const r2Res = await callProvider(findR2ClipForScene, primarySubject, mainTopic, sceneIdx, jobId, categoryFolder);
    const r2Clip = normalizeProviderResult(r2Res);
    if (r2Clip) {
      console.log(`[5D][R2][CANDIDATE][${jobId}] ${r2Clip}`);

      if (isUsed(jobContext, r2Clip)) {
        console.log(`[5D][R2][DEDUPE][${jobId}] Already used → SKIP: ${r2Clip}`);
      } else if (!passesSubjectGate(r2Clip, primarySubject, mainTopic)) {
        console.log(`[5D][R2][SUBJECT-GATE][${jobId}] REJECT: ${r2Clip}`);
      } else {
        const r2Score = await scoreCandidateWrapper({
          candidateSrc: r2Clip, subject: primarySubject, mainTopic, sceneIdx, isMegaScene
        });
        // Short-circuit: any passing R2 candidate is taken immediately
        console.log(`[5D][R2][PICK][${jobId}] Short-circuit pick with score=${r2Score}: ${r2Clip}`);
        markUsed(jobContext, r2Clip, 'R2');
        return r2Clip;
      }
    } else {
      console.log(`[5D][R2][MISS][${jobId}] No candidate returned by 10A for subject="${primarySubject}"`);
    }
  } catch (e) {
    console.warn(`[5D][R2][ERR][${jobId}]`, e?.message || e);
  }

  // ======================================================
  // 2) PROVIDERS (Video-first): Pexels → Pixabay
  //    We still enforce in-job de-dupe and animal gate.
  // ======================================================
  // PEXELS
  try {
    const pxRes = await callProvider(findPexelsClipForScene, primarySubject, mainTopic, sceneIdx, jobId, categoryFolder);
    const pxClip = normalizeProviderResult(pxRes);
    if (pxClip) {
      console.log(`[5D][PEXELS][CANDIDATE][${jobId}] ${pxClip}`);

      if (isUsed(jobContext, pxClip)) {
        console.log(`[5D][PEXELS][DEDUPE][${jobId}] Already used → SKIP: ${pxClip}`);
      } else if (!passesSubjectGate(pxClip, primarySubject, mainTopic)) {
        console.log(`[5D][PEXELS][SUBJECT-GATE][${jobId}] REJECT: ${pxClip}`);
      } else {
        const pxScore = await scoreCandidateWrapper({
          candidateSrc: pxClip, subject: primarySubject, mainTopic, sceneIdx, isMegaScene
        });
        console.log(`[5D][PEXELS][PICK][${jobId}] score=${pxScore}: ${pxClip}`);
        markUsed(jobContext, pxClip, 'PEXELS');
        return pxClip;
      }
    } else {
      console.log(`[5D][PEXELS][MISS][${jobId}] No candidate returned by 10B for subject="${primarySubject}"`);
    }
  } catch (e) {
    console.warn(`[5D][PEXELS][ERR][${jobId}]`, e?.message || e);
  }

  // PIXABAY
  try {
    const pbRes = await callProvider(findPixabayClipForScene, primarySubject, mainTopic, sceneIdx, jobId, categoryFolder);
    const pbClip = normalizeProviderResult(pbRes);
    if (pbClip) {
      console.log(`[5D][PIXABAY][CANDIDATE][${jobId}] ${pbClip}`);

      if (isUsed(jobContext, pbClip)) {
        console.log(`[5D][PIXABAY][DEDUPE][${jobId}] Already used → SKIP: ${pbClip}`);
      } else if (!passesSubjectGate(pbClip, primarySubject, mainTopic)) {
        console.log(`[5D][PIXABAY][SUBJECT-GATE][${jobId}] REJECT: ${pbClip}`);
      } else {
        const pbScore = await scoreCandidateWrapper({
          candidateSrc: pbClip, subject: primarySubject, mainTopic, sceneIdx, isMegaScene
        });
        console.log(`[5D][PIXABAY][PICK][${jobId}] score=${pbScore}: ${pbClip}`);
        markUsed(jobContext, pbClip, 'PIXABAY');
        return pbClip;
      }
    } else {
      console.log(`[5D][PIXABAY][MISS][${jobId}] No candidate returned by 10C for subject="${primarySubject}"`);
    }
  } catch (e) {
    console.warn(`[5D][PIXABAY][ERR][${jobId}]`, e?.message || e);
  }

  // ======================================================
  // 3) Images → Ken Burns fallback (always returns a video)
  //    We do not enforce animal gate here — last-resort visual.
  // ======================================================
  try {
    console.log(`[5D][KB][FALLBACK][${jobId}] Triggered Ken Burns fallback for subject="${primarySubject || mainTopic}" scene=${sceneIdx+1}`);
    const kb = await fallbackKenBurnsVideo(primarySubject || mainTopic || 'scenic nature', workDir, sceneIdx, jobId);
    if (kb) {
      // Ken Burns creates a *new* file name each time; de-dupe is unlikely but still mark it.
      markUsed(jobContext, kb, 'KENBURNS');
      console.log(`[5D][KB][PICK][${jobId}] ${kb}`);
      return kb;
    }
  } catch (e) {
    console.warn(`[5D][KB][ERR][${jobId}]`, e?.message || e);
  }

  // If we got here, everything failed
  console.error(`[5D][FAIL][${jobId}] No candidate found after all fallbacks for scene ${sceneIdx + 1}.`);
  return null;
}

module.exports = { findClipForScene };
