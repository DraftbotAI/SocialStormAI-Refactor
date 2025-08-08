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
// ===========================================================

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene, findPexelsPhotoForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene, findPixabayPhotoForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { findUnsplashImageForScene } = require('./section10f-unsplash-image-helper.cjs');

// We will use these to produce a Ken Burns VIDEO from a selected image path.
const {
  makeKenBurnsVideoFromImage,
  preprocessImageToJpeg,
  staticImageToVideo,
} = require('./section10d-kenburns-image-helper.cjs');

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

const GENERIC_SUBJECTS = [
  'face','person','man','woman','it','thing','someone','something','body','eyes',
  'kid','boy','girl','they','we','people','scene','child','children','sign','logo',
  'text','skyline','dubai'
];

// ---------- Utilities ----------

// Only assert for *local* files that should exist right now (e.g., downloaded Pexels/Pixabay files).
// Do NOT use this for R2 keys or HTTP URLs — those are fetched later or are remote.
function assertLocalFileExists(file, label = 'FILE', minSize = 10240) {
  try {
    if (!file || file.startsWith('http')) return true; // remote — skip hard assert here
    if (!path.isAbsolute(file) && !fs.existsSync(file)) {
      // Might still be a relative temp; try existsSync anyway:
      if (!fs.existsSync(file)) {
        console.warn(`[5D][${label}][SKIP_ASSERT] Non-absolute or not-yet-downloaded path: ${file}`);
        return true;
      }
    }
    if (!fs.existsSync(file)) {
      console.error(`[5D][${label}][ERR] Local file does not exist: ${file}`);
      return false;
    }
    const sz = fs.statSync(file).size;
    if (sz < minSize) {
      console.error(`[5D][${label}][ERR] Local file too small (${sz} bytes): ${file}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[5D][${label}][ERR] Exception on assert:`, err);
    return false;
  }
}

// R2 key heuristic: not a local file and not an http URL.
function isProbablyR2Key(p) {
  if (!p) return false;
  if (p.startsWith('http://') || p.startsWith('https://')) return false;
  // If it doesn't exist locally, treat as R2 key (download happens in 5B)
  return !fs.existsSync(p);
}

async function gptReformulateSubject(subject, mainTopic, jobId) {
  if (!openai) {
    console.warn(`[5D][REFORM][${jobId}] OpenAI API key missing; skipping query reformulation.`);
    return null;
  }
  try {
    const prompt =
      `Rephrase this into a literal, short stock VIDEO search phrase (no metaphors): "${subject}".` +
      ` Context: ${mainTopic || ''}`;
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
  return text.split(/\s+/).filter(w => w.length > 3)[0] || text;
}

// Try to lock on a famous landmark mentioned in context (small boost path).
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
    const r2Files = await findR2ClipForScene.getAllFiles();
    for (const key of r2Files) {
      if (usedClips.includes(key)) continue;
      if (String(key).toLowerCase().includes(landmark.replace(/\s+/g, '_'))) {
        console.log(`[5D][CONTEXT][${jobId}] Landmark override matched "${landmark}" -> "${key}"`);
        // Do NOT assert here; R2 keys are validated after download in 5B.
        usedClips.push(key);
        return key;
      }
    }
  } catch (err) {
    console.error(`[5D][CONTEXT][${jobId}] Landmark override failed:`, err);
  }
  return null;
}

