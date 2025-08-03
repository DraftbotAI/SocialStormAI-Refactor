// /sections/music-moods.cjs
const path = require('path');
const fs = require('fs');

// === MAP: keywords → actual folder names (sync with your folders) ===
const musicMoods = {
  action: 'action_sports_intense',
  intense: 'action_sports_intense',
  sports: 'action_sports_intense',
  adventure: 'cinematic_epic_adventure',
  epic: 'cinematic_epic_adventure',
  cinematic: 'cinematic_epic_adventure',
  explainer: 'corporate_educational_explainer',
  corporate: 'corporate_educational_explainer',
  educational: 'corporate_educational_explainer',
  suspense: 'dramatic_tense_suspense',
  dramatic: 'dramatic_tense_suspense',
  tense: 'dramatic_tense_suspense',
  fantasy: 'fantasy_magical',
  magical: 'fantasy_magical',
  funny: 'funny_quirky_whimsical',
  quirky: 'funny_quirky_whimsical',
  whimsical: 'funny_quirky_whimsical',
  happy: 'happy_summer',
  summer: 'happy_summer',
  lofi: 'lofi_chill_ambient',
  chill: 'lofi_chill_ambient',
  ambient: 'lofi_chill_ambient', // Main 'lofi' not 'nature'
  relaxing: 'nature_ambient_relaxing',
  nature: 'nature_ambient_relaxing',
  inspiring: 'motivation_inspiration_uplifting',
  motivation: 'motivation_inspiration_uplifting',
  uplifting: 'motivation_inspiration_uplifting',
  historical: 'historical',
  history: 'historical',
  documentary: 'news_documentary_neutral',
  neutral: 'news_documentary_neutral',
  retro: 'retro_8-bit_gaming',
  gaming: 'retro_8-bit_gaming',
  '8-bit': 'retro_8-bit_gaming',
  sad: 'sad_emotional_reflective',
  emotional: 'sad_emotional_reflective',
  reflective: 'sad_emotional_reflective',
  tech: 'science_tech_futuristic',
  futuristic: 'science_tech_futuristic',
  science: 'science_tech_futuristic',
  spooky: 'spooky_creepy_mystery_horror',
  creepy: 'spooky_creepy_mystery_horror',
  horror: 'spooky_creepy_mystery_horror',
  mystery: 'spooky_creepy_mystery_horror',
  pop: 'upbeat_energetic_pop',
  upbeat: 'upbeat_energetic_pop',
  energetic: 'upbeat_energetic_pop',
  // Fallbacks/expansion
};

const KNOWN_FOLDERS = [
  'action_sports_intense',
  'cinematic_epic_adventure',
  'corporate_educational_explainer',
  'dramatic_tense_suspense',
  'fantasy_magical',
  'funny_quirky_whimsical',
  'happy_summer',
  'historical',
  'lofi_chill_ambient',
  'motivation_inspiration_uplifting',
  'nature_ambient_relaxing',
  'news_documentary_neutral',
  'retro_8-bit_gaming',
  'sad_emotional_reflective',
  'science_tech_futuristic',
  'spooky_creepy_mystery_horror',
  'upbeat_energetic_pop'
];

const baseMusicDir = path.join(__dirname, '..', 'public', 'assets', 'music_library');

// --- Helper: Normalize mood or keyword ---
function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

// === Get best folder for a mood or keyword ===
function bestFolderMatch(mood) {
  let val = normalize(mood);
  if (!val) return 'motivation_inspiration_uplifting'; // Fallback default

  // Direct map from musicMoods
  if (musicMoods[val]) return musicMoods[val];

  // Exact folder match
  if (KNOWN_FOLDERS.includes(val)) return val;

  // Fuzzy partial keyword match
  for (const key of Object.keys(musicMoods)) {
    if (val.includes(key)) return musicMoods[key];
  }

  // Fuzzy partial folder match
  for (const folder of KNOWN_FOLDERS) {
    if (val.includes(folder) || folder.includes(val)) return folder;
  }

  // Fallback
  return 'motivation_inspiration_uplifting';
}

// === Get absolute path to folder for a mood ===
function getMusicFolderForMood(mood) {
  const folder = bestFolderMatch(mood);
  const dirPath = path.join(baseMusicDir, folder);
  if (!fs.existsSync(dirPath)) {
    console.warn(`[MUSIC_MOODS][WARN] Folder for mood '${mood}' [${folder}] does not exist: ${dirPath}`);
  }
  return dirPath;
}

