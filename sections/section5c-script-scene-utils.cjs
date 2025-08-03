// ===========================================================
// SECTION 5C: SCRIPT & SCENE UTILITIES (PRO FIXED)
// Splits script into scenes, handles scene structure, utilities.
// HOOK, MEGA-SCENE, and VISUAL SUBJECT (GPT/AI-ready)
// Max logging every step, bulletproof output
// ===========================================================

const uuid = require('uuid'); // For scene IDs

console.log('[5C][INIT] Script & scene utilities loaded.');

// === Pro Helper: Make a viral summary/hook for the intro ===
function generateViralHookAndSummary(script, topic = '') {
  let lines = script.split('\n').map(line => line.trim()).filter(Boolean);
  let summaryLine = '';
  if (topic && lines.some(l => l.toLowerCase().includes(topic.toLowerCase()))) {
    summaryLine = lines.find(l => l.toLowerCase().includes(topic.toLowerCase()));
  } else {
    summaryLine = (lines[0] || '').replace(/like a[n]? [\w ]+/gi, '').trim();
  }
  if (!summaryLine || summaryLine.length < 8) {
    let bySentence = script.split(/[.?!]\s+/).map(s => s.trim()).filter(Boolean);
    summaryLine = bySentence[0] || lines[0] || script.trim();
  }
  if (!summaryLine) summaryLine = 'You won’t believe this!';
  console.log(`[5C][HOOK] Viral summary/hook generated: "${summaryLine}"`);
  return summaryLine;
}

// === Visual Subject Extraction (AI/GPT-ready) ===
function extractVisualSubject(line, mainTopic = '') {
  if (mainTopic && line.toLowerCase().includes(mainTopic.toLowerCase())) {
    return mainTopic;
  }
  const candidates = (line.match(/\b([A-Za-z]{4,})\b/g) || [])
    .filter(word => !['this','that','they','will','have','with','from','your','about','there','their','which','when','just'].includes(word.toLowerCase()));
  return candidates.length ? candidates[0] : line.trim().split(' ').slice(0,3).join(' ');
}

