// ===========================================================
// SECTION 10I: EMOTION/ACTION/TRANSITION HELPER (GPT-powered, Bulletproof)
// Detects if a line is about an emotion, action cue, or transition.
// Returns a *literal* visual subject (face/action/scene/transition visual).
// Used as a plug-in fallback or enhancer in scene matching.
//
// Upgrades (2025-08):
// - Heuristic fast-path (no-API) with rich emotion & transition lexicons
// - Strict de-genericizer and word-count limiter (5–10 words)
// - Smart gender/person handling (allow man/woman IF paired with action/adjective)
// - Transition visual mapper (e.g., "meanwhile" -> "city time-lapse")
// - Robust OpenAI refinement with retries/backoff & timeouts
// - In-memory LRU cache to avoid repeat calls across scenes
// - Main-topic nudging and noise stripping
// - MAX LOGGING; never throws; returns null only when nothing fits
// ===========================================================

const axios = require('axios');

// ------------ ENV / CONFIG ------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const EMOTION_MODEL = process.env.EMOTION_MODEL || 'gpt-4o'; // keep consistent with 10H default family
const OPENAI_TIMEOUT_MS = Number(process.env.EMOTION_OPENAI_TIMEOUT_MS || 15000);
const OPENAI_RETRIES = Math.max(0, Number(process.env.EMOTION_OPENAI_RETRIES || 2));

// If you're extremely cost-sensitive, disable GPT refinement:
// (Heuristics still work very well.)
const EMOTION_USE_GPT = String(process.env.EMOTION_USE_GPT || '1') === '1';

// ------------ LRU CACHE ------------
const _cacheMax = 200;
const _cache = new Map(); // key: `${sceneLine}|${mainTopic}|${preferTransitions}`, value: string|null
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
    const first = _cache.keys().next().value;
    _cache.delete(first);
  }
}

