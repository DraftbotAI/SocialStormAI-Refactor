// ===========================================================
// SECTION 10G: SCENE SCORING HELPER (Universal Candidate Matcher)
// Scores candidate videos/images for best subject match, no matter source.
// Bulletproof: penalizes generics, signs, logos, dupes, prefers video.
// Adds: landmark strictness, provider weighting, category & angle preference,
// multi-angle anti-repeat, Jaccard token overlap, proper-noun exact matching,
// portrait bias for Shorts/Reels (when dims known).
// Handles subject as string, object, or array. MAX LOGGING.
// Used by Section 5D and all video/image helpers.
// ===========================================================

const path = require('path');

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
  'museum','gallery','library','university','campus','garden','plaza','square','market','bazaar'
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

// Synonyms & alias expansions. Keep short and safe.
// NOTE: We also auto-generate landmark aliases from subject itself.
const SYNONYMS = {
  gorilla: ['gorillas','primate','ape','apes','chimpanzee','monkey'],
  chimpanzee: ['chimp','chimps','ape','apes','primate','monkey'],
  lion: ['lions','big cat','wildcat'],
  dog: ['dogs','puppy','puppies','canine'],
  cat: ['cats','kitten','kittens','feline'],

  // Landmarks (basic expansions)
  'great wall of china': ['great wall','china wall','the great wall'],
  'edinburgh castle': ['edinburgh fortress','edinburgh castle scotland','castle rock edinburgh'],
  'giza pyramids': ['pyramids of giza','giza pyramid','great pyramids','egypt pyramids'],
  'eiffel tower': ['tour eiffel','paris tower'],
  stonehenge: ['stone henge'],
  'machu picchu': ['machupicchu'],
};

// Portrait bias (light) if width/height known (Shorts/Reels/TikTok)
const PORTRAIT_BONUS = 6; // gentle nudge, not dominant

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

// Generic checks (string/candidate)
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

function subjectToStrings(subject) {
  if (!subject) return [];
  if (typeof subject === 'string') return [subject];
  if (Array.isArray(subject)) return subject.flatMap(subjectToStrings);
  const out = [];
  if (subject.main) out.push(subject.main);
  if (subject.secondary) out.push(subject.secondary);
  if (Array.isArray(subject.synonyms)) out.push(...subject.synonyms);
  if (Array.isArray(subject.tokens)) out.push(...subject.tokens);
  return out.filter(Boolean).map(String);
}

function subjectToTokens(subject) {
  if (!subject) return [];
  if (typeof subject === 'string') return majorWords(subject);
  if (Array.isArray(subject)) return subject.flatMap(subjectToTokens);
  let tokens = [];
  if (subject.main) tokens.push(...majorWords(subject.main));
  if (subject.secondary) tokens.push(...majorWords(subject.secondary));
  if (Array.isArray(subject.synonyms)) tokens.push(...subject.synonyms.flatMap(majorWords));
  if (Array.isArray(subject.tokens)) tokens.push(...subject.tokens.flatMap(majorWords));
  return tokens.filter(Boolean);
}

function expandSynonyms(strings) {
  const out = [];
  for (const s of strings) {
    out.push(s);
    const key = lower(s);
    const syns = SYNONYMS[key];
    if (Array.isArray(syns)) out.push(...syns);
  }
  return dedupeKeepOrder(out);
}

// Create alias forms for phrases (drop stopwords, short form, etc.)
function aliasPhrases(strings) {
  const out = new Set();
  for (const s of strings) {
    const L = lower(s);
    out.add(s);
    // Short form: remove stopwords
    const mw = majorWords(L).join(' ');
    if (mw && mw !== L) out.add(mw);
    // Hyphen/underscore free
    out.add(L.replace(/[-_]+/g, ' '));
  }
  return Array.from(out);
}

