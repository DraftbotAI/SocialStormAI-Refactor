// ============================================================
// SECTION 10D: KEN BURNS IMAGE VIDEO HELPER (Bulletproofed!)
// Finds fallback still images from Unsplash, Pexels, Pixabay.
// Downloads, scores, creates slow-pan video with FFmpeg.
// MAX LOGGING EVERY STEP, Modular, Deduped, Never dies
// PAN-ONLY (NO ZOOM). Always returns a video if at all possible.
// ============================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

// === ENV KEYS ===
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

// Optional: custom UA for APIs that throttle generic clients
const USER_AGENT = process.env.HTTP_USER_AGENT || 'SocialStormAI/10D (+https://socialstormai.com)';

console.log('[10D][INIT] Ken Burns image video helper loaded.');

// ------------------------------------------------------------
// Utility: ensure dir exists
// ------------------------------------------------------------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ------------------------------------------------------------
// Utility: safe filename
// ------------------------------------------------------------
function safeName(s) {
  return String(s || '')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 80);
}

// ------------------------------------------------------------
// Validate output file
// ------------------------------------------------------------
function isValidFile(fp, jobId) {
  try {
    if (!fs.existsSync(fp)) {
      console.warn(`[10D][VALIDATE][${jobId}] File does not exist: ${fp}`);
      return false;
    }
    const sz = fs.statSync(fp).size;
    if (sz < 2048) {
      console.warn(`[10D][VALIDATE][${jobId}] File too small: ${fp} (${sz} bytes)`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[10D][VALIDATE][${jobId}] Error validating file:`, e);
    return false;
  }
}

// ------------------------------------------------------------
// Clean/score helpers
// ------------------------------------------------------------
function cleanQuery(str) {
  if (!str) return '';
  return str.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
}
function getKeywords(str) {
  return String(str).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s\-]+/g)
    .filter(w => w.length > 2);
}
function strictSubjectPresent(fields, subject) {
  const subjectWords = getKeywords(subject);
  if (!subjectWords.length) return false;
  return subjectWords.every(w => fields.includes(w));
}

// Known landmarks — used to disambiguate “statue” vs. “Statue of Liberty”, etc.
const LANDMARK_MAP = [
  { key: 'statue of liberty', hints: ['liberty', 'new york', 'nyc', 'ellis island', 'torch'] },
  { key: 'eiffel tower', hints: ['paris', 'france', 'tour eiffel', 'champ de mars'] },
  { key: 'big ben', hints: ['elizabeth tower', 'london', 'uk', 'westminster'] },
  { key: 'golden gate bridge', hints: ['san francisco', 'sf', 'marin', 'suspension'] },
  { key: 'colosseum', hints: ['rome', 'italy', 'roman amphitheatre'] },
  { key: 'taj mahal', hints: ['agra', 'india', 'mausoleum'] },
  { key: 'sphinx', hints: ['giza', 'egypt', 'pyramids'] },
  { key: 'machu picchu', hints: ['peru', 'andes', 'inca'] },
  { key: 'great wall', hints: ['china', 'beijing'] },
];

// ------------------------------------------------------------
// Scoring: rank images for fallback Ken Burns
// ------------------------------------------------------------
function scoreImage(candidate, subject, usedClips = []) {
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);

  let fields = '';
  if (candidate.api === 'unsplash') {
    fields = [
      candidate.alt_description || '',
      candidate.description || '',
      (candidate.tags || []).map(t => (t.title || t)).join(' '),
      candidate.user?.name || '',
      candidate.urls?.full || '',
      candidate.urls?.raw || ''
    ].join(' ').toLowerCase();
  } else if (candidate.api === 'pexels') {
    fields = [
      candidate.alt || '',
      candidate.photographer || '',
      candidate.src?.original || '',
      candidate.url || ''
    ].join(' ').toLowerCase();
  } else if (candidate.api === 'pixabay') {
    fields = [
      candidate.tags || '',
      candidate.user || '',
      candidate.pageURL || '',
      candidate.largeImageURL || ''
    ].join(' ').toLowerCase();
  } else if (candidate.api === 'minimal') {
    // minimal candidate with only url/api during fallback selection
    fields = (candidate.url || '').toLowerCase();
  }

  // Base subject matching
  if (strictSubjectPresent(fields, subject)) score += 100;
  if (subjectWords.every(w => fields.includes(w))) score += 35;
  subjectWords.forEach(word => { if (fields.includes(word)) score += 6; });
  if (fields.includes(cleanedSubject)) score += 18;

  // Landmark disambiguation: strongly reward full landmark phrase + hints
  const subjLower = cleanedSubject;
  for (const lm of LANDMARK_MAP) {
    if (subjLower.includes(lm.key)) {
      if (fields.includes(lm.key)) score += 70;
      let hintHits = 0;
      lm.hints.forEach(h => { if (fields.includes(h)) hintHits++; });
      score += Math.min(hintHits * 10, 30); // up to +30 for strong context
      // Penalize “generic statue” if landmark expected but “liberty” not present
      if (lm.key === 'statue of liberty') {
        if (fields.includes('statue') && !fields.includes('liberty')) score -= 30;
      }
      break;
    }
  }

  // Resolution / orientation
  const w = candidate.width || candidate.imageWidth;
  const h = candidate.height || candidate.imageHeight;
  if (w && w >= 1000) score += 7;
  if (h && h >= 1000) score += 7;
  if (w && h && h / w > 1.3) score += 8; // portrait bias

  // Penalize if appears in usedClips
  if (
    usedClips &&
    candidate.url &&
    usedClips.some(u =>
      typeof u === 'string' && (
        u.includes(candidate.url) ||
        (candidate.id && u.includes(String(candidate.id))) ||
        (u.endsWith?.('.jpg') && path.basename(u).includes(String(candidate.id || '')))
      )
    )
  ) score -= 60;

  // Popularity proxies
  if (candidate.downloads && candidate.downloads > 10000) score += 4;
  if (candidate.id && Number(candidate.id) > 1000000) score += 1;

  return score;
}

// ------------------------------------------------------------
// Unsplash image search
// ------------------------------------------------------------
async function findImageInUnsplash(subject, usedClips = []) {
  if (!UNSPLASH_ACCESS_KEY) {
    console.warn('[10D][UNSPLASH] No access key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://api.unsplash.com/search/photos?query=${query}&per_page=15&orientation=portrait&client_id=${UNSPLASH_ACCESS_KEY}`;
    console.log(`[10D][UNSPLASH] Request: ${url}`);
    const resp = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': USER_AGENT }
    });
    if (resp.data?.results?.length > 0) {
      let candidates = resp.data.results.map(item => ({
        ...item,
        api: 'unsplash',
        url: item.urls.full,
        width: item.width,
        height: item.height,
        id: item.id
      }));
      candidates = candidates.filter(c =>
        !usedClips.some(u =>
          typeof u === 'string' && (
            u.includes(c.url) ||
            (c.id && u.includes(String(c.id))) ||
            (u.endsWith?.('.jpg') && path.basename(u).includes(String(c.id || '')))
          )
        )
      );
      candidates.forEach(c => { c.score = scoreImage(c, subject, usedClips); });
      candidates.sort((a, b) => b.score - a.score);
      candidates.slice(0, 4).forEach((c, i) => {
        console.log(`[10D][UNSPLASH][CANDIDATE][${i + 1}] ${c.urls.full} | score=${c.score} | desc="${c.description || c.alt_description || ''}"`);
      });
      if (candidates.length) return candidates[0].urls.full;
    }
    console.log(`[10D][UNSPLASH] No images found for: "${subject}"`);
    return null;
  } catch (err) {
    if (err.response) {
      console.error(`[10D][UNSPLASH][ERR] Status: ${err.response.status}, Data:`, err.response.data);
    } else {
      console.error('[10D][UNSPLASH][ERR]', err);
    }
    return null;
  }
}

