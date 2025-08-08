// ===========================================================
// SECTION 11: GPT VISUAL SUBJECT EXTRACTOR (STRICT V5)
// Purpose: Return the strongest visual subject for a script line,
//          with a canonical subject + optional feature/action + type,
//          plus a backward-compatible list of 4 concrete options.
//
// Major Upgrades vs V4:
// - Adds 10M canonical normalization (aliases → canonical; features/actions).
// - Returns a STRICT structured object for downstream precision:
//     { primary, featureOrAction, parent, alternates[], type }
// - Detects and prefers EXACT landmark/object/animal matches.
// - Extracts visual FEATURES/ACTIONS when present (e.g., "crown", "drinking milk").
// - Entity typing: landmark | animal | object | food | person | other.
// - Hard culls generic/abstract/off-topic; landmark-mode bans animals/people.
// - Deterministic JSON from GPT with resilient parsing & heuristic merge.
// - Backward compatibility: still exports extractVisualSubjects() → [4 strings].
// - MAX LOGGING, no placeholders.
// ===========================================================

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error('[11][FATAL] OPENAI_API_KEY not set in env!');

console.log('[11][INIT] Visual Subject Extractor (STRICT V5) loaded');

const DEFAULT_MODEL = process.env.VISUAL_SUBJECT_MODEL || 'gpt-4.1'; // configurable

// -----------------------------
// 10M Canonical Subjects
// -----------------------------
let resolveCanonicalSubject = null;
try {
  ({ resolveCanonicalSubject } = require('./section10m-canonical-subjects.cjs'));
  console.log('[11][INIT] 10M canonical subject resolver connected.');
} catch (e) {
  console.warn('[11][INIT][WARN] 10M canonical resolver not found. Using internal minimal normalizer.');
  // minimal fallback to avoid crashes
  resolveCanonicalSubject = (input) => {
    const s = (typeof input === 'string' ? input : (input?.primary || '')).toLowerCase().trim();
    const feature = (input?.featureOrAction || input?.feature || input?.action || '').toLowerCase().trim();
    const type = (input?.type || guessTypeFromText(s)).toLowerCase();
    return {
      canonical: s,
      type,
      featureOrAction: feature,
      parent: s,
      alternates: Array.isArray(input?.alternates) ? input.alternates : [],
      synonyms: [],
      languageVariants: [],
      features: [],
      actions: [],
    };
  };
}

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
  'wolf','fox','deer','rabbit','horse','cow','sheep','goat','pig','bird','eagle','hawk','owl','panda','kitten','puppy'
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

// Known-landmark expansions / typo corrections (extend over time)
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

// Country/city proper-name booster
const PLACE_HINTS = [
  'edinburgh','scotland','china','beijing','paris','france','rome','italy','london','england','egypt','giza','peru','cuzco','mexico','new york','usa','united states','united kingdom','uk'
];

// Feature/action vocab seeds (expand as needed)
const FEATURE_WORDS = [
  'crown','torch','clock face','summit','top','base','arches','interior','entrance','pedestal','tablet','face','facade'
];
const ACTION_WORDS = [
  'drinking milk','drinking','pouring milk','pouring','fainting','grazing','climbing','running','sleeping','purring',
  'eating','swinging','time-lapse','timelapse','fireworks','light show','aerial','close-up','close up'
];

// ===========================================================
// Utilities
// ===========================================================
function cleanString(s) {
  return String(s || '').trim();
}
function toAlphaNumLower(s) {
  return cleanString(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}
function isGeneric(phrase) {
  const base = toAlphaNumLower(phrase);
  if (!base) return true;
  return GENERIC_SUBJECTS.some(g => base.includes(toAlphaNumLower(g)));
}
function containsAny(list, s) {
  const L = (s || '').toLowerCase();
  return list.some(t => L.includes(String(t).toLowerCase()));
}
function containsAnimalWord(s) { return containsAny(ANIMAL_TERMS, s); }
function containsPersonWord(s) { return containsAny(PERSON_TERMS, s); }
function containsLandmarkKeyword(s) { return containsAny(LANDMARK_KEYWORDS, s); }

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

function extractQuotedPhrases(s) {
  const res = [];
  const re = /"([^"]+)"|'([^']+)'/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    res.push(m[1] || m[2]);
  }
  return res;
}

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
  const words = s.split(/\s+/);
  let best = null;
  for (let i = 0; i < words.length; i++) {
    const wLow = words[i].toLowerCase();
    if (LANDMARK_KEYWORDS.some(k => wLow === k || wLow.endsWith(k))) {
      let start = Math.max(0, i - 3);
      let end = Math.min(words.length - 1, i + 3);
      const phrase = words.slice(start, end + 1).join(' ');
      if (!best || phrase.length > best.length) best = phrase;
    }
  }
  return best ? titleCase(best) : null;
}

