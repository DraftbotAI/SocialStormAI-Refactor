// ===========================================================
// SECTION 10J: QUESTION FALLBACK VISUAL HELPER (GPT-powered)
// For question lines, returns the *single best literal visual subject*
// (e.g. for "Why do cats purr?" => "cat closeup purring").
// Never generic/question mark. Max logging, bulletproof, never blocks.
// Ultra strict, never silent-fails, returns null if no valid match.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('[10J][FATAL] Missing OPENAI_API_KEY in environment!');
}

const SYSTEM_PROMPT = `
You are an expert viral video editor and visual director.
Given a script line that is a QUESTION, return the SINGLE BEST literal, visual subject or action to show for the core topic.
Strict rules:
- NEVER return a question mark, emoji, generic, or abstract visual ("someone thinking", "question mark", "person", "something").
- Return a concrete visual, e.g. "cat closeup purring", "stormy sky lightning".
- Never output a full sentence, explanation, or metaphor.
- Output must be 5-10 words, single best subject.
- If not a question, say "NO_MATCH".

Examples:
Input: "Why do cats purr?" Output: "cat closeup purring"
Input: "What causes lightning?" Output: "stormy sky lightning"
Input: "How do you become successful?" Output: "successful businessperson holding trophy"
Input: "Who built the pyramids?" Output: "ancient Egyptians building pyramids"
Input: "How can I focus better?" Output: "person studying at desk with books"
Input: "Is sugar bad for you?" Output: "bowl of sugar cubes on table"
`;

async function extractQuestionVisual(sceneLine, mainTopic = '') {
  if (!OPENAI_API_KEY) {
    throw new Error('[10J][FATAL] No OpenAI API key!');
  }
  try {
    const prompt = `
Script line: "${sceneLine}"
Main topic: "${mainTopic || ''}"
If this line is a question, return ONLY the best literal visual subject or action (5-10 words, never a sentence).
If not a question, strictly reply "NO_MATCH".
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

    // Block all non-matches, generics, and junk
    if (
      !visual ||
      visual.length < 3 ||
      visual.toUpperCase() === "NO_MATCH" ||
      visual.toLowerCase().includes('question mark') ||
      visual.includes('?') ||
      [
        'something', 'someone', 'person', 'people', 'scene', 'man', 'woman',
        'it', 'thing', 'they', 'we', 'body', 'face', 'eyes'
      ].includes(visual.toLowerCase())
    ) {
      console.warn('[10J][NO_MATCH] Not a question, or visual too generic:', visual, '| Input:', sceneLine);
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
