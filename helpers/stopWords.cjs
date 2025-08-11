// helpers/stopWords.cjs
// ============================================================
// STOPWORD & PHRASE PACK (EN, Creator-style)
// Centralized lists so every module stays in sync.
// Exports: STOPWORDS, STOP_PHRASES, stripStopPhrases, OBJECT_HINTS,
//          CANONICAL_MULTI, BANNED_PRIMARY
// ============================================================

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/’/g, "'")
    .trim();
}

// --- Core English ---
const ARTICLES = ['a','an','the'];

const PRONOUNS = [
  'i','me','my','mine','myself',
  'you','your','yours','yourself','yourselves',
  'he','him','his','himself',
  'she','her','hers','herself',
  'it','its','itself',
  'we','us','our','ours','ourselves',
  'they','them','their','theirs','themselves',
  'someone','somebody','something','anyone','anybody','anything','everyone','everybody','everything',
  'who','whom','whose','which','that'
];

const AUX_BE_HAVE_DO = ['be','am','is','are','was','were','been','being','have','has','had','having','do','does','did','doing'];

const MODALS = ['can','could','may','might','must','shall','should','will','would','ought'];

const PREPOSITIONS = [
  'about','above','across','after','against','along','amid','among','around','as','at','before','behind','below','beneath','beside','besides',
  'between','beyond','but','by','concerning','considering','despite','down','during','except','excluding','following','for','from',
  'in','inside','into','like','minus','near','of','off','on','onto','opposite','outside','over','past','per','plus','regarding','round',
  'save','since','than','through','throughout','till','to','toward','towards','under','underneath','unlike','until','up','upon','via',
  'with','within','without'
];

const CONJUNCTIONS = ['and','or','nor','but','so','yet','either','neither','both','whether','though','although','while','whereas','because'];

const QUANTIFIERS = ['all','any','both','each','either','enough','every','few','fewer','less','little','many','more','most','much','neither','no','none','several','some','various'];

// --- Discourse, fillers, hedges ---
const FILLERS = [
  'ok','okay','hey','yo','look','listen','alright','right','guys','folks','everyone','anyway',
  'kinda','sorta','like','literally','actually','basically','really','very','super','totally',
  'maybe','perhaps','almost','nearly','probably','honestly','seriously','lowkey','highkey',
  'remember','try','trying','get','got'
];

// --- Time & context fluff ---
const TIME_WORDS = [
  'now','today','tonight','yesterday','tomorrow','currently','right','immediately','instantly','eventually','soon','later',
  'morning','afternoon','evening','night','week','month','year','daily','weekly','monthly','yearly'
];

// --- Platform & CTA fluff ---
const PLATFORM = [
  'video','clip','footage','content','channel','subscribe','follow','like','comment','share','button','bell','link','bio',
  'tiktok','youtube','shorts','reels','instagram','ig'
];

// --- Question/lead-in fluff ---
const QUESTION_FLUFF = [
  'did','ever','wonder','wondered','guess','imagine','know','knew','heard','believe','think','suppose','curious'
];

// --- Contractions (map to base) + bare variants ---
const CONTRACTIONS = [
  "i'm","you're","we're","they're","he's","she's","it's","that's","there's","what's","who's","where's","when's","how's",
  "i've","you've","we've","they've","should've","would've","could've",
  "i'll","you'll","we'll","they'll","he'll","she'll","it'll","that'll",
  "i'd","you'd","we'd","they'd","he'd","she'd","it'd","that'd",
  "don't","doesn't","didn't","won't","wouldn't","shouldn't","couldn't","can't","cannot","ain't","isn't","aren't","wasn't","weren't","haven't","hasn't","hadn't","weren't"
];
const CONTRACTIONS_BARE = CONTRACTIONS.map(c => c.replace(/'/g,''));

// --- Adjective hype/fluff (non-visual) ---
const ADJECTIVE_FLUFF = [
  // Trevi adds
  'iconic','famous','cinematic','pretty','untold','largest',
  // Generic hype
  'amazing','awesome','incredible','epic','cool','beautiful','gorgeous','stunning','massive','huge','tiny','classic','beloved','legendary'
];

// --- Multi-word phrases to strip BEFORE tokenization ---
const STOP_PHRASES = [
  // Creator intros
  "fun fact","did you know","here's why","here is why","let me tell you","let me show you",
  "in this video","today we","today i'm","today i am","we're going to","we are going to","i'm going to","i am going to",
  "stick around","before we start","without further ado","the truth is","the real reason",

  // Calls to action
  "smash that like","hit the like","link in bio","turn on notifications","subscribe for more",

  // Weak framers
  "the thing is","the point is","the crazy part is","the wild part is","you won't believe","you will not believe",

  // Trevi adds
  "isn't just","not just","more than just","treasure trove of","untold stories",
  "nestled in","in the heart of","one of the most","in the world",
  "talk about","because who needs","legend has it","and get this","or so the story goes",
  "just try","striking a pose","so next time you're","standing before","keeps on giving",
  "loyalty potion"
];

// --- Visual preference helpers ---
const OBJECT_HINTS = new Set([
  'tower','bridge','castle','temple','statue','cathedral','church','mosque','palace','museum','fountain','square','plaza','gate','arch',
  'wall','mount','mountain','volcano','lake','river','waterfall','canyon','island','beach','coast','harbor','harbour','port',
  'forest','desert','dune','valley','glacier','reef','cave','city','village','town','road','street','alley','market',
  'painting','sculpture','artifact','ship','train','plane','skyscraper','wheel','observatory','telescope','bazaar',
  'chariot','seahorse','shell','oceanus'
]);

const CANONICAL_MULTI = [
  'eiffel tower','trevi fountain','great wall of china','statue of liberty','times square','machu picchu','grand canyon',
  'mount everest','niagara falls','burj khalifa','colosseum','sagrada familia','tower bridge','louvre museum',
  'chichen itza','stonehenge','golden gate bridge','angkor wat','petra jordan','taj mahal','leaning tower of pisa',
  'fontana degli innamorati'
];

const BANNED_PRIMARY = new Set(['someone','something','things','stuff','place','thing','fact','truth','reason']);

// Build unified STOPWORDS
function buildStopSet() {
  const buckets = [
    ARTICLES, PRONOUNS, AUX_BE_HAVE_DO, MODALS, PREPOSITIONS, CONJUNCTIONS, QUANTIFIERS,
    FILLERS, TIME_WORDS, PLATFORM, QUESTION_FLUFF, CONTRACTIONS, CONTRACTIONS_BARE, ADJECTIVE_FLUFF
  ];
  const s = new Set();
  for (const list of buckets) for (const item of list) s.add(norm(item));
  return s;
}
const STOPWORDS = buildStopSet();

// Strip known stop phrases globally
function stripStopPhrases(text) {
  let out = norm(text);
  for (const p of STOP_PHRASES) {
    const re = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\b`, 'gi');
    out = out.replace(re, ' ');
  }
  return out.replace(/\s+/g,' ').trim();
}

module.exports = {
  STOPWORDS,
  STOP_PHRASES,
  stripStopPhrases,
  OBJECT_HINTS,
  CANONICAL_MULTI,
  BANNED_PRIMARY,
};
