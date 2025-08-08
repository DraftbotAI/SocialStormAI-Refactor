// ===========================================================
// SECTION 10L: REPETITION BLOCKER & VARIETY HANDLER (Bulletproof)
// Detects if a subject/visual was recently used too many times.
// If repeated, returns a new angle, text-only scene, or variety fallback.
// MAX LOGGING every step, never blocks, always returns a valid subject.
// Anti-generic, anti-silent, anti-infinite. Foolproof.
//
// Exports:
//  - breakRepetition(subject, prevSubjects?, options?)
//  - initJob(jobId)
//  - filterCandidates(jobId, sceneIdx, subject, candidates)
//  - registerSelection(jobId, sceneIdx, subject, selected)
//  - isRepeat(jobId, subjectOrKey)
//  - getUsage(jobId)
//  - endJob(jobId)
//
// Compatibility:
//  - Keeps your original `breakRepetition(subject, prevSubjects, options)`
//    so existing calls in 5D continue to work.
//  - Adds optional job-scoped helpers for stronger de-duping if wired in.
// ===========================================================

'use strict';

const axios = require('axios');

// ==== ENV / API ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
if (!OPENAI_API_KEY) {
  console.error('[10L][BOOT][WARN] Missing OPENAI_API_KEY in environment! Will use heuristic fallbacks only.');
}
const MODEL_10L = (process.env.OPENAI_MODEL_10L || 'gpt-4o').trim();

// ==== CONSTANTS ====
const DEFAULT_AXIOS_TIMEOUT_MS = 15000;
const DEFAULT_TIME_BUDGET_MS = 12000; // hard helper budget
const MAX_RETRIES = 1;                 // short retry; we fail fast to fallback
const INITIAL_BACKOFF_MS = 500;

// Extra: Even more generic subjects to block
const GENERIC_SUBJECTS = [
  'face','person','man','woman','it','thing','someone','something',
  'body','eyes','people','scene','child','children','sign','logo','text',
  'boy','girl','they','we','background','sky','view','caption','photo',
  'question','mark','unknown','undefined','generic'
];

// ==== UTILITIES ====
function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalized(str = '') {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function cleanPhrase(s = '') {
  // one line, strip quotes & emojis, lower, no trailing punct
  let out = String(s || '').split('\n')[0]
    .replace(/^output\s*[:\-]\s*/i, '')
    .replace(/[“”"]/g, '')
    .replace(/\s*&\s*/g, ' and ')
    .trim();

  out = out
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]+/gu, '')
    .replace(/[.?!,:;]+$/g, '')
    .replace(/[\[\]\(\){}]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}

function isGeneric(subject = '') {
  const n = normalized(subject);
  if (!n) return true;
  return GENERIC_SUBJECTS.some(g => n === normalized(g) || n.includes(normalized(g)));
}

function enforceWordBounds(phrase, min = 3, max = 10) {
  const toks = String(phrase || '').split(/\s+/).filter(Boolean);
  if (toks.length > max) return toks.slice(0, max).join(' ');
  // allow < min; upstream decides if too short and swap to fallback
  return toks.join(' ');
}

function isRepeatOfRecent(subject, recentNormalizedSet) {
  const n = normalized(subject);
  return n && recentNormalizedSet.has(n);
}

function makeRecentSet(prevSubjects = [], maxWindow = 2) {
  const recent = prevSubjects.slice(-maxWindow).map(normalized);
  return new Set(recent);
}

function varietyTemplates(subject) {
  // Fallback generator: derives angles/contexts without LLM.
  const s = cleanPhrase(subject);
  const base = s || 'subject';
  // Prefer angle/context changes. Keep 3–10 words where possible.
  return [
    `${base} from above`,
    `${base} wide angle view`,
    `${base} closeup detail`,
    `${base} in motion`,
    `${base} with crowd`,
    `${base} in nature`,
    `${base} in neon lights`,
    `${base} silhouette at sunset`
  ].map(p => enforceWordBounds(cleanPhrase(p)));
}

function pickFirstNonGeneric(list = [], recentSet, currNorm) {
  for (const cand of list) {
    const c = cleanPhrase(cand);
    if (!c || c.length < 3) continue;
    if (isGeneric(c)) continue;
    if (recentSet && (recentSet.has(normalized(c)) || normalized(c) === currNorm)) continue;
    return enforceWordBounds(c);
  }
  return null;
}

// ==== LLM CALL ====
async function callOpenAI(prompt, timeLeftMs) {
  const timeoutMs = Math.min(DEFAULT_AXIOS_TIMEOUT_MS, Math.max(2000, timeLeftMs));
  console.log(`[10L][HTTP][POST] /chat/completions model=${MODEL_10L} timeoutMs=${timeoutMs}`);
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: MODEL_10L,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_tokens: 32,
      temperature: 0.6,
      n: 1,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    }
  );
  return res;
}

