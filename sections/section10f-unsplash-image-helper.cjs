// ==============================================================
// SECTION 10F: UNSPLASH IMAGE HELPER (Search & Download & Score)
// Searches Unsplash for the best-scoring, high-res image matching the subject.
// Downloads to local job folder, returns file path on success.
// MAX LOGGING, bulletproof, modular, NO DUPES, scores all matches
// Requires: UNSPLASH_ACCESS_KEY in env
// ==============================================================

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || '';

if (!UNSPLASH_ACCESS_KEY) {
  console.error('[10F][FATAL] UNSPLASH_ACCESS_KEY missing in env!');
}

console.log('[10F][INIT] Unsplash image helper loaded.');

// --- Clean string for safe filenames ---
function cleanForFilename(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}
function getKeywords(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/[\s\-]+/).filter(w => w.length > 2);
}
function majorWords(subject) {
  return (subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','of','and','in','on','with','to','is','for','at','by','as','a','an'].includes(w));
}
function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Strict subject presence: all subject words must be present in fields ---
function strictSubjectPresent(fields, subject) {
  const subjectWords = getKeywords(subject);
  if (!subjectWords.length) return false;
  return subjectWords.every(w => fields.includes(w));
}
function fuzzyMatch(fields, subject) {
  const words = majorWords(subject);
  return words.length && words.every(word => fields.includes(word));
}
function partialMatch(fields, subject) {
  const words = majorWords(subject);
  return words.some(word => fields.includes(word));
}

/**
 * Scoring function for Unsplash results.
 * Enforces strict > fuzzy > partial subject. Scores all matches!
 */
function scoreUnsplashImage(result, subject, usedClips = []) {
  let score = 0;
  const cleanedSubject = subject.toLowerCase();
  const subjectWords = getKeywords(subject);

  const desc = (
    (result.alt_description || '') + ' ' +
    (result.description || '') + ' ' +
    (result.user?.name || '') + ' ' +
    ((result.tags || []).map(t => t.title || t).join(' '))
  ).toLowerCase();

  // Strict subject
  if (strictSubjectPresent(desc, subject)) score += 100;
  else if (fuzzyMatch(desc, subject)) score += 30;
  else if (partialMatch(desc, subject)) score += 10;

  // Phrase match
  if (desc.includes(cleanedSubject) && cleanedSubject.length > 2) score += 55;

  // All words present
  if (subjectWords.every(w => desc.includes(w)) && subjectWords.length > 1) score += 28;

  // Each word present (small boost)
  subjectWords.forEach(word => { if (desc.includes(word)) score += 5; });

  // Prefer portrait/HD
  if (result.width >= 1000) score += 7;
  if (result.height >= 1500) score += 8;
  if (result.height > result.width) score += 10;

  // Bonus for popularity
  if (result.likes && result.likes > 100) score += 4;

  // Penalize used
  if (usedClips && usedClips.some(u => result.urls?.full && u.includes(result.urls.full))) score -= 100;

  // Recent images (higher ID, slight bump)
  if (result.id && Number(result.id) > 1000000) score += 1;

  // Shorter alt description = more direct
  if ((result.alt_description || '').length < 60 && (result.alt_description || '').length > 10) score += 2;

  return score;
}

/**
 * Search Unsplash API for the best-scoring image matching subject and download it.
 * @param {string} subject - The search phrase (topic, scene, keyword)
 * @param {string} workDir - Directory to save downloaded image
 * @param {number} sceneIdx - Scene index (for filename uniqueness)
 * @param {string} jobId - For logging
 * @param {Array<string>} usedClips - List of used image URLs to prevent dupes
 * @returns {Promise<string|null>} Local file path if successful, else null
 */
async function findUnsplashImageForScene(subject, workDir, sceneIdx = 0, jobId = 'nojob', usedClips = []) {
  if (!UNSPLASH_ACCESS_KEY) {
    console.error('[10F][NO_API_KEY][%s] Unsplash API key missing.', jobId);
    return null;
  }
  if (!subject || !workDir) {
    console.error('[10F][INVALID_ARGS][%s] Missing subject or workDir.', jobId);
    return null;
  }

  const query = encodeURIComponent(subject);
  const apiUrl = `https://api.unsplash.com/search/photos?query=${query}&orientation=portrait&per_page=10&client_id=${UNSPLASH_ACCESS_KEY}`;

  console.log(`[10F][REQ][${jobId}] Searching Unsplash: "${subject}"`);

  let json;
  try {
    const response = await axios.get(apiUrl, { timeout: 15000 });
    json = response.data;
  } catch (err) {
    console.error(`[10F][API_ERR][${jobId}] Unsplash API error:`, err?.response?.data || err.message || err);
    return null;
  }

  if (!json || !Array.isArray(json.results) || !json.results.length) {
    console.warn(`[10F][NO_RESULT][${jobId}] No Unsplash image found for: "${subject}"`);
    return null;
  }

  // Score all results, skip used, STRICT: only candidates with positive score
  let scored = json.results.map(result => ({
    result,
    score: scoreUnsplashImage(result, subject, usedClips),
    url: result.urls.full
  })).filter(item => item.score >= 0 && item.url && !usedClips.some(u => u.includes(item.url)));

  scored.sort((a, b) => b.score - a.score);

  // Log top candidates (always show if any)
  scored.slice(0, 5).forEach((s, i) => {
    console.log(`[10F][CANDIDATE][${jobId}] [${i + 1}] url=${s.url} | score=${s.score} | desc="${s.result.alt_description || ''}"`);
  });

  const best = scored[0];
  if (!best || !best.url || best.score < 15) {
    console.warn(`[10F][NO_GOOD][${jobId}] No strong Unsplash match for "${subject}" (best score: ${best ? best.score : 'none'})`);
    return null;
  }

  // Download image to local job dir
  const filename = `unsplash_${cleanForFilename(subject)}_${sceneIdx}.jpg`;
  const outPath = path.join(workDir, filename);

  // If file already exists and is >10KB, skip download
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10 * 1024) {
    console.log(`[10F][CACHE][${jobId}] HIT: ${outPath}`);
    return outPath;
  }

  try {
    const response = await axios({
      url: best.url,
      method: 'GET',
      responseType: 'stream',
      timeout: 15000
    });

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(outPath);
      response.data.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', err => {
        fs.unlink(outPath, () => reject(err));
      });
    });

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10 * 1024) {
      console.log(`[10F][DOWNLOAD][${jobId}] OK: Saved Unsplash image to ${outPath}`);
      return outPath;
    } else {
      throw new Error('Downloaded file is too small or missing');
    }
  } catch (err) {
    console.error(`[10F][DOWNLOAD_ERR][${jobId}] Failed to download Unsplash image:`, err);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    return null;
  }
}

module.exports = { findUnsplashImageForScene };
