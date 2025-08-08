// ===========================================================
// SECTION 10J: QUESTION FALLBACK VISUAL HELPER (GPT-powered)
// For question lines, returns the *single best literal visual subject*
// (e.g. for "Why do cats purr?" => "cat closeup purring").
// Never generic/question mark. Max logging, bulletproof, never blocks.
// Ultra strict, never silent-fails, returns null if no valid match.
// Upgraded 2025-08: robust question detection, retries/backoff,
// output sanitization (5–10 words), strict generic filters.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
if (!OPENAI_API_KEY) {
  console.error('[10J][FATAL] Missing OPENAI_API_KEY in environment!');
}

// ---------- Tunables ----------
const MODEL = process.env.OPENAI_MODEL_10J || 'gpt-4o';
const TIMEOUT_MS = 15000;
const TEMPERATURE = 0.4;
const MAX_TOKENS = 28;
const MAX_RETRIES = 2;          // additional tries after the first (total calls = 1 + MAX_RETRIES)
const RETRY_BASE_DELAY_MS = 600;

// ---------- Helpers ----------
const GENERIC_BANNED = new Set([
  'something','someone','person','people','scene','man','woman','it','thing',
  'they','we','body','face','eyes','child','children','someone thinking',
  'question mark','question-mark','emoji'
]);

function isQuestionLike(line = '') {
  const L = String(line || '').trim();
  if (!L) return false;
  if (/[?!]\s*$/.test(L)) return true; // ends with ? or !
  // starts with interrogatives
  if (/^\s*(why|what|how|who|whom|whose|where|when|which|is|are|can|should|could|would|do|does|did|will)\b/i.test(L)) {
    return true;
  }
  // contains questiony phrases
  if (/\b(did you know|ever wonder|is it true|can you|should you|how come)\b/i.test(L)) {
    return true;
  }
  return false;
}

function sanitizeOutput(raw = '') {
  let s = String(raw || '').trim();

  // Drop leading "output: - " noise and quotes/punctuation trim
  s = s.replace(/^output\s*[:\-]\s*/i, '').replace(/^[“"'\-]+|[”"'.]+$/g, '').trim();

  // Ban question marks or explicit "question mark"
  if (s.includes('?') || /question\s*mark/i.test(s)) return '';

  // Hard NO_MATCH handling
  if (/^\s*no[_\-\s]*match\s*$/i.test(s)) return '';

  // Generic block
  const sLower = s.toLowerCase();
  if (GENERIC_BANNED.has(sLower)) return '';

  // Enforce 5–10 words: if longer, trim; if shorter (<3) reject
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 3) return '';
  if (words.length > 10) s = words.slice(0, 10).join(' ');

  // Keep it literal-ish: remove trailing commas/periods
  s = s.replace(/[,.]\s*$/,'').trim();

  // Light safety: drop leading articles to tighten phrasing
  s = s.replace(/^(the|a|an)\s+/i, '').trim();

  // Final generic re-check on cleaned text
  if (GENERIC_BANNED.has(s.toLowerCase())) return '';

  return s;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------- Prompt ----------
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
`.trim();

// ---------- Core ----------
async function callOpenAIQuestion(line, topic) {
  const prompt = `
Script line: "${line}"
Main topic: "${topic || ''}"
If this line is a question, return ONLY the best literal visual subject or action (5-10 words, never a sentence).
If not a question, strictly reply "NO_MATCH".
  `.trim();

  console.log(`[10J][PROMPT] ${prompt}`);

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      n: 1
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: TIMEOUT_MS
    }
  );

  const raw = resp?.data?.choices?.[0]?.message?.content ?? '';
  return String(raw).trim();
}

/**
 * extractQuestionVisual
 * - If the line is question-like, asks LLM for a literal visual.
 * - Sanitizes to 5–10 words, rejects generics and question marks.
 * - Returns null on no-match or failure (non-blocking fallback).
 */
async function extractQuestionVisual(sceneLine, mainTopic = '') {
  try {
    const line = String(sceneLine || '').trim();
    if (!line) {
      console.warn('[10J][NO_MATCH] Empty line.');
      return null;
    }

    // Fast local gate: only hit LLM for likely questions
    if (!isQuestionLike(line)) {
      console.log('[10J][GATE] Not question-like; skipping LLM.');
      return null;
    }

    // Retry loop with backoff on 429/5xx/timeouts
    let attempt = 0;
    let lastErr = null;
    while (attempt <= MAX_RETRIES) {
      try {
        attempt++;
        const raw = await callOpenAIQuestion(line, mainTopic);
        let visual = sanitizeOutput(raw);

        if (!visual) {
          console.warn(`[10J][SANITIZE][NO_MATCH] raw="${raw}"`);
          return null;
        }

        // Additional guardrails: forbid trailing question semantics
        if (/\?$/.test(visual)) return null;

        console.log(`[10J][RESULT] "${line}" => "${visual}"`);
        return visual;
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status;
        const retriable = status === 429 || (status >= 500 && status < 600) || err?.code === 'ECONNABORTED';
        console.error(`[10J][ERR] attempt=${attempt} status=${status || 'n/a'} msg=${err?.message || err}`);

        if (!retriable || attempt > MAX_RETRIES) break;

        const delay = Math.round(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        console.log(`[10J][RETRY] Waiting ${delay}ms before retry...`);
        await sleep(delay);
      }
    }

    console.warn('[10J][NO_MATCH] Failed to obtain a valid visual after retries.');
    return null;
  } catch (err) {
    if (err?.response) {
      console.error('[10J][ERR][HTTP]', err.response.status, err.response.data);
    } else {
      console.error('[10J][ERR]', err);
    }
    return null;
  }
}

module.exports = { extractQuestionVisual };