function boostPlaceHints(s) {
  const low = (s || '').toLowerCase();
  return PLACE_HINTS.filter(h => low.includes(h));
}

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

function shouldForceLandmarkMode(itemsOrText) {
  if (Array.isArray(itemsOrText)) return itemsOrText.some(containsLandmarkKeyword);
  return containsLandmarkKeyword(itemsOrText);
}

function strongCull(items) {
  return items
    .map(x => x && String(x).trim())
    .filter(Boolean)
    .filter(x => x.length > 2)
    .filter(x => !isGeneric(x));
}

function guessTypeFromText(s) {
  const L = (s || '').toLowerCase();
  if (containsAny(LANDMARK_KEYWORDS, L)) return 'landmark';
  if (containsAny(ANIMAL_TERMS, L)) return 'animal';
  if (/\b(milk|bread|pizza|burger|coffee|tea|drink|food)\b/.test(L)) return 'food';
  if (containsAny(PERSON_TERMS, L)) return 'person';
  return 'other';
}

function extractFeatureOrAction(text) {
  const L = (text || '').toLowerCase();
  const hits = [];
  FEATURE_WORDS.forEach(f => { if (L.includes(f)) hits.push(f); });
  ACTION_WORDS.forEach(a => { if (L.includes(a)) hits.push(a); });
  // Prefer multi-word actions (drinking milk) then feature nouns
  hits.sort((a, b) => b.split(' ').length - a.split(' ').length);
  return hits[0] || '';
}

function combineAndCullLandmarkMode(items, landmarkMode) {
  let merged = uniqueKeepOrder(items);
  merged = strongCull(merged);
  if (landmarkMode) {
    const before = merged.length;
    merged = merged.filter(x => !containsAnimalWord(x) && !containsPersonWord(x));
    const after = merged.length;
    if (after < before) {
      console.log(`[11][FILTER] Landmark mode culled ${before - after} animal/person items`);
    }
  }
  return merged;
}

function toFourStrings(primary, alternates, mainTopic) {
  const base = [];
  if (primary?.featureOrAction) base.push(`${primary.primary} ${primary.featureOrAction}`.trim());
  base.push(primary.primary);
  (alternates || []).forEach(a => base.push(a));
  const final = strongCull(uniqueKeepOrder(base));
  while (final.length < 4) {
    const filler = final.length === 0 ? mainTopic : `${primary.primary} close-up`;
    if (!final.includes(filler)) final.push(filler);
    else final.push(`${primary.primary} view`);
  }
  return final.slice(0, 4);
}

