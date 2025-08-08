// ============================================================
// SECTION 10D: KEN BURNS IMAGE → VIDEO HELPER (Last-Resort)
// Purpose: Turn a local still image into a vertical MP4.
// Exports (used by 5D):
//   - preprocessImageToJpeg(inputPath, outJpgPath, jobId)
//   - makeKenBurnsVideoFromImage(preppedJpgPath, outMp4Path, durationSec?, jobId)
//   - staticImageToVideo(preppedJpgPath, outMp4Path, durationSec?, jobId)
// Extras:
//   - buildTextImage(subject, outPng, jobId)  // optional placeholder
//
// Notes:
// - **No provider searching here** (10B/10C/10F already do that).
// - Vertical-first (1080×1920), constant FPS, yuv420p.
// - Pan-only Ken Burns (no zoom) = safe, non-dizzy motion.
// - Max logging, strict output validation.
// ============================================================

const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const sharp = require('sharp');

const LOG = '[10D]';

// ---------- Tunables ----------
const OUT_WIDTH  = Number(process.env.KB_WIDTH  || 1080);
const OUT_HEIGHT = Number(process.env.KB_HEIGHT || 1920);
const FPS        = Number(process.env.KB_FPS    || 30);
const CRF        = Number(process.env.KB_CRF    || 20);
const PRESET     = String(process.env.KB_PRESET || 'veryfast');

const MIN_VIDEO_BYTES = 2 * 1024; // sanity
const MIN_JPG_BYTES   = 2 * 1024;

// ---------- Utils ----------
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function fileOk(p, minBytes = 1) {
  try {
    if (!p || !fs.existsSync(p)) return false;
    const st = fs.statSync(p);
    return st.isFile() && st.size >= minBytes;
  } catch { return false; }
}

async function runFFmpegChecked(jobId) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-version']);
    let ok = false;
    child.on('exit', (code) => { ok = code === 0; resolve(ok); });
    child.on('error', () => resolve(false));
  });
}

function safeName(s) {
  return String(s || '')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 80);
}

// ---------- Core: Preprocess ----------
async function preprocessImageToJpeg(inPath, outJpgPath, jobId = '') {
  if (!inPath) throw new Error('preprocess: inputPath required');
  if (!outJpgPath) throw new Error('preprocess: outJpgPath required');

  console.log(`${LOG}[PREP][${jobId}] ${inPath} → ${outJpgPath}`);
  ensureDir(path.dirname(outJpgPath));

  await sharp(inPath)
    // Make a clean portrait canvas; keep entire image, letterbox if needed.
    .resize(OUT_WIDTH, OUT_HEIGHT, { fit: 'contain', background: { r:0, g:0, b:0 } })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toFile(outJpgPath);

  if (!fileOk(outJpgPath, MIN_JPG_BYTES)) {
    throw new Error(`${LOG}[PREP][${jobId}] Output JPG invalid: ${outJpgPath}`);
  }
  console.log(`${LOG}[PREP][${jobId}] OK`);
  return outJpgPath;
}

// ---------- Optional: text placeholder (for tests/emergencies) ----------
async function buildTextImage(subject, outPng, jobId = '') {
  const width = OUT_WIDTH, height = OUT_HEIGHT;
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

  console.log(`${LOG}[TEXT][${jobId}] ${outPng}`);
  ensureDir(path.dirname(outPng));
  await sharp(Buffer.from(svg)).png().toFile(outPng);

  if (!fileOk(outPng, MIN_JPG_BYTES)) {
    throw new Error(`${LOG}[TEXT][${jobId}] Placeholder PNG invalid: ${outPng}`);
  }
  return outPng;
}

