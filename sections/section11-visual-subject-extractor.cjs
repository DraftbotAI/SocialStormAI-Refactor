// ===========================================================
// SECTION 11: GPT VISUAL SUBJECT EXTRACTOR (STRICT, TOPIC-AWARE)
// Purpose:
//   Given a script line + the overall main topic, return the TOP 4
//   VISUAL-ONLY subjects we should try to show for that scene.
//
// Strategy (Stopword-first, AI fallback):
//   1) Use section10n-stopword-subject-extractor to get a literal subject.
//   2) Expand into concrete, filmable variants (angles/details).
//   3) If we still can't form 4 strong items, optionally call GPT.
//   4) Enforce strict species/object if configured.
//   5) Deterministic cleanup + de-dup + padding.
//
// Output:
//   Array<string> of length 4:
//     [ primary, contextual, alternate, general_fallback ]
//
// Notes:
//   - MAX LOGGING for full traceability.
//   - Safe when OPENAI_API_KEY is absent.
// ===========================================================

'use strict';

const path = require('path');
const fs = require('fs');

const { extractSubjectByStopwords, extractSubjectByStopwordsDetailed } =
  require('./section10n-stopword-subject-extractor.cjs');

// Prefer ChatGPTAPI if present in env (optional)
let ChatGPTAPI = null;
try {
  ChatGPTAPI = require('chatgpt').ChatGPTAPI;
} catch (_) { /* optional */ }

// Optional OpenAI SDK (fallback)
let OpenAI = null;
try {
  OpenAI = require('openai');
} catch (_) { /* optional */ }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_TOKEN || '';
if (!OPENAI_API_KEY) {
  console.warn('[11][WARN] OPENAI_API_KEY not set. AI fallback disabled (stopword-only mode).');
}

// ===== Config =====
const MODEL = process.env.SS_SUBJECT_MODEL || 'gpt-4.1-mini';
const TIMEOUT_MS = Number(process.env.SS_SUBJECT_TIMEOUT_MS || 16000);
const STRICT_SPECIES = String(process.env.SS_SUBJECT_STRICT || '1') === '1'; // keep exact species/object
const MAX_ITEMS = 4;

console.log(`[11][INIT] Visual Subject Extractor loaded. model=${MODEL} strict=${STRICT_SPECIES} timeout=${TIMEOUT_MS}ms`);

// ===== Utilities =====
function norm(s) { return String(s || '').toLowerCase().trim(); }
function normalizeForCompare(s) { return norm(s).replace(/[^a-z0-9]+/g, ''); }