// ==== PROMPT ====
const SYSTEM_PROMPT = `
You are a world-class viral short-form video editor.
Recent scenes repeated the same visual. Suggest a NEW visual, angle, style, or related subject for variety.

Absolute rules:
- Output only ONE short visual phrase (3–10 words).
- All lowercase, no trailing punctuation, no emojis, no sentences.
- DO NOT repeat the last subject or any of the recent subjects.
- NEVER return a generic like "person", "scene", "caption".
- If truly stuck, output exactly: text-only viral caption card

Examples:
- Input: "cat closeup" after 3 repeats → "cat jumping from table", "cat with family"
- Input: "lebron james dunk" after 2 repeats → "lebron james celebrating", "basketball crowd cheering"
`.trim();

// ==== CORE (Stateless) ====
// Preserves your original API, adds budget + retries internally.
/**
 * Checks repetition and returns a variety subject if repeated.
 * Always returns a string (may be "text-only viral caption card").
 *
 * @param {string} subject
 * @param {Array<string>} prevSubjects - latest last
 * @param {object} options
 *  - maxRepeats: number (default 2)
 *  - varietyMode: string ('auto' reserved)
 *  - timeBudgetMs: number (default 12s)
 * @returns {Promise<string>}
 */
async function breakRepetition(subject, prevSubjects = [], options = {}) {
  const started = nowMs();
  const maxRepeats = typeof options.maxRepeats === 'number' ? options.maxRepeats : 2;
  const timeBudgetMs = Math.max(3000, Number(options.timeBudgetMs) || DEFAULT_TIME_BUDGET_MS);
  const varietyMode = options.varietyMode || 'auto';

  const currNorm = normalized(subject);
  const recentSet = makeRecentSet(prevSubjects, maxRepeats);
  const repeatCount = prevSubjects.slice(-maxRepeats).map(normalized).filter(s => s === currNorm).length;

  console.log(`[10L][CHECK] "${subject}" | recent(${maxRepeats}): ${JSON.stringify([...recentSet])} | repeats: ${repeatCount} | mode=${varietyMode}`);

  // If subject is generic, always force variety
  if (isGeneric(subject)) {
    console.warn(`[10L][GENERIC_BLOCK] Subject "${subject}" is generic → forcing variety fallback.`);
    const canned = pickFirstNonGeneric(varietyTemplates(subject), recentSet, currNorm);
    if (canned) {
      console.log('[10L][FALLBACK][TEMPLATE_GENERIC]', canned);
      return canned;
    }
    return 'text-only viral caption card';
  }

  // Not over threshold → keep
  if (repeatCount < maxRepeats) {
    console.log('[10L][PASS] Not past repeat threshold, keeping subject.');
    return enforceWordBounds(cleanPhrase(subject));
  }

  // No API? Use heuristic templates
  if (!OPENAI_API_KEY) {
    console.warn('[10L][NO_API] No OpenAI key, using heuristic templates.');
    const canned = pickFirstNonGeneric(varietyTemplates(subject), recentSet, currNorm);
    if (canned) {
      console.log('[10L][FALLBACK][TEMPLATE_NOAPI]', canned);
      return canned;
    }
    return 'text-only viral caption card';
  }

  // === LLM attempt with minimal retries + backoff ===
  const userPrompt = `
current subject: "${String(subject || '').trim()}"
recent subjects: ${JSON.stringify(prevSubjects.slice(-maxRepeats))}
Output ONLY a new literal visual (3–10 words). If stuck, "text-only viral caption card".
  `.trim();

  let attempt = 0;
  let lastStatus = null;

  while (attempt <= MAX_RETRIES) {
    const used = nowMs() - started;
    const left = timeBudgetMs - used;
    if (left <= 250) {
      console.warn(`[10L][TIMEOUT][ATTEMPT=${attempt}] Budget exhausted → fallbacks.`);
      break;
    }

    if (attempt > 0) {
      const backoff = Math.min(INITIAL_BACKOFF_MS * (2 ** (attempt - 1)), 1500);
      console.log(`[10L][RETRY][ATTEMPT=${attempt}] Backoff ${backoff}ms (left=${left}ms)`);
      await sleep(Math.min(backoff, Math.max(0, left - 150)));
    }

    console.log(`[10L][HTTP][ATTEMPT=${attempt}] Calling OpenAI (left=${left}ms)`);
    const httpRes = await callOpenAI(userPrompt, left);
    lastStatus = httpRes?.status;

    if (!httpRes) {
      console.error(`[10L][ERR][ATTEMPT=${attempt}] Empty HTTP response.`);
      attempt++;
      continue;
    }

    if (httpRes.status < 200 || httpRes.status >= 300) {
      console.error(`[10L][ERR][HTTP_STATUS][ATTEMPT=${attempt}] status=${httpRes.status}`, httpRes.data);
      if ([408,409,429,500,502,503,504].includes(httpRes.status) && attempt < MAX_RETRIES) {
        attempt++;
        continue;
      }
      break;
    }

    let raw = cleanPhrase(httpRes?.data?.choices?.[0]?.message?.content || '');
    raw = enforceWordBounds(raw);

    if (!raw || raw.length < 3) {
      console.warn(`[10L][NO_MATCH][ATTEMPT=${attempt}] Empty/too short.`);
      if (attempt < MAX_RETRIES) { attempt++; continue; }
    } else if (isGeneric(raw)) {
      console.warn(`[10L][GENERIC_REJECT][ATTEMPT=${attempt}] "${raw}"`);
      if (attempt < MAX_RETRIES) { attempt++; continue; }
    } else if (isRepeatOfRecent(raw, recentSet) || normalized(raw) === currNorm) {
      console.warn(`[10L][REPEAT_REJECT][ATTEMPT=${attempt}] "${raw}" still repeats.`);
      if (attempt < MAX_RETRIES) { attempt++; continue; }
    } else {
      console.log(`[10L][RESULT] "${subject}" → "${raw}" (status=${httpRes.status})`);
      return raw;
    }

    attempt++;
  }

  // === FALLBACKS ===
  const templated = pickFirstNonGeneric(varietyTemplates(subject), recentSet, currNorm);
  if (templated) {
    console.log(`[10L][FALLBACK][TEMPLATE_STATUS=${lastStatus ?? 'n/a'}]`, templated);
    return templated;
  }

  console.warn('[10L][FALLBACK][TEXT_ONLY] Using caption card fallback.');
  return 'text-only viral caption card';
}

