// ===========================================================
// SECTION 10D: KEN BURNS IMAGE VIDEO HELPER
// Finds fallback still images, downloads them, creates slow-pan videos
// Used when no matching R2/Pexels/Pixabay video is found.
// MAX LOGGING EVERY STEP, Modular, Deduped, Validated
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

console.log('[10D][INIT] Ken Burns image video helper loaded.');

// --- Validate output file ---
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

// --- Find an image on Pexels ---
async function findImageInPexels(subject) {
  console.log(`[10D][PEXELS-IMG] Searching for still image | subject="${subject}"`);
  if (!PEXELS_API_KEY) {
    console.warn('[10D][PEXELS-IMG] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://api.pexels.com/v1/search?query=${query}&per_page=5`;
    console.log(`[10D][PEXELS-IMG] Request: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (resp.data && resp.data.photos && resp.data.photos.length > 0) {
      const best = resp.data.photos[0];
      console.log(`[10D][PEXELS-IMG] Found image: ${best.src.original}`);
      return best.src.original;
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

// --- Find an image on Pixabay ---
async function findImageInPixabay(subject) {
  console.log(`[10D][PIXABAY-IMG] Searching for still image | subject="${subject}"`);
  if (!PIXABAY_API_KEY) {
    console.warn('[10D][PIXABAY-IMG] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query}&image_type=photo&per_page=5`;
    console.log(`[10D][PIXABAY-IMG] Request: ${url}`);
    const resp = await axios.get(url);
    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      const best = resp.data.hits[0];
      if (best && best.largeImageURL) {
        console.log(`[10D][PIXABAY-IMG] Found image: ${best.largeImageURL}`);
        return best.largeImageURL;
      }
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

// --- Download remote image to local disk ---
async function downloadRemoteFileToLocal(url, outPath, jobId = '') {
  console.log(`[10D][DL][${jobId}] Downloading | url="${url}" | outPath="${outPath}"`);
  try {
    if (!url) throw new Error('No URL provided to download.');
    if (fs.existsSync(outPath)) {
      console.log(`[10D][DL][${jobId}] File already exists, skipping download: ${outPath}`);
      return;
    }

    const writer = fs.createWriteStream(outPath);
    const resp = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 60000
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

// --- Make Ken Burns video from local image ---
async function makeKenBurnsVideoFromImage(imgPath, outPath, duration = 5, jobId = '') {
  const direction = Math.random() > 0.5 ? 'ltr' : 'rtl';
  console.log(`[10D][KENBURNS][${jobId}] Creating pan video (${direction}) | ${imgPath} → ${outPath} (${duration}s)`);

  if (!fs.existsSync(imgPath)) throw new Error('[10D][KENBURNS][ERR] Image does not exist: ' + imgPath);

  const width = 1080, height = 1920;
  const filter = direction === 'ltr'
    ? `[0:v]scale=${width*1.4}:${height*1.4},crop=${width}:${height}:x='(iw-${width})*t/${duration}',setpts=PTS-STARTPTS[v]`
    : `[0:v]scale=${width*1.4}:${height*1.4},crop=${width}:${height}:x='(iw-${width})-(iw-${width})*t/${duration}',setpts=PTS-STARTPTS[v]`;

  const ffmpegCmd = `ffmpeg -y -loop 1 -i "${imgPath}" -filter_complex "${filter}" -map "[v]" -t ${duration} -r 30 -pix_fmt yuv420p -c:v libx264 "${outPath}"`;
  console.log(`[10D][KENBURNS][${jobId}] Running FFmpeg: ${ffmpegCmd}`);

  return new Promise((resolve, reject) => {
    exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        console.error('[10D][KENBURNS][ERR]', error, stderr);
        return reject(error);
      }
      if (!isValidFile(outPath, jobId)) {
        return reject(new Error('[10D][KENBURNS][ERR] Output video not created or too small'));
      }
      console.log(`[10D][KENBURNS][${jobId}] Ken Burns pan video created:`, outPath);
      resolve(outPath);
    });
  });
}

// --- Main entry: fallback to Ken Burns if no video found ---
// Returns: local .mp4 path (or null if fail)
// Signature: (subject, workDir, sceneIdx, jobId, usedClips)
async function fallbackKenBurnsVideo(subject, workDir, sceneIdx, jobId, usedClips = []) {
  try {
    console.log(`[10D][FALLBACK][${jobId}] Attempting Ken Burns fallback video for "${subject}" | workDir="${workDir}" | sceneIdx=${sceneIdx}`);

    // Look for an image that hasn't been used yet
    let imageUrl = await findImageInPexels(subject);
    if (!imageUrl) imageUrl = await findImageInPixabay(subject);

    // If dupe, keep looking (simple dupe check)
    let tryCount = 0;
    while (imageUrl && usedClips && usedClips.some(u => u.includes(imageUrl)) && tryCount < 3) {
      console.warn(`[10D][FALLBACK][${jobId}] Image already used (${imageUrl}), trying next...`);
      imageUrl = await findImageInPixabay(subject + ' ' + (Math.random() * 10000).toFixed(0));
      tryCount++;
    }

    if (!imageUrl) {
      console.warn(`[10D][FALLBACK][${jobId}] No fallback image found for "${subject}"`);
      return null;
    }

    // Prepare temp dir
    const realTmpDir = workDir || path.join(__dirname, 'tmp');
    if (!fs.existsSync(realTmpDir)) fs.mkdirSync(realTmpDir, { recursive: true });

    const imgName = `kenburns-${uuidv4()}.jpg`;
    const imgPath = path.join(realTmpDir, imgName);
    await downloadRemoteFileToLocal(imageUrl, imgPath, jobId);

    const outVidName = `kenburns-${uuidv4()}.mp4`;
    const outVidPath = path.join(realTmpDir, outVidName);

    await makeKenBurnsVideoFromImage(imgPath, outVidPath, 5, jobId);

    console.log(`[10D][FALLBACK][${jobId}] Ken Burns fallback video created: ${outVidPath}`);
    return outVidPath;
  } catch (err) {
    console.error(`[10D][FALLBACK][ERR][${jobId}] Ken Burns fallback failed:`, err);
    return null;
  }
}

module.exports = {
  fallbackKenBurnsVideo,
  findImageInPexels,
  findImageInPixabay,
  downloadRemoteFileToLocal,
  makeKenBurnsVideoFromImage
};
