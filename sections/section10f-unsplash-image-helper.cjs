// =============================================================
// SECTION 10F: UNSPLASH IMAGE HELPER (Search & Download)
// Searches Unsplash for a high-res image matching the subject.
// Downloads to local job folder, returns file path on success.
// MAX LOGGING, bulletproof, modular, NO DUPES!
// Requires: UNSPLASH_ACCESS_KEY in env
// =============================================================
const fs = require('fs');
const path = require('path');
const https = require('https');

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || '';

if (!UNSPLASH_ACCESS_KEY) {
  console.error('[10F][FATAL] UNSPLASH_ACCESS_KEY missing in env!');
}

console.log('[10F][INIT] Unsplash image helper loaded.');

function cleanForFilename(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}

/**
 * Search Unsplash API for an image matching subject and download it.
 * @param {string} subject - The search phrase (topic, scene, keyword)
 * @param {string} workDir - Directory to save downloaded image
 * @param {number} sceneIdx - Scene index (for filename uniqueness)
 * @param {string} jobId - For logging
 * @returns {Promise<string|null>} Local file path if successful, else null
 */
async function findUnsplashImageForScene(subject, workDir, sceneIdx = 0, jobId = 'nojob') {
  if (!UNSPLASH_ACCESS_KEY) {
    console.error('[10F][NO_API_KEY][%s] Unsplash API key missing.', jobId);
    return null;
  }
  if (!subject || !workDir) {
    console.error('[10F][INVALID_ARGS][%s] Missing subject or workDir.', jobId);
    return null;
  }

  const query = encodeURIComponent(subject);
  const apiUrl = `https://api.unsplash.com/search/photos?query=${query}&orientation=portrait&per_page=1&client_id=${UNSPLASH_ACCESS_KEY}`;

  console.log(`[10F][REQ][${jobId}] Searching Unsplash: "${subject}"`);

  let json;
  try {
    json = await new Promise((resolve, reject) => {
      https.get(apiUrl, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  } catch (err) {
    console.error(`[10F][API_ERR][${jobId}] Unsplash API error:`, err);
    return null;
  }

  // Pick first result (if exists)
  const result = json && Array.isArray(json.results) && json.results[0];
  if (!result || !result.urls || !result.urls.full) {
    console.warn(`[10F][NO_RESULT][${jobId}] No Unsplash image found for: "${subject}"`);
    return null;
  }

  // Download image to local job dir
  const filename = `unsplash_${cleanForFilename(subject)}_${sceneIdx}.jpg`;
  const outPath = path.join(workDir, filename);

  // If file already exists and is >10KB, skip download
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10 * 1024) {
    console.log(`[10F][CACHE][${jobId}] HIT: ${outPath}`);
    return outPath;
  }

  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(outPath);
      https.get(result.urls.full, response => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} when downloading Unsplash image`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', err => {
        fs.unlink(outPath, () => reject(err));
      });
    });
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10 * 1024) {
      console.log(`[10F][DOWNLOAD][${jobId}] OK: Saved Unsplash image to ${outPath}`);
      return outPath;
    } else {
      throw new Error('Downloaded file is too small or missing');
    }
  } catch (err) {
    console.error(`[10F][DOWNLOAD_ERR][${jobId}] Failed to download Unsplash image:`, err);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    return null;
  }
}

module.exports = { findUnsplashImageForScene };
