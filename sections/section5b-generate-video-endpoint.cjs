// ===========================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT (Job Controller)
// The /api/generate-video route handler. Full job orchestration.
// MAX LOGGING EVERYWHERE, User-friendly status messages!
// PRO+: Audio and muxed video caching, parallelized scene jobs
// 2024-08: Works with new 5F and 5G logic for sync and split
// ===========================================================

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// R2 dependencies (S3 SDK)
const { s3Client, PutObjectCommand } = require('./section1-setup.cjs');

// === 5C: SCENE UTILS ===
const {
  bulletproofScenes,
  splitScriptToScenes,
  extractVisualSubject
} = require('./section5c-script-scene-utils.cjs');

// === 5G Video/Music/Outro/Helpers ===
const {
  concatScenes,
  ensureAudioStream,
  overlayMusic,
  appendOutro,
  getUniqueFinalName,
  pickMusicForMood
} = require('./section5g-concat-and-music.cjs');

// === 5F: AV/Scene Mux Logic ===
const {
  getDuration,
  trimForNarration,
  muxVideoWithNarration,
  splitVideoForFirstTwoScenes
} = require('./section5f-video-processing.cjs');

// === 5H: Job Cleanup (with post-job R2 ingestion) ===
const { cleanupJob } = require('./section5h-job-cleanup.cjs');

console.log('[5B][INIT] section5b-generate-video-endpoint.cjs loaded');

// === CACHE DIRS ===
const audioCacheDir = path.resolve(__dirname, '..', 'audio_cache');
const videoCacheDir = path.resolve(__dirname, '..', 'video_cache');
if (!fs.existsSync(audioCacheDir)) fs.mkdirSync(audioCacheDir);
if (!fs.existsSync(videoCacheDir)) fs.mkdirSync(videoCacheDir);

