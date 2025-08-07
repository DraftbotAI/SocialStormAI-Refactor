// ===========================================================
// SECTION 5C: SCRIPT & SCENE UTILITIES (AI-Optimized, Bulletproof, Mega-Scene Safe)
// Splits script into scenes, extracts main topics, and bulletproofs output
// MAX LOGGING EVERY STEP. Never returns repeated visualSubjects unless unavoidable.
// Enhanced: Viral summary/hook-first, mega-scene, bulletproof dedupe, AI subject extraction
// 2024-08: Ultra strict subject pass-through for 5D, compatible with new pro helpers
// ===========================================================

const uuid = require('uuid');

console.log('[5C][INIT] Script & scene utilities loaded.');

// === Pro Helper: Always generates a viral summary/hook as scene 1 ===
function generateViralHookAndSummary(script, topic = '') {
  let lines = script.split('\n').map(line => line.trim()).filter(Boolean);
  let summaryLine = lines[0] || '';
  if (
    !summaryLine ||
    summaryLine.length < 8 ||
    (topic && !summaryLine.toLowerCase().includes(topic.toLowerCase()))
  ) {
    summaryLine = topic
      ? `Here’s why ${topic.replace(/^(the|a|an)\s+/i, '').trim()} is blowing up right now.`
      : 'You won’t believe this!';
    console.warn(`[5C][HOOK][FIX] Hook missing/weak, auto-generated: "${summaryLine}"`);
  }
  console.log(`[5C][HOOK] Viral summary/hook extracted: "${summaryLine}"`);
  return summaryLine;
}

