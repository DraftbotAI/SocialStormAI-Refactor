// ============================================================
// SECTION 10M: CANONICAL SUBJECTS (Entity Resolver & Query Builder)
// Purpose:
//   - Normalize line subjects to a canonical entity with type
//   - Map aliases/synonyms/language variants -> canonical
//   - Provide features/actions for "feature-first" matching
//   - Build staged query terms for 5D orchestrator:
//       Stage A: canonical + feature/action (most specific)
//       Stage B: canonical only (landmark/object/animal)
//       Stage C: synonyms/alternates/language variants
//   - Max logging, deterministic output, zero placeholders
//
// Exports:
//   - resolveCanonicalSubject(input)
//   - getQueryStagesForSubject(input)
//   - getEntityMetadata(canonicalOrAlias)
//   - isSameCanonical(a, b)
//   - addCustomEntities(entitiesArray)
//
// Input "subject" accepted forms:
//   - string: "Statue of Liberty crown"
//   - object (from Section 11 STRICT):
//       {
//         primary: "Statue of Liberty",
//         featureOrAction: "crown interior",
//         parent: "Statue of Liberty",
//         alternates: ["Statue of Liberty crown", "Statue of Liberty close-up"],
//         type: "landmark" // optional, we can infer
//       }
//
// Types supported: 'landmark', 'animal', 'object', 'food', 'person', 'symbol', 'other'
//
// Logging tags: [10M][INFO] / [10M][WARN] / [10M][ERR]
// ============================================================

'use strict';

/* =========================
 * Internal Utilities
 * ========================= */

const SLUG_RE = /[^a-z0-9]+/g;

// Strip diacritics (é → e) and lowercase deterministically
function _normLower(s) {
  return (s || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // remove combining marks
    .toLowerCase();
}

function lcase(s) { return _normLower(s).trim(); }
function slugify(s) {
  return _normLower(s).replace(SLUG_RE, ' ').replace(/\s+/g, ' ').trim();
}
function uniq(arr) { return Array.from(new Set((arr || []).filter(Boolean).map(x => x.trim()))); }
function notEmpty(x) { return !!(x && x.trim && x.trim().length); }
function asArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }

function logInfo(...args) { console.log('[10M][INFO]', ...args); }
function logWarn(...args) { console.warn('[10M][WARN]', ...args); }
function logErr (...args) { console.error('[10M][ERR] ', ...args); }

/* =========================
 * Seed Ontology (starter set)
 * - Extend freely. 10M supports runtime additions.
 * - Each entity has:
 *   canonical, type, parents[], synonyms[], languageVariants[], features[], actions[]
 * ========================= */

const SEED_ENTITIES = [
  // ----- Landmarks -----
  {
    canonical: 'eiffel tower',
    type: 'landmark',
    parents: ['paris', 'france', 'landmark'],
    synonyms: ['tour eiffel', 'la tour eiffel', 'eiffel', 'paris tower'],
    languageVariants: ['tour eiffel'],
    features: ['top', 'summit', 'arches', 'base', 'night lights', 'iron lattice'],
    actions: ['time-lapse', 'fireworks', 'light show'],
  },
  {
    canonical: 'statue of liberty',
    type: 'landmark',
    parents: ['new york', 'usa', 'landmark'],
    synonyms: ['lady liberty', 'liberty island', 'statue liberty'],
    languageVariants: ['statue de la liberté'],
    features: ['crown', 'torch', 'pedestal', 'face', 'tablet'],
    actions: ['aerial', 'ferry passing', 'close-up'],
  },
  {
    canonical: 'elizabeth tower',
    type: 'landmark',
    parents: ['london', 'uk', 'landmark'],
    synonyms: ['big ben', 'clock tower', 'palace of westminster clock', 'westminster clock'],
    languageVariants: [],
    features: ['clock face', 'tower top', 'belfry'],
    actions: ['clock hands moving', 'night lights'],
  },
  {
    canonical: 'trevi fountain',
    type: 'landmark',
    parents: ['rome', 'italy', 'landmark'],
    synonyms: ['fontana di trevi', 'trevi'],
    languageVariants: ['fontana di trevi'],
    features: ['central statue', 'basin', 'facade'],
    actions: ['coin toss', 'water flow'],
  },

  // ----- Animals -----
  {
    canonical: 'goat',
    type: 'animal',
    parents: ['animal', 'livestock'],
    synonyms: ['goats', 'fainting goat', 'fainting goats', 'kid (goat)', 'billy goat', 'nanny goat'],
    languageVariants: [],
    features: ['horns', 'beard', 'pupils'],
    actions: ['drinking milk', 'fainting', 'grazing', 'climbing'],
  },
  {
    canonical: 'orangutan',
    type: 'animal',
    parents: ['animal', 'primate'],
    synonyms: ['orang-utan', 'orangutang', 'great ape'],
    languageVariants: [],
    features: ['long arms', 'orange fur'],
    actions: ['climbing', 'eating fruit', 'swinging'],
  },
  {
    canonical: 'dog',
    type: 'animal',
    parents: ['animal', 'pet'],
    synonyms: ['dogs', 'puppy', 'puppies', 'canine'],
    languageVariants: [],
    features: ['ears', 'tail'],
    actions: ['running', 'playing', 'drinking water'],
  },
  {
    canonical: 'cat',
    type: 'animal',
    parents: ['animal', 'pet'],
    synonyms: ['cats', 'kitten', 'kittens', 'feline'],
    languageVariants: [],
    features: ['whiskers', 'eyes'],
    actions: ['sleeping', 'purring', 'drinking milk'],
  },

  // ----- Objects / Symbols -----
  {
    canonical: 'crown',
    type: 'object',
    parents: ['object', 'symbol'],
    synonyms: ['royal crown', 'tiara (loose)', 'king crown', 'queen crown'],
    languageVariants: [],
    features: ['jewels', 'gold', 'spikes'],
    actions: ['close-up', 'held', 'worn'],
  },
  {
    canonical: 'torch',
    type: 'object',
    parents: ['object', 'light'],
    synonyms: ['flaming torch', 'handheld torch'],
    languageVariants: [],
    features: ['flame', 'handle'],
    actions: ['burning'],
  },

  // ----- Food -----
  {
    canonical: 'milk',
    type: 'food',
    parents: ['food', 'drink'],
    synonyms: ['cow milk', 'goat milk'],
    languageVariants: [],
    features: ['glass of milk'],
    actions: ['pouring', 'drinking'],
  },
];

