// ===========================================================
// SECTION 10G: SCENE SCORING HELPER (Universal Candidate Matcher)
// Scores candidate videos/images for best subject match, no matter source.
// Bulletproof: penalizes generics, signs, logos, dupes, and prefers video.
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

/**
 * Bulletproof scorer for scene candidates.
 * - Blocks generic/sign/logo if real match exists.
 * - Penalizes duplicates.
 * - Prefers video over photo (if specified on candidate).
 * - Uses strong/loose token, synonym, and fallback scoring.
 *
 * @param {object} candidate - { filename, tags, title, description, filePath, provider, isVideo }
 * @param {string} subject
 * @param {string[]} usedFiles - Array of filePaths/filenames used so far in this job
 * @param {boolean} realMatchExists - Are there any real (non-generic) candidates in this batch?
 * @returns {number} score (0–150)
 */
function scoreSceneCandidate(candidate, subject, usedFiles = [], realMatchExists = false) {
  if (!candidate || !subject) return -9999;
  const subj = (subject || '').toLowerCase().trim();
  const fname = (candidate.filename || path.basename(candidate.filePath || '') || '').toLowerCase();
  const tags = (candidate.tags || []).map(t => t.toLowerCase());
  const title = (candidate.title || '').toLowerCase();
  const desc = (candidate.description || '').toLowerCase();
  const isVid = candidate.isVideo === true;
  const used = usedFiles.includes(candidate.filePath || candidate.filename);

  // Already used = MASSIVE penalty
  if (used) {
    console.log(`[10G][SCORE][BLOCKED][DUPLICATE] ${fname}`);
    return -5000;
  }

  // Strong/strict subject match (filename/tag/title/desc)
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
    console.log(`[10G][SCORE][STRICT][${subj}] = ${score} [${fname}]`);
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
      console.log(`[10G][SCORE][SYNONYM][${subj}] = ${score} [${fname}]`);
      return score;
    }
  }

  // Loose token/major word match
  const words = getMajorWords(subj);
  let looseScore = 0;
  let tokensMatched = 0;
  words.forEach(word => {
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
  if (tokensMatched === words.length && words.length > 0) looseScore += 20; // All words match
  if (looseScore > 0) {
    if (isVid) looseScore += 10;
    if (isGeneric(fname) && realMatchExists) looseScore -= 2000;
    if (isGeneric(fname) && !realMatchExists) looseScore -= 200;
    console.log(`[10G][SCORE][LOOSE][${subj}] = ${looseScore} [${fname}]`);
    return looseScore;
  }

  // Weakly related (animal, nature, etc.)
  if (
    tags.some(t => ['primate', 'jungle', 'wildlife', 'nature', 'animal'].includes(t))
  ) {
    let weakScore = 40;
    if (isVid) weakScore += 10;
    if (isGeneric(fname) && realMatchExists) weakScore -= 2000;
    if (isGeneric(fname) && !realMatchExists) weakScore -= 200;
    console.log(`[10G][SCORE][WEAK][${subj}] = ${weakScore} [${fname}]`);
    return weakScore;
  }

  // Generic fallback (absolutely nothing else matches)
  let genericScore = isGeneric(fname) ? (realMatchExists ? -2000 : -200) : 10;
  if (isVid) genericScore += 2;
  console.log(`[10G][SCORE][GENERIC/DEFAULT][${subj}] = ${genericScore} [${fname}]`);
  return genericScore;
}

module.exports = { scoreSceneCandidate, GENERIC_SUBJECTS, SYNONYMS };
