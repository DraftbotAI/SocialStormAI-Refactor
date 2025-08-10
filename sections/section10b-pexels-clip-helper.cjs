// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER (Video + Photo Search & Download)
// Exports:
//   - findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips)  // usedClips ignored here
//   - findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips) // usedClips ignored here
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

console.log('[10B][INIT] Pexels helper (video + photo) loaded. [ALLOW][USED] No duplicate filtering here; 5D handles within-job de-dupe.');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_API_KEY) {
  console.error('[10B][FATAL] Missing PEXELS_API_KEY in environment!');
}

// Env floor to force photo/other source fallback when videos are weak
const PEXELS_MIN_SCORE = Number(process.env.SS_PEXELS_MIN_SCORE || 28);

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
      console.warn(`[10B][DL][${jobId}] File does not exist: ${filePath}`);
      return false;
    }
    const size = fs.statSync(filePath).size;
    if (size < 2048) {
      console.warn(`[10B][DL][${jobId}] File too small or broken: ${filePath} (${size} bytes)`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[10B][DL][${jobId}] File validation error:`, err);
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
    console.log(`[10B][DL][${jobId}] Downloading ${kind}: ${url} -> ${outPath}`);
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
      console.warn(`[10B][DL][${jobId}] Incomplete download: wrote ${written} of ${expected} bytes.`);
      try { fs.unlinkSync(tmp); } catch (_) {}
      return null;
    }

    // Minimum sanity bytes
    const minBytes = kind === 'Video' ? 256 * 1024 : 16 * 1024;
    if (written < minBytes) {
      console.warn(`[10B][DL][${jobId}] ${kind} too small (${written} bytes).`);
      try { fs.unlinkSync(tmp); } catch (_) {}
      return null;
    }

    // Atomic rename
    fs.renameSync(tmp, outPath);

    // ffprobe validation for videos
    if (kind === 'Video') {
      const ok = await ffprobeHasVideoStream(outPath);
      if (!ok) {
        console.warn(`[10B][DL][${jobId}] ffprobe found NO video stream. Deleting ${outPath}.`);
        try { fs.unlinkSync(outPath); } catch (_) {}
        return null;
      }
    }

    // Final sanity check
    if (!isValidFile(outPath, jobId)) {
      console.warn(`[10B][DL][${jobId}] Downloaded ${kind.toLowerCase()} invalid/broken: ${outPath}`);
      return null;
    }

    console.log(`[10B][DL][${jobId}] ${kind} saved to: ${outPath} (${written} bytes)`);
    return outPath;
  } catch (err) {
    console.error('[10B][DL][ERR]', err?.message || err);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }
}

// --- Scoring (video): choose best inside Pexels; 5D/10G does global ranking ---
function scorePexelsMatch(video, file, subject) {
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);

  const fields = [
    (video?.user?.name || ''),
    (video?.url || ''),
    (file?.link || ''),
    (file?.file_type || ''),
    ...(video?.tags ? video.tags.map(t => t.title || t) : []),
    (video?.description || ''),
    (video?.title || '')
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

  // Aspect ratio: prefer portrait (9:16), then 16:9
  if (file.height > file.width) score += 11;
  if (file.width / file.height > 1.4 && file.width / file.height < 2.0) score += 5;
  if (file.height / file.width > 1.7 && file.height / file.width < 2.1) score += 6;

  // Video quality/length
  score += file.height >= 720 ? 2 : 0;
  score += file.file_type === 'video/mp4' ? 2 : 0;
  score += Math.floor(file.width / 120);

  // Penalize very short clips
  if (video.duration && video.duration < 4) score -= 6;

  // Slight bonus for newer Pexels IDs
  if (video.id && Number(video.id) > 1000000) score += 2;

  // Species gate penalty/blocks
  score += gatePenalty(fields, subject);

  return score;
}

// --- Scoring (photo): used only to pick best inside photos; videos still have priority in 5D ---
function scorePexelsPhotoMatch(photo, subject) {
  let score = 0;
  const cleanedSubject = cleanQuery(subject).toLowerCase();
  const subjectWords = getKeywords(subject);

  const fields = [
    (photo?.alt || ''),
    (photo?.url || ''),
    (photo?.photographer || ''),
    ...(Array.isArray(photo?.tags) ? photo.tags : []),
  ].join(' ').toLowerCase();

  // Text relevance
  if (strictSubjectPresent(fields, subject)) score += 28;
  if (fuzzyMatch(fields, subject)) score += 16;
  if (partialMatch(fields, subject)) score += 6;
  if (fields.includes(cleanedSubject) && cleanedSubject.length > 2) score += 8;
  subjectWords.forEach(w => { if (fields.includes(w)) score += 2; });

  // Prefer portrait-ish images (better for 9:16)
  const w = Number(photo?.width || 0);
  const h = Number(photo?.height || 0);
  if (h > w) score += 10;
  if (h >= 1280) score += 4;

  // Species gate penalty/blocks
  score += gatePenalty(fields, subject);

  return score;
}

/**
 * Finds and downloads the best Pexels video for a given subject/scene.
 * Returns a local .mp4 path or null.
 * NOTE: This helper does NOT filter duplicates. 5D enforces within-job de-dupe.
 */
async function findPexelsClipForScene(subject, workDir, sceneIdx, jobId /*, usedClips */) {
  console.log(`[10B][PEXELS][${jobId}] findPexelsClipForScene | subject="${subject}" | sceneIdx=${sceneIdx}`);

  if (!PEXELS_API_KEY) {
    console.error('[10B][PEXELS][ERR] No Pexels API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(cleanQuery(subject));
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=12&orientation=portrait`;
    console.log(`[10B][PEXELS][${jobId}] Searching videos: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });

    if (resp.data && Array.isArray(resp.data.videos) && resp.data.videos.length > 0) {
      const scored = [];
      for (const video of resp.data.videos) {
        const files = (video.video_files || []).filter(f => f.file_type === 'video/mp4' && f.link);
        for (const file of files) {
          const score = scorePexelsMatch(video, file, subject);
          scored.push({ video, file, score });
        }
      }

      if (!scored.length) {
        console.warn(`[10B][PEXELS][${jobId}] No suitable Pexels video candidates after scoring.`);
        return null;
      }

      // Sort high to low, log top
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 7).forEach((s, i) => {
        console.log(`[10B][PEXELS][${jobId}][CANDIDATE][${i + 1}] ${s.file.link} | score=${s.score} | duration=${s.video.duration}s | size=${s.file.width}x${s.file.height}`);
      });

      const best = scored[0];

      // Enforce floor to allow fallback when videos are weak
      if (typeof best.score === 'number' && best.score < PEXELS_MIN_SCORE) {
        console.warn(`[10B][PEXELS][${jobId}][FLOOR] Best video score ${best.score} < floor ${PEXELS_MIN_SCORE}. Returning null to trigger photo/other source.`);
        return null;
      }

      console.log(`[10B][PEXELS][${jobId}][PICKED] Video: ${best.file.link} | score=${best.score}`);
      const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-${uuidv4()}.mp4`);
      const resultPath = await downloadStreamToLocal(best.file.link, outPath, jobId, 'Video');
      if (resultPath) return resultPath;

      console.warn(`[10B][PEXELS][${jobId}] Download failed for best video; trying next best...`);
      // Try next best if available (and still above floor)
      for (const cand of scored.slice(1)) {
        if (cand.score < PEXELS_MIN_SCORE) {
          console.warn(`[10B][PEXELS][${jobId}][FLOOR] Skipping candidate below floor: ${cand.score}`);
          continue;
        }
        const altOut = path.join(workDir, `scene${sceneIdx + 1}-pexels-${uuidv4()}.mp4`);
        const altRes = await downloadStreamToLocal(cand.file.link, altOut, jobId, 'Video');
        if (altRes) return altRes;
      }

      return null;
    } else {
      console.log(`[10B][PEXELS][${jobId}] No Pexels video results for "${subject}"`);
    }
    return null;
  } catch (err) {
    if (err.response?.data) {
      console.error('[10B][PEXELS][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10B][PEXELS][ERR]', err);
    }
    return null;
  }
}

