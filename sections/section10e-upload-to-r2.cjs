// ========================================================
// SECTION 10E: UPLOAD TO R2 HELPER (Auto-ingest for library)
// Uploads to socialstorm-library/[category]/ with bulletproof naming
// Max logging, bulletproof dedupe, and error resilience
// 2024-08
// ========================================================

const fs = require('fs');
const path = require('path');
const { s3Client, PutObjectCommand, HeadObjectCommand } = require('./section1-setup.cjs');

// === Always use this bucket for the library ===
const LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';

/**
 * Cleans any string for use as a folder or filename.
 * Ensures no forbidden characters and safe R2 key format.
 */
function cleanForFilename(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')  // Replace non-alphanum with underscore
    .replace(/_+/g, '_')          // Collapse underscores
    .replace(/^_+|_+$/g, '')      // Trim leading/trailing
    .slice(0, 70);
}

/**
 * Uploads a file to R2 in the /socialstorm-library/[category]/ folder with bulletproof naming and dedupe.
 * @param {string} localFilePath - Path to local file (video/image)
 * @param {string} subject - Main subject/scene description (for filename)
 * @param {number|string} sceneIdx - Scene index (for filename)
 * @param {string} source - Source (pexels, pixabay, unsplash, etc)
 * @param {string} categoryFolder - Top-level topic/folder (e.g. "lore_history_mystery_horror")
 * @returns {Promise<string|false>} - Returns R2 path string on success, false on fail
 */
async function uploadSceneClipToR2(localFilePath, subject, sceneIdx, source, categoryFolder) {
  try {
    if (!fs.existsSync(localFilePath)) {
      console.error('[10E][UPLOAD][FAIL][SCENE] Local file not found:', localFilePath);
      return false;
    }

    const ext = path.extname(localFilePath) || '.mp4';
    const baseName = path.basename(localFilePath, ext);
    const subjectClean = cleanForFilename(subject) || 'unknown_subject';
    const safeSource = cleanForFilename(source) || 'unknown_source';
    const catFolder = cleanForFilename(categoryFolder) || 'misc';

    // Final R2 path: category/subject__sceneIdx-source-original.ext
    const r2DestPath = `${catFolder}/${subjectClean}__${sceneIdx}-${safeSource}-${baseName}${ext}`;

    // Dedupe: skip upload if already present in R2
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: LIBRARY_BUCKET,
        Key: r2DestPath
      }));
      console.log(`[10E][UPLOAD][SKIP][SCENE] File already exists in R2: ${LIBRARY_BUCKET}/${r2DestPath}`);
      return `${LIBRARY_BUCKET}/${r2DestPath}`; // Already there, skip
    } catch (_) {
      // Not found, proceed to upload
    }

    const fileBuffer = fs.readFileSync(localFilePath);

    await s3Client.send(new PutObjectCommand({
      Bucket: LIBRARY_BUCKET,
      Key: r2DestPath,
      Body: fileBuffer,
      // No ACL needed for R2 (Cloudflare) public buckets, but set content type
      ContentType: ext === '.mp4'
        ? 'video/mp4'
        : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'application/octet-stream'
    }));

    console.log(`[10E][UPLOAD][OK][SCENE] Uploaded to R2: ${LIBRARY_BUCKET}/${r2DestPath}`);
    return `${LIBRARY_BUCKET}/${r2DestPath}`;
  } catch (err) {
    console.error('[10E][UPLOAD][FAIL][SCENE]', err);
    return false;
  }
}

module.exports = {
  uploadSceneClipToR2,
  cleanForFilename
};
