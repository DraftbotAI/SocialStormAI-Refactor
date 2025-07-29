/* ===========================================================
   SECTION 1: SETUP & DEPENDENCIES
   -----------------------------------------------------------
   - Load env, modules, API keys, paths
   - Configure AWS + Cloudflare R2 + OpenAI + FFmpeg
   - Includes audio/video helpers with god-tier logging
   =========================================================== */

console.log('\n========== [BOOTING SERVER] ==========');
console.log('[INFO] Booting SocialStormAI backend...');
console.log('[INFO] Loading dependencies...');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const util = require('util');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[INFO] FFmpeg path set to:', ffmpegPath);

const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const AWS = require('aws-sdk');

// === OPENAI CLIENT SETUP ===
let openai;
try {
  const OpenAI = require('openai');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  console.log('[INFO] OpenAI client initialized.');
} catch (err) {
  console.error('[FATAL] OpenAI client setup failed:', err);
  process.exit(1);
}

// === R2 / S3 BUCKETS & CLIENT SETUP ===
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_VIDEOS_BUCKET = process.env.R2_VIDEOS_BUCKET || 'socialstorm-videos';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;

const s3Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});
console.log('[INFO] Cloudflare R2 S3Client initialized.');
console.log('[INFO] R2_LIBRARY_BUCKET:', R2_LIBRARY_BUCKET);
console.log('[INFO] R2_VIDEOS_BUCKET:', R2_VIDEOS_BUCKET);
console.log('[INFO] R2_ENDPOINT:', R2_ENDPOINT);

const JOBS_DIR = path.join(__dirname, 'jobs');
console.log('[INFO] Dependencies loaded.');

const requiredEnvVars = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'R2_LIBRARY_BUCKET',
  'R2_VIDEOS_BUCKET',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'OPENAI_API_KEY'
];
const missingEnv = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error('[FATAL] Missing environment variables:', missingEnv);
  process.exit(1);
}
console.log('[INFO] All required environment variables are present.');

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1'
});
console.log('[INFO] AWS SDK configured for Polly, region:', process.env.AWS_REGION);

const app = express();

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

const progress = {};
console.log('[INFO] Progress tracker initialized.');

// === LOAD HELPERS ONCE, IN SECTION 1 ===
const {
  splitScriptToScenes,
  findClipForScene,
  downloadRemoteFileToLocal
} = require('./pexels-helper.cjs');

console.log('[INFO] Helper functions loaded.');

// ===================== UTILITY FUNCTIONS =====================

// --- GOD-TIER LOGGING for audio/video helpers ---

// Get audio duration in seconds using ffprobe (God-Tier Logging)
const getAudioDuration = (audioPath) => {
  return new Promise((resolve, reject) => {
    console.log(`[HELPER] [getAudioDuration] Called with: ${audioPath}`);
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        console.error(`[HELPER] [getAudioDuration] ffprobe error for ${audioPath}:`, err);
        return reject(err);
      }
      if (!metadata || !metadata.format || typeof metadata.format.duration !== 'number') {
        console.error(`[HELPER] [getAudioDuration] Invalid metadata for ${audioPath}:`, metadata);
        return reject(new Error('Invalid ffprobe metadata'));
      }
      console.log(`[HELPER] [getAudioDuration] Success. Duration: ${metadata.format.duration}s`);
      resolve(metadata.format.duration);
    });
  });
};

