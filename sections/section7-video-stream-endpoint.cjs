/* ===========================================================
   SECTION 7: VIDEO STREAM ENDPOINT (Modular)
   -----------------------------------------------------------
   - Exports registerVideoStreamEndpoint(app)
   - Serves videos from /public/video (local disk)
   - Bulletproof path validation, MAX logging at all stages
   =========================================================== */

console.log('\n========== [SECTION 7] Video Stream Endpoint ==========');

const path = require('path');
const fs = require('fs');

function registerVideoStreamEndpoint(app) {
  console.log('[SECTION7][INIT] registerVideoStreamEndpoint called');
  if (!app) throw new Error('[SECTION7][FATAL] No app instance provided!');

  app.get('/video/:key', (req, res) => {
    const key = req.params.key;
    console.log(`[SECTION7][REQ] GET /video/${key}`);

    // Defensive: Prevent path traversal and only allow .mp4
    if (!key || typeof key !== 'string' || key.includes('..') || !key.endsWith('.mp4')) {
      console.warn('[SECTION7][VIDEO SERVE] Invalid or missing key:', key);
      return res.status(400).send('Invalid video key');
    }

    // Only serve from exact public/video directory
    const videoDir = path.resolve(__dirname, '..', 'public', 'video');
    const videoPath = path.resolve(videoDir, key);
    if (!videoPath.startsWith(videoDir)) {
      console.warn('[SECTION7][VIDEO SERVE] Attempted path escape:', videoPath);
      return res.status(400).send('Invalid video key');
    }

    fs.stat(videoPath, (err, stats) => {
      if (err || !stats.isFile()) {
        console.warn(`[SECTION7][404] Video not found on disk: ${videoPath}`);
        return res.status(404).send("Video not found");
      }

      // Set headers for mp4 streaming and caching
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `inline; filename="${key}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 7 days

      const range = req.headers.range;
      if (range) {
        // Parse HTTP Range requests
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        let start = 0, end = stats.size - 1;
        if (match) {
          if (match[1]) start = parseInt(match[1], 10);
          if (match[2]) end = parseInt(match[2], 10);
        }
        if (isNaN(start) || isNaN(end) || start > end || end >= stats.size) {
          console.warn('[SECTION7][SERVE] Bad range request:', range, `(start=${start}, end=${end}, size=${stats.size})`);
          return res.status(416).send('Requested range not satisfiable');
        }
        const chunkSize = (end - start) + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stats.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/mp4'
        });
        fs.createReadStream(videoPath, { start, end })
          .on('open', () => {
            console.log(`[SECTION7][SERVE] Partial video sent: ${key} [${start}-${end}]`);
          })
          .on('error', (streamErr) => {
            console.error('[SECTION7][STREAM][ERR]', streamErr);
            res.status(500).send('Stream error');
          })
          .pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stats.size,
          'Content-Type': 'video/mp4'
        });
        fs.createReadStream(videoPath)
          .on('open', () => {
            console.log(`[SECTION7][SERVE] Full video sent: ${key}`);
          })
          .on('error', (streamErr) => {
            console.error('[SECTION7][STREAM][ERR]', streamErr);
            res.status(500).send('Stream error');
          })
          .pipe(res);
      }
    });
  });

  console.log('[SECTION7][INFO] /video/:key endpoint registered.');
}

console.log('[SECTION7][EXPORT] registerVideoStreamEndpoint exported');
module.exports = registerVideoStreamEndpoint;