function uniqueOrdered(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = normalizeForCompare(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function looksNonVisual(line) {
  const l = norm(line);
  const abstract = ['imagine', 'think', 'believe', 'history shows', 'legend', 'you know', 'they say', 'fact is'];
  return abstract.some(w => l.includes(w));
}

// ===== Canonicalizer for main topics =====
function canonicalizeTopic(mainTopicRaw) {
  const main = norm(mainTopicRaw);
  const out = {
    canonical: main,
    aliases: [],
    bannedNear: [],
    typeHint: null, // 'animal', 'landmark', 'object', ...
  };

  if (main.includes('manatee') || main === 'sea cow' || main.includes('sea cow')) {
    out.canonical = 'manatee';
    out.aliases = ['manatee', 'sea cow', 'west indian manatee', 'florida manatee', 'trichechus manatus'];
    out.bannedNear = [
      'dolphin','porpoise','whale','orca','shark','stingray','ray','manta',
      'seal','sea lion','otter','turtle','jellyfish','octopus','squid',
    ];
    out.typeHint = 'animal';
    return out;
  }

  // Add more special cases as needed (Eiffel Tower, Trevi Fountain, etc.)
  out.aliases = [main].filter(Boolean);
  out.typeHint = null;
  return out;
}

// ===== Local variation generator =====
function localSubjectVariationsForTopic(topic) {
  const t = canonicalizeTopic(topic);
  const base = t.canonical || topic || 'subject';
  if (t.canonical === 'manatee') {
    return uniqueOrdered([
      'manatee swimming underwater (side profile)',
      'manatee eating seagrass in shallow water',
      'mother manatee with calf (gentle swim)',
      'close-up of manatee face and whiskers',
      'group of manatees resting near a spring',
      'manatee tail and slow propulsion underwater',
    ]).slice(0, MAX_ITEMS);
  }
  return uniqueOrdered([
    `${base} close-up`,
    `${base} wide shot`,
    `${base} detail of texture or feature`,
    `${base} from a different angle`,
    `${base} in motion`,
  ]).slice(0, MAX_ITEMS);
}

// ===== Stopword-first expansion =====
function buildFromStopwords(line, mainTopic) {
  const detail = extractSubjectByStopwordsDetailed(line, mainTopic);
  const primary = detail.primary && String(detail.primary).trim();
  console.log('[11][STOPWORDS][CANDS]', detail.candidates);
  console.log(`[11][STOPWORDS][PRIMARY] "${primary}" (conf=${detail.confidence?.toFixed?.(2) ?? 'n/a'} src=${detail.debug?.source || 'n/a'})`);

  if (!primary) return [];

  // Build concrete, filmable variants around the primary
  const variations = uniqueOrdered([
    primary,
    `${primary} close-up`,
    `${primary} wide shot`,
    `${primary} detail (sculpture/texture/feature)`,
    `${primary} from a different angle`,
  ]);

  // Add one alternate from candidates if it differs materially
  const alt = (detail.candidates || []).find(c => normalizeForCompare(c) !== normalizeForCompare(primary));
  if (alt) variations.push(alt);

  // Pad with main topic variations if still short
  while (variations.length < MAX_ITEMS && mainTopic) {
    const pads = localSubjectVariationsForTopic(mainTopic);
    for (const p of pads) {
      if (variations.length >= MAX_ITEMS) break;
      if (!variations.find(x => normalizeForCompare(x) === normalizeForCompare(p))) variations.push(p);
    }
    break;
  }

  return variations.slice(0, MAX_ITEMS);
}

// ===== Prompt builder (for AI fallback only) =====
function buildPrompt(line, mainTopic) {
  const topic = canonicalizeTopic(mainTopic);
  const disallow = STRICT_SPECIES ? `NEVER substitute related species/objects (banned examples: ${topic.bannedNear.join(', ') || 'n/a'}).` : '';

  const mustContain = STRICT_SPECIES
    ? `Every item must explicitly mention ${topic.aliases.join(' or ')}.`
    : `Prefer items that explicitly mention ${topic.aliases.join(' or ')}.`;

  const instructions = [
    `You are a world-class short-form video editor.`,
    `TASK: For the given script line, list the 4 BEST visual subjects to show.`,
    `Focus the camera on the exact main topic: "${topic.canonical}".`,
    mustContain,
    disallow,
    `Only return visuals that can be literally filmed.`,
    `Avoid metaphors, jokes, emotions, or abstract ideas.`,
    `If the line is not visual, fall back to variations of the main topic.`,
    `Keep it concise and concrete.`,
    `Return EXACTLY ${MAX_ITEMS} items as a plain numbered list (no extra text).`,
  ].filter(Boolean).join('\n');

  const examples = [
    `Line: "They’re gentle giants that graze all day."`,
    `Main Topic: manatee`,
    `Answer:`,
    `1) manatee eating seagrass in shallow water`,
    `2) mother manatee with calf swimming slowly`,
    `3) close-up of a manatee face and whiskers`,
    `4) group of manatees resting near a spring`,
  ].join('\n');

  const user = [
    `Line: "${line}"`,
    `Main Topic: ${topic.canonical}`,
    `Answer:`,
  ].join('\n');

  const final = `${instructions}\n\n${examples}\n\n${user}`;
  return { prompt: final, topic };
}

// ===== Model callers (fallback) =====
async function callChatGPTAPI(prompt) {
  if (!ChatGPTAPI || !OPENAI_API_KEY) return null;
  const api = new ChatGPTAPI({ apiKey: OPENAI_API_KEY });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    console.log('[11][GPT][chatgpt] sending prompt...');
    const res = await api.sendMessage(prompt, {
      timeoutMs: TIMEOUT_MS - 500,
    });
    clearTimeout(t);
    const text = res?.text || '';
    console.log('[11][GPT][chatgpt][RAW]', text);
    return text;
  } catch (e) {
    clearTimeout(t);
    console.warn('[11][GPT][chatgpt][WARN]', e?.message || e);
    return null;
  }
}

async function callOpenAIChat(prompt) {
  if (!OpenAI || !OPENAI_API_KEY) return null;
  try {
    console.log('[11][GPT][openai] sending prompt...');
    const client = new OpenAI.OpenAI({ apiKey: OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You output numbered lists only.' },
        { role: 'user', content: prompt },
      ],
      timeout: TIMEOUT_MS,
    });
    const text = res?.choices?.[0]?.message?.content || '';
    console.log('[11][GPT][openai][RAW]', text);
    return text;
  } catch (e) {
    console.warn('[11][GPT][openai][WARN]', e?.message || e);
    return null;
  }
}

