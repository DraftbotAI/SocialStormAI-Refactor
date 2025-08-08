// ============================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT (Job Controller)
// The /api/generate-video route handler. Full job orchestration.
// MAX LOGGING EVERYWHERE, User-friendly status messages!
// NO DUPLICATE CLIPS IN A SINGLE VIDEO — ABSOLUTE
// ACCURATE PROGRESS BAR (No more stuck at 95%)
// 2024-08: Uploads to R2 "videos" bucket BEFORE player returns URL,
// then archives to "library" after video is ready
//
// 2025-08 updates:
// - FORCE video output: if a provider returns an image, convert to Ken Burns immediately.
// - Progress bar smoothing: redistributed phase percentages, added granular updates
//   for upload/archive so it won’t “hang” at 94–95%.
// - Stronger file/materialization checks and clearer logs.
// ============================================================

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const { s3Client, PutObjectCommand } = require('./section1-setup.cjs');

const {
  bulletproofScenes,
  splitScriptToScenes,
} = require('./section5c-script-scene-utils.cjs');

const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');

const {
  concatScenes,
  ensureAudioStream,
  overlayMusic,
  appendOutro,
  getUniqueFinalName,
  pickMusicForMood,
} = require('./section5g-concat-and-music.cjs');

const {
  getDuration,
  trimForNarration,
  muxVideoWithNarration,
  getVideoInfo: getVideoInfoLocal, // may be missing in older 5F — we guard below
  standardizeVideo: standardizeVideoLocal,
} = require('./section5f-video-processing.cjs');

const { findClipForScene } = require('./section5d-clip-matcher.cjs');
const { cleanupJob } = require('./section5h-job-cleanup.cjs');
const { uploadSceneClipToR2, cleanForFilename } = require('./section10e-upload-to-r2.cjs');

// Ken Burns helpers (10D). generatePlaceholderKenBurns may not exist yet;
// we soft-require and fall back to an internal ffmpeg placeholder if missing.
let fallbackKenBurnsVideo = null;
let generatePlaceholderKenBurns = null;
try {
  const kb = require('./section10d-kenburns-image-helper.cjs');
  fallbackKenBurnsVideo = kb.fallbackKenBurnsVideo || null;
  generatePlaceholderKenBurns = kb.generatePlaceholderKenBurns || null;
  console.log('[5B][INIT] 10D Ken Burns helpers loaded.');
} catch (e) {
  console.warn('[5B][INIT][WARN] 10D Ken Burns helper not found. Will synthesize placeholder if needed.');
}

const OpenAI = require('openai');

console.log('[5B][INIT] section5b-generate-video-endpoint.cjs loaded');

// === CACHES ===
const audioCacheDir = path.resolve(__dirname, '..', 'audio_cache');
const videoCacheDir = path.resolve(__dirname, '..', 'video_cache');
if (!fs.existsSync(audioCacheDir)) fs.mkdirSync(audioCacheDir, { recursive: true });
if (!fs.existsSync(videoCacheDir)) fs.mkdirSync(videoCacheDir, { recursive: true });

// === HELPERS ===
function hashForCache(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function assertFileExists(file, label) {
  const exists = fs.existsSync(file);
  const size = exists ? fs.statSync(file).size : 0;
  if (!exists || size < 10240) {
    throw new Error(`[5B][${label}][ERR] File does not exist or is too small: ${file} (${size} bytes)`);
  }
}

function isLikelyImage(p) {
  const s = String(p || '').toLowerCase();
  return /\.(jpe?g|png|webp|gif|bmp|tiff?)$/.test(s);
}
function isLikelyVideo(p) {
  const s = String(p || '').toLowerCase();
  return /\.(mp4|mov|m4v|webm|mkv|avi)$/.test(s);
}

// Normalize a clip source into {type,value}
// - http(s) → remote URL (we do not fetch here)
// - absolute/local path → local
// - anything else → r2 key
function classifyClipSrc(srcPath) {
  const s = String(srcPath || '');
  if (/^https?:\/\//i.test(s)) return { type: 'url', value: s };
  if (path.isAbsolute(s) || s.startsWith('./') || s.startsWith('../')) return { type: 'local', value: s };
  return { type: 'r2', value: s.replace(/^\/+/, '') };
}

// INTEL download/copy: R2 object or local file.
// If src is local and exists → copy into localPath (so later cleanup is easy).
// If src is an R2 key → try R2 library bucket, then videos bucket.
// If src is a URL → we *assume* origin fetch happened upstream; fail back if missing.
async function ensureLocalClipExists(srcPath, localPath) {
  const kind = classifyClipSrc(srcPath);

  try {
    if (kind.type === 'local') {
      if (fs.existsSync(kind.value) && fs.statSync(kind.value).isFile()) {
        if (path.resolve(kind.value) !== path.resolve(localPath)) {
          fs.copyFileSync(kind.value, localPath);
          console.log(`[5B][LOCAL][COPY] Copied local clip → ${localPath}`);
        } else {
          console.log(`[5B][LOCAL][SKIP] Clip already at local target: ${localPath}`);
        }
        return localPath;
      } else {
        console.warn(`[5B][LOCAL][MISS] Local file not found: ${kind.value}`);
        throw new Error('Local clip missing');
      }
    }

    if (kind.type === 'r2') {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const requestedKey = String(kind.value || '').replace(/^\/+/, '');
      const bucketsInOrder = [
        process.env.R2_LIBRARY_BUCKET || 'socialstorm-library',
        process.env.R2_VIDEOS_BUCKET  || 'socialstorm-videos',
      ];

      let lastErr = null;
      for (const bucket of bucketsInOrder) {
        try {
          console.log(`[5B][R2][TRY] bucket=${bucket} key=${requestedKey} → ${localPath}`);
          const data = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: requestedKey }));
          const fileStream = fs.createWriteStream(localPath);
          await new Promise((resolve, reject) => {
            data.Body.pipe(fileStream);
            data.Body.on('error', reject);
            fileStream.on('finish', resolve);
          });
          console.log(`[5B][R2][OK] Downloaded from bucket=${bucket} key=${requestedKey} → ${localPath}`);
          return localPath;
        } catch (e) {
          lastErr = e;
          const code = e && (e.Code || e.name) ? (e.Code || e.name) : 'UnknownError';
          console.warn(`[5B][R2][MISS] bucket=${bucket} key=${requestedKey} → ${code}`);
        }
      }

      console.error(`[5B][R2][FAIL] All buckets failed for key=${requestedKey}`);
      throw lastErr || new Error('R2 download failed across library and videos');
    }

    // URL (http/https) → not supported to fetch here
    console.warn(`[5B][URL][WARN] Got a URL for clip, but no local fetcher here: ${srcPath}`);
    throw new Error('URL clip not locally available');
  } catch (err) {
    console.error(`[5B][CLIP_FETCH][FAIL] Could not materialize clip locally for src=${srcPath}`, err);
    throw err;
  }
}

