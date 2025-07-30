/* ===========================================================
   SECTION 3: VOICES ENDPOINT (Modular)
   -----------------------------------------------------------
   - Exports registerVoicesEndpoint(app)
   - MAX logging everywhere
   - Compatible with centralized app from Section 1
   =========================================================== */

console.log('\n========== [SECTION 3] Voices Endpoint Setup ==========');

// You must pass in `app` from Section 1.
// Example usage: 
// const { app } = require('./section1-setup.cjs');
// const { registerVoicesEndpoint } = require('./section3-voices-endpoint.cjs');
// registerVoicesEndpoint(app);

// Your real voices array goes here:
const voices = [
  { id: "Matthew", name: "Matthew (US Male)", description: "Amazon Polly, Male, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  // ... Add all your other voices here ...
  { id: "GL7nH05mDrxcH1JPJK5T", name: "Aimee (ASMR Gentle)", description: "ASMR Gentle Whisper", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: false }
];

const POLLY_VOICE_IDS = voices.filter(v => v.provider === "polly").map(v => v.id);

function registerVoicesEndpoint(app) {
  if (!app) {
    console.error('[SECTION3][FATAL] registerVoicesEndpoint called with no app!');
    throw new Error('App instance required');
  }
  console.log('[SECTION3][INFO] Registering /api/voices endpoint...');

  app.get('/api/voices', (req, res) => {
    const now = new Date().toISOString();
    console.log(`[SECTION3][REQ] GET /api/voices @ ${now}`);
    const count = voices.length;
    const byTier = {
      Free: voices.filter(v => v.tier === 'Free').length,
      Pro: voices.filter(v => v.tier === 'Pro').length,
      ASMR: voices.filter(v => v.tier === 'ASMR').length
    };
    console.log(`[SECTION3][INFO] Returning ${count} voices → Free: ${byTier.Free}, Pro: ${byTier.Pro}, ASMR: ${byTier.ASMR}`);
    res.json({ success: true, voices });
  });

  console.log('[SECTION3][INFO] /api/voices endpoint registered.');
}

module.exports = { registerVoicesEndpoint, voices, POLLY_VOICE_IDS };
