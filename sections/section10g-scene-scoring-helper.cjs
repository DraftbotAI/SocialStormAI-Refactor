// ===========================================================
// SECTION 10G: SCENE SCORING HELPER (Entity-Aware Candidate Matcher)
// Scores candidate videos/images for best subject match, across sources.
//
// Upgrades in this build:
//   - 10M Canonical integration (canonical, alternates, synonyms, language variants)
//   - Feature/Action bonuses (inline & loose)
//   - Entity-type penalties/bonuses (landmark/animal/object/food/person) w/ landmark strictness
//   - Strong exact-boundary matching over filename/title/desc/tags/url
//   - Geography nudge (if 10M returns { city/country/region } and candidate text matches)
//   - Provider trust weighting (R2 > Pexels > Pixabay > Unsplash)
//   - Anti-dup & angle-repeat hard blocks (per job)
//   - Jaccard token overlap fallback
//   - Practical quality filters: watermark/compilation/“edit” penalties
//   - Light portrait bias for Shorts/Reels (when dims known)
//   - Extra landmark lexicon (Parliament, Alamo, Mermaid, Opera House, etc.)
//   - Max logging; zero placeholders.
//
// Used by Section 5D and all video/image helpers.
// ===========================================================

const path = require('path');

// -----------------------------
// 10M Canonical Subjects (soft require but expected present)
// -----------------------------
let resolveCanonicalSubject = null;
let getEntityMetadata = null;
try {
  ({ resolveCanonicalSubject, getEntityMetadata } = require('./section10m-canonical-subjects.cjs'));
  console.log('[10G][INIT] 10M Canonicals connected.');
} catch (e) {
  console.warn('[10G][INIT][WARN] 10M Canonicals not found. Falling back to legacy synonym-only scoring.');
  // Minimal fallbacks so we never crash
  resolveCanonicalSubject = (s) => ({
    canonical: (typeof s === 'string' ? s : (s?.primary || 'subject')).toLowerCase().trim(),
    type: (s?.type || 'other'),
    featureOrAction: (s?.featureOrAction || s?.feature || s?.action || '').toLowerCase().trim(),
    parent: (s?.parent || '').toLowerCase().trim(),
    alternates: (Array.isArray(s?.alternates) ? s.alternates : []).map(x => String(x || '').toLowerCase().trim()),
    synonyms: [],
    languageVariants: [],
    features: [],
    actions: [],
  });
  getEntityMetadata = () => null;
}

// -----------------------------
// Constants & Lexicons
// -----------------------------
const GENERIC_SUBJECTS = [
  'face','person','man','woman','it','thing','someone','something','body','eyes',
  'kid','boy','girl','they','we','people','scene','child','children','sign','logo','text','crowd','background',
  'view','image','photo','object','stuff','figure'
];

const LANDMARK_KEYWORDS = [
  'castle','wall','tower','bridge','cathedral','basilica','church','mosque','temple','pagoda','synagogue','monument',
  'statue','pyramid','palace','fort','fortress','acropolis','colosseum','amphitheatre','arena',
  'mount','mountain','peak','summit','canyon','gorge','valley','desert','dune','oasis','volcano',
  'falls','waterfall','lake','river','glacier','fjord','coast','beach','shore','harbor','harbour','bay',
  'park','national park','forest','rainforest','reserve','island','archipelago','peninsula',
  'museum','gallery','library','university','campus','garden','plaza','square','market','bazaar',
  // + extras for common scripts we see
  'parliament','alamo','mermaid','opera house','parthenon','buckingham','palace of',
];

const ANIMAL_TERMS = [
  'dog','dogs','puppy','puppies','canine','cat','cats','kitten','kittens','feline',
  'monkey','monkeys','orangutan','orangutans','primate','primates','ape','apes','gorilla','gorillas','chimp','chimps','chimpanzee','chimpanzees',
  'lion','lions','tiger','tigers','bear','bears','elephant','elephants','giraffe','giraffes','panda','pandas','wolf','wolves','fox','foxes',
  'deer','rabbits','rabbit','horse','horses','cow','cows','sheep','goat','goats','pig','pigs','bird','birds','eagle','eagles','hawk','hawks','owl','owls'
];