// === Get all music files (full path) for a mood ===
function getAllMusicFilesForMood(mood) {
  const folderPath = getMusicFolderForMood(mood);
  let files = [];
  if (fs.existsSync(folderPath)) {
    files = fs.readdirSync(folderPath)
      .filter(f => /\.(mp3|wav|aac|ogg)$/i.test(f))
      .map(f => path.join(folderPath, f));
  }
  if (!files.length) {
    console.warn(`[MUSIC_MOODS][WARN] No tracks found for mood '${mood}' in ${folderPath}`);
  }
  return files;
}

// === Pick a random track per request, NEVER repeat if more than 1 exists ===
let _lastTrack = null;
function getRandomMusicFileForMood(mood = 'motivation_inspiration_uplifting') {
  let files = getAllMusicFilesForMood(mood);
  if (!files.length) {
    // Try any folder
    const allFiles = [];
    for (const folder of KNOWN_FOLDERS) {
      allFiles.push(...getAllMusicFilesForMood(folder));
    }
    if (!allFiles.length) {
      console.error(`[MUSIC_MOODS][ERR] No music tracks found in ANY mood folder!`);
      return null;
    }
    files = allFiles;
    console.warn(`[MUSIC_MOODS][WARN] Using random fallback song from ANY mood.`);
  }
  let idx = Math.floor(Math.random() * files.length);

  // Prevent repeat if possible
  if (files.length > 1 && _lastTrack && files.length < 100) {
    let tries = 0;
    while (files[idx] === _lastTrack && tries < 10) {
      idx = Math.floor(Math.random() * files.length);
      tries++;
    }
  }
  const pick = files[idx];
  _lastTrack = pick;
  console.log(`[MUSIC_MOODS][PICK] Mood="${mood}" → "${pick}"`);
  return pick;
}

function getAllMoods() {
  return [...KNOWN_FOLDERS];
}

function listAllTracks() {
  const summary = {};
  for (const folder of KNOWN_FOLDERS) {
    summary[folder] = getAllMusicFilesForMood(folder);
  }
  return summary;
}

// === MAIN MOOD DETECTOR: given a script, return a best mood/folder name ===
function detectMusicMood(script) {
  const text = (script || '').toLowerCase();
  if (/funny|joke|quirky|whimsical|laugh/i.test(text)) return 'funny_quirky_whimsical';
  if (/scary|horror|spooky|creepy|ghost|mystery/i.test(text)) return 'spooky_creepy_mystery_horror';
  if (/sad|cry|emotional|tear|loss|lonely|goodbye/i.test(text)) return 'sad_emotional_reflective';
  if (/inspire|motivate|uplift|dream|goal|win|achieve/i.test(text)) return 'motivation_inspiration_uplifting';
  if (/science|tech|ai|future|robot|space/i.test(text)) return 'science_tech_futuristic';
  if (/game|arcade|8-bit|retro/i.test(text)) return 'retro_8-bit_gaming';
  if (/summer|sun|beach|vacation|happy/i.test(text)) return 'happy_summer';
  if (/chill|ambient|relax|lofi/i.test(text)) return 'lofi_chill_ambient';
  if (/action|sports|intense|extreme/i.test(text)) return 'action_sports_intense';
  if (/tense|suspense|drama|dramatic/i.test(text)) return 'dramatic_tense_suspense';
  if (/cinematic|epic|adventure/i.test(text)) return 'cinematic_epic_adventure';
  if (/fantasy|magic|wizard|dragon/i.test(text)) return 'fantasy_magical';
  if (/historic|history|past|empire|war/i.test(text)) return 'historical';
  if (/news|documentary|neutral|report/i.test(text)) return 'news_documentary_neutral';
  if (/nature|ocean|forest|animal|mountain|tree/i.test(text)) return 'nature_ambient_relaxing';
  if (/corporate|business|office|meeting|education|lesson/i.test(text)) return 'corporate_educational_explainer';
  if (/pop|upbeat|energetic/i.test(text)) return 'upbeat_energetic_pop';
  // Default fallback
  return 'motivation_inspiration_uplifting';
}

module.exports = {
  getMusicFolderForMood,
  getRandomMusicFileForMood,
  getAllMusicFilesForMood,
  getAllMoods,
  listAllTracks,
  musicMoods,
  baseMusicDir,
  bestFolderMatch,
  detectMusicMood // <--- main AI hook
};
