// ===========================================================
// SECTION 10H: SYMBOLIC SCENE MATCHER (GPT-powered, Bulletproof)
// Handles metaphors, abstract, emotion, question, and multi-subject lines.
// Returns a smart visual subject (single, literal, visual, non-generic).
// Used as a fallback or enhancement alongside visual subject extractor.
// MAX LOGGING at every step, crash-proof, never silent-fails.
// 2025-08 UPGRADE NOTES:
// - Deterministic, short literal outputs (3–9 words), no sentences.
// - Hard filters for generics & abstractions; landmark/people/action bias.
// - One safe retry with a stricter, “literalize” prompt.
// - Normalizes punctuation/quotes, strips verbs like “show/display”.
// - Last-ditch rule-based fallback (topic nouns / famous symbol map).
// - Tunable via VISUAL_SYMBOLIC_MODEL + timeouts, no silent fails.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('[10H][FATAL] Missing OPENAI_API_KEY in environment!');
}

const VISUAL_SYMBOLIC_MODEL =
  process.env.VISUAL_SYMBOLIC_MODEL
  || process.env.VISUAL_SUBJECT_MODEL
  || 'gpt-4.1';

const AXIOS_TIMEOUT_MS = Number(process.env.SYMBOLIC_TIMEOUT_MS || 18000);

// -----------------------------
// Lexicons & helpers
// -----------------------------
const GENERIC_TERMS = new Set([
  // useless pronouns / placeholders
  'something','someone','somebody','thing','anything','anyone','person','people','we','they','it',
  // vague visuals
  'scene','view','image','photo','object','stuff','background','concept','idea','metaphor','symbol',
  // too generic body parts without context
  'face','eyes','body','hand','hands'
]);

const ABSTRACT_TERMS = new Set([
  'royalty','success','power','creativity','innovation','freedom','victory','happiness','sadness',
  'anxiety','love','heartbreak','wealth','motivation','focus','fear','anger','joy','hope','destiny',
  'truth','lies','wisdom','knowledge','mystery','luck','chaos','order','patience'
]);

const STOPWORDS = new Set([
  'the','a','an','of','and','to','in','on','with','for','from','by','as','at','is','are','was','were',
  'do','does','did','be','been','being','or','if','then','so','that','this','these','those','than','but',
  'into','over','under','about','around','after','before','during','without','within','between','up','down'
]);

const FAMOUS_SYMBOL_MAP = {
  royalty: 'royal figure wearing purple robe',
  victory: 'athlete raising a gold trophy',
  success: 'businessperson holding briefcase on city skyline',
  creativity: 'artist painting with bright colors',
  innovation: 'person holding a glowing lightbulb',
  wealth: 'hand counting cash bills',
  heartbreak: 'person alone on bench at sunset',
  anxiety: 'worried person biting nails',
  love: 'couple holding hands at sunset',
  freedom: 'person running on open beach',
  power: 'leader at podium with crowd',
};

