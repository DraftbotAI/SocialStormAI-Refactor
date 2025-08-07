// ===========================================================
// SECTION 10L: REPETITION BLOCKER & VARIETY HANDLER
// Detects if a subject/visual was recently used too many times.
// If repeated, returns a new angle, "text-only" scene, or "variety" fallback.
// Ensures scene variety for maximum retention and viral watch-through.
// MAX LOGGING every step, crash-proof, never blocks scene flow.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('[10L][FATAL] Missing OPENAI_API_KEY in environment!');
}

/**
 * Checks the last N subjects for repetition and, if detected,
 * returns a new visual suggestion for variety.
 *
 * @param {string} subject          The current proposed visual subject
 * @param {Array<string>} prevSubjects  Array of previous visual subjects (latest last)
 * @param {object} options              { maxRepeats: 2, varietyMode: "auto" }
 * @returns {Promise<string>} New subject suggestion, "text-only", or same subject if no repeat.
 */
async function breakRepetition(subject, prevSubjects = [], options = {}) {
  const maxRepeats = options.maxRepeats || 2;
  const varietyMode = options.varietyMode || 'auto'; // 'auto', 'text-only', 'emoji', etc.

  // Count how many times the subject appears in the last N
  const normalized = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const currNorm = normalized(subject);
  const recent = prevSubjects.slice(-maxRepeats).map(normalized);
  const repeatCount = recent.filter(s => s === currNorm).length;

  console.log(`[10L][CHECK] "${subject}" | recent(${maxRepeats}): ${JSON.stringify(recent)} | repeats: ${repeatCount}`);

  // If not repeated over threshold, return subject as-is
  if (repeatCount < maxRepeats) {
    return subject;
  }

  // Otherwise, ask GPT for a new angle or fallback variety visual
  if (!OPENAI_API_KEY) {
    console.warn('[10L][NO_API] No OpenAI key for variety suggestion.');
    return "text-only viral caption card";
  }

  const SYSTEM_PROMPT = `
You are an expert viral video editor.
The last scenes all used the same visual subject: "${subject}".
Suggest a new visual scene, angle, or style for the next scene to break the repetition.
Options include: a new camera angle, a different context, a "viral text card" (text-only), a dramatic emoji/transition card, or a related but new subject.
Be brief. Output only the new visual suggestion (never a sentence).
Examples:
Input: "cat closeup" (after 3 repeats) => "cat jumping from table", "cat text-only caption card", "animated cat emoji card"
`;

  const prompt = `
Current subject: "${subject}"
Recent subjects: ${JSON.stringify(prevSubjects.slice(-maxRepeats))}
Suggest a new visual for variety. Output only the subject or fallback (5-10 words).
If you can't, reply "text-only viral caption card".
  `.trim();

  try {
    console.log(`[10L][PROMPT] ${prompt}`);
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 25,
        temperature: 0.6,
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
    if (!raw || raw.length < 3) raw = "text-only viral caption card";

    console.log(`[10L][RESULT] "${subject}" => "${raw}"`);
    return raw;
  } catch (err) {
    if (err.response) {
      console.error('[10L][ERR][HTTP]', err.response.status, err.response.data);
    } else {
      console.error('[10L][ERR]', err);
    }
    return "text-only viral caption card";
  }
}

module.exports = { breakRepetition };
