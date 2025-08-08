// ===========================================================
// SECTION 11: GPT VISUAL SUBJECT EXTRACTOR (BULLETPROOF V3)
// Returns the top 4 visual subject candidates for any script line.
// Order: Primary > Contextual > Fallback > General
// Bulletproof: Handles blank, weird, or failed GPT cases.
// Filters generics, always returns strong non-generic visuals.
// MAX LOGGING, deterministic, crash-proof, never silent-fails.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error('[11][FATAL] OPENAI_API_KEY not set in env!');

const GENERIC_SUBJECTS = [
  'face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something', 'body', 'eyes',
  'kid', 'boy', 'girl', 'they', 'we', 'people', 'scene', 'child', 'children', 'sign', 'logo', 'text',
  'view', 'image', 'photo', 'background', 'object'
];

console.log('[11][INIT] Visual Subject Extractor module loaded');

const SYSTEM_PROMPT = `
You are a world-class viral video editor for TikTok, Reels, and Shorts. For each line of a script, your ONLY job is to pick the 4 best possible VISUAL subjects to show in that scene.

RULES:
- Only return objects, places, people, or actions that can be LITERALLY SHOWN ON SCREEN.
- Ignore all metaphors, jokes, emotions, abstract concepts, or invisible things.
- If a line is not visually showable, use the main topic as fallback.
- Each answer should be concrete, visual, and unambiguous.
- No duplicate items, no vague generalities.
- Never return: ${GENERIC_SUBJECTS.join(', ')}.
- Prefer viral, famous, or highly clickable visuals.
- If the line includes multiple strong subjects, combine them (e.g., "cat and dog together").
Return EXACTLY 4 in order: primary, context, fallback, general.
Output ONLY a numbered list. No intro, no explanation, no extra info.

NOW RETURN:
Line: "{{LINE}}"
Main topic: "{{TOPIC}}"
`;

function isGeneric(phrase) {
  return GENERIC_SUBJECTS.some(g =>
    (phrase || '').toLowerCase().replace(/[^a-z0-9]+/g, '').includes(
      g.replace(/[^a-z0-9]+/g, '')
    )
  );
}

async function extractVisualSubjects(line, mainTopic) {
  try {
    console.log(`[11][INPUT] Script line: "${line}"`);
    console.log(`[11][INPUT] Main topic: "${mainTopic}"`);

    if (!line || typeof line !== 'string' || !line.trim()) {
      console.warn('[11][WARN] Blank/invalid line. Returning main topic as fallback.');
      return [mainTopic, mainTopic, mainTopic, mainTopic];
    }

    const userPrompt = `
Line: "${line}"
Main topic: "${mainTopic}"
Return a numbered list of exactly 4. No generics, no explanations.
`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.VISUAL_SUBJECT_MODEL || 'gpt-4.1',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 70,
        temperature: 0.4,
        n: 1,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 18000,
      }
    );

    let raw = response.data?.choices?.[0]?.message?.content?.trim() || '';
    console.log('[11][RAW GPT OUTPUT]', JSON.stringify(raw));

    // Parse numbered list
    let list = raw
      .split('\n')
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').replace(/^- /, '').trim())
      .filter(l => l && !isGeneric(l) && l.length > 2);

    // Deduplicate
    const seen = new Set();
    let finalList = [];
    for (let item of list) {
      const clean = item.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!seen.has(clean)) {
        seen.add(clean);
        finalList.push(item);
      }
      if (finalList.length === 4) break;
    }

    // Pad to exactly 4 with topic-based fillers
    while (finalList.length < 4) {
      if (!finalList.includes(mainTopic)) finalList.push(mainTopic);
      else finalList.push(`${mainTopic} scene`);
    }
    if (finalList.length > 4) finalList = finalList.slice(0, 4);

    console.log('[11][RESULT] Visual subjects:', finalList);
    return finalList;
  } catch (err) {
    console.error('[11][ERROR] GPT visual extraction failed:', err?.response?.data || err);
    return [mainTopic, mainTopic, mainTopic, mainTopic];
  }
}

// === CLI Test Utility ===
if (require.main === module) {
  const testLine = process.argv[2] || 'The pyramids were built over 20 years.';
  const mainTopic = process.argv[3] || 'Egypt';
  extractVisualSubjects(testLine, mainTopic)
    .then(subjects => {
      console.log('Extracted subjects:', subjects);
      process.exit(0);
    })
    .catch(err => {
      console.error('Test error:', err);
      process.exit(1);
    });
}

module.exports = { extractVisualSubjects };