// ------------------------------------------------------------
// Pexels image search
// ------------------------------------------------------------
async function findImageInPexels(subject, usedClips = []) {
  if (!PEXELS_API_KEY) {
    console.warn('[10D][PEXELS-IMG] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://api.pexels.com/v1/search?query=${query}&per_page=12&orientation=portrait`;
    console.log(`[10D][PEXELS-IMG] Request: ${url}`);
    const resp = await axios.get(url, {
      headers: { Authorization: PEXELS_API_KEY, 'User-Agent': USER_AGENT },
      timeout: 12000,
      maxRedirects: 3,
    });
    if (resp.data?.photos?.length > 0) {
      let candidates = resp.data.photos.map(item => ({
        ...item,
        api: 'pexels',
        url: item.src.original,
        width: item.width,
        height: item.height,
        id: item.id
      }));
      candidates = candidates.filter(c =>
        !usedClips.some(u =>
          typeof u === 'string' && (
            u.includes(c.url) ||
            (c.id && u.includes(String(c.id))) ||
            (u.endsWith?.('.jpg') && path.basename(u).includes(String(c.id || '')))
          )
        )
      );
      candidates.forEach(c => { c.score = scoreImage(c, subject, usedClips); });
      candidates.sort((a, b) => b.score - a.score);
      candidates.slice(0, 4).forEach((c, i) => {
        console.log(`[10D][PEXELS-IMG][CANDIDATE][${i + 1}] ${c.src.original} | score=${c.score} | photographer="${c.photographer || ''}"`);
      });
      if (candidates.length) return candidates[0].src.original;
    }
    console.log(`[10D][PEXELS-IMG] No images found for: "${subject}"`);
    return null;
  } catch (err) {
    if (err.response) {
      console.error(`[10D][PEXELS-IMG][ERR] Status: ${err.response.status}, Data:`, err.response.data);
    } else {
      console.error('[10D][PEXELS-IMG][ERR]', err);
    }
    return null;
  }
}

// ------------------------------------------------------------
// Pixabay image search
// ------------------------------------------------------------
async function findImageInPixabay(subject, usedClips = []) {
  if (!PIXABAY_API_KEY) {
    console.warn('[10D][PIXABAY-IMG] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query}&image_type=photo&per_page=12&orientation=vertical`;
    console.log(`[10D][PIXABAY-IMG] Request: ${url}`);
    const resp = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': USER_AGENT }
    });
    if (resp.data?.hits?.length > 0) {
      let candidates = resp.data.hits.map(item => ({
        ...item,
        api: 'pixabay',
        url: item.largeImageURL,
        width: item.imageWidth,
        height: item.imageHeight,
        id: item.id || item.pageURL || item.largeImageURL
      }));
      candidates = candidates.filter(c =>
        !usedClips.some(u =>
          typeof u === 'string' && (
            u.includes(c.url) ||
            (c.id && u.includes(String(c.id))) ||
            (u.endsWith?.('.jpg') && path.basename(u).includes(String(c.id || '')))
          )
        )
      );
      candidates.forEach(c => { c.score = scoreImage(c, subject, usedClips); });
      candidates.sort((a, b) => b.score - a.score);
      candidates.slice(0, 4).forEach((c, i) => {
        console.log(`[10D][PIXABAY-IMG][CANDIDATE][${i + 1}] ${c.largeImageURL} | score=${c.score} | tags="${c.tags}"`);
      });
      if (candidates.length) return candidates[0].largeImageURL;
    }
    console.log(`[10D][PIXABAY-IMG] No images found for: "${subject}"`);
    return null;
  } catch (err) {
    if (err.response) {
      console.error(`[10D][PIXABAY-IMG][ERR] Status: ${err.response.status}, Data:`, err.response.data);
    } else {
      console.error('[10D][PIXABAY-IMG][ERR]', err);
    }
    return null;
  }
}

