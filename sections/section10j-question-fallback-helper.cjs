// ===========================================================
// SECTION 10J: QUESTION FALLBACK VISUAL HELPER (GPT-powered)
// For question lines, returns the *single best literal visual subject*
// (e.g., for "Why do cats purr?" => "close-up of cat purring softly").
// Never generic/question mark. Max logging, bulletproof, never blocks.
// Ultra strict, never silent-fails, returns null if no valid match.
// Upgraded 2025-08: robust question detection, retries/backoff,
// output sanitization (5–10 words), strict generic filters, LRU cache.
// ===========================================================

const axios = require('axios');

// ---------------- ENV / CONFIG ----------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
if (!OPENAI_API_KEY) {
  console.error('[10J][FATAL] Missing OPENAI_API_KEY in environment!');
}

const QUESTION_MODEL =
  process.env.QUESTION_MODEL ||
  process.env.OPENAI_MODEL_10J ||
  'gpt-4o';

const QUESTION_USE_GPT = String(process.env.QUESTION_USE_GPT || '1') === '1';

const QUESTION_OPENAI_TIMEOUT_MS = Number(
  process.env.QUESTION_OPENAI_TIMEOUT_MS ||
  process.env.OPENAI_TIMEOUT_MS ||
  15000
);

const QUESTION_OPENAI_RETRIES = Math.max(
  0,
  Number(process.env.QUESTION_OPENAI_RETRIES || process.env.OPENAI_RETRIES_10J || 2)
);

const QUESTION_TEMPERATURE = Number(process.env.QUESTION_TEMPERATURE || 0.35);
const QUESTION_MAX_TOKENS = Math.max(1, Number(process.env.QUESTION_MAX_TOKENS || 28));
const RETRY_BASE_DELAY_MS = Math.max(100, Number(process.env.QUESTION_RETRY_BASE_DELAY_MS || 600));

// ---------------- LRU CACHE ----------------
const _cacheMax = Math.max(50, Number(process.env.QUESTION_CACHE_MAX || 300));
const _cache = new Map(); // key => value; LRU via delete+set
function _cacheGet(k) {
  if (_cache.has(k)) {
    const v = _cache.get(k);
    _cache.delete(k);
    _cache.set(k, v);
    return v;
  }
  return undefined;
}
function _cacheSet(k, v) {
  if (_cache.has(k)) _cache.delete(k);
  _cache.set(k, v);
  if (_cache.size > _cacheMax) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
}

