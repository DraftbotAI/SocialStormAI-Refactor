/* ===========================================================
   SECTION 5: VIDEO GENERATION ENDPOINT (Monolithic, Subsectioned)
   -----------------------------------------------------------
   - POST /api/generate-video
   - Handles script, voice, branding, outro, background music
   - Bulletproof file/dir safety; SUPER MAX logging in every step
   - Internally divided into labeled subsections 5A–5H
   =========================================================== */

// ========== 5A: TTS & SUBJECT HELPERS ==========
console.log('[5A][INIT] TTS and subject extraction helpers loaded.');
const AWS = require('aws-sdk');
const fs = require('fs');

async function extractVisualSubject(line, scriptTopic = '') {
  console.log(`[5A][EXTRACT] Dummy extractVisualSubject for: "${line}" | topic: "${scriptTopic}"`);
  return line;
}

async function generatePollyTTS(text, voiceId, outPath) {
  try {
    console.log(`[5A][POLLY] Synthesizing speech: "${text}" [voice: ${voiceId}] → ${outPath}`);
    const polly = new AWS.Polly();
    const params = {
      OutputFormat: 'mp3',
      Text: text,
      VoiceId: voiceId,
      Engine: 'neural'
    };
    const data = await polly.synthesizeSpeech(params).promise();
    fs.writeFileSync(outPath, data.AudioStream);
    console.log(`[5A][POLLY] Audio written: ${outPath}`);
  } catch (err) {
    console.error(`[5A][ERR][POLLY] TTS failed for voice ${voiceId} text: "${text}"`, err);
    throw err;
  }
}

async function generateElevenLabsTTS(text, voiceId, outPath) {
  console.error('[5A][ERR][11LABS] ElevenLabs TTS not implemented!');
  throw new Error('ElevenLabs TTS not implemented');
}

async function generateSceneAudio(sceneText, voiceId, outPath, provider) {
  console.log(`[5A][AUDIO] generateSceneAudio called: "${sceneText}" | voice: ${voiceId} | provider: ${provider} | out: ${outPath}`);
  if (!provider) throw new Error("No TTS provider specified");
  if (!sceneText || !voiceId || !outPath) throw new Error("Missing input for generateSceneAudio");
  if (provider.toLowerCase() === 'polly') {
    await generatePollyTTS(sceneText, voiceId, outPath);
  } else if (provider.toLowerCase() === 'elevenlabs') {
    await generateElevenLabsTTS(sceneText, voiceId, outPath);
  } else {
    throw new Error(`Unknown TTS provider: ${provider}`);
  }
}

// ========== 5B: MAIN ENDPOINT ==========

