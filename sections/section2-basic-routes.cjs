/* ===========================================================
   SECTION 2: BASIC ROUTES & STATIC FILE SERVING (Modular)
   -----------------------------------------------------------
   - Static file middleware, home page, status and progress endpoints
   - Assumes app, express, progress from Section 1
   - MAX logging everywhere
   =========================================================== */

// Dependencies expected from Section 1:
const path = require('path');

// Accepts 'app', 'express', and 'progress' as parameters from Section 1
function registerBasicRoutes(app, express, progress) {
  console.log('[SECTION2][INFO] Setting up static file routes...');

  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  app.use(express.static(PUBLIC_DIR));
  console.log('[SECTION2][INFO] Static file directory mounted:', PUBLIC_DIR);

  app.get('/', (req, res) => {
    console.log('[SECTION2][REQ] GET /');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/api/status', (req, res) => {
    console.log('[SECTION2][REQ] GET /api/status');
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  });

  app.get('/api/progress/:jobId', (req, res) => {
    const { jobId } = req.params;
    console.log(`[SECTION2][REQ] GET /api/progress/${jobId}`);
    if (progress && progress[jobId]) {
      console.log(`[SECTION2][INFO] Returning progress for job ${jobId}:`, progress[jobId]);
      res.json(progress[jobId]);
    } else {
      console.warn(`[SECTION2][WARN] No progress found for job ${jobId}`);
      res.json({ percent: 100, status: 'Done (or not found)' });
    }
  });

  console.log('[SECTION2][INFO] All basic routes registered.');
}

module.exports = registerBasicRoutes;