function parseNumberedList(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const items = [];
  for (const l of lines) {
    const m = l.match(/^\s*(?:\d+[\)\.:-]\s*)?(.*)$/);
    if (!m) continue;
    const val = m[1].trim();
    if (!val) continue;
    items.push(val);
  }
  return items;
}

function enforceStrictness(items, topic) {
  if (!items || !items.length) return [];
  if (!STRICT_SPECIES) return items;
  const allowedTokens = topic.aliases.map(norm);
  const keep = [];
  for (const it of items) {
    const low = norm(it);
    const ok = allowedTokens.some(tok => low.includes(tok));
    if (ok) keep.push(it);
  }
  return keep.length ? keep : localSubjectVariationsForTopic(topic.canonical);
}

function padToFour(items, topic) {
  const out = [...items];
  while (out.length < MAX_ITEMS) {
    const fallbackList = localSubjectVariationsForTopic(topic.canonical);
    for (const cand of fallbackList) {
      if (out.length >= MAX_ITEMS) break;
      if (!out.find(x => normalizeForCompare(x) === normalizeForCompare(cand))) {
        out.push(cand);
      }
    }
    if (out.length >= MAX_ITEMS) break;
    out.push(topic.canonical || 'subject');
  }
  return out.slice(0, MAX_ITEMS);
}

/**
 * MAIN EXPORT:
 * extractVisualSubjects(line: string, mainTopic: string): Promise<string[]>
 */
async function extractVisualSubjects(line, mainTopic) {
  const lineStr = String(line || '').trim();
  const main = String(mainTopic || '').trim();
  console.log(`[11][INPUT] line="${lineStr}" mainTopic="${main}"`);

  const topic = canonicalizeTopic(main);
  if (!lineStr) {
    console.warn('[11][WARN] Blank line. Returning local variations.');
    return localSubjectVariationsForTopic(main);
  }

  // 1) Stopword-first suggestion
  let items = buildFromStopwords(lineStr, main);
  items = uniqueOrdered(items);

  // Safety: if the line is abstract, bias toward main topic variations
  if (looksNonVisual(lineStr)) {
    const local = localSubjectVariationsForTopic(topic.canonical);
    items = uniqueOrdered([...local.slice(0, 2), ...items]).slice(0, MAX_ITEMS);
  }

  // 2) If we still don’t have 4, try AI as fallback (only if API key present)
  if (items.length < MAX_ITEMS && OPENAI_API_KEY) {
    const { prompt } = buildPrompt(lineStr, main);
    console.log('[11][PROMPT]\n' + prompt);
    let raw = await callChatGPTAPI(prompt);
    if (!raw) raw = await callOpenAIChat(prompt);
    const aiItems = parseNumberedList(raw);
    console.log('[11][PARSED_AI]', aiItems);
    items = uniqueOrdered([...items, ...aiItems]);
  }

  // 3) Strict filter + pad
  items = enforceStrictness(items, topic);
  items = uniqueOrdered(items);
  items = padToFour(items, topic);

  console.log('[11][RESULT]', items);
  return items;
}

// === CLI test helper ===
if (require.main === module) {
  (async () => {
    const testLine = process.argv.slice(2).join(' ') || 'They’re gentle giants that graze all day.';
    const main = 'manatee';
    const res = await extractVisualSubjects(testLine, main);
    console.log('Extracted subjects:', res);
  })().catch(err => {
    console.error('[11][CLI][ERR]', err);
    process.exit(1);
  });
}

module.exports = { extractVisualSubjects, canonicalizeTopic };
