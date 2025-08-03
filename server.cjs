// ===========================================================
// server.cjs — SocialStormAI Modular Backend Bootstrap
// MAX CRASH LOGGING, Clean Logs for Railway/Prod, No Skips
// 2024-08-03: Robust boot, clear section logs, crash-proof
// ===========================================================

// ==== TOP-LEVEL CRASH HANDLERS (log all fatal errors instantly) ====
process.on('uncaughtException', err => {
  try { console.error('[FATAL][UNCAUGHT_EXCEPTION]', err); } catch (e) {}
  process.exit(1);
});
process.on('unhandledRejection', err => {
  try { console.error('[FATAL][UNHANDLED_REJECTION]', err); } catch (e) {}
  process.exit(1);
});
console.log('\n========== [BOOT] SocialStormAI Modular Backend ==========');

// ==== Section 1: Setup (returns app, helpers, shared state) ====
const section1 = require('./sections/section1-setup.cjs');
const { app, progress, express } = section1;
console.log('[SERVER][INFO] Section 1 loaded.');

// ==== Section 2: Basic routes & static serving ====
console.log('[SERVER][INFO] Loading Section 2 (Basic Routes)...');
const registerBasicRoutes = require('./sections/section2-basic-routes.cjs');
registerBasicRoutes(app, express, progress);

// ==== Section 3: Voices API ====
console.log('[SERVER][INFO] Loading Section 3 (Voices API)...');
const registerVoicesEndpoint = require('./sections/section3-voices-endpoint.cjs');
registerVoicesEndpoint(app);

// ==== Section 4: Script generator ====
console.log('[SERVER][INFO] Loading Section 4 (Script Generator)...');
const registerGenerateScriptEndpoint = require('./sections/section4-generate-script-endpoint.cjs');
registerGenerateScriptEndpoint(app, section1.openai);

// ==== Section 5: Video generator ====
console.log('[SERVER][INFO] Loading Section 5 (Video Generator)...');
const { findClipForScene } = require('./sections/section5d-clip-matcher.cjs');
const { createSceneAudio, createMegaSceneAudio } = require('./sections/section5e-audio-generator.cjs');
const { selectMusicFileForScript } = require('./sections/music-moods.cjs');
const registerGenerateVideoEndpoint = require('./sections/section5b-generate-video-endpoint.cjs');

registerGenerateVideoEndpoint(app, {
  ...section1,
  progress,
  voices: section1.voices,
  POLLY_VOICE_IDS: section1.POLLY_VOICE_IDS,
  findClipForScene,
  createSceneAudio,
  createMegaSceneAudio,
  pickMusicForMood: selectMusicFileForScript
});

// ==== Section 6: Thumbnails ====
console.log('[SERVER][INFO] Loading Section 6 (Thumbnail Generator)...');
const registerThumbnailEndpoint = require('./sections/section6-generate-thumbnails-endpoint.cjs');
registerThumbnailEndpoint(app, section1);

// ==== Section 7: Video streaming ====
console.log('[SERVER][INFO] Loading Section 7 (Video Streaming)...');
const registerVideoStreamEndpoint = require('./sections/section7-video-stream-endpoint.cjs');
registerVideoStreamEndpoint(app, section1);

// ==== Section 8: Contact form ====
console.log('[SERVER][INFO] Loading Section 8 (Contact Endpoint)...');
const registerContactEndpoint = require('./sections/section8-contact-endpoint.cjs');
registerContactEndpoint(app, section1);

// ==== Section 9: 404 and server start ====
console.log('[SERVER][INFO] Loading Section 9 (404 and Server Start)...');
const registerErrorHandlerAndStart = require('./sections/section9-error-handling-and-server-start.cjs');
registerErrorHandlerAndStart(app);

console.log('[SERVER][COMPLETE] All sections loaded. Server boot complete.');
