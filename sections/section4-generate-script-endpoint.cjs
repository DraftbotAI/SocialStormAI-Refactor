/* ===========================================================
   SECTION 4: /api/generate-script ENDPOINT (Modular, PRO)
   -----------------------------------------------------------
   - Exports registerGenerateScriptEndpoint(app, openai)
   - MAX logging everywhere
   - 2024-08: ALWAYS starts script with viral, topic-rich hook
   - 2025-08: OPTIONAL story-style ending line (ENV: ADD_STORY_ENDING=1)
   - 2025-08: Hidden SCENE_MAP JSON for subject extraction (ENV: SCRIPT_SCENEMAP=1)
   - 2025-08: Upgraded metadata quality (Title/Description/Tags) + smart fallbacks
   - 2025-08: Varied endings (fun/happy/dramatic) — randomized each run
   - Robust OpenAI prompt, post-validation, error-proofed
   =========================================================== */

console.log('\n========== [SECTION4][INIT] /api/generate-script Endpoint ==========');

// Usage (in main server file):
// const registerGenerateScriptEndpoint = require('./sections/section4-generate-script-endpoint.cjs');
// registerGenerateScriptEndpoint(app, openai);

/** Lightweight stopword list for tag cleaning */
const SECTION4_STOPWORDS = new Set([
  'the','a','an','and','or','but','so','because','about','into','onto','with','from','over','under','of','in','on','to','for','by',
  'is','are','was','were','be','been','being','this','that','these','those','it','its','as','at','if','then','than','there','their',
  'you','your','yours','we','our','ours','they','them','he','she','his','her','i','me','my','mine','us'
]);

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
      // === Feature flags ===
      const addEnding = (process.env.ADD_STORY_ENDING ?? '1') !== '0';
      const enableSceneMap = (process.env.SCRIPT_SCENEMAP ?? '1') !== '0';
      console.log(`[SECTION4][FLAGS] ADD_STORY_ENDING=${addEnding ? 'ON' : 'OFF'} | SCRIPT_SCENEMAP=${enableSceneMap ? 'ON' : 'OFF'}`);

      // === Build Prompt (with optional SCENE_MAP instructions) ===
      let prompt = `
You are a viral YouTube Shorts scriptwriter.

Write an ultra-engaging, narratable script for the topic: "${idea}"

== ABSOLUTE RULES ==
- The FIRST line MUST clearly state the real topic, acting as a viral, punchy hook. Never vague, never rhetorical, never a question, and no "Did you ever wonder" or "Let's find out". It MUST include the actual subject in plain English, not just a teaser.
- The first line should be instantly clear, not a metaphor or general statement. (Example: "The Trevi Fountain isn’t just a landmark—here’s why everyone is obsessed with it." or "Here are the secrets hidden inside the world’s most famous landmarks.")
- Each following line = one scene. Short, punchy, narratable. No camera directions, hashtags, emojis, or quote marks.
- Make every fact feel like a "secret" or powerful insight.
- Use 6–10 total lines (including the hook).
- No animal metaphors, off-topic jokes, or padding.
- End with a strong, mysterious, or memorable closing line.

== STYLE ==
- Conversational, vivid, friendly, clever.
- Balanced tone: humor=medium, drama=medium, info=high.
- Each line must include one concrete, verifiable idea.
- Humor only if natural—never forced.

== METADATA (HIGH QUALITY) ==
Return at the end:
Title: [6–9 words, includes the real topic, curiosity + clarity, no quotes, no emojis]
Description: [1–2 tight sentences. Lead with the value the viewer gets; include 1–2 concrete terms from the script; no hashtags]
Tags: [Up to 5 single words, space-separated, lowercase, no commas, no hashtags. Avoid stopwords; prefer specific nouns (e.g., "trevi", "fountain", "rome", "history", "travel")]

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
`.trim();

      if (enableSceneMap) {
        prompt += `

== SCENE MAP (for internal use) ==
After the metadata above, append a block starting with exactly:
SCENE_MAP:
followed by a valid JSON array (no trailing commentary). One object per script line in order (including the first hook line and your final ending line). Use this schema:
[
  {"idx":0,"subject":"<primary visual subject for line 0>",
   "alternates":["alt1","alt2"],
   "must_tokens":["token1","token2"],
   "mood":"funny+dramatic+info"}
  // ...repeat for every line
]
- "subject": a concrete, visual noun phrase (e.g., "Trevi Fountain", "manatee", "Eiffel Tower at night").
- "alternates": 1–3 reasonable substitutes (e.g., "Rome fountain","Italian landmark").
- "must_tokens": 1–3 essential tokens helpful for filename/tag matching (lowercase, no spaces if possible).
- "mood": the string "funny+dramatic+info".
- Ensure JSON is strictly valid.
`;
      }

      prompt += `

Now write a script for: "${idea}"
`.trim();

      // === OpenAI call ===
      const completion = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        temperature: 0.88,
        max_tokens: 1200,
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
      let sceneMap = null;

      // Parse lines and metadata
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      const titleIdx    = lines.findIndex(l => /^title\s*:/i.test(l));
      const descIdx     = lines.findIndex(l => /^description\s*:/i.test(l));
      const tagsIdx     = lines.findIndex(l => /^tags?\s*:/i.test(l));
      const metaStartCandidates = [titleIdx, descIdx, tagsIdx].filter(x => x > -1).sort((a, b) => a - b);
      const metaStart  = (metaStartCandidates.length ? metaStartCandidates[0] : lines.length);

      scriptLines = lines.slice(0, metaStart).filter(l =>
        !/^title\s*:/i.test(l) &&
        !/^description\s*:/i.test(l) &&
        !/^tags?\s*:/i.test(l) &&
        !/^scene_map\s*:/i.test(l)
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
          let topic = idea.replace(/^(the|a|an)\s+/i, '').trim();
          if (!topic) topic = 'this topic';
          const viralHook = `In 60 seconds, here’s exactly what you’ll learn about ${topic}.`;
          console.warn('[SECTION4][HOOK][ENFORCE] First line did not mention subject, auto-replacing:', firstLine, '→', viralHook);
          scriptLines[0] = viralHook;
        } else {
          console.log('[SECTION4][HOOK][INFO] First line already includes subject; keeping generated hook.');
        }
      }

      // === OPTIONAL: Append varied story-style ending line (ENV: ADD_STORY_ENDING) ===
      if (addEnding) {
        let topic = idea.replace(/^(the|a|an)\s+/i, '').trim();
        if (!topic) topic = 'this topic';

        // Curated endings — fun, happy, punchy, dramatic; randomized each run.
        const ENDINGS = [
          `And that’s your quick tour of ${topic}.`,
          `Short version? ${topic} is way cooler than it looks.`,
          `Next time you see ${topic}, you’ll spot the hidden details.`,
          `${topic}, decoded in under a minute—nice.`,
          `Consider yourself briefed on ${topic}.`,
          `That’s ${topic} in a nutshell.`,
          `From now on, ${topic} won’t look the same.`,
          `Bookmark this—${topic} just got interesting.`,
          `Okay, ${topic} fan unlocked. On to the next.`,
          `Boom—${topic}, explained.`,
          `That’s the quick breakdown of ${topic}.`,
          `Alright, that’s ${topic}. See you in the next one.`
        ];
        const idx = Math.floor(Math.random() * ENDINGS.length);
        const closing = ENDINGS[idx];

        console.log(`[SECTION4][ENDING][INFO] Appending closing line (index=${idx}): ${closing}`);
        scriptLines.push(closing);
      } else {
        console.log('[SECTION4][ENDING][SKIP] ADD_STORY_ENDING disabled.');
      }

      // Cap at 10 lines (including hook and optional ending)
      if (scriptLines.length > 10) {
        console.warn('[SECTION4][LIMIT][WARN] Script exceeded 10 lines; trimming to 10.');
        scriptLines = scriptLines.slice(0, 10);
      }

      // Extract metadata from model output
      for (const l of lines.slice(metaStart)) {
        if (/^title\s*:/i.test(l)) title = l.replace(/^title\s*:/i, '').trim().replace(/^["']|["']$/g, '');
        else if (/^description\s*:/i.test(l)) description = l.replace(/^description\s*:/i, '').trim();
        else if (/^tags?\s*:/i.test(l)) tags = l.replace(/^tags?\s*:/i, '').trim().toLowerCase();
      }

      // === Parse SCENE_MAP JSON (hidden, behind-the-scenes) ===
      if (enableSceneMap) {
        try {
          const smMatch = raw.match(/SCENE_MAP\s*:\s*([\s\S]+)$/i);
          if (smMatch && smMatch[1]) {
            const jsonRaw = smMatch[1].trim();
            sceneMap = JSON.parse(jsonRaw);
            if (!Array.isArray(sceneMap)) {
              console.warn('[SECTION4][SCENEMAP][WARN] Parsed SCENE_MAP is not an array; discarding.');
              sceneMap = null;
            } else {
              console.log('[SECTION4][SCENEMAP][INFO] Parsed SCENE_MAP entries:', sceneMap.length);
              const maxIdx = scriptLines.length - 1;
              sceneMap = sceneMap
                .filter(item => typeof item?.idx === 'number' && item.idx >= 0 && item.idx <= maxIdx)
                .map(item => ({
                  idx: item.idx,
                  subject: typeof item.subject === 'string' ? item.subject : '',
                  alternates: Array.isArray(item.alternates) ? item.alternates.slice(0, 3) : [],
                  must_tokens: Array.isArray(item.must_tokens) ? item.must_tokens.slice(0, 3) : [],
                  mood: typeof item.mood === 'string' ? item.mood : 'funny+dramatic+info'
                }));
              console.log('[SECTION4][SCENEMAP][INFO] Filtered to script length:', sceneMap.length);
            }
          } else {
            console.log('[SECTION4][SCENEMAP][SKIP] No SCENE_MAP block found in model output.');
          }
        } catch (smErr) {
          console.warn('[SECTION4][SCENEMAP][ERR] Failed to parse SCENE_MAP JSON:', smErr?.message || smErr);
          sceneMap = null;
        }
      }

      // === Metadata Fallbacks & Upgrades ===
      const topic = (idea || '').replace(/^(the|a|an)\s+/i, '').trim() || 'this topic';

      function buildFallbackTags(limit = 5) {
        const pool = [idea, ...scriptLines.slice(0, 6)].join(' ').toLowerCase();
        const words = pool
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .map(w => w.trim());
        const counts = new Map();
        for (const w of words) {
          if (w.length < 4) continue;
          if (SECTION4_STOPWORDS.has(w)) continue;
          counts.set(w, (counts.get(w) || 0) + 1);
        }
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
        const uniq = [];
        for (const w of sorted) {
          if (!uniq.includes(w)) uniq.push(w);
          if (uniq.length >= limit) break;
        }
        return uniq;
      }

      function sanitizeTags(input) {
        let parts = [];
        if (input) {
          parts = input.toLowerCase().split(/\s+/).filter(Boolean);
        }
        if (!parts.length) parts = buildFallbackTags(5);
        const out = [];
        for (const t of parts) {
          const tok = t.replace(/[^a-z0-9]/g, '');
          if (!tok) continue;
          if (tok.length < 3) continue;
          if (SECTION4_STOPWORDS.has(tok)) continue;
          if (!out.includes(tok)) out.push(tok);
          if (out.length >= 5) break;
        }
        if (!out.length) out.push('viral');
        return out.join(' ');
      }

      function buildFallbackTitle() {
        const topTags = buildFallbackTags(3);
        const focus = topic.charAt(0).toUpperCase() + topic.slice(1);
        if (topTags.length >= 2) {
          return `${focus}: ${topTags[0]} & ${topTags[1]} You Should Know`;
        }
        return `The Real Story of ${focus}`;
      }

      function buildFallbackDescription(finalTagsStr) {
        const tks = (finalTagsStr || '').split(/\s+/).filter(Boolean);
        const hints = tks.slice(0, 2).join(', ');
        if (hints) {
          return `In under a minute, get the key facts about ${topic} — including ${hints}.`;
        }
        return `In under a minute, get the key facts about ${topic}.`;
      }

      const originalTitle = title;
      const originalDesc  = description;
      const originalTags  = tags;

      if (!title || title.length < 6 || title.toLowerCase() === idea.toLowerCase()) {
        title = buildFallbackTitle();
        console.log('[SECTION4][META][TITLE][FALLBACK] Rebuilt title:', title, '| original:', originalTitle);
      } else {
        console.log('[SECTION4][META][TITLE][OK]', title);
      }

      tags = sanitizeTags(tags);
      if (tags !== originalTags) {
        console.log('[SECTION4][META][TAGS][SANITIZED]', tags, '| original:', originalTags);
      } else {
        console.log('[SECTION4][META][TAGS][OK]', tags);
      }

      if (!description || description.length < 20) {
        description = buildFallbackDescription(tags);
        console.log('[SECTION4][META][DESC][FALLBACK] Rebuilt description:', description, '| original:', originalDesc);
      } else {
        const lc = description.toLowerCase();
        if (!lc.includes(topic.toLowerCase().split(' ')[0])) {
          description = `${description} This short covers ${topic}.`;
          console.log('[SECTION4][META][DESC][UPGRADE] Ensured topic mention.');
        } else {
          console.log('[SECTION4][META][DESC][OK]', description);
        }
      }

      if (!scriptLines.length) scriptLines = ['Something went wrong generating the script.'];

      console.log('[SECTION4][PARSED] script lines:', scriptLines.length, scriptLines);
      console.log('[SECTION4][PARSED] title:', title);
      console.log('[SECTION4][PARSED] description:', description);
      console.log('[SECTION4][PARSED] tags:', tags);
      if (enableSceneMap) {
        console.log('[SECTION4][PARSED] sceneMap entries:', sceneMap ? sceneMap.length : 0);
      }

      const responsePayload = {
        success: true,
        script: scriptLines.join('\n'),
        title,
        description,
        tags
      };
      if (enableSceneMap && sceneMap) {
        responsePayload.sceneMap = sceneMap; // backend-only consumer
      }

      res.json(responsePayload);

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