// ===========================================================
// GPT Prompting (JSON enforced, resilient parsing)
// ===========================================================
function buildSystemPrompt(genericBlacklistCSV) {
  return [
    'You are a senior editor for viral short-form videos (TikTok/Reels/Shorts).',
    'Given a script line and main topic, produce a single STRICT visual subject with optional feature/action and type.',
    'Rules:',
    '- Only return visuals that can literally appear on screen (objects/places/landmarks/animals/actions).',
    '- Ignore metaphors, jokes, emotions, or abstract concepts.',
    '- Prefer PROPER NOUNS and famous landmarks/objects/animals when present.',
    '- If the line names a landmark/place, DO NOT return animals/people unless they are part of the landmark (e.g., guards at Buckingham Palace).',
    `- NEVER use: ${genericBlacklistCSV}.`,
    '- No duplicates. No vague words like “scene”, “view”, “image”, “photo”, “text”, “logo”.',
    '',
    'Output MUST be strict JSON with this shape:',
    '{ "primary": "string", "featureOrAction": "string", "type": "landmark|animal|object|food|person|other", "alternates": ["string", "string"] }',
    'No explanations. No extra fields.',
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

async function callOpenAIForStrict(line, mainTopic, heuristicHints) {
  const system = buildSystemPrompt(GENERIC_SUBJECTS.join(', '));
  const user = buildUserPrompt(line, mainTopic, heuristicHints);

  const reqBody = {
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.1,
    max_tokens: 180
  };

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    reqBody,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 22000,
    }
  );

  const raw = res.data?.choices?.[0]?.message?.content?.trim() || '';
  console.log('[11][GPT][RAW]', raw);

  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { obj = JSON.parse(m[0]); } catch { /* noop */ }
    }
  }

  if (obj && typeof obj === 'object') {
    // sanitize
    let primary = cleanString(obj.primary || '');
    let featureOrAction = cleanString(obj.featureOrAction || obj.feature || obj.action || '');
    let type = cleanString(obj.type || '');
    let alternates = Array.isArray(obj.alternates) ? obj.alternates.map(cleanString).filter(Boolean) : [];

    return { primary, featureOrAction, type, alternates };
  }

  return null;
}

// ===========================================================
// Public API (STRICT object) + Back-compat array of 4 strings
// ===========================================================
async function extractVisualSubjectStrict(line, mainTopic) {
  try {
    const rawLine = cleanString(line);
    const rawTopic = cleanString(mainTopic || 'misc');
    console.log(`[11][INPUT] Line="${rawLine}" | Topic="${rawTopic}"`);

    if (!rawLine) {
      console.warn('[11][WARN] Blank/invalid line. Returning topic-based filler.');
      const fallbackObj = resolveCanonicalSubject({ primary: rawTopic, type: guessTypeFromText(rawTopic) });
      const normalized = {
        primary: titleCase(fallbackObj.canonical || rawTopic),
        featureOrAction: '',
        parent: titleCase(fallbackObj.canonical || rawTopic),
        alternates: [],
        type: fallbackObj.type || 'other',
      };
      console.log('[11][RESULT][STRICT][FALLBACK]', normalized);
      return normalized;
    }

    // ---------- Heuristic Pre-pass ----------
    let preCandidates = [];

    let correctedLine = applyLandmarkCorrections(rawLine);
    if (correctedLine !== rawLine) {
      console.log(`[11][HEUR][CORRECT] "${rawLine}" -> "${correctedLine}"`);
    }

    const quoted = extractQuotedPhrases(correctedLine);
    if (quoted.length) console.log('[11][HEUR][QUOTED]', quoted);
    preCandidates.push(...quoted);

    const pn = extractProperNounSequences(correctedLine);
    if (pn.length) console.log('[11][HEUR][PROPER]', pn);
    preCandidates.push(...pn);

    const lm = maybeLandmarkFromKeywords(correctedLine);
    if (lm) {
      console.log('[11][HEUR][LANDMARK]', lm);
      preCandidates.push(lm);
    }

    const hints = boostPlaceHints(correctedLine);
    if (hints.length) console.log('[11][HEUR][PLACE_HINTS]', hints);

    const landmarkMode = shouldForceLandmarkMode(preCandidates) || shouldForceLandmarkMode(correctedLine);
    if (landmarkMode) console.log('[11][MODE] Landmark mode is ON');

    // ---------- GPT STRICT ----------
    let gptStrict = null;
    try {
      gptStrict = await callOpenAIForStrict(correctedLine, rawTopic, preCandidates);
    } catch (e) {
      console.error('[11][GPT][ERR] GPT call failed:', e?.response?.data || e);
      gptStrict = null;
    }

    // ---------- Heuristic subject & feature/action ----------
    // If GPT missed feature/action, try to pull from line.
    const heuristicFeature = extractFeatureOrAction(correctedLine);

    // Decide a primary candidate string
    const mergedPre = uniqueKeepOrder(preCandidates);
    let primaryGuess = gptStrict?.primary || mergedPre[0] || correctedLine;
    primaryGuess = titleCase(applyLandmarkCorrections(primaryGuess));

    // Cull generic primary (rare but guard it)
    if (isGeneric(primaryGuess)) {
      // try next best from merged pre-candidates or topic
      const alt = mergedPre.find(x => !isGeneric(x)) || rawTopic;
      console.log(`[11][HEUR][PRIMARY_REPLACE] "${primaryGuess}" -> "${alt}"`);
      primaryGuess = titleCase(alt);
    }

    // Merge feature/action
    let featureOrAction = cleanString(gptStrict?.featureOrAction || heuristicFeature || '');
    // Light normalization for close up variant
    if (featureOrAction.toLowerCase() === 'close up') featureOrAction = 'close-up';

    // Type: trust GPT if valid; else guess
    const validTypes = new Set(['landmark','animal','object','food','person','other']);
    let type = (gptStrict?.type && validTypes.has(gptStrict.type.toLowerCase()))
      ? gptStrict.type.toLowerCase()
      : guessTypeFromText(primaryGuess);

    // Alternates: GPT alternates + heuristics (proper nouns / quoted)
    let alternates = Array.isArray(gptStrict?.alternates) ? gptStrict.alternates : [];
    alternates = uniqueKeepOrder([...alternates, ...mergedPre.slice(1)]).filter(x => !isGeneric(x));

    // Landmark-mode cull alternates containing animals/people
    if (type === 'landmark' || landmarkMode) {
      const before = alternates.length;
      alternates = alternates.filter(x => !containsAnimalWord(x) && !containsPersonWord(x));
      if (before !== alternates.length) {
        console.log(`[11][ALT][CULL] Removed ${before - alternates.length} off-topic alternates in landmark mode`);
      }
    }

    // ---------- Canonical normalization via 10M ----------
    const normalized10M = resolveCanonicalSubject({
      primary: primaryGuess,
      featureOrAction,
      parent: primaryGuess, // parent collapses to canonical in 10M
      alternates,
      type,
    });

    // Final strict object
    const strictObj = {
      primary: titleCase(normalized10M.canonical || primaryGuess),
      featureOrAction: normalized10M.featureOrAction || '',
      parent: titleCase(normalized10M.canonical || primaryGuess),
      alternates: (normalized10M.alternates || []).map(titleCase).slice(0, 6),
      type: normalized10M.type || type || 'other',
    };

    console.log('[11][RESULT][STRICT]', strictObj);
    return strictObj;
  } catch (err) {
    console.error('[11][FATAL]', err);
    const topic = cleanString(mainTopic || 'misc') || 'misc';
    const fallbackObj = {
      primary: titleCase(topic),
      featureOrAction: '',
      parent: titleCase(topic),
      alternates: [],
      type: guessTypeFromText(topic),
    };
    console.log('[11][RESULT][STRICT][FALLBACK2]', fallbackObj);
    return fallbackObj;
  }
}

