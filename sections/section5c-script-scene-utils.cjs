// ===========================================================
// SECTION 5C: SCRIPT & SCENE UTILITIES
// Splits script into scenes, handles scene structure, utilities.
// MAX LOGGING AT EVERY STEP
// Enhanced: Always returns array of scene objects, never strings
// Improved: Viral summary/hook-first logic, super robust sentence/line splitting
// ===========================================================

const uuid = require('uuid'); // For scene IDs

console.log('[5C][INIT] Script & scene utilities loaded.');

// === Pro Helper: Make a viral summary/hook for the intro ===
function generateViralHookAndSummary(script, topic = '') {
  // Use the first line as a clear, viral summary if it fits, else generate one
  let lines = script.split('\n').map(line => line.trim()).filter(Boolean);
  let summaryLine = '';
  // Try to find a line that contains the topic, else fallback to first
  if (topic && lines.some(l => l.toLowerCase().includes(topic.toLowerCase()))) {
    summaryLine = lines.find(l => l.toLowerCase().includes(topic.toLowerCase()));
  } else {
    // Fallback: Use a punchy first line, strip animal metaphors
    summaryLine = (lines[0] || '').replace(/like a[n]? [\w ]+/gi, '').trim();
  }
  // If all else fails, use the first complete sentence or fallback
  if (!summaryLine || summaryLine.length < 8) {
    let bySentence = script.split(/[.?!]\s+/).map(s => s.trim()).filter(Boolean);
    summaryLine = bySentence[0] || lines[0] || script.trim();
  }
  // Avoid empties
  if (!summaryLine) summaryLine = 'You won’t believe this!';
  console.log(`[5C][HOOK] Viral summary/hook generated: "${summaryLine}"`);
  return summaryLine;
}

/**
 * Enhanced split:
 * - First scene is always a strong summary/hook about the topic.
 * - Groups next 1–2 lines as a "mega-scene" if they add context.
 * - Each subsequent line is a regular scene.
 * - Each scene: { id, texts: [str], isMegaScene: bool, type, origIndices }
 * @param {string} script - Full script text, possibly multi-line.
 * @param {string} [topic] - (optional) The main topic for summary hook
 * @returns {Array<{id: string, texts: string[], isMegaScene?: boolean, type: string, origIndices: number[]}>}
 */
function splitScriptToScenes(script, topic = '') {
  console.log('[5C][SPLIT] splitScriptToScenes called.');

  if (!script || typeof script !== 'string') {
    console.error('[5C][ERR] No script provided or script not a string.');
    return [];
  }

  // Step 1: Clean up all lines and sentences, remove blank/junk
  let rawLines = script.split('\n').map(line => line.trim()).filter(Boolean);
  let bySentences = script.split(/[.?!]\s+/).map(s => s.trim()).filter(Boolean);

  // Step 2: Generate a viral summary/hook as the very first scene
  const summaryLine = generateViralHookAndSummary(script, topic);
  let lines = [summaryLine];

  // Step 3: Remove the summary from the rest (prevent dupe)
  let restLines = rawLines.filter(l => l !== summaryLine && l.length > 4);
  if (restLines.length < 2) restLines = bySentences.filter(l => l !== summaryLine && l.length > 4);

  // Log full lines for debug
  console.log(`[5C][SPLIT] Lines for scenes after hook/summary:`, JSON.stringify(restLines));

  // Step 4: Decide grouping for mega-scene (combine next 1–2 lines if they add context)
  let scenes = [];
  const seenIds = new Set();

  // Scene 1: The viral summary/hook
  const hookId = `hookscene-1-${uuid.v4()}`;
  scenes.push({
    id: hookId,
    texts: [summaryLine],
    isMegaScene: false,
    type: 'hook-summary',
    origIndices: [0],
  });
  seenIds.add(hookId);
  console.log(`[5C][HOOK] Created HOOK SCENE: "${summaryLine}" [ID: ${hookId}]`);

  // Scene 2: Optional mega-scene, group next 1–2 context lines
  if (restLines.length > 1) {
    const megaId = `megascene-2-${uuid.v4()}`;
    scenes.push({
      id: megaId,
      texts: [restLines[0], restLines[1]],
      isMegaScene: true,
      type: 'context-mega',
      origIndices: [1, 2],
    });
    seenIds.add(megaId);
    console.log(`[5C][MEGA] Created MEGA-SCENE for context lines [ID: ${megaId}]`);
    // Push remaining lines as normal scenes
    for (let i = 2; i < restLines.length; ++i) {
      const sceneId = `scene${i + 1}-${uuid.v4()}`;
      if (seenIds.has(sceneId)) {
        console.warn(`[5C][SCENE][WARN] Duplicate scene ID generated at index ${i}. Regenerating...`);
      }
      seenIds.add(sceneId);
      scenes.push({
        id: sceneId,
        texts: [restLines[i]],
        isMegaScene: false,
        type: 'normal',
        origIndices: [i + 1],
      });
      console.log(`[5C][SCENE] Created scene ${i + 1}: "${restLines[i]}" [ID: ${sceneId}]`);
    }
  } else if (restLines.length === 1) {
    const sceneId = `scene2-${uuid.v4()}`;
    scenes.push({
      id: sceneId,
      texts: [restLines[0]],
      isMegaScene: false,
      type: 'single',
      origIndices: [1],
    });
    seenIds.add(sceneId);
    console.log(`[5C][SCENE] Only one context line, created single scene [ID: ${sceneId}]`);
  }

  // Bulletproof: Make sure each scene is a proper object, texts always array of non-empty string(s)
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
    let safeTexts = Array.isArray(scene.texts) ? scene.texts.map(t => String(t || '')) : [String(scene.texts || '')];
    if (!safeTexts.length || !safeTexts[0]) {
      safeTexts = [''];
      console.warn(`[5C][DEFENSE][BUG] Scene ${scene.id || idx} had empty texts array. Setting to [''].`);
    }
    // Guard against duplicate scene IDs
    if (idx > 0 && seenIds.has(scene.id)) {
      console.warn(`[5C][DEFENSE][BUG] Duplicate scene ID detected for idx ${idx}: ${scene.id}`);
    }
    return { ...scene, texts: safeTexts };
  });

  console.log(`[5C][SPLIT] Total scenes generated (hook/summary + mega + singles): ${finalScenes.length}`);
  finalScenes.forEach((scene, idx) => {
    console.log(`[5C][SCENES][${idx}] ID: ${scene.id}, Mega: ${!!scene.isMegaScene}, Type: ${scene.type}, Lines: ${scene.texts.length}, OrigIndices: ${scene.origIndices.join(',')}, Text: "${scene.texts.join(' / ')}"`);
  });

  return finalScenes;
}