// ------------------------------------------------------------
// Download remote image to local disk
// ------------------------------------------------------------
async function downloadRemoteFileToLocal(url, outPath, jobId = '') {
  console.log(`[10D][DL][${jobId}] Downloading | url="${url}" | outPath="${outPath}"`);
  try {
    if (!url) throw new Error('No URL provided to download.');
    ensureDir(path.dirname(outPath));
    if (fs.existsSync(outPath)) {
      console.log(`[10D][DL][${jobId}] File already exists, skipping download: ${outPath}`);
      return;
    }
    const writer = fs.createWriteStream(outPath);
    const resp = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 60000,
      maxRedirects: 4,
      headers: { 'User-Agent': USER_AGENT }
    });

    await new Promise((resolve, reject) => {
      resp.data.pipe(writer);
      let errored = false;
      writer.on('error', err => {
        errored = true;
        console.error('[10D][DL][ERR]', err);
        writer.close();
        reject(err);
      });
      writer.on('finish', () => {
        if (!errored) {
          console.log('[10D][DL] Download complete:', outPath, 'size:', fs.existsSync(outPath) ? fs.statSync(outPath).size : 'N/A');
          resolve();
        }
      });
    });

    if (!isValidFile(outPath, jobId)) {
      throw new Error('[10D][DL] File not written or broken after download: ' + outPath);
    }
  } catch (err) {
    console.error('[10D][DL][ERR]', url, err);
    throw err;
  }
}

