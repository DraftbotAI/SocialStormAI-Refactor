// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER (Video + Photo)
// Finds and downloads best-matching video (and photo) from Pixabay API
// MAX LOGGING EVERY STEP, Modular System Compatible
// Bulletproof: unique files, dedupe, valid output, crash-proof
// 2024-08: Scoring with strict/fuzzy/partial keyword filter, no skips
// NOTE: Photos are fallback-tier; videos remain priority (scored higher in 5D/10G).
// ===========================================================

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');

console.log('[10C][INIT] Pixabay clip helper loaded.');

const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
if (!PIXABAY_API_KEY) {
  console.error('[10C][FATAL] Missing PIXABAY_API_KEY in environment!');
}

// New: env floor to force photo/other source fallback when videos are weak
const PIXABAY_MIN_SCORE = Number(process.env.SS_PIXABAY_MIN_SCORE || 28);

// --- Utility: Query normalization & keyword helpers ---
function cleanQuery(str) {
  if (!str) return '';
  return str.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
}
function getKeywords(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s\-]+/)
    .filter(w => w.length > 2);
}
function majorWords(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
}
function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Match helpers (handles underscores, loose matches, etc) ---
function strictSubjectMatchPixabay(filename, subject) {
  if (!filename || !subject) return false;
  const safeSubject = cleanQuery(subject).replace(/\s+/g, '_');
  const re = new RegExp(`(^|_|-)${safeSubject}(_|-|\\.|$)`, 'i');
  return re.test(filename.replace(/ /g, '_'));
}
function fuzzyMatchPixabay(filename, subject) {
  if (!filename || !subject) return false;
  const fn = normalizeForMatch(filename);
  const words = majorWords(subject);
  return words.length && words.every(word => fn.includes(word));
}
function partialMatchPixabay(filename, subject) {
  if (!filename || !subject) return false;
  const fn = normalizeForMatch(filename);
  const words = majorWords(subject);
  return words.some(word => fn.includes(word));
}

// --- Species gate (minimal, subject-aware) ---
function getSpeciesGate(subject) {
  const s = String(subject || '').toLowerCase();
  if (s.includes('manatee') || s.includes('sea cow')) {
    return {
      include: ['manatee','sea cow','west indian manatee','trichechus'],
      exclude: [
        'gorilla','monkey','primate','dolphin','porpoise','whale','orca','shark',
        'octopus','squid','ray','stingray','seal','sea lion','owl','bird','cat','kitten','dog','puppy'
      ],
    };
  }
  return null;
}
function gatePenalty(fields, subject) {
  const gate = getSpeciesGate(subject);
  if (!gate) return 0;
  const low = fields.toLowerCase();
  if (gate.exclude.some(tok => low.includes(tok))) return -1000;
  if (!gate.include.some(tok => low.includes(tok))) return -250;
  return 0;
}

// --- File validation (works for video or image streams) ---
function isValidClip(filePath, jobId) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[10C][DL][${jobId}] File does not exist: ${filePath}`);
      return false;
    }
    const size = fs.statSync(filePath).size;
    if (size < 2048) {
      console.warn(`[10C][DL][${jobId}] File too small or broken: ${filePath} (${size} bytes)`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[10C][DL][${jobId}] File validation error:`, err);
    return false;
  }
}

// --- ffprobe helper (video validation) ---
function ffprobeHasVideoStream(p) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height','-of','csv=p=0', p],
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(Boolean(String(stdout || '').trim()));
      }
    );
  });
}

