// ============================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT (Job Controller)
// The /api/generate-video route handler. Full job orchestration.
// MAX LOGGING EVERYWHERE, User-friendly status messages!
//
// 2025-08 updates:
//  - R2-first pipeline
//  - Stopwords→AI scene subject flow (via Section 11)
//  - De-dupe handled ONLY within current video (jobContext), not across jobs
//  - Bulletproof scene normalization, caching, and quality checks
// ============================================================

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { extractSubjectByStopwords, extractSubjectByStopwordsDetailed } = require('./section10n-stopword-subject-extractor.cjs');
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
  pickMusicForMood
} = require('./section5g-concat-and-music.cjs');

const { findClipForScene } = require('./section5d-clip-matcher.cjs');

// ----------------- tiny utils -----------------
function norm(s) { return String(s || '').trim(); }
function hashForCache(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

function assertFileExists(file, label = 'FILE', minSize = 10240) {
  try {
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      if (size >= minSize) return true;
      console.warn(`[5B][ASSERT][WARN] ${label} exists but too small (${size} bytes): ${file}`);
      return false;
    }
    console.warn(`[5B][ASSERT][WARN] ${label} not found: ${file}`);
    return false;
  } catch (e) {
    console.error(`[5B][ASSERT][ERR] ${label} exception for ${file}:`, e);
    return false;
  }
}

function getDuration(audioPath) {
  return new Promise((resolve, reject) => {
    try {
      const ffprobe = require('ffprobe-static');
      const { spawn } = require('child_process');
      const proc = spawn(ffprobe.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
      let out = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => {});
      proc.on('close', (code) => {
        const n = parseFloat(out.trim());
        if (Number.isFinite(n)) {
          resolve(n);
        } else {
          reject(new Error(`ffprobe parse fail: "${out}"`));
        }
      });
    } catch (e) { reject(e); }
  });
}

async function trimForNarration(inVideo, outVideo, durationSec, { loop = false } = {}) {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('ffmpeg-static');
    const args = loop
      ? ['-y','-hide_banner','-stream_loop','-1','-i', inVideo,'-t', String(durationSec),'-c:v','libx264','-pix_fmt','yuv420p', outVideo]
      : ['-y','-hide_banner','-i', inVideo,'-t', String(durationSec),'-c:v','libx264','-pix_fmt','yuv420p', outVideo];
    console.log('[5B][FFMPEG][TRIM]', args.join(' '));
    const { spawn } = require('child_process');
    const proc = spawn(ffmpeg, args);
    proc.on('close', (code) => code === 0 ? resolve(true) : reject(new Error(`trimForNarration code=${code}`)));
  });
}

async function muxVideoWithNarration(inVideo, inAudio, outVideo) {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('ffmpeg-static');
    const args = ['-y','-hide_banner','-i', inVideo,'-i', inAudio,'-c:v','copy','-c:a','aac','-b:a','160k', outVideo];
    console.log('[5B][FFMPEG][MUX]', args.join(' '));
    const { spawn } = require('child_process');
    const proc = spawn(ffmpeg, args);
    proc.on('close', (code) => code === 0 ? resolve(true) : reject(new Error(`muxVideoWithNarration code=${code}`)));
  });
}

/**
 * Ensure a local file exists for a given source path:
 * - If src is already a local file → optionally copy to desiredPath (for naming consistency)
 * - If src is HTTP URL → download to desiredPath
 * - Else treat src as an R2 **library** key and download from R2_BUCKET || R2_LIBRARY_BUCKET into desiredPath
 */