// Emergency placeholder generator if 10D.generatePlaceholderKenBurns is unavailable.
// Creates a 3s 1080x1920 MP4 with black background and centered subject text.
async function synthesizePlaceholderKenBurns(subject, workDir, sceneIdx, jobId) {
  const safeIdx = String(sceneIdx).padStart(2, '0');
  const outPath = path.join(workDir, `kb_placeholder_${safeIdx}.mp4`);
  const text = (subject || 'No Visual').replace(/:/g, '\\:').slice(0, 64);
  return new Promise((resolve, reject) => {
    const cmd =
      `ffmpeg -y -f lavfi -i color=c=black:s=1080x1920:d=3 ` +
      `-vf "drawtext=text='${text}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2,` +
      `zoompan=z='min(zoom+0.0015,1.1)':d=90:fps=30" ` +
      `-pix_fmt yuv420p -r 30 -c:v libx264 "${outPath}"`;
    console.log(`[5B][KB_PLACEHOLDER][${jobId}] ${cmd}`);
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error('[5B][KB_PLACEHOLDER][ERR]', err, stderr);
        return reject(err);
      }
      console.log('[5B][KB_PLACEHOLDER][OK]', outPath);
      resolve(outPath);
    });
  });
}

async function ensureKenBurnsClip(subject, workDir, sceneIdx, jobId, usedClips) {
  // Try 10D fallback first (if available)
  if (typeof fallbackKenBurnsVideo === 'function') {
    try {
      const p = await fallbackKenBurnsVideo(subject, workDir, sceneIdx, jobId, usedClips);
      if (p) return p;
      console.warn(`[5B][KB][${jobId}] 10D fallback returned null, generating placeholder...`);
    } catch (e) {
      console.warn(`[5B][KB][${jobId}] 10D fallback threw, generating placeholder...`, e);
    }
  }
  // If 10D has generatePlaceholderKenBurns, use it; else synthesize internally.
  if (typeof generatePlaceholderKenBurns === 'function') {
    return await generatePlaceholderKenBurns(subject, workDir, sceneIdx, jobId);
  }
  return await synthesizePlaceholderKenBurns(subject, workDir, sceneIdx, jobId);
}

