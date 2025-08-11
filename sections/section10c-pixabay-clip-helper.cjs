// ===========================================================
// SECTION 10C: PIXABAY CLIP HELPER (Video + Photo Search & Download)
// Exports:
//   - findPixabayClipForScene(subject, workDir, sceneIdx, jobId, usedClips)  // usedClips ignored here
//   - findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips) // usedClips ignored here
// Bulletproof: tries options, logs every step, no silent fails
// NOTE: Images are fallback-tier; 5D should prefer video over photos.
// NOTE: Used-clip filtering is REMOVED here. 5D enforces within-job de-dupe.
// ===========================================================

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');

console.log('[10C][INIT] Pixabay helper (video + photo) loaded. [ALLOW][USED] No duplicate filtering here; 5D handles within-job de-dupe.');

const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
if (!PIXABAY_API_KEY) {
  console.error('[10C][FATAL] Missing PIXABAY_API_KEY in environment!');
}

// Env floor to force photo/other source fallback when videos are weak
const PIXABAY_MIN_SCORE = Number(process.env.SS_PIXABAY_MIN_SCORE || 28);

// --- Normalization helpers ---
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
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function majorWords(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
}
function fuzzyMatch(text, subject) {
  const txt = normalize(text);
  const words = majorWords(subject);
  return words.length && words.every(word => txt.includes(word));
}
function partialMatch(text, subject) {
  const txt = normalize(text);
  const words = majorWords(subject);
  return words.some(word => txt.includes(word));
}
function strictSubjectPresent(text, subject) {
  const subjectWords = getKeywords(subject);
  if (!subjectWords.length) return false;
  return subjectWords.every(w => text.includes(w));
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
  return null; // no special gate
}
function gatePenalty(fields, subject) {
  const gate = getSpeciesGate(subject);
  if (!gate) return 0;
  const low = fields.toLowerCase();
  if (gate.exclude.some(tok => low.includes(tok))) return -1000;
  if (!gate.include.some(tok => low.includes(tok))) return -250;
  return 0;
}

// --- File validation ---
function isValidFile(filePath, jobId) {
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

// --- Downloaders (ROBUST) ---
async function downloadStreamToLocal(url, outPath, jobId, kind = 'Video') {
  const tmp = `${outPath}.part`;
  try {
    console.log(`[10C][DL][${jobId}] Downloading ${kind}: ${url} -> ${outPath}`);
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

    // Content-length guard (when provided)
    if (expected && written !== expected) {
      console.warn(`[10C][DL][${jobId}] Incomplete download: wrote ${written} of ${expected} bytes.`);
      try { fs.unlinkSync(tmp); } catch (_) {}
      return null;
    }

    // Minimum sanity bytes
    const minBytes = kind === 'Video' ? 256 * 1024 : 16 * 1024;
    if (written < minBytes) {
      console.warn(`[10C][DL][${jobId}] ${kind} too small (${written} bytes).`);
      try { fs.unlinkSync(tmp); } catch (_) {}
      return null;
    }

    // Atomic rename
    fs.renameSync(tmp, outPath);

    // ffprobe validation for videos
    if (kind === 'Video') {
      const ok = await ffprobeHasVideoStream(outPath);
      if (!ok) {
        console.warn(`[10C][DL][${jobId}] ffprobe found NO video stream. Deleting ${outPath}.`);
        try { fs.unlinkSync(outPath); } catch (_) {}
        return null;
      }
    }

    // Final sanity check
    if (!isValidFile(outPath, jobId)) {
      console.warn(`[10C][DL][${jobId}] Downloaded ${kind.toLowerCase()} invalid/broken: ${outPath}`);
      return null;
    }

    console.log(`[10C][DL][${jobId}] ${kind} saved to: ${outPath} (${written} bytes)`);
    return outPath;
  } catch (err) {
    console.error('[10C][DL][ERR]', err?.message || err);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }
}

// --- Scoring (video): choose best inside Pixabay; 5D/10G does global ranking ---
function scorePixabayMatch(hit, variant, subject) {
  // hit: a single item from hits[]; variant: one of hit.videos.{large,medium,small,tiny}
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);

  const fields = [
    (hit?.tags || ''),         // comma-separated tags
    (hit?.user || ''),         // uploader
    (hit?.pageURL || ''),      // page
    (variant?.url || ''),      // variant url
  ].join(' ').toLowerCase();

  // STRONG: All words present
  if (strictSubjectPresent(fields, subject)) score += 40;
  // FUZZY: All major words in any order
  if (fuzzyMatch(fields, subject)) score += 25;
  // PARTIAL: Any major word present
  if (partialMatch(fields, subject)) score += 10;
  // PHRASE match bonus
  if (fields.includes(cleanedSubject) && cleanedSubject.length > 2) score += 12;

  // Each individual keyword present
  subjectWords.forEach(word => {
    if (fields.includes(word)) score += 3;
  });

  // Dimensions / aspect (prefer portrait, then 16:9)
  const w = Number(variant?.width || 0);
  const h = Number(variant?.height || 0);
  if (h > w) score += 11;
  if (w && h) {
    const ar = w / h;
    if (ar > 1.4 && ar < 2.0) score += 5;
    if (h / w > 1.7 && h / w < 2.1) score += 6;
  }

  // Video quality/length proxies
  score += h >= 720 ? 2 : 0;
  score += Math.floor(w / 120);

  // Small length penalty if duration exists
  if (typeof hit?.duration === 'number' && hit.duration < 4) score -= 6;

  // Engagement hints (if present)
  if (typeof hit?.likes === 'number') score += Math.min(5, Math.floor(hit.likes / 200));
  if (typeof hit?.views === 'number') score += Math.min(5, Math.floor(hit.views / 5000));

  // Species gate penalty/blocks
  score += gatePenalty(fields, subject);

  return score;
}

