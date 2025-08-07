// ===========================================================
// SECTION 10I: EMOTION/ACTION/TRANSITION HELPER (GPT-powered, Bulletproof)
// Detects if a line is about an emotion, action cue, or transition.
// Returns a *literal* visual subject (face/action/scene/transition visual).
// Used as a plug-in fallback or enhancer in scene matching.
// MAX LOGGING every step, never blocks, never returns a generic.
// Never silent-fails. Returns null if no match (for fallback logic).
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('[10I][FATAL] Missing OPENAI_API_KEY in environment!');
}

const SYSTEM_PROMPT = `
You are an expert viral video editor and AI visual subject picker.
Given a script line from a video, follow these strict rules:
1. If the line expresses an EMOTION, return a *specific*, literal, visual of a person showing that emotion (e.g. "worried man biting nails", "happy woman smiling", "child jumping for joy").
2. If it's an ACTION CUE or TRANSITION (e.g. "Let's get started", "Meanwhile", "Later that day", "Moving on"), return a literal visual scene or transition (e.g. "scene change animation", "clock spinning", "city time-lapse", "fast moving clouds").
3. Otherwise, say "NO_MATCH".
- Never return a metaphor, generic, or abstract answer.
- Always output ONLY the best visual subject or action, never a sentence or explanation, 5-10 words max.
- Never output: "person", "people", "man", "woman", "something", "someone", "thing", "scene".
- If nothing matches, strictly reply "NO_MATCH".

Examples:
Input: "Feeling anxious?" Output: "worried woman biting nails"
Input: "Let's get started!" Output: "scene change animation"
Input: "Meanwhile, across town..." Output: "city time-lapse"
Input: "Later that day" Output: "clock spinning"
Input: "He's overjoyed" Output: "man jumping for joy"
Input: "Now for the real secret" Output: "hand pulling cloth to reveal"
Input: "What a plot twist!" Output: "face with shocked expression"
`;

async function extractEmotionActionVisual(sceneLine, mainTopic = '') {
  if (!OPENAI_API_KEY) {
    throw new Error('[10I][FATAL] No OpenAI API key!');
  }
  try {
    const prompt = `
Script line: "${sceneLine}"
Main topic: "${mainTopic || ''}"
If this is emotion/action/transition, return ONLY a literal visual subject or action (never a full sentence).
If not, strictly reply "NO_MATCH".
    `.trim();

    console.log(`[10I][PROMPT] ${prompt}`);

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 24,
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

    // Block all generics, abstract, empty, or NO_MATCH responses.
    if (
      !visual ||
      visual.length < 3 ||
      visual.toUpperCase() === "NO_MATCH" ||
      [
        'something','someone','person','people','scene','man','woman','it','thing',
        'they','we','body','face','eyes','child','children'
      ].includes(visual.toLowerCase())
    ) {
      console.warn('[10I][NO_MATCH] No valid emotion/action/transition visual:', visual, '| Input:', sceneLine);
      return null;
    }

    // Log output and return best match.
    console.log(`[10I][RESULT] "${sceneLine}" => "${visual}"`);
    return visual;
  } catch (err) {
    if (err.response) {
      console.error('[10I][ERR][HTTP]', err.response.status, err.response.data);
    } else {
      console.error('[10I][ERR]', err);
    }
    return null;
  }
}

module.exports = { extractEmotionActionVisual };
