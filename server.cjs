// server.cjs
console.log('\n========== [BOOT] SocialStormAI Modular Backend ==========');

// === Section 1: Setup (returns app, helpers, shared state) ===
const section1 = require('./sections/section1-setup.cjs');
const { app, progress, express } = section1;
console.log('[SERVER][INFO] Section 1 loaded (app, progress, express ready)');

// === Section 2: Basic routes & static serving ===
console.log('[SERVER][INFO] Loading Section 2 (Basic Routes)...');
const registerBasicRoutes = require('./sections/section2-basic-routes.cjs');
registerBasicRoutes(app, express, progress);

// === Section 3: Voices API ===
console.log('[SERVER][INFO] Loading Section 3 (Voices API)...');
const registerVoicesEndpoint = require('./sections/section3-voices-endpoint.cjs');
registerVoicesEndpoint(app); // Only pass app, NOT section1

// === Section 4: Script generator ===
console.log('[SERVER][INFO] Loading Section 4 (Script Generator)...');
const registerGenerateScriptEndpoint = require('./sections/section4-generate-script-endpoint.cjs');
registerGenerateScriptEndpoint(app, section1.openai); // Pass app and openai

// === Section 5: Video generator ===
console.log('[SERVER][INFO] Loading Section 5 (Video Generator)...');
const registerGenerateVideoEndpoint = require('./sections/section5-generate-video-endpoint.cjs');
registerGenerateVideoEndpoint(app, {
    ...section1,
    progress,
    voices: section1.voices,               // If present in section1
    POLLY_VOICE_IDS: section1.POLLY_VOICE_IDS // If present in section1
});

// === Section 6: Thumbnails ===
console.log('[SERVER][INFO] Loading Section 6 (Thumbnail Generator)...');
const registerThumbnailEndpoint = require('./sections/section6-generate-thumbnails-endpoint.cjs');
registerThumbnailEndpoint(app, section1);

// === Section 7: Video streaming ===
console.log('[SERVER][INFO] Loading Section 7 (Video Streaming)...');
const registerVideoStreamEndpoint = require('./sections/section7-video-stream-endpoint.cjs');
registerVideoStreamEndpoint(app, section1);

// === Section 8: Contact form ===
console.log('[SERVER][INFO] Loading Section 8 (Contact Endpoint)...');
const registerContactEndpoint = require('./sections/section8-contact-endpoint.cjs');
registerContactEndpoint(app, section1);

// === Section 9: 404 and server start ===
console.log('[SERVER][INFO] Loading Section 9 (404 and Server Start)...');
const registerErrorHandlerAndStart = require('./sections/section9-error-handling-and-server-start.cjs');
registerErrorHandlerAndStart(app);

console.log('[SERVER][COMPLETE] All sections loaded. Server boot complete.');