// ===================================================================
// OPTIONAL: Job-scoped repetition manager for deeper integration
// ===================================================================

/**
 * Internal state: jobId -> {
 *   usedSubjects: Set<string>, // normalized subjects
 *   usedKeys: Set<string>,     // R2 keys / filenames / stems
 *   history: Array<{sceneIdx, subject, key?, when}>
 * }
 */
const __jobs = new Map();

function initJob(jobId) {
  if (!jobId) {
    console.warn('[10L][STATE][WARN] initJob called without jobId.');
    return;
  }
  if (!__jobs.has(jobId)) {
    __jobs.set(jobId, {
      usedSubjects: new Set(),
      usedKeys: new Set(),
      history: []
    });
    console.log(`[10L][STATE][INIT] jobId=${jobId}`);
  } else {
    console.log(`[10L][STATE][INIT_DUP] jobId=${jobId} already exists; reusing.`);
  }
}

function getJob(jobId) {
  const j = __jobs.get(jobId);
  if (!j) {
    console.warn('[10L][STATE][MISS] jobId not initialized:', jobId);
  }
  return j;
}

function subjectStem(s = '') {
  return normalized(s);
}

function keyStem(k = '') {
  const n = String(k || '').toLowerCase().trim();
  // strip extension
  const base = n.replace(/\.[a-z0-9]+$/i, '');
  // just take last segment of path
  const last = base.split(/[\\/]/).pop() || base;
  // remove trailing hashes if present
  return last.replace(/[-_][a-f0-9]{6,}$/i, '');
}

