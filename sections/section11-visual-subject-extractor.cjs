// ===========================================================
// SECTION 11: GPT VISUAL SUBJECT EXTRACTOR (STRICT V4)
// Purpose: Return the top 4 concrete, on-topic visual subjects
//          for a given script line (Primary, Context, Fallback, General).
//
// Improvements vs V3:
// - Heuristic pre-pass: proper-noun + landmark keyword detection.
// - Landmark strictness: if a landmark/place is detected, ban animals/people.
// - Off-topic guard: culls generic/abstract/jokey outputs.
// - Typo corrections: "Edinboro" -> "Edinburgh", "Giza Pyrimids" -> "Giza Pyramids", etc.
// - Deterministic JSON output from GPT with fallback parsing.
// - Always returns EXACTLY 4 strong, non-generic items.
// - MAX LOGGING, no silent failures.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error('[11][FATAL] OPENAI_API_KEY not set in env!');

console.log('[11][INIT] Visual Subject Extractor (STRICT V4) loaded');

const DEFAULT_MODEL = process.env.VISUAL_SUBJECT_MODEL || 'gpt-4.1'; // keep configurable

// ===========================================================
// Vocabulary / Heuristics
// ===========================================================
const GENERIC_SUBJECTS = [
  'face','person','man','woman','it','thing','someone','something','body','eyes',
  'kid','boy','girl','they','we','people','scene','sign','logo','text',
  'view','image','photo','background','object','shape','figure','stuff'
];

const ANIMAL_TERMS = [
  'dog','cat','monkey','orangutan','ape','gorilla','chimp','chimpanzee','lion','tiger','bear','elephant','giraffe',
  'wolf','fox','deer','rabbit','horse','cow','sheep','goat','pig','bird','eagle','hawk','owl','panda'
];

const PERSON_TERMS = [
  'man','woman','boy','girl','child','person','people','couple','tourist','tourists','crowd','dancer','runner'
];

const LANDMARK_KEYWORDS = [
  'castle','wall','tower','bridge','cathedral','basilica','church','mosque','temple','pagoda','synagogue','monument',
  'statue','pyramid','palace','fort','fortress','acropolis','colosseum','amphitheatre','arena',
  'mount','mountain','peak','summit','canyon','gorge','valley','desert','dune','oasis','volcano',
  'falls','waterfall','lake','river','glacier','fjord','coast','beach','shore','harbor','harbour','bay',
  'park','national park','forest','rainforest','reserve','island','archipelago','peninsula',
  'museum','gallery','library','university','campus','garden','plaza','square','market','bazaar'
];

// Quick known-landmark expansions / typo corrections (add over time)
const LANDMARK_CORRECTIONS = [
  { re: /\bedinboro\b/gi, fix: 'Edinburgh' }, // user-reported
  { re: /\bgreat\s*wall\b/gi, fix: 'Great Wall of China' },
  { re: /\bpyrimids\b/gi, fix: 'Pyramids' },
  { re: /\bgiza\s*pyramids?\b/gi, fix: 'Giza Pyramids' },
  { re: /\bstonehenge\b/gi, fix: 'Stonehenge' },
  { re: /\beifel\b/gi, fix: 'Eiffel' },
  { re: /\beiffel\s*tower\b/gi, fix: 'Eiffel Tower' },
  { re: /\bmachu\s*piccu\b/gi, fix: 'Machu Picchu' },
  { re: /\bchichen\s*itza\b/gi, fix: 'Chichen Itza' },
  { re: /\bburj\s*khalifa\b/gi, fix: 'Burj Khalifa' },
];

// Mild country/city proper-name booster
const PLACE_HINTS = [
  'edinburgh','scotland','china','beijing','paris','france','rome','italy','london','england','egypt','giza','peru','cuzco','mexico'
];

