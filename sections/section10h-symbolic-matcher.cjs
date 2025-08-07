// ===========================================================
// SECTION 10H: SYMBOLIC SCENE MATCHER (GPT-powered, Bulletproof)
// Handles metaphors, abstract, emotion, question, and multi-subject lines.
// Returns a smart visual subject (single, literal, visual, non-generic).
// Used as a fallback or enhancement alongside visual subject extractor.
// MAX LOGGING at every step, crash-proof, never silent-fails.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('[10H][FATAL] Missing OPENAI_API_KEY in environment!');
}

const SYSTEM_PROMPT = `
You are an expert video editor and visual director.
Given a scene line from a viral video script, extract the single best visual subject or action to display on screen.
- NEVER return a metaphor, wordplay, or abstract concept.
- If the line is a question, return a visual that best illustrates the core topic.
- If the line is about emotion, return a literal facial expression or human action showing that emotion.
- For symbolic/abstract topics (e.g. "royalty", "creativity", "victory"), return a specific, visually clear scene (e.g. "royal figure in purple robe", "person with lightbulb", "winner raising trophy").
- If multiple valid options, prefer the most famous, vivid, or viral.
- Return ONLY a single visual subject, never a full sentence.
Examples:
Input: "Why is purple the color of royalty?" Output: "royal figure in purple robe"
Input: "How do you deal with heartbreak?" Output: "sad person alone on bench"
Input: "Creativity can be hard to explain." Output: "person painting with bright colors"
Input: "The thrill of victory" Output: "athlete holding gold medal"
Input: "Feeling anxious lately?" Output: "worried woman biting nails"
`;

async function extractSymbolicVisualSubject(sceneLine, mainTopic = '') {
  if (!OPENAI_API_KEY) {
    throw new Error('[10H][FATAL] No OpenAI API key for symbolic matcher!');
  }
  try {
    const prompt = `
Script line: "${sceneLine}"
Main topic: "${mainTopic || ''}"
What is the *single best literal visual subject or action* to show in a short-form video for this line?
Return ONLY the core visual subject or action in 5-10 words. Never output a sentence or explanation.
    `.trim();

    console.log(`[10H][PROMPT] ${prompt}`);

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

    const raw = response.data?.choices?.[0]?.message?.content?.trim() || '';
    let visual = raw
      .replace(/^output\s*[:\-]\s*/i, '')
      .replace(/["'.]+$/g, '')
      .replace(/^(show|display)\s*/i, '')
      .trim();

    // Sanitize: never empty, never generic
    if (
      !visual ||
      visual.length < 3 ||
      [
        'something', 'someone', 'person', 'people', 'scene', 'man', 'woman', 
        'it', 'thing', 'they', 'we', 'body', 'face', 'eyes'
      ].includes(visual.toLowerCase())
    ) {
      console.warn('[10H][WARN] Symbolic subject too generic or empty:', visual);
      visual = mainTopic || sceneLine;
    }

    console.log(`[10H][RESULT] "${sceneLine}" => "${visual}"`);
    return visual;
  } catch (err) {
    if (err.response) {
      console.error('[10H][ERR][HTTP]', err.response.status, err.response.data);
    } else {
      console.error('[10H][ERR]', err);
    }
    return mainTopic || sceneLine;
  }
}

module.exports = { extractSymbolicVisualSubject };

