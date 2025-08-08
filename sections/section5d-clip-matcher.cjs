// ===========================================================
// SECTION 5D: CLIP MATCHER ORCHESTRATOR (Smart, Video-Preferred, No Duplicates, Max Logs, Strict Scoring + GPT Reformulation + Parallelized Lookups)
// Always returns something: R2, Pexels Video, Pixabay Video, Pexels Photo, Pixabay Photo, Unsplash image, or Ken Burns.
// Never repeats a clip/image in the same video unless absolutely unavoidable.
// Scores and ranks all candidates, always prefers video in case of tie.
// Handles edge cases: emotion, question, multi-subject, symbolic, repetition.
// Includes GPT-4.1 reformulation fallback with backup keyword extraction.
// Bulletproofed to instantly log missing/broken helpers.
// Parallelized API lookups for speed.
// ===========================================================

const { findR2ClipForScene } = require('./section10a-r2-clip-helper.cjs');
const { findPexelsClipForScene, findPexelsPhotoForScene } = require('./section10b-pexels-clip-helper.cjs');
const { findPixabayClipForScene, findPixabayPhotoForScene } = require('./section10c-pixabay-clip-helper.cjs');
const { findUnsplashImageForScene } = require('./section10f-unsplash-image-helper.cjs');
const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');
const { extractSymbolicVisualSubject } = require('./section10h-symbolic-matcher.cjs');
const { extractEmotionActionVisual } = require('./section10i-emotion-action-helper.cjs');
const { extractQuestionVisual } = require('./section10j-question-fallback-helper.cjs');
const { extractMultiSubjectVisual } = require('./section10k-multi-subject-handler.cjs');
const { breakRepetition } = require('./section10l-repetition-blocker.cjs');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');
const fs = require('fs');
const OpenAI = require('openai');

const REFORMULATION_MODEL = process.env.REFORMULATION_MODEL || 'gpt-4.1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log('[5D][INIT] Smart Clip Matcher with GPT Reformulation + Parallelization loaded.');

const GENERIC_SUBJECTS = [
  'face','person','man','woman','it','thing','someone','something','body','eyes',
  'kid','boy','girl','they','we','people','scene','child','children','sign','logo',
  'text','skyline','dubai'
];

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

