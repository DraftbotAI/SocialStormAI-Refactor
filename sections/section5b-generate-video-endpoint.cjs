// ===========================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT (Job Controller)
// The /api/generate-video route handler. Full job orchestration.
// MAX LOGGING EVERYWHERE
// Enhanced: Mega-scene (hook+main) support
// ===========================================================

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const {
  concatScenes,
  ensureAudioStream,
  overlayMusic,
  appendOutro,
  bulletproofScenes
} = require('./section5g-concat-and-music.cjs');

console.log('[5B][INIT] section5b-generate-video-endpoint.cjs loaded');

function registerGenerateVideoEndpoint(app, deps) {
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
    progress[jobId] = { percent: 0, status: 'starting' };
    console.log(`[5B][INFO] New job started: ${jobId}`);
    res.json({ jobId });

    // --- MAIN VIDEO JOB HANDLER ---
    (async () => {
      const workDir = path.join(__dirname, '..', 'jobs', jobId);
      try {
        fs.mkdirSync(workDir, { recursive: true });
        progress[jobId] = { percent: 2, status: 'created work dir' };
        console.log(`[5B][WORKDIR] ${workDir} created.`);

        // === 1. Parse and split script into scenes ===
        const { script = '', voice = '', music = true, outro = true, provider = 'polly' } = req.body || {};
        if (!script || !voice) throw new Error('Missing script or voice');
        console.log('[5B][INPUTS] Script length:', script.length, 'Voice:', voice);

        const scenes = splitScriptToScenes(script);
        console.log(`[5B][SCENES] Split into ${scenes.length} scenes.`);
        if (!Array.isArray(scenes) || scenes.length === 0) throw new Error('[5B][ERR] No scenes parsed from script.');

        // === 2. Find/generate video clip for each scene ===
        const usedClips = [];
        const sceneFiles = [];

        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i];
          const isMegaScene = !!scene.isMegaScene;
          progress[jobId] = { percent: 5 + i * 5, status: `Finding clip for scene ${i + 1}` };

          // Main subject for mega-scene: always from scene 1+2
          const mainTopic = (scenes[0].texts && scenes[0].texts[1]) ? scenes[0].texts[1] : scenes[0].texts[0];
          let subject = isMegaScene ? mainTopic : (scene.texts[0] || mainTopic);

          // --- CLIP MATCHING ---
          const clipPath = await findClipForScene({
            subject,
            sceneIdx: i,
            allSceneTexts: scenes.flatMap(s => s.texts),
            mainTopic,
            isMegaScene,
            usedClips
          });
          if (!clipPath) {
            throw new Error(`[5B][ERR] No clip found for scene ${i + 1}`);
          }
          usedClips.push(clipPath);
          console.log(`[5B][CLIP] Scene ${i + 1}: Clip selected: ${clipPath}`);

          // --- AUDIO GENERATION ---
          let audioPath;
          if (isMegaScene) {
            // Mega-scene: merge two lines into one audio
            audioPath = path.join(workDir, `scene${i + 1}-mega-audio.mp3`);
            await createMegaSceneAudio(scene.texts, voice, audioPath, provider, workDir);
            console.log(`[5B][AUDIO] Mega-scene: Merged audio created: ${audioPath}`);
          } else {
            audioPath = path.join(workDir, `scene${i + 1}-audio.mp3`);
            await createSceneAudio(scene.texts[0], voice, audioPath, provider);
            console.log(`[5B][AUDIO] Scene ${i + 1}: Audio generated: ${audioPath}`);
          }
          if (!audioPath || typeof audioPath !== 'string' || !fs.existsSync(audioPath)) {
            throw new Error(`[5B][ERR] No audio generated for scene ${i + 1}`);
          }

          // --- MUXING (combine) video and audio for the scene ---
          const muxedScenePath = path.join(workDir, `scene${i + 1}.mp4`);
          if (isMegaScene) {
            await muxMegaSceneWithNarration(clipPath, audioPath, muxedScenePath);
            console.log(`[5B][MUX] Mega-scene: Video and merged audio muxed: ${muxedScenePath}`);
          } else {
            await muxVideoWithNarration(clipPath, audioPath, muxedScenePath);
            console.log(`[5B][MUX] Scene ${i + 1}: Muxed scene written: ${muxedScenePath}`);
          }
          sceneFiles.push(muxedScenePath);
        }
        progress[jobId] = { percent: 40, status: 'All scenes muxed' };

        // === 3. Bulletproof video scenes (codec/size) ===
        const refInfo = await getVideoInfo(sceneFiles[0]);
        await bulletproofScenes(sceneFiles, refInfo, getVideoInfo, standardizeVideo);
        console.log('[5B][BULLETPROOF] All scenes bulletproofed.');

        // === 4. Concatenate all scene files ===
        const concatPath = await concatScenes(sceneFiles, workDir);
        progress[jobId] = { percent: 60, status: 'Scenes concatenated' };
        console.log(`[5B][CONCAT] Scenes concatenated: ${concatPath}`);

        // === 5. Ensure audio (add silence if needed) ===
        const withAudioPath = await ensureAudioStream(concatPath, workDir);
        progress[jobId] = { percent: 70, status: 'Audio checked' };
        console.log('[5B][AUDIO] Audio stream ensured.');

        // === 6. Overlay background music (if enabled) ===
        let musicPath = withAudioPath;
        if (music) {
          const chosenMusic = pickMusicForMood ? await pickMusicForMood(script, workDir) : null;
          if (chosenMusic) {
            const musicOutput = path.join(workDir, 'with-music.mp4');
            await overlayMusic(withAudioPath, chosenMusic, musicOutput);
            musicPath = musicOutput;
            progress[jobId] = { percent: 80, status: 'Music overlayed' };
            console.log('[5B][MUSIC] Music overlayed:', chosenMusic);
          } else {
            console.warn('[5B][MUSIC] No background music found/skipped.');
          }
        }

        // === 7. Append outro (if enabled) ===
        let finalPath = musicPath;
        if (outro) {
          const outroPath = path.resolve(__dirname, '..', 'public', 'video', 'outro.mp4');
          if (fs.existsSync(outroPath)) {
            const outroOutput = path.join(workDir, 'final-with-outro.mp4');
            await appendOutro(musicPath, outroPath, outroOutput, workDir);
            finalPath = outroOutput;
            progress[jobId] = { percent: 90, status: 'Outro appended' };
            console.log('[5B][OUTRO] Outro appended.');
          } else {
            console.warn('[5B][OUTRO] Outro file missing:', outroPath);
          }
        }

        // === 8. Job Complete! ===
        progress[jobId] = { percent: 100, status: 'complete', output: finalPath };
        console.log(`[5B][SUCCESS] Video job complete! Output at: ${finalPath}`);

      } catch (err) {
        console.error('[5B][FATAL][JOB] Video job failed:', err);
        progress[jobId] = { percent: 100, status: 'failed', error: err.message || err.toString() };
      } finally {
        if (cleanupJob) {
          try { cleanupJob(jobId); } catch (e) { console.warn('[5B][CLEANUP][WARN] Cleanup failed:', e); }
        }
      }
    })();
  });

  console.log('[5B][SUCCESS] /api/generate-video endpoint registered.');
}

console.log('[5B][EXPORT] registerGenerateVideoEndpoint exported');
module.exports = registerGenerateVideoEndpoint;