/**
 * Finds and downloads the best Pexels PHOTO for a given subject/scene.
 * Returns a local image path (.jpg/.jpeg/.png) or null.
 * NOTE: Photos are fallback; 5D should score/choose video first.
 * NOTE: This helper does NOT filter duplicates. 5D enforces within-job de-dupe.
 */
async function findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId /*, usedClips */) {
  console.log(`[10B][PEXELS][${jobId}] findPexelsPhotoForScene | subject="${subject}" | sceneIdx=${sceneIdx}`);

  if (!PEXELS_API_KEY) {
    console.error('[10B][PEXELS][ERR] No Pexels API key set!');
    return null;
  }
  try {
    const query = encodeURIComponent(cleanQuery(subject));
    const url = `https://api.pexels.com/v1/search?query=${query}&per_page=20&orientation=portrait`;
    console.log(`[10B][PEXELS][${jobId}] Searching photos: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });

    const photos = Array.isArray(resp?.data?.photos) ? resp.data.photos : [];
    if (photos.length === 0) {
      console.log(`[10B][PEXELS][${jobId}] No Pexels photo results for "${subject}"`);
      return null;
    }

    // Score photos locally
    const scored = photos.map(p => ({
      photo: p,
      score: scorePexelsPhotoMatch(p, subject),
    }));

    if (!scored.length) {
      console.warn(`[10B][PEXELS][${jobId}] No suitable Pexels photo candidates after scoring.`);
      return null;
    }

    scored.sort((a, b) => b.score - a.score);
    scored.slice(0, 7).forEach((s, i) => {
      const src = s.photo?.src?.large2x || s.photo?.src?.large || s.photo?.src?.portrait || s.photo?.src?.original || s.photo?.src?.medium || 'n/a';
      console.log(`[10B][PEXELS][${jobId}][PHOTO][CANDIDATE][${i + 1}] ${src} | score=${s.score} | size=${s.photo?.width}x${s.photo?.height}`);
    });

    const best = scored[0];
    if (!best || !best.photo) {
      console.warn(`[10B][PEXELS][${jobId}] No suitable Pexels photo candidates chosen.`);
      return null;
    }

    const src =
      best.photo?.src?.large2x ||
      best.photo?.src?.large ||
      best.photo?.src?.portrait ||
      best.photo?.src?.original ||
      best.photo?.src?.medium;

    if (!src) {
      console.warn(`[10B][PEXELS][${jobId}] Best photo missing src URL.`);
      return null;
    }

    const extGuess = (src.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
    const safeExt = ['jpg','jpeg','png','webp'].includes(extGuess) ? extGuess : 'jpg';
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-photo-${uuidv4()}.${safeExt}`);

    const saved = await downloadStreamToLocal(src, outPath, jobId, 'Photo');
    if (saved) return saved;

    // Try the next best if download failed
    for (const cand of scored.slice(1)) {
      const altSrc =
        cand.photo?.src?.large2x ||
        cand.photo?.src?.large ||
        cand.photo?.src?.portrait ||
        cand.photo?.src?.original ||
        cand.photo?.src?.medium;
      if (!altSrc) continue;

      const altExtGuess = (altSrc.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
      const altSafeExt = ['jpg','jpeg','png','webp'].includes(altExtGuess) ? altExtGuess : 'jpg';
      const altOut = path.join(workDir, `scene${sceneIdx + 1}-pexels-photo-${uuidv4()}.${altSafeExt}`);
      const altSaved = await downloadStreamToLocal(altSrc, altOut, jobId, 'Photo');
      if (altSaved) return altSaved;
    }

    return null;
  } catch (err) {
    if (err.response?.data) {
      console.error('[10B][PEXELS][ERR]', JSON.stringify(err.response.data));
    } else {
      console.error('[10B][PEXELS][ERR]', err);
    }
    return null;
  }
}

module.exports = {
  findPexelsClipForScene,
  findPexelsPhotoForScene,
};