/* =========================
 * Runtime Ontology & Indexes
 * ========================= */

let ONTOLOGY = {};
let ALIAS_TO_CANON = new Map();

function indexEntity(e) {
  const c = slugify(e.canonical);
  if (!c) return;

  // normalize arrays
  e.parents = uniq(asArray(e.parents).map(slugify));
  e.synonyms = uniq(asArray(e.synonyms).map(slugify));
  e.languageVariants = uniq(asArray(e.languageVariants).map(slugify));
  e.features = uniq(asArray(e.features).map(slugify));
  e.actions = uniq(asArray(e.actions).map(slugify));

  // store
  ONTOLOGY[c] = {
    canonical: c,
    type: e.type || 'other',
    parents: e.parents,
    synonyms: e.synonyms,
    languageVariants: e.languageVariants,
    features: e.features,
    actions: e.actions,
  };

  // alias index
  ALIAS_TO_CANON.set(c, c);
  e.synonyms.forEach(s => ALIAS_TO_CANON.set(s, c));
  e.languageVariants.forEach(s => ALIAS_TO_CANON.set(s, c));
}

function rebuildIndexes() {
  ONTOLOGY = {};
  ALIAS_TO_CANON = new Map();
  SEED_ENTITIES.forEach(indexEntity);
  logInfo('Seed ontology indexed:', Object.keys(ONTOLOGY).length, 'entities');
}
rebuildIndexes();

/* =========================
 * Lightweight Type Guessing
 * (if entity is unknown)
 * ========================= */

const ANIMAL_HINTS = new Set([
  'goat','goats','dog','dogs','puppy','puppies','cat','cats','kitten','kittens',
  'lion','lions','tiger','tigers','bear','bears','eagle','eagles','monkey','monkeys',
  'chimp','chimpanzee','orangutan','gorilla','primate','cow','cows','horse','horses'
]);

const LANDMARK_HINTS = new Set([
  'tower','statue','fountain','bridge','castle','cathedral','temple','mosque',
  'pyramid','palace','clock','monument','mount','mountain'
]);

function guessTypeFromTokens(tokens) {
  try {
    const t = (tokens || []).map(slugify);
    if (t.some(x => ANIMAL_HINTS.has(x))) return 'animal';
    if (t.some(x => LANDMARK_HINTS.has(x))) return 'landmark';
    return 'other';
  } catch {
    return 'other';
  }
}

/* =========================
 * Core: Canonical Resolution
 * ========================= */

/**
 * Normalize a raw subject (string or section-11 object) into a canonical entity description.
 * Returns:
 * {
 *   canonical: 'statue of liberty',
 *   type: 'landmark',
 *   featureOrAction: 'crown',
 *   parent: 'statue of liberty',
 *   alternates: ['statue of liberty crown', ...],
 *   synonyms: [...],
 *   languageVariants: [...],
 *   features: [...],
 *   actions: [...]
 * }
 */
