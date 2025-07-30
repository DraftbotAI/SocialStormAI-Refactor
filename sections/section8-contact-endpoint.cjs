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
  if (!app) throw new Error('[SECTION8][FATAL] No app instance provided!');

  app.post('/api/contact', async (req, res) => {
    console.log('[SECTION8][REQ] POST /api/contact');
    try {
      const { name = '', email = '', message = '' } = req.body || {};
      console.log('[SECTION8][CONTACT INPUT] Name:', name, '| Email:', email, '| Message:', message);

      if (!name || !email || !message) {
        console.warn('[SECTION8][WARN] Missing contact form fields.');
        return res.json({ success: false, error: "Please fill out all fields." });
      }

      // Here you could add: Email sending, DB save, queue, etc.
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

module.exports = { registerContactEndpoint };
