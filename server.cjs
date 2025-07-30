// server.cjs
console.log('\n========== [BOOT] SocialStormAI Modular Backend ==========');

// === Section 1: Setup (returns app, helpers, shared state) ===
const section1 = require('./sections/section1-setup.cjs');
const { app, progress, express, ...helpers } = section1;

// === Section 2: Basic routes & static serving ===
require('./sections/section2-basic-routes.cjs').registerBasicRoutes(app, progress);

// === Section 3: Voices API ===
require('./sections/section3-voices-endpoint.cjs').registerVoicesEndpoint(app);

// === Section 4: Script generator ===
require('./sections/section4-generate-script-endpoint.cjs').registerGenerateScriptEndpoint(app, helpers.openai);

// === Section 5: Video generator ===
require('./sections/section5-generate-video-endpoint.cjs').registerGenerateVideoEndpoint(app, {
    ...helpers, progress, voices: helpers.voices, POLLY_VOICE_IDS: helpers.POLLY_VOICE_IDS
});

// === Section 6: Thumbnails ===
require('./sections/section6-generate-thumbnails-endpoint.cjs').registerThumbnailEndpoint(app);

// === Section 7: Video streaming ===
require('./sections/section7-video-stream-endpoint.cjs').registerVideoStreamEndpoint(app);

// === Section 8: Contact form ===
require('./sections/section8-contact-endpoint.cjs').registerContactEndpoint(app);

// === Section 9: 404 and server start ===
require('./sections/section9-error-handling-and-server-start.cjs').registerErrorHandlerAndStart(app);