function lower(s) { return String(s || '').trim().toLowerCase(); }
function stripQuotes(s) { return String(s || '').replace(/^["'\s]+|["'\s]+$/g, ''); }
function cleanOutput(s) {
  return stripQuotes(
    String(s || '')
      .replace(/^output\s*[:\-]\s*/i, '')
      .replace(/^(show|display|use|visualize)\s+/i, '')
      .replace(/^[\-\•\d\)\.]+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function isGeneric(s) {
  const L = lower(s);
  if (!L) return true;
  // obvious generic tokens
  for (const t of GENERIC_TERMS) if (L === t || L.includes(` ${t} `)) return true;
  // single vague word
  if (!/\s/.test(L) && (GENERIC_TERMS.has(L) || ABSTRACT_TERMS.has(L))) return true;
  // ends with pure category words
  if (/^(something|someone|scene|image|photo|object)$/i.test(L)) return true;
  // sentence-like or too long
  if (/[\.!?]$/.test(L) || L.split(/\s+/).length > 11) return true;
  return false;
}

function enforceLiterality(s) {
  let out = cleanOutput(s);
  // remove abstract-only endings like "concept", "idea"
  out = out.replace(/\b(concept|idea|metaphor|symbol|theme)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  // prefer a noun phrase with optional modifier; cut trailing clauses
  out = out.replace(/\b(while|because|as|so that|which|that)\b.*$/i, '').trim();
  // guard minimum & maximum word count
  const words = out.split(/\s+/).filter(Boolean);
  if (words.length < 2 && !/\b(cat|dog|car|tree|castle|tower|bridge|wall|mountain|beach|trophy|medal|lightbulb|bench|painting)\b/i.test(out)) {
    // nudge to a slightly more descriptive noun phrase
    out = `${out} close-up`;
  }
  if (words.length > 9) {
    out = words.slice(0, 9).join(' ');
  }
  return out.trim();
}

function majorWords(s) {
  return lower(s)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 2 && !STOPWORDS.has(w));
}

function pickTopicNoun(sceneLine, mainTopic) {
  // Prefer capitalized proper-ish phrase from the line, else main topic major word, else first major word
  const line = String(sceneLine || '');
  const caps = (line.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g) || []).map(stripQuotes);
  if (caps.length) return caps[0].toLowerCase();
  const mt = (majorWords(mainTopic || '')[0]) || '';
  if (mt) return mt;
  const mw = (majorWords(line)[0]) || '';
  return mw || 'landmark';
}

function lastResortFallback(sceneLine, mainTopic) {
  const topic = pickTopicNoun(sceneLine, mainTopic);
  // famous symbol if known abstract topic
  const famous = FAMOUS_SYMBOL_MAP[topic] || FAMOUS_SYMBOL_MAP[lower(mainTopic || '')];
  if (famous) return famous;
  // safe visual templates
  if (/(castle|fort|tower|wall|bridge|pyramid|temple|cathedral|palace)/i.test(sceneLine) || /(castle|fort|tower|wall|bridge|pyramid|temple|cathedral|palace)/i.test(mainTopic || '')) {
    return 'iconic landmark wide shot';
  }
  if (/(how|why|what|when|where|who)\b/i.test(sceneLine)) {
    return `${topic} close-up`;
  }
  if (/(victory|win|success)/i.test(sceneLine) || /(medal|trophy)/i.test(sceneLine)) {
    return 'athlete holding a trophy';
  }
  if (/(heartbreak|sad|lonely|anxious|anxiety|worry|worried)/i.test(sceneLine)) {
    return 'person alone on bench';
  }
  // generic but visual noun phrase
  return `${topic} cinematic close-up`;
}

// -----------------------------
// Prompts
// -----------------------------
const SYSTEM_PROMPT = `
You are a senior short-form video editor.
Your task: Convert each script line into ONE literal, visual subject or action that can be filmed or shown.
HARD RULES:
- Output a single short noun phrase (3–9 words), no sentences, no punctuation at end.
- Must be physically showable: objects, places, people, or actions.
- Avoid metaphors, concepts, icons-only words, and vague terms.
- Prefer famous or highly recognizable visuals if relevant to the topic.
- If line is a question, choose the clearest literal visual of the core topic.
- If emotion, choose a concrete human expression or action (e.g., "worried person biting nails").
- Never output placeholders like "someone", "something", "scene", "image", "object", "background".
Return ONLY the noun phrase.
`.trim();

function userPrompt(line, topic) {
  return [
    `Script line: "${String(line || '').trim()}"`,
    `Main topic: "${String(topic || '').trim()}"`,
    `Return ONE literal visual subject/action (3–9 words). No sentences. No explanations.`
  ].join('\n');
}

function userPromptRetry(line, topic) {
  return [
    `Script line: "${String(line || '').trim()}"`,
    `Main topic: "${String(topic || '').trim()}"`,
    `Your previous answer was too abstract or generic.`,
    `Return ONE concrete, famous or visually clear subject (3–9 words).`,
    `Only nouns/adjectives allowed, avoid verbs like "show/display".`,
    `Examples: "royal figure wearing purple robe", "athlete raising a gold trophy", "worried person biting nails".`,
    `Output only the phrase.`
  ].join('\n');
}

// -----------------------------
// Core API call
// -----------------------------
async function callOpenAIOnce(prompt, { model = VISUAL_SYMBOLIC_MODEL, temperature = 0.2, max_tokens = 30, timeout = AXIOS_TIMEOUT_MS } = {}) {
  const payload = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    max_tokens,
    temperature,
    n: 1,
  };

  const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout,
  });

  const text = res.data?.choices?.[0]?.message?.content ?? '';
  return cleanOutput(text);
}

// small delay for retry backoff
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -----------------------------
// Public API
// -----------------------------
async function extractSymbolicVisualSubject(sceneLine, mainTopic = '') {
  if (!OPENAI_API_KEY) {
    console.error('[10H][FATAL] No OpenAI API key for symbolic matcher!');
    // still try rule-based fallback so upstream never breaks
    const fb = lastResortFallback(sceneLine, mainTopic);
    console.warn('[10H][FALLBACK][NO_KEY]', fb);
    return fb;
  }

  const line = String(sceneLine || '').trim();
  const topic = String(mainTopic || '').trim();

  console.log(`[10H][INPUT] line="${line}" | topic="${topic}"`);

  try {
    // First pass (deterministic)
    const p1 = userPrompt(line, topic);
    console.log(`[10H][PROMPT1] ${p1}`);
    let out = await callOpenAIOnce(p1);

    out = enforceLiterality(out);
    console.log(`[10H][RAW1] "${out}"`);

    if (isGeneric(out) || ABSTRACT_TERMS.has(lower(out))) {
      console.warn(`[10H][RETRY_TRIGGER] Output too generic/abstract: "${out}"`);
      // Retry once with stricter instructions
      await sleep(400 + Math.floor(Math.random() * 300));
      const p2 = userPromptRetry(line, topic);
      console.log(`[10H][PROMPT2] ${p2}`);
      let out2 = await callOpenAIOnce(p2, { temperature: 0.15, max_tokens: 28 });
      out2 = enforceLiterality(out2);
      console.log(`[10H][RAW2] "${out2}"`);

      if (!isGeneric(out2) && !ABSTRACT_TERMS.has(lower(out2))) {
        console.log(`[10H][RESULT][RETRY_OK] "${line}" => "${out2}"`);
        return out2;
      }

      // both failed => fallback
      const fb = lastResortFallback(line, topic);
      console.warn(`[10H][RESULT][RULE_FALLBACK] "${line}" => "${fb}"`);
      return fb;
    }

    console.log(`[10H][RESULT][OK] "${line}" => "${out}"`);
    return out;
  } catch (err) {
    if (err?.response) {
      console.error('[10H][ERR][HTTP]', err.response.status, err.response.data);
    } else {
      console.error('[10H][ERR]', err?.message || err);
    }
    // Final guard — rule-based fallback
    const fb = lastResortFallback(sceneLine, mainTopic);
    console.warn(`[10H][FALLBACK][EXCEPTION] "${sceneLine}" => "${fb}"`);
    return fb;
  }
}

module.exports = { extractSymbolicVisualSubject };