function hashForCache(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

// ================= R2 UPLOAD HELPER =======================
async function uploadToR2(localFilePath, r2FinalName, jobId) {
  const bucket = process.env.R2_VIDEOS_BUCKET || 'socialstorm-videos';
  const customDomainBase = 'videos.socialstormai.com';
  const r2Key = `${jobId}-${r2FinalName}`;
  console.log(`[5B][R2 UPLOAD][START] job=${jobId} localFilePath=${localFilePath} bucket=${bucket} key=${r2Key}`);
  try {
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`[5B][R2 UPLOAD][ERR] File does not exist: ${localFilePath}`);
    }
    const fileBuffer = fs.readFileSync(localFilePath);

    const r2Resp = await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key,
      Body: fileBuffer,
      ContentType: 'video/mp4'
    }));

    console.log(`[5B][R2 UPLOAD][COMPLETE] R2 upload response:`, r2Resp);

    const publicUrl = `https://${customDomainBase}/${r2Key}`;
    console.log(`[5B][R2 UPLOAD][SUCCESS] File available at: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    console.error(`[5B][R2 UPLOAD][FAIL] job=${jobId} localFilePath=${localFilePath}:`, err);
    throw err;
  }
}

function assertFileExists(file, label) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 10240) {
    throw new Error(`[5B][${label}][ERR] File does not exist or is too small: ${file}`);
  }
}

// --- CATEGORY/TOPIC MAPPING ---
function getCategoryFolder(mainTopic) {
  const lower = (mainTopic || '').toLowerCase();
  if (/haunt|castle|ghost|lore|myth|mystery|history|horror/.test(lower)) return 'lore_history_mystery_horror';
  if (/basketball|soccer|sports|lebron|fitness|exercise|workout|football/.test(lower)) return 'sports_fitness';
  if (/car|truck|tesla|vehicle|drive|race/.test(lower)) return 'cars_vehicles';
  if (/chimp|chimpanzee|ape|gorilla|orangutan|primate/.test(lower)) return 'animals_primates';
  // ...add more rules as you wish...
  return 'misc';
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
    findClipForScene,
    createSceneAudio,
    createMegaSceneAudio,
    getAudioDuration, getVideoInfo, standardizeVideo,
    progress, voices, POLLY_VOICE_IDS,
  } = deps;

  if (typeof findClipForScene !== "function") throw new Error('[5B][FATAL] findClipForScene missing from deps!');
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

      // === 1. Init job context with scene metadata ===
      const jobContext = {
        sceneClipMetaList: []
      };

      try {
        fs.mkdirSync(workDir, { recursive: true });
        progress[jobId] = { percent: 2, status: 'Setting up your project...' };
        console.log(`[5B][WORKDIR][${jobId}] Created: ${workDir}`);

        // === 1. Parse and split script into scenes ===
        const { script = '', voice = '', music = true, outro = true, provider = 'polly' } = req.body || {};
        if (!script || !voice) throw new Error('Missing script or voice');
        console.log(`[5B][INPUTS][${jobId}] Script length: ${script.length} | Voice: ${voice}`);
        console.log(`[5B][SCRIPT][${jobId}] Full script input:\n${script}`);

        let scenes = depSplitScriptToScenes(script);

        // Defensive scene handling & subject extraction (as before)
        scenes = Array.isArray(scenes) ? scenes : [];
        scenes = scenes.map((scene, idx) => {
          if (!scene || typeof scene !== 'object' || !Array.isArray(scene.texts)) {
            console.error(`[5B][BUG][${jobId}] Invalid scene at idx ${idx}, auto-wrapping:`, scene);
            return {
              id: `scene${idx + 1}-fixwrap-${uuidv4()}`,
              texts: [typeof scene === 'string' ? scene : ''],
              isMegaScene: false,
              type: 'auto-wrap',
              origIndices: [idx],
              visualSubject: ''
            };
          }
          let subject = '';
          if (scene.type === 'hook-summary') {
            subject = scene.visualSubject || extractVisualSubject(scene.texts[0] || '', '');
          } else if (scene.isMegaScene) {
            subject = extractVisualSubject(scene.texts[1] || scene.texts[0] || '', scene.visualSubject || '');
          } else {
            subject = extractVisualSubject(scene.texts[0] || '', scene.visualSubject || '');
          }
          return { ...scene, visualSubject: subject || scene.visualSubject || '' };
        });

        // Defensive filtering (as before)
        scenes = scenes.filter(s =>
          s && Array.isArray(s.texts) && typeof s.texts[0] === 'string' && s.texts[0].length > 0
        );
        if (!scenes.length) throw new Error('[5B][FATAL] No valid scenes found after filter!');

        // === Category folder detection ===
        const allSceneTexts = scenes.flatMap(s => Array.isArray(s.texts) ? s.texts : []);
        const mainTopic = allSceneTexts[0] || 'misc';
        const categoryFolder = getCategoryFolder(mainTopic);
        jobContext.categoryFolder = categoryFolder;

        // === 2. SCENE/CLIP ASSIGNMENT ===
        const usedClips = [];
        const sceneFiles = [];
        let megaClipPath = null;
        let megaSceneTrimmedVideos = null;

        // === 2a. Mega subject/clip logic (as before) ===
        let megaSubject = scenes.length > 1 && scenes[1].isMegaScene ? scenes[1].visualSubject : allSceneTexts[1] || allSceneTexts[0];
        if (!megaSubject || typeof megaSubject !== 'string' || megaSubject.length < 2) {
          megaSubject = allSceneTexts[1] || allSceneTexts[0];
        }
        const GENERIC_SUBJECTS = ['face','person','man','woman','it','thing','someone','something','body','eyes'];
        if (GENERIC_SUBJECTS.includes((megaSubject || '').toLowerCase())) {
          megaSubject = allSceneTexts[0];
        }
        if (scenes.length > 1) {
          megaClipPath = await findClipForScene({
            subject: megaSubject,
            sceneIdx: 1,
            allSceneTexts,
            mainTopic: megaSubject,
            isMegaScene: true,
            usedClips,
            workDir,
            jobId,
            megaSubject: megaSubject,
            jobContext,
            categoryFolder
          });
          if (!megaClipPath) throw new Error(`[5B][ERR] No mega-clip found for mega-subject: "${megaSubject}"`);
          usedClips.push(megaClipPath);
        }

        // === 2c. Process all scenes (assign unique clips, audio, mux, etc.) ===
        const sceneJobs = scenes.map((scene, i) => (async () => {
          let isMegaScene = !!scene.isMegaScene;
          let clipPath = null;
          let sceneSubject = scene.visualSubject || (Array.isArray(scene.texts) && scene.texts[0]) || allSceneTexts[i];
          if (GENERIC_SUBJECTS.includes((sceneSubject || '').toLowerCase())) {
            sceneSubject = allSceneTexts[0];
          }

          // CLIP MATCHING
          if (i === 0 || isMegaScene) {
            clipPath = megaClipPath;
          } else {
            try {
              clipPath = await findClipForScene({
                subject: sceneSubject,
                sceneIdx: i,
                allSceneTexts,
                mainTopic: allSceneTexts[0],
                isMegaScene: false,
                usedClips,
                workDir,
                jobId,
                jobContext,
                categoryFolder
              });
            } catch (e) {
              console.error(`[5B][CLIP][ERR][${jobId}] findClipForScene failed for scene ${i + 1}:`, e);
            }
            if (!clipPath) throw new Error(`[5B][ERR] No clip found for scene ${i + 1}`);
            usedClips.push(clipPath);
          }
          assertFileExists(clipPath, `CLIP_SCENE_${i+1}`);

          // === SCENE CLIP ARCHIVING METADATA ===
          // Add metadata for this scene to jobContext.sceneClipMetaList
          jobContext.sceneClipMetaList.push({
            localFilePath: clipPath,
            subject: sceneSubject,
            sceneIdx: i,
            source: (clipPath || '').includes('pexels') ? 'pexels' : (clipPath || '').includes('pixabay') ? 'pixabay' : 'r2',
            category: categoryFolder
          });

          // AUDIO GENERATION WITH CACHE
          const audioHash = hashForCache(JSON.stringify({
            text: scene.texts,
            voice,
            provider
          }));
          const audioCachePath = path.join(audioCacheDir, `${audioHash}.mp3`);
          let audioPath = audioCachePath;

          let audioPreExists = fs.existsSync(audioCachePath) && fs.statSync(audioCachePath).size > 10000;
          if (!audioPreExists) {
            if (isMegaScene) {
              await deps.createMegaSceneAudio(scene.texts, voice, audioCachePath, provider, workDir);
            } else {
              await deps.createSceneAudio(scene.texts[0], voice, audioCachePath, provider);
            }
            assertFileExists(audioCachePath, isMegaScene ? `AUDIO_MEGA_${i+1}` : `AUDIO_SCENE_${i+1}`);
          }

          let audioDuration = -1;
          try {
            audioDuration = fs.existsSync(audioPath) ? (await getDuration(audioPath)) : -1;
          } catch (err) {}
          if (audioDuration <= 0.01) {
            throw new Error(`[5B][AUDIO][FATAL] Audio file for scene ${i+1} is empty or corrupted: ${audioPath}`);
          }

          // PRECISE TRIM/MUX PIPELINE
          const muxHash = hashForCache(JSON.stringify({
            text: scene.texts,
            voice,
            provider,
            clip: clipPath
          }));
          const videoCachePath = path.join(videoCacheDir, `${muxHash}.mp4`);
          let muxedScenePath = videoCachePath;

          if (fs.existsSync(videoCachePath) && fs.statSync(videoCachePath).size > 100000) {
            // Cache hit
          } else {
            if (isMegaScene) {
              if (!megaSceneTrimmedVideos) {
                const megaAudio1 = audioPath;
                const nextAudioHash = hashForCache(JSON.stringify({
                  text: scenes[1].texts,
                  voice,
                  provider
                }));
                const megaAudio2 = path.join(audioCacheDir, `${nextAudioHash}.mp3`);
                if (!fs.existsSync(megaAudio2) || fs.statSync(megaAudio2).size < 10000) {
                  await deps.createSceneAudio(scenes[1].texts[0], voice, megaAudio2, provider);
                }
                let dur1 = fs.existsSync(megaAudio1) ? (await getDuration(megaAudio1)) : 0;
                let dur2 = fs.existsSync(megaAudio2) ? (await getDuration(megaAudio2)) : 0;
                if (dur1 < 0.01 || dur2 < 0.01) {
                  throw new Error(`[5B][AUDIO][FATAL] Mega scene audio is empty: [${megaAudio1}] ${dur1}s, [${megaAudio2}] ${dur2}s`);
                }
                megaSceneTrimmedVideos = await splitVideoForFirstTwoScenes(
                  clipPath, megaAudio1, megaAudio2, workDir
                );
              }
              const [scene1Video, scene2Video] = megaSceneTrimmedVideos;
              const trimmedVideoPath = (i === 0) ? scene1Video : scene2Video;
              await muxVideoWithNarration(trimmedVideoPath, audioPath, videoCachePath);
              assertFileExists(videoCachePath, `MUXED_MEGA_${i+1}`);
            } else {
              const narrationDuration = audioDuration;
              const trimmedVideoPath = path.join(workDir, `scene${i+1}-trimmed.mp4`);
              await trimForNarration(clipPath, trimmedVideoPath, narrationDuration);
              await muxVideoWithNarration(trimmedVideoPath, audioPath, videoCachePath);
              assertFileExists(videoCachePath, `MUXED_SCENE_${i+1}`);
            }
          }
          return { idx: i, muxedScenePath };
        })());

        progress[jobId] = { percent: 10, status: `Processing all scenes in parallel (with caching)...` };
        let allScenes;
        try {
          allScenes = await Promise.all(sceneJobs);
          allScenes.sort((a, b) => a.idx - b.idx).forEach(obj => sceneFiles.push(obj.muxedScenePath));
        } catch (err) {
          throw new Error(`[5B][FATAL] One or more scenes failed to process: ${err}`);
        }

        progress[jobId] = { percent: 40, status: 'Stitching your video together...' };

        // === 3. Bulletproof video scenes (codec/size) ===
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

        // === 4. Concatenate all scene files ===
        let concatPath;
        try {
          progress[jobId] = { percent: 60, status: 'Combining everything into one amazing video...' };
          concatPath = await concatScenes(sceneFiles, workDir, jobContext.sceneClipMetaList);
          assertFileExists(concatPath, 'CONCAT_OUT');
        } catch (e) {
          throw new Error(`[5B][CONCAT][ERR][${jobId}] concatScenes failed: ${e}`);
        }

        // === 5. Ensure audio (add silence if needed) ===
        let withAudioPath;
        try {
          progress[jobId] = { percent: 70, status: 'Finalizing your audio...' };
          withAudioPath = await ensureAudioStream(concatPath, workDir);
          assertFileExists(withAudioPath, 'AUDIOFIX_OUT');
        } catch (e) {
          throw new Error(`[5B][AUDIO][ERR][${jobId}] ensureAudioStream failed: ${e}`);
        }

        // === 6. Overlay background music (if enabled) ===
        let musicPath = withAudioPath;
        if (music) {
          try {
            progress[jobId] = { percent: 80, status: 'Adding background music...' };
            const chosenMusic = pickMusicForMood ? await pickMusicForMood(script, workDir, jobId) : null;
            if (chosenMusic) {
              const musicOutput = path.join(workDir, getUniqueFinalName('with-music'));
              await overlayMusic(withAudioPath, chosenMusic, musicOutput);
              assertFileExists(musicOutput, 'MUSIC_OUT');
              musicPath = musicOutput;
              progress[jobId] = { percent: 82, status: 'Background music ready!' };
            } else {
              progress[jobId] = { percent: 80, status: 'No music found, skipping...' };
            }
          } catch (e) {
            throw new Error(`[5B][MUSIC][ERR][${jobId}] overlayMusic failed: ${e}`);
          }
        } else {
          progress[jobId] = { percent: 80, status: 'Music skipped (user setting).' };
        }

        // === 7. Append outro (if enabled) ===
        let finalPath = musicPath;
        let r2FinalName = getUniqueFinalName('final-with-outro');
        if (outro) {
          const outroPath = path.join(__dirname, '..', 'public', 'assets', 'outro.mp4');
          if (fs.existsSync(outroPath)) {
            try {
              progress[jobId] = { percent: 90, status: 'Adding your outro...' };
              const outroOutput = path.join(workDir, r2FinalName);
              await appendOutro(musicPath, outroPath, outroOutput, workDir);
              assertFileExists(outroOutput, 'OUTRO_OUT');
              finalPath = outroOutput;
              progress[jobId] = { percent: 92, status: 'Outro added! Wrapping up...' };
            } catch (e) {
              throw new Error(`[5B][OUTRO][ERR][${jobId}] appendOutro failed: ${e}`);
            }
          } else {
            progress[jobId] = { percent: 90, status: 'Finalizing your masterpiece...' };
          }
        } else {
          progress[jobId] = { percent: 90, status: 'Outro skipped (user setting).' };
        }

        // === 8. Upload final video to R2 and finish ===
        try {
          progress[jobId] = { percent: 98, status: 'Uploading video to Cloudflare R2...' };
          const r2VideoUrl = await uploadToR2(finalPath, r2FinalName, jobId);
          progress[jobId] = { percent: 100, status: 'Your video is ready! 🎉', output: r2VideoUrl };
        } catch (uploadErr) {
          progress[jobId] = { percent: 100, status: 'Video ready locally (Cloudflare upload failed).', output: finalPath };
        }

      } catch (err) {
        console.error(`[5B][FATAL][JOB][${jobId}] Video job failed:`, err);
        progress[jobId] = { percent: 100, status: 'Something went wrong. Please try again or contact support.', error: err.message || err.toString() };
      } finally {
        if (cleanupJob) {
          try {
            cleanupJob(jobId, jobContext); // <--- Pass jobContext for async R2 archiving!
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
