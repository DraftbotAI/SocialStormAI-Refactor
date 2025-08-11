// ============================================================
// SECTION 5B: GENERATE VIDEO ENDPOINT (Job Controller)
// The /api/generate-video route handler. Full job orchestration.
// MAX LOGGING EVERYWHERE, User-friendly status messages!
//
// 2025-08 updates:
//  - R2-first pipeline
//  - Stopwords→AI scene subject flow (via Section 11)
//  - Per-job de-dupe is handled in 5D
//  - Bulletproof scene normalization, caching, and quality checks
//  - TTS generation in-process (AWS Polly) with neural→standard fallback
//  - **NEW:** Robust subject coercion (arrays/objects → strings) to prevent .toLowerCase() crashes
// ============================================================

'use strict';

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');

const {
  s3Client,
  PutObjectCommand,
  GetObjectCommand,
  progress, // progress tracker from Section 1
} = require('./section1-setup.cjs');

const {
  bulletproofScenes,
  splitScriptToScenes,
} = require('./section5c-script-scene-utils.cjs');

const { extractVisualSubjects } = require('./section11-visual-subject-extractor.cjs');

const {
  concatScenes,
  ensureAudioStream,
  overlayMusic,
  appendOutro,
  getUniqueFinalName,
  pickMusicForMood
} = require('./section5g-concat-and-music.cjs');

const {
  getDuration,
  trimForNarration,
  muxVideoWithNarration,
} = require('./section5f-video-processing.cjs');

const { findClipForScene } = require('./section5d-clip-matcher.cjs');
const { cleanupJob } = require('./section5h-job-cleanup.cjs');

// --- Polly (neural + fallback) ---
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');

console.log('[5B][INIT] section5b-generate-video-endpoint.cjs loaded');

// === CACHE DIRS ===
const audioCacheDir = path.resolve(__dirname, '..', 'audio_cache');
const videoCacheDir = path.resolve(__dirname, '..', 'video_cache');
if (!fs.existsSync(audioCacheDir)) fs.mkdirSync(audioCacheDir, { recursive: true });
if (!fs.existsSync(videoCacheDir)) fs.mkdirSync(videoCacheDir, { recursive: true });

// --- Duration probe fallback (avoids ffprobe arch issues) ---
async function getDurationSafe(filePath) {
  try {
    const d = await getDuration(filePath);
    if (typeof d === 'number' && isFinite(d) && d > 0) return d;
    throw new Error('getDuration returned invalid: ' + d);
  } catch (err) {
    console.warn('[5B][DUR][FALLBACK] getDuration failed, using ffmpeg parse:', (err && err.message) || err);
    return await probeDurationViaFfmpeg(filePath);
  }
}

function parseDurationFromStderr(stderr) {
  const m = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const h = parseInt(m[1], 10) || 0;
  const mnt = parseInt(m[2], 10) || 0;
  const s = parseFloat(m[3]) || 0;
  return h * 3600 + mnt * 60 + s;
}

async function probeDurationViaFfmpeg(filePath) {
  return await new Promise((resolve) => {
    const args = ['-i', filePath];
    execFile(ffmpegPath, args, { windowsHide: true }, (_error, stdout, stderr) => {
      const dur = parseDurationFromStderr(stderr || stdout);
      if (!dur || !isFinite(dur)) {
        console.error('[5B][DUR][FALLBACK][ERR] Unable to parse duration for', filePath);
        return resolve(0);
      }
      console.log('[5B][DUR][FALLBACK] Parsed duration', dur, 'for', filePath);
      resolve(dur);
    });
  });
}

