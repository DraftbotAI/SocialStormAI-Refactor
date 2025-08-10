/* ===========================================================
   SECTION 4: /api/generate-script ENDPOINT (Modular, PRO)
   -----------------------------------------------------------
   - Exports registerGenerateScriptEndpoint(app, openai)
   - MAX logging everywhere
   - 2024-08: ALWAYS starts script with viral, topic-rich hook
   - 2025-08: Enforce story-style ENDING line; allow 1 tasteful joke
   - Robust OpenAI prompt, post-validation, error-proofed
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
      // === VIRAL, FUNNY-DRAMATIC-INFO HOOK PROMPT (REVISED) ===
      const prompt = `
You are a viral YouTube Shorts scriptwriter.

Write an ultra-engaging, narratable script for the topic: "${idea}"

== ABSOLUTE RULES ==
- The FIRST line MUST clearly state the real topic, acting as a viral, punchy hook. Never vague, never rhetorical, never a question, and no "Did you ever wonder" or "Let's find out". It MUST include the actual subject in plain English, not just a teaser.
- The first line should be instantly clear, not a metaphor or general statement. (Example: "The Trevi Fountain isn’t just a landmark—here’s why everyone is obsessed with it." or "Here are the secrets hidden inside the world’s most famous landmarks.")
- Each following line = one scene. Short, punchy, narratable. No camera directions, hashtags, emojis, or quote marks.
- Make every fact feel like a "secret" or powerful insight.
- Use 6–10 total lines (including the hook).
- No animal metaphors, off-topic jokes, or padding.
- The LAST line MUST be a proper ending that wraps the story or delivers a takeaway/callback. It cannot be a question or a teaser.

== STYLE ==
- Viral, funny (when appropriate), dramatic, and informational.
- Include at most ONE light, tasteful joke if it naturally fits; otherwise skip jokes.
- Conversational, vivid, friendly, clever. Each line advances the story and keeps the viewer hooked.

== METADATA ==
At the end, return:
Title: [a viral, clickable title — no quotes]
Description: [1–2 sentence summary of what the video reveals]
Tags: [Max 5 words, space-separated. No hashtags or commas.]

== EXAMPLE SCRIPT ==
Here are the secrets hidden inside the world’s most famous landmarks.
The Statue of Liberty's torch was open to the public until 1916—sabotage shut it down forever.
Mount Rushmore has a secret room behind Lincoln’s head holding America’s most prized documents.
The Eiffel Tower hides a tiny apartment Gustave Eiffel used to entertain Thomas Edison.
Under the Lincoln Memorial, there’s a hidden room filled with construction graffiti from the workers.
And in the Leaning Tower of Pisa, centuries-old stairs are marked by the shoes of millions.
Title: Secrets of Famous Landmarks
Description: Discover the wildest hidden rooms, lost history, and real secrets inside the world’s iconic landmarks.
Tags: landmarks secrets travel viral history

Now write a script for: "${idea}"
      `.trim();

      // === OpenAI v4+ call ===
      const completion = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        temperature: 0.88,
        max_tokens: 1000,
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

      // Parse lines and metadata
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      const titleIdx = lines.findIndex(l => /^title\s*:/i.test(l));
      const descIdx  = lines.findIndex(l => /^description\s*:/i.test(l));
      const tagsIdx  = lines.findIndex(l => /^tags?\s*:/i.test(l));

      const metaStart = [titleIdx, descIdx, tagsIdx].filter(x => x > -1).sort((a, b) => a - b)[0] || lines.length;

      scriptLines = lines.slice(0, metaStart).filter(l =>
        !/^title\s*:/i.test(l) &&
        !/^description\s*:/i.test(l) &&
        !/^tags?\s*:/i.test(l)
      );

      // Remove camera/script directions just in case
      const cameraWords = ['cut to', 'zoom', 'pan', 'transition', 'fade', 'camera', 'pov', 'flash'];
      scriptLines = scriptLines.filter(line => {
        const lc = line.toLowerCase();
        return !cameraWords.some(word => lc.startsWith(word) || lc.includes(`: ${word}`));
      });

      // === FORCED HOOK LOGIC: Ensure first line is topic-rich and hooky ===
      if (scriptLines.length > 0) {
        const firstLine = scriptLines[0];
        const ideaKeywords = idea
          .toLowerCase()
          .replace(/[^a-z0-9\s]/gi, ' ')
          .split(/\s+/)
          .filter(w => w.length > 3);
        const firstLineLc = firstLine.toLowerCase();

        let subjectMentioned = false;
        if (ideaKeywords.length) {
          subjectMentioned = ideaKeywords.some(word => firstLineLc.includes(word));
        }
        if (!subjectMentioned && idea.length > 5) {
          const ideaNorm = idea.toLowerCase().replace(/[^\w\s]/g, '').trim();
          if (ideaNorm && firstLineLc.includes(ideaNorm)) subjectMentioned = true;
        }
        if (!subjectMentioned || firstLine.length < 8) {
          let viralHook;
          if (ideaKeywords.length > 0) {
            viralHook = `Here are the secrets about ${idea.replace(/^the\s+/i, '').trim()} you never learned in school.`;
          } else {
            viralHook = `Here's why ${idea.replace(/^(the|a|an)\s+/i, '').trim()} is blowing up right now.`;
          }
          console.warn('[SECTION4][HOOK][ENFORCE] First line did not mention subject, auto-replacing:', firstLine, '→', viralHook);
          scriptLines[0] = viralHook;
        }
      }

      // Cap at 10 lines (including hook)
      if (scriptLines.length > 10) scriptLines = scriptLines.slice(0, 10);

      // === ENDING ENFORCER: last line must be a story-style wrap (no question) ===
      const looksLikeEnding = (line) => {
        if (!line) return false;
        const l = line.trim();
        if (l.length < 8) return false;
        if (/\?$/.test(l)) return false; // no questions for the closer
        const mustEnd = /[.!]$/.test(l);
        const cues = [
          "that's the story",
          "now you know",
          "bottom line",
          "the takeaway",
          "here's the kicker",
          "in the end",
          "long story short",
          "and that's why",
          "remember this"
        ];
        const hasCue = cues.some(c => l.toLowerCase().includes(c));
        return mustEnd || hasCue;
      };

      if (scriptLines.length > 0 && !looksLikeEnding(scriptLines[scriptLines.length - 1])) {
        const cleanIdea = idea.replace(/^the\s+/i, '').trim();
        const fallbackEnd = `That's the story behind ${cleanIdea}. Now you know why it matters.`;
        console.warn('[SECTION4][ENDING][ENFORCE] Appending proper ending line:', fallbackEnd);
        scriptLines.push(fallbackEnd);
      }

      // Extract meta
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
