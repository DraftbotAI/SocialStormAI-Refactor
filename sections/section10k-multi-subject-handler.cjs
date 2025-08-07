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
You are an expert short-form video editor.
Given a script line with multiple subjects or items (e.g., "Cats and dogs are both popular pets"), return the SINGLE best viral visual subject that combines them, if possible (e.g., "cute cat and dog together").
If a true combo is not possible, return the MOST viral or visually strong subject from the line.
Never output a sentence or explanation, only the core visual subject or action (max 10 words).
Examples:
Input: "Cats and dogs are both popular pets." Output: "cute cat and dog together"
Input: "Pizza and burgers are classic foods." Output: "pizza and burger side by side"
Input: "Sun and rain can happen together." Output: "sun shining with rain"
If only one strong subject, return just that.
`;

async function extractMultiSubjectVisual(sceneLine, mainTopic = '') {
  if (!OPENAI_API_KEY) {
    throw new Error('[10K][FATAL] No OpenAI API key!');
  }
  try {
    const prompt = `
Script line: "${sceneLine}"
Main topic: "${mainTopic || ''}"
If the line includes multiple visual subjects, return the best viral COMBO visual.
If not, return just the top subject. Only the subject, never a sentence.
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
        temperature: 0.5,
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
      console.warn('[10K][NO_MATCH] No strong multi-subject visual:', visual);
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