// === GPT CLIENT (for category fallback) ===
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// === CATEGORY DETECTION (regex first, GPT fallback, then misc) ===
async function getCategoryFolder(mainTopic) {
  const lower = (mainTopic || '').toLowerCase();
  const regexCategories = [
    { re: /haunt|castle|ghost|lore|myth|mystery|history|horror/, cat: 'lore_history_mystery_horror' },
    { re: /basketball|soccer|sports|lebron|fitness|exercise|workout|football/, cat: 'sports_fitness' },
    { re: /car|truck|tesla|vehicle|drive|race/, cat: 'cars_vehicles' },
    { re: /chimp|chimpanzee|ape|gorilla|orangutan|primate/, cat: 'animals_primates' },
    { re: /food|cook|recipe|kitchen|ziti|meatball|bake|meal/, cat: 'food_cooking' },
    { re: /wellness|health|medical|doctor|treatment/, cat: 'health_wellness' },
    { re: /holiday|christmas|halloween|birthday|celebrate/, cat: 'holidays_events' },
    { re: /emotion|feel|sad|happy|angry|love|cry|smile/, cat: 'human_emotion_social' },
    { re: /kid|child|baby|family|parent/, cat: 'kids_family' },
    { re: /love|relationship|date|couple|romance/, cat: 'love_relationships' },
    { re: /money|business|success|profit|finance|stock/, cat: 'money_business_success' },
    { re: /motivate|inspire|success|goal|achievement/, cat: 'motivation_success' },
    { re: /music|dance|sing|band|song/, cat: 'music_dance' },
    { re: /science|nature|animal|earth|planet|tree/, cat: 'science_nature' },
    { re: /sport|fitness|workout|exercise/, cat: 'sports_fitness' },
    { re: /tech|innovation|gadget|app|robot/, cat: 'technology_innovation' },
    { re: /travel|adventure|trip|journey|tourist|vacation/, cat: 'travel_adventure' },
    { re: /viral|trend|tiktok|reels|shorts/, cat: 'viral_trendy_content' },
  ];

  for (const { re, cat } of regexCategories) {
    if (re.test(lower)) {
      console.log(`[5B][CATEGORY][REGEX] Matched → ${cat}`);
      return cat;
    }
  }

  console.log('[5B][CATEGORY][REGEX] No match. Trying GPT fallback...');
  if (!openai) {
    console.warn('[5B][CATEGORY][GPT][SKIP] OPENAI_API_KEY missing. Using misc.');
    return 'misc';
  }
  try {
    const gptResp = await openai.chat.completions.create({
      model: process.env.CATEGORY_MODEL || 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content:
            'Classify the topic into one of these categories: ' +
            regexCategories.map(c => c.cat).join(', ') +
            '. Respond with only the category id, nothing else.',
        },
        { role: 'user', content: String(mainTopic || '').slice(0, 200) },
      ],
      max_tokens: 10,
      temperature: 0,
    });

    const category = (gptResp.choices?.[0]?.message?.content || '').trim();
    if (regexCategories.find(c => c.cat === category)) {
      console.log(`[5B][CATEGORY][GPT] Classified as → ${category}`);
      return category;
    } else {
      console.warn(`[5B][CATEGORY][GPT] Invalid GPT category "${category}". Falling back to misc.`);
    }
  } catch (err) {
    console.error('[5B][CATEGORY][GPT][ERR]', err);
  }

  return 'misc';
}

// === Simple concurrency limiter (no external deps) ===
function pLimit(max) {
  const queue = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      const fn = queue.shift();
      fn();
    }
  };

  const run = (fn, resolve, reject) => {
    activeCount++;
    Promise.resolve(fn())
      .then((val) => {
        resolve(val);
        next();
      })
      .catch((err) => {
        reject(err);
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      const task = () => run(fn, resolve, reject);
      if (activeCount < max) {
        task();
      } else {
        queue.push(task);
      }
    });
}