function hashForCache(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

// ----------------------
// File / HTTP helpers
// ----------------------
function assertFileExists(file, label = 'FILE', minBytes = 10240) {
  try {
    if (!file || !fs.existsSync(file)) {
      throw new Error(`[5B][${label}][ERR] File does not exist: ${file}`);
    }
    const sz = fs.statSync(file).size;
    if (sz < minBytes) {
      throw new Error(`[5B][${label}][ERR] File too small (${sz} bytes): ${file}`);
    }
    return true;
  } catch (e) {
    console.error(`[5B][${label}][ERR]`, e);
    return false;
  }
}

function isHttpUrl(str) {
  return typeof str === 'string' && /^https?:\/\//i.test(str);
}

async function downloadHttpToFile(url, outPath, jobId = '') {
  console.log(`[5B][HTTP][${jobId}] Downloading ${url} -> ${outPath}`);
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        file.close?.();
        try { fs.unlinkSync(outPath); } catch {}
        return reject(new Error(`[5B][HTTP][${jobId}] HTTP ${response.statusCode} for ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      file.close?.();
      try { fs.unlinkSync(outPath); } catch {}
      reject(err);
    });
  });
  console.log(`[5B][HTTP][${jobId}] Download complete: ${outPath}`);
  return outPath;
}

// ----------------------
// TTS helpers (Polly)
// ----------------------
const pollyClient = new PollyClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function synthesizePollyToFile({ text, voice = 'Matthew', outPath, jobId, engine = 'neural' }) {
  const params = {
    OutputFormat: 'mp3',
    Text: text,
    VoiceId: voice,
    Engine: engine, // 'neural' or 'standard'
    SampleRate: '22050',
    TextType: 'text',
  };
  console.log(`[5B][TTS][${jobId}] Polly synth (${engine}) voice=${voice} → ${outPath}`);
  const cmd = new SynthesizeSpeechCommand(params);
  const resp = await pollyClient.send(cmd);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    resp.AudioStream.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  return outPath;
}

async function ensureTTSFile({ text, voice = 'Matthew', outPath, jobId }) {
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 4096) {
    console.log(`[5B][TTS][CACHE][${jobId}] Using cached audio: ${outPath}`);
    return outPath;
  }
  try {
    await synthesizePollyToFile({ text, voice, outPath, jobId, engine: 'neural' });
    return outPath;
  } catch (eNeural) {
    console.warn(`[5B][TTS][WARN][${jobId}] Neural failed, retrying standard:`, eNeural?.message || eNeural);
    await synthesizePollyToFile({ text, voice, outPath, jobId, engine: 'standard' });
    return outPath;
  }
}

// ----------------------
// Subject cleaning (HARDENED)
// ----------------------
const GENERIC_SUBJECTS = new Set([
  'face','person','man','woman','it','thing','someone','something','body','eyes',
  'their','they','them','this','that','these','those','your','you','we','our','its',
  "you're","youre","i","me","my","mine","ours","hers","his","theirs","subject"
]);

function coerceSubjectToString(input) {
  try {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    if (Array.isArray(input)) {
      // Find first useful string or object.subject/full_query
      for (const item of input) {
        if (typeof item === 'string' && item.trim()) return item;
        if (item && typeof item === 'object') {
          const c =
            (typeof item.subject === 'string' && item.subject) ||
            (typeof item.full_query === 'string' && item.full_query) ||
            (typeof item.text === 'string' && item.text) ||
            (typeof item.name === 'string' && item.name) ||
            '';
          if (c.trim()) return c;
        }
      }
      // Fallback: stringify first entry
      return JSON.stringify(input[0] ?? '');
    }
    if (typeof input === 'object') {
      const c =
        (typeof input.subject === 'string' && input.subject) ||
        (typeof input.full_query === 'string' && input.full_query) ||
        (typeof input.text === 'string' && input.text) ||
        (typeof input.name === 'string' && input.name) ||
        '';
      if (c.trim()) return c;
      return JSON.stringify(input);
    }
    return String(input);
  } catch {
    return '';
  }
}

function cleanSubjectMaybeFallback(subj, mainTopic) {
  const coerced = coerceSubjectToString(subj);
  const s = coerced.toLowerCase().trim();
  const topic = (mainTopic || '').toLowerCase().trim();

  if (!s) return topic || 'nature';
  if (GENERIC_SUBJECTS.has(s)) return topic || 'nature';
  if (s.startsWith('line:') || s.startsWith('main topic:')) return topic || 'nature';
  if (s.startsWith('next time')) return topic || 'nature';
  if (s.startsWith('wrap your mind')) return topic || 'nature';

  // condense weird tokens like “sixth senseliterally”
  const cleaned = s.replace(/\s{2,}/g, ' ').replace(/[^a-z0-9\s\-']/gi, '').trim();
  return cleaned || topic || 'nature';
}

// --------------
// Route handler
// --------------
async function generateVideoHandler(req, res) {
  const jobId = uuidv4();
  const workDir = path.resolve(__dirname, '..', 'jobs', jobId);
  fs.mkdirSync(workDir, { recursive: true });

  console.log(`\n========== [5B][JOB][START] ${jobId} ==========\n`);

  try {
    const { script, voice = 'Matthew', mainTopic, category = 'misc' } = req.body || {};
    const categoryFolder = String(category || 'misc').toLowerCase();

    // Normalize and split scenes
    const scenes = bulletproofScenes(splitScriptToScenes(script || ''), mainTopic);
    const allSceneTexts = scenes.map(s => s.texts?.[0] || '').filter(Boolean);

    // Resolve a non-empty mainTopic for downstream calls/prompts
    const resolvedMainTopic = (mainTopic && String(mainTopic).trim()) ||
      (allSceneTexts[0] && /manatee/i.test(allSceneTexts[0]) ? 'manatee' : '') ||
      'wildlife';

    // === HOOK scene ===
    const hookText = scenes[0]?.texts?.[0] || allSceneTexts[0] || resolvedMainTopic || 'intro';
    const audioPathHook = path.join(audioCacheDir, `${hashForCache(hookText + voice)}-hook.mp3`);
    console.log(`[5B][AUDIO][HOOK][${jobId}] Generating (if missing) hook audio...`);
    await ensureTTSFile({ text: hookText, voice, outPath: audioPathHook, jobId });
    if (!assertFileExists(audioPathHook, 'AUDIO_HOOK')) throw new Error('Hook audio generation failed');

    let hookClipPath = null;
    try {
      const hookSubject = cleanSubjectMaybeFallback(scenes[0].visualSubject || hookText || resolvedMainTopic, resolvedMainTopic);
      hookClipPath = await findClipForScene({
        subject: hookSubject,
        sceneIdx: 0,
        allSceneTexts,
        mainTopic: resolvedMainTopic,
        isMegaScene: false,
        workDir,
        jobId,
        categoryFolder
      });
    } catch (e) {
      console.error(`[5B][CLIP][ERR][${jobId}] findClipForScene failed for HOOK:`, e);
    }
    if (!hookClipPath) throw new Error('No hook clip found.');

    // Localize if remote
    const localHookClipPath = isHttpUrl(hookClipPath)
      ? path.join(workDir, 'scene1-source.mp4')
      : hookClipPath;

    if (isHttpUrl(hookClipPath)) {
      await downloadHttpToFile(hookClipPath, localHookClipPath, jobId);
    }

    if (!assertFileExists(localHookClipPath, 'HOOK_CLIP_LOCAL')) throw new Error('Hook clip localization failed');

    const hookDuration = await getDurationSafe(audioPathHook);
    const trimmedHookClip = path.join(workDir, `scene1-trimmed.mp4`);
    await trimForNarration(localHookClipPath, trimmedHookClip, hookDuration);
    if (!assertFileExists(trimmedHookClip, 'HOOK_TRIMMED', 4096)) throw new Error('Hook trim failed');

    // === MEGA scene (scene 2) ===
    const megaText = scenes[1]?.texts?.[0] || allSceneTexts[1] || resolvedMainTopic || '';
    const audioPathMega = path.join(audioCacheDir, `${hashForCache(megaText + voice)}-mega.mp3`);
    console.log(`[5B][AUDIO][MEGA][${jobId}] Generating (if missing) mega audio...`);
    await ensureTTSFile({ text: megaText, voice, outPath: audioPathMega, jobId });
    if (!assertFileExists(audioPathMega, 'AUDIO_MEGA')) throw new Error('Mega audio generation failed');

    // Subject extraction for mega
    let candidateSubjects = [];
    try {
      const extracted = await extractVisualSubjects(megaText, resolvedMainTopic);
      candidateSubjects = Array.isArray(extracted) ? extracted : [];
    } catch (e) {
      console.warn(`[5B][MEGA][WARN] Subject extract failed, falling back:`, e);
    }
    if (!candidateSubjects.length) candidateSubjects = [megaText, resolvedMainTopic].filter(Boolean);

    let megaClipPath = null;
    for (const subj of candidateSubjects) {
      const cleaned = cleanSubjectMaybeFallback(subj, resolvedMainTopic);
      megaClipPath = await findClipForScene({
        subject: cleaned,
        sceneIdx: 1,
        allSceneTexts,
        mainTopic: resolvedMainTopic,
        isMegaScene: true,
        workDir,
        jobId,
        categoryFolder
      });
      if (megaClipPath) break;
    }
    if (!megaClipPath) {
      const { fallbackKenBurnsVideo } = require('./section10d-kenburns-image-helper.cjs');
      const fallbacks = [resolvedMainTopic, megaText, candidateSubjects[0], 'manatee wildlife'].filter(Boolean);
      for (const fb of fallbacks) {
        megaClipPath = await fallbackKenBurnsVideo(fb, workDir, 1, jobId);
        if (megaClipPath) break;
      }
    }
    if (!megaClipPath) throw new Error('No mega clip found.');

    const localMegaClipPath = isHttpUrl(megaClipPath)
      ? path.join(workDir, 'scene2-source.mp4')
      : megaClipPath;

    if (isHttpUrl(megaClipPath)) {
      await downloadHttpToFile(megaClipPath, localMegaClipPath, jobId);
    }
    if (!assertFileExists(localMegaClipPath, 'MEGA_CLIP_LOCAL')) throw new Error('Mega clip localization failed');

    const megaDuration = await getDurationSafe(audioPathMega);
    const trimmedMegaClip = path.join(workDir, `scene2-trimmed.mp4`);
    await trimForNarration(localMegaClipPath, trimmedMegaClip, megaDuration);
    if (!assertFileExists(trimmedMegaClip, 'MEGA_TRIMMED', 4096)) throw new Error('Mega trim failed');

    // === Remaining Scenes ===
    const stagedClips = [trimmedHookClip, trimmedMegaClip];
    for (let i = 2; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneIdx = i;

      const sceneSubject = cleanSubjectMaybeFallback(
        scene.visualSubject || (Array.isArray(scene.texts) && scene.texts[0]) || allSceneTexts[sceneIdx],
        resolvedMainTopic
      );

      let clipPath = null;
      try {
        clipPath = await findClipForScene({
          subject: sceneSubject,
          sceneIdx,
          allSceneTexts,
          mainTopic: resolvedMainTopic,
          isMegaScene: false,
          workDir,
          jobId,
          categoryFolder
        });
      } catch (e) {
        console.error(`[5B][CLIP][ERR][${jobId}] findClipForScene failed for scene ${sceneIdx + 1}:`, e);
      }
      if (!clipPath) {
        console.error(`[5B][ERR][NO_MATCH][${jobId}] No clip found for scene ${sceneIdx + 1}. Failing this job.`);
        if (progress) {
          progress[jobId] = { percent: 100, status: `No clip found for scene ${sceneIdx + 1}. Try a clearer topic.` };
        }
        return res.status(500).json({ ok: false, error: `No clip found for scene ${sceneIdx + 1}` });
      }

      const localClipPath = isHttpUrl(clipPath)
        ? path.join(workDir, `scene${sceneIdx + 1}-source.mp4`)
        : clipPath;

      if (isHttpUrl(clipPath)) {
        await downloadHttpToFile(clipPath, localClipPath, jobId);
      }
      if (!assertFileExists(localClipPath, `SCENE${sceneIdx + 1}_LOCAL`)) {
        throw new Error(`Scene ${sceneIdx + 1} clip localization failed`);
      }

      const sceneText = scene.texts?.[0] || '';
      const audioCachePath = path.join(audioCacheDir, `${hashForCache(sceneText + voice)}-scene${sceneIdx + 1}.mp3`);
      console.log(`[5B][AUDIO][SCENE${sceneIdx + 1}][${jobId}] Generating (if missing) narration...`);
      await ensureTTSFile({ text: sceneText, voice, outPath: audioCachePath, jobId });
      if (!assertFileExists(audioCachePath, `AUDIO_SCENE_${sceneIdx + 1}`)) throw new Error('Scene audio generation failed');

      const narrationDuration = await getDurationSafe(audioCachePath);
      const trimmedVideoPath = path.join(workDir, `scene${sceneIdx + 1}-trimmed.mp4`);
      await trimForNarration(localClipPath, trimmedVideoPath, narrationDuration);
      if (!assertFileExists(trimmedVideoPath, `SCENE${sceneIdx + 1}_TRIMMED`, 4096)) {
        throw new Error(`Scene ${sceneIdx + 1} trim failed`);
      }

      const muxedPath = path.join(workDir, `scene${sceneIdx + 1}-muxed.mp4`);
      await muxVideoWithNarration(trimmedVideoPath, audioCachePath, muxedPath);
      if (!assertFileExists(muxedPath, `SCENE${sceneIdx + 1}_MUXED`, 4096)) {
        throw new Error(`Scene ${sceneIdx + 1} mux failed`);
      }
      stagedClips.push(muxedPath);
    }

    // === Final assembly ===
    const stitchedPath = await concatScenes(stagedClips, workDir, jobId);
    const stitchedFixed = await ensureAudioStream(stitchedPath, workDir, jobId);

    // === Optional music (post-stitch) ===
    const mood = await pickMusicForMood(scenes.map(s => s.texts?.join(' ') || '').join(' ')); // <-- FIX: await
    const withMusic = await overlayMusic(stitchedFixed, mood, workDir, jobId);

    // === Optional outro ===
    const finalWithOutro = await appendOutro(withMusic, workDir, jobId);

    // === Upload to R2
    const finalName = getUniqueFinalName(resolvedMainTopic || 'video', jobId);
    const uploadKey = `videos/${finalName}`;
    console.log(`[5B][UPLOAD][${jobId}] Uploading final: ${uploadKey}`);

    const finalBuffer = fs.readFileSync(finalWithOutro);
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET || process.env.R2_LIBRARY_BUCKET,
      Key: uploadKey,
      Body: finalBuffer,
      ContentType: 'video/mp4',
      ACL: 'public-read'
    }));

    const url = `${process.env.R2_PUBLIC_BASE}/${uploadKey}`;
    console.log(`[5B][DONE][${jobId}]`, url);
    return res.json({ ok: true, jobId, url });

  } catch (err) {
    console.error(`[5B][FATAL][JOB][${jobId}]`, err);
    try {
      return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    } catch (_) { /* noop */ }
  } finally {
    try { await cleanupJob(jobId); } catch (e) { console.warn('[5B][CLEANUP][WARN]', e); }
    console.log(`\n========== [5B][JOB][END] ${jobId} ==========\n`);
  }
}

// ===== Register function expected by server.cjs =====
function registerGenerateVideoEndpoint(app) {
  console.log('========== [SECTION5B][START] Registering /api/generate-video ==========');
  if (!app || typeof app.post !== 'function') {
    console.error('[SECTION5B][ERR] Express app not provided to registerGenerateVideoEndpoint.');
    throw new Error('registerGenerateVideoEndpoint requires a valid Express app');
  }
  app.post('/api/generate-video', (req, res) => {
    Promise.resolve(generateVideoHandler(req, res)).catch(err => {
      console.error('[SECTION5B][UNCAUGHT][/api/generate-video]', err);
      try { res.status(500).json({ ok: false, error: String((err && err.message) || err) }); } catch (_) {}
    });
  });
  console.log('[SECTION5B][SUCCESS] /api/generate-video endpoint registered.');
}

// ------- Exports (support BOTH import styles) -------
module.exports = registerGenerateVideoEndpoint; // default export (callable)
module.exports.registerGenerateVideoEndpoint = registerGenerateVideoEndpoint; // named
module.exports.generateVideoHandler = generateVideoHandler; // named
