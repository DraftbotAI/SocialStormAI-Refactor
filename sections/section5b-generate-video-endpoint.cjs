// ============================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT (Job Controller)
// The /api/generate-video route handler. Full job orchestration.
// MAX LOGGING EVERYWHERE, User-friendly status messages!
// PRO+: Audio and muxed video caching, parallelized scene jobs
// 2024-08: Works with GPT-powered subject extraction (Section 11)
// Mega-clip logic: Scenes 1 & 2 = ONE continuous video, subject from line 2 (w/ progressive fallback)
// Bulletproof R2: Auto-downloads from R2 if file not present locally
// ===========================================================

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// R2 dependencies (S3 SDK)
const { s3Client, PutObjectCommand, GetObjectCommand } = require('./section1-setup.cjs');

// === 5C: SCENE UTILS ===
const {
  bulletproofScenes,
  splitScriptToScenes,
  extractVisualSubject
} = require('./section5c-script-scene-utils.cjs');

// === 11: GPT Visual Subject Extractor ===
const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');

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
} = require('./section5f-video-processing.cjs');

// === 5D: GPT + Visual Clip Matcher ===
const { findClipForScene } = require('./section5d-clip-matcher.cjs');

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

async function concatAudioFiles(audioPaths, outPath) {
  const { exec } = require('child_process');
  return new Promise((resolve, reject) => {
    const filelistPath = `${outPath}.txt`;
    fs.writeFileSync(filelistPath, audioPaths.map(p => `file '${p}'`).join('\n'));
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${filelistPath}" -c copy "${outPath}"`;
    exec(cmd, (err) => {
      fs.unlinkSync(filelistPath);
      if (err) return reject(err);
      resolve(outPath);
    });
  });
}

// ========== ENSURE LOCAL CLIP FROM R2 ==========
async function ensureLocalClipExists(r2Path, localPath) {
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 10240) return localPath;
  const bucket = process.env.R2_VIDEOS_BUCKET || 'socialstorm-videos';
  const key = r2Path.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  console.log(`[5B][R2][DOWNLOAD] Fetching from R2: bucket=${bucket} key=${key} → ${localPath}`);
  try {
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
  return 'misc';
}

