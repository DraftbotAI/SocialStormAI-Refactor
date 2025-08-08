// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR
// Smart, Video-Preferred, No Duplicates, Max Logs, Strict Scoring
// + GPT Reformulation + Parallelized Lookups
//
// FIXES:
// - Do NOT assert local existence for R2 keys (5B downloads them).
// - When an image wins, make a local Ken Burns VIDEO from that image
//   (no subject search) so 5B gets a real video clip.
// - Prefer video whenever available; photos are fallback only.
// - Reduce noisy "file does not exist" logs for remote/R2 items.
// - Works whether usedClips is an Array or a Set, with normalized keys.
// ===========================================================

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const {
  findPexelsClipForScene,
  findPexelsPhotoForScene
} = require('./section10b-pexels-clip-helper.cjs');
const {
  findPixabayClipForScene,
  findPixabayPhotoForScene
} = require('./section10c-pixabay-clip-helper.cjs');
const { findUnsplashImageForScene } = require('./section10f-unsplash-image-helper.cjs');

// Ken Burns image → video helpers
const {
  makeKenBurnsVideoFromImage,
  preprocessImageToJpeg,
  staticImageToVideo,
} = require('./section10d-kenburns-image-helper.cjs');

// Subject extraction, symbolic & edge-case helpers, repetition breaker, scoring
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');
const { extractSymbolicVisualSubject } = require('./section10h-symbolic-matcher.cjs');
const { extractEmotionActionVisual } = require('./section10i-emotion-action-helper.cjs');
const { extractQuestionVisual } = require('./section10j-question-fallback-helper.cjs');
const { extractMultiSubjectVisual } = require('./section10k-multi-subject-handler.cjs');
const { breakRepetition } = require('./section10l-repetition-blocker.cjs');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');

const OpenAI = require('openai');
const REFORMULATION_MODEL = process.env.REFORMULATION_MODEL || 'gpt-4.1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log('[5D][INIT] Smart Clip Matcher (video-preferred, R2-safe) loaded.');

// ===========================================================
// Constants / Utilities
// ===========================================================

const GENERIC_SUBJECTS = [
  'face','person','man','woman','it','thing','someone','something','body','eyes',
  'kid','boy','girl','they','we','people','scene','child','children','sign','logo',
  'text','skyline','dubai'
];

function normKey(p) {
  if (!p) return '';
  try {
    const base = path.basename(String(p)).toLowerCase().trim();
    return base.replace(/\s+/g, '_');
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
    } else {
      // fallback: silently ignore
    }
  } catch (e) {
    console.error('[5D][USED][ERR] Failed to add used clip:', e);
  }
}

