// ===========================================================
// SECTION 5C: SCRIPT & SCENE UTILITIES
// Splits script into scenes, handles scene structure, utilities.
// MAX LOGGING AT EVERY STEP
// Enhanced: Scene 1+2 "mega-scene" grouping for continuous video
// Bulletproof: Always returns array of scene objects, never strings
// ===========================================================

const uuid = require('uuid'); // For scene IDs

console.log('[5C][INIT] Script & scene utilities loaded.');

// === Split script into scenes with 1+2 paired logic ===
/**
 * Enhanced split:
 * - Groups first two lines into a "mega-scene" for continuous video.
 * - Each subsequent line is a regular scene.
 * - Each scene: { id, texts: [str], isMegaScene: bool, type, origIndices }
 * @param {string} script - Full script text, possibly multi-line.
 * @returns {Array<{id: string, texts: string[], isMegaScene?: boolean, type: string, origIndices: number[]}>}
 */
function splitScriptToScenes(script) {
  console.log('[5C][SPLIT] splitScriptToScenes called.');

  if (!script || typeof script !== 'string') {
    console.error('[5C][ERR] No script provided or script not a string.');
    return [];
  }

  // Step 1: Try splitting by newlines.
  let lines = script.split('\n').map(line => line.trim()).filter(line => !!line);

  // Step 2: If only 0 or 1 line, fallback to sentence split.
  if (lines.length < 2) {
    lines = script.split(/[.?!]\s+/).map(s => s.trim()).filter(Boolean);
    console.log(`[5C][SPLIT] Fallback: Split by sentence, got ${lines.length} lines.`);
  } else {
    console.log(`[5C][SPLIT] Script split into ${lines.length} non-empty lines.`);
  }

  // Step 3: Remove any empty lines again just to be sure.
  lines = lines.filter(Boolean);

  const scenes = [];

  if (lines.length >= 2) {
    // Create "mega-scene" for first two lines
    const id = `megascene-1-2-${uuid.v4()}`;
    scenes.push({
      id,
      texts: [lines[0], lines[1]],
      isMegaScene: true,
      type: 'hook+main',
      origIndices: [0, 1],
    });
    console.log(`[5C][MEGA] Created MEGA-SCENE for lines 1+2 [ID: ${id}]`);
    // Add each additional line as its own scene
    for (let i = 2; i < lines.length; ++i) {
      const sceneId = `scene${i + 1}-${uuid.v4()}`;
      scenes.push({
        id: sceneId,
        texts: [lines[i]],
        isMegaScene: false,
        type: 'normal',
        origIndices: [i],
      });
      console.log(`[5C][SCENE] Created scene ${i + 1}: "${lines[i]}" [ID: ${sceneId}]`);
    }
  } else if (lines.length === 1) {
    // Only one line: treat as a regular scene
    const sceneId = `scene1-${uuid.v4()}`;
    scenes.push({
      id: sceneId,
      texts: [lines[0]],
      isMegaScene: false,
      type: 'single',
      origIndices: [0],
    });
    console.log(`[5C][SCENE] Only one line, created single scene [ID: ${sceneId}]`);
  } else {
    console.warn('[5C][SPLIT] No scenes found in script!');
  }

  // Defensive: Bulletproof—make sure each scene is a proper object
  const finalScenes = scenes.map((scene, idx) => {
    if (!scene || typeof scene !== 'object') {
      console.error(`[5C][DEFENSE][BUG] Scene at idx ${idx} is not an object! Wrapping as fallback.`);
      return {
        id: `scene${idx + 1}-fixwrap-${uuid.v4()}`,
        texts: [typeof scene === 'string' ? scene : String(scene)],
        isMegaScene: false,
        type: 'auto-wrap',
        origIndices: [idx]
      };
    }
    // Defensive: ensure .texts is always an array of strings (never empty or null)
    let safeTexts = Array.isArray(scene.texts) ? scene.texts.map(t => String(t || '')) : [String(scene.texts || '')];
    if (!safeTexts.length || !safeTexts[0]) {
      safeTexts = [''];
      console.warn(`[5C][DEFENSE][BUG] Scene ${scene.id || idx} had empty texts array. Setting to [''].`);
    }
    return { ...scene, texts: safeTexts };
  });

  console.log(`[5C][SPLIT] Total scenes generated (mega + singles): ${finalScenes.length}`);
  finalScenes.forEach((scene, idx) => {
    console.log(`[5C][SCENES][${idx}] ID: ${scene.id}, Mega: ${!!scene.isMegaScene}, Type: ${scene.type}, Lines: ${scene.texts.length}, OrigIndices: ${scene.origIndices.join(',')}`);
  });

  return finalScenes;
}

// === Utility: Guess main subject from all scenes (stub for future AI upgrades) ===
/**
 * Gets the most repeated or thematically central word/phrase in all scenes.
 * @param {Array<{id: string, texts: string[]}>} scenes
 * @returns {string} Main subject guess
 */
function guessMainSubjectFromScenes(scenes) {
  console.log('[5C][SUBJECT] guessMainSubjectFromScenes called.');
  if (!Array.isArray(scenes) || !scenes.length) {
    console.warn('[5C][SUBJECT] No scenes to analyze.');
    return '';
  }
  // Flatten all texts
  const allTexts = scenes.flatMap(s => s.texts || []);
  const freq = {};
  for (const text of allTexts) {
    const words = (text || '').toLowerCase().split(/\W+/).filter(w => w.length > 3);
    for (const word of words) {
      freq[word] = (freq[word] || 0) + 1;
    }
  }
  let main = '';
  let max = 0;
  for (const [word, count] of Object.entries(freq)) {
    if (count > max) {
      main = word;
      max = count;
    }
  }
  console.log(`[5C][SUBJECT] Main subject guessed: "${main}" (appears ${max}x)`);
  return main;
}

// === Utility: Clean scene text (remove special chars, extra spaces, etc.) ===
/**
 * Clean up scene text (remove special chars, extra spaces, etc.)
 * @param {string} text
 * @returns {string}
 */
function cleanSceneText(text) {
  if (!text) return '';
  let cleaned = text.replace(/\s+/g, ' ').replace(/[^\w\s.,?!-]/g, '').trim();
  console.log(`[5C][CLEAN] Cleaned scene text: "${cleaned}"`);
  return cleaned;
}

module.exports = {
  splitScriptToScenes,
  guessMainSubjectFromScenes,
  cleanSceneText,
};
