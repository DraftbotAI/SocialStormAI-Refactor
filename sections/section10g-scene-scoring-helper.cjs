// ===========================================================
// SECTION 10G: SCENE SCORING HELPER (Universal Candidate Matcher)
// Scores candidate videos/images for best subject match, no matter source.
// Used by Section 5D and all video/image helpers.
//
// 2025-08 updates:
//  - Optional usedFiles (local-only de-dupe handled in 5D; this will only
//    zero-out if a caller still passes usedFiles explicitly).
//  - Word-boundary & plural-aware exact phrase matching
//  - Token-level matching with weights per field
//  - Synonyms/aliases and object-head (fountain/bridge/etc.) boosts
//  - Dense logging with reasons for score
// ===========================================================

'use strict';

const path = require('path');

// Light object heads list (kept local to avoid heavy dependencies)
const OBJECT_HEADS = new Set([
  'fountain','bridge','castle','temple','statue','cathedral','church','mosque','palace','museum','square','plaza','gate','arch','tower',
  'wall','mountain','volcano','lake','river','waterfall','canyon','island','beach','coast','harbor','harbour','port',
  'forest','desert','dune','valley','glacier','reef','cave','city','village','town','road','street','alley','market',
  'colosseum','basilica','arena','monument','pyramid','observatory','wheel'
]);

// Synonyms / aliases (extend as needed)
const SYNONYMS = {
  gorilla: ['gorillas', 'primate', 'ape', 'apes', 'chimpanzee', 'chimp', 'monkey'],
  chimpanzee: ['chimp', 'chimps', 'ape', 'apes', 'primate', 'monkey'],
  lion: ['lions', 'big cat', 'wildcat'],
  manatee: ['manatees', 'sea cow', 'sea cows'],
  'trevi fountain': ['fontana di trevi', 'fontana degli innamorati'],
  dolphin: ['dolphins', 'porpoise'],
  whale: ['whales', 'orca'],
  car: ['cars', 'auto', 'automobile', 'vehicle', 'vehicles'],
  // Add more domain synonyms as we learn
};

function norm(s) {
  return String(s || '').toLowerCase().trim();
}