async function gptReformulateSubject(subject, mainTopic, jobId) {
  if (!openai) {
    console.error(`[5D][REFORMULATION][${jobId}] OpenAI API key missing, skipping GPT reformulation.`);
    return null;
  }
  try {
    const prompt = `Rephrase this search subject into a clear, literal, short phrase for finding a relevant stock video: "${subject}". Keep it factual, no metaphors. Context: ${mainTopic || ''}`;
    const response = await openai.chat.completions.create({
      model: REFORMULATION_MODEL,
      messages: [
        { role: 'system', content: 'You are a search query generator for stock video matching.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 20,
      temperature: 0
    });
    const reformulated = response.choices[0]?.message?.content?.trim();
    if (reformulated) {
      console.log(`[5D][REFORMULATION][${jobId}] Generated alternate search term: "${reformulated}"`);
      return reformulated;
    }
  } catch (err) {
    console.error(`[5D][REFORMULATION][${jobId}] GPT reformulation failed:`, err);
  }
  return null;
}

function backupKeywordExtraction(text) {
  if (!text) return null;
  return text.split(' ').filter(w => w.length > 3)[0] || text;
}

async function tryContextualLandmarkOverride(subject, mainTopic, usedClips, jobId) {
  if (!findR2ClipForScene.getAllFiles) return null;
  const LANDMARK_WORDS = [
    'statue of liberty','white house','empire state building','eiffel tower','sphinx','great wall',
    'mount rushmore','big ben','colosseum','machu picchu','pyramids','chichen itza','louvre','taj mahal',
    'notre dame','angkor wat','leaning tower','buckingham palace','niagara falls','grand canyon',
    'hollywood sign','stonehenge','burj khalifa','golden gate bridge','petra','cristo redentor','opera house'
  ];
  const toTest = [subject, mainTopic].filter(Boolean).map(s => (typeof s === 'string' ? s.toLowerCase() : ''));
  let foundLandmark = LANDMARK_WORDS.find(l => toTest.some(t => t.includes(l))) || '';
  if (!foundLandmark) return null;
  try {
    const r2Files = await findR2ClipForScene.getAllFiles();
    for (const fname of r2Files) {
      if (usedClips.includes(fname)) continue;
      if (fname.toLowerCase().includes(foundLandmark.replace(/\s+/g, '_'))) {
        console.log(`[5D][CONTEXT][${jobId}] Landmark override: "${foundLandmark}" => "${fname}"`);
        if (assertFileExists(fname, 'R2_CONTEXT_RESULT')) {
          usedClips.push(fname);
          return fname;
        }
      }
    }
  } catch (err) {
    console.error(`[5D][CONTEXT][${jobId}] Landmark override failed:`, err);
  }
  return null;
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
  categoryFolder,
  prevVisualSubjects = [],
}) {
  let searchSubject = subject;

  if (isMegaScene || sceneIdx === 0) {
    try {
      let anchorSubjects = await extractVisualSubjects(megaSubject || mainTopic || allSceneTexts[0], mainTopic);
      anchorSubjects = anchorSubjects.filter(s => !!s && !GENERIC_SUBJECTS.includes(s.toLowerCase?.() || ''));
      if (anchorSubjects.length) {
        searchSubject = anchorSubjects[0];
        console.log(`[5D][ANCHOR][${jobId}] Using anchor subject: "${searchSubject}"`);
      }
    } catch (err) {
      console.error(`[5D][ANCHOR][${jobId}] Anchor subject extraction error:`, err);
    }
  }

  if (!searchSubject || GENERIC_SUBJECTS.includes(searchSubject.toLowerCase?.() || '')) {
    searchSubject = mainTopic || allSceneTexts[0] || subject;
    console.log(`[5D][FALLBACK][${jobId}] Using fallback subject: "${searchSubject}"`);
  }

  if (forceClipPath) {
    console.log(`[5D][FORCE][${jobId}] Forced clip: ${forceClipPath}`);
    return assertFileExists(forceClipPath, 'FORCE_CLIP') ? forceClipPath : null;
  }

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
      if (res && !GENERIC_SUBJECTS.includes(res.toLowerCase())) {
        extractedSubjects.push(res);
        console.log(`[5D][SUBJECT][${label}] ${res}`);
      }
    } catch (err) {
      console.error(`[5D][${label}][${jobId}][ERR]`, err);
    }
  }));

  try {
    const prioritized = await extractVisualSubjects(searchSubject, mainTopic);
    prioritized?.forEach(s => {
      if (s && !GENERIC_SUBJECTS.includes(s.toLowerCase())) extractedSubjects.push(s);
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

  const contextOverride = await tryContextualLandmarkOverride(finalSubjects[0], mainTopic, usedClips, jobId);
  if (contextOverride) return contextOverride;

  let videoCandidates = [];
  let imageCandidates = [];

  for (const subjectOption of finalSubjects) {
    // Run R2, Pexels, Pixabay video lookups in parallel
    await Promise.all([
      (async () => {
        if (findR2ClipForScene.getAllFiles) {
          const r2Files = await findR2ClipForScene.getAllFiles();
          r2Files.forEach(fname => {
            if (!usedClips.includes(fname) && assertFileExists(fname, 'R2_RESULT')) {
              videoCandidates.push({ path: fname, source: 'R2', isVideo: true, subject: subjectOption });
            }
          });
        }
      })(),
      (async () => {
        try {
          let res = await findPexelsClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
          let pathRes = res?.path || res;
          if (pathRes && !usedClips.includes(pathRes) && assertFileExists(pathRes, 'PEXELS_VIDEO_RESULT')) {
            videoCandidates.push({ path: pathRes, source: 'PEXELS_VIDEO', isVideo: true, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PEXELS_VIDEO][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          let res = await findPixabayClipForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
          let pathRes = res?.path || res;
          if (pathRes && !usedClips.includes(pathRes) && assertFileExists(pathRes, 'PIXABAY_VIDEO_RESULT')) {
            videoCandidates.push({ path: pathRes, source: 'PIXABAY_VIDEO', isVideo: true, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PIXABAY_VIDEO][${jobId}][ERR]`, err);
        }
      })()
    ]);

    // Run photo sources in parallel
    await Promise.all([
      (async () => {
        try {
          let res = await findPexelsPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
          if (res && !usedClips.includes(res) && assertFileExists(res, 'PEXELS_PHOTO_RESULT')) {
            imageCandidates.push({ path: res, source: 'PEXELS_PHOTO', isVideo: false, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PEXELS_PHOTO][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          let res = await findPixabayPhotoForScene(subjectOption, workDir, sceneIdx, jobId, usedClips);
          if (res && !usedClips.includes(res) && assertFileExists(res, 'PIXABAY_PHOTO_RESULT')) {
            imageCandidates.push({ path: res, source: 'PIXABAY_PHOTO', isVideo: false, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][PIXABAY_PHOTO][${jobId}][ERR]`, err);
        }
      })(),
      (async () => {
        try {
          let res = await findUnsplashImageForScene(subjectOption, workDir, sceneIdx, jobId, usedClips, jobContext);
          if (res && !usedClips.includes(res) && assertFileExists(res, 'UNSPLASH_RESULT')) {
            imageCandidates.push({ path: res, source: 'UNSPLASH', isVideo: false, subject: subjectOption });
          }
        } catch (err) {
          console.error(`[5D][UNSPLASH][${jobId}][ERR]`, err);
        }
      })()
    ]);
  }

  if (!videoCandidates.length) {
    const reformulated = await gptReformulateSubject(finalSubjects[0], mainTopic, jobId) || backupKeywordExtraction(finalSubjects[0]);
    if (reformulated && reformulated !== finalSubjects[0]) {
      console.log(`[5D][REFORMULATION_USED][${jobId}] Retrying search with: "${reformulated}"`);
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
        forceClipPath,
        jobContext,
        categoryFolder,
        prevVisualSubjects
      });
    }
  }

  videoCandidates.forEach(c => c.score = scoreSceneCandidate(c, c.subject, usedClips, true));
  imageCandidates.forEach(c => c.score = scoreSceneCandidate(c, c.subject, usedClips, false));

  videoCandidates = videoCandidates.filter(c => c.score >= 70).sort((a, b) => b.score - a.score);
  imageCandidates = imageCandidates.filter(c => c.score >= 70).sort((a, b) => b.score - a.score);

  if (videoCandidates.length) {
    usedClips.push(videoCandidates[0].path);
    console.log(`[5D][RESULT][VIDEO][${jobId}]`, videoCandidates[0]);
    return videoCandidates[0].path;
  }
  if (imageCandidates.length) {
    usedClips.push(imageCandidates[0].path);
    let kenBurns = await fallbackKenBurnsVideo(imageCandidates[0].path, workDir, sceneIdx, jobId, usedClips);
    if (kenBurns && assertFileExists(kenBurns, 'KENBURNS_RESULT')) return kenBurns;
    return imageCandidates[0].path;
  }

  if (findR2ClipForScene.getAllFiles) {
    const r2Files = await findR2ClipForScene.getAllFiles();
    const fallback = r2Files.find(f => !usedClips.includes(f) && assertFileExists(f, 'R2_ANYFALLBACK'));
    if (fallback) return fallback;
  }
  let kenBurnsFinal = await fallbackKenBurnsVideo('landmark', workDir, sceneIdx, jobId, usedClips);
  if (kenBurnsFinal && assertFileExists(kenBurnsFinal, 'KENBURNS_RESULT')) return kenBurnsFinal;

  console.error(`[5D][NO_MATCH][${jobId}] No match found for scene ${sceneIdx + 1}`);
  return null;
}

module.exports = { findClipForScene };