// ===========================================================
// REGISTER ENDPOINT
// ===========================================================
function registerGenerateVideoEndpoint(app, deps) {
  console.log('[5B][BOOT] Called registerGenerateVideoEndpoint...');
  if (!app) throw new Error('[5B][FATAL] No app passed in!');
  if (!deps) throw new Error('[5B][FATAL] No dependencies passed in!]');

  const {
    splitScriptToScenes: depSplitScriptToScenes,
    findClipForScene: depFindClipForScene, // not used directly; we use top-level findClipForScene
    createSceneAudio,
    createMegaSceneAudio,
    getAudioDuration,
    getVideoInfo: depGetVideoInfo,
    standardizeVideo: depStandardizeVideo,
    progress,
    voices,
    POLLY_VOICE_IDS,
  } = deps;

  // Prefer DI, else local imports, else no-op guard (we still continue safely)
  const getVideoInfo = typeof depGetVideoInfo === 'function'
    ? depGetVideoInfo
    : (typeof getVideoInfoLocal === 'function' ? getVideoInfoLocal : null);

  const standardizeVideo = typeof depStandardizeVideo === 'function'
    ? depStandardizeVideo
    : (typeof standardizeVideoLocal === 'function' ? standardizeVideoLocal : null);

  console.log(`[5B][CAPS] getVideoInfo: ${getVideoInfo ? 'OK' : 'MISSING'} | standardizeVideo: ${standardizeVideo ? 'OK' : 'MISSING'}`);

  if (typeof createSceneAudio !== 'function' || typeof createMegaSceneAudio !== 'function') {
    throw new Error('[5B][FATAL] Audio generation helpers missing!');
  }
  if (typeof depSplitScriptToScenes !== 'function') {
    throw new Error('[5B][FATAL] splitScriptToScenes missing from deps!');
  }

  // Safe wrapper: never throws, always returns structure
  async function getVideoInfoSafe(filePath) {
    try {
      if (!getVideoInfo) {
        console.warn('[5B][FFPROBE][WARN] getVideoInfo not available; returning null info');
        return { width: null, height: null, duration: null, fps: null, codec: null, hasAudio: null };
      }
      const info = await getVideoInfo(filePath);
      if (!info || typeof info !== 'object') {
        console.warn('[5B][FFPROBE][WARN] getVideoInfo returned invalid payload; normalizing');
        return { width: null, height: null, duration: null, fps: null, codec: null, hasAudio: null };
      }
      return info;
    } catch (e) {
      console.error('[5B][FFPROBE][ERR]', e);
      return { width: null, height: null, duration: null, fps: null, codec: null, hasAudio: null };
    }
  }

  console.log('[5B][INFO] Registering POST /api/generate-video route...');

  app.post('/api/generate-video', async (req, res) => {
    console.log('[5B][REQ] POST /api/generate-video');
    const jobId = uuidv4();
    if (!progress) {
      console.error('[5B][FATAL] No progress tracker found!');
      return res.status(500).json({ error: 'Internal progress tracker missing.' });
    }
    progress[jobId] = { percent: 0, status: 'Starting up...' };
    console.log(`[5B][INFO] New job started: ${jobId}`);
    res.json({ jobId });

    // --- MAIN VIDEO JOB HANDLER ---
    (async () => {
      const workDir = path.join(__dirname, '..', 'jobs', jobId);
      const jobContext = { sceneClipMetaList: [] };

      try {
        fs.mkdirSync(workDir, { recursive: true });
        progress[jobId] = { percent: 3, status: 'Setting up your project...' };

        const { script = '', voice = '', music = true, outro = true, provider = 'polly' } = req.body || {};
        if (!script || !voice) throw new Error('Missing script or voice');

        // Split and normalize scenes
        let scenes = depSplitScriptToScenes(script);
        scenes = Array.isArray(scenes) ? scenes : [];
        scenes = scenes.map((scene, idx) => {
          if (typeof scene === 'string') {
            return { texts: [scene], isMegaScene: idx === 1, type: idx === 0 ? 'hook-summary' : 'normal' };
          }
          if (scene && Array.isArray(scene.texts)) {
            return scene;
          }
          if (scene && typeof scene.text === 'string') {
            return { texts: [scene.text], ...scene };
          }
          return null;
        });
        scenes = scenes.filter(
          s => s && Array.isArray(s.texts) && typeof s.texts[0] === 'string' && s.texts[0].length > 0
        );
        if (!scenes.length) throw new Error('[5B][FATAL] No valid scenes found after filter!');

        // Main topic & category
        const allSceneTexts = scenes.flatMap(s => (Array.isArray(s.texts) ? s.texts : []));
        const mainTopic = allSceneTexts[0] || 'misc';
        const categoryFolder = await getCategoryFolder(mainTopic);
        jobContext.categoryFolder = categoryFolder;

        // Global de-duplication state shared across all scenes
        const usedClips = [];
        const sceneFiles = [];
        const sceneMeta = []; // track to resolve post-hoc dupes if any

        // ===========================================
        // SCENE 0: HOOK (serial)
        // ===========================================
        progress[jobId] = { percent: 8, status: 'Generating intro audio…' };
        const hookText = scenes[0].texts[0];
        const audioHashHook = hashForCache(JSON.stringify({ text: hookText, voice, provider }));
        const audioPathHook = path.join(audioCacheDir, `${audioHashHook}.mp3`);
        if (!fs.existsSync(audioPathHook) || fs.statSync(audioPathHook).size < 10000) {
          await deps.createSceneAudio(hookText, voice, audioPathHook, provider);
        }
        assertFileExists(audioPathHook, 'AUDIO_HOOK');

        progress[jobId] = { percent: 10, status: 'Finding first visual… (video preferred)' };
        let hookClipPath = null;
        try {
          hookClipPath = await findClipForScene({
            subject: scenes[0].visualSubject || hookText || mainTopic,
            sceneIdx: 0,
            allSceneTexts,
            mainTopic,
            isMegaScene: false,
            usedClips,
            workDir,
            jobId,
            jobContext,
            categoryFolder,
          });
        } catch (e) {
          console.warn(`[5B][HOOK][CLIP][WARN][${jobId}] No clip found for hook, will try Ken Burns fallback:`, e);
        }
        if (!hookClipPath) {
          console.warn(`[5B][HOOK][FALLBACK][${jobId}] No visual; using Ken Burns fallback for HOOK`);
          hookClipPath = await ensureKenBurnsClip(
            scenes[0].visualSubject || hookText || mainTopic,
            workDir,
            0,
            jobId,
            usedClips
          );
        }

        // *** FORCE VIDEO: if provider returned a still image, convert to Ken Burns now ***
        if (!isLikelyVideo(hookClipPath) && isLikelyImage(hookClipPath)) {
          console.log('[5B][HOOK][KB] Source appears to be an image; generating Ken Burns video…');
          hookClipPath = await ensureKenBurnsClip(
            scenes[0].visualSubject || hookText || mainTopic,
            workDir,
            0,
            jobId,
            usedClips
          );
        }

        const localHookClipPath = path.join(workDir, path.basename(hookClipPath));
        await ensureLocalClipExists(hookClipPath, localHookClipPath);

        // ARCHIVE RAW SOURCE (PEXELS/PIXABAY) — clean name, store in library
        try {
          const srcProvider =
            (hookClipPath || '').includes('pexels') ? 'pexels' :
            (hookClipPath || '').includes('pixabay') ? 'pixabay' : 'r2';
          if (srcProvider !== 'r2') {
            const subjectForName = cleanForFilename(scenes[0].visualSubject || hookText || mainTopic);
            await uploadSceneClipToR2(localHookClipPath, subjectForName, 0, 'library', categoryFolder);
            console.log(`[5B][ARCHIVE][RAW][S1] Archived raw ${srcProvider} source -> library`);
          }
        } catch (e) {
          console.warn('[5B][ARCHIVE][RAW][WARN][S1]', e);
        }

        progress[jobId] = { percent: 12, status: 'Aligning intro video to narration…' };
        const hookDuration = await getDuration(audioPathHook);
        const trimmedHookClip = path.join(
          videoCacheDir,
          `${hashForCache(localHookClipPath + audioPathHook)}-hooktrim.mp4`
        );
        await trimForNarration(localHookClipPath, trimmedHookClip, hookDuration, { loop: true });
        assertFileExists(trimmedHookClip, 'HOOK_TRIMMED_VIDEO');

        const hookMuxed = path.join(
          videoCacheDir,
          `${hashForCache(trimmedHookClip + audioPathHook)}-hookmux.mp4`
        );
        await muxVideoWithNarration(trimmedHookClip, audioPathHook, hookMuxed);
        assertFileExists(hookMuxed, 'HOOK_MUXED');

        sceneFiles[0] = hookMuxed;
        sceneMeta[0] = { sourceClipPath: hookClipPath, subject: scenes[0].visualSubject || hookText || mainTopic };
        jobContext.sceneClipMetaList.push({
          localFilePath: hookMuxed,
          subject: scenes[0].visualSubject || hookText || mainTopic,
          sceneIdx: 0,
          source: hookClipPath.includes('pexels') ? 'pexels' : hookClipPath.includes('pixabay') ? 'pixabay' : 'r2',
          category: categoryFolder,
        });

        // ===========================================
        // SCENE 1: MEGA (serial — subject anchored to scene 2)
        // ===========================================
        progress[jobId] = { percent: 16, status: 'Building mega scene…' };
        const scene2 = scenes[1];
        if (!scene2) throw new Error('[5B][FATAL] Mega scene missing!');

        const megaText = (scene2.texts && Array.isArray(scene2.texts)) ? scene2.texts.join(' ') : '';
        const audioHashMega = hashForCache(JSON.stringify({ text: megaText, voice, provider }));
        const audioPathMega = path.join(audioCacheDir, `${audioHashMega}-mega.mp3`);

        if (!fs.existsSync(audioPathMega) || fs.statSync(audioPathMega).size < 10000) {
          await deps.createSceneAudio(megaText, voice, audioPathMega, provider);
        }
        assertFileExists(audioPathMega, 'AUDIO_MEGA');

        let candidateSubjects = [];
        if (extractVisualSubjects) {
          try {
            candidateSubjects = await extractVisualSubjects(megaText, mainTopic);
            if (!Array.isArray(candidateSubjects) || !candidateSubjects.length) candidateSubjects = [];
          } catch (e) {
            console.warn('[5B][MEGA][WARN] GPT subject extract failed, falling back:', e);
          }
        }
        if (!candidateSubjects.length) candidateSubjects = [megaText, mainTopic];

        progress[jobId] = { percent: 18, status: 'Finding mega scene visual… (video preferred)' };
        let megaClipPath = null;
        for (const subj of candidateSubjects) {
          megaClipPath = await findClipForScene({
            subject: subj,
            sceneIdx: 1,
            allSceneTexts,
            mainTopic,
            isMegaScene: true,
            usedClips,
            workDir,
            jobId,
            megaSubject: subj,
            jobContext,
            categoryFolder,
          });
          if (megaClipPath) break;
        }
        if (!megaClipPath) {
          console.warn(`[5B][MEGA][FALLBACK][${jobId}] Using Ken Burns fallback for MEGA`);
          megaClipPath = await ensureKenBurnsClip(candidateSubjects[0] || mainTopic, workDir, 1, jobId, usedClips);
        }

        // *** FORCE VIDEO for mega scene too ***
        if (!isLikelyVideo(megaClipPath) && isLikelyImage(megaClipPath)) {
          console.log('[5B][MEGA][KB] Source appears to be an image; generating Ken Burns video…');
          megaClipPath = await ensureKenBurnsClip(candidateSubjects[0] || mainTopic, workDir, 1, jobId, usedClips);
        }

        const localMegaClipPath = path.join(workDir, path.basename(megaClipPath));
        await ensureLocalClipExists(megaClipPath, localMegaClipPath);

        // ARCHIVE RAW SOURCE (PEXELS/PIXABAY) — clean name, store in library
        try {
          const srcProvider =
            (megaClipPath || '').includes('pexels') ? 'pexels' :
            (megaClipPath || '').includes('pixabay') ? 'pixabay' : 'r2';
          if (srcProvider !== 'r2') {
            const subjectForName = cleanForFilename(candidateSubjects[0] || mainTopic);
            await uploadSceneClipToR2(localMegaClipPath, subjectForName, 1, 'library', categoryFolder);
            console.log('[5B][ARCHIVE][RAW][S2] Archived raw', srcProvider, 'source -> library');
          }
        } catch (e) {
          console.warn('[5B][ARCHIVE][RAW][WARN][S2]', e);
        }

        progress[jobId] = { percent: 20, status: 'Aligning mega scene to narration…' };
        const megaDuration = await getDuration(audioPathMega);
        const trimmedMegaClip = path.join(
          videoCacheDir,
          `${hashForCache(localMegaClipPath + audioPathMega)}-megatrim.mp4`
        );
        await trimForNarration(localMegaClipPath, trimmedMegaClip, megaDuration, { loop: true });
        assertFileExists(trimmedMegaClip, 'MEGA_TRIMMED_VIDEO');

        const megaMuxed = path.join(
          videoCacheDir,
          `${hashForCache(trimmedMegaClip + audioPathMega)}-megamux.mp4`
        );
        await muxVideoWithNarration(trimmedMegaClip, audioPathMega, megaMuxed);
        assertFileExists(megaMuxed, 'MEGA_MUXED');

        sceneFiles[1] = megaMuxed;
        sceneMeta[1] = { sourceClipPath: megaClipPath, subject: candidateSubjects[0] || mainTopic };
        jobContext.sceneClipMetaList.push({
          localFilePath: megaMuxed,
          subject: candidateSubjects[0] || mainTopic,
          sceneIdx: 1,
          source: megaClipPath.includes('pexels') ? 'pexels' : megaClipPath.includes('pixabay') ? 'pixabay' : 'r2',
          category: categoryFolder,
        });

        // ===========================================
        // SCENES 2+ : PARALLEL with concurrency cap + bulletproof fallback
        // ===========================================
        const totalScenes = scenes.length;
        const remainingCount = Math.max(totalScenes - 2, 0);

        // Progress plan:
        //  0– 8 setup
        //  8–12 hook audio/visual
        // 12–20 mega audio/visual
        // 20–60 remaining scenes (parallel)
        // 60–70 bulletproof/standardize
        // 70–78 concat
        // 78–84 ensure audio stream
        // 84–90 music
        // 90–94 outro
        // 94–98 upload to player bucket
        // 98–100 archive + done
        const pctBase = 20;
        const pctSpan = 40; // 20 -> 60
        const pctPerScene = remainingCount > 0 ? (pctSpan / remainingCount) : 0;
        let completedScenes = 0;

        const maxConc = Math.max(1, parseInt(process.env.MAX_CONCURRENT_SCENES || '3', 10));
        const limit = pLimit(maxConc);
        console.log(`[5B][PARALLEL] Processing ${remainingCount} scenes with concurrency=${maxConc}`);

        async function processOneScene(sceneIdx) {
          const scene = scenes[sceneIdx];
          let sceneSubject =
            scene.visualSubject ||
            (Array.isArray(scene.texts) && scene.texts[0]) ||
            allSceneTexts[sceneIdx];

          const GENERIC_SUBJECTS = ['face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something', 'body', 'eyes'];
          if (GENERIC_SUBJECTS.includes((sceneSubject || '').toLowerCase())) {
            sceneSubject = mainTopic;
          }

          const doWork = async () => {
            progress[jobId] = { percent: Math.min(59, Math.floor(pctBase + completedScenes * pctPerScene)), status: `Finding visual for scene ${sceneIdx + 1}…` };
            let clipPath = null;
            try {
              clipPath = await findClipForScene({
                subject: sceneSubject,
                sceneIdx,
                allSceneTexts,
                mainTopic,
                isMegaScene: false,
                usedClips,
                workDir,
                jobId,
                jobContext,
                categoryFolder,
              });
            } catch (e) {
              console.error(`[5B][CLIP][ERR][${jobId}] findClipForScene failed for scene ${sceneIdx + 1}:`, e);
            }

            if (!clipPath) {
              console.warn(`[5B][FALLBACK][${jobId}] No visual; using Ken Burns fallback for scene ${sceneIdx + 1}`);
              clipPath = await ensureKenBurnsClip(sceneSubject || mainTopic, workDir, sceneIdx, jobId, usedClips);
            }

            // *** FORCE VIDEO for normal scenes as well ***
            if (!isLikelyVideo(clipPath) && isLikelyImage(clipPath)) {
              console.log(`[5B][SCENE${sceneIdx + 1}][KB] Source appears to be an image; generating Ken Burns video…`);
              clipPath = await ensureKenBurnsClip(sceneSubject || mainTopic, workDir, sceneIdx, jobId, usedClips);
            }

            const localClipPath = path.join(workDir, path.basename(clipPath));
            await ensureLocalClipExists(clipPath, localClipPath);
            assertFileExists(localClipPath, `CLIP_SCENE_${sceneIdx + 1}`);

            // ARCHIVE RAW SOURCE (PEXELS/PIXABAY) — clean name, store in library
            try {
              const srcProvider =
                (clipPath || '').includes('pexels') ? 'pexels' :
                (clipPath || '').includes('pixabay') ? 'pixabay' : 'r2';
              if (srcProvider !== 'r2') {
                const subjectForName = cleanForFilename(sceneSubject || mainTopic);
                await uploadSceneClipToR2(localClipPath, subjectForName, sceneIdx, 'library', categoryFolder);
                console.log(`[5B][ARCHIVE][RAW][S${sceneIdx + 1}] Archived raw ${srcProvider} source -> library`);
              }
            } catch (e) {
              console.warn(`[5B][ARCHIVE][RAW][WARN][S${sceneIdx + 1}]`, e);
            }

            const audioHash = hashForCache(JSON.stringify({ text: scene.texts, voice, provider }));
            const audioCachePath = path.join(audioCacheDir, `${audioHash}.mp3`);
            if (!fs.existsSync(audioCachePath) || fs.statSync(audioCachePath).size < 10000) {
              await deps.createSceneAudio(scene.texts[0], voice, audioCachePath, provider);
            }
            assertFileExists(audioCachePath, `AUDIO_SCENE_${sceneIdx + 1}`);

            const narrationDuration = await getDuration(audioCachePath);
            const trimmedVideoPath = path.join(workDir, `scene${sceneIdx + 1}-trimmed.mp4`);
            await trimForNarration(localClipPath, trimmedVideoPath, narrationDuration);
            const videoCachePath = path.join(
              videoCacheDir,
              `${hashForCache(JSON.stringify({ text: scene.texts, voice, provider, clip: clipPath }))}.mp4`
            );
            await muxVideoWithNarration(trimmedVideoPath, audioCachePath, videoCachePath);
            assertFileExists(videoCachePath, `MUXED_SCENE_${sceneIdx + 1}`);

            jobContext.sceneClipMetaList.push({
              localFilePath: videoCachePath,
              subject: sceneSubject,
              sceneIdx,
              source: (clipPath || '').includes('pexels')
                ? 'pexels'
                : (clipPath || '').includes('pixabay')
                ? 'pixabay'
                : 'r2',
              category: categoryFolder,
            });

            sceneFiles[sceneIdx] = videoCachePath;
            sceneMeta[sceneIdx] = { sourceClipPath: clipPath, subject: sceneSubject };

            // Mark progress
            completedScenes += 1;
            const pct = Math.min(60, Math.floor(pctBase + completedScenes * pctPerScene));
            progress[jobId] = { percent: pct, status: `Processed scene ${sceneIdx + 1} of ${totalScenes}` };

            return true;
          };

          // Try parallel work, retry serially once on failure
          try {
            return await doWork();
          } catch (err) {
            console.warn(
              `[5B][PARALLEL][WARN][${jobId}] Scene ${sceneIdx + 1} failed in parallel. Retrying serially...`,
              err
            );
            try {
              return await doWork();
            } catch (err2) {
              console.error(`[5B][PARALLEL][FATAL][${jobId}] Scene ${sceneIdx + 1} failed again serially.`, err2);
              throw err2;
            }
          }
        }

        // Kick off scenes 2..N in parallel with limit
        const parallelPromises = [];
        for (let i = 2; i < totalScenes; i++) {
          parallelPromises.push(limit(() => processOneScene(i)));
        }
        await Promise.all(parallelPromises);

        // Final sanity de-dupe check (rare parallel race guard)
        const seenClip = new Set();
        for (let i = 0; i < sceneMeta.length; i++) {
          if (!sceneMeta[i]) continue;
          const key = sceneMeta[i].sourceClipPath || '';
          if (key && seenClip.has(key)) {
            console.warn(
              `[5B][DEDUPE][WARN][${jobId}] Duplicate clip detected post-parallel for scene ${i + 1}. Re-running serially.`
            );
            const idx = usedClips.indexOf(key);
            if (idx >= 0) usedClips.splice(idx, 1);
            await processOneScene(i);
          } else if (key) {
            seenClip.add(key);
          }
        }

        // ===========================================
        // CONCAT, AUDIO FIX, MUSIC, OUTRO, UPLOADS
        // ===========================================
        progress[jobId] = { percent: 62, status: 'Stitching your video together…' };

        progress[jobId] = { percent: 65, status: 'Checking video quality…' };
        const refInfo = await getVideoInfoSafe(sceneFiles[0]);
        console.log(`[5B][FFPROBE][REF] ${JSON.stringify(refInfo)}`);

        try {
          await bulletproofScenes(
            sceneFiles,
            refInfo,
            // pass safe adapters so bulletproofScenes can use them
            async (p) => await getVideoInfoSafe(p),
            standardizeVideo || (async (a,b,c) => { console.warn('[5B][STD][WARN] standardizeVideo missing, skipping'); return a; })
          );
          progress[jobId] = { percent: 70, status: 'Perfecting your video quality…' };
        } catch (e) {
          throw new Error(`[5B][BULLETPROOF][ERR][${jobId}] bulletproofScenes failed: ${e}`);
        }

        let concatPath;
        try {
          progress[jobId] = { percent: 74, status: 'Combining everything into one amazing video…' };
          concatPath = await concatScenes(sceneFiles, workDir, jobContext.sceneClipMetaList);
          assertFileExists(concatPath, 'CONCAT_OUT');
          progress[jobId] = { percent: 78, status: 'Combined successfully.' };
        } catch (e) {
          throw new Error(`[5B][CONCAT][ERR][${jobId}] concatScenes failed: ${e}`);
        }

        let withAudioPath = concatPath;
        try {
          progress[jobId] = { percent: 80, status: 'Finalizing your audio…' };
          withAudioPath = await ensureAudioStream(concatPath, workDir);
          assertFileExists(withAudioPath, 'AUDIOFIX_OUT');
          progress[jobId] = { percent: 84, status: 'Audio track ready.' };
        } catch (e) {
          throw new Error(`[5B][AUDIO][ERR][${jobId}] ensureAudioStream failed: ${e}`);
        }

        let musicPath = withAudioPath;
        if (music) {
          try {
            progress[jobId] = { percent: 85, status: 'Adding background music…' };
            const chosenMusic = pickMusicForMood ? await pickMusicForMood(script, workDir, jobId) : null;
            if (chosenMusic) {
              const musicOutput = path.join(workDir, getUniqueFinalName('with-music'));
              await overlayMusic(withAudioPath, chosenMusic, musicOutput);
              assertFileExists(musicOutput, 'MUSIC_OUT');
              musicPath = musicOutput;
              progress[jobId] = { percent: 90, status: 'Background music added.' };
            } else {
              progress[jobId] = { percent: 88, status: 'No music found, skipping…' };
            }
          } catch (e) {
            throw new Error(`[5B][MUSIC][ERR][${jobId}] overlayMusic failed: ${e}`);
          }
        } else {
          progress[jobId] = { percent: 88, status: 'Music skipped (user setting).' };
        }

        let finalPath = musicPath;
        let finalName = getUniqueFinalName('final-with-outro');
        if (outro) {
          const outroPath = path.join(__dirname, '..', 'public', 'assets', 'outro.mp4');
          if (fs.existsSync(outroPath)) {
            try {
              progress[jobId] = { percent: 91, status: 'Adding your outro…' };
              const outroOutput = path.join(workDir, finalName);
              await appendOutro(musicPath, outroPath, outroOutput, workDir);
              assertFileExists(outroOutput, 'OUTRO_OUT');
              finalPath = outroOutput;
              progress[jobId] = { percent: 94, status: 'Outro added!' };
            } catch (e) {
              throw new Error(`[5B][OUTRO][ERR][${jobId}] appendOutro failed: ${e}`);
            }
          } else {
            progress[jobId] = { percent: 92, status: 'Finalizing your masterpiece…' };
          }
        } else {
          progress[jobId] = { percent: 92, status: 'Outro skipped (user setting).' };
        }

        // === STEP 1: UPLOAD FINAL VIDEO TO VIDEOS BUCKET (PLAYER) ===
        let r2VideoUrl = null;
        try {
          progress[jobId] = { percent: 95, status: 'Uploading video to player bucket…' };
          r2VideoUrl = await uploadFinalToVideosBucket(finalPath, finalName, jobId, categoryFolder);
          progress[jobId] = { percent: 97, status: 'Player upload complete. Archiving to library…' };
        } catch (uploadErr) {
          progress[jobId] = {
            percent: -1,
            status: 'FAILED: Upload to player bucket',
            error: String(uploadErr),
            output: finalPath,
          };
          throw uploadErr;
        }

        // === STEP 2: ARCHIVE TO LIBRARY (FINAL VIDEO) ===
        try {
          const subjectForName = cleanForFilename(mainTopic);
          const finalSceneIdx = scenes.length - 1;
          await uploadSceneClipToR2(finalPath, subjectForName, finalSceneIdx, 'socialstorm', categoryFolder);
          progress[jobId] = { percent: 99, status: 'Archive complete. Wrapping up…' };
        } catch (e) {
          console.warn('[5B][ARCHIVE][LIBRARY][WARN] Could not archive video to library:', e);
          // Still finish; archive isn’t critical for player URL
          progress[jobId] = { percent: 99, status: 'Archive skipped. Wrapping up…' };
        }

        // === DONE! Player gets direct videos bucket link ===
        progress[jobId] = { percent: 100, status: 'Your video is ready! 🎉', output: r2VideoUrl };
      } catch (err) {
        console.error(`[5B][FATAL][JOB][${jobId}] Video job failed:`, err, err && err.stack ? err.stack : '');
        progress[jobId] = {
          percent: -1,
          status: `FAILED: ${err.message || err}`,
          error: err.message || err.toString(),
        };
      } finally {
        if (cleanupJob) {
          try {
            cleanupJob(jobId, jobContext);
          } catch (e) {
            console.warn(`[5B][CLEANUP][WARN][${jobId}] Cleanup failed:`, e);
          }
        }
      }
    })();
  });

  console.log('[5B][SUCCESS] /api/generate-video endpoint registered.');
}

console.log('[5B][EXPORT] registerGenerateVideoEndpoint exported');
module.exports = registerGenerateVideoEndpoint;

// === UPLOAD FINAL VIDEO TO R2 VIDEOS BUCKET (FOR PLAYER) ===
async function uploadFinalToVideosBucket(finalPath, finalName, jobId, categoryFolder) {
  const bucket = process.env.R2_VIDEOS_BUCKET || 'socialstorm-videos';
  const fileData = fs.readFileSync(finalPath);
  const key = `${categoryFolder}/jobs/${jobId}/${finalName}`;
  console.log(`[5B][R2][UPLOAD] Uploading final to bucket=${bucket} key=${key}`);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileData,
      ContentType: 'video/mp4',
    })
  );
  const urlBase = process.env.R2_PUBLIC_CUSTOM_DOMAIN || 'https://videos.socialstormai.com';
  const url = `${urlBase.replace(/\/$/, '')}/${categoryFolder}/jobs/${jobId}/${finalName}`;
  console.log('[5B][R2][UPLOAD][OK] Final uploaded:', url);
  return url;
}
