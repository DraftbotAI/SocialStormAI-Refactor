// ===========================================================
// SECTION 10Z: LITERAL SUBJECT PICKER (Heuristic, GPT-free, Fast)
// Produces up to 3 short, literal, non-generic visual options per line.
// Order: (1) direct nouns/actions, (2) question/transition maps, (3) emotion maps.
// Deterministic, no network calls, minimal allocations, max logging optional.
// ===========================================================

/** Light stopword set (lowercase). */
const STOP = new Set([
  'the','a','an','and','or','but','of','to','in','on','at','for','from','by','with','as',
  'is','are','was','were','be','been','being','it','this','that','these','those','there',
  'then','than','so','such','very','just','really','quite','some','any','much','many',
  'i','you','he','she','we','they','me','him','her','us','them','my','your','his','its','our','their',
  'can','should','could','would','will','do','does','did','how','why','what','when','where','which','who','whom',
  'if','because','while','though','although','about','around','after','before','during','without','within','between'
]);

const GENERIC_BAN = new Set([
  'something','someone','person','people','scene','man','woman','kid','child','children','thing','stuff','object','background'
]);

// --- tiny lexicons ---
const LANDMARK_HINTS = /\b(castle|tower|bridge|pyramid|temple|cathedral|palace|wall|fort|monument|museum|skyline|mountain|beach|waterfall|desert|forest)\b/i;

const EMOTION = [
  [/\b(anxious|anxiety|worried|nervous|tense|panic|panicky)\b/i, 'worried person biting nails close-up'],
  [/\b(happy|joy|joyful|excited|thrilled|elated|cheerful)\b/i, 'person jumping for joy outdoors'],
  [/\b(sad|unhappy|down|blue|upset|heartbroken)\b/i, 'sad person alone on bench at sunset'],
  [/\b(angry|furious|irate|frustrated|rage)\b/i, 'person with clenched fists close-up'],
  [/\b(shock|shocked|surprised|astonished|plot twist)\b/i, 'face with shocked expression close-up'],
  [/\b(confused|uncertain|unsure|puzzled|dilemma)\b/i, 'person scratching head at laptop'],
  [/\b(relief|relieved|calm|serene|peaceful)\b/i, 'person exhaling with relief by window'],
  [/\b(embarrassed|awkward|ashamed|guilty)\b/i, 'person covering face with hand'],
  [/\b(proud|victory|winner|trophy|medal)\b/i, 'athlete raising a trophy on podium'],
  [/\b(lonely|alone|isolation|isolated)\b/i, 'silhouette sitting alone on park bench'],
  [/\b(stressed|overwhelmed|burned out|pressure)\b/i, 'person with head in hands at desk'],
];

const TRANSITION = [
  [/\b(meanwhile|in the meantime|at the same time)\b/i, 'city skyline time-lapse'],
  [/\b(later that day|later|afterward|afterwards|soon after|minutes later|hours later)\b/i, 'clock hands spinning close-up'],
  [/\b(earlier|before that|previously|rewind)\b/i, 'rewind tape animation'],
  [/\b(moving on|next up|on to|now for|let.?s get started|kick off)\b/i, 'scene change swipe transition'],
  [/\b(finally|in conclusion|to wrap up|wrap it up|at last)\b/i, 'closing curtain animation'],
];

const ACTION_TO_VISUAL = [
  // common verbs → literal visuals
  [/\b(build|construct|assemble)\b/i, 'hands assembling parts on table close-up'],
  [/\b(cook|fry|bake|grill)\b/i, 'chef cooking in pan sizzling close-up'],
  [/\b(code|program|debug)\b/i, 'hands typing on laptop code editor'],
  [/\b(write|note|journal)\b/i, 'hand writing in notebook close-up'],
  [/\b(read|study|revise)\b/i, 'person studying at desk with books'],
  [/\b(run|jog|sprint)\b/i, 'runner on track mid stride'],
  [/\b(present|pitch)\b/i, 'person presenting to small audience'],
  [/\b(record|podcast|voiceover)\b/i, 'microphone in studio close-up'],
];

// noun-ish whitelist boost
const CONCRETE_NOUNS = /\b(cat|dog|puppy|kitten|monkey|lion|tiger|bird|car|train|plane|ship|phone|laptop|book|camera|mic|trophy|medal|lightbulb|bench|desk|window|sunset|storm|lightning|rain|snow|ocean|beach|forest|mountain|bridge|castle|pyramid)\b/i;

/** Clean and lower for token checks. */
function _norm(s) { return String(s || '').trim(); }
function _lower(s) { return _norm(s).toLowerCase(); }

function _tokens(s) {
  return _lower(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
}

function sanitizePhrase(p) {
  let s = _norm(p)
    .replace(/^output\s*[:\-]\s*/i, '')
    .replace(/^[“"'\-]+|[”"'.]+$/g, '')
    .replace(/[.!?;:,]+$/g, '')
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s || GENERIC_BAN.has(_lower(s))) return '';
  const words = s.split(' ').filter(Boolean);
  if (words.length < 3) return '';
  if (words.length > 10) s = words.slice(0, 10).join(' ');
  return s;
}

/** Build up to 3 literal candidates in priority order. */
function getLiteralSceneOptions(sceneLine, mainTopic = '', opts = {}) {
  const line = _norm(sceneLine);
  const out = [];
  if (!line) return out;

  // 1) direct concrete noun extraction
  const combined = `${line} ${mainTopic || ''}`;
  let verbHit = null;
  for (const [re, vis] of ACTION_TO_VISUAL) {
    if (re.test(line)) { verbHit = vis; break; }
  }
  if (verbHit) {
    const s = sanitizePhrase(verbHit);
    if (s) out.push(s);
  }

  // noun phrases / landmarks
  if (LANDMARK_HINTS.test(combined)) {
    const s = sanitizePhrase('iconic landmark wide shot');
    if (s && !out.includes(s)) out.push(s);
  }
  if (CONCRETE_NOUNS.test(combined)) {
    const noun = combined.match(CONCRETE_NOUNS)[0];
    // try to pair noun with a literal action/qualifier
    const nounBest = sanitizePhrase(
      /cat|kitten/.test(noun) ? 'cat close-up purring' :
      /dog|puppy/.test(noun) ? 'dog close-up wagging tail' :
      /monkey/.test(noun) ? 'monkey sitting on branch close-up' :
      /lightning|storm/.test(noun) ? 'stormy sky lightning strike' :
      `${noun} cinematic close-up`
    );
    if (nounBest && !out.includes(nounBest)) out.push(nounBest);
  }

  // 2) transition map
  for (const [re, vis] of TRANSITION) {
    if (re.test(line)) {
      const s = sanitizePhrase(vis);
      if (s && !out.includes(s)) out.push(s);
      break;
    }
  }

  // 3) emotion map
  for (const [re, vis] of EMOTION) {
    if (re.test(line)) {
      const s = sanitizePhrase(vis);
      if (s && !out.includes(s)) out.push(s);
      break;
    }
  }

  // final pass: cap to 3 unique options
  return Array.from(new Set(out)).slice(0, 3);
}

module.exports = { getLiteralSceneOptions };
