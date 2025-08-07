/* ===========================================================
   SECTION 4: /api/generate-script ENDPOINT (Viral Metadata Pro)
   -----------------------------------------------------------
   - Exports registerGenerateScriptEndpoint(app, openai)
   - MAX logging everywhere
   - 2024-08: Forced viral, topic-rich hook, strong ending, bulletproof meta
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

    // Input validation
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
      // === MAX VIRAL PROMPT (Revised) ===
      const prompt = `
You are a viral YouTube Shorts scriptwriter and YouTube SEO expert.

Write an ultra-engaging, narratable script for the topic: "${idea}"

== ABSOLUTE RULES ==
- The FIRST line MUST clearly state the real topic, acting as a viral, punchy hook. No vague questions, no "Did you ever wonder", no rhetorical lead-ins, no quotes. Must include the actual subject.
- The first line should be instantly clear, not a metaphor or general statement.
- Each following line = one scene. Short, punchy, narratable. No camera directions, hashtags, emojis, or quote marks.
- Each fact must feel like a "secret", hack, or mind-blowing insight.
- Use 6–10 total lines (including hook and ending).
- No animal metaphors, off-topic jokes, or padding.
- END with a powerful, mysterious, or emotional closing line (a twist, question, or challenge).
- At the end, return:
  Title: [Viral, clickable, FOMO title. No quotes, no punctuation at end, never dry, never repeat hook.]
  Description: [1–3 sentences, vivid, story-driven, triggers curiosity and FOMO. Explain why viewer *must* watch. Include a call to action for likes, comments, or sharing.]
  Tags: [10–12 high-search tags, no repeats, no hashtags, no commas, use topic, subject, adjacent interests, and current trends.]

== STYLE ==
- Conversational, vivid, clever.
- Every line keeps the viewer hooked.
- Humor only if natural—never forced.

== EXAMPLE SCRIPT ==
Here are the secrets hidden inside the world’s most famous landmarks.
The Statue of Liberty's torch was open to the public until 1916—sabotage shut it down forever.
Mount Rushmore has a secret room behind Lincoln’s head holding America’s most prized documents.
The Eiffel Tower hides a tiny apartment Gustave Eiffel used to entertain Thomas Edison.
Under the Lincoln Memorial, there’s a hidden room filled with construction graffiti from the workers.
And in the Leaning Tower of Pisa, centuries-old stairs are marked by the shoes of millions.
Title: Hidden Truths of Landmarks Revealed
Description: Uncover the wildest hidden rooms, lost histories, and real secrets inside the world’s most iconic landmarks. These mind-blowing facts will change the way you see them forever. Drop a like and comment which secret surprised you most!
Tags: landmarks secrets travel history viral tourist architecture mystery facts famous
      
Now write a script for: "${idea}"
      `.trim();

      // === OpenAI v4+ call ===
      const completion = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        temperature: 0.92,
        max_tokens: 1100,
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

      // === FORCED HOOK LOGIC ===
      if (scriptLines.length > 0) {
        const firstLine = scriptLines[0];
        // Extract all "big" (4+ letter) words from idea
        const ideaKeywords = idea
          .toLowerCase()
          .replace(/[^a-z0-9\s]/gi, ' ')
          .split(/\s+/)
          .filter(w => w.length > 3);
        const firstLineLc = firstLine.toLowerCase();

        // Consider the *entire* idea string as a possible subject too
        let subjectMentioned = false;
        if (ideaKeywords.length) {
          subjectMentioned = ideaKeywords.some(word => firstLineLc.includes(word));
        }
        // Also check if the whole "idea" as a phrase (normalized) appears
        if (!subjectMentioned && idea.length > 5) {
          const ideaNorm = idea.toLowerCase().replace(/[^\w\s]/g, '').trim();
          if (ideaNorm && firstLineLc.includes(ideaNorm)) subjectMentioned = true;
        }
        // If not found, force replace
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

      // === ENFORCE STRONG ENDING (callout, twist, or challenge) ===
      if (scriptLines.length > 1) {
        let last = scriptLines[scriptLines.length - 1].toLowerCase();
        const endings = [
          "So next time you see it, remember this secret.",
          "Now you know what most people never do.",
          "Will you ever look at it the same way again?",
          "Let me know in the comments if you learned something new.",
          "That’s a fact most people have never heard.",
          "Share this with someone who’d be shocked.",
          "Like for more mind-blowing facts!",
          "Which secret surprised you most?",
          "I bet you didn’t expect that!",
          "This changes everything you thought you knew."
        ];
        // If ending is generic, enforce a punchy closing line
        const endingTooDry = (last.length < 18) ||
          last.startsWith("title:") ||
          last.startsWith("description:") ||
          last.startsWith("tags:");
        if (endingTooDry) {
          const ending = endings[Math.floor(Math.random() * endings.length)];
          scriptLines[scriptLines.length - 1] = ending;
          console.warn('[SECTION4][ENDING][ENFORCE] Last line was dry, auto-replacing with:', ending);
        }
      }

      // Cap at 10 lines (including hook and ending)
      if (scriptLines.length > 10) scriptLines = scriptLines.slice(0, 10);

      // === Extract meta
      for (const l of lines.slice(metaStart)) {
        if (/^title\s*:/i.test(l)) title = l.replace(/^title\s*:/i, '').trim();
        else if (/^description\s*:/i.test(l)) description = l.replace(/^description\s*:/i, '').trim();
        else if (/^tags?\s*:/i.test(l)) tags = l.replace(/^tags?\s*:/i, '').trim();
      }

      // === Metadata Fallbacks (Pro Enhanced) ===

      // --- Title ---
      const makeViralTitle = (subject) => {
        const keywords = String(subject || '').split(/\s+/).filter(w => w.length > 3).slice(0, 4).join(' ');
        return [
          `The Shocking Truth About ${keywords}`,
          `Secrets of ${keywords} Finally Revealed`,
          `Why Everyone's Obsessed with ${keywords}`,
          `Mind-Blowing Facts About ${keywords}`,
          `What No One Tells You About ${keywords}`,
          `This Will Change How You See ${keywords}`
        ][Math.floor(Math.random() * 6)];
      };

      if (!title || title.length < 5 || title.toLowerCase() === idea.toLowerCase()) {
        title = makeViralTitle(idea);
        console.warn('[SECTION4][TITLE][ENFORCE] Title missing or generic, generating viral fallback:', title);
      }

      // --- Description ---
      const makeLongDescription = (idea, scriptLines) => {
        const main = idea.charAt(0).toUpperCase() + idea.slice(1);
        const lastLine = scriptLines[scriptLines.length - 1] || "";
        return `${main} — Uncover secrets, hacks, and fascinating truths you never knew. Every fact will make you rethink what you thought was possible! Stick around to the end for a mind-blowing twist. Drop a like and share this with someone who would love it. ${lastLine}`;
      };
      if (!description || description.length < 18) {
        description = makeLongDescription(idea, scriptLines);
        console.warn('[SECTION4][DESC][ENFORCE] Description missing or generic, generating pro fallback:', description);
      }

      // --- Tags ---
      const makeTagList = (idea, scriptLines, extra = []) => {
        let tagsArr = [
          ...idea.toLowerCase().split(/\W+/),
          ...scriptLines.join(' ').toLowerCase().split(/\W+/)
        ]
        .filter(w => w.length > 2)
        .map(w => w.trim())
        .concat(extra || []);
        // Deduplicate and cap
        tagsArr = Array.from(new Set(tagsArr)).filter(Boolean);
        // Remove weak/boring tags
        const ban = ['title','description','tags','secret','facts','video','shorts','story','like','share','most','watch'];
        tagsArr = tagsArr.filter(t => !ban.includes(t));
        // Hard boost: always keep the first two keywords
        if (tagsArr.length > 12) tagsArr = tagsArr.slice(0, 12);
        if (tagsArr.length < 8) tagsArr = tagsArr.concat(['viral','trending','mustsee','amazing','new','history','now','explained','bizarre','mindblowing']).slice(0,12);
        return tagsArr.join(' ');
      };
      if (!tags || tags.split(' ').length < 6) {
        tags = makeTagList(idea, scriptLines);
        console.warn('[SECTION4][TAGS][ENFORCE] Tags missing or generic, generating upgraded fallback:', tags);
      }

      if (!scriptLines.length) scriptLines = ['Something went wrong generating the script.'];

      // === Log Results
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
