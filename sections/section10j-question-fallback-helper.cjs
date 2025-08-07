// ===========================================================
// SECTION 10J: QUESTION FALLBACK VISUAL HELPER (GPT-powered)
// For question lines, returns the *single best literal visual subject*
// (e.g. for "Why do cats purr?" => "cat closeup purring").
// Never generic/question mark. Max logging, bulletproof, never blocks.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('[10J][FATAL] Missing OPENAI_API_KEY in environment!');
}

const SYSTEM_PROMPT = `
You are an expert at making viral video shorts.
Given a script line that is a QUESTION, do this:
- Return the SINGLE BEST literal visual subject or action to show for the core topic.
- Never output a question mark or generic (never "someone thinking", never "question mark").
- Return a concrete visual, e.g. "cat closeup purring", "stormy sky lightning".
- Never a full sentence or explanation, never a metaphor.
Examples:
Input: "Why do cats purr?" Output: "cat closeup purring"
Input: "What causes lightning?" Output: "stormy sky lightning"
Input: "How do you become successful?" Output: "successful businessperson holding trophy"
Input: "Who built the pyramids?" Output: "ancient Egyptians building pyramids"
`;

async function extractQuestionVisual(sceneLine, mainTopic = '') {
  if (!OPENAI_API_KEY) {
    throw new Error('[10J][FATAL] No OpenAI API key!');
  }
  try {
    const prompt = `
Script line: "${sceneLine}"
Main topic: "${mainTopic || ''}"
If the line is a question, return ONLY the single best literal visual subject or action (5-10 words).
If not a question, reply "NO_MATCH".
    `.trim();

    console.log(`[10J][PROMPT] ${prompt}`);

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 25,
        temperature: 0.4,
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
    raw = raw.replace(/^output\s*[:\-]\s*/i, '').replace(/["'.]+$/g, '').trim();

    let visual = raw;

    if (
      !visual ||
      visual.toUpperCase() === "NO_MATCH" ||
      visual.length < 3 ||
      [
        'something', 'someone', 'person', 'people', 'scene', 'man', 'woman',
        'it', 'thing', 'they', 'we', 'body', 'face', 'eyes'
      ].includes(visual.toLowerCase())
    ) {
      console.warn('[10J][NO_MATCH] Not a question, or visual too generic:', visual);
      return null;
    }

    console.log(`[10J][RESULT] "${sceneLine}" => "${visual}"`);
    return visual;
  } catch (err) {
    if (err.response) {
      console.error('[10J][ERR][HTTP]', err.response.status, err.response.data);
    } else {
      console.error('[10J][ERR]', err);
    }
    return null;
  }
}

module.exports = { extractQuestionVisual };