// === BULLETPROOF DEFENSE: Always return array of valid scenes, never fail ===
function bulletproofScenes(scenes) {
  console.log('[5C][BULLETPROOF] bulletproofScenes called.');
  if (!Array.isArray(scenes)) {
    console.error('[5C][BULLETPROOF][ERR] Input is not an array, wrapping as single fallback scene.');
    return [{
      id: `scene-fallback-${uuid.v4()}`,
      texts: [typeof scenes === 'string' ? scenes : JSON.stringify(scenes)],
      isMegaScene: false,
      type: 'auto-wrap',
      origIndices: [0]
    }];
  }
  // Filter out any null/undefined and make sure each is a proper scene object
  const safe = scenes.map((scene, idx) => {
    if (!scene || typeof scene !== 'object' || !scene.texts) {
      console.warn(`[5C][BULLETPROOF][BUG] Scene at idx ${idx} is invalid. Wrapping as fallback.`);
      return {
        id: `scene${idx + 1}-fixwrap-${uuid.v4()}`,
        texts: [typeof scene === 'string' ? scene : String(scene)],
        isMegaScene: false,
        type: 'auto-wrap',
        origIndices: [idx]
      };
    }
    let safeTexts = Array.isArray(scene.texts) ? scene.texts.map(t => String(t || '')) : [String(scene.texts || '')];
    if (!safeTexts.length || !safeTexts[0]) {
      safeTexts = [''];
      console.warn(`[5C][BULLETPROOF][BUG] Scene ${scene.id || idx} had empty texts array. Setting to [''].`);
    }
    return { ...scene, texts: safeTexts };
  });
  if (!safe.length) {
    console.warn('[5C][BULLETPROOF][WARN] No valid scenes found. Returning generic fallback.');
    return [{
      id: `scene-fallback-empty-${uuid.v4()}`,
      texts: ['No scenes available.'],
      isMegaScene: false,
      type: 'auto-wrap',
      origIndices: [0]
    }];
  }
  console.log(`[5C][BULLETPROOF] ${safe.length} valid scenes returned.`);
  return safe;
}

// === Utility: Guess main subject from all scenes (stub for future AI upgrades) ===
function guessMainSubjectFromScenes(scenes) {
  console.log('[5C][SUBJECT] guessMainSubjectFromScenes called.');
  if (!Array.isArray(scenes) || !scenes.length) {
    console.warn('[5C][SUBJECT] No scenes to analyze.');
    return '';
  }
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
  if (!main) {
    console.warn('[5C][SUBJECT][WARN] Main subject guess was empty.');
  }
  console.log(`[5C][SUBJECT] Main subject guessed: "${main}" (appears ${max}x)`);
  return main;
}

// === Utility: Clean scene text (remove special chars, extra spaces, etc.) ===
function cleanSceneText(text) {
  if (!text) return '';
  let cleaned = text.replace(/\s+/g, ' ').replace(/[^\w\s.,?!-]/g, '').trim();
  console.log(`[5C][CLEAN] Cleaned scene text: "${cleaned}"`);
  return cleaned;
}

module.exports = {
  splitScriptToScenes,
  bulletproofScenes,
  guessMainSubjectFromScenes,
  cleanSceneText,
};
