// ============================================================
// SECTION 10N: STOPWORD-BASED SUBJECT EXTRACTOR (Deterministic)
// Purpose:
//   Extract a literal, filmable SUBJECT from a line using:
//     1) Multi-word canonical phrase detection (e.g., "trevi fountain")
//     2) Head-noun reconstruction (e.g., "<modifier> fountain")
//     3) Object-hint + frequency/length heuristics
//   Falls back to mainTopic, then to a safe generic.
//
// Exports:
//   - extractSubjectByStopwords(line, mainTopic) -> string (primary subject)
//   - extractSubjectByStopwordsDetailed(line, mainTopic) -> { primary, confidence, candidates[], debug{} }
//   - stripAllStops(line) -> string (utility)
//
// Notes:
//   - Uses centralized lists via section10n-stopword-lists.cjs
//   - MAX LOGGING with stable tags
//   - No cross-job memory; purely local/deterministic
// ============================================================

'use strict';

const {
  STOPWORDS,
  STOP_PHRASES,
  stripStopPhrases,
  OBJECT_HINTS,
  CANONICAL_MULTI,
  BANNED_PRIMARY,
} = require('./section10n-stopword-lists.cjs');

const HEAD_NOUNS = new Set([
  'fountain','bridge','castle','temple','statue','cathedral','church','mosque','palace','museum','square','plaza','gate','arch','tower',
  'wall','mountain','volcano','lake','river','waterfall','canyon','island','beach','coast','harbor','harbour','port',
  'forest','desert','dune','valley','glacier','reef','cave','city','village','town','road','street','alley','market',
  'colosseum','basilica','arena','monument','pyramid','observatory','wheel'
]);

function norm(s) { return String(s || '').toLowerCase().trim(); }

function titleCase(s = '') {
  return s.split(/\s+/).map(w => w ? (w[0].toUpperCase() + w.slice(1)) : w).join(' ').trim();
}

function tokenize(raw) {
  // Keep alnum + apostrophes inside tokens
  const out = [];
  const rx = /[a-z0-9]+(?:'[a-z0-9]+)?/gi;
  let m;
  while ((m = rx.exec(raw))) out.push(m[0]);
  return out;
}

function stripAllStops(line) {
  const noPhrases = stripStopPhrases(line);
  const toks = tokenize(noPhrases);
  const keep = toks.filter(t => !STOPWORDS.has(norm(t)) && t.length > 2);
  return keep.join(' ');
}

function findPhraseOriginal(original, phraseLower) {
  const i = original.toLowerCase().indexOf(phraseLower);
  if (i === -1) return null;
  return original.slice(i, i + phraseLower.length);
}

function canonicalCandidates(lineRaw) {
  const lower = norm(lineRaw);
  const out = [];
  // sort canonical phrases by length desc to prefer longest
  const sorted = [...CANONICAL_MULTI].sort((a, b) => b.length - a.length);
  for (const ph of sorted) {
    const phLower = ph.toLowerCase();
    // word-boundary search
    const re = new RegExp(`\\b${phLower.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\b`, 'i');
    if (re.test(lower)) {
      const orig = findPhraseOriginal(lineRaw, phLower) || titleCase(phLower);
      out.push({ text: orig, score: 1.0, reason: 'canonical-phrase' });
      // Keep scanning to collect others, but the first will usually win
    }
  }
  return out;
}

function headNounReconstruction(lineRaw) {
  // Build "<modifier> <head>" bigrams using original order
  const lower = norm(lineRaw);
  const tokens = tokenize(lower);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!HEAD_NOUNS.has(tok)) continue;
    // prev token as modifier if not a stopword
    const prev = tokens[i - 1];
    if (prev && !STOPWORDS.has(prev) && prev.length > 2) {
      const phrase = `${prev} ${tok}`;
      out.push({ text: titleCase(phrase), score: 0.82, reason: 'head-noun-bigram' });
    }
    // try prev2 + prev + head if prev2 is strong (not stopword and >=4)
    const prev2 = tokens[i - 2];
    if (prev && prev2 && !STOPWORDS.has(prev2) && prev2.length >= 4 && !STOPWORDS.has(prev)) {
      const tri = `${prev2} ${prev} ${tok}`;
      out.push({ text: titleCase(tri), score: 0.86, reason: 'head-noun-trigram' });
    }
    // bare head noun
    out.push({ text: titleCase(tok), score: 0.65, reason: 'head-noun' });
  }
  return dedupeByKey(out, c => norm(c.text));
}

