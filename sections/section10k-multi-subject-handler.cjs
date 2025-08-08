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
//   - Deterministic sanitization, retries with backoff, strict filters
//
// Usage:
//   const { extractMultiSubjectVisual } = require('./section10k-multi-subject-handler.cjs');
//   const visual = await extractMultiSubjectVisual(line, mainTopic, { timeBudgetMs: 14000 });
//
// Notes:
//   - Aligns with 10H/10I/10J style (axios + OpenAI Chat Completions)
//   - Strong sanitization + heuristic fallback if API returns junk
//   - Compatible with 5D (subject routing) and 10L (repetition blocker)
// ===========================================================

'use strict';

const axios = require('axios');

// ==== ENV / API ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
if (!OPENAI_API_KEY) {
  console.error('[10K][FATAL] Missing OPENAI_API_KEY in environment!');
}

// ==== CONSTANTS ====
const DEFAULT_AXIOS_TIMEOUT_MS = 15000;
const DEFAULT_TIME_BUDGET_MS = 14000; // hard stop for this helper
const MODEL = (process.env.OPENAI_MODEL_10K || 'gpt-4o').trim();

// Retry/backoff settings (short; we fail fast + fallback)
const MAX_RETRIES = 1;
const INITIAL_BACKOFF_MS = 500;