// === Visual Subject Extraction (strict, but now only for fallback/defense) ===
function extractVisualSubject(line, mainTopic = '') {
  if (!line && mainTopic) return mainTopic;
  if (
    mainTopic &&
    line &&
    line.toLowerCase().includes(mainTopic.toLowerCase()) &&
    mainTopic.length < 25
  ) {
    return mainTopic;
  }
  // Remove junk, keep only strong nouns/caps
  const stopwords = [
    'the','a','an','and','or','but','if','of','at','by','for','with','about','into','on','after',
    'in','to','from','up','down','over','under','again','further','then','once','there','their','they',
    'his','her','she','he','him','hers','its','it','is','are','was','were','be','been','being',
    'have','has','had','having','do','does','did','doing','as','such','just','which','when','that','this','your'
  ];
  const tokens = (line || '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(tok => tok && !stopwords.includes(tok.toLowerCase()) && tok.length > 2);

  // Capital word (landmarks, brands)
  const caps = tokens.find(w => /^[A-Z][a-z]+/.test(w));
  if (caps) return caps;
  if (tokens.length >= 3) return tokens.slice(0, 3).join(' ');
  if (tokens.length === 2) return tokens.join(' ');
  if (tokens.length === 1) return tokens[0];
  return mainTopic || '';
}

// === Main: Script → Scenes Array (w/ bulletproof deduplication & pro subject handling) ===
function splitScriptToScenes(script, topic = '') {
  console.log('[5C][SPLIT] splitScriptToScenes called.');

  if (!script || typeof script !== 'string') {
    console.error('[5C][ERR] No script provided or script not a string.');
    return [];
  }
  let rawLines = script.split('\n').map(line => line.trim()).filter(Boolean);

  // Always extract hook/summary from line 1 (already enforced in Section 4)
  const summaryLine = generateViralHookAndSummary(script, topic);

  // Keep original order for index tracking
  let restLines = rawLines.filter(l => l !== summaryLine && l.length > 4);

  // Guess main topic if not provided
  const mainTopic = topic && typeof topic === 'string' && topic.length > 1
    ? topic
    : guessMainSubjectFromScenes(restLines);

  const scenes = [];
  const seenSubjects = new Set();
  const seenIds = new Set();

  // === Scene 1: HOOK ===
  const hookId = `hookscene-1-${uuid.v4()}`;
  // Visual subject is now always the mainTopic for the hook (ensures clip anchoring)
  const hookVisual = mainTopic || extractVisualSubject(summaryLine, mainTopic);
  scenes.push({
    id: hookId,
    texts: [summaryLine],
    isMegaScene: false,
    type: 'hook-summary',
    origIndices: [0],
    visualSubject: hookVisual,
  });
  seenSubjects.add(hookVisual.toLowerCase());
  seenIds.add(hookId);
  console.log(`[5C][HOOK] Created HOOK SCENE: "${summaryLine}" [ID: ${hookId}] visualSubject="${hookVisual}"`);

  // === Scene 2: MEGA-SCENE (combine next 2 lines, if possible) ===
  if (restLines.length > 1) {
    const megaId = `megascene-2-${uuid.v4()}`;
    const megaTexts = [restLines[0], restLines[1]];

    // Use the *more subject-rich* of the first two context lines (AI helpers will refine in 5D)
    let megaSubject = extractVisualSubject(restLines[1], mainTopic);
    if (seenSubjects.has(megaSubject.toLowerCase())) {
      megaSubject = extractVisualSubject(restLines[0], mainTopic) || megaSubject;
    }
    // Extra defense: If both are vague, fallback to mainTopic
    if (!megaSubject || megaSubject.length < 2 || megaSubject === hookVisual) {
      megaSubject = mainTopic;
    }

    scenes.push({
      id: megaId,
      texts: megaTexts,
      isMegaScene: true,
      type: 'context-mega',
      origIndices: [1, 2],
      visualSubject: megaSubject,
    });
    seenSubjects.add(megaSubject.toLowerCase());
    seenIds.add(megaId);
    console.log(`[5C][MEGA] Created MEGA-SCENE: "${megaTexts[0]}" / "${megaTexts[1]}" [ID: ${megaId}] visualSubject="${megaSubject}"`);

    // === Scenes 3+: Each is normal (skip [0] and [1]) ===
    for (let i = 2; i < restLines.length; ++i) {
      const sceneId = `scene${i + 1}-${uuid.v4()}`;
      let subject = extractVisualSubject(restLines[i], mainTopic);

      // Bulletproof dedupe: if this visualSubject is already used, pick a unique fallback
      let altSubject = subject;
      let tries = 0;
      while (seenSubjects.has(altSubject.toLowerCase()) && tries < 3) {
        // Try fallback: look at next word(s) or use line before/after or mainTopic
        altSubject =
          extractVisualSubject(
            restLines[i + 1] || restLines[i - 1] || '', mainTopic
          ) || mainTopic;
        tries++;
      }
      subject = altSubject;
      if (!subject || subject.length < 2) subject = mainTopic;

      scenes.push({
        id: sceneId,
        texts: [restLines[i]],
        isMegaScene: false,
        type: 'normal',
        origIndices: [i + 1],
        visualSubject: subject,
      });
      seenSubjects.add(subject.toLowerCase());
      seenIds.add(sceneId);
      console.log(`[5C][SCENE] Created scene ${i + 1}: "${restLines[i]}" [ID: ${sceneId}] visualSubject="${subject}"`);
    }
  } else if (restLines.length === 1) {
    // Only one line left after hook, make it a normal scene
    const sceneId = `scene2-${uuid.v4()}`;
    const subject = extractVisualSubject(restLines[0], mainTopic) || mainTopic;
    scenes.push({
      id: sceneId,
      texts: [restLines[0]],
      isMegaScene: false,
      type: 'single',
      origIndices: [1],
      visualSubject: subject,
    });
    seenSubjects.add(subject.toLowerCase());
    seenIds.add(sceneId);
    console.log(`[5C][SCENE] Only one context line, created single scene [ID: ${sceneId}] visualSubject="${subject}"`);
  }

  // Bulletproof: every scene is valid, texts always array, subject always present
  const finalScenes = scenes.map((scene, idx) => {
    if (!scene || typeof scene !== 'object') {
      console.error(`[5C][DEFENSE][BUG] Scene at idx ${idx} is not an object! Wrapping as fallback.`);
      return {
        id: `scene${idx + 1}-fixwrap-${uuid.v4()}`,
        texts: [typeof scene === 'string' ? scene : String(scene)],
        isMegaScene: false,
        type: 'auto-wrap',
        origIndices: [idx],
        visualSubject: mainTopic,
      };
    }
    let safeTexts = Array.isArray(scene.texts)
      ? scene.texts.map(t => String(t || ''))
      : [String(scene.texts || '')];
    if (!safeTexts.length || !safeTexts[0]) {
      safeTexts = [''];
      console.warn(`[5C][DEFENSE][BUG] Scene ${scene.id || idx} had empty texts array. Setting to [''].`);
    }
    let subject = scene.visualSubject;
    if (!subject || typeof subject !== 'string' || subject.length > 40) {
      subject = extractVisualSubject(safeTexts[0], mainTopic) || mainTopic;
    }
    return { ...scene, texts: safeTexts, visualSubject: subject || mainTopic };
  });

  console.log(`[5C][SPLIT] Total scenes generated: ${finalScenes.length}`);
  finalScenes.forEach((scene, idx) => {
    console.log(
      `[5C][SCENES][${idx}] ID: ${scene.id}, Mega: ${!!scene.isMegaScene}, Type: ${scene.type}, Lines: ${scene.texts.length}, OrigIndices: ${scene.origIndices.join(',')}, visualSubject: "${scene.visualSubject}", Text: "${scene.texts.join(' / ')}"`
    );
  });

  return finalScenes;
}

// === BULLETPROOF DEFENSE: Always return array of valid scenes ===
function bulletproofScenes(scenes) {
  console.log('[5C][BULLETPROOF] bulletproofScenes called.');
  if (!Array.isArray(scenes)) {
    console.error('[5C][BULLETPROOF][ERR] Input is not an array, wrapping as single fallback scene.');
    return [
      {
        id: `scene-fallback-${uuid.v4()}`,
        texts: [typeof scenes === 'string' ? scenes : JSON.stringify(scenes)],
        isMegaScene: false,
        type: 'auto-wrap',
        origIndices: [0],
        visualSubject: '',
      },
    ];
  }
  const safe = scenes.map((scene, idx) => {
    if (!scene || typeof scene !== 'object' || !scene.texts) {
      console.warn(`[5C][BULLETPROOF][BUG] Scene at idx ${idx} is invalid. Wrapping as fallback.`);
      return {
        id: `scene${idx + 1}-fixwrap-${uuid.v4()}`,
        texts: [typeof scene === 'string' ? scene : String(scene)],
        isMegaScene: false,
        type: 'auto-wrap',
        origIndices: [idx],
        visualSubject: '',
      };
    }
    let safeTexts = Array.isArray(scene.texts)
      ? scene.texts.map(t => String(t || ''))
      : [String(scene.texts || '')];
    if (!safeTexts.length || !safeTexts[0]) {
      safeTexts = [''];
      console.warn(`[5C][BULLETPROOF][BUG] Scene ${scene.id || idx} had empty texts array. Setting to [''].`);
    }
    let subject = scene.visualSubject;
    if (!subject || typeof subject !== 'string' || subject.length > 40) {
      subject = extractVisualSubject(safeTexts[0], '');
    }
    return { ...scene, texts: safeTexts, visualSubject: subject || '' };
  });
  if (!safe.length) {
    console.warn('[5C][BULLETPROOF][WARN] No valid scenes found. Returning generic fallback.');
    return [
      {
        id: `scene-fallback-empty-${uuid.v4()}`,
        texts: ['No scenes available.'],
        isMegaScene: false,
        type: 'auto-wrap',
        origIndices: [0],
        visualSubject: '',
      },
    ];
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
  const allTexts = lines.flatMap(l => (typeof l === 'string' ? l : ''));
  const freq = {};
  for (const text of allTexts) {
    const words = (text || '')
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3);
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
  extractVisualSubject,
};