// ---------------- TEXT UTILS ----------------
function _norm(s) { return String(s || '').trim(); }
function _lower(s) { return _norm(s).toLowerCase(); }
function _stripQuotes(s) { return String(s || '').replace(/^["'\s]+|["'\s]+$/g, ''); }
function _squash(s) { return _stripQuotes(s).replace(/\s+/g, ' ').trim(); }
function _neutralizePunctuation(s) {
  return String(s || '')
    .replace(/[“”"’']/g, '')
    .replace(/[.!?;:,]+$/g, '')
    .trim();
}
function _between(min, max, s) {
  const n = _squash(s).split(/\s+/).filter(Boolean).length;
  return n >= min && n <= max;
}
function _removeLeadingVerbs(s) {
  return String(s || '').replace(/^(show|display|depict|visualize|cut to|see)\s+/i, '').trim();
}

// ---------------- GENERIC / BAN LISTS ----------------
const GENERIC_BANNED = new Set([
  'something','someone','person','people','scene','man','woman','it','thing',
  'they','we','body','face','eyes','child','children','kid','kids',
  'someone thinking','question mark','question-mark','emoji','question symbol'
]);

// ---------------- QUESTION GATE ----------------
function isQuestionLike(line = '') {
  const Lraw = String(line || '');
  const L = Lraw.trim();
  if (!L) return false;

  // obvious punctuation
  if (/\?\s*$/.test(L)) return true;

  // starts with interrogatives / auxiliaries
  if (/^\s*(why|what|how|who|whom|whose|where|when|which|is|are|can|should|could|would|do|does|did|will|won't|can't|isn['’]?t|aren['’]?t)\b/i.test(L)) {
    return true;
  }

  // questiony phrases
  if (/\b(did you know|ever wonder|is it true|can you|should you|how come|what if)\b/i.test(L)) {
    return true;
  }

  return false;
}

// ---------------- SANITIZER ----------------
function sanitizeOutput(raw = '') {
  let s = String(raw || '').trim();

  // Drop "output: -" style noise and trim quotes/punct
  s = s.replace(/^output\s*[:\-]\s*/i, '').replace(/^[“"'\-]+|[”"'.]+$/g, '').trim();

  // NO_MATCH or explicit negatives
  if (/^\s*no[_\-\s]*match\s*$/i.test(s)) return '';

  // forbid question-y things
  if (s.includes('?') || /question\s*mark/i.test(s)) return '';

  // Remove leading verbs and normalize punctuation
  s = _neutralizePunctuation(_removeLeadingVerbs(_squash(s)));

  // Light tightening
  s = s.replace(/^(the|a|an)\s+/i, '').trim();

  // Enforce 5–10 words hard
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 5 || words.length > 20) return ''; // reject short sentences/phrases; trim later
  if (words.length > 10) s = words.slice(0, 10).join(' ');

  // Re-check generics
  const lower = s.toLowerCase();
  if (GENERIC_BANNED.has(lower)) return '';

  // Safety: avoid trivially vague starters
  const first = (words[0] || '').toLowerCase();
  if (/^(something|someone|thing|object|stuff|idea)$/.test(first)) return '';

  return s;
}

// ---------------- PROMPTS ----------------
const SYSTEM_PROMPT = `
You are an expert viral video editor and visual director.
Given a script line that is a QUESTION, return the SINGLE BEST literal, visual subject or action to show for the core topic.
Rules:
- NEVER return a question mark, emoji, or generic/abstract visual ("someone thinking", "person", "something", "question mark").
- Return a concrete visual, e.g., "stormy sky with lightning bolts".
- Output must be a single noun phrase, 5–10 words, no sentence, no punctuation at end, no quotes.
- If not a question, reply exactly "NO_MATCH".
Examples:
Input: "Why do cats purr?" → "close-up of cat purring softly"
Input: "What causes lightning?" → "stormy sky with lightning bolts"
Input: "How do you become successful?" → "successful businessperson holding a trophy"
Input: "Who built the pyramids?" → "ancient egyptians building massive pyramids"
Input: "How can I focus better?" → "student studying at desk with books"
Input: "Is sugar bad for you?" → "bowl of sugar cubes on table"
`.trim();

function _buildUserPrompt(line, topic) {
  return `
Script line: "${_stripQuotes(line)}"
Main topic: "${_stripQuotes(topic || '')}"
If this line is a question, return ONLY the best literal visual subject or action (5–10 words, single noun phrase).
If not a question, strictly reply "NO_MATCH".
  `.trim();
}

// ---------------- OPENAI CALL ----------------
async function _callOpenAIQuestion(line, topic, { jobId } = {}) {
  const prompt = _buildUserPrompt(line, topic);
  console.log(`[10J][PROMPT][${jobId || 'job'}] ${prompt}`);

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: QUESTION_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_tokens: QUESTION_MAX_TOKENS,
      temperature: QUESTION_TEMPERATURE,
      n: 1
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: QUESTION_OPENAI_TIMEOUT_MS
    }
  );

  const raw = resp?.data?.choices?.[0]?.message?.content ?? '';
  return String(raw).trim();
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------- PUBLIC API ----------------
/**
 * Analyze a script line for question-oriented visuals.
 * Returns a literal, non-generic subject/action (5–10 words) or null.
 *
 * @param {string} sceneLine - A single scene/script line
 * @param {string} mainTopic - Optional general topic
 * @param {object} opts - { jobId?: string }
 * @returns {Promise<string|null>}
 */
async function extractQuestionVisual(sceneLine, mainTopic = '', opts = {}) {
  const jobId = opts?.jobId || '';

  let line = _neutralizePunctuation(_squash(sceneLine || ''));
  if (!line) {
    console.warn('[10J][NO_MATCH] Empty line.');
    return null;
  }

  const cacheKey = `Q|${line}|${mainTopic}`;
  const cached = _cacheGet(cacheKey);
  if (cached !== undefined) {
    console.log('[10J][CACHE][HIT]', cacheKey, '=>', cached);
    return cached;
  }

  // Fast local gate: only hit LLM for likely questions
  if (!isQuestionLike(line)) {
    console.log('[10J][GATE] Not question-like; skipping LLM.');
    _cacheSet(cacheKey, null);
    return null;
  }

  if (!QUESTION_USE_GPT || !OPENAI_API_KEY) {
    console.warn('[10J][SKIP_GPT] Disabled or missing API key. Returning null.');
    _cacheSet(cacheKey, null);
    return null;
  }

  // Retry loop with backoff on 429/5xx/timeouts
  let attempt = 0;
  let lastErr = null;

  while (attempt <= QUESTION_OPENAI_RETRIES) { // total calls = 1 + retries
    try {
      console.log(`[10J][REQ][${jobId || 'job'}] attempt=${attempt + 1} model=${QUESTION_MODEL}`);
      const raw = await _callOpenAIQuestion(line, mainTopic, { jobId });

      if (!raw) {
        console.warn('[10J][RAW][EMPTY]');
        _cacheSet(cacheKey, null);
        return null;
      }

      if (/^\s*no[_\-\s]*match\s*$/i.test(raw)) {
        console.log('[10J][LLM][NO_MATCH] Not a question.');
        _cacheSet(cacheKey, null);
        return null;
      }

      const visual = sanitizeOutput(raw);
      if (!visual) {
        console.warn(`[10J][SANITIZE][NO_MATCH] raw="${raw}"`);
        _cacheSet(cacheKey, null);
        return null;
      }

      // Guard against trailing punctuation that slipped through
      if (/[?!.]$/.test(visual)) {
        console.warn('[10J][GUARD] Trailing punctuation, rejecting.');
        _cacheSet(cacheKey, null);
        return null;
      }

      console.log(`[10J][RESULT][${jobId || 'job'}] "${line}" => "${visual}"`);
      _cacheSet(cacheKey, visual);
      return visual;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const retriable =
        status === 429 ||
        (status >= 500 && status < 600) ||
        err?.code === 'ECONNABORTED';

      console.error(`[10J][ERR] attempt=${attempt + 1} status=${status || 'n/a'} msg=${err?.message || err}`);

      if (!retriable || attempt >= QUESTION_OPENAI_RETRIES) {
        break;
      }
      const delay = Math.round(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
      console.log(`[10J][RETRY] Waiting ${delay}ms before retry...`);
      await _sleep(delay);
      attempt++;
    }
  }

  console.warn('[10J][NO_MATCH] Failed to obtain a valid visual after retries.', lastErr ? `(last error: ${lastErr?.message || 'unknown'})` : '');
  _cacheSet(cacheKey, null);
  return null;
}

module.exports = { extractQuestionVisual };
