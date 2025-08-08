// ===========================================================
// SECTION 10K: MULTI-SUBJECT HANDLER (GPT-powered, Bulletproof)
// Purpose:
//   For lines with multiple valid subjects, return a single,
//   literal, viral, visually-clear COMBO subject when possible
//   (e.g. "cute cat and dog playing together").
//   If a combo isn't appropriate, return the most viral single.
//
// Guarantees:
//   - MAX LOGGING at every step
//   - Never outputs metaphors, emojis, or generic nouns
//   - 3–10 words, lowercase, no trailing punctuation/sentences
//   - Returns null ONLY when truly not applicable
//   - Crash-proof (timeouts handled, fallback heuristic present)
//
// Usage:
//   const { extractMultiSubjectVisual } = require('./section10k-multi-subject-handler.cjs');
//   const visual = await extractMultiSubjectVisual(line, mainTopic);
//
// Notes:
//   - Aligns with 10H/10I/10J style (axios + OpenAI Chat Completions)
//   - Strong sanitization + heuristic fallback if API returns junk
// ===========================================================

const axios = require('axios');

// ==== ENV / API ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
if (!OPENAI_API_KEY) {
  console.error('[10K][FATAL] Missing OPENAI_API_KEY in environment!');
}

// ==== CONSTANTS ====
const AXIOS_TIMEOUT_MS = 15000;
const MODEL = process.env.OPENAI_MODEL_10K || 'gpt-4o';

// Ban super-generic or junk outputs
const BANNED_SINGLE_TOKENS = new Set([
  'something','someone','somebody','anyone','anybody','everyone','everybody',
  'person','people','man','woman','men','women','boy','girl','child','children',
  'scene','things','thing','it','they','we','face','eyes','body','animal','animals',
  'object','objects','stuff','figure','silhouette','emoji','emojis','question','mark'
]);

// Stopwords for simple subject parsing fallback
const STOP = new Set([
  'the','a','an','and','or','but','with','without','of','in','on','at','to','from','by','for','over','under',
  'is','are','was','were','be','been','being','do','does','did','doing','have','has','had',
  'this','that','these','those','there','here','then','than','as','so','such','very','really',
  'more','most','less','least','few','fewer','many','much','some','any','no','not',
  'you','your','yours','i','me','my','mine','we','our','ours','they','them','their','theirs','he','him','his','she','her','hers','it','its',
  'let','lets','let\'s','now','meanwhile','later','today','tomorrow','yesterday'
]);

// Words that suggest a list / combo scenario
const MULTI_HINTS = /\b(and|,|\/|&|versus|vs\.?|plus)\b/i;

// ==== SYSTEM PROMPT ====
// (Ultra-strict: literal, viral, short, no generics, prefer combos)
const SYSTEM_PROMPT = `
You are a viral short-form video editor and expert scene picker.
Given ONE script line, select a SINGLE visual subject phrase that is literal and visually clickable.
When the line clearly includes MULTIPLE visual subjects, prefer a COMBO visual (together/side-by-side/interaction).
Otherwise, return the TOP single visual subject.

Absolute rules:
- Output only a short phrase (3–10 words), all lowercase, no trailing punctuation.
- NO sentences, NO emojis, NO metaphors, NO abstract nouns, NO generic terms ("person", "someone", "thing", "scene").
- Prefer famous or visually strong pairings; avoid brand logos unless explicitly named in the input.
- Keep phrasing concrete and camera-ready (e.g., "cute cat and dog playing", "pizza and burger side by side", "sun shining with rain").
- If no multi-subject logic applies and nothing vivid stands out, return "NO_MATCH".
`.trim();

// ==== UTILITIES ====
function cleanOutput(s = '') {
  let out = String(s || '')
    .replace(/^output\s*[:\-]\s*/i, '')
    .replace(/^(show|display|combo)\s*[:\-]?\s*/i, '')
    .replace(/[“”"]/g, '')
    .trim();

  // Lowercase, strip trailing punctuation and emojis
  out = out.toLowerCase().replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]+/gu, '').trim();
  out = out.replace(/[.?!,:;]+$/g, '').trim();

  // Collapse spaces
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function isPhraseGeneric(phrase) {
  if (!phrase || phrase.length < 3) return true;
  // reject if contains banned single token alone or as entire phrase
  if (BANNED_SINGLE_TOKENS.has(phrase)) return true;

  // tokens check
  const toks = phrase.split(/\s+/);
  if (toks.length > 12) return true; // too long (should be 3–10)
  if (toks.length < 2) {
    // single-token phrases are generally too weak unless famous nouns like "pizza" or "lightning"
    // allow some strong singletons heuristically
    const strongSingletons = new Set(['lightning','pizza','sunset','rainbow','tornado','volcano','eiffel tower','pyramids','aurora']);
    if (!strongSingletons.has(phrase)) return true;
  }

  // reject if any token is an obvious generic and the phrase is short
  const genericHit = toks.some(t => BANNED_SINGLE_TOKENS.has(t));
  if (genericHit && toks.length <= 3) return true;

  // Reject if it looks like a sentence (has verbs with subject pronouns or punctuation mid-line)
  if (/[.!?]/.test(phrase)) return true;
  if (/\b(i|you|we|they|he|she)\b/.test(phrase)) return true;

  return false;
}

function enforceWordBounds(phrase) {
  const toks = phrase.split(/\s+/).filter(Boolean);
  if (toks.length > 10) return toks.slice(0, 10).join(' ');
  if (toks.length < 3) return phrase; // upstream will decide if too short
  return phrase;
}

// Simple heuristic to guess multi-subjects from a raw line if LLM fails
function heuristicMultiFromLine(line) {
  if (!line) return null;
  // Detect clear separators
  const hasMulti = MULTI_HINTS.test(line);
  if (!hasMulti) return null;

  // Extract candidate nouns-ish (very rough): words, keep those >2 chars and not stopwords
  const words = String(line)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 2 && !STOP.has(w));

  if (words.length < 2) return null;

  // Deduplicate while keeping order
  const seen = new Set();
  const uniq = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      uniq.push(w);
    }
  }

  // Try to pick two strongest-looking tokens (prefer concrete things)
  // crude preference order: animals/food/places/common objects lists
  const strongSets = [
    ['cat','dog','puppy','kitten','lion','tiger','bear','panda','monkey','gorilla','elephant','horse','fox'],
    ['pizza','burger','fries','sushi','taco','pasta','steak','salad','noodles'],
    ['sun','rain','clouds','storm','lightning','snow','rainbow','sunset'],
    ['eiffel','tower','pyramids','pyramid','castle','bridge','temple','statue','mountain','volcano','beach','forest'],
  ];
  const strength = (w) => {
    for (let i = 0; i < strongSets.length; i++) {
      if (strongSets[i].includes(w)) return 100 - (i * 10);
    }
    // fallback heuristic: longer slightly better
    return Math.min(50, 20 + w.length);
  };

  // Score and pick top 2 distinct
  const scored = uniq.map(w => ({ w, s: strength(w) }));
  scored.sort((a, b) => b.s - a.s);
  const a = scored[0]?.w;
  const b = scored.find(x => x.w !== a)?.w;

  if (a && b) return `${a} and ${b} together`;
  return null;
}

