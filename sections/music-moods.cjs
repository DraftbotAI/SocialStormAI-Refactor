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

function getRandomMusicFileForMood(mood) {
  const folderPath = getMusicFolderForMood(mood);
  if (!fs.existsSync(folderPath)) return null;
  const files = fs.readdirSync(folderPath).filter(f =>
    f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg')
  );
  if (!files.length) return null;
  // Pick one at random
  const idx = Math.floor(Math.random() * files.length);
  return path.join(folderPath, files[idx]);
}

module.exports = { getMusicFolderForMood, getRandomMusicFileForMood, musicMoods, baseMusicDir };