function resolveCanonicalSubject(input) {
  try {
    const interpreted = interpretInput(input);
    const primary = slugify(interpreted.primary);
    const featureOrAction = slugify(interpreted.featureOrAction || '');
    const parent = slugify(interpreted.parent || primary);
    let type = interpreted.type ? lcase(interpreted.type) : null;

    // Step 1: resolve canonical by alias → canonical
    const canonical = resolveToCanonical(primary) || resolveToCanonical(parent) || primary;

    // Step 2: fetch ontology entry or synthesize unknown
    const meta = ONTOLOGY[canonical] || synthesizeUnknownEntity(canonical, type);

    // Step 3: type inference if needed
    if (!type || type === 'other') {
      type = meta.type || guessTypeFromTokens(primary.split(' '));
    }

    // Step 4: alternates expansion (from input + synonyms + language variants)
    const alternates = uniq([
      ...(interpreted.alternates || []).map(slugify),
      ...meta.synonyms,
      ...meta.languageVariants,
    ]).filter(a => a && a !== canonical);

    // Step 5: Final pack
    const resolved = {
      canonical,
      type,
      featureOrAction,
      parent: canonical, // parent collapses to canonical after normalization
      alternates,
      synonyms: meta.synonyms,
      languageVariants: meta.languageVariants,
      features: meta.features,
      actions: meta.actions,
    };

    logInfo('[RESOLVE]', { inputSummary: summarizeInput(input), resolved });
    return resolved;
  } catch (err) {
    logErr('resolveCanonicalSubject failed:', err?.message || err);
    // return minimal safe structure to avoid crashes downstream
    const fallbackCanonical = slugify(typeof input === 'string' ? input : input?.primary || 'subject');
    return {
      canonical: fallbackCanonical,
      type: 'other',
      featureOrAction: '',
      parent: fallbackCanonical || '',
      alternates: [],
      synonyms: [],
      languageVariants: [],
      features: [],
      actions: [],
    };
  }
}

function interpretInput(input) {
  if (typeof input === 'string') {
    // For raw strings, treat entire string as primary; 11 handles parsing.
    const s = slugify(input);
    return { primary: s, featureOrAction: '', parent: s, alternates: [], type: null };
  }
  if (input && typeof input === 'object') {
    return {
      primary: input.primary || input.subject || '',
      featureOrAction: input.featureOrAction || input.feature || input.action || '',
      parent: input.parent || input.primary || '',
      alternates: asArray(input.alternates).filter(notEmpty),
      type: input.type || null,
    };
  }
  return { primary: '', featureOrAction: '', parent: '', alternates: [], type: null };
}

function resolveToCanonical(name) {
  if (!name) return null;
  const key = slugify(name);
  return ALIAS_TO_CANON.get(key) || null;
}

function synthesizeUnknownEntity(canonical, maybeType) {
  try {
    const tokens = (canonical || '').split(' ').filter(Boolean);
    const inferredType = maybeType || guessTypeFromTokens(tokens);
    if (!ONTOLOGY[canonical]) {
      ONTOLOGY[canonical] = {
        canonical,
        type: inferredType,
        parents: [],
        synonyms: [],
        languageVariants: [],
        features: [],
        actions: [],
      };
      ALIAS_TO_CANON.set(canonical, canonical);
    }
    return ONTOLOGY[canonical];
  } catch (e) {
    logWarn('synthesizeUnknownEntity error; returning minimal entity.', e?.message || e);
    return {
      canonical,
      type: 'other',
      parents: [],
      synonyms: [],
      languageVariants: [],
      features: [],
      actions: [],
    };
  }
}

function summarizeInput(input) {
  if (typeof input === 'string') return input.slice(0, 120);
  try {
    return JSON.stringify({
      primary: input?.primary,
      featureOrAction: input?.featureOrAction,
      type: input?.type,
    });
  } catch {
    return '[object]';
  }
}

/* =========================
 * Query Builder (Stages)
 * ========================= */

/**
 * Build staged search queries for 5D.
 * Stage A: canonical + featureOrAction (many phrasings)
 * Stage B: canonical only (plus parent if different)
 * Stage C: alternates/synonyms/languageVariants
 *
 * Returns:
 * [
 *   { stage: 'A', terms: ['statue of liberty crown','crown of statue of liberty',...] },
 *   { stage: 'B', terms: ['statue of liberty'] },
 *   { stage: 'C', terms: ['lady liberty','statue de la liberte', ...] }
 * ]
 */