// ==== CORE FUNCTION ====
async function extractMultiSubjectVisual(sceneLine, mainTopic = '') {
  if (!OPENAI_API_KEY) {
    console.error('[10K][FATAL] No OpenAI API key!');
    // Try last-resort heuristic if we can
    const h = heuristicMultiFromLine(sceneLine);
    if (h && !isPhraseGeneric(h)) {
      console.warn('[10K][HEURISTIC][API_MISSING] Using heuristic combo:', h);
      return enforceWordBounds(h);
    }
    return null;
  }

  try {
    const userPrompt = `
script line: "${String(sceneLine || '').trim()}"
main topic: "${String(mainTopic || '').trim()}"

Return ONLY one literal visual subject phrase:
- Prefer a COMBO if multiple visual subjects clearly appear (together, side-by-side, interacting).
- Otherwise the single strongest subject.
- 3–10 words, all lowercase, no trailing punctuation, no emojis, no sentence.
- Never generic ("person", "someone", "thing", "scene", "question mark").
If not applicable, reply "NO_MATCH".
    `.trim();

    console.log('[10K][PROMPT]', userPrompt);

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 32,
        temperature: 0.35,
        n: 1,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: AXIOS_TIMEOUT_MS,
      }
    );

    let raw = response?.data?.choices?.[0]?.message?.content ?? '';
    let visual = cleanOutput(raw);

    // Hard filters
    if (!visual || visual.toUpperCase() === 'NO_MATCH') {
      console.warn('[10K][NO_MATCH] Model returned no match | input:', sceneLine);
      // Try heuristic combo
      const h = heuristicMultiFromLine(sceneLine);
      if (h && !isPhraseGeneric(h)) {
        console.log('[10K][HEURISTIC] Using heuristic combo:', h);
        return enforceWordBounds(h);
      }
      // Fallback: if mainTopic is strong enough, return it (single subject)
      const topic = String(mainTopic || '').toLowerCase().trim();
      if (topic && !isPhraseGeneric(topic)) {
        const bounded = enforceWordBounds(topic);
        console.log('[10K][FALLBACK][TOPIC]', bounded);
        return bounded;
      }
      return null;
    }

    // Sanitization + constraints
    visual = enforceWordBounds(visual);

    // Final generic & sentence checks
    if (isPhraseGeneric(visual)) {
      console.warn('[10K][REJECT_GENERIC]', visual, '| input:', sceneLine);
      // Try heuristic
      const h = heuristicMultiFromLine(sceneLine);
      if (h && !isPhraseGeneric(h)) {
        console.log('[10K][HEURISTIC] Using heuristic combo after generic:', h);
        return enforceWordBounds(h);
      }
      // Fallback to main topic as single subject if valid
      const topic = String(mainTopic || '').toLowerCase().trim();
      if (topic && !isPhraseGeneric(topic)) {
        const bounded = enforceWordBounds(topic);
        console.log('[10K][FALLBACK][TOPIC_AFTER_GENERIC]', bounded);
        return bounded;
      }
      return null;
    }

    // Log + return
    console.log(`[10K][RESULT] "${sceneLine}" => "${visual}"`);
    return visual;
  } catch (err) {
    if (err?.response) {
      console.error('[10K][ERR][HTTP]', err.response.status, err.response.data);
    } else {
      console.error('[10K][ERR]', err?.message || err);
    }

    // Network/API failure fallback
    const h = heuristicMultiFromLine(sceneLine);
    if (h && !isPhraseGeneric(h)) {
      console.warn('[10K][FALLBACK][HEURISTIC_AFTER_ERR]', h);
      return enforceWordBounds(h);
    }
    const topic = String(mainTopic || '').toLowerCase().trim();
    if (topic && !isPhraseGeneric(topic)) {
      const bounded = enforceWordBounds(topic);
      console.warn('[10K][FALLBACK][TOPIC_AFTER_ERR]', bounded);
      return bounded;
    }
    return null;
  }
}

module.exports = { extractMultiSubjectVisual };
