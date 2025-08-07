// ===========================================================
// SECTION 10K: MULTI-SUBJECT HANDLER (GPT-powered, Bulletproof)
// For lines with multiple valid subjects, returns a combined viral visual subject
// (e.g., "cat and dog playing together"). Used to avoid boring or split scenes.
// Returns a single visual subject (combo or most viral), never a full sentence.
// MAX LOGGING every step, never silent-fails, crash-proof.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('[10K][FATAL] Missing OPENAI_API_KEY in environment!');
}

const SYSTEM_PROMPT = `
You are a viral video editor and expert visual scene picker.
Given a script line with multiple real, visual subjects or items (e.g. "Cats and dogs are both popular pets."), do the following:
- Return the SINGLE BEST viral, literal, visually clickable combination if possible (e.g. "cute cat and dog playing together").
- If no combo is possible, return the single most viral or visually strong subject from the line.
Strict rules:
- NEVER output a full sentence, explanation, metaphor, or generic ("someone", "person", "question mark", "thing", "it", etc).
- Always use the shortest, most visual phrasing (max 10 words).
- Return only the subject/action/scene, not a caption.
Examples:
Input: "Cats and dogs are both popular pets." Output: "cute cat and dog together"
Input: "Pizza and burgers are classic foods." Output: "pizza and burger side by side"
Input: "Sun and rain can happen together." Output: "sun shining with rain"
Input: "Eiffel Tower and Arc de Triomphe are Paris icons." Output: "eiffel tower and arc de triomphe together"
If only one strong subject, return just that.
If not applicable, reply with "NO_MATCH".
`;

async function extractMultiSubjectVisual(sceneLine, mainTopic = '') {
  if (!OPENAI_API_KEY) {
    throw new Error('[10K][FATAL] No OpenAI API key!');
  }
  try {
    const prompt = `
Script line: "${sceneLine}"
Main topic: "${mainTopic || ''}"
If the line includes multiple visual subjects or items, return the best viral COMBO visual (combo or side-by-side, etc).
If not, return just the single top visual subject (never generic).
Only output the visual subject, never a sentence or explanation.
If not applicable, reply "NO_MATCH".
    `.trim();

    console.log(`[10K][PROMPT] ${prompt}`);

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 25,
        temperature: 0.35,
        n: 1,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    let raw = response.data?.choices?.[0]?.message?.content?.trim() || '';
    raw = raw.replace(/^output\s*[:\-]\s*/i, '')
      .replace(/["'.]+$/g, '')
      .replace(/^(show|display|combo)[:\-\s]*/i, '')
      .trim();

    let visual = raw;

    // Block generic/abstract outputs
    if (
      !visual ||
      visual.toUpperCase() === "NO_MATCH" ||
      visual.length < 3 ||
      [
        'something', 'someone', 'person', 'people', 'scene', 'man', 'woman',
        'it', 'thing', 'they', 'we', 'body', 'face', 'eyes', 'animal', 'animals'
      ].includes(visual.toLowerCase())
    ) {
      console.warn('[10K][NO_MATCH] No strong multi-subject visual:', visual, '| Input:', sceneLine);
      return null;
    }

    console.log(`[10K][RESULT] "${sceneLine}" => "${visual}"`);
    return visual;
  } catch (err) {
    if (err.response) {
      console.error('[10K][ERR][HTTP]', err.response.status, err.response.data);
    } else {
      console.error('[10K][ERR]', err);
    }
    return null;
  }
}

module.exports = { extractMultiSubjectVisual };