// ------------------------------------------------------------
// Preprocess: always scale to 1080x1920 portrait, pad, JPEG output
// ------------------------------------------------------------
async function preprocessImageToJpeg(inPath, outPath, jobId = '') {
  try {
    console.log(`[10D][PREPROCESS][${jobId}] Preprocessing image: ${inPath} → ${outPath}`);
    ensureDir(path.dirname(outPath));
    await sharp(inPath)
      .resize(1080, 1920, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
      .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
      .toFile(outPath);
    if (!isValidFile(outPath, jobId)) {
      throw new Error('[10D][PREPROCESS][ERR] Sharp output file not valid: ' + outPath);
    }
    console.log(`[10D][PREPROCESS][${jobId}] Preprocessing complete: ${outPath}`);
    return outPath;
  } catch (err) {
    console.error(`[10D][PREPROCESS][ERR][${jobId}] Failed to preprocess image`, err);
    throw err;
  }
}

// ------------------------------------------------------------
// Build a text image (placeholder) 1080x1920 using sharp
// ------------------------------------------------------------
async function buildTextImage(subject, outPng, jobId = '') {
  const width = 1080, height = 1920;
  const text = (String(subject || 'No Visual')).slice(0, 120);
  const svg =
`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1f2937"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="50%" y="50%" font-family="Helvetica, Arial, sans-serif" font-size="52" fill="#ffffff" text-anchor="middle">
    ${escapeXml(text)}
  </text>
</svg>`;
  console.log(`[10D][TEXTIMG][${jobId}] Creating placeholder PNG: ${outPng}`);
  const buffer = Buffer.from(svg);
  ensureDir(path.dirname(outPng));
  await sharp(buffer).png().toFile(outPng);
  if (!isValidFile(outPng, jobId)) {
    throw new Error('[10D][TEXTIMG][ERR] Placeholder PNG invalid: ' + outPng);
  }
  return outPng;
}
function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ------------------------------------------------------------
// Make Ken Burns video from local image (PAN ONLY, NO ZOOM)
// ------------------------------------------------------------
async function makeKenBurnsVideoFromImage(imgPath, outPath, duration = 5, jobId = '') {
  const direction = Math.random() > 0.5 ? 'ltr' : 'rtl';
  console.log(`[10D][KENBURNS][${jobId}] Creating pan video (${direction}, NO ZOOM) | ${imgPath} → ${outPath} (${duration}s)`);

  if (!fs.existsSync(imgPath)) throw new Error('[10D][KENBURNS][ERR] Image does not exist: ' + imgPath);
  ensureDir(path.dirname(outPath));

  const width = 1080, height = 1920;

  // Pan only (NO ZOOM) — use crop after pad, with time-based x movement
  const panExpr = direction === 'ltr'
    ? `crop=${width}:${height}:x='(iw-${width})*t/${Math.max(duration, 0.001)}':y='(ih-${height})/2'`
    : `crop=${width}:${height}:x='(iw-${width})-(iw-${width})*t/${Math.max(duration, 0.001)}':y='(ih-${height})/2'`;

  // Single stream chain → use -vf (NOT -filter_complex) so we don’t need -map
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `setsar=1`,
    `${panExpr}`,
    `setpts=PTS-STARTPTS`
  ].join(',');

  const ffmpegCmd =
    `ffmpeg -y -loop 1 -i "${imgPath}" -vf "${filter}" ` +
    `-t ${duration} -r 30 -pix_fmt yuv420p -c:v libx264 -preset ultrafast "${outPath}"`;

  console.log(`[10D][KENBURNS][${jobId}] Running FFmpeg: ${ffmpegCmd}`);

  return new Promise((resolve, reject) => {
    const child = exec(ffmpegCmd, { timeout: 25000 }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          console.error(`[10D][KENBURNS][TIMEOUT][${jobId}] FFmpeg timed out after 25s!`, error);
        } else {
          console.error('[10D][KENBURNS][ERR]', error, stderr);
        }
        return reject(error);
      }
      if (!isValidFile(outPath, jobId)) {
        return reject(new Error('[10D][KENBURNS][ERR] Output video not created or too small'));
      }
      console.log(`[10D][KENBURNS][${jobId}] Ken Burns pan video created:`, outPath);
      resolve(outPath);
    });

    child.on('error', (err) => {
      console.error('[10D][KENBURNS][ERR][PROC]', err);
      reject(err);
    });
  });
}