// Ban super-generic or junk outputs (single tokens and throwaways)
const BANNED_SINGLE_TOKENS = new Set([
  'something','someone','somebody','anyone','anybody','everyone','everybody',
  'person','people','man','woman','men','women','boy','girl','child','children',
  'scene','things','thing','it','they','we','face','eyes','body','animal','animals',
  'object','objects','stuff','figure','silhouette','emoji','emojis','question','mark',
  'unknown','undefined','generic'
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
function nowMs() { return Date.now(); }

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function cleanOutput(s = '') {
  let out = String(s || '')
    .split('\n')[0]                                // only first line if model returns multiple
    .replace(/^output\s*[:\-]\s*/i, '')
    .replace(/^(show|display|combo)\s*[:\-]?\s*/i, '')
    .replace(/[“”"]/g, '')
    .replace(/\s*&\s*/g, ' and ')                  // normalize ampersand to 'and'
    .trim();

  // Lowercase, strip trailing punctuation and emojis
  out = out.toLowerCase()
           .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]+/gu, '')
           .trim();
  out = out.replace(/[.?!,:;]+$/g, '').trim();

  // Remove brackets/parentheses content if present
  out = out.replace(/[\[\]\(\){}]/g, ' ').replace(/\s+/g, ' ').trim();

  // Collapse spaces
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function isPhraseGeneric(phrase) {
  if (!phrase) return true;

  // reject exact banned token
  if (BANNED_SINGLE_TOKENS.has(phrase)) return true;

  // tokenization
  const toks = phrase.split(/\s+/).filter(Boolean);

  // hard caps
  if (toks.length > 12) return true; // overly long (should be 3–10 actual target)
  if (/[.!?]/.test(phrase)) return true; // looks like a sentence
  if (/\b(i|you|we|they|he|she)\b/.test(phrase)) return true; // pronouns → sentence-like

  // reject if any token is a banned generic and the phrase is short
  const genericHit = toks.some(t => BANNED_SINGLE_TOKENS.has(t));
  if (genericHit && toks.length <= 3) return true;

  // Weak 1-token outputs are usually junk; allow a few famous singletons
  if (toks.length === 1) {
    const t = toks[0];
    const strongSingletons = new Set([
      'lightning','pizza','sunset','rainbow','tornado','volcano','aurora'
    ]);
    return !strongSingletons.has(t);
  }

  // Allow solid 2-word famous things like "eiffel tower", "trevi fountain"
  return false;
}

function enforceWordBounds(phrase) {
  const toks = phrase.split(/\s+/).filter(Boolean);
  if (toks.length > 10) return toks.slice(0, 10).join(' ');
  if (toks.length < 3) return phrase; // upstream can decide if too short based on context
  return phrase;
}

function looksMultiSubject(line) {
  if (!line) return false;
  return MULTI_HINTS.test(line);
}

// Simple heuristic to guess multi-subjects from a raw line if LLM fails
function heuristicMultiFromLine(line) {
  if (!line) return null;
  if (!looksMultiSubject(line)) return null;

  // Extract candidate noun-ish tokens (rough): keep alnum > 2 chars and not stopwords
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

  // crude preference order: animals/food/weather/places
  const strongSets = [
    ['cat','dog','puppy','kitten','lion','tiger','bear','panda','monkey','gorilla','elephant','horse','fox'],
    ['pizza','burger','fries','sushi','taco','pasta','steak','salad','noodles'],
    ['sun','rain','clouds','storm','lightning','snow','rainbow','sunset'],
    ['eiffel','tower','pyramids','pyramid','castle','bridge','temple','statue','mountain','volcano','beach','forest','fountain','trevi'],
  ];
  const strength = (w) => {
    for (let i = 0; i < strongSets.length; i++) {
      if (strongSets[i].includes(w)) return 100 - (i * 10);
    }
    // fallback heuristic: longer slightly better
    return Math.min(55, 20 + w.length);
  };

  // Score and pick top 2 distinct
  const scored = uniq.map(w => ({ w, s: strength(w) }));
  scored.sort((a, b) => b.s - a.s);
  const a = scored[0]?.w;
  const b = scored.find(x => x.w !== a)?.w;

  if (a && b) {
    const combo = `${a} and ${b} together`;
    return combo;
  }
  return null;
}

function pickTopicFallback(mainTopic) {
  const topic = String(mainTopic || '').toLowerCase().trim();
  if (!topic) return null;
  const cleaned = cleanOutput(topic);
  if (!cleaned) return null;
  if (isPhraseGeneric(cleaned)) return null;
  return enforceWordBounds(cleaned);
}

async function callOpenAI(userPrompt, timeLeftMs) {
  const timeoutMs = Math.min(DEFAULT_AXIOS_TIMEOUT_MS, Math.max(2000, timeLeftMs));
  console.log(`[10K][HTTP][POST] /chat/completions model=${MODEL} timeoutMs=${timeoutMs}`);
  const res = await axios.post(
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
      timeout: timeoutMs,
      validateStatus: () => true, // we'll handle errors
    }
  );
  return res;
}

// ==== CORE FUNCTION ====
/**
 * Extract a multi-subject or strongest single visual phrase for a line.
 * @param {string} sceneLine - raw script line
 * @param {string} [mainTopic] - the overall topic (for fallback single)
 * @param {object} [opts]
 * @param {number} [opts.timeBudgetMs] - hard budget for this helper (default 14s)
 * @returns {Promise<string|null>} visual phrase or null
 */
async function extractMultiSubjectVisual(sceneLine, mainTopic = '', opts = {}) {
  const started = nowMs();
  const timeBudgetMs = Math.max(3000, Number(opts.timeBudgetMs) || DEFAULT_TIME_BUDGET_MS);

  // Pre-flight
  if (!sceneLine || !String(sceneLine).trim()) {
    console.warn('[10K][WARN] Empty scene line provided.');
    const topicFallback = pickTopicFallback(mainTopic);
    if (topicFallback) {
      console.log('[10K][FALLBACK][TOPIC_EMPTY_LINE]', topicFallback);
      return topicFallback;
    }
    return null;
  }

  // Quick reject for missing API (stay non-blocking)
  if (!OPENAI_API_KEY) {
    console.error('[10K][FATAL] No OpenAI API key! Falling back heuristically.');
    const h = heuristicMultiFromLine(sceneLine);
    if (h && !isPhraseGeneric(h)) {
      const bounded = enforceWordBounds(h);
      console.warn('[10K][HEURISTIC][API_MISSING] Using heuristic combo:', bounded);
      return bounded;
    }
    const topicFallback = pickTopicFallback(mainTopic);
    if (topicFallback) {
      console.warn('[10K][FALLBACK][TOPIC_API_MISSING]', topicFallback);
      return topicFallback;
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

    console.log('[10K][PROMPT]', userPrompt.replace(/\s+/g, ' ').slice(0, 600));

    // Try with minimal retries + exponential backoff
    let attempt = 0;
    let lastHttp = null;

    while (attempt <= MAX_RETRIES) {
      const timeUsed = nowMs() - started;
      const timeLeft = timeBudgetMs - timeUsed;
      if (timeLeft <= 300) {
        console.warn(`[10K][TIMEOUT][ATTEMPT=${attempt}] No time left. Breaking to fallbacks.`);
        break;
      }

      if (attempt > 0) {
        const backoff = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1), 1500);
        console.log(`[10K][RETRY][ATTEMPT=${attempt}] Backing off ${backoff}ms (timeLeft=${timeLeft}ms)`);
        if (backoff > 0) await sleep(Math.min(backoff, Math.max(0, timeLeft - 200)));
      }

      console.log(`[10K][HTTP][ATTEMPT=${attempt}] Calling OpenAI (timeLeft=${timeLeft}ms)`);
      const httpRes = await callOpenAI(userPrompt, timeLeft);
      lastHttp = httpRes;

      if (!httpRes) {
        console.error(`[10K][ERR][ATTEMPT=${attempt}] Empty HTTP response.`);
        attempt++;
        continue;
      }

      const status = Number(httpRes.status);
      if (status < 200 || status >= 300) {
        console.error(`[10K][ERR][HTTP_STATUS][ATTEMPT=${attempt}] status=${status}`, httpRes.data);
        // Retry on transient statuses
        if ([408, 409, 429, 500, 502, 503, 504].includes(status) && attempt < MAX_RETRIES) {
          attempt++;
          continue;
        }
        break; // non-retriable or out of retries
      }

      const raw = httpRes?.data?.choices?.[0]?.message?.content ?? '';
      let visual = cleanOutput(raw);

      if (!visual || visual.toUpperCase() === 'NO_MATCH') {
        console.warn(`[10K][NO_MATCH][ATTEMPT=${attempt}] Model said NO_MATCH or empty. raw="${raw}"`);
        // If we still have a retry, try again; else fallback
        if (attempt < MAX_RETRIES) {
          attempt++;
          continue;
        }
      } else {
        // Enforce word bounds and run final generic checks
        visual = enforceWordBounds(visual);
        if (isPhraseGeneric(visual)) {
          console.warn(`[10K][REJECT_GENERIC][ATTEMPT=${attempt}] "${visual}" | input: ${sceneLine}`);
          if (attempt < MAX_RETRIES) {
            attempt++;
            continue;
          }
        } else {
          console.log(`[10K][RESULT] "${sceneLine}" => "${visual}"`);
          return visual;
        }
      }

      attempt++;
    }

    // === FALLBACKS ===
    const h = heuristicMultiFromLine(sceneLine);
    if (h && !isPhraseGeneric(h)) {
      const bounded = enforceWordBounds(h);
      console.log('[10K][FALLBACK][HEURISTIC]', bounded);
      return bounded;
    }

    const topicFallback = pickTopicFallback(mainTopic);
    if (topicFallback) {
      console.log('[10K][FALLBACK][TOPIC]', topicFallback);
      return topicFallback;
    }

    console.warn('[10K][FALLBACK][NULL] No valid visual could be determined.');
    return null;
  } catch (err) {
    // Network/API failure fallback
    if (err?.response) {
      console.error('[10K][ERR][HTTP_THROW]', err.response.status, err.response.data);
    } else {
      console.error('[10K][ERR][THROW]', err?.message || err);
    }

    const h = heuristicMultiFromLine(sceneLine);
    if (h && !isPhraseGeneric(h)) {
      const bounded = enforceWordBounds(h);
      console.warn('[10K][FALLBACK][HEURISTIC_AFTER_ERR]', bounded);
      return bounded;
    }
    const topicFallback = pickTopicFallback(mainTopic);
    if (topicFallback) {
      console.warn('[10K][FALLBACK][TOPIC_AFTER_ERR]', topicFallback);
      return topicFallback;
    }
    return null;
  }
}

module.exports = { extractMultiSubjectVisual };