// --- Scoring (photo) ---
function scorePixabayPhotoMatch(hit, subject) {
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);

  const fields = [
    (hit?.tags || ''),
    (hit?.user || ''),
    (hit?.pageURL || ''),
    (hit?.largeImageURL || ''),
    (hit?.webformatURL || '')
  ].join(' ').toLowerCase();

  // Text relevance
  if (strictSubjectPresent(fields, subject)) score += 28;
  if (fuzzyMatch(fields, subject)) score += 16;
  if (partialMatch(fields, subject)) score += 6;
  if (fields.includes(cleanedSubject) && cleanedSubject.length > 2) score += 8;
  subjectWords.forEach(w => { if (fields.includes(w)) score += 2; });

  // Prefer portrait-ish images (better for 9:16)
  const w = Number(hit?.imageWidth || 0);
  const h = Number(hit?.imageHeight || 0);
  if (h > w) score += 10;
  if (h >= 1280) score += 4;

  // Species gate penalty/blocks
  score += gatePenalty(fields, subject);

  return score;
}

/**
 * Finds and downloads the best Pixabay VIDEO for a given subject/scene.
 * Returns a local .mp4 path or null.
 * NOTE: This helper does NOT filter duplicates. 5D enforces within-job de-dupe.
 */
async function findPixabayClipForScene(subject, workDir, sceneIdx, jobId /*, usedClips */) {
  console.log(`[10C][PIXABAY][${jobId}] findPixabayClipForScene | subject="${subject}" | sceneIdx=${sceneIdx}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No Pixabay API key set!');
    return null;
  }

  try {
    const query = encodeURIComponent(cleanQuery(subject));
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=10&safesearch=true`;
    console.log(`[10C][PIXABAY][${jobId}] Searching: ${url}`);
    const resp = await axios.get(url, { timeout: 20000 });

    const hits = Array.isArray(resp?.data?.hits) ? resp.data.hits : [];
    if (!hits.length) {
      console.log(`[10C][PIXABAY][${jobId}] No video results for "${subject}"`);
      return null;
    }

    // Build scored candidates
    const scored = [];
    for (const hit of hits) {
      const videos = hit?.videos || {};
      const variants = ['large', 'medium', 'small', 'tiny']
        .map(k => ({ key: k, ...videos[k] }))
        .filter(v => v && v.url);

      for (const v of variants) {
        const score = scorePixabayMatch(hit, v, subject);
        scored.push({ hit, variant: v, score });
      }
    }

    if (!scored.length) {
      console.warn(`[10C][PIXABAY][${jobId}] No suitable Pixabay video candidates after scoring.`);
      return null;
    }

    // Sort high to low, log top
    scored.sort((a, b) => b.score - a.score);
    scored.slice(0, 7).forEach((s, i) => {
      console.log(`[10C][PIXABAY][${jobId}][CANDIDATE][${i + 1}] ${s.variant.url} | score=${s.score} | size=${s.variant.width}x${s.variant.height}`);
    });

    const best = scored[0];

    // Enforce floor to allow fallback when videos are weak
    if (typeof best.score === 'number' && best.score < PIXABAY_MIN_SCORE) {
      console.warn(`[10C][PIXABAY][${jobId}][FLOOR] Best video score ${best.score} < floor ${PIXABAY_MIN_SCORE}. Returning null to trigger photo/other source.`);
      return null;
    }
    
    console.log(`[10C][PIXABAY][${jobId}][PICKED] Video: ${best.variant.url} | score=${best.score}`);
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${uuidv4()}.mp4`);
    const resultPath = await downloadStreamToLocal(best.variant.url, outPath, jobId, 'Video');
    if (resultPath) return resultPath;

    console.warn(`[10C][PIXABAY][${jobId}] Download failed for best video; trying next best...`);
    // Try next best if available (and still above floor)
    for (const cand of scored.slice(1)) {
      if (cand.score < PIXABAY_MIN_SCORE) {
        console.warn(`[10C][PIXABAY][${jobId}][FLOOR] Skipping candidate below floor: ${cand.score}`);
        continue;
      }
      const altOut = path.join(workDir, `scene${sceneIdx + 1}-pixabay-${uuidv4()}.mp4`);
      const altRes = await downloadStreamToLocal(cand.variant.url, altOut, jobId, 'Video');
      if (altRes) return altRes;
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
 * Finds and downloads the best Pixabay PHOTO for a given subject/scene.
 * Returns a local image path (.jpg/.jpeg/.png) or null.
 * Photos are fallback-tier; 5D should prefer videos first.
 * NOTE: This helper does NOT filter duplicates. 5D enforces within-job de-dupe.
 */
async function findPixabayPhotoForScene(subject, workDir, sceneIdx, jobId /*, usedClips */) {
  console.log(`[10C][PIXABAY][${jobId}] findPixabayPhotoForScene | subject="${subject}" | sceneIdx=${sceneIdx}`);

  if (!PIXABAY_API_KEY) {
    console.error('[10C][PIXABAY][ERR] No Pixabay API key set!');
    return null;
  }

  try {
    const query = encodeURIComponent(cleanQuery(subject));
    const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query}&image_type=photo&orientation=vertical&per_page=20&safesearch=true`;
    console.log(`[10C][PIXABAY][${jobId}] Searching photos: ${url}`);
    const resp = await axios.get(url, { timeout: 20000 });

    const hits = Array.isArray(resp?.data?.hits) ? resp.data.hits : [];
    if (!hits.length) {
      console.log(`[10C][PIXABAY][${jobId}] No photo results for "${subject}"`);
      return null;
    }

    // Score photos locally
    const scored = [];
    for (const hit of hits) {
      const src =
        hit?.largeImageURL ||
        hit?.webformatURL ||
        hit?.previewURL ||
        '';
      if (!src) continue;

      scored.push({ hit, src, score: scorePixabayPhotoMatch(hit, subject) });
    }

    if (!scored.length) {
      console.warn(`[10C][PIXABAY][${jobId}] No suitable Pixabay photo candidates after scoring.`);
      return null;
    }

    scored.sort((a, b) => b.score - a.score);
    scored.slice(0, 7).forEach((s, i) => {
      console.log(`[10C][PIXABAY][${jobId}][PHOTO][CANDIDATE][${i + 1}] ${s.src} | score=${s.score} | size=${s.hit?.imageWidth}x${s.hit?.imageHeight}`);
    });

    const best = scored[0];
    if (!best) {
      console.warn(`[10C][PIXABAY][${jobId}] No suitable photo candidates chosen.`);
      return null;
    }

    const extGuess = (best.src.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
    const safeExt = ['jpg','jpeg','png','webp'].includes(extGuess) ? extGuess : 'jpg';
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-pixabay-photo-${uuidv4()}.${safeExt}`);

    const saved = await downloadStreamToLocal(best.src, outPath, jobId, 'Photo');
    if (saved) return saved;

    // Try next best if download failed
    for (const cand of scored.slice(1)) {
      const altSrc =
        cand?.src ||
        cand?.hit?.largeImageURL ||
        cand?.hit?.webformatURL ||
        cand?.hit?.previewURL ||
        '';
      if (!altSrc) continue;

      const altExtGuess = (altSrc.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
      const altSafeExt = ['jpg','jpeg','png','webp'].includes(altExtGuess) ? altExtGuess : 'jpg';
      const altOut = path.join(workDir, `scene${sceneIdx + 1}-pixabay-photo-${uuidv4()}.${altSafeExt}`);
      const altSaved = await downloadStreamToLocal(altSrc, altOut, jobId, 'Photo');
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