// --- Download video from Pixabay to local file (ROBUST) ---
async function downloadPixabayVideoToLocal(url, outPath, jobId) {
  const tmp = `${outPath}.part`;
  try {
    console.log(`[10C][DL][${jobId}] Downloading Pixabay video: ${url} -> ${outPath}`);
    const response = await axios.get(url, { responseType: 'stream', timeout: 20000, maxRedirects: 5 });

    const expected = Number(response.headers['content-length'] || 0);
    let written = 0;

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      response.data.on('data', (chunk) => { written += chunk.length; });
      response.data.on('error', reject);
      ws.on('error', reject);
      response.data.pipe(ws);
      ws.on('finish', resolve);
    });

    if (expected && written !== expected) {
      console.warn(`[10C][DL][${jobId}] Incomplete video download: wrote ${written} of ${expected} bytes.`);
      try { fs.unlinkSync(tmp); } catch (_) {}
      return null;
    }

    const minBytes = 256 * 1024;
    if (written < minBytes) {
      console.warn(`[10C][DL][${jobId}] Video too small (${written} bytes).`);
      try { fs.unlinkSync(tmp); } catch (_) {}
      return null;
    }

    fs.renameSync(tmp, outPath);

    const ok = await ffprobeHasVideoStream(outPath);
    if (!ok) {
      console.warn(`[10C][DL][${jobId}] ffprobe found NO video stream. Deleting ${outPath}.`);
      try { fs.unlinkSync(outPath); } catch (_) {}
      return null;
    }

    if (!isValidClip(outPath, jobId)) {
      console.warn(`[10C][DL][${jobId}] Downloaded file is invalid/broken: ${outPath}`);
      return null;
    }

    console.log(`[10C][DL][${jobId}] Video saved to: ${outPath} (${written} bytes)`);
    return outPath;
  } catch (err) {
    console.error('[10C][DL][ERR]', err);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }
}

// --- Download image from Pixabay to local file (ROBUST) ---
async function downloadPixabayImageToLocal(url, outPath, jobId) {
  const tmp = `${outPath}.part`;
  try {
    console.log(`[10C][DL][${jobId}] Downloading Pixabay image: ${url} -> ${outPath}`);
    const response = await axios.get(url, { responseType: 'stream', timeout: 20000, maxRedirects: 5 });

    const expected = Number(response.headers['content-length'] || 0);
    let written = 0;

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      response.data.on('data', (chunk) => { written += chunk.length; });
      response.data.on('error', reject);
      ws.on('error', reject);
      response.data.pipe(ws);
      ws.on('finish', resolve);
    });

    if (expected && written !== expected) {
      console.warn(`[10C][DL][${jobId}] Incomplete image download: wrote ${written} of ${expected} bytes.`);
      try { fs.unlinkSync(tmp); } catch (_) {}
      return null;
    }

    const minBytes = 16 * 1024;
    if (written < minBytes) {
      console.warn(`[10C][DL][${jobId}] Image too small (${written} bytes).`);
      try { fs.unlinkSync(tmp); } catch (_) {}
      return null;
    }

    fs.renameSync(tmp, outPath);

    if (!isValidClip(outPath, jobId)) {
      console.warn(`[10C][DL][${jobId}] Downloaded image invalid/broken: ${outPath}`);
      return null;
    }

    console.log(`[10C][DL][${jobId}] Image saved to: ${outPath} (${written} bytes)`);
    return outPath;
  } catch (err) {
    console.error('[10C][DL][ERR]', err);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }
}

// --- Scoring (strict > fuzzy > partial > fallback) ---
function scorePixabayMatch(hit, vid, subject, usedClips = []) {
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);
  const filename = (vid.url || '').split('/').pop();

  // Score subject in filename (strict > fuzzy > partial)
  if (strictSubjectMatchPixabay(filename, subject)) score += 90;
  else if (fuzzyMatchPixabay(filename, subject)) score += 28;
  else if (partialMatchPixabay(filename, subject)) score += 14;

  // Metadata keyword/phrase
  const fields = [
    ...(hit.tags ? hit.tags.split(',').map(t => t.trim()) : []),
    hit.user || '',
    hit.pageURL || '',
    vid.url || ''
  ].join(' ').toLowerCase();

  if (fields.includes(cleanedSubject) && cleanedSubject.length > 2) score += 45;
  if (subjectWords.every(w => fields.includes(w)) && subjectWords.length > 1) score += 25;
  subjectWords.forEach(word => { if (fields.includes(word)) score += 5; });

  // Aspect/size
  if (vid.height > vid.width) score += 8; // Portrait
  if (vid.width > vid.height) score += 6; // Landscape
  if (vid.height >= 720) score += 7;
  score += Math.floor(vid.width / 120);

  // Penalize used/duplicate
  if (usedClips && usedClips.some(u => vid.url && (u.includes(vid.url) || vid.url.includes(u)))) score -= 100;

  // Penalize very short
  if (hit.duration && hit.duration < 4) score -= 8;
  if (hit.id && Number(hit.id) > 1000000) score += 2;

  // Bonus: shorter filename, newer id, better match
  score -= filename.length;

  // Species gate penalty/blocks
  score += gatePenalty(
    [
      ...(hit.tags ? hit.tags.split(',').map(t => t.trim()) : []),
      hit.user || '', hit.pageURL || '', vid.url || ''
    ].join(' '),
    subject
  );

  return score;
}

