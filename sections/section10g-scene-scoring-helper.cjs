// ===========================================================
// SECTION 10G: SCENE SCORING HELPER (Universal Candidate Matcher)
// Scores candidate videos/images for best subject match, no matter source.
// Bulletproof: penalizes generics, signs, logos, dupes, and prefers video.
// Handles subject as string, object, or array. Max logging.
// Used by Section 5D and all video/image helpers.
// ===========================================================

const path = require('path');

const GENERIC_SUBJECTS = [
  'face', 'person', 'man', 'woman', 'it', 'thing', 'someone', 'something', 'body', 'eyes',
  'kid', 'boy', 'girl', 'they', 'we', 'people', 'scene', 'child', 'children', 'sign', 'logo', 'text'
];

const SYNONYMS = {
  gorilla: ['gorillas', 'primate', 'ape', 'apes', 'chimpanzee', 'monkey'],
  chimpanzee: ['chimp', 'chimps', 'ape', 'apes', 'primate', 'monkey'],
  lion: ['lions', 'big cat', 'wildcat'],
  manatee: ['sea cow', 'manatees'],
  // Add more as needed!
};

function getMajorWords(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
}

function isGeneric(filename = '') {
  filename = filename.toLowerCase();
  return GENERIC_SUBJECTS.some(g => filename.includes(g)) || /\b(sign|logo|text)\b/.test(filename);
}

function getAllSubjectTokens(subject) {
  // Accepts string, object, or array, returns array of major words
  if (!subject) return [];
  if (typeof subject === 'string') return getMajorWords(subject);
  if (Array.isArray(subject)) return subject.flatMap(getAllSubjectTokens);
  // Object: look for main, secondary, synonyms, tokens
  let tokens = [];
  if (subject.main) tokens.push(...getMajorWords(subject.main));
  if (subject.secondary) tokens.push(...getMajorWords(subject.secondary));
  if (Array.isArray(subject.synonyms)) tokens.push(...subject.synonyms.flatMap(getMajorWords));
  if (Array.isArray(subject.tokens)) tokens.push(...subject.tokens.flatMap(getMajorWords));
  return tokens.filter(Boolean);
}

function getAllSubjectStrings(subject) {
  // Extracts all possible string values from a subject
  if (!subject) return [];
  if (typeof subject === 'string') return [subject];
  if (Array.isArray(subject)) return subject.flatMap(getAllSubjectStrings);
  // Object fields (main, secondary, synonyms, tokens)
  let out = [];
  if (subject.main) out.push(subject.main);
  if (subject.secondary) out.push(subject.secondary);
  if (Array.isArray(subject.synonyms)) out.push(...subject.synonyms);
  if (Array.isArray(subject.tokens)) out.push(...subject.tokens);
  return out.filter(Boolean);
}

/**
 * Bulletproof scorer for scene candidates.
 * - Blocks generic/sign/logo if real match exists.
 * - Penalizes duplicates.
 * - Prefers video over photo (if specified on candidate).
 * - Uses strong/loose token, synonym, and fallback scoring.
 *
 * @param {object} candidate - { filename, tags, title, description, filePath, provider, isVideo }
 * @param {string|object|array} subject
 * @param {string[]} usedFiles - Array of filePaths/filenames used so far in this job
 * @param {boolean} realMatchExists - Are there any real (non-generic) candidates in this batch?
 * @returns {number} score (0–150)
 */
function scoreSceneCandidate(candidate, subject, usedFiles = [], realMatchExists = false) {
  // Defensive null checks
  if (!candidate || !subject) {
    console.log('[10G][SCORE][ERR] Missing candidate or subject!', { candidate, subject });
    return 0;
  }

  // Pull candidate fields
  const fname = (candidate.filename || path.basename(candidate.filePath || '') || '').toLowerCase();
  const tags = (candidate.tags || []).map(t => t.toLowerCase());
  const title = (candidate.title || '').toLowerCase();
  const desc = (candidate.description || '').toLowerCase();
  const isVid = candidate.isVideo === true;
  const used = usedFiles.includes(candidate.filePath || candidate.filename);

  // [DUPLICATE BLOCKER]
  if (used) {
    console.log(`[10G][SCORE][BLOCKED][DUPLICATE] ${fname}`);
    return -5000;
  }

  // Support: Accepts subject as string/object/array
  const subjectStrings = getAllSubjectStrings(subject);
  const subjectTokens = getAllSubjectTokens(subject);
  const rawSubj = (typeof subject === 'string') ? subject : (subject.main || subject.secondary || subjectStrings[0] || '');

  // 1. Strong/strict subject match (filename/tag/title/desc)
  for (const subjStr of subjectStrings) {
    const subj = subjStr.toLowerCase().trim();
    if (
      fname.includes(subj) ||
      tags.includes(subj) ||
      title.includes(subj) ||
      desc.includes(subj)
    ) {
      let score = 120;
      if (isVid) score += 20;
      if (isGeneric(fname) && realMatchExists) score -= 2000;
      if (isGeneric(fname) && !realMatchExists) score -= 200;
      console.log(`[10G][SCORE][STRICT][${subj}] = ${score} [${fname}] [${typeof subject}]`);
      return score;
    }

    // Synonym match
    const syns = SYNONYMS[subj] || [];
    for (const syn of syns) {
      if (
        fname.includes(syn) ||
        tags.includes(syn) ||
        title.includes(syn) ||
        desc.includes(syn)
      ) {
        let score = 100;
        if (isVid) score += 10;
        if (isGeneric(fname) && realMatchExists) score -= 2000;
        if (isGeneric(fname) && !realMatchExists) score -= 200;
        console.log(`[10G][SCORE][SYNONYM][${subj}→${syn}] = ${score} [${fname}]`);
        return score;
      }
    }
  }

  // 2. Loose token/major word match (ANY token)
  let looseScore = 0;
  let tokensMatched = 0;
  subjectTokens.forEach(word => {
    if (
      fname.includes(word) ||
      tags.some(t => t.includes(word)) ||
      title.includes(word) ||
      desc.includes(word)
    ) {
      looseScore += 10;
      tokensMatched++;
    }
  });
  if (tokensMatched === subjectTokens.length && tokensMatched > 0) looseScore += 20; // All tokens matched
  if (looseScore > 0) {
    if (isVid) looseScore += 10;
    if (isGeneric(fname) && realMatchExists) looseScore -= 2000;
    if (isGeneric(fname) && !realMatchExists) looseScore -= 200;
    console.log(`[10G][SCORE][LOOSE][${rawSubj}] = ${looseScore} [${fname}] [${typeof subject}]`);
    return looseScore;
  }

  // 3. Weakly related (animal, nature, etc.)
  if (
    tags.some(t => ['primate', 'jungle', 'wildlife', 'nature', 'animal'].includes(t))
  ) {
    let weakScore = 40;
    if (isVid) weakScore += 10;
    if (isGeneric(fname) && realMatchExists) weakScore -= 2000;
    if (isGeneric(fname) && !realMatchExists) weakScore -= 200;
    console.log(`[10G][SCORE][WEAK][${rawSubj}] = ${weakScore} [${fname}]`);
    return weakScore;
  }

  // 4. Generic fallback (absolutely nothing else matches)
  let genericScore = isGeneric(fname) ? (realMatchExists ? -2000 : -200) : 10;
  if (isVid) genericScore += 2;
  console.log(`[10G][SCORE][GENERIC/DEFAULT][${rawSubj}] = ${genericScore} [${fname}]`);
  return genericScore;
}

module.exports = { scoreSceneCandidate, GENERIC_SUBJECTS, SYNONYMS };
