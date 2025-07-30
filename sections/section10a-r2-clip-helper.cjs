// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2)
// Finds and returns best-matching video from your R2 bucket
// MAX LOGGING EVERY STEP
// ===========================================================

const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

console.log('[10A][INIT] R2 clip helper loaded.');

const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_ENDPOINT = process.env.R2_ENDPOINT;

const s3Client = new S3Client({
  endpoint: R2_ENDPOINT,
  region: 'auto',
  credentials: {
    accessKeyId: process.env.R2_KEY,
    secretAccessKey: process.env.R2_SECRET,
  }
});

function normalize(str) {
  const norm = String(str)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .replace(/[^a-z0-9]/g, '');
  console.log(`[10A][NORMALIZE] "${str}" -> "${norm}"`);
  return norm;
}

async function listAllFilesInR2(prefix = '') {
  let files = [];
  let continuationToken;
  let round = 0;
  try {
    do {
      round++;
      console.log(`[10A][R2] Listing R2 files, round ${round}...`);
      const cmd = new ListObjectsV2Command({
        Bucket: R2_LIBRARY_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const resp = await s3Client.send(cmd);
      if (resp && resp.Contents) {
        files.push(...resp.Contents.map(obj => obj.Key));
      }
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);
    console.log(`[10A][R2] Listed ${files.length} files from R2.`);
    return files;
  } catch (err) {
    console.error('[10A][R2][ERR] List error:', err);
    return [];
  }
}

async function findR2Clip(subject, sceneIdx, mainTopic) {
  console.log(`[10A][R2] findR2Clip | subject="${subject}" sceneIdx=${sceneIdx} mainTopic="${mainTopic}"`);
  try {
    const files = await listAllFilesInR2('');
    const normQuery = normalize(subject);
    let best = null;
    for (let file of files) {
      if (normalize(file).includes(normQuery)) {
        best = file;
        break;
      }
    }
    if (best) {
      let url = R2_ENDPOINT.endsWith('/') ? R2_ENDPOINT : (R2_ENDPOINT + '/');
      url += `${R2_LIBRARY_BUCKET}/${best}`;
      console.log(`[10A][R2] Found: ${url}`);
      return url;
    }
    console.log(`[10A][R2] No R2 match for "${subject}"`);
    return null;
  } catch (err) {
    console.error('[10A][R2][ERR] findR2Clip failed:', err);
    return null;
  }
}

module.exports = { findR2Clip };
