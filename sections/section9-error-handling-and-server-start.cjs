/* ===========================================================
   SECTION 9: ERROR HANDLING & SERVER START (Modular)
   -----------------------------------------------------------
   - Exports registerErrorHandlerAndStart(app)
   - 404 catchall (must go last!)
   - Starts server on chosen port
   - MAXIMUM logging: logs server startup and all unmatched routes
   =========================================================== */

console.log('\n========== [SECTION 9] Error Handling & Server Start ==========');

function registerErrorHandlerAndStart(app) {
  console.log('[SECTION9][INIT] registerErrorHandlerAndStart called');
  if (!app) throw new Error('[SECTION9][FATAL] No app instance provided!');

  // 404 Catch-all (must go last)
  app.use((req, res) => {
    console.warn('[SECTION9][404] Route not found:', req.originalUrl);
    res.status(404).send('Not found');
  });

  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`🟢 [SECTION9][START] SocialStormAI backend running on port ${PORT}`);
  });

  console.log('[SECTION9][INFO] Error handler and server start registered.');
}

console.log('[SECTION9][EXPORT] registerErrorHandlerAndStart exported');
module.exports = registerErrorHandlerAndStart;