/**
 * Enhanced split:
 * - Scene 1: Strong hook/summary (from topic or first punchy line)
 * - Scene 2: Mega-scene (group next 2 lines into *one* scene, not two!)
 * - Scenes 3+: Each line becomes a normal scene.
 * Each scene: { id, texts: [str], isMegaScene: bool, type, origIndices, visualSubject }
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

  // Step 3: Remove the summary from the rest (prevent dupe)
  let restLines = rawLines.filter(l => l !== summaryLine && l.length > 4);
  if (restLines.length < 2) restLines = bySentences.filter(l => l !== summaryLine && l.length > 4);

  console.log(`[5C][SPLIT] Lines for scenes after hook/summary:`, JSON.stringify(restLines));

  // Step 4: Group into scenes (must return array of scene objects!)
  let scenes = [];
  const seenIds = new Set();

  // Main topic for scene matching (use topic or fallback to best guess)
  const mainTopic = topic && typeof topic === 'string' && topic.length > 1 ? topic : guessMainSubjectFromScenes(restLines);

  // Scene 1: Viral hook (always use main topic for matching)
  const hookId = `hookscene-1-${uuid.v4()}`;
  scenes.push({
    id: hookId,
    texts: [summaryLine],
    isMegaScene: false,
    type: 'hook-summary',
    origIndices: [0],
    visualSubject: mainTopic
  });
  seenIds.add(hookId);
  console.log(`[5C][HOOK] Created HOOK SCENE: "${summaryLine}" [ID: ${hookId}] visualSubject="${mainTopic}"`);

  // Scene 2: MEGA-SCENE (group next 2 lines into ONE scene!)
  if (restLines.length > 1) {
    // Fix: Combine [restLines[0], restLines[1]] into a single scene (never split).
    const megaId = `megascene-2-${uuid.v4()}`;
    const megaTexts = [restLines[0], restLines[1]];
    const megaSubject = extractVisualSubject(restLines[1], mainTopic); // Use the second line as visual anchor
    scenes.push({
      id: megaId,
      texts: megaTexts,
      isMegaScene: true,
      type: 'context-mega',
      origIndices: [1, 2],
      visualSubject: megaSubject
    });
    seenIds.add(megaId);
    console.log(`[5C][MEGA] Created MEGA-SCENE: "${megaTexts[0]}" / "${megaTexts[1]}" [ID: ${megaId}] visualSubject="${megaSubject}"`);

    // Scenes 3+ are normal (skip restLines[0] and restLines[1], already included above)
    for (let i = 2; i < restLines.length; ++i) {
      const sceneId = `scene${i + 1}-${uuid.v4()}`;
      if (seenIds.has(sceneId)) {
        console.warn(`[5C][SCENE][WARN] Duplicate scene ID generated at index ${i}. Regenerating...`);
      }
      seenIds.add(sceneId);
      const subject = extractVisualSubject(restLines[i], mainTopic);
      scenes.push({
        id: sceneId,
        texts: [restLines[i]],
        isMegaScene: false,
        type: 'normal',
        origIndices: [i + 1],
        visualSubject: subject
      });
      console.log(`[5C][SCENE] Created scene ${i + 1}: "${restLines[i]}" [ID: ${sceneId}] visualSubject="${subject}"`);
    }
  } else if (restLines.length === 1) {
    // Only one line left after hook: single normal scene
    const sceneId = `scene2-${uuid.v4()}`;
    const subject = extractVisualSubject(restLines[0], mainTopic);
    scenes.push({
      id: sceneId,
      texts: [restLines[0]],
      isMegaScene: false,
      type: 'single',
      origIndices: [1],
      visualSubject: subject
    });
    seenIds.add(sceneId);
    console.log(`[5C][SCENE] Only one context line, created single scene [ID: ${sceneId}] visualSubject="${subject}"`);
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
        origIndices: [idx],
        visualSubject: mainTopic
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
    // Ensure visualSubject present
    return { ...scene, texts: safeTexts, visualSubject: scene.visualSubject || mainTopic };
  });

  console.log(`[5C][SPLIT] Total scenes generated: ${finalScenes.length}`);
  finalScenes.forEach((scene, idx) => {
    console.log(`[5C][SCENES][${idx}] ID: ${scene.id}, Mega: ${!!scene.isMegaScene}, Type: ${scene.type}, Lines: ${scene.texts.length}, OrigIndices: ${scene.origIndices.join(',')}, visualSubject: "${scene.visualSubject}", Text: "${scene.texts.join(' / ')}"`);
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
      origIndices: [0],
      visualSubject: ''
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
        origIndices: [idx],
        visualSubject: ''
      };
    }
    let safeTexts = Array.isArray(scene.texts) ? scene.texts.map(t => String(t || '')) : [String(scene.texts || '')];
    if (!safeTexts.length || !safeTexts[0]) {
      safeTexts = [''];
      console.warn(`[5C][BULLETPROOF][BUG] Scene ${scene.id || idx} had empty texts array. Setting to [''].`);
    }
    return { ...scene, texts: safeTexts, visualSubject: scene.visualSubject || '' };
  });
  if (!safe.length) {
    console.warn('[5C][BULLETPROOF][WARN] No valid scenes found. Returning generic fallback.');
    return [{
      id: `scene-fallback-empty-${uuid.v4()}`,
      texts: ['No scenes available.'],
      isMegaScene: false,
      type: 'auto-wrap',
      origIndices: [0],
      visualSubject: ''
    }];
  }
  console.log(`[5C][BULLETPROOF] ${safe.length} valid scenes returned.`);
  return safe;
}

// === Utility: Guess main subject from all scenes (stub for future AI upgrades) ===
function guessMainSubjectFromScenes(lines) {
  console.log('[5C][SUBJECT] guessMainSubjectFromScenes called.');
  if (!Array.isArray(lines) || !lines.length) {
    console.warn('[5C][SUBJECT] No scenes/lines to analyze.');
    return '';
  }
  const allTexts = lines.flatMap(l => typeof l === 'string' ? l : '');
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
  extractVisualSubject // export for external GPT subject helpers
};
