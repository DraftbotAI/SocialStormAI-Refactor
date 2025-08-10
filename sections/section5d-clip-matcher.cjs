// ============================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Deterministic, Bulletproof)
// R2-FIRST short-circuit: if R2 returns a clip, we take it immediately.
// Always returns something: R2 video, provider video, or Ken Burns (Pexels/Pixabay photos).
// Max logging at each step. No infinite loops.
// Policy: Ken Burns never on scene 1, max 2 per job.
// ===========================================================

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
const { cleanForFilename } = require('./section10e-upload-to-r2.cjs');
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');
const fs = require('fs');
const path = require('path');

console.log('[5D][INIT] Clip matcher orchestrator (R2-first, deterministic) loaded.');

const GENERIC_SUBJECTS = [
  'face','person','man','woman','it','thing','someone','something','body','eyes','kid','boy','girl','they','we','people','scene','child','children'
];

// ---------- Small utils ----------
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

function markUsedInPlace(usedClips, candidate = {}) {
  try {
    if (!Array.isArray(usedClips)) return;
    const p = candidate.path || candidate.filePath || '';
    const b = p ? path.basename(p) : '';
    const u = candidate.meta?.url || candidate.url || '';
    const n = candidate.meta?.originalName || candidate.filename || '';
    const add = v => { if (v && !usedClips.includes(v)) usedClips.push(v); };
    add(p); add(b); add(u); add(n);
  } catch {}
}

function isUsed(usedClips, candidatePath, meta = {}) {
  if (!Array.isArray(usedClips)) return false;
  const base = candidatePath ? path.basename(candidatePath) : '';
  const url  = meta?.url || '';
  return usedClips.includes(candidatePath) || (base && usedClips.includes(base)) || (url && usedClips.includes(url));
}

function normalizeGeneric(subject) {
  return (subject || '').toLowerCase();
}

function getMajorWords(subject) {
  return (subject || '')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
}

