/* ===========================================================
   SECTION 4: /api/generate-script ENDPOINT (Modular, PRO)
   -----------------------------------------------------------
   - Exports registerGenerateScriptEndpoint(app, openai)
   - MAX logging everywhere
   - Enhanced: full input validation, OpenAI usage logging, robust errors
   =========================================================== */

console.log('\n========== [SECTION4][INIT] /api/generate-script Endpoint ==========');

// Usage (in main server file):
// const registerGenerateScriptEndpoint = require('./sections/section4-generate-script-endpoint.cjs');
// registerGenerateScriptEndpoint(app, openai);

function registerGenerateScriptEndpoint(app, openai) {
  if (!app || !openai) {
    console.error('[SECTION4][FATAL] registerGenerateScriptEndpoint called without app or openai!');
    throw new Error('App and OpenAI instance required');
  }

  console.log('[SECTION4][INFO] Registering /api/generate-script endpoint...');

  app.post('/api/generate-script', async (req, res) => {
    let idea;
    const timestamp = new Date().toISOString();
    console.log(`[SECTION4][REQ] POST /api/generate-script @ ${timestamp}`);

    // Input validation: Body must be JSON and contain a non-empty "idea" string
    try {
      if (!req.body || typeof req.body !== 'object') {
        console.warn('[SECTION4][WARN] Request body missing or not parsed (possible JSON error).');
        return res.status(400).json({ success: false, error: "Request body missing or not valid JSON." });
      }
      idea = typeof req.body.idea === 'string' ? req.body.idea.trim() : '';
      if (!idea) {
        console.warn('[SECTION4][WARN] Missing or empty "idea" in request body.');
        return res.status(400).json({ success: false, error: "Missing idea" });
      }
    } catch (inputErr) {
      console.error('[SECTION4][ERR] Exception parsing request body:', inputErr);
      return res.status(400).json({ success: false, error: "Invalid request body." });
    }

    console.log(`[SECTION4][INPUT] idea = "${idea}"`);

    try {
      const prompt = `
You are a viral YouTube Shorts scriptwriter.

Your job is to write an engaging, narratable script on the topic: "${idea}"

== RULES ==
- Line 1 must be a HOOK — surprising, dramatic, or funny — that makes the viewer stay.
- Each line = one spoken scene (short, punchy, narratable).
- Make each fact feel like a secret or hidden story.
- DO NOT use camera directions (e.g., "Cut to", "Zoom in", "POV", "Flash").
- DO NOT use hashtags, emojis, or quote marks.
- Aim for 6 to 10 lines total. Narration-style only.

== STYLE ==
- Use vivid, conversational tone.
- Add a twist or deeper explanation when possible.
- Be clever or funny when appropriate.
- End with a satisfying or mysterious final line.

== METADATA ==
At the end, return:
Title: [a viral, clickable title — no quotes]
Description: [1–2 sentence summary of what the video reveals]
Tags: [Max 5 words, space-separated. No hashtags or commas.]

== EXAMPLE SCRIPT ==
They say history is written by the winners. But what did they hide?
There's a chamber behind Lincoln’s head at Mount Rushmore — planned for documents, never finished.
The Eiffel Tower hides a tiny private apartment — built by Gustave Eiffel for special guests only.
The Great Wall of China has underground tunnels — built to sneak troops and supplies past enemies.
Lady Liberty’s torch? Sealed off since 1916 after a German attack during WWI.
One paw of the Sphinx may hide a sealed room — sensors detect a cavity, but Egypt won’t open it.
Whispers say the Taj Mahal has secret floors — built for symmetry, now sealed tight.
Title: Hidden Secrets They Don’t Teach in School
Description: Real hidden rooms and strange facts about the world’s most famous landmarks.
Tags: secrets landmarks mystery history viral
      `.trim();

      // === OpenAI v4+ call ===
      const completion = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        temperature: 0.84,
        max_tokens: 900,
        messages: [
          { role: "system", content: prompt }
        ]
      });

      const raw = completion?.choices?.[0]?.message?.content?.trim() || '';
      console.log('[SECTION4][GPT] Raw output:\n' + raw);

      // === Log OpenAI token usage if present ===
      if (completion?.usage) {
        console.log('[SECTION4][OPENAI_USAGE]', completion.usage);
      }

      // === Parse Output ===
      let scriptLines = [];
      let title = '';
      let description = '';
      let tags = '';

      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      const titleIdx = lines.findIndex(l => /^title\s*:/i.test(l));
      const descIdx  = lines.findIndex(l => /^description\s*:/i.test(l));
      const tagsIdx  = lines.findIndex(l => /^tags?\s*:/i.test(l));

      const metaStart = [titleIdx, descIdx, tagsIdx].filter(x => x > -1).sort((a,b) => a - b)[0] || lines.length;

      scriptLines = lines.slice(0, metaStart).filter(l =>
        !/^title\s*:/i.test(l) &&
        !/^description\s*:/i.test(l) &&
        !/^tags?\s*:/i.test(l)
      );

      // Strip out lines that are clearly not meant to be narrated
      const cameraWords = ['cut to', 'zoom', 'pan', 'transition', 'fade', 'camera', 'pov', 'flash'];
      scriptLines = scriptLines.filter(line => {
        const lc = line.toLowerCase();
        return !cameraWords.some(word => lc.startsWith(word) || lc.includes(`: ${word}`));
      });

      if (scriptLines.length > 10) scriptLines = scriptLines.slice(0, 10);

      for (const l of lines.slice(metaStart)) {
        if (/^title\s*:/i.test(l)) title = l.replace(/^title\s*:/i, '').trim();
        else if (/^description\s*:/i.test(l)) description = l.replace(/^description\s*:/i, '').trim();
        else if (/^tags?\s*:/i.test(l)) tags = l.replace(/^tags?\s*:/i, '').trim();
      }

      // === Metadata Fallbacks ===
      if (!title) title = idea.length < 60 ? idea : idea.slice(0, 57) + "...";
      if (!description) description = `This video explores: ${idea}`;
      if (!tags) tags = idea
        .toLowerCase()
        .split(/\W+/)
        .filter(w => w.length > 2)
        .slice(0, 5)
        .join(' ');

      if (!scriptLines.length) scriptLines = ['Something went wrong generating the script.'];

      console.log('[SECTION4][PARSED] script lines:', scriptLines.length, scriptLines);
      console.log('[SECTION4][PARSED] title:', title);
      console.log('[SECTION4][PARSED] description:', description);
      console.log('[SECTION4][PARSED] tags:', tags);

      res.json({
        success: true,
        script: scriptLines.join('\n'),
        title,
        description,
        tags
      });

    } catch (err) {
      // Distinguish between OpenAI errors and general errors
      if (err.response && err.response.status) {
        console.error('[SECTION4][FATAL][OPENAI] OpenAI API error:', err.response.status, err.response.data);
        return res.status(502).json({ success: false, error: "OpenAI API error", details: err.response.data });
      }
      console.error('[SECTION4][FATAL] Script generation failed:', err);
      res.status(500).json({ success: false, error: "Script generation failed" });
    }
  });

  console.log('[SECTION4][SUCCESS] /api/generate-script endpoint registered.');
}

console.log('[SECTION4][EXPORT] registerGenerateScriptEndpoint exported');
module.exports = registerGenerateScriptEndpoint;
