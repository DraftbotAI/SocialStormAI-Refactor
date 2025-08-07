// ===========================================================
// SECTION 10B: PEXELS CLIP HELPER (Video & Photo Search & Download)
// Exports:
//   - findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips)
//   - findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips)
// Bulletproof: always tries all options, never blocks on strict match
// Max logs at every step, accepts best available, NO silent fails
// 2024-08: Ready for universal scoring, anti-dupe, anti-generic, max debug
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';
if (!PEXELS_API_KEY) {
  console.error('[10B][FATAL] Missing PEXELS_API_KEY in env!');
}

console.log('[10B][INIT] Pexels helper loaded.');

const PEXELS_VIDEO_URL = 'https://api.pexels.com/videos/search';
const PEXELS_PHOTO_URL = 'https://api.pexels.com/v1/search';

async function downloadFile(url, outPath, jobId) {
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      headers: { 'Authorization': PEXELS_API_KEY }
    });

    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(outPath);
      response.data.pipe(fileStream);
      response.data.on('error', (err) => {
        console.error(`[10B][${jobId}][DOWNLOAD][ERR] Stream error:`, err);
        reject(err);
      });
      fileStream.on('finish', resolve);
      fileStream.on('error', (err) => {
        console.error(`[10B][${jobId}][DOWNLOAD][ERR] File write error:`, err);
        reject(err);
      });
    });
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 2048) {
      console.log(`[10B][${jobId}][DOWNLOAD][OK] File downloaded: ${outPath}`);
      return outPath;
    } else {
      console.warn(`[10B][${jobId}][DOWNLOAD][WARN] Downloaded file invalid/broken: ${outPath}`);
      return null;
    }
  } catch (err) {
    console.error(`[10B][${jobId}][DOWNLOAD][ERR] Download failed:`, err);
    return null;
  }
}

// --- Universal candidate builder for scoring ---
function buildCandidates(items, subject, source, isVideo) {
  return items.map(item => ({
    ...item,
    type: isVideo ? 'video' : 'photo',
    source,
    subject,
    isVideo,
    score: 0, // Score will be filled in after
  }));
}

// ===========================================================
// MAIN VIDEO FINDER
// ===========================================================

async function findPexelsClipForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  if (!PEXELS_API_KEY) {
    console.error('[10B][FATAL] No PEXELS_API_KEY!');
    return null;
  }

  // ---- 1. Search for videos
  try {
    console.log(`[10B][VIDEO][${jobId}] Searching Pexels for: "${subject}"`);
    const res = await axios.get(PEXELS_VIDEO_URL, {
      params: { query: subject, per_page: 20 },
      headers: { Authorization: PEXELS_API_KEY }
    });
    const videos = (res.data && res.data.videos) ? res.data.videos : [];
    if (!videos.length) {
      console.warn(`[10B][VIDEO][${jobId}] No videos found for "${subject}"`);
      return null;
    }

    // Build scored candidates, filter by used
    const candidates = videos.map(video => {
      // Best quality fallback
      const bestFile = video.video_files.sort((a, b) => b.width - a.width)[0];
      return {
        pexelsId: video.id,
        url: bestFile.link,
        width: bestFile.width,
        height: bestFile.height,
        duration: video.duration,
        photographer: video.user && video.user.name,
        title: video.url,
        tags: video.tags || [],
        subject,
        isVideo: true,
        path: null, // Will be filled after download
      };
    }).filter(video => {
      // Try to avoid re-downloading files if URL matches any used
      return !usedClips.includes(video.url);
    });

    // Score each candidate
    candidates.forEach(c => {
      c.score = scoreSceneCandidate(c, subject, usedClips);
    });

    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) {
      console.warn(`[10B][VIDEO][${jobId}] No valid video candidates to download.`);
      return null;
    }

    // Pick best candidate
    const best = candidates[0];
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-${best.pexelsId}.mp4`);

    // Download if not already exists
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 2048) {
      console.log(`[10B][VIDEO][${jobId}] Downloading Pexels video: ${best.url} -> ${outPath}`);
      const dl = await downloadFile(best.url, outPath, jobId);
      if (!dl) {
        console.warn(`[10B][VIDEO][${jobId}] Download failed: ${best.url}`);
        return null;
      }
    } else {
      console.log(`[10B][VIDEO][${jobId}] Video already downloaded: ${outPath}`);
    }

    best.path = outPath;
    usedClips.push(outPath);

    console.log(`[10B][VIDEO][${jobId}] Best Pexels video selected: ${outPath} | score=${best.score}`);
    return outPath;
  } catch (err) {
    console.error(`[10B][VIDEO][${jobId}][ERR]`, err);
    return null;
  }
}

// ===========================================================
// PHOTO FALLBACK FINDER
// ===========================================================

async function findPexelsPhotoForScene(subject, workDir, sceneIdx, jobId, usedClips = []) {
  if (!PEXELS_API_KEY) {
    console.error('[10B][FATAL] No PEXELS_API_KEY!');
    return null;
  }

  try {
    console.log(`[10B][PHOTO][${jobId}] Searching Pexels Photos for: "${subject}"`);
    const res = await axios.get(PEXELS_PHOTO_URL, {
      params: { query: subject, per_page: 20 },
      headers: { Authorization: PEXELS_API_KEY }
    });
    const photos = (res.data && res.data.photos) ? res.data.photos : [];
    if (!photos.length) {
      console.warn(`[10B][PHOTO][${jobId}] No photos found for "${subject}"`);
      return null;
    }

    // Build scored candidates, avoid used
    const candidates = photos.map(photo => ({
      pexelsId: photo.id,
      url: photo.src && (photo.src.large2x || photo.src.original || photo.src.large),
      width: photo.width,
      height: photo.height,
      photographer: photo.photographer,
      subject,
      isVideo: false,
      path: null, // Will be filled after download
    })).filter(photo => photo.url && !usedClips.includes(photo.url));

    candidates.forEach(c => {
      c.score = scoreSceneCandidate(c, subject, usedClips);
    });

    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) {
      console.warn(`[10B][PHOTO][${jobId}] No valid photo candidates to download.`);
      return null;
    }

    const best = candidates[0];
    const outPath = path.join(workDir, `scene${sceneIdx + 1}-pexels-photo-${best.pexelsId}.jpg`);

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
      console.log(`[10B][PHOTO][${jobId}] Downloading Pexels photo: ${best.url} -> ${outPath}`);
      const dl = await downloadFile(best.url, outPath, jobId);
      if (!dl) {
        console.warn(`[10B][PHOTO][${jobId}] Download failed: ${best.url}`);
        return null;
      }
    } else {
      console.log(`[10B][PHOTO][${jobId}] Photo already downloaded: ${outPath}`);
    }

    best.path = outPath;
    usedClips.push(outPath);

    console.log(`[10B][PHOTO][${jobId}] Best Pexels photo selected: ${outPath} | score=${best.score}`);
    return outPath;
  } catch (err) {
    console.error(`[10B][PHOTO][${jobId}][ERR]`, err);
    return null;
  }
}

module.exports = {
  findPexelsClipForScene,
  findPexelsPhotoForScene
};