// --- Scoring for PHOTOS (local ranking only; videos remain priority in 5D) ---
function scorePixabayPhotoMatch(hit, subject, usedClips = []) {
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);

  const fields = [
    hit.tags || '',
    hit.user || '',
    hit.pageURL || '',
    hit.largeImageURL || hit.webformatURL || hit.previewURL || ''
  ].join(' ').toLowerCase();

  // Text relevance
  if (fields.includes(cleanedSubject) && cleanedSubject.length > 2) score += 24;
  if (subjectWords.every(w => fields.includes(w)) && subjectWords.length > 1) score += 14;
  subjectWords.forEach(w => { if (fields.includes(w)) score += 3; });

  // Prefer portrait-ish photos for 9:16
  const w = Number(hit.imageWidth || 0);
  const h = Number(hit.imageHeight || 0);
  if (h > w) score += 10;
  if (h >= 1280) score += 4;

  // De-dupe if remote src already used
  const src = hit.largeImageURL || hit.webformatURL || hit.previewURL || '';
  if (usedClips && usedClips.some(u => src && (u.includes(src) || src.includes(u)))) score -= 100;

  // Species gate penalty/blocks
  score += gatePenalty(fields, subject);

  return score;
}

/**
 * Finds and downloads best-scoring Pixabay video for a subject/scene.
 * All normalization, strict/fuzzy/partial, deduping, logging, crash-proof.
 * @param {string} subject         Main scene subject (clean, descriptive)
 * @param {string} workDir         Local job folder for saving video
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {Array<string>} usedClips Paths/URLs already used
 * @returns {Promise<string|null>} Local .mp4 path, or null
 */