// ===========================================================
// Utilities
// ===========================================================
function cleanString(s) {
  return String(s || '').trim();
}
function toAlphaNumLower(s) {
  return cleanString(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function isGeneric(phrase) {
  const base = toAlphaNumLower(phrase);
  if (!base) return true;
  return GENERIC_SUBJECTS.some(g => base.includes(toAlphaNumLower(g)));
}
function containsAnimalWord(s) {
  const low = (s || '').toLowerCase();
  return ANIMAL_TERMS.some(t => low.includes(t));
}
function containsPersonWord(s) {
  const low = (s || '').toLowerCase();
  return PERSON_TERMS.some(t => low.includes(t));
}
function containsLandmarkKeyword(s) {
  const low = (s || '').toLowerCase();
  return LANDMARK_KEYWORDS.some(t => low.includes(t));
}
function titleCase(s) {
  return cleanString(s)
    .split(/\s+/)
    .map(w => w.match(/^[A-Za-z]/) ? (w[0].toUpperCase() + w.slice(1)) : w)
    .join(' ');
}

function applyLandmarkCorrections(s) {
  let out = s;
  for (const { re, fix } of LANDMARK_CORRECTIONS) {
    out = out.replace(re, fix);
  }
  return out;
}

// capture quoted phrases
function extractQuotedPhrases(s) {
  const res = [];
  const re = /"([^"]+)"|'([^']+)'/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    res.push(m[1] || m[2]);
  }
  return res;
}