async function ensureLocalClipExists(srcPath, desiredPath, jobId = '') {
  try {
    if (!srcPath) throw new Error('No srcPath provided');

    // 1) Already-local file?
    if (fs.existsSync(srcPath) && fs.statSync(srcPath).size > 10240) {
      if (srcPath === desiredPath) {
        console.log(`[5B][LOCAL][${jobId}] Using clip as-is: ${srcPath}`);
        return srcPath;
      }
      fs.copyFileSync(srcPath, desiredPath);
      console.log(`[5B][LOCAL][${jobId}] Copied to desired path: ${desiredPath}`);
      return desiredPath;
    }

    // 2) HTTP?
    if (/^https?:\/\//i.test(srcPath)) {
      console.log(`[5B][HTTP][${jobId}] Downloading ${srcPath} -> ${desiredPath}`);
      const axios = require('axios');
      const resp = await axios.get(srcPath, { responseType: 'arraybuffer', timeout: 60000 });
      fs.writeFileSync(desiredPath, Buffer.from(resp.data));
      return desiredPath;
    }

    // 3) R2 key
    const bucket = process.env.R2_BUCKET || process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
    console.log(`[5B][R2][GET][${jobId}] key=${srcPath} -> ${desiredPath} (bucket=${bucket})`);
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const obj = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: srcPath }));
    const stream = obj.Body;
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    fs.writeFileSync(desiredPath, Buffer.concat(chunks));
    console.log(`[5B][R2][GET][OK][${jobId}] Saved: ${desiredPath}`);
    return desiredPath;
  } catch (e) {
    console.error(`[5B][ENSURE-LOCAL][ERR][${jobId}] src=${srcPath}`, e);
    throw e;
  }
}

function getCategoryFolder(mainTopic) {
  const low = (mainTopic || '').toLowerCase();
  if (/manatee|dolphin|whale|shark|fish|seal|otter/.test(low)) return 'animals';
  if (/rome|fountain|temple|castle|bridge|tower|cathedral|square|plaza|ruins|palace|colosseum/.test(low)) return 'travel_landmarks';
  if (/food|recipe|kitchen|cook|cooking|bake|baking/.test(low)) return 'food_cooking';
  if (/ai|software|code|coding|javascript|python|app|tech|startup|hacker|debug/.test(low)) return 'tech_coding';
  return 'misc';
}