function isRepeat(jobId, subjectOrKey) {
  const job = getJob(jobId);
  if (!job) return false;
  const n = subjectStem(subjectOrKey);
  const k = keyStem(subjectOrKey);
  return job.usedSubjects.has(n) || job.usedKeys.has(k);
}

/**
 * Remove exact repeats from a candidate list (by R2 key, filename, or normalized path).
 * candidates: Array<{ key?: string, path?: string, url?: string, filename?: string, score?: number }>
 */
function filterCandidates(jobId, sceneIdx, subject, candidates = []) {
  const job = getJob(jobId);
  if (!job) return candidates;

  const blocked = [];
  const accepted = [];

  for (const c of candidates) {
    const k = keyStem(c.key || c.filename || c.path || c.url || '');
    if (!k) {
      console.warn('[10L][FILTER][WARN] Candidate missing key/path/filename:', c);
      accepted.push(c); // don’t drop unknowns—let 5D handle later
      continue;
    }
    if (job.usedKeys.has(k)) {
      blocked.push(k);
      continue;
    }
    accepted.push(c);
  }

  if (blocked.length) {
    console.log(`[10L][FILTER][SCENE=${sceneIdx}] Blocked repeats: ${blocked.join(', ')}`);
  } else {
    console.log(`[10L][FILTER][SCENE=${sceneIdx}] No candidate repeats detected.`);
  }

  // Keep order; let 5D/10G scoring choose best from accepted.
  return accepted;
}

/**
 * Register the final selection for a scene to prevent repeats later.
 * selected: { key?: string, filename?: string, path?: string }
 */
function registerSelection(jobId, sceneIdx, subject, selected = {}) {
  const job = getJob(jobId);
  if (!job) return;

  const subjectN = subjectStem(subject);
  if (subjectN) job.usedSubjects.add(subjectN);

  const k = keyStem(selected.key || selected.filename || selected.path || '');
  if (k) job.usedKeys.add(k);

  job.history.push({
    sceneIdx,
    subject: subjectN || '(none)',
    key: k || '(none)',
    when: Date.now()
  });

  console.log(`[10L][REGISTER][SCENE=${sceneIdx}] subject=${subjectN} key=${k}`);
}

function getUsage(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  return {
    usedSubjects: [...job.usedSubjects],
    usedKeys: [...job.usedKeys],
    history: [...job.history],
  };
}

function endJob(jobId) {
  if (!jobId) return;
  if (__jobs.delete(jobId)) {
    console.log(`[10L][STATE][END] Cleared job state for jobId=${jobId}`);
  }
}

// ===========================================================
module.exports = {
  breakRepetition,
  initJob,
  filterCandidates,
  registerSelection,
  isRepeat,
  getUsage,
  endJob,
};
