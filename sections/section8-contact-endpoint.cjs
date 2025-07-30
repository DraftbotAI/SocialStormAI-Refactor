/* ===========================================================
   SECTION 8: CONTACT FORM ENDPOINT (Modular)
   -----------------------------------------------------------
   - Exports registerContactEndpoint(app)
   - POST /api/contact
   - Logs all inputs, results, and errors (MAX logging)
   - Bulletproof error handling, works with modular backend
   =========================================================== */

console.log('\n========== [SECTION 8] Contact Form Endpoint ==========');

function registerContactEndpoint(app) {
  console.log('[SECTION8][INIT] registerContactEndpoint called');
  if (!app) throw new Error('[SECTION8][FATAL] No app instance provided!');

  app.post('/api/contact', async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[SECTION8][REQ] POST /api/contact @ ${timestamp}`);

    try {
      const { name = '', email = '', message = '' } = req.body || {};
      console.log('[SECTION8][CONTACT INPUT] Name:', name, '| Email:', email, '| Message:', message);

      if (!name || !email || !message) {
        console.warn('[SECTION8][WARN] Missing contact form fields.');
        return res.json({ success: false, error: "Please fill out all fields." });
      }

      // Example: Here you could add email sending, DB save, queue, etc.
      console.log(`[SECTION8][CONTACT] Message received from: ${name} <${email}> | Message: ${message}`);

      res.json({ success: true, status: "Message received!" });
      console.log('[SECTION8][CONTACT] Success response sent.');

    } catch (err) {
      console.error('[SECTION8][ERROR] /api/contact:', err);
      res.json({ success: false, error: "Failed to send message." });
    }
  });

  console.log('[SECTION8][INFO] /api/contact endpoint registered.');
}

console.log('[SECTION8][EXPORT] registerContactEndpoint exported');
module.exports = registerContactEndpoint;