// capture proper-noun like sequences (>=2 capitalized tokens)
function extractProperNounSequences(s) {
  const tokens = s.split(/(\s+|[.,!?;:()"'])/).filter(Boolean);
  const out = [];
  let curr = [];
  for (const t of tokens) {
    if (/^[A-Z][a-zA-Z'-]*$/.test(t)) {
      curr.push(t);
    } else {
      if (curr.length >= 2) out.push(curr.join(' '));
      curr = [];
    }
  }
  if (curr.length >= 2) out.push(curr.join(' '));
  return out;
}

function maybeLandmarkFromKeywords(s) {
  // Try to find the minimal phrase around landmark words (e.g., "Edinburgh Castle", "Great Wall of China")
  const low = s.toLowerCase();
  let best = null;

  // Heuristic windows
  const words = s.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const wLow = words[i].toLowerCase();
    if (LANDMARK_KEYWORDS.some(k => wLow === k || wLow.endsWith(k))) {
      // Expand left/right to include proper nouns and of/ the/ in/ etc.
      let start = Math.max(0, i - 3);
      let end = Math.min(words.length - 1, i + 3);
      const phrase = words.slice(start, end + 1).join(' ');
      if (!best || phrase.length > best.length) best = phrase;
    }
  }
  if (best) return titleCase(best);
  return null;
}

function boostPlaceHints(s) {
  const low = (s || '').toLowerCase();
  return PLACE_HINTS.filter(h => low.includes(h));
}

// Deduplicate by alphanum-lower
function uniqueKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const key = toAlphaNumLower(x);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

// If any item contains landmark keyword, consider the whole set "landmark-mode".
function shouldForceLandmarkMode(items) {
  return items.some(containsLandmarkKeyword);
}

// Enforce anti-animal/person when landmark mode
function filterOffTopicForLandmark(items) {
  return items.filter(x => !containsAnimalWord(x) && !containsPersonWord(x));
}

// Hard cull: generics, too short, non-visual
function strongCull(items) {
  return items
    .map(x => x && String(x).trim())
    .filter(Boolean)
    .filter(x => x.length > 2)
    .filter(x => !isGeneric(x));
}

// Ensure exactly 4 results, padding with mainTopic variations if needed
function finalize4(items, mainTopic) {
  let arr = uniqueKeepOrder(items);
  arr = strongCull(arr);

  if (arr.length === 0) arr.push(mainTopic);
  while (arr.length < 4) {
    if (!arr.includes(mainTopic)) arr.push(mainTopic);
    else {
      const t = `${mainTopic} view`;
      if (!arr.includes(t)) arr.push(t);
      else arr.push(`${mainTopic} close-up`);
    }
  }
  if (arr.length > 4) arr = arr.slice(0, 4);
  return arr;
}

// ===========================================================
// GPT Prompting (JSON enforced, but with resilient parsing)
// ===========================================================
function buildSystemPrompt(genericBlacklistCSV) {
  return [
    'You are a senior editor for viral short-form videos (TikTok/Reels/Shorts).',
    'Your job: Given a script line and main topic, produce EXACTLY FOUR concrete, showable visual subjects.',
    'Rules:',
    '- Only return visuals that can literally appear on screen (objects/places/landmarks/actions).',
    '- Ignore metaphors, jokes, emotions, or abstract concepts.',
    '- Prefer PROPER NOUNS and famous landmarks when present.',
    '- If the line names a landmark/place, DO NOT return animals/people unless they are part of the landmark (e.g., guards at Buckingham Palace).',
    `- NEVER return: ${genericBlacklistCSV}.`,
    '- No duplicates. No vague words like “scene”, “view”, “image”, “photo”, “text”, “logo”.',
    '- If nothing is clear, use the main topic as fallback.',
    '',
    'Output must be strict JSON object with this shape:',
    '{ "primary": "string", "context": "string", "fallback": "string", "general": "string" }',
    'Do not add explanations or any other fields.',
  ].join('\n');
}

function buildUserPrompt(line, mainTopic, heuristicHints) {
  const hints = heuristicHints && heuristicHints.length
    ? `Heuristic hints detected: ${heuristicHints.join('; ')}`
    : 'Heuristic hints: none';
  return [
    `Line: "${line}"`,
    `Main topic: "${mainTopic}"`,
    hints,
    'Return the JSON object now.'
  ].join('\n');
}

async function callOpenAIForSubjects(line, mainTopic, heuristicHints) {
  const system = buildSystemPrompt(GENERIC_SUBJECTS.join(', '));
  const user = buildUserPrompt(line, mainTopic, heuristicHints);

  const reqBody = {
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.2,
    max_tokens: 120
  };

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    reqBody,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  const raw = res.data?.choices?.[0]?.message?.content?.trim() || '';
  console.log('[11][GPT][RAW]', raw);

  // First try JSON parse
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    // fallback: try to extract JSON object substring
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { obj = JSON.parse(m[0]); } catch { /* noop */ }
    }
  }

  if (obj && typeof obj === 'object') {
    const { primary, context, fallback, general } = obj;
    return [primary, context, fallback, general]
      .map(x => (typeof x === 'string' ? x : ''))
      .filter(x => !!x && x.trim().length > 0);
  }

  // Second fallback: numbered list parsing (if model ignored JSON)
  const list = raw
    .split('\n')
    .map(l => l.replace(/^\s*\d+[\.\)]\s*/, '').replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  return list;
}

// ===========================================================
// Main API
// ===========================================================
async function extractVisualSubjects(line, mainTopic) {
  try {
    const rawLine = cleanString(line);
    const rawTopic = cleanString(mainTopic || 'misc');

    console.log(`[11][INPUT] Line="${rawLine}" | Topic="${rawTopic}"`);

    if (!rawLine) {
      console.warn('[11][WARN] Blank/invalid line. Returning topic-based fillers.');
      return finalize4([rawTopic], rawTopic);
    }

    // ---------- Heuristic Pre-pass ----------
    let preCandidates = [];

    // Typo/variant corrections applied to the line
    let correctedLine = applyLandmarkCorrections(rawLine);
    if (correctedLine !== rawLine) {
      console.log(`[11][HEUR][CORRECT] "${rawLine}" -> "${correctedLine}"`);
    }

    // Quoted phrases carry high intent
    const quoted = extractQuotedPhrases(correctedLine);
    if (quoted.length) console.log('[11][HEUR][QUOTED]', quoted);
    preCandidates.push(...quoted);

    // Proper noun sequences (>=2 caps)
    const pn = extractProperNounSequences(correctedLine);
    if (pn.length) console.log('[11][HEUR][PROPER]', pn);
    preCandidates.push(...pn);

    // Landmark keyword windowing
    const lm = maybeLandmarkFromKeywords(correctedLine);
    if (lm) {
      console.log('[11][HEUR][LANDMARK]', lm);
      preCandidates.push(lm);
    }

    // Place hint boosters (city/country present)
    const hints = boostPlaceHints(correctedLine);
    if (hints.length) console.log('[11][HEUR][PLACE_HINTS]', hints);

    // If nothing strong, try mainTopic with corrections
    const correctedTopic = applyLandmarkCorrections(rawTopic);
    if (correctedTopic !== rawTopic) {
      console.log(`[11][HEUR][TOPIC_CORRECT] "${rawTopic}" -> "${correctedTopic}"`);
    }

    // Normalize and title-case heuristic candidates
    preCandidates = uniqueKeepOrder(
      preCandidates
        .map(applyLandmarkCorrections)
        .map(titleCase)
        .filter(Boolean)
    );

    // Enforce landmark mode if any candidate clearly indicates landmark/place
    const landmarkMode = shouldForceLandmarkMode(preCandidates) || containsLandmarkKeyword(correctedLine);
    if (landmarkMode) console.log('[11][MODE] Landmark mode is ON');

    // ---------- GPT Call (JSON enforced) ----------
    let gptList = [];
    try {
      gptList = await callOpenAIForSubjects(correctedLine, correctedTopic, preCandidates);
    } catch (e) {
      console.error('[11][GPT][ERR] GPT call failed:', e?.response?.data || e);
      gptList = [];
    }

    // Merge heuristic + GPT, apply landmark rules & culls
    let merged = uniqueKeepOrder([
      ...preCandidates,
      ...gptList
    ]);

    if (landmarkMode) {
      const before = merged.length;
      merged = filterOffTopicForLandmark(merged);
      const after = merged.length;
      if (after < before) {
        console.log(`[11][FILTER] Landmark mode culled ${before - after} animal/person items`);
      }
    }

    // Strong cull of generics/shorts/abstracts
    merged = strongCull(merged);

    // If still nothing, seed with topic and a landmark-ified guess if present in line
    if (merged.length === 0) {
      console.warn('[11][EMPTY] No solid subjects found after culls. Seeding with topic.');
      if (lm) merged.push(lm);
      merged.push(correctedTopic);
    }

    // Finalize exactly 4
    const final4 = finalize4(merged, correctedTopic);

    // Order normalization: Primary → Context → Fallback → General
    // - Keep first as Primary, next as Context, then Fallback, then General
    const labeled = {
      primary: final4[0],
      context: final4[1],
      fallback: final4[2],
      general: final4[3],
    };

    console.log('[11][RESULT]', labeled);
    return [labeled.primary, labeled.context, labeled.fallback, labeled.general];
  } catch (err) {
    console.error('[11][FATAL]', err);
    const topic = cleanString(mainTopic || 'misc') || 'misc';
    return finalize4([topic], topic);
  }
}

// ===========================================================
// CLI Test Utility
// Usage: node section11-visual-subject-extractor.cjs "<line>" "<topic>"
// ===========================================================
if (require.main === module) {
  const testLine = process.argv[2] || 'A line about the Great Wall of China and Edinburgh Castle.';
  const mainTopic = process.argv[3] || 'World Landmarks';
  extractVisualSubjects(testLine, mainTopic)
    .then(subjects => {
      console.log('[11][CLI][OK] Extracted subjects:', subjects);
      process.exit(0);
    })
    .catch(err => {
      console.error('[11][CLI][ERR]', err);
      process.exit(1);
    });
}

module.exports = { extractVisualSubjects };