function deriveFallbackSubjects(line, mainTopic) {
  const subjects = [];
  const words = String(line || '').split(/\s+/).map(w => w.trim()).filter(Boolean);
  // naive two/three-grams that look like landmarks (last word head)
  for (let i = 0; i < words.length - 1; i++) {
    const two = `${words[i]} ${words[i+1]}`.toLowerCase();
    if (/\b(fountain|bridge|castle|temple|statue|cathedral|mosque|palace|museum|square|plaza|gate|arch|tower|mountain|river|lake|waterfall|beach)\b/.test(two)) {
      subjects.push(two);
      if (i+2 < words.length) {
        const three = `${two} ${words[i+2]}`.toLowerCase();
        if (three.length > 2) subjects.push(three);
      }
    }
  }
  if (!subjects.length) {
    for (let i = 0; i < words.length - 2; i++) {
      const two = `${words[i]} ${words[i+1]} ${words[i+2]}`.toLowerCase();
      if (two.length > 2) subjects.push(two);
    }
    subjects.push(...words.filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as'].includes(w.toLowerCase())));
  }
  if (mainTopic && !subjects.includes(mainTopic)) subjects.push(mainTopic);
  subjects.push('landmark', 'famous building', 'tourist attraction');
  return [...new Set(subjects.map(s => s.trim()).filter(Boolean))];
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
    findClipForScene: depFindClipForScene, // optional override
    createSceneAudio,
    createMegaSceneAudio, // unused but kept for compat
    getAudioDuration,     // optional in deps
    getVideoInfo, standardizeVideo,
    progress, voices, POLLY_VOICE_IDS,
  } = deps;

  if (typeof createSceneAudio !== "function")
    throw new Error('[5B][FATAL] createSceneAudio helper missing!');
  if (typeof getVideoInfo !== "function" || typeof standardizeVideo !== "function")
    throw new Error('[5B][FATAL] Video helpers missing from Section 5F/5G!');
  if (!progress) throw new Error('[5B][FATAL] No progress tracker (deps.progress)!');
    const cleanupJob = deps.cleanupJob;
  const split = typeof depSplitScriptToScenes === 'function' ? depSplitScriptToScenes : splitScriptToScenes;
  const findClip = typeof depFindClipForScene === 'function' ? depFindClipForScene : findClipForScene;

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
      const jobContext = { sceneClipMetaList: [], kbUsedCount: 0, clipsToIngest: [], usedClipKeys: new Set() };

      try {
        fs.mkdirSync(workDir, { recursive: true });
        const audioCacheDir = path.join(workDir, 'audio');
        const videoCacheDir = path.join(workDir, 'video');
        fs.mkdirSync(audioCacheDir, { recursive: true });
        fs.mkdirSync(videoCacheDir, { recursive: true });

        progress[jobId] = { percent: 2, status: 'Setting up your project...' };

        const { script = '', voice = '', music = true, outro = true, provider = 'polly' } = req.body || {};
        if (!script || !voice) throw new Error('Missing script or voice');
        let scenes = split(script);

        // === BULLETPROOF SCENE NORMALIZATION ===
        console.log(`[5B][SCENES][RAW][${jobId}]`, JSON.stringify(scenes, null, 2));
        scenes = Array.isArray(scenes) ? scenes : [];
        scenes = scenes.map((scene, idx) => {
          if (typeof scene === 'string') {
            console.log(`[5B][SCENES][NORMALIZE][${jobId}] Scene ${idx + 1} was string, wrapping.`);
            return { texts: [scene], isMegaScene: idx === 1, type: idx === 0 ? 'hook-summary' : 'normal' };
          }
          if (scene && Array.isArray(scene.texts)) {
            return scene;
          }
          if (scene && typeof scene.text === 'string') {
            console.log(`[5B][SCENES][NORMALIZE][${jobId}] Scene ${idx + 1} had 'text' field, converting to texts array.`);
            return { texts: [scene.text], ...scene };
          }
          return null;
        });

        console.log(`[5B][SCENES][NORM][${jobId}]`, JSON.stringify(scenes, null, 2));

        scenes = scenes.filter(s =>
          s && Array.isArray(s.texts) && typeof s.texts[0] === 'string' && s.texts[0].length > 0
        );
        if (!scenes.length) throw new Error('[5B][FATAL] No valid scenes found after filter!');

        const allSceneTexts = scenes.flatMap(s => Array.isArray(s.texts) ? s.texts : []);
        let mainTopic = (req.body && typeof req.body.mainTopic === 'string' && req.body.mainTopic.trim())
          ? req.body.mainTopic.trim()
          : null;
        if (!mainTopic) {
          console.log(`[5B][TOPIC][${jobId}] Deriving mainTopic via 10N across full script...`);
          try {
            const freq = new Map();
            for (const line of allSceneTexts) {
              try {
                const sub = extractSubjectByStopwords(line, '');
                const key = (sub || '').toLowerCase().trim();
                if (key) freq.set(key, (freq.get(key) || 0) + 1);
              } catch (e) { console.warn(`[5B][TOPIC][WARN][${jobId}] 10N failed on line:`, e); }
            }
            const best = [...freq.entries()].sort((a,b)=>b[1]-a[1])[0];
            if (best && best[0]) mainTopic = best[0];
          } catch (e) {
            console.warn(`[5B][TOPIC][WARN][${jobId}] Derive failed, fallback to hook text:`, e);
          }
        }
        if (!mainTopic) mainTopic = allSceneTexts[0] || 'misc';
        console.log(`[5B][TOPIC][${jobId}] mainTopic="${mainTopic}" (strict=${process.env.SS_SUBJECT_STRICT||'1'})`);
        const categoryFolder = getCategoryFolder(mainTopic);
        jobContext.categoryFolder = categoryFolder;

        const sceneFiles = [];
        console.log(`[5B][DEDUPE][${jobId}] In-job usedClipKeys initialized (size=${jobContext.usedClipKeys.size})`);

        // === HOOK SCENE ===
        const hookText = scenes[0].texts[0];
        const audioHashHook = hashForCache(JSON.stringify({ text: hookText, voice, provider }));
        const audioPathHook = path.join(audioCacheDir, `${audioHashHook}-hook.mp3`);

        if (!fs.existsSync(audioPathHook) || fs.statSync(audioPathHook).size < 10000) {
          console.log(`[5B][TTS][HOOK][${jobId}] Generating narration...`);
          await createSceneAudio(hookText, voice, audioPathHook, provider);
        } else {
          console.log(`[5B][TTS][HOOK][${jobId}] Using cached narration: ${audioPathHook}`);
        }

        // Try subject extraction for hook to improve clip matching
        let hookSubjects = [];
        try {
          hookSubjects = await extractVisualSubjects(hookText, mainTopic);
        } catch (e) { console.warn(`[5B][HOOK][SUBJECT][WARN][${jobId}]`, e); }

        let hookClipPath = null;
        try {
          hookClipPath = await findClipForScene({
            subject: hookSubjects?.[0] || hookText || mainTopic,
            sceneIdx: 0,
            allSceneTexts,
            mainTopic,
            isMegaScene: false,
            workDir,
            jobId,
            jobContext,
            categoryFolder
          });
        } catch (e) {
          console.warn(`[5B][HOOK][CLIP][WARN][${jobId}] No clip found for hook, using fallback:`, e);
        }
        if (!hookClipPath) {
          const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
          hookClipPath = await fallbackKenBurnsVideo(scenes[0].visualSubject || hookText || mainTopic, workDir, 0, jobId);
        }
        if (!hookClipPath) throw new Error(`[5B][HOOK][${jobId}] Failed to obtain hook clip`);

        // Localize/standardize hook clip path
        const hookBase = path.basename(hookClipPath);
        const localHookClipPath = path.join(workDir, hookBase);
        await ensureLocalClipExists(hookClipPath, localHookClipPath, jobId);
        if (!assertFileExists(localHookClipPath, 'HOOK_CLIP_LOCAL')) throw new Error('Hook clip localization failed');

        const hookDuration = await getDuration(audioPathHook);
        const trimmedHookClip = path.join(videoCacheDir, `${hashForCache(localHookClipPath + audioPathHook)}-hooktrim.mp4`);
        await trimForNarration(localHookClipPath, trimmedHookClip, hookDuration, { loop: true });
        if (!assertFileExists(trimmedHookClip, 'HOOK_TRIMMED_VIDEO')) throw new Error('Hook trimming failed');

        const hookMuxed = path.join(videoCacheDir, `${hashForCache(trimmedHookClip + audioPathHook)}-hookmux.mp4`);
        await muxVideoWithNarration(trimmedHookClip, audioPathHook, hookMuxed);
        if (!assertFileExists(hookMuxed, 'HOOK_MUXED')) throw new Error('Hook mux failed');

        sceneFiles[0] = hookMuxed;
        jobContext.sceneClipMetaList.push({
          localFilePath: hookMuxed,
          subject: scenes[0].visualSubject || hookText || mainTopic,
          sceneIdx: 0,
          source: hookClipPath.includes('pexels') ? 'pexels' : hookClipPath.includes('pixabay') ? 'pixabay' : 'r2',
          category: categoryFolder
        });

        // === MEGA SCENE (Scene 2) ===
        if (scenes.length > 1) {
          const megaText = scenes[1].texts[0] || mainTopic;
          const audioHashMega = hashForCache(JSON.stringify({ text: megaText, voice, provider }));
          const audioPathMega = path.join(audioCacheDir, `${audioHashMega}-mega.mp3`);
          if (!fs.existsSync(audioPathMega) || fs.statSync(audioPathMega).size < 10000) {
            console.log(`[5B][TTS][MEGA][${jobId}] Generating narration...`);
            await createSceneAudio(megaText, voice, audioPathMega, provider);
          } else {
            console.log(`[5B][TTS][MEGA][${jobId}] Using cached narration: ${audioPathMega}`);
          }

          let candidateSubjects = [];
          try {
            const extracted = await extractVisualSubjects(megaText, mainTopic);
            candidateSubjects = Array.isArray(extracted) ? extracted : [];
          } catch (e) {
            console.warn(`[5B][MEGA][WARN] Subject extract failed, falling back:`, e);
          }
          if (!candidateSubjects.length) candidateSubjects = [megaText, mainTopic].filter(Boolean);

          let megaClipPath = null;
          for (const subj of candidateSubjects) {
            megaClipPath = await findClipForScene({
              subject: subj,
              sceneIdx: 1,
              allSceneTexts,
              mainTopic,
              megaSubject: subj,
              isMegaScene: true,
              workDir,
              jobId,
              jobContext,
              categoryFolder
            });
            if (megaClipPath) break;
          }
          if (!megaClipPath) {
            console.warn(`[5B][MEGA][WARN][${jobId}] Falling back to Ken Burns for mega scene.`);
            const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
            megaClipPath = await fallbackKenBurnsVideo(candidateSubjects[0] || mainTopic, workDir, 1, jobId);
          }
          if (!megaClipPath) throw new Error(`[5B][MEGA][${jobId}] No mega-clip found for any subject/fallback`);

          const megaBase = path.basename(megaClipPath);
          const localMegaClipPath = path.join(workDir, megaBase);
          await ensureLocalClipExists(megaClipPath, localMegaClipPath, jobId);
          if (!assertFileExists(localMegaClipPath, 'MEGA_CLIP_LOCAL')) throw new Error('Mega clip localization failed');

          const megaDuration = await getDuration(audioPathMega);
          const trimmedMegaClip = path.join(videoCacheDir, `${hashForCache(localMegaClipPath + audioPathMega)}-megatrim.mp4`);
          await trimForNarration(localMegaClipPath, trimmedMegaClip, megaDuration, { loop: true });
          if (!assertFileExists(trimmedMegaClip, 'MEGA_TRIMMED_VIDEO')) throw new Error('Mega trimming failed');

          const megaMuxed = path.join(videoCacheDir, `${hashForCache(trimmedMegaClip + audioPathMega)}-megamux.mp4`);
          await muxVideoWithNarration(trimmedMegaClip, audioPathMega, megaMuxed);
          if (!assertFileExists(megaMuxed, 'MEGA_MUXED')) throw new Error('Mega mux failed');

          sceneFiles[1] = megaMuxed;
          jobContext.sceneClipMetaList.push({
            localFilePath: megaMuxed,
            subject: candidateSubjects[0] || mainTopic,
            sceneIdx: 1,
            source: megaClipPath.includes('pexels') ? 'pexels' : megaClipPath.includes('pixabay') ? 'pixabay' : 'r2',
            category: categoryFolder
          });
        }

        // === Remaining Scenes ===
        for (let i = 2; i < scenes.length; i++) {
          const scene = scenes[i];
          const sceneIdx = i;
          const sceneText = scene.texts[0];
          const audioHash = hashForCache(JSON.stringify({ text: sceneText, voice, provider }));
          const audioCachePath = path.join(audioCacheDir, `${audioHash}.mp3`);
          if (!fs.existsSync(audioCachePath) || fs.statSync(audioCachePath).size < 10000) {
            console.log(`[5B][TTS][SCENE][${jobId}] Generating narration for scene ${sceneIdx+1}...`);
            await createSceneAudio(sceneText, voice, audioCachePath, provider);
          } else {
            console.log(`[5B][TTS][SCENE][${jobId}] Using cached narration for scene ${sceneIdx+1}: ${audioCachePath}`);
          }

          let sceneSubject = scene.visualSubject || mainTopic;
          try {
            const arr = await extractVisualSubjects(sceneText, mainTopic);
            if (Array.isArray(arr) && arr[0]) sceneSubject = arr[0];
          } catch (e) { console.warn(`[5B][SUBJECT][WARN][${jobId}] Scene ${sceneIdx+1} subject extraction failed:`, e); }

          // Find best clip (R2-first; 5D handles de-dupe via jobContext.usedClipKeys)
          const clipPath = await findClipForScene({
            subject: sceneSubject, sceneIdx, allSceneTexts, mainTopic,
            isMegaScene: false, workDir, jobId, jobContext, categoryFolder
          });

          if (!clipPath) {
            progress[jobId] = { percent: 35, status: `We had trouble finding a visual for scene ${sceneIdx + 1}. Try a different topic or rephrase your script.`, error: `No clip found for scene ${sceneIdx + 1}` };
            throw new Error(`[5B][ERR][NO_MATCH][${jobId}] No clip found for scene ${sceneIdx + 1}`);
          }

          const localBase = path.basename(clipPath);
          const localClipPath = path.join(workDir, localBase);
          await ensureLocalClipExists(clipPath, localClipPath, jobId);
          if (!assertFileExists(localClipPath, `CLIP_SCENE_${sceneIdx+1}`)) throw new Error('Clip localization failed');

          const narrationDuration = await getDuration(audioCachePath);
          const trimmed = path.join(videoCacheDir, `${hashForCache(localClipPath + audioCachePath)}-trim.mp4`);
          await trimForNarration(localClipPath, trimmed, narrationDuration, { loop: true });
          if (!assertFileExists(trimmed, `TRIMMED_SCENE_${sceneIdx+1}`)) throw new Error('Scene trim failed');

          const videoCachePath = path.join(videoCacheDir, `${hashForCache(trimmed + audioCachePath)}-mux.mp4`);
          await muxVideoWithNarration(trimmed, audioCachePath, videoCachePath);
          if (!assertFileExists(videoCachePath, `MUXED_SCENE_${sceneIdx+1}`)) throw new Error('Scene mux failed');

          jobContext.sceneClipMetaList.push({
            localFilePath: videoCachePath,
            subject: sceneSubject,
            sceneIdx,
            source: (clipPath || '').includes('pexels') ? 'pexels' : (clipPath || '').includes('pixabay') ? 'pixabay' : 'r2',
            category: categoryFolder
          });

          sceneFiles[sceneIdx] = videoCachePath;
        }

        // === Standardize & Concat ===
        progress[jobId] = { percent: 40, status: 'Stitching your video together...' };
        let refInfo = null;
        try {
          progress[jobId] = { percent: 44, status: 'Checking video quality...' };
          refInfo = await getVideoInfo(sceneFiles[0]);
        } catch (e) {
          throw new Error(`[5B][BULLETPROOF][ERR][${jobId}] Failed to get video info: ${e}`);
        }
        try {
          await bulletproofScenes(sceneFiles, refInfo, getVideoInfo, standardizeVideo);
          progress[jobId] = { percent: 48, status: 'Perfecting your video quality...' };
        } catch (e) {
          throw new Error(`[5B][BULLETPROOF][ERR][${jobId}] bulletproofScenes failed: ${e}`);
        }

        let concatPath;
        try {
          progress[jobId] = { percent: 72, status: 'Concatenating scenes...' };
          concatPath = await concatScenes(sceneFiles);
          if (!assertFileExists(concatPath, 'CONCAT_FINAL')) throw new Error('concatScenes returned invalid path');
        } catch (e) {
          throw new Error(`[5B][CONCAT][ERR][${jobId}] ${e}`);
        }

        // === Ensure audio stream (safety) ===
        let finalPath = concatPath;
        try {
          progress[jobId] = { percent: 78, status: 'Ensuring audio stream...' };
          finalPath = await ensureAudioStream(concatPath);
          if (!assertFileExists(finalPath, 'AUDIO_STREAM_SAFE')) throw new Error('ensureAudioStream failed');
        } catch (e) {
          console.warn(`[5B][AUDIO][WARN][${jobId}] ensureAudioStream failed, using concat as final:`, e);
          finalPath = concatPath;
        }

        // === Optional music overlay ===
        const wantMusic = !!music;
        if (wantMusic) {
          try {
            progress[jobId] = { percent: 82, status: 'Selecting background music...' };
            const mood = pickMusicForMood(allSceneTexts.join(' '), mainTopic);
            const withMusic = await overlayMusic(finalPath, mood);
            if (assertFileExists(withMusic, 'WITH_MUSIC')) {
              finalPath = withMusic;
              progress[jobId] = { percent: 86, status: 'Music added! Mixing levels...' };
            }
          } catch (e) {
            console.warn(`[5B][MUSIC][WARN][${jobId}] overlayMusic failed:`, e);
          }
        } else {
          console.log(`[5B][MUSIC][SKIP][${jobId}] Music overlay disabled by user.`);
        }

        // === Optional outro append ===
        const wantOutro = !!outro;
        if (wantOutro) {
          try {
            progress[jobId] = { percent: 88, status: 'Attaching your outro...' };
            finalPath = await appendOutro(finalPath);
            if (assertFileExists(finalPath, 'WITH_OUTRO')) {
              progress[jobId] = { percent: 92, status: 'Outro added! Wrapping up...' };
            } else {
              throw new Error('appendOutro returned invalid path');
            }
          } catch (e) {
            throw new Error(`[5B][OUTRO][ERR][${jobId}] appendOutro failed: ${e}`);
          }
        } else {
          progress[jobId] = { percent: 90, status: 'Outro skipped (user setting).' };
        }

        // === Upload final to R2 (videos bucket) ===
        try {
          progress[jobId] = { percent: 98, status: 'Uploading video to Cloudflare R2...' };
          const r2FinalName = getUniqueFinalName(allSceneTexts.join(' '), mainTopic);
          const r2VideoUrl = await uploadToR2(finalPath, r2FinalName, jobId);
          progress[jobId] = { percent: 100, status: 'Your video is ready! 🎉', output: r2VideoUrl };
        } catch (uploadErr) {
          console.error(`[5B][R2][UPLOAD][${jobId}] Failed to upload final:`, uploadErr);
          progress[jobId] = { percent: 100, status: 'Video ready locally (Cloudflare upload failed).', output: finalPath };
        }

      } catch (err) {
        console.error(`[5B][FATAL][JOB][${jobId}] Video job failed:`, err, err && err.stack ? err.stack : '');
        progress[jobId] = { percent: 100, status: 'Something went wrong. Please try again or contact support.', error: err.message || err.toString() };
      } finally {
        if (cleanupJob) {
          try {
            cleanupJob(jobId, jobContext);
          } catch (e) {
            console.warn(`[5B][CLEANUP][WARN][${jobId}] Cleanup failed:`, e);
          }
        }
      }
    })().catch(e => {
      console.error('[5B][ASYNC][ERR] Uncaught job error:', e);
      // best effort
    });
  });
}

// ===========================================================
// upload final to R2 (videos bucket)
// ===========================================================
async function uploadToR2(finalPath, r2FinalName, jobId) {
  const bucket = process.env.R2_BUCKET || process.env.R2_VIDEOS_BUCKET || 'videos';
  const fileData = fs.readFileSync(finalPath);
  const key = r2FinalName.startsWith('jobs/') ? r2FinalName : `jobs/${jobId}/${r2FinalName}`;
  console.log(`[5B][R2][UPLOAD] Uploading final to bucket=${bucket} key=${key}`);
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileData,
    ContentType: 'video/mp4'
  }));
  const urlBase = process.env.R2_PUBLIC_CUSTOM_DOMAIN || 'https://videos.socialstormai.com';
  const url = `${urlBase.replace(/\/$/, '')}/${key}`;
  console.log(`[5B][R2][UPLOAD][OK] Final uploaded: ${url}`);
  return url;
}

module.exports = registerGenerateVideoEndpoint;
