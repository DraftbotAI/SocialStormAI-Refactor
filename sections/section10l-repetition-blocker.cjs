// ===========================================================
// SECTION 10L: REPETITION BLOCKER & VARIETY HANDLER (Bulletproof)
// Detects if a subject/visual was recently used too many times in the video.
// If repeated, returns a new angle, text-only scene, emoji, or variety fallback.
// MAX LOGGING every step, never blocks, always returns a valid subject.
// Anti-generic, anti-silent, anti-infinite. Foolproof.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('[10L][FATAL] Missing OPENAI_API_KEY in environment!');
}

// Extra: Even more generic subjects to block
const GENERIC_SUBJECTS = [
  'face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something',
  'body', 'eyes', 'people', 'scene', 'child', 'children', 'sign', 'logo', 'text',
  'boy', 'girl', 'they', 'we', 'background', 'sky', 'view', 'caption', 'photo'
];

// Normalizer for subject comparison (strict, ignores punctuation/case)
function normalized(str = '') {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function isGeneric(subject = '') {
  const n = normalized(subject);
  return GENERIC_SUBJECTS.some(g => n === normalized(g) || n.includes(normalized(g)));
}

/**
 * Checks the last N subjects for repetition, returns a variety subject if repeated.
 *
 * @param {string} subject - The current proposed visual subject
 * @param {Array<string>} prevSubjects - Array of previous visual subjects (latest last)
 * @param {object} options - { maxRepeats: 2, varietyMode: "auto" }
 * @returns {Promise<string>} New subject suggestion, "text-only", or same subject if no repeat.
 */
async function breakRepetition(subject, prevSubjects = [], options = {}) {
  const maxRepeats = typeof options.maxRepeats === 'number' ? options.maxRepeats : 2;
  const varietyMode = options.varietyMode || 'auto';

  const currNorm = normalized(subject);
  const recent = prevSubjects.slice(-maxRepeats).map(normalized);
  const repeatCount = recent.filter(s => s === currNorm).length;

  console.log(`[10L][CHECK] "${subject}" | recent(${maxRepeats}): ${JSON.stringify(recent)} | repeats: ${repeatCount}`);

  // If subject is generic, *always* force variety (never allow repeat of generic)
  if (isGeneric(subject)) {
    console.warn(`[10L][GENERIC_BLOCK] Subject "${subject}" is generic, forcing variety fallback.`);
    return "text-only viral caption card";
  }

  // If not repeated over threshold, return subject as-is
  if (repeatCount < maxRepeats) {
    return subject;
  }

  // If no OpenAI key, fallback to text-only or emoji/transition
  if (!OPENAI_API_KEY) {
    console.warn('[10L][NO_API] No OpenAI key for variety suggestion.');
    return "text-only viral caption card";
  }

  const SYSTEM_PROMPT = `
You are a world-class viral video editor.
The last scenes all used the same visual subject: "${subject}".
Suggest a NEW visual, angle, style, or related visual for variety:
- A new camera angle (e.g. "cat from above")
- Different context or location ("cat with family")
- Text-only viral caption card
- Dramatic emoji/transition card
- Related but new subject
NEVER repeat the last subject, and NEVER return a generic (like "person", "scene", "caption").
Be BRIEF. Output only the new visual (max 10 words), never a sentence.
If truly stuck, say "text-only viral caption card".
Examples:
Input: "cat closeup" after 3 repeats → "cat jumping from table", "animated cat emoji card"
Input: "LeBron James dunk" after 2 repeats → "LeBron James celebrating", "basketball crowd cheering"
`;

  const prompt = `
Current subject: "${subject}"
Recent subjects: ${JSON.stringify(prevSubjects.slice(-maxRepeats))}
Suggest a NEW visual for variety (5-10 words). If truly stuck, reply "text-only viral caption card". Output ONLY the new visual.
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

    // Defensive: Fallback if still generic or empty or repeats the last subject
    if (
      !raw ||
      raw.length < 3 ||
      isGeneric(raw) ||
      recent.includes(normalized(raw)) ||
      normalized(raw) === currNorm
    ) {
      console.warn(`[10L][RESULT][NO_VARIETY] Fallback: "${raw}" too generic or still repetitive.`);
      return "text-only viral caption card";
    }

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
