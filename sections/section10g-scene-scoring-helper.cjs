// ===========================================================
// SECTION 10G: SCENE SCORING HELPER (Universal Candidate Matcher)
// Scores candidate videos/images for best subject match, no matter source.
// Used by Section 5D and all video/image helpers.
// ===========================================================

const SYNONYMS = {
  gorilla: ['gorillas', 'primate', 'ape', 'apes', 'chimpanzee', 'monkey'],
  chimpanzee: ['chimp', 'chimps', 'ape', 'apes', 'primate', 'monkey'],
  lion: ['lions', 'big cat', 'wildcat'],
  // Add more as needed!
};

/**
 * Scores a candidate against a subject.
 * 100 = perfect subject match (filename/tags/title/desc)
 * 80+ = partial (strong synonym)
 * 75  = partial token (e.g. in filename)
 * 50  = weakly related ("jungle", "primate" for "gorilla")
 * 0   = not relevant or already used
 * 
 * @param {object} candidate - { filename, tags, title, description, filePath, provider }
 * @param {string} subject
 * @param {string[]} usedFiles - Array of filePaths/filenames used so far in this job
 * @returns {number} score (0–100)
 */
function scoreSceneCandidate(candidate, subject, usedFiles = []) {
  if (!candidate || !subject) return 0;
  const subj = (subject || '').toLowerCase().trim();
  const fname = (candidate.filename || '').toLowerCase();
  const tags = (candidate.tags || []).map(t => t.toLowerCase());
  const title = (candidate.title || '').toLowerCase();
  const desc = (candidate.description || '').toLowerCase();
  const used = usedFiles.includes(candidate.filePath || candidate.filename);

  // Already used = 0
  if (used) return 0;

  // Exact filename/tag/title/desc match
  if (
    fname.includes(subj) ||
    tags.includes(subj) ||
    title.includes(subj) ||
    desc.includes(subj)
  ) return 100;

  // Partial or synonym match
  const syns = SYNONYMS[subj] || [];
  for (const syn of syns) {
    if (
      fname.includes(syn) ||
      tags.includes(syn) ||
      title.includes(syn) ||
      desc.includes(syn)
    ) return 85;
  }

  // Partial token match (e.g., "gorilla" as a word in a sentence)
  if (
    fname.split(/[\s_\-\.\d]/).includes(subj) ||
    tags.some(t => t.includes(subj)) ||
    title.split(/[\s_\-\.\d]/).includes(subj) ||
    desc.split(/[\s_\-\.\d]/).includes(subj)
  ) return 75;

  // Weakly related (e.g., "jungle", "primate", etc.)
  if (
    tags.some(t => ['primate', 'jungle', 'wildlife', 'nature', 'animal'].includes(t))
  ) return 50;

  // No match
  return 10;
}

module.exports = { scoreSceneCandidate };