const PERSON_TERMS = [
  'man','men','woman','women','boy','boys','girl','girls','child','children','person','people','tourist','tourists','crowd','couple'
];

// Provider trust weighting — prefer curated/local over generic web APIs
const PROVIDER_WEIGHTS = {
  r2: 18,
  pexels: 10,
  pixabay: 8,
  unsplash: 6,
  unknown: 0,
};

// Legacy synonyms (kept; 10M adds more via canonical enrichment)
const SYNONYMS = {
  gorilla: ['gorillas','primate','ape','apes','chimpanzee','monkey'],
  chimpanzee: ['chimp','chimps','ape','apes','primate','monkey'],
  lion: ['lions','big cat','wildcat'],
  dog: ['dogs','puppy','puppies','canine'],
  cat: ['cats','kitten','kittens','feline'],

  'great wall of china': ['great wall','china wall','the great wall'],
  'edinburgh castle': ['edinburgh fortress','edinburgh castle scotland','castle rock edinburgh'],
  'giza pyramids': ['pyramids of giza','giza pyramid','great pyramids','egypt pyramids'],
  'eiffel tower': ['tour eiffel','paris tower'],
  stonehenge: ['stone henge'],
  'machu picchu': ['machupicchu'],
  'parliament building': ['parliament','hungarian parliament','parlament budapest'],
  'the alamo': ['alamo mission','alamo fort'],
  'little mermaid': ['the little mermaid','copenhagen mermaid'],
};

// Portrait bias (light) if width/height known (Shorts/Reels/TikTok)
const PORTRAIT_BONUS = 6; // gentle nudge, not dominant

// Feature/Action bonus ranges
const FEATURE_BONUS_INLINE = 12;   // feature present alongside canonical
const FEATURE_BONUS_LOOSE  = 7;    // feature present without canonical boundary

// Type penalty magnitudes
const PENALTY_OFFTOPIC_PERSON = 28;   // animal/landmark subject but humans in candidate (non-ceremonial)
const PENALTY_OFFTOPIC_ANIMAL = 26;   // landmark/object subject but animals in candidate

// Practical quality penalties
const PENALTY_WATERMARK = 30;        // "watermark", "logo", "tiktok", "youtube", "subscribe", etc.
const PENALTY_COMPILATION = 18;      // "compilation", "edit", "montage", "meme edit", etc.

// -----------------------------
// Utility Helpers
// -----------------------------
const STOPWORDS = new Set(['the','of','and','in','on','with','to','is','for','at','by','as','a','an','from','that','this','these','those']);