async function findPixabayClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  console.log(`[10C][PIXABAY][${jobId}] findPixabayClipForScene | subject="${subject}" | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No Pixabay API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(cleanQuery(subject)).slice(0, 100);
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=10&safesearch=true`;
    console.log(`[10C][PIXABAY][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url);

    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      let scored = [];
      for (const hit of resp.data.hits) {
        const videoCandidates = Object.values(hit.videos || {});
        for (const vid of videoCandidates) {
          if (!vid?.url) continue;
          const score = scorePixabayMatch(hit, vid, subject, usedClips);
          scored.push({ hit, vid, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 7).forEach((s, i) =>
        console.log(`[10C][PIXABAY][${jobId}][CANDIDATE][${i + 1}] ${s.vid.url} | score=${s.score} | size=${s.vid.width}x${s.vid.height}`)
      );

      let best = scored[0];
      if (!best) {
        console.warn(`[10C][PIXABAY][${jobId}] No suitable Pixabay video candidates scored.`);
        return null;
      }

      // Enforce floor to allow fallback to photos/other sources
      if (typeof best.score === 'number' && best.score < PIXABAY_MIN_SCORE) {
        console.warn(`[10C][PIXABAY][${jobId}][FLOOR] Best video score ${best.score} < floor ${PIXABAY_MIN_SCORE}. Returning null to trigger photo/other source.`);
        return null;
      }

      console.log(`[10C][PIXABAY][${jobId}][PICKED] Selected: ${best.vid.url} | score=${best.score}`);
      const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${uuidv4()}.mp4`);
      const resultPath = await downloadPixabayVideoToLocal(best.vid.url, outPath, jobId);
      if (resultPath) return resultPath;

      // If download fails, try remaining candidates (respect floor)
      for (const cand of scored.slice(1)) {
        if (cand.score < PIXABAY_MIN_SCORE) {
          console.warn(`[10C][PIXABAY][${jobId}][FLOOR] Skipping candidate below floor: ${cand.score}`);
          continue;
        }
        const altPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${uuidv4()}.mp4`);
        const altRes = await downloadPixabayVideoToLocal(cand.vid.url, altPath, jobId);
        if (altRes) return altRes;
      }
    } else {
      console.log(`[10C][PIXABAY][${jobId}] No Pixabay video results found for "${subject}"`);
    }
    return null;
  } catch (err) {
    if (err.response?.data) {
      console.error('[10C][PIXABAY][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10C][PIXABAY][ERR]', err);
    }
    return null;
  }
}

/**
 * Finds and downloads the best Pixabay PHOTO for a subject/scene.
 * Returns a local image path (.jpg/.jpeg/.png/.webp) or null.
 * NOTE: Photos are fallback; 5D should still prefer video.
 * @param {string} subject
 * @param {string} workDir
 * @param {number} sceneIdx
 * @param {string} jobId
 * @param {Array<string>} usedClips
 * @returns {Promise<string|null>}
 */
async function findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  console.log(`[10C][PIXABAY][${jobId}] findPixabayPhotoForScene | subject="${subject}" | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No Pixabay API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(cleanQuery(subject)).slice(0, 100);
    const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query}&image_type=photo&safesearch=true&per_page=24&orientation=vertical`;
    console.log(`[10C][PIXABAY][${jobId}] Searching photos: ${url}`);
    const resp = await axios.get(url);

    const hits = Array.isArray(resp?.data?.hits) ? resp.data.hits : [];
    if (hits.length === 0) {
      console.log(`[10C][PIXABAY][${jobId}] No Pixabay photo results for "${subject}"`);
      return null;
    }

    const scored = hits
      .map(h => ({ hit: h, score: scorePixabayPhotoMatch(h, subject, usedClips) }))
      .sort((a, b) => b.score - a.score);

    scored.slice(0, 7).forEach((s, i) => {
      const src = s.hit.largeImageURL || s.hit.webformatURL || s.hit.previewURL || 'n/a';
      console.log(`[10C][PIXABAY][${jobId}][PHOTO][CANDIDATE][${i + 1}] ${src} | score=${s.score} | size=${s.hit.imageWidth}x${s.hit.imageHeight}`);
    });

    const best = scored[0];
    if (!best || !best.hit) {
      console.warn(`[10C][PIXABAY][${jobId}] No suitable Pixabay photo candidates scored.`);
      return null;
    }

    const src =
      best.hit.largeImageURL ||
      best.hit.webformatURL ||
      best.hit.previewURL;

    if (!src) {
      console.warn(`[10C][PIXABAY][${jobId}] Best photo missing src URL.`);
      return null;
    }

    const extGuess = (src.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
    const safeExt = ['jpg','jpeg','png','webp'].includes(extGuess) ? extGuess : 'jpg';
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-photo-${uuidv4()}.${safeExt}`);

    const saved = await downloadPixabayImageToLocal(src, outPath, jobId);
    if (saved) return saved;

    // Try the next best if download failed
    for (const cand of scored.slice(1)) {
      const altSrc = cand.hit.largeImageURL || cand.hit.webformatURL || cand.hit.previewURL;
      if (!altSrc) continue;
      const altExtGuess = (altSrc.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
      const altSafeExt = ['jpg','jpeg','png','webp'].includes(altExtGuess) ? altExtGuess : 'jpg';
      const altOut = path.join(workDir, `scene${sceneIdx + 1}-pixabay-photo-${uuidv4()}.${altSafeExt}`);
      const altSaved = await downloadPixabayImageToLocal(altSrc, altOut, jobId);
      if (altSaved) return altSaved;
    }

    return null;
  } catch (err) {
    if (err.response?.data) {
      console.error('[10C][PIXABAY][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10C][PIXABAY][ERR]', err);
    }
    return null;
  }
}

module.exports = {
  findPixabayClipForScene,
  findPixabayPhotoForScene,
};