function getQueryStagesForSubject(input) {
  try {
    const e = resolveCanonicalSubject(input);

    const stageA = buildFeatureFirstTerms(e);
    const stageB = buildCanonicalOnlyTerms(e);
    const stageC = buildSynonymAlternateTerms(e);

    // Ensure arrays exist (even if empty) and are de-duped
    const result = [
      { stage: 'A', terms: uniq(stageA).filter(notEmpty) },
      { stage: 'B', terms: uniq(stageB).filter(notEmpty) },
      { stage: 'C', terms: uniq(stageC).filter(notEmpty) },
    ];

    logInfo('[QUERIES]', { canonical: e.canonical, type: e.type, stages: result });
    return result;
  } catch (err) {
    logErr('getQueryStagesForSubject failed:', err?.message || err);
    // Minimal safe output
    const c = slugify(typeof input === 'string' ? input : input?.primary || 'subject');
    return [
      { stage: 'A', terms: [] },
      { stage: 'B', terms: [c] },
      { stage: 'C', terms: [] },
    ];
  }
}

function buildFeatureFirstTerms(e) {
  const terms = [];
  const c = e.canonical;

  if (e.featureOrAction) {
    const fa = e.featureOrAction;

    // Core pairings
    terms.push(`${c} ${fa}`);
    terms.push(`${fa} ${c}`);

    // Variations with safe action normalization
    const norm = normalizeActionPhrase(fa, c);
    if (norm && norm !== fa) terms.push(norm);
    terms.push(`${c} ${norm}`);

    // If type=animal, prefer animal-first lead with angle
    if (e.type === 'animal') {
      terms.push(`${c} ${fa} close-up`);
      terms.push(`${c} ${fa} in field`);
    }
  }
  return terms.filter(notEmpty);
}

function buildCanonicalOnlyTerms(e) {
  const terms = [e.canonical];

  // If parent differs (rare in our normalized model), include
  if (e.parent && e.parent !== e.canonical) {
    terms.push(e.parent);
  }

  // For landmarks, add common viewing variants
  if (e.type === 'landmark') {
    terms.push(`${e.canonical} aerial`);
    terms.push(`${e.canonical} close-up`);
    terms.push(`${e.canonical} night`);
  }

  // For animals, common safe variants
  if (e.type === 'animal') {
    terms.push(`${e.canonical} close-up`);
    terms.push(`${e.canonical} in field`);
  }

  return terms.filter(notEmpty);
}

function buildSynonymAlternateTerms(e) {
  const terms = [];
  const all = uniq([...(e.alternates || []), ...(e.synonyms || []), ...(e.languageVariants || [])]);
  all.forEach(a => {
    terms.push(a);
    if (e.featureOrAction) {
      terms.push(`${a} ${e.featureOrAction}`);
      terms.push(`${e.featureOrAction} ${a}`);
    }
  });
  return terms.filter(notEmpty);
}

function normalizeActionPhrase(fa, canonical) {
  const s = slugify(fa);
  if (!s) return '';

  // Expand some common verb phrases without overcomplicating
  // Always keep canonical present for ambiguous actions
  if (/(drinking|pouring|grazing|climbing|running|sleeping|purring|swinging|time[- ]?lapse|fireworks|light show|aerial|close ?up|close-up|night|celebrating|coin toss|water flow)/.test(s)) {
    return `${canonical} ${s}`;
  }
  return s;
}

/* =========================
 * Helpers for 10G / 5D
 * ========================= */

/**
 * Get full metadata for a canonical or alias string.
 */
function getEntityMetadata(nameOrAlias) {
  const key = slugify(nameOrAlias);
  const c = resolveToCanonical(key) || key;
  return ONTOLOGY[c] || null;
}

/**
 * Are two names the same canonical (after alias resolution)?
 */
function isSameCanonical(a, b) {
  if (!a || !b) return false;
  const ca = resolveToCanonical(slugify(a)) || slugify(a);
  const cb = resolveToCanonical(slugify(b)) || slugify(b);
  return ca === cb;
}

/**
 * Runtime augmentation of the ontology (e.g., app-level seeds from JSON)
 * Example entity object shape = same as SEED_ENTITIES entries.
 */
function addCustomEntities(entitiesArray = []) {
  try {
    const before = Object.keys(ONTOLOGY).length;
    asArray(entitiesArray).forEach(indexEntity);
    const after = Object.keys(ONTOLOGY).length;
    logInfo(`[ADD] Added ${Math.max(0, after - before)} entities (total=${after})`);
  } catch (err) {
    logErr('addCustomEntities failed:', err?.message || err);
  }
}

/* =========================
 * Module Exports
 * ========================= */

module.exports = {
  resolveCanonicalSubject,
  getQueryStagesForSubject,
  getEntityMetadata,
  isSameCanonical,
  addCustomEntities,
};