function norm(s) {
  return String(s || '').trim();
}
function lower(s) {
  return norm(s).toLowerCase();
}
function alnumLower(s) {
  return lower(s).replace(/[^a-z0-9]+/g, '');
}
function majorWords(str) {
  return lower(str)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 2 && !STOPWORDS.has(w));
}
function dedupeKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = alnumLower(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function isGenericString(s = '') {
  const L = lower(s);
  if (GENERIC_SUBJECTS.some(g => L.includes(g))) return true;
  if (/\b(sign|logo|text|background)\b/.test(L)) return true;
  return false;
}
function isGenericCandidate(candidate = {}) {
  const text = [
    candidate.filename,
    candidate.title,
    candidate.description,
    candidate.url,
    candidate.filePath,
  ].filter(Boolean).join(' ').toLowerCase();
  return isGenericString(text);
}

function containsAny(termList, s) {
  const L = lower(s);
  return termList.some(t => L.includes(lower(t)));
}

function hasAnimalText(candidate) {
  const text = [
    candidate.filename,
    candidate.title,
    candidate.description,
    candidate.tags ? candidate.tags.join(' ') : '',
    candidate.url
  ].filter(Boolean).join(' ');
  return containsAny(ANIMAL_TERMS, text);
}
function hasPersonText(candidate) {
  const text = [
    candidate.filename,
    candidate.title,
    candidate.description,
    candidate.tags ? candidate.tags.join(' ') : '',
    candidate.url
  ].filter(Boolean).join(' ');
  return containsAny(PERSON_TERMS, text);
}

function subjectToStringsLegacy(subject) {
  if (!subject) return [];
  if (typeof subject === 'string') return [subject];
  if (Array.isArray(subject)) return subject.flatMap(subjectToStringsLegacy);
  const out = [];
  if (subject.main) out.push(subject.main);
  if (subject.secondary) out.push(subject.secondary);
  if (Array.isArray(subject.synonyms)) out.push(...subject.synonyms);
  if (Array.isArray(subject.tokens)) out.push(...subject.tokens);
  return out.filter(Boolean).map(String);
}

function subjectToTokensLegacy(subject) {
  if (!subject) return [];
  if (typeof subject === 'string') return majorWords(subject);
  if (Array.isArray(subject)) return subject.flatMap(subjectToTokensLegacy);
  let tokens = [];
  if (subject.main) tokens.push(...majorWords(subject.main));
  if (subject.secondary) tokens.push(...majorWords(subject.secondary));
  if (Array.isArray(subject.synonyms)) tokens.push(...subject.synonyms.flatMap(majorWords));
  if (Array.isArray(subject.tokens)) tokens.push(...subject.tokens.flatMap(majorWords));
  return tokens.filter(Boolean);
}

function expandSynonymsLegacy(strings) {
  const out = [];
  for (const s of strings) {
    out.push(s);
    const key = lower(s);
    const syns = SYNONYMS[key];
    if (Array.isArray(syns)) out.push(...syns);
  }
  return dedupeKeepOrder(out);
}

function aliasPhrases(strings) {
  const out = new Set();
  for (const s of strings) {
    const L = lower(s);
    out.add(s);
    const mw = majorWords(L).join(' ');
    if (mw && mw !== L) out.add(mw);
    out.add(L.replace(/[-_]+/g, ' '));
  }
  return Array.from(out);
}

function isLandmarkSubjectLegacy(subject) {
  const strings = subjectToStringsLegacy(subject);
  const tokens = subjectToTokensLegacy(subject);
  if (strings.some(s => containsAny(LANDMARK_KEYWORDS, s))) return true;
  if (tokens.some(t => LANDMARK_KEYWORDS.includes(t))) return true;
  return false;
}

function providerWeight(provider) {
  const key = provider ? lower(provider) : 'unknown';
  if (key.includes('pexels')) return PROVIDER_WEIGHTS.pexels;
  if (key.includes('pixabay')) return PROVIDER_WEIGHTS.pixabay;
  if (key.includes('unsplash')) return PROVIDER_WEIGHTS.unsplash;
  if (key.includes('r2')) return PROVIDER_WEIGHTS.r2;
  return PROVIDER_WEIGHTS.unknown;
}

function getAngleOrVersion(filename) {
  if (!filename) return '';
  const match = String(filename).toLowerCase().match(/_(0[1-9]|[1-9][0-9]|[a-z]{1,2}|closeup|sideview|zoom|angle|front|back|wide|profile)\b/);
  return match ? match[0].replace(/^_/, '') : '';
}

function getCategoryFromPathish(s) {
  if (!s) return '';
  const L = lower(s);
  if (L.includes('lore_history_mystery_horror')) return 'lore_history_mystery_horror';
  if (L.includes('sports_fitness')) return 'sports_fitness';
  if (L.includes('cars_vehicles')) return 'cars_vehicles';
  if (L.includes('animals_primates')) return 'animals_primates';
  if (L.includes('food_cooking')) return 'food_cooking';
  return 'misc';
}

// Word-boundary contains check (proper-noun friendly)
function containsPhraseBoundary(hay, needle) {
  const H = lower(hay);
  const N = lower(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${N}\\b`, 'i');
  return re.test(H);
}

function jaccardScore(aTokens, bTokens) {
  const A = new Set(aTokens);
  const B = new Set(bTokens);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return inter / union; // 0..1
}

function isPortraitLike(candidate) {
  const w = Number(candidate.width || 0);
  const h = Number(candidate.height || 0);
  if (!w || !h) return false;
  return h > w; // portrait-ish
}

// Practical quality checks
function hasWatermarkishText(s) {
  const L = lower(s || '');
  return /\b(watermark|subscribe|logo|tiktok|youtube|instagram|follow)\b/.test(L);
}
function isCompilationishText(s) {
  const L = lower(s || '');
  return /\b(compilation|edit|montage|remix|meme edit)\b/.test(L);
}

// ----------------------------------------------------------
// 10M-aware subject normalization for scoring
// ----------------------------------------------------------
function normalizeSubjectForScoring(subject) {
  // Accept: string, legacy object, array, or Section 11 strict object
  let resolved = null;
  try {
    if (typeof subject === 'string') {
      resolved = resolveCanonicalSubject({ primary: subject });
    } else if (Array.isArray(subject)) {
      resolved = resolveCanonicalSubject({ primary: subject[0], alternates: subject.slice(1) });
    } else if (subject && typeof subject === 'object') {
      resolved = resolveCanonicalSubject(subject);
    } else {
      resolved = resolveCanonicalSubject('subject');
    }
  } catch (e) {
    resolved = resolveCanonicalSubject(subject || 'subject');
  }

  const canon = lower(resolved.canonical || '');
  const type = lower(resolved.type || 'other');
  const feature = lower(resolved.featureOrAction || '');
  const alts = Array.isArray(resolved.alternates) ? resolved.alternates.map(lower) : [];
  const syns10m = Array.isArray(resolved.synonyms) ? resolved.synonyms.map(lower) : [];
  const langs10m = Array.isArray(resolved.languageVariants) ? resolved.languageVariants.map(lower) : [];
  const features10m = Array.isArray(resolved.features) ? resolved.features.map(lower) : [];
  const actions10m = Array.isArray(resolved.actions) ? resolved.actions.map(lower) : [];

  // Legacy expansions for robustness
  const legacyStrings = subjectToStringsLegacy(subject);
  const legacyTokens = subjectToTokensLegacy(subject);
  const legacyExpanded = expandSynonymsLegacy(legacyStrings);

  const canonicalStrings = dedupeKeepOrder([
    canon,
    ...alts,
    ...syns10m,
    ...langs10m,
    ...legacyExpanded
  ]).filter(Boolean);

  const subjectTokens = dedupeKeepOrder([
    ...majorWords(canon),
    ...legacyTokens
  ]);

  const featureTokens = feature ? majorWords(feature) : [];

  // Geography metadata from 10M (optional)
  let geo = null;
  try {
    geo = getEntityMetadata ? getEntityMetadata(canon) : null;
    // Expected geo shape: { city, country, region, altNames: [] } — best-effort
  } catch (_) { /* noop */ }

  return { canon, type, feature, featureTokens, canonicalStrings, subjectTokens, geo };
}

// ----------------------------------------------------------
// Core Scoring
// ----------------------------------------------------------

/**
 * Bulletproof scorer for scene candidates.
 * - Exact boundary matching on canonical/synonyms/language variants
 * - Feature/Action bonuses when present
 * - Entity-type penalties to suppress off-topic content
 * - Geography nudges from 10M metadata (city/country/region presence)
 * - Provider/portrait/video bonuses
 * - Anti-dup/angle-repeat hard blocks
 * - Watermark/compilation penalties
 * - Jaccard token overlap fallback
 *
 * @param {object} candidate - { filename, tags, title, description, filePath, provider, isVideo, url, width, height }
 * @param {string|object|array} subject
 * @param {string[]} usedFiles - Array of filePaths/filenames used so far in this job
 * @param {boolean} realMatchExists - legacy signal (safe to pass true)
 * @returns {number} score (can be negative); typical 0–220
 */
function scoreSceneCandidate(candidate, subject, usedFiles = [], realMatchExists = true) {
  try {
    if (!candidate || !subject) {
      console.log('[10G][SCORE][ERR] Missing candidate or subject!', { candidate, subject });
      return 0;
    }

    // Normalize candidate fields
    const fname = lower(candidate.filename || path.basename(candidate.filePath || '') || '');
    const tags = (candidate.tags || []).map(t => lower(t));
    const title = lower(candidate.title || '');
    const desc = lower(candidate.description || '');
    const url = lower(candidate.url || '');
    const pathish = lower(candidate.filePath || candidate.filename || candidate.url || '');
    const isVid = candidate.isVideo === true;
    const provWeight = providerWeight(candidate.provider || pathish);
    const used = usedFiles.includes(candidate.filePath || candidate.filename) ||
                 usedFiles.includes(path.basename(candidate.filePath || candidate.filename || ''));

    // Category & angle
    const candidateCategory =
      getCategoryFromPathish(pathish) || getCategoryFromPathish(title) || getCategoryFromPathish(desc);
    const candidateAngle = getAngleOrVersion(fname);

    // DUPLICATE & ANGLE REPEAT BLOCKERS
    if (used) {
      console.log(`[10G][SCORE][BLOCKED][DUPLICATE] ${fname}`);
      return -5000;
    }
    const angleUsed = candidateAngle && usedFiles.some(f => getAngleOrVersion(f) === candidateAngle);
    if (angleUsed && candidateAngle) {
      console.log(`[10G][SCORE][BLOCKED][ANGLE_REPEAT] Angle "${candidateAngle}" already used: ${fname}`);
      return -3500;
    }

    // 10M-normalized subject
    const S = normalizeSubjectForScoring(subject);
    const landmarkMode = S.type === 'landmark' || isLandmarkSubjectLegacy(S.canon);
    const animalMode   = S.type === 'animal';
    const objectMode   = S.type === 'object' || S.type === 'symbol';
    const foodMode     = S.type === 'food';

    // Generic penalty: strong if any real match exists (callers usually filter)
    const generic = isGenericCandidate(candidate);
    const baseGenericPenalty = generic ? (realMatchExists ? -1200 : -160) : 0;

    // Aggregate haystacks
    const hayTitle = title;
    const hayDesc  = desc;
    const hayFile  = fname;
    const hayTags  = tags.join(' ');
    const hayUrl   = url;
    const hayAll   = `${hayTitle} ${hayDesc} ${hayFile} ${hayTags} ${hayUrl}`.trim();

    // ------------------------------------------------------
    // Practical quality penalties
    // ------------------------------------------------------
    if (hasWatermarkishText(hayAll)) {
      console.log(`[10G][SCORE][PENALTY][WATERMARK] ${fname} -${PENALTY_WATERMARK}`);
    }
    if (isCompilationishText(hayAll)) {
      console.log(`[10G][SCORE][PENALTY][COMPILATION] ${fname} -${PENALTY_COMPILATION}`);
    }

    // ------------------------------------------------------
    // Entity-Type Off-topic Culls (pre-score penalties)
    // ------------------------------------------------------
    if (landmarkMode) {
      const animalText  = hasAnimalText(candidate);
      const personText  = hasPersonText(candidate);
      const allowedHumans = /\b(guard|guards|soldier|soldiers|ceremony|changing of the guard)\b/.test(`${title} ${desc}`);
      const hasLandmarkWords = containsAny(LANDMARK_KEYWORDS, `${title} ${desc} ${fname} ${hayTags}`);
      if ((animalText || personText) && !(allowedHumans && hasLandmarkWords)) {
        console.log(`[10G][SCORE][BLOCKED][LANDMARK_OFFTOPIC] ${fname}`);
        return -3000;
      }
    }
    if (animalMode) {
      if (hasPersonText(candidate)) {
        console.log(`[10G][SCORE][PENALTY][ANIMAL_HAS_PEOPLE] ${fname} -${PENALTY_OFFTOPIC_PERSON}`);
      }
    }
    if (objectMode || foodMode) {
      if (hasPersonText(candidate)) {
        console.log(`[10G][SCORE][PENALTY][OBJECT_FOOD_HAS_PEOPLE] ${fname} -${Math.floor(PENALTY_OFFTOPIC_PERSON * 0.6)}`);
      }
      if (hasAnimalText(candidate) && !animalMode) {
        console.log(`[10G][SCORE][PENALTY][OBJECT_FOOD_HAS_ANIMALS] ${fname} -${Math.floor(PENALTY_OFFTOPIC_ANIMAL * 0.6)}`);
      }
    }

    // ------------------------------------------------------
    // 1) STRICT BOUNDARY: Canonical / Synonym / Language Variant
    // ------------------------------------------------------
    let strictBest = 0;
    for (const subjStr of S.canonicalStrings) {
      if (!subjStr) continue;

      const boundaryHit =
        containsPhraseBoundary(hayAll, subjStr) ||
        tags.includes(lower(subjStr));

      if (boundaryHit) {
        let score = 160; // canonical-first world
        if (isVid) score += 20;
        score += provWeight;
        if (candidateCategory && containsPhraseBoundary(candidateCategory, subjStr)) score += 8;
        if (isPortraitLike(candidate)) score += PORTRAIT_BONUS;

        // Feature/Action inline bonus if also present
        if (S.featureTokens.length > 0) {
          const featureHit = S.featureTokens.some(ft =>
            containsPhraseBoundary(hayAll, ft) || tags.includes(ft)
          );
          if (featureHit) {
            score += FEATURE_BONUS_INLINE;
            console.log(`[10G][SCORE][FEATURE_INLINE][+"${S.feature}"] +${FEATURE_BONUS_INLINE} [${fname}]`);
          }
        }

        // Geography nudge (city/country/region)
        if (S.geo) {
          const geoParts = [
            S.geo.city,
            S.geo.country,
            S.geo.region,
            ...(Array.isArray(S.geo.altNames) ? S.geo.altNames : [])
          ].filter(Boolean).map(lower);
          if (geoParts.length) {
            const geoHit = geoParts.some(g => containsPhraseBoundary(hayAll, g));
            if (geoHit) {
              score += 8;
              console.log(`[10G][SCORE][GEO] +8 for geography match [${fname}]`);
            }
          }
        }

        // Entity-type micro bonuses (subject-fit nudges)
        if (landmarkMode) score += 6;
        if (animalMode)   score += 6;
        if (foodMode)     score += 4;

        // Quality penalties applied after positives so logs are clearer
        if (hasWatermarkishText(hayAll)) score -= PENALTY_WATERMARK;
        if (isCompilationishText(hayAll)) score -= PENALTY_COMPILATION;

        score += baseGenericPenalty;
        console.log(`[10G][SCORE][STRICT_BOUNDARY]["${subjStr}"] = ${score} [${fname}]`);
        strictBest = Math.max(strictBest, score);
      }
    }
    if (strictBest > 0) return strictBest;

    // ------------------------------------------------------
    // 2) FEATURE/ACTION LOOSE BONUS (without canonical boundary)
    // ------------------------------------------------------
    let featureLooseBonus = 0;
    if (S.featureTokens.length > 0) {
      const featureLooseHit = S.featureTokens.some(ft =>
        hayAll.includes(ft) || tags.some(t => t.includes(ft))
      );
      if (featureLooseHit) {
        featureLooseBonus += FEATURE_BONUS_LOOSE;
        console.log(`[10G][SCORE][FEATURE_LOOSE][+"${S.feature}"] +${FEATURE_BONUS_LOOSE} [${fname}]`);
      }
    }

    // ------------------------------------------------------
    // 3) LOOSE TOKEN / JACCARD OVERLAP
    // ------------------------------------------------------
    let tokenHits = 0;
    let looseScore = 0;
    for (const w of S.subjectTokens) {
      if (!w) continue;
      if (hayAll.includes(w) || tags.some(t => t.includes(w))) {
        tokenHits++;
        looseScore += 11;
      }
    }
    const candTokens = majorWords(hayTitle || hayFile);
    const jac = jaccardScore(S.subjectTokens, candTokens);
    if (jac > 0) looseScore += Math.round(jac * 30); // up to +30

    if (tokenHits > 0 || featureLooseBonus > 0) {
      if (tokenHits >= S.subjectTokens.length && S.subjectTokens.length > 0) looseScore += 18; // full cover bonus
      if (isVid) looseScore += 10;
      if (isPortraitLike(candidate)) looseScore += PORTRAIT_BONUS;
      looseScore += provWeight;
      looseScore += baseGenericPenalty;
      looseScore += featureLooseBonus;

      // Geography nudge
      if (S.geo) {
        const geoParts = [
          S.geo.city,
          S.geo.country,
          S.geo.region,
          ...(Array.isArray(S.geo.altNames) ? S.geo.altNames : [])
        ].filter(Boolean).map(lower);
        if (geoParts.length) {
          const geoHit = geoParts.some(g => containsPhraseBoundary(hayAll, g));
          if (geoHit) {
            looseScore += 6;
            console.log(`[10G][SCORE][GEO_LOOSE] +6 for geography match [${fname}]`);
          }
        }
      }

      // Entity-fit nudges
      if (landmarkMode) looseScore += 4;
      if (animalMode)   looseScore += 4;
      if (foodMode)     looseScore += 2;

      if (hasWatermarkishText(hayAll)) looseScore -= PENALTY_WATERMARK;
      if (isCompilationishText(hayAll)) looseScore -= PENALTY_COMPILATION;

      console.log(`[10G][SCORE][LOOSE][canon="${S.canon}"] tokens=${tokenHits} jac=${jac.toFixed(3)} feat+${featureLooseBonus} => ${looseScore} [${fname}]`);
      return looseScore;
    }

    // ------------------------------------------------------
    // 4) THEMATIC / CATEGORY LAST RESORT
    // ------------------------------------------------------
    if (candidateCategory) {
      const subjCatHint = S.canonicalStrings.some(s => candidateCategory === getCategoryFromPathish(s));
      if (subjCatHint) {
        let catScore = 38 + provWeight + (isVid ? 2 : 0) + baseGenericPenalty;
        if (isPortraitLike(candidate)) catScore += Math.floor(PORTRAIT_BONUS / 2);
        if (hasWatermarkishText(hayAll)) catScore -= Math.floor(PENALTY_WATERMARK / 2);
        if (isCompilationishText(hayAll)) catScore -= Math.floor(PENALTY_COMPILATION / 2);
        console.log(`[10G][SCORE][CATEGORY_HINT]["${S.canon}"] = ${catScore} [${fname}]`);
        return catScore;
      }
    }

    // ------------------------------------------------------
    // 5) DEFAULT / GENERIC
    // ------------------------------------------------------
    let genericScore = generic ? (realMatchExists ? -1200 : -160) : 8;
    genericScore += provWeight;
    if (isVid) genericScore += 2;
    if (isPortraitLike(candidate)) genericScore += Math.floor(PORTRAIT_BONUS / 2);
    if (hasWatermarkishText(hayAll)) genericScore -= Math.floor(PENALTY_WATERMARK / 2);
    if (isCompilationishText(hayAll)) genericScore -= Math.floor(PENALTY_COMPILATION / 2);
    console.log(`[10G][SCORE][DEFAULT]["${S.canon}"] = ${genericScore} [${fname}]`);
    return genericScore;
  } catch (err) {
    console.error('[10G][SCORE][FATAL]', err);
    return 0;
  }
}

// -----------------------------
// Export
// -----------------------------
module.exports = {
  scoreSceneCandidate,
  GENERIC_SUBJECTS,
  SYNONYMS,
  LANDMARK_KEYWORDS,
  ANIMAL_TERMS,
  PERSON_TERMS,
  // Expose helpers for 5D tests/metrics if needed
  _internals: {
    majorWords,
    containsPhraseBoundary,
    jaccardScore,
    isGenericCandidate,
    isLandmarkSubject: isLandmarkSubjectLegacy,
    providerWeight,
    getAngleOrVersion,
    getCategoryFromPathish,
    isPortraitLike,
    normalizeSubjectForScoring,
  },
};