// Produce a Ken Burns VIDEO locally from a chosen image file.
// Always returns a path to a real .mp4 to keep 5B flow happy.
async function kenBurnsVideoFromImagePath(imgPath, workDir, sceneIdx, jobId) {
  try {
    const safeDir = workDir || path.join(__dirname, '..', 'jobs', `kb-${jobId || 'job'}`);
    if (!fs.existsSync(safeDir)) fs.mkdirSync(safeDir, { recursive: true });

    // If the provider already saved it locally, great. If it's a remote URL, that should have been downloaded by the provider.
    // We still preprocess to guaranteed 1080x1920 JPEG, then pan (no zoom).
    const prepped = path.join(safeDir, `kb-prepped-${uuidv4()}.jpg`);
    await preprocessImageToJpeg(imgPath, prepped, jobId);

    const outVid = path.join(safeDir, `kbvid-${uuidv4()}.mp4`);
    await makeKenBurnsVideoFromImage(prepped, outVid, 5, jobId);
    if (!assertLocalFileExists(outVid, 'KENBURNS_OUT', 2048)) {
      // Try static fallback (never fails)
      await staticImageToVideo(prepped, outVid, 5, jobId);
    }
    console.log(`[5D][KENBURNS][${jobId}] Built local KB video from image: ${outVid}`);
    return outVid;
  } catch (err) {
    console.error(`[5D][KENBURNS][${jobId}][ERR] Could not build from image (${imgPath}).`, err);
    return null;
  }
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
  categoryFolder,
  prevVisualSubjects = [],
}) {
  let searchSubject = subject;

  // Anchor subject for the hook/mega scenes
  if (isMegaScene || sceneIdx === 0) {
    try {
      let anchors = await extractVisualSubjects(megaSubject || mainTopic || allSceneTexts?.[0], mainTopic);
      anchors = (anchors || []).filter(s => !!s && !GENERIC_SUBJECTS.includes((s || '').toLowerCase()));
      if (anchors.length) {
        searchSubject = anchors[0];
        console.log(`[5D][ANCHOR][${jobId}] Using anchor subject: "${searchSubject}"`);
      }
    } catch (err) {
      console.error(`[5D][ANCHOR][${jobId}] Extraction error:`, err);
    }
  }

  if (!searchSubject || GENERIC_SUBJECTS.includes((searchSubject || '').toLowerCase())) {
    searchSubject = mainTopic || allSceneTexts?.[0] || subject || 'topic';
    console.log(`[5D][FALLBACK][${jobId}] Using fallback subject: "${searchSubject}"`);
  }

  if (forceClipPath) {
    console.log(`[5D][FORCE][${jobId}] Forced clip: ${forceClipPath}`);
    // Accept forced path (R2 or local). Validation will happen downstream if needed.
    return forceClipPath;
  }

  // Try extra subject hints in parallel
  let extractedSubjects = [];
  const subjectExtractors = [
    ['MULTI', extractMultiSubjectVisual],
    ['QUESTION', extractQuestionVisual],
    ['SYMBOLIC', extractSymbolicVisualSubject],
    ['EMOTION', extractEmotionActionVisual],
  ];
  await Promise.all(subjectExtractors.map(async ([label, fn]) => {
    try {
      const res = await fn(searchSubject, mainTopic);
      if (res && !GENERIC_SUBJECTS.includes((res || '').toLowerCase())) {
        extractedSubjects.push(res);
        console.log(`[5D][SUBJECT][${label}] ${res}`);
      }
    } catch (err) {
      console.error(`[5D][${label}][${jobId}][ERR]`, err);
    }
  }));

  try {
    const prioritized = await extractVisualSubjects(searchSubject, mainTopic);
    (prioritized || []).forEach(s => {
      if (s && !GENERIC_SUBJECTS.includes((s || '').toLowerCase())) extractedSubjects.push(s);
    });
    console.log(`[5D][SUBJECT][PRIORITIZED]`, prioritized);
  } catch (err) {
    console.error(`[5D][LITERAL][${jobId}][ERR]`, err);
  }

  if (!extractedSubjects.length) extractedSubjects.push(searchSubject);
  extractedSubjects = [...new Set(extractedSubjects)];

  let finalSubjects = [];
  for (let sub of extractedSubjects) {
    try {
      const varied = await breakRepetition(sub, prevVisualSubjects || [], { maxRepeats: 2 });
      if (varied && !finalSubjects.includes(varied)) finalSubjects.push(varied);
    } catch {
      finalSubjects.push(sub);
    }
  }

  // If a known landmark appears, try a quick R2 override
  const contextOverride = await tryContextualLandmarkOverride(finalSubjects[0], mainTopic, usedClips, jobId);
  if (contextOverride) return contextOverride;

  // Collect candidates
  let videoCandidates = [];
  let imageCandidates = [];

  for (const subjectOption of finalSubjects) {
    // Video lookups in parallel
    await Promise.all([
      (async () => {
        if (findR2ClipForScene.getAllFiles) {
          try {
            const r2Files = await findR2ClipForScene.getAllFiles(subjectOption, categoryFolder);
            // Push as R2 keys (no local assert)
            r2Files.forEach(key => {
              if (!usedClips.includes(key)) {
                videoCandidates.push({ path: key, source: 'R2', isVideo: true, subject: subjectOption });
              }
            });
            console.log(`[5D][R2][${jobId}] +${r2Files.length} candidates for "${subjectOption}"`);
          } catch (err) {
            console.error(`[5D][R2][${jobId}][ERR]`, err);
          }
        }
      })(),
      (async () => {
        try {
          const res = await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
          const p = res?.path || res;
          if (p && !usedClips.includes(p) && assertLocalFileExists(p, 'PEXELS_VIDEO_RESULT')) {
            videoCandidates.push({ path: p, source: 'PEXELS_VIDEO', isVideo: true, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PEXELS_VIDEO][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          const res = await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
          const p = res?.path || res;
          if (p && !usedClips.includes(p) && assertLocalFileExists(p, 'PIXABAY_VIDEO_RESULT')) {
            videoCandidates.push({ path: p, source: 'PIXABAY_VIDEO', isVideo: true, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PIXABAY_VIDEO][${jobId}][ERR]`, err);
        }
      })()
    ]);

    // Photo lookups in parallel (fallback tier, only used if no video found)
    await Promise.all([
      (async () => {
        try {
          const res = await findPexelsPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
          if (res && !usedClips.includes(res) && assertLocalFileExists(res, 'PEXELS_PHOTO_RESULT', 4096)) {
            imageCandidates.push({ path: res, source: 'PEXELS_PHOTO', isVideo: false, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PEXELS_PHOTO][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          const res = await findPixabayPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
          if (res && !usedClips.includes(res) && assertLocalFileExists(res, 'PIXABAY_PHOTO_RESULT', 4096)) {
            imageCandidates.push({ path: res, source: 'PIXABAY_PHOTO', isVideo: false, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PIXABAY_PHOTO][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          const res = await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext);
          if (res && !usedClips.includes(res) && assertLocalFileExists(res, 'UNSPLASH_RESULT', 4096)) {
            imageCandidates.push({ path: res, source: 'UNSPLASH', isVideo: false, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][UNSPLASH][${jobId}][ERR]`, err);
        }
      })()
    ]);
  }

  // If no video yet, try a single reformulation pass then re-run
  if (!videoCandidates.length) {
    const reformulated =
      (await gptReformulateSubject(finalSubjects[0], mainTopic, jobId)) ||
      backupKeywordExtraction(finalSubjects[0]);

    if (reformulated && reformulated !== finalSubjects[0]) {
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

  // Score candidates
  videoCandidates.forEach(c => { c.score = scoreSceneCandidate(c, c.subject, usedClips, true); });
  imageCandidates.forEach(c => { c.score = scoreSceneCandidate(c, c.subject, usedClips, false); });

  // Keep reasonably-good candidates
  videoCandidates = videoCandidates.filter(c => c.score >= 65).sort((a, b) => b.score - a.score);
  imageCandidates = imageCandidates.filter(c => c.score >= 70).sort((a, b) => b.score - a.score);

  // *** VIDEO ALWAYS WINS if any present ***
  if (videoCandidates.length) {
    const best = videoCandidates[0];
    usedClips.push(best.path);
    console.log(`[5D][RESULT][VIDEO][${jobId}]`, { path: best.path, source: best.source, score: best.score, subj: best.subject });
    return best.path; // R2 key or local file; 5B handles both
  }

  // Otherwise, fallback to image → build a local Ken Burns video NOW and return the .mp4 path
  if (imageCandidates.length) {
    const bestImg = imageCandidates[0];
    console.log(`[5D][RESULT][IMAGE->KB][${jobId}]`, { path: bestImg.path, source: bestImg.source, score: bestImg.score, subj: bestImg.subject });

    const kbVid = await kenBurnsVideoFromImagePath(bestImg.path, workDir, sceneIdx, jobId);
    if (kbVid && assertLocalFileExists(kbVid, 'KB_OUT', 2048)) {
      usedClips.push(bestImg.path); // de-dupe on original image path
      return kbVid;
    }

    // If KB somehow failed, still return the raw image path (5B will likely fail on trim; but we try not to hit this)
    console.warn(`[5D][IMAGE_FALLBACK][${jobId}] Ken Burns build failed; returning image path (not ideal).`);
    return bestImg.path;
  }

  // Nothing found — try any R2 fallback (without exists assert; 5B will fetch)
  if (findR2ClipForScene.getAllFiles) {
    try {
      const r2Files = await findR2ClipForScene.getAllFiles();
      const fallback = r2Files.find(f => !usedClips.includes(f));
      if (fallback) {
        console.warn(`[5D][FALLBACK][${jobId}] Using first-available R2 clip: ${fallback}`);
        return fallback;
      }
    } catch (err) {
      console.error(`[5D][R2_FALLBACK][${jobId}][ERR]`, err);
    }
  }

  // Absolute last resort: generate a black static video via 10D helpers (handled in 5B if needed)
  console.error(`[5D][NO_MATCH][${jobId}] No match found for scene ${sceneIdx + 1}`);
  return null;
}

module.exports = { findClipForScene };