// ------------------------------------------------------------
// Emergency fallback: static image → video (never fails if ffmpeg ok)
// ------------------------------------------------------------
async function staticImageToVideo(imgPath, outPath, duration = 5, jobId = '') {
  const width = 1080, height = 1920;
  ensureDir(path.dirname(outPath));
  const ffmpegCmd =
    `ffmpeg -y -loop 1 -i "${imgPath}" ` +
    `-vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS" ` +
    `-t ${duration} -r 30 -pix_fmt yuv420p -c:v libx264 -preset ultrafast "${outPath}"`;
  console.log(`[10D][STATICIMG][${jobId}] Running fallback FFmpeg: ${ffmpegCmd}`);
  return new Promise((resolve, reject) => {
    exec(ffmpegCmd, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[10D][STATICIMG][ERR][${jobId}] Fallback static image to video failed.`, error, stderr);
        return reject(error);
      }
      if (!isValidFile(outPath, jobId)) {
        return reject(new Error('[10D][STATICIMG][ERR] Output video not created or too small'));
      }
      console.log(`[10D][STATICIMG][${jobId}] Static image video created:`, outPath);
      resolve(outPath);
    });
  });
}

// ------------------------------------------------------------
// Generate a placeholder Ken Burns clip (no external APIs)
// ------------------------------------------------------------
async function generatePlaceholderKenBurns(subject, workDir, sceneIdx, jobId) {
  try {
    const dir = ensureDir(workDir || path.join(__dirname, 'tmp'));
    const safe = safeName(subject || 'no-visual');
    const png = path.join(dir, `kb_placeholder_${safe}_${String(sceneIdx).padStart(2, '0')}.png`);
    const mp4 = path.join(dir, `kb_placeholder_${safe}_${String(sceneIdx).padStart(2, '0')}.mp4`);

    await buildTextImage(subject, png, jobId);
    // Try pan video; if it fails, fall back to static
    try {
      await makeKenBurnsVideoFromImage(png, mp4, 5, jobId);
      console.log(`[10D][PLACEHOLDER][${jobId}] Placeholder Ken Burns created: ${mp4}`);
      return mp4;
    } catch (e) {
      console.warn(`[10D][PLACEHOLDER][WARN][${jobId}] Pan failed, using static image video.`, e);
      await staticImageToVideo(png, mp4, 5, jobId);
      console.log(`[10D][PLACEHOLDER][${jobId}] Placeholder static video created: ${mp4}`);
      return mp4;
    }
  } catch (err) {
    console.error(`[10D][PLACEHOLDER][ERR][${jobId}] Could not create placeholder video`, err);
    return null;
  }
}

// ------------------------------------------------------------
// Main entry: fallback to Ken Burns if no video found
// Always tries sources; if none work, builds placeholder.
// Returns a valid local MP4 path or null (only on catastrophic failure).
// ------------------------------------------------------------
async function fallbackKenBurnsVideo(subject, workDir, sceneIdx, jobId, usedClips = []) {
  try {
    // Accept subject as object/array/string
    const logSubject = (typeof subject === 'object' && subject?.subject) ? subject.subject : subject;
    console.log(`[10D][FALLBACK][${jobId}] Attempting Ken Burns fallback for "${logSubject}" | workDir="${workDir}" | sceneIdx=${sceneIdx}`);

    const tmpDir = ensureDir(workDir || path.join(__dirname, 'tmp'));
    const candidates = [];

    // Search order: Unsplash → Pexels → Pixabay
    if (UNSPLASH_ACCESS_KEY) {
      const url = await findImageInUnsplash(logSubject, usedClips);
      if (url) candidates.push({ api: 'minimal', url });
    }
    if (PEXELS_API_KEY) {
      const url = await findImageInPexels(logSubject, usedClips);
      if (url) candidates.push({ api: 'minimal', url });
    }
    if (PIXABAY_API_KEY) {
      const url = await findImageInPixabay(logSubject, usedClips);
      if (url) candidates.push({ api: 'minimal', url });
    }

    // If we have at least one image, build pan video from the best
    if (candidates.length) {
      for (const c of candidates) {
        // Minimal scoring pass (url/api only) still benefits from subject landmark boosts
        c.score = scoreImage({ ...c, api: 'minimal' }, logSubject, usedClips);
      }
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      console.log(`[10D][FALLBACK][${jobId}] Using image: ${best.url} (score: ${best.score})`);

      const rawImg = path.join(tmpDir, `kb_raw_${uuidv4()}.jpg`);
      await downloadRemoteFileToLocal(best.url, rawImg, jobId);

      const prepped = path.join(tmpDir, `kb_pre_${uuidv4()}.jpg`);
      await preprocessImageToJpeg(rawImg, prepped, jobId);

      const outVid = path.join(tmpDir, `kb_${uuidv4()}.mp4`);
      try {
        await makeKenBurnsVideoFromImage(prepped, outVid, 5, jobId);
        console.log(`[10D][FALLBACK][${jobId}] Ken Burns fallback video created: ${outVid}`);
        return outVid;
      } catch (err) {
        console.error(`[10D][FALLBACK][ERR][${jobId}] Ken Burns pan failed, trying static image video.`, err);
        try {
          await staticImageToVideo(prepped, outVid, 5, jobId);
          console.log(`[10D][FALLBACK][${jobId}] Static image fallback video created: ${outVid}`);
          return outVid;
        } catch (staticErr) {
          console.error(`[10D][FALLBACK][ERR][${jobId}] Static image video failed as well.`, staticErr);
          // Fall through to placeholder
        }
      }
    }

    // No candidates or all processing failed → generate placeholder
    console.warn(`[10D][FALLBACK][${jobId}] No suitable images. Generating placeholder for "${logSubject}"`);
    const placeholder = await generatePlaceholderKenBurns(logSubject, tmpDir, sceneIdx, jobId);
    if (placeholder && isValidFile(placeholder, jobId)) return placeholder;

    // Catastrophic fail (should be extremely rare)
    console.error(`[10D][FALLBACK][FATAL][${jobId}] Could not create any fallback video for "${logSubject}".`);
    return null;
  } catch (err) {
    console.error(`[10D][FALLBACK][ERR][${jobId}] Unexpected failure`, err);
    return null;
  }
}

// ------------------------------------------------------------
// Exports
// ------------------------------------------------------------
module.exports = {
  // Main
  fallbackKenBurnsVideo,
  generatePlaceholderKenBurns,

  // Building blocks (used elsewhere / tests)
  findImageInPexels,
  findImageInPixabay,
  findImageInUnsplash,
  downloadRemoteFileToLocal,
  makeKenBurnsVideoFromImage,
  staticImageToVideo,
  preprocessImageToJpeg,
  buildTextImage,
};
