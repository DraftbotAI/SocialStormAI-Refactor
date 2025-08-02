// /sections/music-moods.cjs
const path = require('path');
const fs = require('fs');

// Map moods to your actual folder names (sync this list to your folders!)
const musicMoods = {
  action: 'action_sports_intense',
  adventure: 'cinematic_epic_adventure',
  explainer: 'corporate_educational_explainer',
  suspense: 'dramatic_tense_suspense',
  fantasy: 'fantasy_magical',
  funny: 'funny_quirky_whimsical',
  happy: 'happy_summer',
  lofi: 'lofi_chill_ambient',
  inspiring: 'motivation_inspiration_uplifting',
  ambient: 'nature_ambient_relaxing',
  documentary: 'news_documentary_neutral',
  retro: 'retro_8-bit_gaming',
  sad: 'sad_emotional_reflective',
  tech: 'science_tech_futuristic',
  spooky: 'spooky_creepy_mystery_horror',
  pop: 'upbeat_energetic_pop',
  // add more as needed
};
const baseMusicDir = path.join(__dirname, '..', 'public', 'assets', 'music_library');

function getMusicFolderForMood(mood) {
  // fallback: use 'inspiring'
  const folder = musicMoods[mood] || musicMoods['inspiring'];
  return path.join(baseMusicDir, folder);
}

function getAllMusicFilesForMood(mood) {
  const folderPath = getMusicFolderForMood(mood);
  if (!fs.existsSync(folderPath)) {
    console.warn(`[MUSIC_MOODS][WARN] Folder for mood '${mood}' does not exist: ${folderPath}`);
    return [];
  }
  const files = fs.readdirSync(folderPath).filter(f =>
    f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg')
  );
  if (!files.length) {
    console.warn(`[MUSIC_MOODS][WARN] No music files found for mood '${mood}' in folder: ${folderPath}`);
  }
  return files.map(f => path.join(folderPath, f));
}

// TRUE random per request, falls back to "any" if mood is empty
function getRandomMusicFileForMood(mood = 'inspiring') {
  let files = getAllMusicFilesForMood(mood);
  if (!files.length) {
    // Fallback: try random from *any* folder
    const allFiles = [];
    Object.keys(musicMoods).forEach(m => {
      allFiles.push(...getAllMusicFilesForMood(m));
    });
    if (!allFiles.length) {
      console.error(`[MUSIC_MOODS][ERR] No music files found in ANY mood folder!`);
      return null;
    }
    files = allFiles;
    console.warn(`[MUSIC_MOODS][WARN] Using random fallback song (no files for mood '${mood}')`);
  }
  const idx = Math.floor(Math.random() * files.length);
  const pick = files[idx];
  console.log(`[MUSIC_MOODS][PICK] Mood='${mood}' → "${pick}"`);
  return pick;
}

// Utility: list all supported moods (for UI, debugging, or random mood picking)
function getAllMoods() {
  return Object.keys(musicMoods);
}

// Utility: list all tracks for ALL moods (debug/audit)
function listAllTracks() {
  const summary = {};
  Object.keys(musicMoods).forEach(mood => {
    summary[mood] = getAllMusicFilesForMood(mood);
  });
  return summary;
}

module.exports = {
  getMusicFolderForMood,
  getRandomMusicFileForMood,
  getAllMusicFilesForMood,
  getAllMoods,
  listAllTracks,
  musicMoods,
  baseMusicDir
};