// Trim video to duration (God-Tier Logging)
const trimVideo = (inPath, outPath, duration, seek = 0) => {
  return new Promise((resolve, reject) => {
    console.log(`[HELPER] [trimVideo] Trimming ${inPath} to ${duration}s, outPath: ${outPath}, seek: ${seek}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    ffmpeg(inPath)
      .setStartTime(seek)
      .setDuration(duration)
      .output(outPath)
      .on('end', () => {
        console.log(`[HELPER] [trimVideo] Trim complete: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[HELPER] [trimVideo] Error:`, err);
        reject(err);
      })
      .run();
  });
};

// Normalize to 9x16, blurred background (God-Tier Logging)
const normalizeTo9x16Blurred = (inPath, outPath, width, height) => {
  return new Promise((resolve, reject) => {
    console.log(`[HELPER] [normalizeTo9x16Blurred] Normalizing ${inPath} to ${width}x${height}, output: ${outPath}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    ffmpeg(inPath)
      .complexFilter([
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[main];` +
        `[0:v]scale=${width}:${height},boxblur=20:1[blur];` +
        `[blur][main]overlay=(W-w)/2:(H-h)/2,crop=${width}:${height}`
      ])
      .outputOptions(['-c:a copy'])
      .output(outPath)
      .on('end', () => {
        console.log(`[HELPER] [normalizeTo9x16Blurred] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[HELPER] [normalizeTo9x16Blurred] Error:`, err);
        reject(err);
      })
      .run();
  });
};

// Add silent audio track if needed (God-Tier Logging)
const addSilentAudioTrack = (inPath, outPath, duration) => {
  return new Promise((resolve, reject) => {
    console.log(`[HELPER] [addSilentAudioTrack] Adding silent audio to ${inPath} (duration: ${duration}s) -> ${outPath}`);
    ffmpeg()
      .input(inPath)
      .input('anullsrc=channel_layout=stereo:sample_rate=44100')
      .inputOptions(['-f lavfi'])
      .outputOptions(['-shortest', '-c:v copy', '-c:a aac', '-y'])
      .save(outPath)
      .on('end', () => {
        console.log(`[HELPER] [addSilentAudioTrack] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[HELPER] [addSilentAudioTrack] Error:`, err);
        reject(err);
      });
  });
};

// Mux video with narration audio (God-Tier Logging)
const muxVideoWithNarration = (videoPath, audioPath, outPath, duration) => {
  return new Promise((resolve, reject) => {
    console.log(`[HELPER] [muxVideoWithNarration] Combining video ${videoPath} + audio ${audioPath} → ${outPath} (duration: ${duration}s)`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-shortest', '-y'])
      .save(outPath)
      .on('end', () => {
        console.log(`[HELPER] [muxVideoWithNarration] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[HELPER] [muxVideoWithNarration] Error:`, err);
        reject(err);
      });
  });
};

// Standardize video to match reference info (God-Tier Logging)
const standardizeVideo = (inputPath, outPath, refInfo) => {
  return new Promise((resolve, reject) => {
    console.log(`[HELPER] [standardizeVideo] Standardizing ${inputPath} to match reference:`, refInfo);
    const args = [
      '-vf', `scale=${refInfo.width}:${refInfo.height},format=${refInfo.pix_fmt}`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-pix_fmt', refInfo.pix_fmt,
      '-y'
    ];
    ffmpeg(inputPath)
      .outputOptions(args)
      .save(outPath)
      .on('end', () => {
        console.log(`[HELPER] [standardizeVideo] Success: ${outPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[HELPER] [standardizeVideo] Error:`, err);
        reject(err);
      });
  });
};

// Get info about a video (God-Tier Logging)
const getVideoInfo = (filePath) => {
  return new Promise((resolve, reject) => {
    console.log(`[HELPER] [getVideoInfo] Getting info for: ${filePath}`);
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`[HELPER] [getVideoInfo] ffprobe error:`, err);
        return reject(err);
      }
      console.log(`[HELPER] [getVideoInfo] Info for ${filePath}:`, JSON.stringify(metadata));
      resolve(metadata);
    });
  });
};

// Pick music by mood (God-Tier Logging stub)
const pickMusicForMood = (mood) => {
  // Example logic: you would implement this
  console.log(`[HELPER] [pickMusicForMood] Picking music for mood: ${mood}`);
  return null; // Or path to your music file
};

// SAFE CLEANUP FUNCTION (GOD-TIER LOGGING)
function cleanupJob(jobId) {
  try {
    console.log(`[CLEANUP] Starting cleanup for job: ${jobId}`);
    if (progress[jobId]) {
      delete progress[jobId];
      console.log(`[CLEANUP] Progress entry deleted for job: ${jobId}`);
    }
    const jobDir = path.join(__dirname, 'renders', jobId);
    if (fs.existsSync(jobDir)) {
      fsExtra.removeSync(jobDir);
      console.log(`[CLEANUP] Removed temp folder: ${jobDir}`);
    }
  } catch (err) {
    console.warn(`[WARN] Cleanup failed for job ${jobId}:`, err);
  }
}

console.log('[INFO] Section 1 complete – all dependencies, helpers, and logging functions loaded.');
/* ===========================================================
   SECTION 2: BASIC ROUTES & STATIC FILE SERVING
   =========================================================== */

console.log('[INFO] Setting up static file routes...');

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
console.log('[INFO] Static file directory mounted:', PUBLIC_DIR);

app.get('/', (req, res) => {
  console.log('[REQ] GET /');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/api/status', (req, res) => {
  console.log('[REQ] GET /api/status');
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  console.log(`[REQ] GET /api/progress/${jobId}`);
  if (progress[jobId]) {
    console.log(`[INFO] Returning progress for job ${jobId}:`, progress[jobId]);
    res.json(progress[jobId]);
  } else {
    console.warn(`[WARN] No progress found for job ${jobId}`);
    res.json({ percent: 100, status: 'Done (or not found)' });
  }
});

/* ===========================================================
   SECTION 3: VOICES ENDPOINTS
   =========================================================== */

console.log('[INFO] Registering /api/voices endpoint...');

const voices = [
  // ... (unchanged, use your voices array from before)
  { id: "Matthew", name: "Matthew (US Male)", description: "Amazon Polly, Male, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  // ... (all the others)
  { id: "GL7nH05mDrxcH1JPJK5T", name: "Aimee (ASMR Gentle)", description: "ASMR Gentle Whisper", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: false }
];
const POLLY_VOICE_IDS = voices.filter(v => v.provider === "polly").map(v => v.id);

app.get('/api/voices', (req, res) => {
  const now = new Date().toISOString();
  console.log(`[REQ] GET /api/voices @ ${now}`);
  const count = voices.length;
  const byTier = {
    Free: voices.filter(v => v.tier === 'Free').length,
    Pro: voices.filter(v => v.tier === 'Pro').length,
    ASMR: voices.filter(v => v.tier === 'ASMR').length
  };
  console.log(`[INFO] Returning ${count} voices → Free: ${byTier.Free}, Pro: ${byTier.Pro}, ASMR: ${byTier.ASMR}`);
  res.json({ success: true, voices });
});

/* ===========================================================
   SECTION 4: /api/generate-script ENDPOINT
   =========================================================== */

console.log('[INFO] Registering /api/generate-script endpoint...');

app.post('/api/generate-script', async (req, res) => {
  const idea = req.body.idea?.trim();
  const timestamp = new Date().toISOString();
  console.log(`[REQ] POST /api/generate-script @ ${timestamp}`);
  console.log(`[INPUT] idea = "${idea}"`);

  if (!idea) {
    console.warn('[WARN] Missing idea in request body');
    return res.status(400).json({ success: false, error: "Missing idea" });
  }

  try {
    const prompt = `
You are a viral YouTube Shorts scriptwriter.

Your job is to write an engaging, narratable script on the topic: "${idea}"

== RULES ==
- Line 1 must be a HOOK — surprising, dramatic, or funny — that makes the viewer stay.
- Each line = one spoken scene (short, punchy, narratable).
- Make each fact feel like a secret or hidden story.
- DO NOT use camera directions (e.g., "Cut to", "Zoom in", "POV", "Flash").
- DO NOT use hashtags, emojis, or quote marks.
- Aim for 6 to 10 lines total. Narration-style only.

== STYLE ==
- Use vivid, conversational tone.
- Add a twist or deeper explanation when possible.
- Be clever or funny when appropriate.
- End with a satisfying or mysterious final line.

== METADATA ==
At the end, return:
Title: [a viral, clickable title — no quotes]
Description: [1–2 sentence summary of what the video reveals]
Tags: [Max 5 words, space-separated. No hashtags or commas.]

== EXAMPLE SCRIPT ==
They say history is written by the winners. But what did they hide?
There's a chamber behind Lincoln’s head at Mount Rushmore — planned for documents, never finished.
The Eiffel Tower hides a tiny private apartment — built by Gustave Eiffel for special guests only.
The Great Wall of China has underground tunnels — built to sneak troops and supplies past enemies.
Lady Liberty’s torch? Sealed off since 1916 after a German attack during WWI.
One paw of the Sphinx may hide a sealed room — sensors detect a cavity, but Egypt won’t open it.
Whispers say the Taj Mahal has secret floors — built for symmetry, now sealed tight.
Title: Hidden Secrets They Don’t Teach in School
Description: Real hidden rooms and strange facts about the world’s most famous landmarks.
Tags: secrets landmarks mystery history viral
    `.trim();

    // === OpenAI v4+ call ===
    const completion = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      temperature: 0.84,
      max_tokens: 900,
      messages: [
        { role: "system", content: prompt }
      ]
    });

    const raw = completion?.choices?.[0]?.message?.content?.trim() || '';
    console.log('[GPT] Raw output:\n' + raw);

    // === Parse Output ===
    let scriptLines = [];
    let title = '';
    let description = '';
    let tags = '';

    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const titleIdx = lines.findIndex(l => /^title\s*:/i.test(l));
    const descIdx  = lines.findIndex(l => /^description\s*:/i.test(l));
    const tagsIdx  = lines.findIndex(l => /^tags?\s*:/i.test(l));

    const metaStart = [titleIdx, descIdx, tagsIdx].filter(x => x > -1).sort((a,b) => a - b)[0] || lines.length;

    scriptLines = lines.slice(0, metaStart).filter(l =>
      !/^title\s*:/i.test(l) &&
      !/^description\s*:/i.test(l) &&
      !/^tags?\s*:/i.test(l)
    );

    // Strip out lines that are clearly not meant to be narrated
    const cameraWords = ['cut to', 'zoom', 'pan', 'transition', 'fade', 'camera', 'pov', 'flash'];
    scriptLines = scriptLines.filter(line => {
      const lc = line.toLowerCase();
      return !cameraWords.some(word => lc.startsWith(word) || lc.includes(`: ${word}`));
    });

    if (scriptLines.length > 10) scriptLines = scriptLines.slice(0, 10);

    for (const l of lines.slice(metaStart)) {
      if (/^title\s*:/i.test(l)) title = l.replace(/^title\s*:/i, '').trim();
      else if (/^description\s*:/i.test(l)) description = l.replace(/^description\s*:/i, '').trim();
      else if (/^tags?\s*:/i.test(l)) tags = l.replace(/^tags?\s*:/i, '').trim();
    }

    // === Metadata Fallbacks ===
    if (!title) title = idea.length < 60 ? idea : idea.slice(0, 57) + "...";
    if (!description) description = `This video explores: ${idea}`;
    if (!tags) tags = idea
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 2)
      .slice(0, 5)
      .join(' ');

    if (!scriptLines.length) scriptLines = ['Something went wrong generating the script.'];

    console.log('[PARSED] script lines:', scriptLines.length, scriptLines);
    console.log('[PARSED] title:', title);
    console.log('[PARSED] description:', description);
    console.log('[PARSED] tags:', tags);

    res.json({
      success: true,
      script: scriptLines.join('\n'),
      title,
      description,
      tags
    });

  } catch (err) {
    console.error('[FATAL] Script generation failed:', err);
    res.status(500).json({ success: false, error: "Script generation failed" });
  }
});




/* ===========================================================
   SECTION 5: VIDEO GENERATION ENDPOINT
   -----------------------------------------------------------
   - POST /api/generate-video
   - Handles script, voice, branding, outro, background music
   - Bulletproof file/dir safety; MAX logging in every step
   =========================================================== */

console.log('[INIT] Video generation endpoint initialized.');

// --- PATCHED: Dummy extractVisualSubject so backend cannot crash ---
async function extractVisualSubject(line, scriptTopic = '') {
  console.log(`[EXTRACT] Dummy extractVisualSubject for: "${line}" | topic: "${scriptTopic}"`);
  return line;
}

// --- Amazon Polly TTS ONLY (no Google TTS here) ---
async function generatePollyTTS(text, voiceId, outPath) {
  try {
    console.log(`[POLLY] Synthesizing speech: "${text}" [voice: ${voiceId}] → ${outPath}`);
    const polly = new AWS.Polly();
    const params = {
      OutputFormat: 'mp3',
      Text: text,
      VoiceId: voiceId,
      Engine: 'neural'
    };
    const data = await polly.synthesizeSpeech(params).promise();
    fs.writeFileSync(outPath, data.AudioStream);
    console.log(`[POLLY] Audio written: ${outPath}`);
  } catch (err) {
    console.error(`[ERR][POLLY] TTS failed for voice ${voiceId} text: "${text}"`, err);
    throw err;
  }
}

// --- ElevenLabs TTS stub (can be filled in later) ---
async function generateElevenLabsTTS(text, voiceId, outPath) {
  console.error('[ERR][11LABS] ElevenLabs TTS not implemented!');
  throw new Error('ElevenLabs TTS not implemented');
}

// --- Single entry point for scene TTS (NO GOOGLE TTS) ---
async function generateSceneAudio(sceneText, voiceId, outPath, provider) {
  console.log(`[AUDIO] generateSceneAudio called: "${sceneText}" | voice: ${voiceId} | provider: ${provider} | out: ${outPath}`);
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

// ===================== MAIN ENDPOINT =====================

app.post('/api/generate-video', (req, res) => {
  console.log('[REQ] POST /api/generate-video');
  const jobId = uuidv4();
  progress[jobId] = { percent: 0, status: 'starting' };
  console.log(`[INFO] New job started: ${jobId}`);
  res.json({ jobId });

  (async () => {
    let finished = false;
    const watchdog = setTimeout(() => {
      if (!finished && progress[jobId]) {
        progress[jobId] = { percent: 100, status: "Failed: Timed out." };
        cleanupJob(jobId);
        console.warn(`[WATCHDOG] Job ${jobId} timed out and was cleaned up`);
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

      console.log(`[STEP] Inputs parsed. Voice: ${voice} | Paid: ${paidUser} | Music: ${backgroundMusic} | Mood: ${musicMood} | Remove Outro: ${removeOutro}`);
      console.log(`[DEBUG] Raw script:\n${script}`);

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

      const workDir = path.resolve(__dirname, 'renders', jobId);
      fs.mkdirSync(workDir, { recursive: true });
      console.log(`[STEP] Work dir created: ${workDir}`);

      const scenes = splitScriptToScenes(script);
      if (!scenes.length) {
        progress[jobId] = { percent: 100, status: 'Failed: No scenes from script' };
        cleanupJob(jobId); clearTimeout(watchdog);
        return;
      }
      console.log(`[STEP] Script split into ${scenes.length} scenes.`);
      console.log('[DEBUG] Scenes array:', JSON.stringify(scenes, null, 2));

      let sceneFiles = [];
      let line2Subject = scenes[1]?.text || '';
      let mainTopic = title || '';
      let sharedClipUrl = null;

      // ---- Extract better main subject for scene 1/2 ----
      let sharedSubject = await extractVisualSubject(line2Subject, mainTopic);
      try {
        sharedClipUrl = await findClipForScene(sharedSubject, 1, scenes.map(s => s.text), mainTopic);
        console.log(`[SCENE 1&2] Selected shared clip for hook/scene2: ${sharedClipUrl}`);
      } catch (err) {
        console.error(`[ERR] Could not select shared video clip for scenes 1 & 2`, err);
      }

      for (let i = 0; i < scenes.length; i++) {
        if (!scenes[i]) {
          console.error(`[ERR] Scene at index ${i} is undefined!`);
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
        console.log(`[SCENE] Working on scene ${i + 1}/${scenes.length}: "${sceneText}"`);

        try {
          console.log(`[AUDIO] Generating scene ${i + 1} audio…`);
          await generateSceneAudio(sceneText, voice, audioPath, ttsProvider);
          if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1024) {
            throw new Error(`Audio output missing or too small: ${audioPath}`);
          }
          console.log(`[AUDIO] Scene ${i + 1} audio created: ${audioPath}`);
        } catch (err) {
          console.error(`[ERR] Audio generation failed for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: Audio generation error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        let clipUrl = null;
        if (i === 0 || i === 1) {
          clipUrl = sharedClipUrl;
        } else {
          try {
            const sceneSubject = await extractVisualSubject(sceneText, mainTopic);
            console.log(`[MATCH] Scene ${i + 1} subject: "${sceneSubject}"`);
            clipUrl = await findClipForScene(sceneSubject, i, scenes.map(s => s.text), mainTopic);
          } catch (err) {
            console.error(`[ERR] Clip matching failed for scene ${i + 1}`, err);
          }
        }

        if (!clipUrl) {
          progress[jobId] = { percent: 100, status: `Failed: No video found for scene ${i + 1}` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        try {
          console.log(`[VIDEO] Downloading video for scene ${i + 1}…`);
          await downloadRemoteFileToLocal(clipUrl, rawVideoPath);
          if (!fs.existsSync(rawVideoPath) || fs.statSync(rawVideoPath).size < 10240) {
            throw new Error(`Video output missing or too small: ${rawVideoPath}`);
          }
          console.log(`[VIDEO] Downloaded for scene ${i + 1}: ${rawVideoPath}`);
        } catch (err) {
          console.error(`[ERR] Video download failed for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: Video download error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        let audioDuration;
        try {
          console.log(`[AUDIO] Getting audio duration for scene ${i + 1}…`);
          audioDuration = await getAudioDuration(audioPath);
          if (!audioDuration || audioDuration < 0.2) throw new Error("Audio duration zero or invalid.");
          console.log(`[AUDIO] Duration for scene ${i + 1}: ${audioDuration}s`);
        } catch (err) {
          console.error(`[ERR] Could not get audio duration for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: Audio duration error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }
        const leadIn = 0.5, tail = 1.0;
        const sceneDuration = leadIn + audioDuration + tail;

        try {
          console.log(`[TRIM] Trimming video for scene ${i + 1} to ${sceneDuration}s…`);
          await trimVideo(rawVideoPath, trimmedVideoPath, sceneDuration, 0);
          if (!fs.existsSync(trimmedVideoPath) || fs.statSync(trimmedVideoPath).size < 10240) {
            throw new Error(`Trimmed video missing or too small: ${trimmedVideoPath}`);
          }
          console.log(`[TRIM] Video trimmed for scene ${i + 1}: ${trimmedVideoPath} (${sceneDuration}s)`);
        } catch (err) {
          console.error(`[ERR] Trimming video failed for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: Video trim error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        try {
          console.log(`[NORMALIZE] Normalizing video for scene ${i + 1} to 1080x1920 with blurred background…`);
          await normalizeTo9x16Blurred(trimmedVideoPath, normalizedVideoPath, 1080, 1920);
          if (!fs.existsSync(normalizedVideoPath) || fs.statSync(normalizedVideoPath).size < 10240) {
            throw new Error(`Normalized 9:16 video missing or too small: ${normalizedVideoPath}`);
          }
          console.log(`[NORMALIZE] Video normalized for scene ${i + 1}: ${normalizedVideoPath}`);
        } catch (err) {
          console.error(`[ERR] 9:16 normalization failed for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: 9:16 normalization error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        try {
          await addSilentAudioTrack(normalizedVideoPath, videoWithSilence, sceneDuration);
          if (!fs.existsSync(videoWithSilence) || fs.statSync(videoWithSilence).size < 10240) {
            throw new Error(`Silent-audio video missing or too small: ${videoWithSilence}`);
          }
          console.log(`[AUDIOFIX] Silent audio added for scene ${i + 1}: ${videoWithSilence}`);
        } catch (err) {
          console.error(`[ERR] Could not add silent audio for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: Silent audio error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        try {
          await muxVideoWithNarration(videoWithSilence, audioPath, sceneMp4, sceneDuration);
          if (!fs.existsSync(sceneMp4) || fs.statSync(sceneMp4).size < 10240) {
            throw new Error(`Combined scene output missing or too small: ${sceneMp4}`);
          }
          sceneFiles.push(sceneMp4);
          console.log(`[COMBINE] Scene ${i + 1} ready for concat: ${sceneMp4}`);
        } catch (err) {
          console.error(`[ERR] Scene mux failed (scene ${i + 1})`, err);
          progress[jobId] = { percent: 100, status: `Failed: Scene mux error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }
        console.log(`[SCENE] Finished processing scene ${i + 1}/${scenes.length}.`);
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
        console.log('[BULLETPROOF] Reference video info:', refInfo);
      } catch (err) {
        console.error('[ERR] Could not get reference video info:', err);
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
            console.log(`[BULLETPROOF] Fixed scene ${i + 1} video: ${sceneFiles[i]}`);
          } else {
            console.log(`[BULLETPROOF] Scene ${i + 1} validated OK`);
          }
        } catch (err) {
          console.error(`[ERR] Bulletproof check failed for scene ${i + 1}`, err);
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
      console.log(`[CONCAT] Scene list for concat:\n${sceneFiles.join('\n')}`);

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
        console.log(`[STITCH] All scenes concatenated: ${concatFile}`);
      } catch (err) {
        console.error(`[ERR] Concatenation failed`, err);
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
        console.log(`[AUDIOFIX] concat.mp4 audio stream exists: ${audioStreamExists}`);
      } catch (err) {
        console.error('[ERR] Could not probe concat.mp4:', err);
      }
      if (!audioStreamExists) {
        const concatWithAudioPath = path.resolve(workDir, 'concat-audio.mp4');
        console.log('[AUDIOFIX] concat.mp4 is missing audio, adding silent track...');
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
        console.log('[AUDIOFIX] Silent audio track added to concat.mp4');
      }

      // === Optional: Add music (if enabled and file is found) ===
      let concatWithMusicFile = concatInputFile;
      let musicUsed = false;
      let selectedMusicPath = null;
      if (backgroundMusic && musicMood) {
        selectedMusicPath = pickMusicForMood(musicMood);
        if (selectedMusicPath && fs.existsSync(selectedMusicPath)) {
          const musicMixPath = path.resolve(workDir, 'concat-music.mp4');
          console.log(`[MUSIC] Mixing music over: ${concatInputFile}`);
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
            console.log(`[MUSIC] Music mixed over concat, output: ${musicMixPath}`);
          } else {
            console.warn('[MUSIC] Music mix failed, continuing without music.');
          }
        } else {
          console.warn(`[MUSIC] Music not found for mood: ${musicMood}`);
        }
      }

      // === Outro logic ===
      const finalPath = path.resolve(workDir, 'final.mp4');
      const outroPath = path.resolve(__dirname, 'public', 'assets', 'outro.mp4');
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
          console.log('[OUTRO] Patched outro for concat');
        } else {
          console.log('[OUTRO] Outro ready, matches format');
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
        console.log(`[FINAL] Outro appended, output: ${finalPath}`);
      } else {
        fs.copyFileSync(concatWithMusicFile, finalPath);
        console.log(`[FINAL] No outro, output: ${finalPath}`);
      }

      if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size < 10240) {
        throw new Error(`Final output missing or too small: ${finalPath}`);
      }
      console.log(`[FINAL] Final video written: ${finalPath}`);

      // === Copy to local public/video for browser access ===
      fs.mkdirSync(path.resolve(__dirname, 'public', 'video'), { recursive: true });
      const serveCopyPath = path.resolve(__dirname, 'public', 'video', `${jobId}.mp4`);
      fs.copyFileSync(finalPath, serveCopyPath);
      console.log(`[LOCAL SERVE] Video copied to: ${serveCopyPath}`);

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
        console.log(`[UPLOAD] Uploaded final video to R2: ${s3Key}`);
      } catch (err) {
        console.error(`[ERR] R2 upload failed`, err);
      }

      progress[jobId] = {
        percent: 100,
        status: 'Done',
        key: `${jobId}.mp4`
      };

      finished = true;
      clearTimeout(watchdog);
      setTimeout(() => cleanupJob(jobId), 30 * 60 * 1000);
      console.log(`[DONE] Video job ${jobId} finished and available at /video/${jobId}.mp4`);
    } catch (err) {
      console.error(`[CRASH] Fatal video generation error`, err);
      progress[jobId] = { percent: 100, status: 'Failed: Crash' };
      cleanupJob(jobId); clearTimeout(watchdog);
    }
  })();
});

// END OF SECTION 5





/* ===========================================================
   SECTION 6: THUMBNAIL GENERATION ENDPOINT
   -----------------------------------------------------------
   - POST /api/generate-thumbnails
   - Uses Canvas to generate 10 viral thumbnails
   - Handles custom caption, topic, ZIP packing, watermarking
   - Bulletproof error handling, MAX logging
   =========================================================== */

const { createCanvas, loadImage, registerFont } = require('canvas');
const JSZip = require('jszip');

const fontPath = path.join(__dirname, 'frontend', 'assets', 'fonts', 'LuckiestGuy-Regular.ttf');
if (fs.existsSync(fontPath)) {
  registerFont(fontPath, { family: 'LuckiestGuy' });
  console.log('[FONT] Registered LuckiestGuy font:', fontPath);
} else {
  console.warn('[FONT] LuckiestGuy font missing:', fontPath);
}

// Utility: Generate one thumbnail as a buffer
async function generateSingleThumbnail({ caption, topic, templateIndex = 0 }) {
  try {
    const width = 1080, height = 1920;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = "#00e0fe";
    ctx.fillRect(0, 0, width, height);

    // Overlay image template (can expand with real template logic)
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = 0.08 + 0.1 * (templateIndex % 3);
    ctx.fillRect(40, 180, width - 80, height - 400);
    ctx.globalAlpha = 1.0;

    // Topic
    ctx.font = 'bold 88px LuckiestGuy, Arial';
    ctx.fillStyle = "#0a2342";
    ctx.fillText(topic, 70, 300);

    // Caption
    ctx.font = 'bold 110px LuckiestGuy, Arial';
    ctx.fillStyle = "#00b3c4";
    ctx.fillText(caption, 70, 490);

    // Watermark (bottom right)
    ctx.font = '32px Arial';
    ctx.fillStyle = "#10141a";
    ctx.globalAlpha = 0.23;
    ctx.fillText('SocialStormAI.com', width - 470, height - 60);
    ctx.globalAlpha = 1.0;

    // Return image as buffer (jpeg)
    return canvas.toBuffer('image/jpeg', { quality: 0.93 });
  } catch (err) {
    console.error(`[ERR][THUMBNAIL] Failed to generate thumbnail`, err);
    throw err;
  }
}

// Endpoint: /api/generate-thumbnails
app.post('/api/generate-thumbnails', async (req, res) => {
  console.log('[REQ] POST /api/generate-thumbnails');
  try {
    const { caption = '', topic = '' } = req.body || {};
    if (!caption || !topic) {
      console.warn('[ERR][THUMBNAIL] Missing caption or topic');
      return res.status(400).json({ success: false, error: "Missing caption or topic" });
    }
    console.log(`[THUMBNAIL] Generating pack for: caption="${caption}", topic="${topic}"`);

    // Generate 10 thumbnails with minor variation
    const thumbs = [];
    for (let i = 0; i < 10; i++) {
      thumbs.push(await generateSingleThumbnail({ caption, topic, templateIndex: i }));
    }

    // Package into a zip
    const zip = new JSZip();
    thumbs.forEach((buf, i) => {
      zip.file(`thumbnail_${i + 1}.jpg`, buf);
    });

    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="thumbnails.zip"');
    console.log('[THUMBNAIL] ZIP pack ready, sending...');
    res.end(zipBuf);

  } catch (err) {
    console.error('[ERR][THUMBNAIL] Endpoint error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate thumbnails' });
  }
});




/* ===========================================================
   SECTION 7: VIDEO STREAM ENDPOINT
   -----------------------------------------------------------
   - Serve videos directly from /public/video (local disk)
   - Bulletproof path checking, MAX logging
   =========================================================== */

app.get('/video/:key', (req, res) => {
  const key = req.params.key;
  console.log(`[REQ] GET /video/${key}`);

  // Block path traversal and require .mp4 extension
  if (!key || typeof key !== 'string' || key.includes('..') || !key.endsWith('.mp4')) {
    console.warn('[VIDEO SERVE] Invalid or missing key:', key);
    return res.status(400).send('Invalid video key');
  }

  const videoPath = path.join(__dirname, 'public', 'video', key);

  fs.stat(videoPath, (err, stats) => {
    if (err || !stats.isFile()) {
      console.warn(`[404] Video not found on disk: ${videoPath}`);
      return res.status(404).send("Video not found");
    }

    console.log(`[SERVE] Sending video: ${videoPath}`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `inline; filename="${key}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 7 days

    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : stats.size - 1;
      if (isNaN(start) || isNaN(end) || start > end) {
        console.warn('[SERVE] Bad range request:', range);
        return res.status(416).send('Requested range not satisfiable');
      }
      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4'
      });
      fs.createReadStream(videoPath, { start, end }).pipe(res);
      console.log(`[SERVE] Partial video sent: ${key} [${start}-${end}]`);
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': 'video/mp4'
      });
      fs.createReadStream(videoPath).pipe(res);
      console.log(`[SERVE] Full video sent: ${key}`);
    }
  });
});


/* ===========================================================
   SECTION 8: CONTACT FORM ENDPOINT
   -----------------------------------------------------------
   - POST /api/contact
   - Accepts form message, logs all inputs/results/errors
   - MAXIMUM logging, bulletproof error handling
   =========================================================== */

app.post('/api/contact', async (req, res) => {
  console.log('[REQ] POST /api/contact');
  try {
    const { name = '', email = '', message = '' } = req.body;
    console.log('[CONTACT INPUT] Name:', name, '| Email:', email, '| Message:', message);
    if (!name || !email || !message) {
      console.warn('[WARN] Missing contact form fields.');
      return res.json({ success: false, error: "Please fill out all fields." });
    }
    console.log(`[CONTACT] Message received from: ${name} <${email}> | Message: ${message}`);
    res.json({ success: true, status: "Message received!" });
    console.log('[CONTACT] Success response sent.');
  } catch (err) {
    console.error('[ERROR] /api/contact:', err);
    res.json({ success: false, error: "Failed to send message." });
  }
});


/* ===========================================================
   SECTION 9: ERROR HANDLING & SERVER START
   -----------------------------------------------------------
   - 404 catchall
   - Start server on chosen port
   - MAXIMUM logging: logs server startup and bad routes
   =========================================================== */

app.use((req, res) => {
  console.warn('[404] Route not found:', req.originalUrl);
  res.status(404).send('Not found');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🟢 SocialStormAI backend running on port ${PORT}`);
});