function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------- Core: Ken Burns (Pan-Only, No Zoom) ----------
async function makeKenBurnsVideoFromImage(preppedJpgPath, outMp4Path, durationSec = 5, jobId = '') {
  if (!preppedJpgPath) throw new Error('kenburns: preppedJpgPath required');
  if (!outMp4Path) throw new Error('kenburns: outMp4Path required');
  if (!fileOk(preppedJpgPath, MIN_JPG_BYTES)) throw new Error('kenburns: prepped jpg missing/invalid');

  const hasFF = await runFFmpegChecked(jobId);
  if (!hasFF) throw new Error(`${LOG}[FATAL][${jobId}] ffmpeg not available on PATH.`);

  ensureDir(path.dirname(outMp4Path));
  const D = Math.max(2, Math.min(Number(durationSec) || 5, 20));

  // Decide direction deterministically based on filename (avoid random in tests)
  const base = path.basename(preppedJpgPath);
  const hash = hash32(base);
  const dir = (hash % 2 === 0) ? 'forward' : 'reverse';

  // Strategy:
  // 1) scale-to-cover so input fully covers OUT_W×OUT_H (no black bars).
  // 2) crop to OUT_W×OUT_H with moving window.
  // If source is wider than 9:16 → horizontal pan; else vertical pan.
  //
  // x(t) = (iw - OUT_W) * (t/D)   (or reversed: (iw - OUT_W) * (1 - t/D))
  // y(t) = (ih - OUT_H) * (t/D)   (or reversed)
  //
  // Use conditional to select axis based on aspect (a = iw/ih).
  const t = `t/${D}`;
  const chooseX = dir === 'forward'
    ? `(iw-${OUT_WIDTH})*${t}`
    : `(iw-${OUT_WIDTH})*(1-${t})`;
  const chooseY = dir === 'forward'
    ? `(ih-${OUT_HEIGHT})*${t}`
    : `(ih-${OUT_HEIGHT})*(1-${t})`;

  const xExpr = `if(gt(a,${OUT_WIDTH}/${OUT_HEIGHT}), ${chooseX}, (iw-${OUT_WIDTH})/2)`
  const yExpr = `if(gt(a,${OUT_WIDTH}/${OUT_HEIGHT}), (ih-${OUT_HEIGHT})/2, ${chooseY})`

  const vf = [
    // scale-to-cover (no padding)
    `scale=w='if(gt(a,${OUT_WIDTH}/${OUT_HEIGHT}),-1,${OUT_WIDTH})':h='if(gt(a,${OUT_WIDTH}/${OUT_HEIGHT}),${OUT_HEIGHT},-1)'`,
    // moving crop window
    `crop=${OUT_WIDTH}:${OUT_HEIGHT}:${xExpr}:${yExpr}`,
    `fps=${FPS}`,
    `format=yuv420p`,
    `setsar=1`,
    `setpts=PTS-STARTPTS`
  ].join(',');

  const cmd =
    `ffmpeg -y -hide_banner -loglevel error -loop 1 -i "${preppedJpgPath}" ` +
    `-t ${D} -vf "${vf}" -c:v libx264 -preset ${PRESET} -crf ${CRF} -pix_fmt yuv420p -an "${outMp4Path}"`;

  console.log(`${LOG}[KB][${jobId}] ${dir} pan ${D}s @ ${FPS}fps`);
  console.log(`${LOG}[KB][${jobId}] ${cmd}`);

  await execPromise(cmd, 30000, `${LOG}[KB][${jobId}]`);
  if (!fileOk(outMp4Path, MIN_VIDEO_BYTES)) {
    throw new Error(`${LOG}[KB][${jobId}] Output MP4 invalid: ${outMp4Path}`);
  }
  console.log(`${LOG}[KB][${jobId}] OK → ${outMp4Path}`);
  return outMp4Path;
}

// ---------- Core: Still Image → Video (centered, no motion) ----------
async function staticImageToVideo(preppedJpgPath, outMp4Path, durationSec = 5, jobId = '') {
  if (!preppedJpgPath) throw new Error('still: preppedJpgPath required');
  if (!outMp4Path) throw new Error('still: outMp4Path required');
  if (!fileOk(preppedJpgPath, MIN_JPG_BYTES)) throw new Error('still: prepped jpg missing/invalid');

  const hasFF = await runFFmpegChecked(jobId);
  if (!hasFF) throw new Error(`${LOG}[FATAL][${jobId}] ffmpeg not available on PATH.`);

  ensureDir(path.dirname(outMp4Path));
  const D = Math.max(2, Math.min(Number(durationSec) || 5, 20));

  const vf = [
    // scale-to-cover (no bars), then center crop
    `scale=w='if(gt(a,${OUT_WIDTH}/${OUT_HEIGHT}),-1,${OUT_WIDTH})':h='if(gt(a,${OUT_WIDTH}/${OUT_HEIGHT}),${OUT_HEIGHT},-1)'`,
    `crop=${OUT_WIDTH}:${OUT_HEIGHT}`,
    `fps=${FPS}`,
    `format=yuv420p`,
    `setsar=1`,
    `setpts=PTS-STARTPTS`
  ].join(',');

  const cmd =
    `ffmpeg -y -hide_banner -loglevel error -loop 1 -i "${preppedJpgPath}" ` +
    `-t ${D} -vf "${vf}" -c:v libx264 -preset ${PRESET} -crf ${CRF} -pix_fmt yuv420p -an "${outMp4Path}"`;

  console.log(`${LOG}[STILL][${jobId}] ${cmd}`);

  await execPromise(cmd, 20000, `${LOG}[STILL][${jobId}]`);
  if (!fileOk(outMp4Path, MIN_VIDEO_BYTES)) {
    throw new Error(`${LOG}[STILL][${jobId}] Output MP4 invalid: ${outMp4Path}`);
  }
  console.log(`${LOG}[STILL][${jobId}] OK → ${outMp4Path}`);
  return outMp4Path;
}

// ---------- Exec helper ----------
function execPromise(cmd, timeoutMs, tag) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (stdout && stdout.trim()) console.log(`${tag}[OUT]\n${stdout}`);
      if (stderr && stderr.trim()) console.log(`${tag}[FFMPEG]\n${stderr}`);
      if (error) {
        if (error.killed) console.error(`${tag}[TIMEOUT] exceeded ${timeoutMs}ms`);
        return reject(error);
      }
      resolve();
    });
    child.on('error', reject);
  });
}

// ---------- tiny hash ----------
function hash32(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

module.exports = {
  preprocessImageToJpeg,
  makeKenBurnsVideoFromImage,
  staticImageToVideo,
  buildTextImage, // optional
};