// Only assert for local files (e.g., downloaded Pexels/Pixabay, KB outputs).
// Skip for R2 keys and HTTP URLs — those are remote/fetched later.
function assertLocalFileExists(file, label = 'FILE', minSize = 8192) {
  try {
    if (!file) return false;
    const s = String(file);
    if (s.startsWith('http://') || s.startsWith('https://')) return true; // remote
    // If not absolute, still allow; just check exists if possible
    if (!fs.existsSync(s)) {
      console.warn(`[5D][${label}][SKIP_ASSERT] Not local yet (R2/remote or temp missing): ${s}`);
      return true; // do not hard-fail, caller decides
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

// Optional heuristic; currently not used to branch logic
function isProbablyR2Key(p) {
  if (!p) return false;
  const s = String(p);
  if (s.startsWith('http://') || s.startsWith('https://')) return false;
  return !fs.existsSync(s);
}

async function gptReformulateSubject(subject, mainTopic, jobId) {
  if (!openai) {
    console.warn(`[5D][REFORM][${jobId}] OpenAI API key missing; skipping query reformulation.`);
    return null;
  }
  try {
    const prompt =
      `Rephrase this into a literal, short stock VIDEO search phrase (no metaphors): "${subject}".` +
      (mainTopic ? ` Context: ${mainTopic}` : '');
    const response = await openai.chat.completions.create({
      model: REFORMULATION_MODEL,
      messages: [
        { role: 'system', content: 'You are a search query generator for stock video matching.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 20,
      temperature: 0
    });
    const reformulated = response.choices?.[0]?.message?.content?.trim();
    if (reformulated) {
      console.log(`[5D][REFORM][${jobId}] "${subject}" -> "${reformulated}"`);
      return reformulated;
    }
  } catch (err) {
    console.error(`[5D][REFORM][${jobId}] GPT failed:`, err);
  }
  return null;
}

function backupKeywordExtraction(text) {
  if (!text) return null;
  const tokens = String(text).split(/\s+/).filter(w => w.length > 3);
  return tokens[0] || text;
}

// Quick landmark context check to bias R2 if we have it indexed
async function tryContextualLandmarkOverride(subject, mainTopic, usedClips, jobId) {
  if (!findR2ClipForScene.getAllFiles) return null;
  const LANDMARK_WORDS = [
    'statue of liberty','white house','empire state building','eiffel tower','sphinx','great wall',
    'mount rushmore','big ben','colosseum','machu picchu','pyramids','chichen itza','louvre','taj mahal',
    'notre dame','angkor wat','leaning tower','buckingham palace','niagara falls','grand canyon',
    'hollywood sign','stonehenge','burj khalifa','golden gate bridge','petra','cristo redentor','opera house'
  ];
  const toTest = [subject, mainTopic].filter(Boolean).map(s => (typeof s === 'string' ? s.toLowerCase() : ''));
  const landmark = LANDMARK_WORDS.find(l => toTest.some(t => t.includes(l)));
  if (!landmark) return null;

  try {
    const r2Files = await findR2ClipForScene.getAllFiles(); // list of keys
    const needle = landmark.replace(/\s+/g, '_');
    for (const key of r2Files) {
      if (usedHas(usedClips, key)) continue;
      if (String(key).toLowerCase().includes(needle)) {
        console.log(`[5D][CONTEXT][${jobId}] Landmark override "${landmark}" -> "${key}"`);
        usedAdd(usedClips, key);
        return key; // return R2 key directly (5B will fetch)
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
  try {
    const safeDir = workDir || path.join(__dirname, '..', 'jobs', `kb-${jobId || 'job'}`);
    if (!fs.existsSync(safeDir)) fs.mkdirSync(safeDir, { recursive: true });

    const prepped = path.join(safeDir, `kb-prepped-${uuidv4()}.jpg`);
    await preprocessImageToJpeg(imgPath, prepped, jobId);

    const outVid = path.join(safeDir, `kbvid-${uuidv4()}.mp4`);
    await makeKenBurnsVideoFromImage(prepped, outVid, 5, jobId);

    if (!assertLocalFileExists(outVid, 'KENBURNS_OUT', 2048)) {
      // Fallback: static still-to-video (never fails)
      await staticImageToVideo(prepped, outVid, 5, jobId);
    }
    console.log(`[5D][KENBURNS][${jobId}] Built local KB video from image: ${outVid}`);
    return outVid;
  } catch (err) {
    console.error(`[5D][KENBURNS][${jobId}][ERR] Could not build KB from image (${imgPath}).`, err);
    return null;
  }
}

// Normalize helper returns into a { path, source } object
function asPathAndSource(res, sourceTag) {
  const p = res?.filePath || res?.path || res;
  return p ? { path: p, source: sourceTag } : null;
}

// ===========================================================
// MAIN
// ===========================================================

/**
 * Chooses the best visual for a scene.
 * Returns either:
 *  - R2 key string (no local assert; 5B downloads)
 *  - Local absolute file path to a video (pexels/pixabay download or Ken Burns output)
 *  - null (true last resort; 5B may still handle a final safety net)
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
  console.log('\n===================================================');
  console.log(`[5D][START][${jobId}][S${sceneIdx}] Subject="${subject}" Mega=${isMegaScene}`);
  console.log(`[5D][CTX][S${sceneIdx}]`, allSceneTexts?.[sceneIdx] || '(no scene text)');

  // ---- Anchor subject for scene 0 or explicit mega scene ----
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
    return forceClipPath; // may be R2 key or local file
  }

  // ---- Subject enrichment in parallel (symbolic/emotion/question/multi) ----
  let extractedSubjects = [];
  const subjectExtractors = [
    ['MULTI', extractMultiSubjectVisual],
    ['QUESTION', extractQuestionVisual],
    ['SYMBOLIC', extractSymbolicVisualSubject],
    ['EMOTION', extractEmotionActionVisual],
  ];

  await Promise.all(
    subjectExtractors.map(async ([label, fn]) => {
      try {
        const res = await fn(searchSubject, mainTopic);
        if (res && !GENERIC_SUBJECTS.includes(String(res).toLowerCase())) {
          extractedSubjects.push(res);
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
      if (s && !GENERIC_SUBJECTS.includes(String(s).toLowerCase())) extractedSubjects.push(s);
    });
    console.log(`[5D][SUBJECT][PRIORITIZED]`, prioritized);
  } catch (err) {
    console.error(`[5D][LITERAL][${jobId}][ERR]`, err);
  }

  if (!extractedSubjects.length) extractedSubjects.push(searchSubject);
  // Dedup
  extractedSubjects = [...new Set(extractedSubjects.map(s => String(s)))];

  // Break repetition against prior subjects (soft variation)
  let finalSubjects = [];
  for (const sub of extractedSubjects) {
    try {
      const varied = await breakRepetition(sub, prevVisualSubjects || [], { maxRepeats: 2 });
      if (varied && !finalSubjects.includes(varied)) finalSubjects.push(varied);
    } catch {
      if (!finalSubjects.includes(sub)) finalSubjects.push(sub);
    }
  }

  // Quick landmark override to R2 if we spot a famous subject
  const contextOverride = await tryContextualLandmarkOverride(finalSubjects[0], mainTopic, usedClips, jobId);
  if (contextOverride) return contextOverride;

  // =========================================================
  // Collect candidates (videos first; images as fallback)
  // =========================================================
  let videoCandidates = [];
  let imageCandidates = [];

  for (const subjectOption of finalSubjects) {
    console.log(`[5D][SEARCH][${jobId}] Subject Option: "${subjectOption}"`);

    // ---- Video lookups in parallel ----
    await Promise.all([
      (async () => {
        // R2 returns keys; do NOT assert local existence
        try {
          if (findR2ClipForScene.getAllFiles) {
            const r2Files = await findR2ClipForScene.getAllFiles(subjectOption, categoryFolder);
            for (const key of r2Files) {
              if (!usedHas(usedClips, key)) {
                videoCandidates.push({ path: key, source: 'R2', isVideo: true, subject: subjectOption });
              }
            }
            console.log(`[5D][R2][${jobId}] +${r2Files.length} candidates for "${subjectOption}"`);
          }
        } catch (err) {
          console.error(`[5D][R2][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          const hit = asPathAndSource(await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips), 'PEXELS_VIDEO');
          if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PEXELS_VIDEO_RESULT')) {
            videoCandidates.push({ ...hit, isVideo: true, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PEXELS_VIDEO][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          const hit = asPathAndSource(await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips), 'PIXABAY_VIDEO');
          if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PIXABAY_VIDEO_RESULT')) {
            videoCandidates.push({ ...hit, isVideo: true, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PIXABAY_VIDEO][${jobId}][ERR]`, err);
        }
      })(),
    ]);

    // ---- Photo lookups in parallel (fallback tier) ----
    await Promise.all([
      (async () => {
        try {
          const hit = asPathAndSource(await findPexelsPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips), 'PEXELS_PHOTO');
          if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PEXELS_PHOTO_RESULT', 4096)) {
            imageCandidates.push({ ...hit, isVideo: false, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PEXELS_PHOTO][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          const hit = asPathAndSource(await findPixabayPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips), 'PIXABAY_PHOTO');
        if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'PIXABAY_PHOTO_RESULT', 4096)) {
            imageCandidates.push({ ...hit, isVideo: false, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PIXABAY_PHOTO][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          const hit = asPathAndSource(await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext), 'UNSPLASH');
          if (hit && !usedHas(usedClips, hit.path) && assertLocalFileExists(hit.path, 'UNSPLASH_RESULT', 4096)) {
            imageCandidates.push({ ...hit, isVideo: false, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][UNSPLASH][${jobId}][ERR]`, err);
        }
      })(),
    ]);
  }

  // =========================================================
  // If no video yet, try ONE reformulation pass, then re-run
  // =========================================================
  if (!videoCandidates.length) {
    const seed = finalSubjects[0];
    const reformulated = (await gptReformulateSubject(seed, mainTopic, jobId)) || backupKeywordExtraction(seed);
    if (reformulated && reformulated !== seed) {
      console.log(`[5D][REFORM_USED][${jobId}] Retrying with: "${reformulated}"`);
      return await findClipForScene({
        subject: reformulated,
        sceneIdx,
        allSceneTexts,
        mainTopic,
        isMegaScene,
        usedClips,
        workDir,
        jobId,
        megaSubject,
        forceClipPath: null,
        jobContext,
        categoryFolder,
        prevVisualSubjects
      });
    }
  }

  // =========================================================
  // Score candidates (strict thresholds, video preferred)
  // =========================================================
  videoCandidates.forEach(c => { c.score = scoreSceneCandidate(c, c.subject, usedClips, true); });
  imageCandidates.forEach(c => { c.score = scoreSceneCandidate(c, c.subject, usedClips, false); });

  // Filter/Sort
  videoCandidates = videoCandidates.filter(c => c.score >= 65).sort((a, b) => b.score - a.score);
  imageCandidates = imageCandidates.filter(c => c.score >= 70).sort((a, b) => b.score - a.score);

  // *** VIDEO ALWAYS WINS if any present ***
  if (videoCandidates.length) {
    const best = videoCandidates[0];
    usedAdd(usedClips, best.path);
    console.log(`[5D][RESULT][VIDEO][${jobId}]`, { path: best.path, source: best.source, score: best.score, subj: best.subject });
    // Return R2 key or local video path; Section 5B handles both cases
    return best.path;
  }

  // =========================================================
  // No video → build Ken Burns VIDEO from best image NOW
  // =========================================================
  if (imageCandidates.length) {
    const bestImg = imageCandidates[0];
    console.log(`[5D][RESULT][IMAGE->KB][${jobId}]`, { path: bestImg.path, source: bestImg.source, score: bestImg.score, subj: bestImg.subject });

    const kbVid = await kenBurnsVideoFromImagePath(bestImg.path, workDir, sceneIdx, jobId);
    if (kbVid && assertLocalFileExists(kbVid, 'KB_OUT', 2048)) {
      // mark original image as used to avoid reusing the same visual
      usedAdd(usedClips, bestImg.path);
      return kbVid; // local video path
    }

    // Shouldn’t happen often; last-ditch image path (5B may struggle)
    console.warn(`[5D][IMAGE_FALLBACK][${jobId}] Ken Burns build failed; returning image path.`);
    return bestImg.path;
  }

  // =========================================================
  // Total miss → pick any R2 clip not yet used (no local assert)
  // =========================================================
  if (findR2ClipForScene.getAllFiles) {
    try {
      const r2Files = await findR2ClipForScene.getAllFiles();
      const fallback = r2Files.find(f => !usedHas(usedClips, f));
      if (fallback) {
        console.warn(`[5D][FALLBACK][${jobId}] Using first-available R2 clip: ${fallback}`);
        usedAdd(usedClips, fallback);
        return fallback; // R2 key
      }
    } catch (err) {
      console.error(`[5D][R2_FALLBACK][${jobId}][ERR]`, err);
    }
  }

  // Nothing left
  console.error(`[5D][NO_MATCH][${jobId}] No match found for scene ${sceneIdx + 1}`);
  return null;
}

module.exports = { findClipForScene };