// --- FALLBACK SUBJECT EXPANDER ---
function getFallbackSubjects(fullSubject, mainTopic) {
  const subs = [];
  if (fullSubject) {
    const words = fullSubject.split(' ').filter(Boolean);
    if (words.length > 2) {
      for (let i = 0; i < words.length - 1; i++) {
        const two = words.slice(i, i + 2).join(' ');
        if (two.length > 2) subs.push(two);
      }
    }
    subs.push(...words.filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as'].includes(w.toLowerCase())));
  }
  if (mainTopic && !subs.includes(mainTopic)) subs.push(mainTopic);
  subs.push('landmark', 'famous building', 'tourist attraction');
  return [...new Set(subs.map(s => s.trim()).filter(Boolean))];
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

        scenes = scenes.filter(s =>
          s && Array.isArray(s.texts) && typeof s.texts[0] === 'string' && s.texts[0].length > 0
        );
        if (!scenes.length) throw new Error('[5B][FATAL] No valid scenes found after filter!');

        const allSceneTexts = scenes.flatMap(s => Array.isArray(s.texts) ? s.texts : []);
        const mainTopic = allSceneTexts[0] || 'misc';
        const categoryFolder = getCategoryFolder(mainTopic);
        jobContext.categoryFolder = categoryFolder;

        // === 2. MEGA-SCENE LOGIC: Scenes 1+2 rendered as one video ===
        const usedClips = [];
        const sceneFiles = [];

        // -- A. Build MEGA audio (concat lines 1+2)
        const scene1text = scenes[0].texts[0];
        const scene2text = (scenes[1] && scenes[1].texts[0]) ? scenes[1].texts[0] : '';
        const audioHash1 = hashForCache(JSON.stringify({ text: scene1text, voice, provider }));
        const audioHash2 = hashForCache(JSON.stringify({ text: scene2text, voice, provider }));
        const audioPath1 = path.join(audioCacheDir, `${audioHash1}.mp3`);
        const audioPath2 = path.join(audioCacheDir, `${audioHash2}.mp3`);

        if (!fs.existsSync(audioPath1) || fs.statSync(audioPath1).size < 10000)
          await deps.createSceneAudio(scene1text, voice, audioPath1, provider);
        if (!fs.existsSync(audioPath2) || fs.statSync(audioPath2).size < 10000)
          await deps.createSceneAudio(scene2text, voice, audioPath2, provider);

        assertFileExists(audioPath1, `AUDIO_SCENE_1`);
        assertFileExists(audioPath2, `AUDIO_SCENE_2`);

        const megaAudioPath = path.join(audioCacheDir, hashForCache(audioPath1 + audioPath2) + '-mega.mp3');
        await concatAudioFiles([audioPath1, audioPath2], megaAudioPath);

        // -- B. Extract subject candidates for line 2 (Scene 2)
        let candidateSubjects = [];
        if (extractVisualSubjects) {
          try {
            candidateSubjects = await extractVisualSubjects(scene2text, mainTopic);
            if (!Array.isArray(candidateSubjects) || !candidateSubjects.length) candidateSubjects = [];
          } catch (e) {
            console.warn(`[5B][MEGA][WARN] GPT subject extract failed, falling back:`, e);
          }
        }
        if (!candidateSubjects.length) candidateSubjects = [scene2text, mainTopic];

        // -- C. Try all GPT candidates, then progressively loosen the fallback to partial phrases, then generic
        let megaClipPath = null;
        // 1. Try all GPT subject candidates (strict)
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
          if (megaClipPath) {
            console.log(`[5B][MEGA][INFO] Found mega-clip for subject: "${subj}" -> ${megaClipPath}`);
            break;
          }
        }
        // 2. Try fallback sub-phrases if nothing matched above
        if (!megaClipPath) {
          console.warn(`[5B][MEGA][WARN] No strict clip found for any GPT subject. Trying broad fallbacks...`);
          let fallbackSubjects = getFallbackSubjects(scene2text, mainTopic);
          for (let subj of fallbackSubjects) {
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
            if (megaClipPath) {
              console.log(`[5B][MEGA][FALLBACK] Found fallback mega-clip: "${subj}" => ${megaClipPath}`);
              break;
            }
          }
        }
        // 3. Ken Burns fallback
        if (!megaClipPath) {
          const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
          megaClipPath = await fallbackKenBurnsVideo(candidateSubjects[0] || mainTopic, workDir, 1, jobId, usedClips);
          if (megaClipPath) {
            console.log(`[5B][MEGA][KENBURNS] Ken Burns fallback created for "${candidateSubjects[0] || mainTopic}"`);
          }
        }
        if (!megaClipPath) throw new Error(`[5B][ERR] No mega-clip found for any subject or fallback for: "${candidateSubjects[0] || mainTopic}"`);
        usedClips.push(megaClipPath);

        // === ENSURE MEGA CLIP IS LOCAL (R2 or remote source) ===
        const localMegaClipPath = path.join(workDir, path.basename(megaClipPath));
        await ensureLocalClipExists(megaClipPath, localMegaClipPath);

        // -- D. Trim/loop mega-clip to match combined audio duration
        const megaDuration = await getDuration(megaAudioPath);
        const trimmedMegaClip = path.join(videoCacheDir, `${hashForCache(localMegaClipPath + megaAudioPath)}-megatrim.mp4`);
        await trimForNarration(localMegaClipPath, trimmedMegaClip, megaDuration, { loop: true });
        assertFileExists(trimmedMegaClip, `MEGA_TRIMMED_VIDEO`);

        // -- E. Mux single mega video with combined audio
        const megaMuxed = path.join(videoCacheDir, `${hashForCache(trimmedMegaClip + megaAudioPath)}-megamux.mp4`);
        await muxVideoWithNarration(trimmedMegaClip, megaAudioPath, megaMuxed);
        assertFileExists(megaMuxed, `MEGA_MUXED`);

        // -- F. Save mega-scene result for scenes 1+2
        sceneFiles[0] = megaMuxed;
        sceneFiles[1] = megaMuxed;
        jobContext.sceneClipMetaList.push({
          localFilePath: megaMuxed,
          subject: candidateSubjects[0] || mainTopic,
          sceneIdx: 0,
          source: megaClipPath.includes('pexels') ? 'pexels' : megaClipPath.includes('pixabay') ? 'pixabay' : 'r2',
          category: categoryFolder
        });
        jobContext.sceneClipMetaList.push({
          localFilePath: megaMuxed,
          subject: candidateSubjects[0] || mainTopic,
          sceneIdx: 1,
          source: megaClipPath.includes('pexels') ? 'pexels' : megaClipPath.includes('pixabay') ? 'pixabay' : 'r2',
          category: categoryFolder
        });

        // === 3. Process remaining scenes with bulletproof async for...of loop ===
        for (let i = 2; i < scenes.length; i++) {
          const scene = scenes[i];
          let sceneIdx = i;
          let sceneSubject = scene.visualSubject || (Array.isArray(scene.texts) && scene.texts[0]) || allSceneTexts[sceneIdx];
          const GENERIC_SUBJECTS = ['face','person','man','woman','it','thing','someone','something','body','eyes'];
          if (GENERIC_SUBJECTS.includes((sceneSubject || '').toLowerCase())) {
            sceneSubject = mainTopic;
          }
          let clipPath = null;
          try {
            console.log(`[5B][SCENE][${sceneIdx + 1}] Finding clip for subject: "${sceneSubject}"`);
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
          if (!clipPath) throw new Error(`[5B][ERR] No clip found for scene ${sceneIdx + 1}`);
          usedClips.push(clipPath);

          // === ENSURE CLIP IS LOCAL (R2 or remote source) ===
          const localClipPath = path.join(workDir, path.basename(clipPath));
          await ensureLocalClipExists(clipPath, localClipPath);

          assertFileExists(localClipPath, `CLIP_SCENE_${sceneIdx+1}`);

          // AUDIO GENERATION WITH CACHE
          const audioHash = hashForCache(JSON.stringify({
            text: scene.texts,
            voice,
            provider
          }));
          const audioCachePath = path.join(audioCacheDir, `${audioHash}.mp3`);
          if (!fs.existsSync(audioCachePath) || fs.statSync(audioCachePath).size < 10000)
            await deps.createSceneAudio(scene.texts[0], voice, audioCachePath, provider);
          assertFileExists(audioCachePath, `AUDIO_SCENE_${sceneIdx+1}`);

          // TRIM/MUX
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
          console.log(`[5B][SCENE][${sceneIdx + 1}] Done: ${videoCachePath}`);
        }

        progress[jobId] = { percent: 40, status: 'Stitching your video together...' };

        // === 4. Bulletproof video scenes (codec/size) ===
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

        // === 5. Concatenate all scene files ===
        let concatPath;
        try {
          progress[jobId] = { percent: 60, status: 'Combining everything into one amazing video...' };
          concatPath = await concatScenes(sceneFiles, workDir, jobContext.sceneClipMetaList);
          assertFileExists(concatPath, 'CONCAT_OUT');
        } catch (e) {
          throw new Error(`[5B][CONCAT][ERR][${jobId}] concatScenes failed: ${e}`);
        }

        // === 6. Ensure audio (add silence if needed) ===
        let withAudioPath;
        try {
          progress[jobId] = { percent: 70, status: 'Finalizing your audio...' };
          withAudioPath = await ensureAudioStream(concatPath, workDir);
          assertFileExists(withAudioPath, 'AUDIOFIX_OUT');
        } catch (e) {
          throw new Error(`[5B][AUDIO][ERR][${jobId}] ensureAudioStream failed: ${e}`);
        }

        // === 7. Overlay background music (if enabled) ===
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

        // === 8. Append outro (if enabled) ===
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

        // === 9. Upload final video to R2 and finish ===
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

// === UPLOAD TO R2 (Helper) ===
async function uploadToR2(finalPath, r2FinalName, jobId) {
  const bucket = process.env.R2_FINALS_BUCKET || 'socialstorm-finals';
  const fileData = fs.readFileSync(finalPath);
  const key = r2FinalName.startsWith('jobs/') ? r2FinalName : `jobs/${jobId}/${r2FinalName}`;
  console.log(`[5B][R2][UPLOAD] Uploading final to bucket=${bucket} key=${key}`);
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileData,
    ContentType: 'video/mp4'
  }));
  const urlBase = process.env.R2_FINALS_BASEURL || '';
  const url = urlBase ? `${urlBase.replace(/\/$/, '')}/${key}` : key;
  console.log(`[5B][R2][UPLOAD][OK] Final uploaded: ${url}`);
  return url;
}
