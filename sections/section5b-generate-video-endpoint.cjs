// ===========================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT (Job Controller)
// The /api/generate-video route handler. Full job orchestration.
// MAX LOGGING EVERYWHERE, User-friendly status messages!
// Enhanced: Mega-scene (hook+main) support
// Now: Uploads final video to Cloudflare R2 and returns public R2 URL
// ===========================================================

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// R2 dependencies
const { s3Client, PutObjectCommand } = require('./section1-setup.cjs'); // update path if needed

const {
  concatScenes,
  ensureAudioStream,
  overlayMusic,
  appendOutro,
  bulletproofScenes
} = require('./section5g-concat-and-music.cjs');

console.log('[5B][INIT] section5b-generate-video-endpoint.cjs loaded');

// ================= R2 UPLOAD HELPER =======================
/**
 * Uploads a video file to Cloudflare R2 and returns the public URL
 * @param {string} localFilePath
 * @param {string} jobId
 */
async function uploadToR2(localFilePath, jobId) {
  try {
    const fileBuffer = fs.readFileSync(localFilePath);
    const r2Key = `videos/${jobId}/final-with-outro.mp4`;
    await s3Client.send(new PutObjectCommand({
      Bucket: 'socialstorm-videos',
      Key: r2Key,
      Body: fileBuffer,
      ContentType: 'video/mp4'
    }));
    // Replace with your actual Cloudflare account ID or custom domain if using a CNAME
    const publicUrl = `https://<your-account-id>.r2.cloudflarestorage.com/socialstorm-videos/${r2Key}`;
    console.log(`[5B][R2 UPLOAD] Uploaded video for job ${jobId} to R2: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    console.error(`[5B][R2 UPLOAD][ERR] Failed to upload video for job ${jobId}:`, err);
    throw err;
  }
}
// ===========================================================

function registerGenerateVideoEndpoint(app, deps) {
  console.log('[5B][BOOT] Called registerGenerateVideoEndpoint...');
  if (!app) {
    console.error('[5B][FATAL] No app passed in!');
    throw new Error('[5B][FATAL] No app passed in!');
  }
  if (!deps) {
    console.error('[5B][FATAL] No dependencies passed in!');
    throw new Error('[5B][FATAL] No dependencies passed in!');
  }

  // Destructure helpers/state from deps for clarity + MAX logging
  const {
    splitScriptToScenes,
    findClipForScene,
    createSceneAudio,
    createMegaSceneAudio,
    getAudioDuration, getVideoInfo, standardizeVideo,
    pickMusicForMood, cleanupJob,
    progress, voices, POLLY_VOICE_IDS,
    muxVideoWithNarration, muxMegaSceneWithNarration,
  } = deps;

  if (typeof findClipForScene !== "function") {
    console.error('[5B][FATAL] findClipForScene not provided or not a function!');
    throw new Error('[5B][FATAL] findClipForScene missing from deps!');
  }
  if (typeof createSceneAudio !== "function" || typeof createMegaSceneAudio !== "function") {
    console.error('[5B][FATAL] Audio generation helpers missing!');
    throw new Error('[5B][FATAL] Audio generation helpers missing!');
  }
  if (typeof splitScriptToScenes !== "function") {
    console.error('[5B][FATAL] splitScriptToScenes not provided or not a function!');
    throw new Error('[5B][FATAL] splitScriptToScenes missing from deps!');
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
      try {
        fs.mkdirSync(workDir, { recursive: true });
        progress[jobId] = { percent: 2, status: 'Setting up your project...' };
        console.log(`[5B][WORKDIR] [${jobId}] Created: ${workDir}`);

        // === 1. Parse and split script into scenes ===
        const { script = '', voice = '', music = true, outro = true, provider = 'polly' } = req.body || {};
        if (!script || !voice) throw new Error('Missing script or voice');
        console.log(`[5B][INPUTS] [${jobId}] Script length: ${script.length} | Voice: ${voice}`);

        let scenes = splitScriptToScenes(script);
        console.log(`[5B][SCENES] [${jobId}] Split into ${scenes.length} scenes.`);

        // ---- AUTO-WRAP IF SPLITTER RETURNS STRINGS (DEV PATCH) ----
        let wrapped = false;
        scenes = scenes.map((scene, i) => {
          if (typeof scene === 'string') {
            wrapped = true;
            return { texts: [scene], isMegaScene: false };
          }
          if (!scene.texts || !Array.isArray(scene.texts)) {
            wrapped = true;
            return { texts: [String(scene)], isMegaScene: false };
          }
          return scene;
        });
        if (wrapped) {
          console.warn(`[5B][WARN][${jobId}] Some scenes auto-wrapped to expected structure. You should fix Section 5C splitter!`);
        }

        if (!Array.isArray(scenes) || scenes.length === 0) throw new Error('[5B][ERR] No scenes parsed from script.');
        // Debug: Log the first scene object structure
        console.log(`[5B][DEBUG][SCENES STRUCTURE] First scene: ${JSON.stringify(scenes[0], null, 2)}`);

        // Defensive: Validate all scenes before running job
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i];
          if (
            !scene ||
            typeof scene !== 'object' ||
            !Array.isArray(scene.texts) ||
            !scene.texts[0] ||
            (typeof scene.texts[0] !== 'string')
          ) {
            console.error(`[5B][FATAL][JOB] [${jobId}] Scene ${i + 1} is invalid or missing .texts array:`, JSON.stringify(scene, null, 2));
            throw new Error(`[5B][FATAL] Scene ${i + 1} is missing .texts array or is not structured correctly!`);
          }
        }

        // === 2. Find/generate video clip for each scene ===
        const usedClips = [];
        const sceneFiles = [];

        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i];
          const isMegaScene = !!scene.isMegaScene;
          progress[jobId] = { percent: 5 + i * 5, status: `Finding the perfect video for step ${i + 1}...` };
          console.log(`[5B][SCENE] [${jobId}] Processing scene ${i + 1} / ${scenes.length} (megaScene: ${isMegaScene})`);

          // Main subject for mega-scene: always from scene 1+2
          let mainTopic = null;
          if (
            scenes[0] &&
            Array.isArray(scenes[0].texts)
          ) {
            mainTopic = (scenes[0].texts[1]) ? scenes[0].texts[1] : scenes[0].texts[0];
          } else {
            mainTopic = scene.texts[0];
          }
          let subject = isMegaScene ? mainTopic : (scene.texts[0] || mainTopic);

          // --- CLIP MATCHING ---
          console.log(`[5B][MATCH] [${jobId}] Scene ${i + 1}: Subject for matching: "${subject}"`);
          let clipPath = null;
          try {
            clipPath = await findClipForScene({
              subject,
              sceneIdx: i,
              allSceneTexts: scenes.flatMap(s => s.texts),
              mainTopic,
              isMegaScene,
              usedClips,
              workDir,
              jobId
            });
          } catch (e) {
            console.error(`[5B][CLIP][ERR] [${jobId}] findClipForScene failed for scene ${i + 1}:`, e);
          }
          if (!clipPath) {
            throw new Error(`[5B][ERR] No clip found for scene ${i + 1}`);
          }
          usedClips.push(clipPath);
          console.log(`[5B][CLIP] [${jobId}] Scene ${i + 1}: Clip selected: ${clipPath}`);

          // --- AUDIO GENERATION ---
          let audioPath;
          if (isMegaScene) {
            audioPath = path.join(workDir, `scene${i + 1}-mega-audio.mp3`);
            try {
              progress[jobId] = { percent: 12 + i * 5, status: `Recording your viral intro...` };
              await createMegaSceneAudio(scene.texts, voice, audioPath, provider, workDir);
              console.log(`[5B][AUDIO] [${jobId}] Mega-scene audio created: ${audioPath}`);
            } catch (e) {
              console.error(`[5B][AUDIO][ERR] [${jobId}] Mega-scene audio gen failed:`, e);
              throw e;
            }
          } else {
            audioPath = path.join(workDir, `scene${i + 1}-audio.mp3`);
            try {
              progress[jobId] = { percent: 14 + i * 5, status: `Voicing scene ${i + 1}...` };
              await createSceneAudio(scene.texts[0], voice, audioPath, provider);
              console.log(`[5B][AUDIO] [${jobId}] Scene ${i + 1} audio generated: ${audioPath}`);
            } catch (e) {
              console.error(`[5B][AUDIO][ERR] [${jobId}] Scene ${i + 1} audio gen failed:`, e);
              throw e;
            }
          }
          if (!audioPath || typeof audioPath !== 'string' || !fs.existsSync(audioPath)) {
            throw new Error(`[5B][ERR] No audio generated for scene ${i + 1}`);
          }

          // --- MUXING (combine) video and audio for the scene ---
          const muxedScenePath = path.join(workDir, `scene${i + 1}.mp4`);
          try {
            progress[jobId] = { percent: 16 + i * 5, status: `Syncing voice and visuals for step ${i + 1}...` };
            if (isMegaScene) {
              await muxMegaSceneWithNarration(clipPath, audioPath, muxedScenePath);
              console.log(`[5B][MUX] [${jobId}] Mega-scene muxed: ${muxedScenePath}`);
            } else {
              await muxVideoWithNarration(clipPath, audioPath, muxedScenePath);
              console.log(`[5B][MUX] [${jobId}] Scene ${i + 1} muxed: ${muxedScenePath}`);
            }
          } catch (e) {
            console.error(`[5B][MUX][ERR] [${jobId}] Scene ${i + 1} mux failed:`, e);
            throw e;
          }
          sceneFiles.push(muxedScenePath);
        }
        progress[jobId] = { percent: 40, status: 'Stitching your video together...' };
        console.log(`[5B][SCENES] [${jobId}] All scenes muxed:`, sceneFiles);

        // === 3. Bulletproof video scenes (codec/size) ===
        let refInfo = null;
        try {
          progress[jobId] = { percent: 44, status: 'Checking video quality...' };
          refInfo = await getVideoInfo(sceneFiles[0]);
        } catch (e) {
          console.error(`[5B][BULLETPROOF][ERR] [${jobId}] Failed to get video info:`, e);
          throw e;
        }
        try {
          await bulletproofScenes(sceneFiles, refInfo, getVideoInfo, standardizeVideo);
          progress[jobId] = { percent: 48, status: 'Perfecting your video quality...' };
          console.log(`[5B][BULLETPROOF] [${jobId}] All scenes bulletproofed.`);
        } catch (e) {
          console.error(`[5B][BULLETPROOF][ERR] [${jobId}] bulletproofScenes failed:`, e);
          throw e;
        }

        // === 4. Concatenate all scene files ===
        let concatPath;
        try {
          progress[jobId] = { percent: 60, status: 'Combining everything into one amazing video...' };
          concatPath = await concatScenes(sceneFiles, workDir);
          console.log(`[5B][CONCAT] [${jobId}] Scenes concatenated: ${concatPath}`);
        } catch (e) {
          console.error(`[5B][CONCAT][ERR] [${jobId}] concatScenes failed:`, e);
          throw e;
        }

        // === 5. Ensure audio (add silence if needed) ===
        let withAudioPath;
        try {
          progress[jobId] = { percent: 70, status: 'Finalizing your audio...' };
          withAudioPath = await ensureAudioStream(concatPath, workDir);
          console.log(`[5B][AUDIO] [${jobId}] Audio stream ensured: ${withAudioPath}`);
        } catch (e) {
          console.error(`[5B][AUDIO][ERR] [${jobId}] ensureAudioStream failed:`, e);
          throw e;
        }

        // === 6. Overlay background music (if enabled) ===
        let musicPath = withAudioPath;
        if (music) {
          try {
            progress[jobId] = { percent: 80, status: 'Adding background music...' };
            const chosenMusic = pickMusicForMood ? await pickMusicForMood(script, workDir) : null;
            if (chosenMusic) {
              const musicOutput = path.join(workDir, 'with-music.mp4');
              await overlayMusic(withAudioPath, chosenMusic, musicOutput);
              musicPath = musicOutput;
              progress[jobId] = { percent: 82, status: 'Background music ready!' };
              console.log(`[5B][MUSIC] [${jobId}] Music overlayed: ${chosenMusic}`);
            } else {
              progress[jobId] = { percent: 80, status: 'No music found, skipping...' };
              console.warn(`[5B][MUSIC][WARN] [${jobId}] No background music found/skipped.`);
            }
          } catch (e) {
            console.error(`[5B][MUSIC][ERR] [${jobId}] overlayMusic failed:`, e);
            throw e;
          }
        } else {
          progress[jobId] = { percent: 80, status: 'Music skipped (user setting).' };
          console.log(`[5B][MUSIC][SKIP] [${jobId}] Music overlay skipped (music disabled).`);
        }

        // === 7. Append outro (if enabled) ===
        let finalPath = musicPath;
        if (outro) {
          const outroPath = path.resolve(__dirname, '..', 'public', 'video', 'outro.mp4');
          if (fs.existsSync(outroPath)) {
            try {
              progress[jobId] = { percent: 90, status: 'Adding your outro...' };
              const outroOutput = path.join(workDir, 'final-with-outro.mp4');
              await appendOutro(musicPath, outroPath, outroOutput, workDir);
              finalPath = outroOutput;
              progress[jobId] = { percent: 92, status: 'Outro added! Wrapping up...' };
              console.log(`[5B][OUTRO] [${jobId}] Outro appended: ${outroPath}`);
            } catch (e) {
              console.error(`[5B][OUTRO][ERR] [${jobId}] appendOutro failed:`, e);
              throw e;
            }
          } else {
            progress[jobId] = { percent: 90, status: 'Finalizing your masterpiece...' };
            console.warn(`[5B][OUTRO][WARN] [${jobId}] Outro file missing: ${outroPath}`);
          }
        } else {
          progress[jobId] = { percent: 90, status: 'Outro skipped (user setting).' };
          console.log(`[5B][OUTRO][SKIP] [${jobId}] Outro append skipped (outro disabled).`);
        }

        // === 8. Upload final video to R2 and finish ===
        try {
          progress[jobId] = { percent: 98, status: 'Uploading video to Cloudflare R2...' };
          const r2VideoUrl = await uploadToR2(finalPath, jobId);
          progress[jobId] = { percent: 100, status: 'Your video is ready! 🎉', output: r2VideoUrl };
          console.log(`[5B][SUCCESS] [${jobId}] Video job complete! Output at: ${r2VideoUrl}`);
        } catch (uploadErr) {
          // Fallback: at least provide local output if upload fails
          progress[jobId] = { percent: 100, status: 'Video ready locally (Cloudflare upload failed).', output: finalPath };
          console.error(`[5B][FATAL][JOB] [${jobId}] Cloudflare R2 upload failed, local file only:`, uploadErr);
        }

      } catch (err) {
        console.error(`[5B][FATAL][JOB] [${jobId}] Video job failed:`, err);
        progress[jobId] = { percent: 100, status: 'Something went wrong. Please try again or contact support.', error: err.message || err.toString() };
      } finally {
        if (cleanupJob) {
          try {
            cleanupJob(jobId); // Now uses delayed cleanup for progress entry
            console.log(`[5B][CLEANUP] [${jobId}] Cleanup scheduled (delayed progress removal).`);
          } catch (e) {
            console.warn(`[5B][CLEANUP][WARN] [${jobId}] Cleanup failed:`, e);
          }
        }
      }
    })();
  });

  console.log('[5B][SUCCESS] /api/generate-video endpoint registered.');
}

console.log('[5B][EXPORT] registerGenerateVideoEndpoint exported');
module.exports = registerGenerateVideoEndpoint;
