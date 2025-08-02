// ===========================================================
// SECTION 5A: TTS & VISUAL SUBJECT HELPERS
// Handles Polly & ElevenLabs TTS + subject extraction
// MAX LOGGING
// ===========================================================
const AWS = require('aws-sdk');
const fs = require('fs');

console.log('[5A][INIT] TTS and subject extraction helpers loaded.');

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

module.exports = {
  extractVisualSubject,
  generatePollyTTS,
  generateElevenLabsTTS,
  generateSceneAudio
};