// ------------ TEXT UTILS ------------
function _norm(s) {
  return String(s || '').trim();
}
function _lower(s) {
  return _norm(s).toLowerCase();
}
function _stripQuotes(s) {
  return String(s || '').replace(/^["'\s]+|["'\s]+$/g, '');
}
function _squash(s) {
  return _stripQuotes(s).replace(/\s+/g, ' ').trim();
}
function _between(wordCountMin, wordCountMax, s) {
  const n = _squash(s).split(/\s+/).filter(Boolean).length;
  return n >= wordCountMin && n <= wordCountMax;
}
function _removeLeadingVerbs(s) {
  return String(s || '').replace(/^(show|display|depict|visualize|cut to|see)\s+/i, '').trim();
}
function _neutralizePunctuation(s) {
  return String(s || '')
    .replace(/[“”"’']/g, '')
    .replace(/[.!?;:,]+$/g, '')
    .trim();
}

// ------------ GENERIC / BAN LISTS ------------
const BANNED_SOLO_GENERICS = new Set([
  'something','someone','person','people','scene','man','woman','it','thing','they','we','body','face','eyes','child','children','kid','kids'
]);

// Allow "man"/"woman" ONLY if paired with a *specific* emotion/action/adjective.
function _isAllowedHumanPhrase(phrase) {
  const L = _lower(phrase);
  if (!/\b(man|woman|boy|girl|child|kid|person)\b/.test(L)) return true; // no human word — allowed

  // Require an adjective or action verb indicating the emotion/action:
  // e.g., "worried woman biting nails", "man jumping for joy", "shocked face close-up"
  const hasDescriptor = /\b(worried|anxious|sad|happy|angry|furious|scared|afraid|shocked|surprised|confused|excited|joyful|relieved|embarrassed|nervous|tense|stressed|calm|serene|proud|ashamed|disgusted|bored|lonely|heartbroken|overwhelmed|pensive|thoughtful)\b/.test(L);
  const hasAction = /\b(crying|smiling|frowning|yelling|screaming|biting nails|pacing|trembling|jumping|cheering|hugging|sighing|laughing|gasping|covering mouth|covering face|hands on head|wide eyes|clenched fists|facepalm|eye roll|shrugging)\b/.test(L);
  return hasDescriptor || hasAction;
}

// ------------ EMOTION LEXICON (heuristics) ------------
// All visuals normalized to 5–10 words to match hard limiter.
const EMOTION_MAP = [
  { re: /\b(anxious|anxiety|worried|nervous|nerves|uneasy|tense|panic|panicky)\b/i, visuals: [
    'worried woman biting nails close-up shot',
    'anxious man wringing hands in hallway',
    'nervous person glancing around on subway',
  ]},
  { re: /\b(happy|joy|joyful|glad|delighted|cheerful|ecstatic|excited|thrilled|elated)\b/i, visuals: [
    'woman smiling brightly on camera close-up',
    'man jumping for joy in slow motion',
    'friends cheering together at city rooftop',
  ]},
  { re: /\b(sad|unhappy|down|blue|upset|depressed|gloomy|heartbroken)\b/i, visuals: [
    'sad person alone on park bench',
    'woman wiping tears by window light',
    'man staring out window in rain',
  ]},
  { re: /\b(angry|mad|furious|irate|rage|annoyed|irritated|frustrated)\b/i, visuals: [
    'man with clenched fists at desk',
    'woman frowning with furrowed brows',
    'person slamming desk in frustration',
  ]},
  { re: /\b(scared|afraid|fear|terrified|frightened|spooked)\b/i, visuals: [
    'person with wide eyes gasping close-up',
    'woman covering mouth in sudden shock',
    'man stepping back in fear indoors',
  ]},
  { re: /\b(shock|shocked|surprised|astonished|amazed|wow|plot twist)\b/i, visuals: [
    'face with shocked expression close-up shot',
    'woman with hands on cheeks surprised',
    'man gasping in surprise on street',
  ]},
  { re: /\b(confused|confusion|uncertain|unsure|perplexed|puzzled|dilemma)\b/i, visuals: [
    'person scratching head at computer screen',
    'woman looking puzzled at laptop screen',
    'man tilting head confused in office',
  ]},
  { re: /\b(relief|relieved|calm|serene|peaceful|composed)\b/i, visuals: [
    'person exhaling with relief by window',
    'calm woman closing eyes breathing deeply',
    'man taking deep breath on balcony',
  ]},
  { re: /\b(embarrassed|awkward|cringe|ashamed|guilty|guilt)\b/i, visuals: [
    'person covering face with hand embarrassed',
    'woman blushing and looking away shyly',
    'man rubbing neck awkwardly in office',
  ]},
  { re: /\b(proud|victory|win|winner|accomplish|achievement|achieved|trophy|medal)\b/i, visuals: [
    'athlete holding gold medal after race',
    'person raising trophy on stage lights',
    'student holding certificate with smile',
  ]},
  { re: /\b(lonely|alone|isolation|isolated)\b/i, visuals: [
    'lonely person on empty street at night',
    'silhouette sitting alone on park bench',
    'person looking out window alone inside',
  ]},
  { re: /\b(stressed|burned out|overwhelmed|overload|pressure)\b/i, visuals: [
    'person with head in hands at desk',
    'woman rubbing temples at laptop desk',
    'man surrounded by paperwork at office',
  ]},
];

// ------------ ACTION / TRANSITION LEXICON (heuristics) ------------
const TRANSITION_MAP = [
  { re: /\b(meanwhile|at the same time|in the meantime)\b/i, visuals: [
    'city skyline fast time-lapse shot',
    'fast moving clouds across blue sky',
    'busy crosswalk pedestrians time-lapse view',
  ]},
  { re: /\b(later that day|later|afterward|afterwards|soon after|minutes later|hours later)\b/i, visuals: [
    'clock hands spinning close-up shot',
    'sun moving across sky time-lapse',
    'day to night city time-lapse transition',
  ]},
  { re: /\b(earlier|before that|previously|rewind)\b/i, visuals: [
    'rewind tape animation retro vhs effect',
    'calendar flipping back with bold page',
    'reverse time effect with particles',
  ]},
  { re: /\b(let\'?s get started|let us begin|getting started|kick off|time to begin)\b/i, visuals: [
    'scene change animation dynamic swipe',
    'hand pressing start button macro shot',
    'opening title swipe with bold text',
  ]},
  { re: /\b(moving on|next up|on to|now for|the real secret)\b/i, visuals: [
    'hand pulling cloth to reveal object',
    'page turn animation clean paper flip',
    'bold swipe transition across screen',
  ]},
  { re: /\b(finally|at last|in conclusion|to wrap up|wrap it up)\b/i, visuals: [
    'closing curtain animation rich fabric',
    'checklist last item ticked close-up',
    'sunset timelapse ending scene visual',
  ]},
];

// ------------ PICKER UTILS ------------
function _pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function _heuristicEmotion(line) {
  for (const entry of EMOTION_MAP) {
    if (entry.re.test(line)) return _pick(entry.visuals);
  }
  return null;
}

function _heuristicTransition(line) {
  for (const entry of TRANSITION_MAP) {
    if (entry.re.test(line)) return _pick(entry.visuals);
  }
  return null;
}

// Ensure the result is short, literal, non-generic, and visually actionable.
function _sanitizeVisual(visual) {
  let v = _neutralizePunctuation(_removeLeadingVerbs(_squash(visual || '')));
  v = v.replace(/^output\s*[:\-]\s*/i, '').trim();

  // Remove quotes & trailing dots
  v = v.replace(/["“”]+/g, '').replace(/[.]+$/g, '').trim();

  // If someone sends a sentence, trim to first ~10 words
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length > 10) v = words.slice(0, 10).join(' ');

  // Block garbage or banned solos
  const l = _lower(v);
  if (!v || v.length < 3) return null;
  if (BANNED_SOLO_GENERICS.has(l)) return null;

  // Allow man/woman only with descriptor/action; else reject
  if (!_isAllowedHumanPhrase(v)) return null;

  // Prefer to start with a concrete subject word, not article
  v = v.replace(/^(a|an|the)\s+/i, '').trim();

  // Safety: if the first word is still too vague, reject
  if (/^(thing|stuff|object|idea)$/.test(_lower(v.split(/\s+/)[0] || ''))) return null;

  // Enforce 5–10 words (strict)
  if (!_between(5, 10, v)) return null;

  return v;
}

// ------------ OPENAI REFINEMENT (optional) ------------
const SYSTEM_PROMPT = `
You are an expert viral video editor and AI visual subject picker.
Given a script line, output ONLY a single, literal, visual subject/action (5–10 words).
- If the line expresses an EMOTION, show a person clearly displaying that emotion.
- If it's an ACTION CUE or TRANSITION (e.g., "Meanwhile", "Later that day"), return a literal transition visual (e.g., "city time-lapse", "clock spinning").
- No metaphors, no abstract concepts, no generic words like "something", "someone", "person", "people", "thing", "scene".
- Output ONLY the phrase (no sentences, no punctuation at end, no quotes).
Examples:
Input: "Feeling anxious?" → "worried woman biting nails close-up shot"
Input: "Let's get started!" → "scene change animation dynamic swipe"
Input: "Meanwhile, across town..." → "city skyline fast time-lapse shot"
Input: "Later that day" → "clock hands spinning close-up shot"
Input: "He's overjoyed" → "man jumping for joy in slow motion"
Input: "Now for the real secret" → "hand pulling cloth to reveal object"
Input: "What a plot twist!" → "face with shocked expression close-up shot"
`.trim();

async function _openaiSuggest(line, mainTopic, jobId) {
  if (!OPENAI_API_KEY || !EMOTION_USE_GPT) {
    console.warn('[10I][GPT] Skipping GPT refinement (disabled or missing API key).');
    return null;
  }

  const userPrompt = `
Script line: "${_stripQuotes(line)}"
Main topic: "${_stripQuotes(mainTopic || '')}"
Return ONLY the best literal visual subject/action (5–10 words). If unsure, say NO_MATCH.
`.trim();

  let attempt = 0;
  let lastErr = null;

  while (attempt <= OPENAI_RETRIES) { // attempts = retries+1
    try {
      console.log(`[10I][GPT][REQ][${jobId || 'job'}] attempt=${attempt + 1} model=${EMOTION_MODEL}`);
      const resp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: EMOTION_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 28,
          temperature: 0.3,
          n: 1,
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: OPENAI_TIMEOUT_MS,
        }
      );

      const raw = _squash(resp?.data?.choices?.[0]?.message?.content || '');
      console.log(`[10I][GPT][RAW][${jobId || 'job'}]`, raw);

      if (!raw || /^no[_\s-]?match$/i.test(raw)) return null;

      const sanitized = _sanitizeVisual(raw);
      if (!sanitized) return null;
      return sanitized;
    } catch (err) {
      lastErr = err;
      const code = err?.response?.status;
      console.error('[10I][GPT][ERR]', code || '', err?.message || err);
      // Exponential-ish backoff
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      attempt++;
    }
  }
  console.warn('[10I][GPT][GIVEUP] Returning null after retries.', lastErr ? `(last error: ${lastErr?.message || 'unknown'})` : '');
  return null;
}

// ------------ PUBLIC API ------------
/**
 * Analyze a script line for emotion/action/transition visuals.
 * Returns a short, literal, non-generic subject/action string, or null if no match.
 *
 * @param {string} sceneLine - A single scene/script line
 * @param {string} mainTopic - Optional general topic
 * @param {object} opts - { jobId?: string, preferTransitions?: boolean }
 * @returns {Promise<string|null>}
 */
async function extractEmotionActionVisual(sceneLine, mainTopic = '', opts = {}) {
  const jobId = opts?.jobId || '';
  const preferTransitions = !!opts?.preferTransitions;

  let line = _neutralizePunctuation(_squash(sceneLine || ''));
  if (!line || line.length < 2) {
    console.warn('[10I][SKIP] Empty/short line.');
    return null;
  }

  const cacheKey = `${line}|${mainTopic}|${preferTransitions ? 'T' : 'F'}`;
  const cached = _cacheGet(cacheKey);
  if (cached !== undefined) {
    console.log('[10I][CACHE][HIT]', cacheKey, '=>', cached);
    return cached;
  }

  console.log(`[10I][START][${jobId}] "${line}" (topic="${mainTopic || ''}")`);

  // 1) Transition-first (if user prefers or line obviously a transition)
  let heuristic;
  if (preferTransitions || /\b(meanwhile|later|earlier|moving on|next up|now for|finally|in conclusion|wrap up|rewind)\b/i.test(line)) {
    heuristic = _heuristicTransition(line);
    if (heuristic) {
      const sanitized = _sanitizeVisual(heuristic);
      if (sanitized) {
        console.log(`[10I][HEURISTIC][TRANSITION][${jobId}] "${line}" => "${sanitized}"`);
        _cacheSet(cacheKey, sanitized);
        return sanitized;
      }
    }
  }

  // 2) Emotion heuristic
  heuristic = _heuristicEmotion(line);
  if (heuristic) {
    const sanitized = _sanitizeVisual(heuristic);
    if (sanitized) {
      console.log(`[10I][HEURISTIC][EMOTION][${jobId}] "${line}" => "${sanitized}"`);
      _cacheSet(cacheKey, sanitized);
      return sanitized;
    }
  }

  // 3) Try the other heuristic path if we haven't yet
  if (!preferTransitions) {
    const maybeTrans = _heuristicTransition(line);
    if (maybeTrans) {
      const sanitized = _sanitizeVisual(maybeTrans);
      if (sanitized) {
        console.log(`[10I][HEURISTIC][TRANSITION2][${jobId}] "${line}" => "${sanitized}"`);
        _cacheSet(cacheKey, sanitized);
        return sanitized;
      }
    }
  }

  // 4) GPT refinement (optional)
  const gpt = await _openaiSuggest(line, mainTopic, jobId);
  if (gpt) {
    console.log(`[10I][GPT][RESULT][${jobId}] "${line}" => "${gpt}"`);
    _cacheSet(cacheKey, gpt);
    return gpt;
  }

  // 5) Nothing matched strongly — return null and let upstream fallbacks continue.
  console.warn(`[10I][NO_MATCH][${jobId}] No emotion/action/transition visual for: "${line}"`);
  _cacheSet(cacheKey, null);
  return null;
}

module.exports = { extractEmotionActionVisual };
