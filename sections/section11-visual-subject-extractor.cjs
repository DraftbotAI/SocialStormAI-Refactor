// ===========================================================
// SECTION 11: GPT VISUAL SUBJECT EXTRACTOR (STRICT, TOPIC-AWARE)
// Purpose:
//   Given a script line + the overall main topic, return the TOP 4
//   VISUAL-ONLY subjects we should try to show for that scene.
//
// Hard rules:
//   - Subjects must be LITERAL, FILMABLE visuals (no metaphors).
//   - STRICT SPECIES/OBJECT: Do NOT swap lookalikes (e.g., manatee ≠ dolphin).
//   - Prefer variations/angles of the SAME subject before drifting.
//   - If a line is abstract, FALL BACK to the main topic variations.
//
// Output:
//   Array<string> of length 4:
//     [ primary, contextual, alternate, general_fallback ]
//
// Notes:
//   - Deterministic cleanup + de-duplication.
//   - API failure-safe: high-quality local fallback generator.
//   - MAX LOGGING for full traceability.
// ===========================================================

'use strict';

const path = require('path');
const fs = require('fs');

// Prefer ChatGPTAPI if present in env (project has used this)
let ChatGPTAPI = null;
try {
  ChatGPTAPI = require('chatgpt').ChatGPTAPI;
} catch (e) {
  // Optional: will fall back to OpenAI SDK if available
}

let OpenAI = null;
try {
  OpenAI = require('openai');
} catch (e) {
  // optional
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_TOKEN || '';
if (!OPENAI_API_KEY) {
  console.warn('[11][WARN] OPENAI_API_KEY not set. Will use LOCAL fallback only.');
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
  // crude heuristic for abstract lines
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
      // common false positives in marine stock
      'dolphin','porpoise','whale','orca','shark','stingray','ray','manta',
      'seal','sea lion','otter','turtle','jellyfish','octopus','squid',
    ];
    out.typeHint = 'animal';
    return out;
  }
  
  // Add more special cases as needed (Eiffel Tower, Trevi Fountain, etc.)
  // Generic default:
  out.aliases = [main];
  out.typeHint = null;
  return out;
}

// ===== Local fallback generator (high quality) =====
function localSubjectVariationsForTopic(topic) {
  const t = canonicalizeTopic(topic);
  const base = t.canonical || topic || 'subject';
  // Provide camera/behavior variations; keep literal + filmable
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
  // Generic variations for unknown topics
  return uniqueOrdered([
    `${base} close-up`,
    `${base} wide shot`,
    `${base} from a different angle`,
    `${base} with minimal background`,
    `${base} in motion`,
  ]).slice(0, MAX_ITEMS);
}

// ===== Prompt builder =====
function buildPrompt(line, mainTopic) {
  const topic = canonicalizeTopic(mainTopic);
  const disallow = STRICT_SPECIES ? `NEVER substitute related species/objects (banned examples: ${topic.bannedNear.join(', ') || 'n/a'}).` : '';
  
  // We require that results CENTER the exact main topic (or its explicit aliases).
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

// ===== Model callers =====
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
  // If strict filtering removes all, fall back to local variations
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
    // emergency fill with topic itself
    out.push(topic.canonical);
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

  if (!lineStr) {
    console.warn('[11][WARN] Blank line. Returning local variations.');
    return localSubjectVariationsForTopic(main);
  }

  const { prompt, topic } = buildPrompt(lineStr, main);
  console.log('[11][PROMPT]\n' + prompt);

  // 1) Try chatgpt package
  let raw = await callChatGPTAPI(prompt);

  // 2) Fallback to OpenAI SDK
  if (!raw) raw = await callOpenAIChat(prompt);

  // 3) Parse
  let items = parseNumberedList(raw);
  console.log('[11][PARSED]', items);

  // 4) Strict filter + de-dup + pad
  items = enforceStrictness(items, topic);
  items = uniqueOrdered(items);
  items = padToFour(items, topic);

  // Special non-visual line safety net
  if (looksNonVisual(lineStr)) {
    const local = localSubjectVariationsForTopic(topic.canonical);
    // Merge local first to ensure camera stays on topic
    items = uniqueOrdered([...local.slice(0, 2), ...items]).slice(0, MAX_ITEMS);
  }

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