function escapeRegex(s = '') {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordBoundaryRegex(phraseLower) {
  // Allow trivial plural (s/es) and simple punctuation separation
  const core = escapeRegex(phraseLower);
  return new RegExp(`\\b${core}(?:e?s)?\\b`, 'i');
}

function tokenize(s) {
  const rx = /[a-z0-9]+(?:'[a-z0-9]+)?/gi;
  const out = [];
  let m;
  while ((m = rx.exec(String(s || '')))) out.push(m[0].toLowerCase());
  return out;
}

function includesPhrase(hay, phraseLower) {
  if (!hay || !phraseLower) return false;
  return wordBoundaryRegex(phraseLower).test(hay.toLowerCase());
}

function tokenIn(hay, tok) {
  if (!hay || !tok) return false;
  return new RegExp(`\\b${escapeRegex(tok)}(?:e?s)?\\b`, 'i').test(hay.toLowerCase());
}

function subjectVariants(subject) {
  const s = norm(subject);
  const out = new Set([s]);
  // If subject is multiword, add a collapsed variant without "the"
  if (s.includes(' ')) {
    out.add(s.replace(/\bthe\b/g, '').replace(/\s+/g, ' ').trim());
  }
  // Synonym/alias expansion
  if (SYNONYMS[s]) {
    for (const v of SYNONYMS[s]) out.add(norm(v));
  }
  return Array.from(out).filter(Boolean);
}

function buildHaystack(candidate) {
  const fname = norm(candidate.filename || path.basename(candidate.filePath || ''));
  const title = norm(candidate.title || '');
  const desc  = norm(candidate.description || '');
  const tags  = Array.isArray(candidate.tags) ? candidate.tags.map(norm) : [];
  const tagsStr = tags.join(' ');
  return { fname, title, desc, tags, tagsStr };
}

function inUsed(usedFiles, candidate) {
  if (!usedFiles) return false;
  try {
    const arr = Array.isArray(usedFiles) ? usedFiles : Array.from(usedFiles);
    const ck = (candidate.filePath || candidate.filename || '').toString();
    const base = path.basename(ck);
    return arr.includes(ck) || (base && arr.includes(base));
  } catch { return false; }
}

/**
 * Scores a candidate against a subject.
 * Typical bands:
 *  95–100: exact phrase hit in filename/title/tags (very strong)
 *  80–92 : strong synonym or multi-token dominance
 *  70–79 : token hits across fields
 *  45–60 : weak topical relation (generic nature/animal/etc.)
 *  10    : unknown / off-topic
 *
 * @param {object} candidate - { filename, tags, title, description, filePath, provider }
 * @param {string} subject
 * @param {string[]|Set<string>} usedFiles - (optional) paths/filenames already used in this job
 * @returns {number} score (0–100)
 */
function scoreSceneCandidate(candidate, subject, usedFiles) {
  if (!candidate || !subject) return 0;

  // De-dupe guard if a caller still passes usedFiles (5D now handles its own)
  if (inUsed(usedFiles, candidate)) {
    // Keep zero here to enforce no duplicate within the CURRENT job for
    // legacy call sites that still pass usedFiles.
    return 0;
  }

  const subj = norm(subject);
  const vars = subjectVariants(subj);
  const { fname, title, desc, tags, tagsStr } = buildHaystack(candidate);

  // Field weights (tune-able)
  const W = {
    fname_phrase: 60,
    title_phrase: 40,
    tags_phrase:  40,
    desc_phrase:  25,

    fname_token:  14,
    title_token:  10,
    tags_token:   12,
    desc_token:    6,

    synonym_phrase: 8,
    synonym_token:  6,

    object_head_boost: 8,
    multi_token_bonus: 6,

    weak_topic: 12, // generic topical words
  };

  let score = 10; // baseline
  const reasons = [];

  // 1) Exact phrase matches (subject and its variants)
  for (const v of vars) {
    if (v && v.length >= 3) {
      if (includesPhrase(fname, v)) { score += W.fname_phrase; reasons.push(`fname:"${v}"`); }
      if (includesPhrase(title, v)) { score += W.title_phrase; reasons.push(`title:"${v}"`); }
      if (tags.some(t => t === v) || includesPhrase(tagsStr, v)) { score += W.tags_phrase; reasons.push(`tags:"${v}"`); }
      if (includesPhrase(desc, v)) { score += W.desc_phrase; reasons.push(`desc:"${v}"`); }
    }
  }

  // 2) Token-level matches
  const subjTokens = tokenize(subj).filter(t => t.length > 2);
  let tokenHits = 0;
  for (const tok of subjTokens) {
    if (tokenIn(fname, tok)) { score += W.fname_token; reasons.push(`fname_tok:${tok}`); tokenHits++; }
    if (tokenIn(title, tok)) { score += W.title_token; reasons.push(`title_tok:${tok}`); tokenHits++; }
    if (tags.some(t => tokenIn(t, tok))) { score += W.tags_token; reasons.push(`tags_tok:${tok}`); tokenHits++; }
    if (tokenIn(desc, tok)) { score += W.desc_token; reasons.push(`desc_tok:${tok}`); tokenHits++; }
  }

  if (subjTokens.length >= 2 && tokenHits >= 2) {
    score += W.multi_token_bonus;
    reasons.push('multi_token_bonus');
  }

  // 3) Synonyms/aliases (lighter weight)
  const syns = SYNONYMS[subj] || [];
  for (const syn of syns) {
    const s = norm(syn);
    if (!s) continue;
    if (includesPhrase(fname, s) || includesPhrase(title, s) || includesPhrase(tagsStr, s) || includesPhrase(desc, s)) {
      score += W.synonym_phrase;
      reasons.push(`syn_phrase:"${s}"`);
    } else {
      const stok = tokenize(s);
      for (const t of stok) {
        if (tokenIn(fname, t) || tokenIn(title, t) || tags.some(tag => tokenIn(tag, t)) || tokenIn(desc, t)) {
          score += W.synonym_token;
          reasons.push(`syn_tok:${t}`);
        }
      }
    }
  }

  // 4) Object head boost (e.g., “fountain”, “bridge”)
  for (const head of subjTokens) {
    if (OBJECT_HEADS.has(head)) {
      if (tokenIn(fname, head) || tokenIn(title, head) || tags.some(t => tokenIn(t, head)) || tokenIn(desc, head)) {
        score += W.object_head_boost;
        reasons.push(`object_head:${head}`);
      }
    }
  }

  // 5) Weak topical relation fallback
  const weakSet = new Set(['primate','jungle','wildlife','nature','animal','landmark','city','travel','tourism','scenery','landscape']);
  if (tags.some(t => weakSet.has(t)) || tokenize(title).some(t => weakSet.has(t))) {
    score = Math.max(score, 45 + W.weak_topic);
    reasons.push('weak_topic');
  }

  // Clamp and tidy
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Logging (compact to avoid log spam, but still helpful)
  try {
    const base = path.basename(candidate.filePath || candidate.filename || 'unknown');
    console.log(`[10G][SCORE] subj="${subj}" -> ${score} :: ${base} :: reasons=${reasons.join('|')}`);
  } catch { /* ignore logging errors */ }

  return score;
}

module.exports = { scoreSceneCandidate };