/**
 * Backward-compatible helper used by 5D (returns 4 strings).
 * Internally uses STRICT to get primary/feature/alternates and expands to 4.
 */
async function extractVisualSubjects(line, mainTopic) {
  const strict = await extractVisualSubjectStrict(line, mainTopic);
  const arr4 = toFourStrings(strict, strict.alternates, cleanString(mainTopic || 'misc'));
  console.log('[11][RESULT][ARRAY4]', arr4);
  return arr4;
}

// ===========================================================
// CLI Test Utility
// Usage: node section11-visual-subject-extractor.cjs "<line>" "<topic>"
// ===========================================================
if (require.main === module) {
  const testLine = process.argv[2] || 'Inside the Statue of Liberty’s crown, visitors peer through the windows.';
  const mainTopic = process.argv[3] || 'World Landmarks';
  (async () => {
    const strict = await extractVisualSubjectStrict(testLine, mainTopic);
    console.log('[11][CLI][STRICT]', strict);
    const arr = await extractVisualSubjects(testLine, mainTopic);
    console.log('[11][CLI][ARRAY4]', arr);
  })().catch(err => {
    console.error('[11][CLI][ERR]', err);
    process.exit(1);
  });
}

module.exports = { extractVisualSubjects, extractVisualSubjectStrict, LANDMARK_KEYWORDS, ANIMAL_TERMS, PERSON_TERMS };
