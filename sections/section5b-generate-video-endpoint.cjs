// ============================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT (Job Controller)
// The /api/generate-video route handler. Full job orchestration.
// MAX LOGGING EVERYWHERE, User-friendly status messages!
// NO DUPLICATE CLIPS IN A SINGLE VIDEO — ABSOLUTE
// ACCURATE PROGRESS BAR (No more stuck at 95%)
// 2024-08: Uploads to R2 ONLY AFTER final video is generated,
// uses correct library/category path with bulletproof naming
// ============================================================

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { s3Client } = require('./section1-setup.cjs');
const {
  bulletproofScenes,
  splitScriptToScenes,
  extractVisualSubject
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
const {
  getDuration,
  trimForNarration,
  muxVideoWithNarration,
} = require('./section5f-video-processing.cjs');
const { findClipForScene } = require('./section5d-clip-matcher.cjs');
const { cleanupJob } = require('./section5h-job-cleanup.cjs');
const { uploadSceneClipToR2, cleanForFilename } = require('./section10e-upload-to-r2.cjs');

console.log('[5B][INIT] section5b-generate-video-endpoint.cjs loaded');

const audioCacheDir = path.resolve(__dirname, '..', 'audio_cache');
const videoCacheDir = path.resolve(__dirname, '..', 'video_cache');
if (!fs.existsSync(audioCacheDir)) fs.mkdirSync(audioCacheDir);
if (!fs.existsSync(videoCacheDir)) fs.mkdirSync(videoCacheDir);

function hashForCache(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function assertFileExists(file, label) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 10240) {
    throw new Error(`[5B][${label}][ERR] File does not exist or is too small: ${file}`);
  }
}

function getCategoryFolder(mainTopic) {
  const lower = (mainTopic || '').toLowerCase();
  if (/haunt|castle|ghost|lore|myth|mystery|history|horror/.test(lower)) return 'lore_history_mystery_horror';
  if (/basketball|soccer|sports|lebron|fitness|exercise|workout|football/.test(lower)) return 'sports_fitness';
  if (/car|truck|tesla|vehicle|drive|race/.test(lower)) return 'cars_vehicles';
  if (/chimp|chimpanzee|ape|gorilla|orangutan|primate/.test(lower)) return 'animals_primates';
  return 'misc';
}

async function ensureLocalClipExists(r2Path, localPath) {
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 10240) return localPath;
  const bucket = process.env.R2_VIDEOS_BUCKET || 'socialstorm-library';
  const key = r2Path.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  console.log(`[5B][R2][DOWNLOAD] Fetching from R2: bucket=${bucket} key=${key} → ${localPath}`);
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const data = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const fileStream = fs.createWriteStream(localPath);
    await new Promise((resolve, reject) => {
      data.Body.pipe(fileStream);
      data.Body.on('error', reject);
      fileStream.on('finish', resolve);
    });
    console.log(`[5B][R2][DOWNLOAD][OK] Downloaded to: ${localPath}`);
    return localPath;
  } catch (err) {
    console.error(`[5B][R2][DOWNLOAD][FAIL] Could not download R2 file:`, err);
    throw err;
  }
}

