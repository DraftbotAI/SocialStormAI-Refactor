// ===========================================================
// SECTION 10G: SCENE SCORING HELPER (Universal Candidate Matcher)
// Scores candidate videos/images for best subject match, no matter source.
// Used by Section 5D and all video/image helpers.
// MAX LOGGING READY (light by default), robust token matching.
// ===========================================================

/**
 * Candidate shape (flexible; missing fields are fine):
 * {
 *   filename: "vecteezy_undersea-wildlife-manatee-....mp4",
 *   filePath: "/local/path/file.mp4" or "r2/key",
 *   tags: ["manatee","ocean","wildlife"],
 *   title: "Undersea wildlife: manatee",
 *   description: "Close-up of a West Indian manatee",
 *   provider: "r2" | "pexels" | "pixabay" | "unsplash",
 *   width: 1080, height: 1920, // optional, for portrait preference
 *   meta: { aspect: "9:16" }   // optional metadata
 * }
 */

// ---- Canonical synonyms / expansions (extend anytime) ----
const SYNONYMS = {
  // Wildlife
  gorilla: ['gorillas', 'primate', 'ape', 'apes', 'chimpanzee', 'monkey'],
  chimpanzee: ['chimp', 'chimps', 'ape', 'apes', 'primate', 'monkey'],
  lion: ['lions', 'big cat', 'wildcat'],

  // *** Manatee family (key for your library) ***
  manatee: [
    'manatees',
    'sea cow',
    'sea cows',
    'west indian manatee',
    'trichechus',
    'florida manatee'
  ],
};

// Weak-topic background tags (limited influence)
const WEAK_TAGS = new Set(['primate', 'jungle', 'wildlife', 'nature', 'animal', 'animals', 'ocean', 'sea', 'water']);

// ---- Helpers ----
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  const n = norm(s);
  if (!n) return [];
  return n
    .replace(/[_\-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function expandSubject(subject) {
  const subj = norm(subject);
  const out = new Set([subj]);
  // Canonical synonyms
  const syns = SYNONYMS[subj];
  if (syns) syns.forEach(s => out.add(norm(s)));
  // Singular/plural flip
  if (subj.endsWith('s')) out.add(subj.slice(0, -1));
  else out.add(`${subj}s`);
  return Array.from(out).filter(Boolean);
}

function isPortrait(candidate) {
  if (!candidate) return false;
  // explicit dimensions
  if (candidate.width && candidate.height && candidate.height > candidate.width) return true;
  // hint via meta
  if (candidate.meta && typeof candidate.meta.aspect === 'string' && /9\s*:\s*16/.test(candidate.meta.aspect)) return true;
  // filename/title hints
  const f = `${candidate.filename || ''} ${candidate.title || ''}`.toLowerCase();
  return /\b9[_x:\- ]?16\b/.test(f) || /tiktok|shorts|reel|portrait/.test(f);
}

/**
 * Scores a candidate against a subject.
 * 100 = strong, exact subject match across fields
 * 80+ = partial via synonym or strong field token match
 * 75  = decent filename/title token inclusion
 * 50  = weakly related (generic context only), capped
 * 0   = not relevant or already used
 *
 * @param {object} candidate - see shape above
 * @param {string} subject
 * @param {string[]|Set<string>} usedFiles - paths/filenames/keys already used
 * @param {object} opts - { debug?: boolean }
 * @returns {number} score (0–100)
 */
function scoreSceneCandidate(candidate, subject, usedFiles = [], opts = {}) {
  try {
    if (!candidate || !subject) return 0;

    // De-dupe check
    const usedSet = usedFiles instanceof Set ? usedFiles : new Set(usedFiles || []);
    const keyForms = [
      candidate.filePath,
      candidate.filename,
      (candidate.filePath || '').split('/').pop(),
      (candidate.filename || '').split('/').pop(),
    ].filter(Boolean);
    if (keyForms.some(k => usedSet.has(k))) return 0;

    const subj = norm(subject);
    const subjTokens = tokens(subject);
    const expansions = expandSubject(subject);

    const fname = norm(candidate.filename);
    const fTokens = tokens(candidate.filename);
    const title = norm(candidate.title);
    const tTokens = tokens(candidate.title);
    const desc = norm(candidate.description);
    const dTokens = tokens(candidate.description);
    const tags = uniq((candidate.tags || []).map(norm));
    const tagSet = new Set(tags);

    // ---- Scoring buckets ----
    let score = 0;

    // Strong: exact subject token present in filename/tags/title/desc
    const exactTokenHit =
      fTokens.includes(subj) ||
      tTokens.includes(subj) ||
      dTokens.includes(subj) ||
      tagSet.has(subj);

    if (exactTokenHit) score += 70;

    // Strong: subject phrase contained (substring, helps hyphenated names)
    const phraseHit =
      (fname && fname.includes(subj)) ||
      (title && title.includes(subj)) ||
      (desc && desc.includes(subj));
    if (phraseHit) score += 15;

    // Synonym/expansion hits (token match first, then substring)
    let synonymTokenHits = 0;
    let synonymSubHits = 0;
    for (const exp of expansions) {
      if (exp === subj) continue;
      if (fTokens.includes(exp) || tTokens.includes(exp) || dTokens.includes(exp) || tagSet.has(exp)) {
        synonymTokenHits++;
      } else if (
        (fname && fname.includes(exp)) ||
        (title && title.includes(exp)) ||
        (desc && desc.includes(exp))
      ) {
        synonymSubHits++;
      }
    }
    if (synonymTokenHits) score += Math.min(40, 20 + 10 * synonymTokenHits); // token-level synonyms are strong
    if (synonymSubHits) score += Math.min(20, 10 + 5 * synonymSubHits);

    // Per-field token overlap with subject tokens (helps multi-word subjects)
    const subjectTokenSet = new Set(subjTokens);
    const tokenOverlap =
      fTokens.filter(t => subjectTokenSet.has(t)).length +
      tTokens.filter(t => subjectTokenSet.has(t)).length +
      dTokens.filter(t => subjectTokenSet.has(t)).length;
    if (tokenOverlap) score += Math.min(20, tokenOverlap * 4);

    // Helpful tag presence (exact)
    const helpfulTags = subjTokens.filter(t => tagSet.has(t)).length;
    if (helpfulTags) score += Math.min(15, helpfulTags * 5);

    // Weak tags (context only) — capped influence
    const weakHits = tags.filter(t => WEAK_TAGS.has(t)).length;
    if (weakHits) score += Math.min(20, weakHits * 3);

    // Portrait hint boost (prefer vertical when ties)
    if (isPortrait(candidate)) score += 6;

    // Length penalty for very long filenames/titles (avoid generic junk)
    const lengthPenalty = Math.min(15, Math.floor(((candidate.filename || '').length + (candidate.title || '').length) / 60));
    score -= lengthPenalty;

    // Bound to 0..100
    if (score < 0) score = 0;
    if (score > 100) score = 100;

    if (opts && opts.debug) {
      console.log('[10G][DEBUG]', {
        subject: subj,
        expansions,
        filename: candidate.filename,
        title: candidate.title,
        score,
        exactTokenHit,
        phraseHit,
        synonymTokenHits,
        synonymSubHits,
        tokenOverlap,
        helpfulTags,
        weakHits,
        isPortrait: isPortrait(candidate),
        lengthPenalty,
      });
    }

    return score;
  } catch (err) {
    console.error('[10G][ERR] scoreSceneCandidate failed:', err);
    return 0;
  }
}

module.exports = { scoreSceneCandidate };