// Identify if the subject is a "landmark-mode" target
function isLandmarkSubject(subject) {
  const strings = subjectToStrings(subject);
  const tokens = subjectToTokens(subject);
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

// -----------------------------
// Core Scoring
// -----------------------------

/**
 * Bulletproof scorer for scene candidates.
 * - Blocks generic/sign/logo/background if real match exists.
 * - Penalizes duplicates and previous angle/variant repeats.
 * - Prefers video over photo (if specified on candidate).
 * - Uses proper-noun exact boundary matching, synonym/alias expansion,
 *   Jaccard token overlap for robust partials.
 * - Landmark strictness: if subject is a landmark, auto-reject animal/person clips (unless guard/ceremony context).
 * - Portrait bias nudge when dims known.
 * - Hard reject floor handled by callers (e.g., 5D).
 *
 * @param {object} candidate - { filename, tags, title, description, filePath, provider, isVideo, url, width, height }
 * @param {string|object|array} subject
 * @param {string[]} usedFiles - Array of filePaths/filenames used so far in this job
 * @param {boolean} realMatchExists - Are there any real (non-generic) candidates in this batch? (optional signal)
 * @returns {number} score (can be negative); typical 0–200
 */
function scoreSceneCandidate(candidate, subject, usedFiles = [], realMatchExists = false) {
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

    // Subject normalization
    const subjectStringsRaw = subjectToStrings(subject);
    const subjectTokens = subjectToTokens(subject);
    const rawSubj = typeof subject === 'string'
      ? subject
      : (subject.main || subject.secondary || subjectStringsRaw[0] || '');

    // Expand aliases/synonyms for strong exact/boundary matches
    let subjectStrings = aliasPhrases(expandSynonyms(subjectStringsRaw));

    // Landmark strictness & off-topic culls
    const landmarkMode = isLandmarkSubject(subject) || subjectStrings.some(s => containsAny(LANDMARK_KEYWORDS, s));
    if (landmarkMode && (hasAnimalText(candidate) || hasPersonText(candidate))) {
      // Allow people only if title/desc mentions guard/soldier/ceremony with landmark context
      const allowedHumanContext = /\b(guard|guards|soldier|soldiers|ceremony|changing of the guard)\b/.test(`${title} ${desc}`);
      const landmarkContextPresent = subjectStrings.some(s => containsPhraseBoundary(`${title} ${desc} ${fname}`, s));
      if (!(allowedHumanContext && landmarkContextPresent)) {
        console.log(`[10G][SCORE][BLOCKED][LANDMARK_MODE_OFFTOPIC] ${fname}`);
        return -3000;
      }
    }

    // Generic penalty (so true matches dominate)
    const generic = isGenericCandidate(candidate);
    const baseGenericPenalty = generic ? (realMatchExists ? -1200 : -160) : 0;

    // Aggregate haystacks
    const hayTitle = title;
    const hayDesc = desc;
    const hayFile = fname;
    const hayTags = tags.join(' ');
    const hayUrl = url;
    const hayAll = `${hayTitle} ${hayDesc} ${hayFile} ${hayTags} ${hayUrl}`.trim();

    // -----------------------------
    // 1) PROPER-NOUN / EXACT BOUNDARY MATCH
    // -----------------------------
    let strictBest = 0;
    for (const subjStr of subjectStrings) {
      if (!subjStr) continue;
      if (
        containsPhraseBoundary(hayAll, subjStr) ||
        tags.includes(lower(subjStr))
      ) {
        // Strong hit
        let score = 150; // base for exact landmark/phrase hit
        if (isVid) score += 20;
        score += provWeight; // provider trust bonus
        if (candidateCategory && containsPhraseBoundary(candidateCategory, subjStr)) score += 8;
        if (isPortraitLike(candidate)) score += PORTRAIT_BONUS;
        score += baseGenericPenalty;
        console.log(`[10G][SCORE][STRICT_BOUNDARY]["${subjStr}"] = ${score} [${fname}]`);
        strictBest = Math.max(strictBest, score);
      } else {
        // Synonym boundary
        const syns = SYNONYMS[lower(subjStr)] || [];
        for (const syn of syns) {
          if (containsPhraseBoundary(hayAll, syn) || tags.includes(lower(syn))) {
            let s = 132;
            if (isVid) s += 16;
            s += provWeight;
            if (isPortraitLike(candidate)) s += PORTRAIT_BONUS;
            s += baseGenericPenalty;
            console.log(`[10G][SCORE][STRICT_SYNONYM]["${subjStr}"→"${syn}"] = ${s} [${fname}]`);
            strictBest = Math.max(strictBest, s);
            break;
          }
        }
      }
    }
    if (strictBest > 0) return strictBest;

    // -----------------------------
    // 2) LOOSE TOKEN / JACCARD OVERLAP
    // -----------------------------
    let tokenHits = 0;
    let looseScore = 0;
    for (const w of subjectTokens) {
      if (!w) continue;
      if (
        hayAll.includes(w) ||
        tags.some(t => t.includes(w))
      ) {
        tokenHits++;
        looseScore += 11;
      }
    }
    // Jaccard boost with candidate title or filename tokens
    const candTokens = majorWords(hayTitle || hayFile);
    const jac = jaccardScore(subjectTokens, candTokens);
    if (jac > 0) looseScore += Math.round(jac * 30); // up to +30

    if (tokenHits > 0) {
      if (tokenHits >= subjectTokens.length && subjectTokens.length > 0) looseScore += 18; // full cover bonus
      if (isVid) looseScore += 10;
      if (isPortraitLike(candidate)) looseScore += PORTRAIT_BONUS;
      looseScore += provWeight;
      looseScore += baseGenericPenalty;
      console.log(`[10G][SCORE][LOOSE][${rawSubj}] tokens=${tokenHits} jac=${jac.toFixed(3)} => ${looseScore} [${fname}]`);
      return looseScore;
    }

    // -----------------------------
    // 3) THEMATIC / CATEGORY LAST RESORT
    // -----------------------------
    if (candidateCategory) {
      // If subject hint matches category (very weak)
      const subjCatHint = subjectStrings.some(s => candidateCategory === getCategoryFromPathish(s));
      if (subjCatHint) {
        let catScore = 38 + provWeight + (isVid ? 2 : 0) + baseGenericPenalty;
        if (isPortraitLike(candidate)) catScore += Math.floor(PORTRAIT_BONUS / 2);
        console.log(`[10G][SCORE][CATEGORY_HINT][${rawSubj}] = ${catScore} [${fname}]`);
        return catScore;
      }
    }

    // -----------------------------
    // 4) DEFAULT / GENERIC
    // -----------------------------
    let genericScore = generic ? (realMatchExists ? -1200 : -160) : 8;
    genericScore += provWeight;
    if (isVid) genericScore += 2;
    if (isPortraitLike(candidate)) genericScore += Math.floor(PORTRAIT_BONUS / 2);
    console.log(`[10G][SCORE][DEFAULT][${rawSubj}] = ${genericScore} [${fname}]`);
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
    isLandmarkSubject,
    providerWeight,
    getAngleOrVersion,
    getCategoryFromPathish,
    isPortraitLike,
  },
};