// ---- Primary-subject + subject-present helpers (minimal, local) ----
function escapeRegex(s = '') {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function wordBoundaryIncludes(hay = '', needle = '') {
  const s = (needle || '').trim();
  if (!s) return false;
  const re = new RegExp(`\\b${escapeRegex(s)}s?\\b`, 'i'); // allow simple plural
  return re.test(String(hay));
}
function subjectPresentInMeta(pathOrName, meta, subject) {
  const s = (subject || '').trim();
  if (!s) return false;
  const fn = (pathOrName || '').toString();
  const tags = meta?.tags || meta?.keywords || [];
  const title = meta?.title || '';
  const desc = meta?.description || '';
  // Phrase check first
  if (wordBoundaryIncludes(fn, s) || wordBoundaryIncludes(tags.join(' '), s) ||
      wordBoundaryIncludes(title, s) || wordBoundaryIncludes(desc, s)) {
    return true;
  }
  // Token fallback (any major word)
  const majors = getMajorWords(s);
  if (!majors.length) return false;
  const hay = `${fn} ${(tags||[]).join(' ')} ${title} ${desc}`.toLowerCase();
  return majors.some(t => wordBoundaryIncludes(hay, t));
}
function pickPrimarySubject({ jobContext = {}, megaSubject, mainTopic, subject, fallback }) {
  const fromCtx = (jobContext.primarySubject || '').trim();
  const candidates = [fromCtx, megaSubject, mainTopic, subject, fallback].filter(Boolean);
  return candidates.find(v => v && !GENERIC_SUBJECTS.includes(normalizeGeneric(v))) || candidates[0] || '';
}

function getMaxKbPerJob() {
  const n = parseInt(process.env.SS_MAX_KB_PER_JOB || '2', 10);
  return isNaN(n) ? 2 : Math.max(0, n);
}

// ---------- Main ----------
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
  // 0) Primary subject (for gating / fallback)
  const primarySubject = pickPrimarySubject({ jobContext, megaSubject, mainTopic, subject, fallback: allSceneTexts?.[0] });
  if (primarySubject) {
    console.log(`[5D][PRIMARY][${jobId}] Primary subject = "${primarySubject}"`);
  }

  // Ken Burns policy controls
  if (typeof jobContext.kbUsedCount !== 'number') jobContext.kbUsedCount = 0;
  const maxKb = getMaxKbPerJob();

  // 1) Decide the search subject (anchor for hook/mega)
  let searchSubject = subject;

  if (isMegaScene || sceneIdx === 0) {
    if (megaSubject && typeof megaSubject === 'string' && megaSubject.length > 2 && !GENERIC_SUBJECTS.includes(normalizeGeneric(megaSubject))) {
      searchSubject = megaSubject;
      console.log(`[5D][ANCHOR][${jobId}] Using megaSubject for scene ${sceneIdx + 1}: "${searchSubject}"`);
    } else if (mainTopic && typeof mainTopic === 'string' && mainTopic.length > 2 && !GENERIC_SUBJECTS.includes(normalizeGeneric(mainTopic))) {
      searchSubject = mainTopic;
      console.log(`[5D][ANCHOR][${jobId}] Using mainTopic for scene ${sceneIdx + 1}: "${searchSubject}"`);
    } else if (allSceneTexts?.[0]) {
      searchSubject = allSceneTexts[0];
      console.log(`[5D][ANCHOR][${jobId}] Fallback to first scene text for anchor: "${searchSubject}"`);
    }
  }

  if (!searchSubject || GENERIC_SUBJECTS.includes(normalizeGeneric(searchSubject))) {
    if (mainTopic && !GENERIC_SUBJECTS.includes(normalizeGeneric(mainTopic))) {
      searchSubject = mainTopic;
      console.log(`[5D][SUBJECT][${jobId}] Generic subject → using mainTopic: "${searchSubject}"`);
    } else if (allSceneTexts?.[0]) {
      searchSubject = allSceneTexts[0];
      console.log(`[5D][SUBJECT][${jobId}] Generic subject → using first scene text: "${searchSubject}"`);
    }
  }

  if (!searchSubject || searchSubject.length < 2) {
    console.error(`[5D][FATAL][${jobId}] No valid subject for scene ${sceneIdx + 1}.`);
    return null;
  }

  // 2) Force clip for debugging
  if (forceClipPath) {
    console.log(`[5D][FORCE][${jobId}] Forcing clip path: ${forceClipPath}`);
    if (assertFileExists(forceClipPath, 'FORCE_CLIP')) return forceClipPath;
    return null;
  }

  if (!findR2ClipForScene || !findPexelsClipForScene || !findPixabayClipForScene || !fallbackKenBurnsVideo) {
    console.error('[5D][FATAL][HELPERS] One or more clip helpers not loaded!');
    return null;
  }

  // 3) Visual subject extraction (ordered list)
  let prioritizedSubjects = [];
  try {
    prioritizedSubjects = await extractVisualSubjects(searchSubject, mainTopic);
    console.log(`[5D][SUBJECTS][${jobId}] Prioritized:`, prioritizedSubjects);
  } catch (err) {
    console.error(`[5D][SUBJECTS][${jobId}][ERR]`, err);
    prioritizedSubjects = [searchSubject, mainTopic].filter(Boolean);
  }

  // 4) Try each subject once (no recursion). R2-FIRST SHORT-CIRCUIT.
  for (const subjectOption of prioritizedSubjects) {
    if (!subjectOption || subjectOption.length < 2) continue;

    // ---- 4a. R2 FIRST (short-circuit if found)
    try {
      const r2Local = await findR2ClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      if (r2Local && assertFileExists(r2Local, 'R2_RESULT')) {
        if (isUsed(usedClips, r2Local)) {
          console.log(`[5D][R2][${jobId}] R2 candidate already used: ${path.basename(r2Local)}`);
        } else {
          console.log(`[5D][R2][${jobId}] Taking R2 winner immediately for "${subjectOption}": ${r2Local}`);
          markUsedInPlace(usedClips, { path: r2Local, filename: path.basename(r2Local) });

          if (jobContext && Array.isArray(jobContext.clipsToIngest)) {
            jobContext.clipsToIngest.push({
              localPath: r2Local, subject: subjectOption, sceneIdx, source: 'r2', categoryFolder
            });
          }
          return r2Local; // SHORT-CIRCUIT ON R2
        }
      } else {
        console.log(`[5D][R2][${jobId}] No R2 match for "${subjectOption}"`);
      }
    } catch (err) {
      console.error(`[5D][R2][${jobId}][ERR]`, err);
    }

    // ---- 4b. Providers (only if R2 failed) – videos first
    const scoredCandidates = [];

    // PEXELS (video)
    try {
      const pxRes = await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      const pxPath = (pxRes && pxRes.path) ? pxRes.path : pxRes;
      const pxMeta = (pxRes && pxRes.meta) ? pxRes.meta : {};
      if (pxPath && assertFileExists(pxPath, 'PEXELS_RESULT')) {
        if (isUsed(usedClips, pxPath, pxMeta)) {
          console.log(`[5D][PEXELS][${jobId}] Used before: ${path.basename(pxPath)}`);
        } else {
          // SUBJECT GATE (videos only)
          if (primarySubject && !subjectPresentInMeta(pxPath, pxMeta, primarySubject)) {
            console.warn(`[5D][SUBJECT-GATE][${jobId}] Reject Pexels off-subject (need "${primarySubject}") -> ${pxPath}`);
          } else {
            const filenameForScoring = pxMeta.originalName || pxMeta.filename || pxMeta.url || path.basename(pxPath);
            const s10 = scoreSceneCandidate(
              { filename: filenameForScoring, filePath: pxPath, tags: pxMeta.tags || pxMeta.keywords || [], title: pxMeta.title || '', description: pxMeta.description || '' },
              subjectOption, usedClips
            );
            const providerScore = typeof pxRes?.score === 'number' ? pxRes.score : (typeof pxMeta.score === 'number' ? pxMeta.score : null);
            const finalScore = providerScore !== null ? Math.max(s10, providerScore) : s10;
            console.log(`[5D][PEXELS][${jobId}] 10G=${s10}${providerScore!==null?` provider=${providerScore}`:''} path=${pxPath}`);
            scoredCandidates.push({ source: 'pexels', path: pxPath, score: finalScore, meta: pxMeta });
          }
        }
      }
    } catch (e) { console.error(`[5D][PEXELS][ERR][${jobId}]`, e); }

    // PIXABAY (video)
    try {
      const pbRes = await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
      const pbPath = (pbRes && pbRes.path) ? pbRes.path : pbRes;
      const pbMeta = (pbRes && pbRes.meta) ? pbRes.meta : {};
      if (pbPath && assertFileExists(pbPath, 'PIXABAY_RESULT')) {
        if (isUsed(usedClips, pbPath, pbMeta)) {
          console.log(`[5D][PIXABAY][${jobId}] Used before: ${path.basename(pbPath)}`);
        } else {
          // SUBJECT GATE (videos only)
          if (primarySubject && !subjectPresentInMeta(pbPath, pbMeta, primarySubject)) {
            console.warn(`[5D][SUBJECT-GATE][${jobId}] Reject Pixabay off-subject (need "${primarySubject}") -> ${pbPath}`);
          } else {
            const filenameForScoring = pbMeta.originalName || pbMeta.filename || pbMeta.url || path.basename(pbPath);
            const s10 = scoreSceneCandidate(
              { filename: filenameForScoring, filePath: pbPath, tags: pbMeta.tags || pbMeta.keywords || [], title: pbMeta.title || '', description: pbMeta.description || '' },
              subjectOption, usedClips
            );
            const providerScore = typeof pbRes?.score === 'number' ? pbRes.score : (typeof pbMeta.score === 'number' ? pbMeta.score : null);
            const finalScore = providerScore !== null ? Math.max(s10, providerScore) : s10;
            console.log(`[5D][PIXABAY][${jobId}] 10G=${s10}${providerScore!==null?` provider=${providerScore}`:''} path=${pbPath}`);
            scoredCandidates.push({ source: 'pixabay', path: pbPath, score: finalScore, meta: pbMeta });
          }
        }
      }
    } catch (e) { console.error(`[5D][PIXABAY][ERR][${jobId}]`, e); }

    // Pick best provider candidate (video)
    if (scoredCandidates.length) {
      scoredCandidates.sort((a, b) => (b.score - a.score) || (Math.random() - 0.5));
      const winner = scoredCandidates[0];
      console.log(`[5D][PICK][${jobId}] Provider winner for "${subjectOption}": ${winner.source} (${winner.score}) -> ${winner.path}`);
      markUsedInPlace(usedClips, { path: winner.path, meta: winner.meta || {}, filename: path.basename(winner.path) });

      if (jobContext && Array.isArray(jobContext.clipsToIngest)) {
        jobContext.clipsToIngest.push({
          localPath: winner.path, subject: subjectOption, sceneIdx, source: winner.source, categoryFolder
        });
      }
      return winner.path;
    }

    // ---- 4c. Photo → Ken Burns (respect policy)
    const canUseKB = sceneIdx > 0 && jobContext.kbUsedCount < maxKb;
    if (!canUseKB) {
      if (sceneIdx === 0) console.warn(`[5D][KB][${jobId}] Skipping KB on scene 1 by policy.`);
      if (jobContext.kbUsedCount >= maxKb) console.warn(`[5D][KB][${jobId}] KB cap reached (${jobContext.kbUsedCount}/${maxKb}).`);
    } else {
      try {
        const kb = await fallbackKenBurnsVideo(subjectOption, workDir, sceneIdx, jobId, usedClips);
        if (kb && !isUsed(usedClips, kb) && assertFileExists(kb, 'KENBURNS_RESULT')) {
          // Allow KB even if filename/meta doesn't include subject tokens (queried by subject).
          console.log(`[5D][PICK][${jobId}] KenBurns (photo) for "${subjectOption}": ${kb}`);
          jobContext.kbUsedCount++;
          markUsedInPlace(usedClips, { path: kb, filename: path.basename(kb) });
          return kb;
        }
      } catch (e) { console.error(`[5D][KENBURNS][ERR][${jobId}]`, e); }
    }
  }

  // 4d) SUBJECT-ONLY FINAL SEARCH (before generic hail-mary)
  if (primarySubject) {
    console.log(`[5D][SUBJECT-FALLBACK][${jobId}] Forcing subject-only search: "${primarySubject}"`);

    // R2 subject-only
    try {
      const r2Only = await findR2ClipForScene(primarySubject, workDir, sceneIdx, jobId, usedClips);
      if (r2Only && assertFileExists(r2Only, 'R2_SUBJECT_ONLY')) {
        markUsedInPlace(usedClips, { path: r2Only, filename: path.basename(r2Only) });
        console.log(`[5D][SUBJECT-FALLBACK][${jobId}] R2 subject-only hit: ${r2Only}`);
        return r2Only;
      }
    } catch (e) { console.error(`[5D][SUBJECT-FALLBACK][R2][${jobId}]`, e); }

    // KenBurns subject-only (respect policy)
    const canUseKB = sceneIdx > 0 && jobContext.kbUsedCount < maxKb;
    if (canUseKB) {
      try {
        const kbSubj = await fallbackKenBurnsVideo(primarySubject, workDir, sceneIdx, jobId, usedClips);
        if (kbSubj && assertFileExists(kbSubj, 'KENBURNS_SUBJECT_ONLY')) {
          jobContext.kbUsedCount++;
          markUsedInPlace(usedClips, { path: kbSubj, filename: path.basename(kbSubj) });
          console.log(`[5D][SUBJECT-FALLBACK][${jobId}] KenBurns subject-only: ${kbSubj} (${jobContext.kbUsedCount}/${maxKb})`);
          return kbSubj;
        }
      } catch (e) { console.error(`[5D][SUBJECT-FALLBACK][KENBURNS][${jobId}]`, e); }
    } else {
      console.warn(`[5D][SUBJECT-FALLBACK][${jobId}] KB fallback disallowed (sceneIdx=${sceneIdx}, used=${jobContext.kbUsedCount}/${maxKb}).`);
    }
  }

  // 5) Final hail-mary: try R2 with main topic OR generic KB (respect policy)
  try {
    const hm = mainTopic || subject || 'landmark';
    console.warn(`[5D][FINALFALLBACK][${jobId}] Hail-mary R2 with "${hm}"`);
    const r2hm = await findR2ClipForScene(hm, workDir, sceneIdx, jobId, usedClips);
    if (r2hm && assertFileExists(r2hm, 'R2_FINAL')) {
      markUsedInPlace(usedClips, { path: r2hm, filename: path.basename(r2hm) });
      console.warn(`[5D][FINALFALLBACK][${jobId}] Using R2 hail-mary: ${r2hm}`);
      return r2hm;
    }
  } catch (e) { console.error(`[5D][FINALFALLBACK][R2][${jobId}]`, e); }

  const canUseKBFinal = sceneIdx > 0 && jobContext.kbUsedCount < maxKb;
  if (canUseKBFinal) {
    try {
      const kb = await fallbackKenBurnsVideo('landmark', workDir, sceneIdx, jobId, usedClips);
      if (kb && assertFileExists(kb, 'KENBURNS_RESULT')) {
        jobContext.kbUsedCount++;
        console.log(`[5D][FINALFALLBACK][${jobId}] KenBurns generic: ${kb} (${jobContext.kbUsedCount}/${maxKb})`);
        markUsedInPlace(usedClips, { path: kb, filename: path.basename(kb) });
        return kb;
      }
    } catch (e) { console.error(`[5D][FINALFALLBACK][KENBURNS][${jobId}]`, e); }
  } else {
    console.warn(`[5D][FINALFALLBACK][${jobId}] KB final fallback disallowed (sceneIdx=${sceneIdx}, used=${jobContext.kbUsedCount}/${maxKb}).`);
  }

  console.error(`[5D][NO_MATCH][${jobId}] No clip found for scene ${sceneIdx + 1}`);
  return null;
}

module.exports = { findClipForScene };
