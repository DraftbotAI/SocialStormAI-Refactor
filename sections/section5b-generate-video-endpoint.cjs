// ===========================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT
// The /api/generate-video route handler. Wires up all logic.
// MAX LOGGING
// ===========================================================
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

console.log('[5B][INIT] Video generation endpoint initialized.');

function registerGenerateVideoEndpoint(app, deps) {
  if (!app) throw new Error('[5B][FATAL] No app passed in!');
  if (!deps) throw new Error('[5B][FATAL] No dependencies passed in!');

  // Destructure all helpers and state from deps for clarity and MAX logging
  const {
    voices, POLLY_VOICE_IDS, splitScriptToScenes, findClipForScene, downloadRemoteFileToLocal,
    getAudioDuration, trimVideo, normalizeTo9x16Blurred, addSilentAudioTrack, muxVideoWithNarration,
    getVideoInfo, standardizeVideo, pickMusicForMood, cleanupJob,
    s3Client, PutObjectCommand, progress,
    extractVisualSubject, generateSceneAudio
  } = deps;

  app.post('/api/generate-video', (req, res) => {
    console.log('[5B][REQ] POST /api/generate-video');
    const jobId = uuidv4();
    progress[jobId] = { percent: 0, status: 'starting' };
    console.log(`[5B][INFO] New job started: ${jobId}`);
    res.json({ jobId });

    // You would now move the async video job logic into its own file (section5g-concat-and-music)
    // For demo purposes, you can copy the async function block from your old monolithic code,
    // and have each helper imported from its new file (5A–5H).

    // Example: Call your main async video job controller
    const { runVideoJob } = require('./section5g-concat-and-music.cjs');
    runVideoJob(req, jobId, deps);
  });

  console.log('[5B][INFO] /api/generate-video endpoint registered.');
}

module.exports = { registerGenerateVideoEndpoint };
