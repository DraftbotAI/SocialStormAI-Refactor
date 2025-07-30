// ===========================================================
// SECTION 10D: KEN BURNS IMAGE VIDEO HELPER
// Finds fallback still images, downloads them, creates slow-pan videos
// Used when no matching R2/Pexels/Pixabay video is found.
// MAX LOGGING EVERY STEP
// ===========================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

console.log('[10D][INIT] Ken Burns image video helper loaded.');

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
async function downloadRemoteFileToLocal(url, outPath) {
  console.log(`[10D][DL] Downloading | url="${url}" | outPath="${outPath}"`);
  try {
    if (!url) throw new Error('No URL provided to download.');
    if (fs.existsSync(outPath)) {
      console.log(`[10D][DL] File already exists, skipping download: ${outPath}`);
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
        console.error('[10D][DL][ERR] Stream error:', err);
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

    if (!fs.existsSync(outPath)) {
      throw new Error('[10D][DL] File not written after download: ' + outPath);
    }
  } catch (err) {
    console.error('[10D][DL][ERR] Download failed:', url, err);
    throw err;
  }
}

// --- Make Ken Burns video from local image ---
async function makeKenBurnsVideoFromImage(imgPath, outPath, duration = 5) {
  const direction = Math.random() > 0.5 ? 'ltr' : 'rtl';
  console.log(`[10D][KENBURNS] Creating pan video (${direction}) | ${imgPath} → ${outPath} (${duration}s)`);

  if (!fs.existsSync(imgPath)) throw new Error('[10D][KENBURNS][ERR] Image does not exist: ' + imgPath);

  const width = 1080, height = 1920;
  const filter = direction === 'ltr'
    ? `[0:v]scale=${width*1.4}:${height*1.4},crop=${width}:${height}:x='(iw-${width})*t/${duration}',setpts=PTS-STARTPTS[v]`
    : `[0:v]scale=${width*1.4}:${height*1.4},crop=${width}:${height}:x='(iw-${width})-(iw-${width})*t/${duration}',setpts=PTS-STARTPTS[v]`;

  const ffmpegCmd = `ffmpeg -y -loop 1 -i "${imgPath}" -filter_complex "${filter}" -map "[v]" -t ${duration} -r 30 -pix_fmt yuv420p -c:v libx264 "${outPath}"`;
  console.log(`[10D][KENBURNS] Running FFmpeg: ${ffmpegCmd}`);

  return new Promise((resolve, reject) => {
    exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        console.error('[10D][KENBURNS][ERR] FFmpeg error:', error, stderr);
        return reject(error);
      }
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
        return reject(new Error('[10D][KENBURNS][ERR] Output video not created or too small'));
      }
      console.log('[10D][KENBURNS] Ken Burns pan video created:', outPath);
      resolve(outPath);
    });
  });
}

// --- Main entry: fallback to Ken Burns if no video found ---
// Returns: local .mp4 path (or null if fail)
async function fallbackKenBurnsVideo(subject, tmpDir = null, duration = 5) {
  try {
    console.log(`[10D][FALLBACK] Attempting Ken Burns fallback video for "${subject}"`);
    let imageUrl = await findImageInPexels(subject);
    if (!imageUrl) imageUrl = await findImageInPixabay(subject);
    if (!imageUrl) {
      console.warn(`[10D][FALLBACK] No fallback image found for "${subject}"`);
      return null;
    }

    // Prepare temp dir
    const realTmpDir = tmpDir || path.join(__dirname, 'tmp');
    if (!fs.existsSync(realTmpDir)) fs.mkdirSync(realTmpDir, { recursive: true });

    const imgName = `kenburns-${uuidv4()}.jpg`;
    const imgPath = path.join(realTmpDir, imgName);
    await downloadRemoteFileToLocal(imageUrl, imgPath);

    const outVidName = `kenburns-${uuidv4()}.mp4`;
    const outVidPath = path.join(realTmpDir, outVidName);

    await makeKenBurnsVideoFromImage(imgPath, outVidPath, duration);

    console.log(`[10D][FALLBACK] Ken Burns fallback video created: ${outVidPath}`);
    return outVidPath;
  } catch (err) {
    console.error('[10D][FALLBACK][ERR] Ken Burns fallback failed:', err);
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
