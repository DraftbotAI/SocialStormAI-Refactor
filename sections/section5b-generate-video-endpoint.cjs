// ===========================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT (Job Controller)
// The /api/generate-video route handler. Full job orchestration.
// MAX LOGGING EVERYWHERE
// ===========================================================
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

// Import helpers directly
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

  // Destructure all helpers and state from deps for clarity and MAX logging
  const {
    splitScriptToScenes, findClipForScene, generateSceneAudio,
    getAudioDuration, getVideoInfo, standardizeVideo, pickMusicForMood, cleanupJob,
    progress, voices, POLLY_VOICE_IDS
    // Add any other helpers you use!
  } = deps;

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
        const { script = '', voice = '', music = true, outro = true } = req.body || {};
        if (!script || !voice) throw new Error('Missing script or voice');
        console.log('[5B][INPUTS] Script length:', script.length, 'Voice:', voice);

        const scenes = splitScriptToScenes(script);
        console.log(`[5B][SCENES] Split into ${scenes.length} scenes.`);

        // === 2. Find/generate video clip for each scene ===
        const sceneFiles = [];
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i];
          progress[jobId] = { percent: 5 + i * 5, status: `Finding clip for scene ${i + 1}` };
          console.log(`[5B][SCENE] Scene ${i + 1}: "${scene}"`);

          const clipPath = await findClipForScene(scene, i, scenes, scenes[0]);
          if (!clipPath) {
            throw new Error(`[5B][ERR] No clip found for scene ${i + 1}`);
          }
          console.log(`[5B][CLIP] Scene ${i + 1}: Clip selected: ${clipPath}`);

          // === Generate narration audio ===
          const audioPath = await generateSceneAudio(scene, voice, workDir, i, jobId);
          console.log(`[5B][AUDIO] Scene ${i + 1}: Audio generated: ${audioPath}`);

          // === Mux (combine) video and audio for the scene ===
          const muxedScenePath = path.join(workDir, `scene${i + 1}.mp4`);
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(clipPath)
              .input(audioPath)
              .outputOptions(['-shortest', '-y'])
              .save(muxedScenePath)
              .on('end', () => {
                console.log(`[5B][MUX] Scene ${i + 1}: Muxed scene written: ${muxedScenePath}`);
                resolve();
              })
              .on('error', (err) => {
                console.error(`[5B][MUX][ERR] Scene ${i + 1}: Muxing failed`, err);
                reject(err);
              });
          });
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
