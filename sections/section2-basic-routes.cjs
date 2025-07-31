/* ===========================================================
   SECTION 2: BASIC ROUTES & STATIC FILE SERVING (Modular)
   -----------------------------------------------------------
   - Static file middleware, home page, status and progress endpoints
   - Assumes app, express, progress from Section 1
   - MAX logging everywhere
   =========================================================== */

const path = require('path');

console.log('[SECTION2][INIT] section2-basic-routes.cjs loaded');

function registerBasicRoutes(app, express, progress) {
  console.log('[SECTION2][START] Registering static file routes and endpoints...');

  try {
    const PUBLIC_DIR = path.join(__dirname, '..', 'public');
    app.use(express.static(PUBLIC_DIR));
    console.log('[SECTION2][INFO] Static file directory mounted:', PUBLIC_DIR);

    // Home page (always serve index.html from /public)
    app.get('/', (req, res) => {
      console.log('[SECTION2][REQ] GET /');
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err) {
          console.error('[SECTION2][ERR] Failed to send index.html:', err);
          // Show basic error UI
          res.status(err.statusCode || 500).send('Error loading homepage.');
        } else {
          console.log('[SECTION2][INFO] index.html sent successfully.');
        }
      });
    });

    // API: Status check
    app.get('/api/status', (req, res) => {
      console.log('[SECTION2][REQ] GET /api/status');
      res.json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    // API: Progress for a jobId
    app.get('/api/progress/:jobId', (req, res) => {
      const { jobId } = req.params;
      console.log(`[SECTION2][REQ] GET /api/progress/${jobId}`);
      if (progress && typeof progress === 'object' && progress[jobId]) {
        console.log(`[SECTION2][INFO] Returning progress for job ${jobId}:`, progress[jobId]);
        res.json(progress[jobId]);
      } else {
        console.warn(`[SECTION2][WARN] No progress found for job ${jobId}`);
        // Always return a valid JSON shape to prevent frontend errors
        res.json({ percent: 100, status: 'Done (or not found)', jobId });
      }
    });

    console.log('[SECTION2][SUCCESS] All basic routes registered.');
  } catch (err) {
    console.error('[SECTION2][FATAL] Error registering basic routes:', err);
    throw err; // Bubble up so init fails visibly
  }
}

console.log('[SECTION2][EXPORT] registerBasicRoutes exported');
module.exports = registerBasicRoutes;
