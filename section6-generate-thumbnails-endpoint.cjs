/* ===========================================================
   SECTION 6: THUMBNAIL GENERATION ENDPOINT (Modular)
   -----------------------------------------------------------
   - POST /api/generate-thumbnails
   - Generates 10 viral thumbnails with Canvas
   - ZIP-packs, bulletproof error handling, MAX logging
   - Compatible with centralized app from Section 1
   =========================================================== */

console.log('\n========== [SECTION 6] Thumbnail Generation Endpoint ==========');

const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage, registerFont } = require('canvas');
const JSZip = require('jszip');

// --- FONT SETUP ---
function tryRegisterFont() {
  const fontPath = path.join(__dirname, '..', 'frontend', 'assets', 'fonts', 'LuckiestGuy-Regular.ttf');
  if (fs.existsSync(fontPath)) {
    registerFont(fontPath, { family: 'LuckiestGuy' });
    console.log('[SECTION6][FONT] Registered LuckiestGuy font:', fontPath);
  } else {
    console.warn('[SECTION6][FONT] LuckiestGuy font missing:', fontPath);
  }
}
tryRegisterFont();

// === Utility: Generate one thumbnail as a buffer ===
async function generateSingleThumbnail({ caption, topic, templateIndex = 0 }) {
  try {
    const width = 1080, height = 1920;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = "#00e0fe";
    ctx.fillRect(0, 0, width, height);

    // Overlay image template (can expand with real template logic)
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = 0.08 + 0.1 * (templateIndex % 3);
    ctx.fillRect(40, 180, width - 80, height - 400);
    ctx.globalAlpha = 1.0;

    // Topic
    ctx.font = 'bold 88px LuckiestGuy, Arial';
    ctx.fillStyle = "#0a2342";
    ctx.fillText(topic, 70, 300);

    // Caption
    ctx.font = 'bold 110px LuckiestGuy, Arial';
    ctx.fillStyle = "#00b3c4";
    ctx.fillText(caption, 70, 490);

    // Watermark (bottom right)
    ctx.font = '32px Arial';
    ctx.fillStyle = "#10141a";
    ctx.globalAlpha = 0.23;
    ctx.fillText('SocialStormAI.com', width - 470, height - 60);
    ctx.globalAlpha = 1.0;

    // Return image as buffer (jpeg)
    console.log(`[SECTION6][THUMB] Generated thumbnail buffer (template: ${templateIndex})`);
    return canvas.toBuffer('image/jpeg', { quality: 0.93 });
  } catch (err) {
    console.error(`[SECTION6][ERR][THUMBNAIL] Failed to generate thumbnail (template ${templateIndex})`, err);
    throw err;
  }
}

// === Main registration function ===
function registerThumbnailEndpoint(app) {
  if (!app) throw new Error('[SECTION6][FATAL] No app instance provided!');

  app.post('/api/generate-thumbnails', async (req, res) => {
    console.log('[SECTION6][REQ] POST /api/generate-thumbnails');
    try {
      const { caption = '', topic = '' } = req.body || {};
      if (!caption || !topic) {
        console.warn('[SECTION6][ERR] Missing caption or topic');
        return res.status(400).json({ success: false, error: "Missing caption or topic" });
      }
      console.log(`[SECTION6][THUMB] Generating pack for: caption="${caption}", topic="${topic}"`);

      // Generate 10 thumbnails with minor variation
      const thumbs = [];
      for (let i = 0; i < 10; i++) {
        thumbs.push(await generateSingleThumbnail({ caption, topic, templateIndex: i }));
      }
      console.log('[SECTION6][THUMB] Generated all 10 thumbnails.');

      // Package into a zip
      const zip = new JSZip();
      thumbs.forEach((buf, i) => {
        zip.file(`thumbnail_${i + 1}.jpg`, buf);
      });

      const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="thumbnails.zip"');
      console.log('[SECTION6][THUMB] ZIP pack ready, sending...');
      res.end(zipBuf);

    } catch (err) {
      console.error('[SECTION6][ERR][THUMBNAIL] Endpoint error:', err);
      res.status(500).json({ success: false, error: 'Failed to generate thumbnails' });
    }
  });

  console.log('[SECTION6][INFO] /api/generate-thumbnails endpoint registered.');
}

module.exports = { registerThumbnailEndpoint, generateSingleThumbnail };