function objectHintCandidates(lineRaw) {
  const cleaned = stripStopPhrases(lineRaw);
  const toks = tokenize(cleaned);
  const keep = toks.filter(t => !STOPWORDS.has(norm(t)) && t.length > 2);
  const freq = new Map();
  for (const t of keep) {
    const k = norm(t);
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const out = [];
  for (const [k, count] of freq.entries()) {
    if (OBJECT_HINTS.has(k)) {
      const baseScore = 0.74 + Math.min(0.06, count * 0.01);
      out.push({ text: titleCase(k), score: baseScore, reason: 'object-hint' });
    } else if (count >= 2 && k.length >= 5) {
      // noun-ish heuristic: repeated, long-ish token
      const baseScore = 0.68 + Math.min(0.05, count * 0.01);
      out.push({ text: titleCase(k), score: baseScore, reason: 'freq-long' });
    }
  }
  return dedupeByKey(out, c => norm(c.text));
}

function applyContextBoost(cands, lineRaw) {
  const lower = norm(lineRaw);
  const boosts = [
    { key: 'fountain', add: 0.08 },
    { key: 'bridge', add: 0.06 },
    { key: 'castle', add: 0.05 },
    { key: 'statue', add: 0.05 },
    { key: 'temple', add: 0.05 },
  ];
  for (const c of cands) {
    const lc = norm(c.text);
    for (const b of boosts) {
      if (lc.includes(b.key) || lower.includes(b.key)) c.score += b.add;
    }
  }
  return cands;
}

function dedupeByKey(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function filterBanned(cands) {
  return cands.filter(c => !BANNED_PRIMARY.has(norm(c.text)));
}

function rankCandidates(all) {
  // Sort by score desc, then longer text, then alpha
  return [...all].sort((a, b) =>
    (b.score - a.score) ||
    (b.text.length - a.text.length) ||
    (a.text.localeCompare(b.text))
  );
}

function finalizePrimary(cands, mainTopic) {
  if (cands.length) {
    const top = rankCandidates(cands)[0];
    let conf = Math.max(0, Math.min(1, top.score));
    // clamp confidence bands
    if (conf >= 0.95) conf = 0.95;
    if (conf < 0.6 && mainTopic) {
      // weak confidence → bias to mainTopic if it's literal
      const mt = titleCase(mainTopic.trim());
      if (!BANNED_PRIMARY.has(norm(mt))) {
        return { primary: mt, confidence: 0.62, source: 'fallback-mainTopic' };
      }
    }
    return { primary: top.text, confidence: conf, source: 'ranked' };
  }
  // No candidates → fallbacks
  if (mainTopic && !BANNED_PRIMARY.has(norm(mainTopic))) {
    return { primary: titleCase(mainTopic), confidence: 0.6, source: 'fallback-mainTopic' };
  }
  return { primary: 'Landmark', confidence: 0.5, source: 'fallback-generic' };
}

function extractSubjectByStopwordsDetailed(line, mainTopic = '') {
  const original = String(line || '');
  const main = String(mainTopic || '').trim();

  console.log(`[10N-EXTRACT][INPUT] line="${original}" mainTopic="${main}"`);

  if (!original.trim()) {
    const fb = finalizePrimary([], main);
    console.log(`[10N-EXTRACT][EMPTY] -> ${fb.primary} (${fb.source})`);
    return { primary: fb.primary, confidence: fb.confidence, candidates: [], debug: { empty: true } };
  }

  const canon = canonicalCandidates(original);
  const heads = headNounReconstruction(original);
  const hints = objectHintCandidates(original);

  let merged = [...canon, ...heads, ...hints];
  merged = applyContextBoost(merged, original);
  merged = filterBanned(merged);
  merged = dedupeByKey(merged, c => norm(c.text));

  const ranked = rankCandidates(merged);
  const fb = finalizePrimary(ranked, main);

  const debug = {
    canon,
    heads,
    hints,
    ranked,
    source: fb.source
  };

  console.log(`[10N-EXTRACT][RESULT] primary="${fb.primary}" conf=${fb.confidence.toFixed(2)} source=${fb.source}`);
  return { primary: fb.primary, confidence: fb.confidence, candidates: ranked.map(r => r.text), debug };
}

function extractSubjectByStopwords(line, mainTopic = '') {
  const { primary } = extractSubjectByStopwordsDetailed(line, mainTopic);
  return primary;
}

module.exports = {
  extractSubjectByStopwords,
  extractSubjectByStopwordsDetailed,
  stripAllStops,
};
