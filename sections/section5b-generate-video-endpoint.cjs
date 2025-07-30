// ===========================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT
// The /api/generate-video route handler. Wires up all logic.
// MAX LOGGING
// ===========================================================
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

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
    voices, POLLY_VOICE_IDS, splitScriptToScenes, findClipForScene, downloadRemoteFileToLocal,
    getAudioDuration, trimVideo, normalizeTo9x16Blurred, addSilentAudioTrack, muxVideoWithNarration,
    getVideoInfo, standardizeVideo, pickMusicForMood, cleanupJob,
    s3Client, PutObjectCommand, progress,
    extractVisualSubject, generateSceneAudio
  } = deps;

  console.log('[5B][INFO] Registering POST /api/generate-video route...');

  app.post('/api/generate-video', (req, res) => {
    console.log('[5B][REQ] POST /api/generate-video');
    const jobId = uuidv4();
    if (!progress) {
      console.error('[5B][FATAL] No progress tracker found!');
    } else {
      progress[jobId] = { percent: 0, status: 'starting' };
      console.log(`[5B][INFO] New job started: ${jobId}`);
    }
    res.json({ jobId });

    // The main async video job logic should now be handled in a dedicated helper file (section5g-concat-and-music)
    try {
      const { runVideoJob } = require('./section5g-concat-and-music.cjs');
      console.log('[5B][INFO] Handing off to runVideoJob()...');
      runVideoJob(req, jobId, deps);
    } catch (err) {
      console.error('[5B][FATAL] Failed to require or start runVideoJob:', err);
      if (progress && progress[jobId]) {
        progress[jobId] = { percent: 100, status: 'failed', error: err.message };
      }
    }
  });

  console.log('[5B][SUCCESS] /api/generate-video endpoint registered.');
}

console.log('[5B][EXPORT] registerGenerateVideoEndpoint exported');
module.exports = registerGenerateVideoEndpoint;