function registerGenerateVideoEndpoint(app, deps) {
  if (!app) throw new Error('[5B][FATAL] No app passed in!');
  if (!deps) throw new Error('[5B][FATAL] No dependencies passed in!');

  // Destructure all helpers and state from deps for clarity and MAX logging
  const {
    voices, POLLY_VOICE_IDS, splitScriptToScenes, findClipForScene, downloadRemoteFileToLocal,
    getAudioDuration, trimVideo, normalizeTo9x16Blurred, addSilentAudioTrack, muxVideoWithNarration,
    getVideoInfo, standardizeVideo, pickMusicForMood, cleanupJob,
    s3Client, PutObjectCommand, progress
  } = deps;

  const path = require('path');
  const ffmpeg = require('fluent-ffmpeg');
  const { v4: uuidv4 } = require('uuid');

  console.log('[5B][INIT] Video generation endpoint initialized.');

  app.post('/api/generate-video', (req, res) => {
    console.log('[5B][REQ] POST /api/generate-video');
    const jobId = uuidv4();
    progress[jobId] = { percent: 0, status: 'starting' };
    console.log(`[5B][INFO] New job started: ${jobId}`);
    res.json({ jobId });

    (async () => {
      let finished = false;
      const watchdog = setTimeout(() => {
        if (!finished && progress[jobId]) {
          progress[jobId] = { percent: 100, status: "Failed: Timed out." };
          cleanupJob(jobId);
          console.warn(`[5B][WATCHDOG] Job ${jobId} timed out and was cleaned up`);
        }
      }, 12 * 60 * 1000);

      try {
        const {
          script = '',
          voice = '',
          paidUser = false,
          removeOutro = false,
          title = '',
          backgroundMusic = true,
          musicMood = null
        } = req.body || {};

        console.log(`[5C][STEP] Inputs parsed. Voice: ${voice} | Paid: ${paidUser} | Music: ${backgroundMusic} | Mood: ${musicMood} | Remove Outro: ${removeOutro}`);
        console.log(`[5C][DEBUG] Raw script:\n${script}`);

        if (!script || !voice) {
          progress[jobId] = { percent: 100, status: 'Failed: Missing script or voice.' };
          cleanupJob(jobId); clearTimeout(watchdog);
          return;
        }

        const selectedVoice = voices.find(v => v.id === voice);
        const ttsProvider = selectedVoice ? selectedVoice.provider : null;

        if (!ttsProvider) {
          progress[jobId] = { percent: 100, status: `Failed: Unknown voice (${voice})` };
          cleanupJob(jobId); clearTimeout(watchdog);
          return;
        }

        if (ttsProvider.toLowerCase() === 'polly' && !POLLY_VOICE_IDS.includes(voice)) {
          progress[jobId] = { percent: 100, status: `Failed: Invalid Polly voice (${voice})` };
          cleanupJob(jobId); clearTimeout(watchdog);
          return;
        }

        const workDir = path.resolve(__dirname, '..', 'renders', jobId);
        fs.mkdirSync(workDir, { recursive: true });
        console.log(`[5D][STEP] Work dir created: ${workDir}`);

        const scenes = splitScriptToScenes(script);
        if (!scenes.length) {
          progress[jobId] = { percent: 100, status: 'Failed: No scenes from script' };
          cleanupJob(jobId); clearTimeout(watchdog);
          return;
        }
        console.log(`[5D][STEP] Script split into ${scenes.length} scenes.`);
        console.log('[5D][DEBUG] Scenes array:', JSON.stringify(scenes, null, 2));

        let sceneFiles = [];
        let line2Subject = scenes[1]?.text || '';
        let mainTopic = title || '';
        let sharedClipUrl = null;

        // ---- Extract better main subject for scene 1/2 ----
        let sharedSubject = await extractVisualSubject(line2Subject, mainTopic);
        try {
          sharedClipUrl = await findClipForScene(sharedSubject, 1, scenes.map(s => s.text), mainTopic);
          console.log(`[5E][SCENE 1&2] Selected shared clip for hook/scene2: ${sharedClipUrl}`);
        } catch (err) {
          console.error(`[5E][ERR] Could not select shared video clip for scenes 1 & 2`, err);
        }

        for (let i = 0; i < scenes.length; i++) {
          if (!scenes[i]) {
            console.error(`[5E][ERR] Scene at index ${i} is undefined!`);
            progress[jobId] = { percent: 100, status: `Failed: Scene ${i + 1} undefined` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }
          const { id: sceneId, text: sceneText } = scenes[i];
          const base = sceneId;
          const audioPath = path.resolve(workDir, `${base}-audio.mp3`);
          const rawVideoPath = path.resolve(workDir, `${base}-rawvideo.mp4`);
          const trimmedVideoPath = path.resolve(workDir, `${base}-trimmed.mp4`);
          const normalizedVideoPath = path.resolve(workDir, `${base}-norm.mp4`);
          const videoWithSilence = path.resolve(workDir, `${base}-silence.mp4`);
          const sceneMp4 = path.resolve(workDir, `${base}.mp4`);

          progress[jobId] = {
            percent: Math.floor((i / scenes.length) * 65),
            status: `Working on scene ${i + 1} of ${scenes.length}...`
          };
          console.log(`[5E][SCENE] Working on scene ${i + 1}/${scenes.length}: "${sceneText}"`);

          try {
            console.log(`[5F][AUDIO] Generating scene ${i + 1} audio…`);
            await generateSceneAudio(sceneText, voice, audioPath, ttsProvider);
            if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1024) {
              throw new Error(`Audio output missing or too small: ${audioPath}`);
            }
            console.log(`[5F][AUDIO] Scene ${i + 1} audio created: ${audioPath}`);
          } catch (err) {
            console.error(`[5F][ERR] Audio generation failed for scene ${i + 1}`, err);
            progress[jobId] = { percent: 100, status: `Failed: Audio generation error (scene ${i + 1})` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }

          let clipUrl = null;
          if (i === 0 || i === 1) {
            clipUrl = sharedClipUrl;
          } else {
            try {
              const sceneSubject = await extractVisualSubject(sceneText, mainTopic);
              console.log(`[5F][MATCH] Scene ${i + 1} subject: "${sceneSubject}"`);
              clipUrl = await findClipForScene(sceneSubject, i, scenes.map(s => s.text), mainTopic);
            } catch (err) {
              console.error(`[5F][ERR] Clip matching failed for scene ${i + 1}`, err);
            }
          }

          if (!clipUrl) {
            progress[jobId] = { percent: 100, status: `Failed: No video found for scene ${i + 1}` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }

          try {
            console.log(`[5F][VIDEO] Downloading video for scene ${i + 1}…`);
            await downloadRemoteFileToLocal(clipUrl, rawVideoPath);
            if (!fs.existsSync(rawVideoPath) || fs.statSync(rawVideoPath).size < 10240) {
              throw new Error(`Video output missing or too small: ${rawVideoPath}`);
            }
            console.log(`[5F][VIDEO] Downloaded for scene ${i + 1}: ${rawVideoPath}`);
          } catch (err) {
            console.error(`[5F][ERR] Video download failed for scene ${i + 1}`, err);
            progress[jobId] = { percent: 100, status: `Failed: Video download error (scene ${i + 1})` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }

          let audioDuration;
          try {
            console.log(`[5F][AUDIO] Getting audio duration for scene ${i + 1}…`);
            audioDuration = await getAudioDuration(audioPath);
            if (!audioDuration || audioDuration < 0.2) throw new Error("Audio duration zero or invalid.");
            console.log(`[5F][AUDIO] Duration for scene ${i + 1}: ${audioDuration}s`);
          } catch (err) {
            console.error(`[5F][ERR] Could not get audio duration for scene ${i + 1}`, err);
            progress[jobId] = { percent: 100, status: `Failed: Audio duration error (scene ${i + 1})` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }
          const leadIn = 0.5, tail = 1.0;
          const sceneDuration = leadIn + audioDuration + tail;

          try {
            console.log(`[5F][TRIM] Trimming video for scene ${i + 1} to ${sceneDuration}s…`);
            await trimVideo(rawVideoPath, trimmedVideoPath, sceneDuration, 0);
            if (!fs.existsSync(trimmedVideoPath) || fs.statSync(trimmedVideoPath).size < 10240) {
              throw new Error(`Trimmed video missing or too small: ${trimmedVideoPath}`);
            }
            console.log(`[5F][TRIM] Video trimmed for scene ${i + 1}: ${trimmedVideoPath} (${sceneDuration}s)`);
          } catch (err) {
            console.error(`[5F][ERR] Trimming video failed for scene ${i + 1}`, err);
            progress[jobId] = { percent: 100, status: `Failed: Video trim error (scene ${i + 1})` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }

          try {
            console.log(`[5F][NORMALIZE] Normalizing video for scene ${i + 1} to 1080x1920 with blurred background…`);
            await normalizeTo9x16Blurred(trimmedVideoPath, normalizedVideoPath, 1080, 1920);
            if (!fs.existsSync(normalizedVideoPath) || fs.statSync(normalizedVideoPath).size < 10240) {
              throw new Error(`Normalized 9:16 video missing or too small: ${normalizedVideoPath}`);
            }
            console.log(`[5F][NORMALIZE] Video normalized for scene ${i + 1}: ${normalizedVideoPath}`);
          } catch (err) {
            console.error(`[5F][ERR] 9:16 normalization failed for scene ${i + 1}`, err);
            progress[jobId] = { percent: 100, status: `Failed: 9:16 normalization error (scene ${i + 1})` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }

          try {
            await addSilentAudioTrack(normalizedVideoPath, videoWithSilence, sceneDuration);
            if (!fs.existsSync(videoWithSilence) || fs.statSync(videoWithSilence).size < 10240) {
              throw new Error(`Silent-audio video missing or too small: ${videoWithSilence}`);
            }
            console.log(`[5F][AUDIOFIX] Silent audio added for scene ${i + 1}: ${videoWithSilence}`);
          } catch (err) {
            console.error(`[5F][ERR] Could not add silent audio for scene ${i + 1}`, err);
            progress[jobId] = { percent: 100, status: `Failed: Silent audio error (scene ${i + 1})` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }

          try {
            await muxVideoWithNarration(videoWithSilence, audioPath, sceneMp4, sceneDuration);
            if (!fs.existsSync(sceneMp4) || fs.statSync(sceneMp4).size < 10240) {
              throw new Error(`Combined scene output missing or too small: ${sceneMp4}`);
            }
            sceneFiles.push(sceneMp4);
            console.log(`[5F][COMBINE] Scene ${i + 1} ready for concat: ${sceneMp4}`);
          } catch (err) {
            console.error(`[5F][ERR] Scene mux failed (scene ${i + 1})`, err);
            progress[jobId] = { percent: 100, status: `Failed: Scene mux error (scene ${i + 1})` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }
          console.log(`[5F][SCENE] Finished processing scene ${i + 1}/${scenes.length}.`);
        }

        // === BULLETPROOF: Validate and standardize all scenes before concat ===
        let refInfo = null;
        try {
          refInfo = await getVideoInfo(sceneFiles[0]);
          const v = (refInfo.streams || []).find(s => s.codec_type === 'video');
          refInfo.width = v.width;
          refInfo.height = v.height;
          refInfo.codec_name = v.codec_name;
          refInfo.pix_fmt = v.pix_fmt;
          console.log('[5G][BULLETPROOF] Reference video info:', refInfo);
        } catch (err) {
          console.error('[5G][ERR] Could not get reference video info:', err);
          progress[jobId] = { percent: 100, status: 'Failed: Reference video info error' };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        for (let i = 0; i < sceneFiles.length; i++) {
          try {
            const info = await getVideoInfo(sceneFiles[i]);
            const v = (info.streams || []).find(s => s.codec_type === 'video');
            const a = (info.streams || []).find(s => s.codec_type === 'audio');
            const needsFix =
              !v ||
              v.codec_name !== refInfo.codec_name ||
              v.width !== refInfo.width ||
              v.height !== refInfo.height ||
              v.pix_fmt !== refInfo.pix_fmt ||
              !a;
            if (needsFix) {
              const fixedPath = sceneFiles[i].replace(/\.mp4$/, '-fixed.mp4');
              await standardizeVideo(sceneFiles[i], fixedPath, refInfo);
              fs.renameSync(fixedPath, sceneFiles[i]);
              console.log(`[5G][BULLETPROOF] Fixed scene ${i + 1} video: ${sceneFiles[i]}`);
            } else {
              console.log(`[5G][BULLETPROOF] Scene ${i + 1} validated OK`);
            }
          } catch (err) {
            console.error(`[5G][ERR] Bulletproof check failed for scene ${i + 1}`, err);
            progress[jobId] = { percent: 100, status: `Failed: Scene video validation error (${i + 1})` };
            cleanupJob(jobId); clearTimeout(watchdog); return;
          }
        }

        const listFile = path.resolve(workDir, 'list.txt');
        fs.writeFileSync(
          listFile,
          sceneFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
        );
        const concatFile = path.resolve(workDir, 'concat.mp4');

        progress[jobId] = { percent: 75, status: "Combining all scenes together..." };
        console.log(`[5G][CONCAT] Scene list for concat:\n${sceneFiles.join('\n')}`);

        try {
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(listFile)
              .inputOptions(['-f concat', '-safe 0'])
              .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
              .save(concatFile)
              .on('end', resolve)
              .on('error', reject);
          });
          if (!fs.existsSync(concatFile) || fs.statSync(concatFile).size < 10240) {
            throw new Error(`Concatenated file missing or too small: ${concatFile}`);
          }
          console.log(`[5G][STITCH] All scenes concatenated: ${concatFile}`);
        } catch (err) {
          console.error(`[5G][ERR] Concatenation failed`, err);
          progress[jobId] = { percent: 100, status: 'Failed: Scene concatenation' };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        // === Audio sanity fix (ensure concat.mp4 has audio) ===
        let concatInputFile = concatFile;
        let audioStreamExists = false;
        try {
          const probe = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(concatFile, (err, metadata) => {
              if (err) reject(err);
              resolve(metadata);
            });
          });
          audioStreamExists = (probe.streams || []).some(s => s.codec_type === 'audio');
          console.log(`[5G][AUDIOFIX] concat.mp4 audio stream exists: ${audioStreamExists}`);
        } catch (err) {
          console.error('[5G][ERR] Could not probe concat.mp4:', err);
        }
        if (!audioStreamExists) {
          const concatWithAudioPath = path.resolve(workDir, 'concat-audio.mp4');
          console.log('[5G][AUDIOFIX] concat.mp4 is missing audio, adding silent track...');
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(concatFile)
              .input('anullsrc=channel_layout=stereo:sample_rate=44100')
              .inputOptions(['-f lavfi'])
              .outputOptions([
                '-shortest',
                '-c:v copy',
                '-c:a aac',
                '-y'
              ])
              .save(concatWithAudioPath)
              .on('end', resolve)
              .on('error', reject);
          });
          concatInputFile = concatWithAudioPath;
          console.log('[5G][AUDIOFIX] Silent audio track added to concat.mp4');
        }

        // === Optional: Add music (if enabled and file is found) ===
        let concatWithMusicFile = concatInputFile;
        let musicUsed = false;
        let selectedMusicPath = null;
        if (backgroundMusic && musicMood) {
          selectedMusicPath = pickMusicForMood(musicMood);
          if (selectedMusicPath && fs.existsSync(selectedMusicPath)) {
            const musicMixPath = path.resolve(workDir, 'concat-music.mp4');
            console.log(`[5G][MUSIC] Mixing music over: ${concatInputFile}`);
            await new Promise((resolve, reject) => {
              ffmpeg()
                .input(concatInputFile)
                .input(selectedMusicPath)
                .complexFilter('[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[mixa]')
                .outputOptions(['-map', '0:v', '-map', '[mixa]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y'])
                .save(musicMixPath)
                .on('end', resolve)
                .on('error', reject);
            });
            if (fs.existsSync(musicMixPath) && fs.statSync(musicMixPath).size > 10240) {
              concatWithMusicFile = musicMixPath;
              musicUsed = true;
              console.log(`[5G][MUSIC] Music mixed over concat, output: ${musicMixPath}`);
            } else {
              console.warn('[5G][MUSIC] Music mix failed, continuing without music.');
            }
          } else {
            console.warn(`[5G][MUSIC] Music not found for mood: ${musicMood}`);
          }
        }

        // === Outro logic ===
        const finalPath = path.resolve(workDir, 'final.mp4');
        const outroPath = path.resolve(__dirname, '..', 'public', 'assets', 'outro.mp4');
        const outroExists = fs.existsSync(outroPath);
        let doAddOutro = outroExists && !(paidUser && removeOutro);

        let patchedOutroPath = outroPath;
        if (doAddOutro) {
          let outroNeedsPatch = false;
          try {
            const probe = await getVideoInfo(outroPath);
            const v = (probe.streams || []).find(s => s.codec_type === 'video');
            const a = (probe.streams || []).find(s => s.codec_type === 'audio');
            outroNeedsPatch =
              !v ||
              !a ||
              v.width !== refInfo.width ||
              v.height !== refInfo.height ||
              v.codec_name !== refInfo.codec_name ||
              v.pix_fmt !== refInfo.pix_fmt;
          } catch (err) {
            outroNeedsPatch = true;
          }
          if (outroNeedsPatch) {
            const outroFixed = path.resolve(workDir, 'outro-fixed.mp4');
            await standardizeVideo(outroPath, outroFixed, refInfo);
            patchedOutroPath = outroFixed;
            console.log('[5H][OUTRO] Patched outro for concat');
          } else {
            console.log('[5H][OUTRO] Outro ready, matches format');
          }
        }

        if (doAddOutro) {
          const list2 = path.resolve(workDir, 'list2.txt');
          fs.writeFileSync(
            list2,
            [`file '${concatWithMusicFile.replace(/'/g, "'\\''")}'`, `file '${patchedOutroPath.replace(/'/g, "'\\''")}'`].join('\n')
          );
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(list2)
              .inputOptions(['-f concat', '-safe 0'])
              .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
              .save(finalPath)
              .on('end', resolve)
              .on('error', reject);
          });
          console.log(`[5H][FINAL] Outro appended, output: ${finalPath}`);
        } else {
          fs.copyFileSync(concatWithMusicFile, finalPath);
          console.log(`[5H][FINAL] No outro, output: ${finalPath}`);
        }

        if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size < 10240) {
          throw new Error(`Final output missing or too small: ${finalPath}`);
        }
        console.log(`[5H][FINAL] Final video written: ${finalPath}`);

        // === Copy to local public/video for browser access ===
        fs.mkdirSync(path.resolve(__dirname, '..', 'public', 'video'), { recursive: true });
        const serveCopyPath = path.resolve(__dirname, '..', 'public', 'video', `${jobId}.mp4`);
        fs.copyFileSync(finalPath, serveCopyPath);
        console.log(`[5H][LOCAL SERVE] Video copied to: ${serveCopyPath}`);

        // === Upload to R2 ===
        try {
          const s3Key = `videos/${jobId}.mp4`;
          const fileData = fs.readFileSync(finalPath);
          await s3Client.send(new PutObjectCommand({
            Bucket: process.env.R2_VIDEOS_BUCKET,
            Key: s3Key,
            Body: fileData,
            ContentType: 'video/mp4'
          }));
          console.log(`[5H][UPLOAD] Uploaded final video to R2: ${s3Key}`);
        } catch (err) {
          console.error(`[5H][ERR] R2 upload failed`, err);
        }

        progress[jobId] = {
          percent: 100,
          status: 'Done',
          key: `${jobId}.mp4`
        };

        finished = true;
        clearTimeout(watchdog);
        setTimeout(() => cleanupJob(jobId), 30 * 60 * 1000);
        console.log(`[5H][DONE] Video job ${jobId} finished and available at /video/${jobId}.mp4`);
      } catch (err) {
        console.error(`[5H][CRASH] Fatal video generation error`, err);
        progress[jobId] = { percent: 100, status: 'Failed: Crash' };
        cleanupJob(jobId); clearTimeout(watchdog);
      }
    })();
  });

  console.log('[5B][INFO] /api/generate-video endpoint registered.');
}

module.exports = { registerGenerateVideoEndpoint };