// ===========================================================
// REGISTER ENDPOINT
// ===========================================================
function registerGenerateVideoEndpoint(app, deps) {
  console.log('[5B][BOOT] Called registerGenerateVideoEndpoint...');
  if (!app) throw new Error('[5B][FATAL] No app passed in!');
  if (!deps) throw new Error('[5B][FATAL] No dependencies passed in!');

  const {
    splitScriptToScenes: depSplitScriptToScenes,
    findClipForScene: depFindClipForScene,
    createSceneAudio,
    createMegaSceneAudio,
    getAudioDuration, getVideoInfo, standardizeVideo,
    progress, voices, POLLY_VOICE_IDS,
  } = deps;

  if (typeof createSceneAudio !== "function" || typeof createMegaSceneAudio !== "function")
    throw new Error('[5B][FATAL] Audio generation helpers missing!');
  if (typeof depSplitScriptToScenes !== "function")
    throw new Error('[5B][FATAL] splitScriptToScenes missing from deps!');

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
        progress[jobId] = { percent: 2, status: 'Setting up your project...' };

        const { script = '', voice = '', music = true, outro = true, provider = 'polly' } = req.body || {};
        if (!script || !voice) throw new Error('Missing script or voice');
        let scenes = depSplitScriptToScenes(script);

        // === BULLETPROOF SCENE NORMALIZATION ===
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
        scenes = scenes.filter(s =>
          s && Array.isArray(s.texts) && typeof s.texts[0] === 'string' && s.texts[0].length > 0
        );
        if (!scenes.length) throw new Error('[5B][FATAL] No valid scenes found after filter!');

        const allSceneTexts = scenes.flatMap(s => Array.isArray(s.texts) ? s.texts : []);
        const mainTopic = allSceneTexts[0] || 'misc';
        const categoryFolder = getCategoryFolder(mainTopic);
        jobContext.categoryFolder = categoryFolder;

        // === ABSOLUTE BULLETPROOF USEDCLIPS DEDUPE ===
        const usedClips = []; // Global, never reset, mutated by ref for the whole job
        const sceneFiles = [];

        // === HOOK SCENE (scene 0) ===
        progress[jobId] = { percent: 10, status: 'Generating intro audio and finding first visual...' };
        const hookText = scenes[0].texts[0];
        const audioHashHook = hashForCache(JSON.stringify({ text: hookText, voice, provider }));
        const audioPathHook = path.join(audioCacheDir, `${audioHashHook}.mp3`);
        if (!fs.existsSync(audioPathHook) || fs.statSync(audioPathHook).size < 10000)
          await deps.createSceneAudio(hookText, voice, audioPathHook, provider);
        assertFileExists(audioPathHook, `AUDIO_HOOK`);

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
            categoryFolder
          });
        } catch (e) {
          console.warn(`[5B][HOOK][CLIP][WARN][${jobId}] No clip found for hook, using fallback:`, e);
        }
        if (!hookClipPath) {
          const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
          hookClipPath = await fallbackKenBurnsVideo(scenes[0].visualSubject || hookText || mainTopic, workDir, 0, jobId, usedClips);
          if (!hookClipPath) throw new Error(`[5B][HOOK][ERR][${jobId}] No fallback Ken Burns visual for HOOK!`);
        }

        const localHookClipPath = path.join(workDir, path.basename(hookClipPath));
        await ensureLocalClipExists(hookClipPath, localHookClipPath);

        const hookDuration = await getDuration(audioPathHook);
        const trimmedHookClip = path.join(videoCacheDir, `${hashForCache(localHookClipPath + audioPathHook)}-hooktrim.mp4`);
        await trimForNarration(localHookClipPath, trimmedHookClip, hookDuration, { loop: true });
        assertFileExists(trimmedHookClip, `HOOK_TRIMMED_VIDEO`);

        const hookMuxed = path.join(videoCacheDir, `${hashForCache(trimmedHookClip + audioPathHook)}-hookmux.mp4`);
        await muxVideoWithNarration(trimmedHookClip, audioPathHook, hookMuxed);
        assertFileExists(hookMuxed, `HOOK_MUXED`);

        sceneFiles[0] = hookMuxed;
        jobContext.sceneClipMetaList.push({
          localFilePath: hookMuxed,
          subject: scenes[0].visualSubject || hookText || mainTopic,
          sceneIdx: 0,
          source: hookClipPath.includes('pexels') ? 'pexels' : hookClipPath.includes('pixabay') ? 'pixabay' : 'r2',
          category: categoryFolder
        });

        // === MEGA SCENE (scene 1) ===
        progress[jobId] = { percent: 20, status: 'Building mega scene...' };
        const scene2 = scenes[1];
        if (!scene2) throw new Error('[5B][FATAL] Mega scene missing!');

        const megaText = (scene2.texts && Array.isArray(scene2.texts)) ? scene2.texts.join(' ') : '';
        const audioHashMega = hashForCache(JSON.stringify({ text: megaText, voice, provider }));
        const audioPathMega = path.join(audioCacheDir, `${audioHashMega}-mega.mp3`);

        if (!fs.existsSync(audioPathMega) || fs.statSync(audioPathMega).size < 10000)
          await deps.createSceneAudio(megaText, voice, audioPathMega, provider);
        assertFileExists(audioPathMega, `AUDIO_MEGA`);

        let candidateSubjects = [];
        if (extractVisualSubjects) {
          try {
            candidateSubjects = await extractVisualSubjects(megaText, mainTopic);
            if (!Array.isArray(candidateSubjects) || !candidateSubjects.length) candidateSubjects = [];
          } catch (e) {
            console.warn(`[5B][MEGA][WARN] GPT subject extract failed, falling back:`, e);
          }
        }
        if (!candidateSubjects.length) candidateSubjects = [megaText, mainTopic];

        let megaClipPath = null;
        for (let subj of candidateSubjects) {
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
            categoryFolder
          });
          if (megaClipPath) break;
        }
        if (!megaClipPath) {
          // Fallback (see Section 10d)
          const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
          megaClipPath = await fallbackKenBurnsVideo(candidateSubjects[0] || mainTopic, workDir, 1, jobId, usedClips);
          if (!megaClipPath) throw new Error(`[5B][MEGA][ERR][${jobId}] No fallback Ken Burns visual for MEGA!`);
        }

        const localMegaClipPath = path.join(workDir, path.basename(megaClipPath));
        await ensureLocalClipExists(megaClipPath, localMegaClipPath);

        const megaDuration = await getDuration(audioPathMega);
        const trimmedMegaClip = path.join(videoCacheDir, `${hashForCache(localMegaClipPath + audioPathMega)}-megatrim.mp4`);
        await trimForNarration(localMegaClipPath, trimmedMegaClip, megaDuration, { loop: true });
        assertFileExists(trimmedMegaClip, `MEGA_TRIMMED_VIDEO`);

        const megaMuxed = path.join(videoCacheDir, `${hashForCache(trimmedMegaClip + audioPathMega)}-megamux.mp4`);
        await muxVideoWithNarration(trimmedMegaClip, audioPathMega, megaMuxed);
        assertFileExists(megaMuxed, `MEGA_MUXED`);

        sceneFiles[1] = megaMuxed;
        jobContext.sceneClipMetaList.push({
          localFilePath: megaMuxed,
          subject: candidateSubjects[0] || mainTopic,
          sceneIdx: 1,
          source: megaClipPath.includes('pexels') ? 'pexels' : megaClipPath.includes('pixabay') ? 'pixabay' : 'r2',
          category: categoryFolder
        });

        // === ALL REMAINING SCENES (SERIALIZED, not parallel for accurate progress) ===
        let curPct = 22;
        const pctPerScene = 35 / (scenes.length - 2);

        for (let i = 2; i < scenes.length; i++) {
          progress[jobId] = { percent: curPct, status: `Processing scene ${i + 1} of ${scenes.length}...` };
          const scene = scenes[i];
          let sceneIdx = i;
          let sceneSubject = scene.visualSubject || (Array.isArray(scene.texts) && scene.texts[0]) || allSceneTexts[sceneIdx];
          const GENERIC_SUBJECTS = ['face','person','man','woman','it','thing','someone','something','body','eyes'];
          if (GENERIC_SUBJECTS.includes((sceneSubject || '').toLowerCase())) {
            sceneSubject = mainTopic;
          }
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
              categoryFolder
            });
          } catch (e) {
            console.error(`[5B][CLIP][ERR][${jobId}] findClipForScene failed for scene ${sceneIdx + 1}:`, e);
          }
          if (!clipPath) {
            const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
            clipPath = await fallbackKenBurnsVideo(sceneSubject || mainTopic, workDir, sceneIdx, jobId, usedClips);
            if (!clipPath) throw new Error(`[5B][ERR][NO_MATCH][${jobId}] No fallback Ken Burns visual for scene ${sceneIdx + 1}!`);
          }

          const localClipPath = path.join(workDir, path.basename(clipPath));
          await ensureLocalClipExists(clipPath, localClipPath);
          assertFileExists(localClipPath, `CLIP_SCENE_${sceneIdx+1}`);

          const audioHash = hashForCache(JSON.stringify({
            text: scene.texts,
            voice,
            provider
          }));
          const audioCachePath = path.join(audioCacheDir, `${audioHash}.mp3`);
          if (!fs.existsSync(audioCachePath) || fs.statSync(audioCachePath).size < 10000)
            await deps.createSceneAudio(scene.texts[0], voice, audioCachePath, provider);
          assertFileExists(audioCachePath, `AUDIO_SCENE_${sceneIdx+1}`);

          const narrationDuration = await getDuration(audioCachePath);
          const trimmedVideoPath = path.join(workDir, `scene${sceneIdx+1}-trimmed.mp4`);
          await trimForNarration(localClipPath, trimmedVideoPath, narrationDuration);
          const videoCachePath = path.join(videoCacheDir, `${hashForCache(JSON.stringify({
            text: scene.texts,
            voice,
            provider,
            clip: clipPath
          }))}.mp4`);
          await muxVideoWithNarration(trimmedVideoPath, audioCachePath, videoCachePath);
          assertFileExists(videoCachePath, `MUXED_SCENE_${sceneIdx+1}`);

          jobContext.sceneClipMetaList.push({
            localFilePath: videoCachePath,
            subject: sceneSubject,
            sceneIdx,
            source: (clipPath || '').includes('pexels') ? 'pexels' : (clipPath || '').includes('pixabay') ? 'pixabay' : 'r2',
            category: categoryFolder
          });

          sceneFiles[sceneIdx] = videoCachePath;
          curPct += pctPerScene;
        }

        // === Concatenation, music, outro, upload, final progress updates ===

        progress[jobId] = { percent: 60, status: 'Stitching your video together...' };
        let refInfo = null;
        try {
          progress[jobId] = { percent: 64, status: 'Checking video quality...' };
          refInfo = await getVideoInfo(sceneFiles[0]);
        } catch (e) {
          throw new Error(`[5B][BULLETPROOF][ERR][${jobId}] Failed to get video info: ${e}`);
        }
        try {
          await bulletproofScenes(sceneFiles, refInfo, getVideoInfo, deps.standardizeVideo);
          progress[jobId] = { percent: 68, status: 'Perfecting your video quality...' };
        } catch (e) {
          throw new Error(`[5B][BULLETPROOF][ERR][${jobId}] bulletproofScenes failed: ${e}`);
        }

        let concatPath;
        try {
          progress[jobId] = { percent: 75, status: 'Combining everything into one amazing video...' };
          concatPath = await concatScenes(sceneFiles, workDir, jobContext.sceneClipMetaList);
          assertFileExists(concatPath, 'CONCAT_OUT');
        } catch (e) {
          throw new Error(`[5B][CONCAT][ERR][${jobId}] concatScenes failed: ${e}`);
        }

        let withAudioPath = concatPath;
        try {
          progress[jobId] = { percent: 80, status: 'Finalizing your audio...' };
          withAudioPath = await ensureAudioStream(concatPath, workDir);
          assertFileExists(withAudioPath, 'AUDIOFIX_OUT');
        } catch (e) {
          throw new Error(`[5B][AUDIO][ERR][${jobId}] ensureAudioStream failed: ${e}`);
        }

        let musicPath = withAudioPath;
        if (music) {
          try {
            progress[jobId] = { percent: 85, status: 'Adding background music...' };
            const chosenMusic = pickMusicForMood ? await pickMusicForMood(script, workDir, jobId) : null;
            if (chosenMusic) {
              const musicOutput = path.join(workDir, getUniqueFinalName('with-music'));
              await overlayMusic(withAudioPath, chosenMusic, musicOutput);
              assertFileExists(musicOutput, 'MUSIC_OUT');
              musicPath = musicOutput;
              progress[jobId] = { percent: 87, status: 'Background music ready!' };
            } else {
              progress[jobId] = { percent: 85, status: 'No music found, skipping...' };
            }
          } catch (e) {
            throw new Error(`[5B][MUSIC][ERR][${jobId}] overlayMusic failed: ${e}`);
          }
        } else {
          progress[jobId] = { percent: 85, status: 'Music skipped (user setting).' };
        }

        let finalPath = musicPath;
        if (outro) {
          const outroPath = path.join(__dirname, '..', 'public', 'assets', 'outro.mp4');
          if (fs.existsSync(outroPath)) {
            try {
              progress[jobId] = { percent: 92, status: 'Adding your outro...' };
              const outroOutput = path.join(workDir, getUniqueFinalName('final-with-outro'));
              await appendOutro(musicPath, outroPath, outroOutput, workDir);
              assertFileExists(outroOutput, 'OUTRO_OUT');
              finalPath = outroOutput;
              progress[jobId] = { percent: 95, status: 'Outro added! Wrapping up...' };
            } catch (e) {
              throw new Error(`[5B][OUTRO][ERR][${jobId}] appendOutro failed: ${e}`);
            }
          } else {
            progress[jobId] = { percent: 92, status: 'Finalizing your masterpiece...' };
          }
        } else {
          progress[jobId] = { percent: 92, status: 'Outro skipped (user setting).' };
        }

        // === FINAL UPLOAD TO LIBRARY (SOCIALSTORM-LIBRARY) ===
        try {
          progress[jobId] = { percent: 98, status: 'Uploading final video to Cloudflare R2 library...' };
          const subjectForName = cleanForFilename(mainTopic);
          const finalSceneIdx = scenes.length - 1;
          const resultR2Path = await uploadSceneClipToR2(
            finalPath,
            subjectForName,
            finalSceneIdx,
            'socialstorm',
            categoryFolder
          );
          const publicBase = process.env.R2_PUBLIC_CUSTOM_DOMAIN || 'https://videos.socialstormai.com';
          const url = resultR2Path
            ? `${publicBase.replace(/\/$/, '')}/${resultR2Path.replace(/^socialstorm-library\//, '')}`
            : finalPath;
          progress[jobId] = { percent: 100, status: 'Your video is ready! 🎉', output: url };
        } catch (uploadErr) {
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
    })();
  });

  console.log('[5B][SUCCESS] /api/generate-video endpoint registered.');
}

console.log('[5B][EXPORT] registerGenerateVideoEndpoint exported');
module.exports = registerGenerateVideoEndpoint;
