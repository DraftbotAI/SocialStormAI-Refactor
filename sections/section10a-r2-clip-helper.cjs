// ===========================================================
// SECTION 10A: R2 CLIP HELPER (Cloudflare R2) - UPGRADED 2025-08
// Exports: findR2ClipForScene (used by 5D) + getAllFiles (for scans)
// MAX LOGGING EVERY STEP, Video-Preferred, Anti-Dupe, Multi-Angle
// Uses universal scoreSceneCandidate from 10G (topic-aware scoring)
// Never silent-fails. Smart filters + caching for speed.
// STRICT: Excludes composed outputs (final/hook/mega/jobs) from candidates.
// DEDUPE: Blocks by full key, basename, and stem (name without extension).
// ===========================================================

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { scoreSceneCandidate } = require('./section10g-scene-scoring-helper.cjs');

// --- ENV + Client bootstrap ---
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_KEY = process.env.R2_KEY || process.env.R2_ACCESS_KEY_ID;
const R2_SECRET = process.env.R2_SECRET || process.env.R2_SECRET_ACCESS_KEY;

if (!R2_LIBRARY_BUCKET || !R2_ENDPOINT || !R2_KEY || !R2_SECRET) {
  console.error('[10A][FATAL] Missing one or more R2 env variables!', {
    has_BUCKET: !!R2_LIBRARY_BUCKET,
    has_ENDPOINT: !!R2_ENDPOINT,
    has_KEY: !!R2_KEY,
    has_SECRET: !!R2_SECRET
  });
  throw new Error('[10A][FATAL] Missing R2 env vars!');
}

const s3Client = new S3Client({
  endpoint: R2_ENDPOINT,
  region: 'auto',
  credentials: {
    accessKeyId: R2_KEY,
    secretAccessKey: R2_SECRET,
  }
});

console.log('[10A][INIT] R2 clip helper (video-first, max logs, multi-angle, cached listing) loaded.');

// ===========================================================
// INTERNAL CONFIG
// ===========================================================
const VIDEO_EXTS = new Set(['.mp4']);            // Pipeline expects mp4
const MIN_BYTES = 2 * 1024;                      // Sanity clip size
const LIST_CACHE_TTL_MS = 60 * 1000;             // 60s cache for list calls
const MAX_LIST_KEYS = 50000;                     // Hard cap to prevent runaway scans
const PREFILTER_LIMIT = 5000;                    // Limit scoring set
const TOKEN_PREFILTER_MAX = 8000;                // safety bound for token prefilter
const PREFER_RECENT = (process.env.R2_PREFER_RECENT || '1') === '1';

// Exclude *composed outputs* and any cached concat artifacts from being used as source clips.
const EXCLUDE_PATTERNS = [
  '/jobs/',                // any job artifacts
  '/final/',               // final folders
  'final-with-outro',
  'with-music',
  'concat-',
  'hookmux',
  'megamux',
  '-bp-',                  // bulletproofed outputs
  '-vol',                  // volume-adjusted outro
  '/thumbnails/',
  '/thumbs/',
];

// ===========================================================
// SIMPLE UTILS
// ===========================================================
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function tokenize(str) {
  return normalize(str).split('_').filter(Boolean);
}

function isMp4Key(key) {
  return VIDEO_EXTS.has(path.extname(String(key)).toLowerCase());
}

function keyStem(key) {
  const base = path.basename(key);
  return base.replace(/\.[^.]+$/, ''); // remove extension
}

function looksUsed(key, usedClips = []) {
  if (!key) return false;
  const base = path.basename(key);
  const stem = keyStem(key);
  return usedClips?.some(u => {
    const uStr = String(u || '');
    const uBase = path.basename(uStr);
    const uStem = keyStem(uStr);
    return (
      uStr === key ||
      uStr === base ||
      uStr === stem ||
      key.endsWith(uStr) ||
      base === uBase ||
      stem === uStem
    );
  });
}

function isValidLocalFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const sz = fs.statSync(filePath).size;
    return sz >= MIN_BYTES;
  } catch {
    return false;
  }
}

function isExcludedKey(key) {
  const k = String(key).toLowerCase();
  return EXCLUDE_PATTERNS.some(p => k.includes(String(p).toLowerCase()));
}

function hasCategoryPrefix(key = '', categoryFolder = '') {
  if (!categoryFolder) return true;
  const k = String(key).toLowerCase();
  const c = String(categoryFolder).replace(/^\/+/, '').toLowerCase();
  return k.includes(`/${c}/`) || k.startsWith(`${c}/`);
}

// ===========================================================
// LISTING WITH CACHING
// ===========================================================
let _listCache = {
  when: 0,
  // objs: array of {Key, Size?, LastModified?}
  objs: /** @type {{Key: string, Size?: number, LastModified?: Date}[]} */ ([]),
};

async function listAllObjectsInR2(prefix = '', jobId = '') {
  const now = Date.now();
  if (now - _listCache.when < LIST_CACHE_TTL_MS && _listCache.objs?.length) {
    console.log(`[10A][R2][${jobId}] Using cached listing: ${_listCache.objs.length} objects.`);
    return _listCache.objs;
  }

  let objs = [];
  let continuationToken;
  let round = 0;

  try {
    do {
      round++;
      const cmd = new ListObjectsV2Command({
        Bucket: R2_LIBRARY_BUCKET,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken
      });
      const resp = await s3Client.send(cmd);
      const part = (resp?.Contents || []).map(o => ({
        Key: o.Key,
        Size: o.Size,
        LastModified: o.LastModified
      })).filter(x => !!x.Key);

      objs.push(...part);
      if (objs.length > MAX_LIST_KEYS) {
        console.warn(`[10A][R2][${jobId}] List exceeded MAX_LIST_KEYS=${MAX_LIST_KEYS}, truncating.`);
        objs = objs.slice(0, MAX_LIST_KEYS);
        break;
      }
      continuationToken = resp?.NextContinuationToken;
      console.log(`[10A][R2][${jobId}] Listing round ${round} — running total: ${objs.length}`);
    } while (continuationToken);

    _listCache = { when: now, objs };
    console.log(`[10A][R2][${jobId}] Listed ${objs.length} objects from R2.`);
    return objs;
  } catch (err) {
    console.error(`[10A][R2][${jobId}][ERR] List error:`, err);
    return [];
  }
}

async function listAllFilesInR2(prefix = '', jobId = '') {
  const objs = await listAllObjectsInR2(prefix, jobId);
  return objs.map(o => o.Key).filter(Boolean);
}

// ===========================================================
// SUBJECT / PHRASE EXTRACTION (accepts flexible input shapes)
// ===========================================================
function extractSubjectAndPhrases(scene) {
  if (typeof scene === 'string') return { subject: scene, matchPhrases: [] };
  if (Array.isArray(scene)) {
    const strItems = scene
      .map(x => typeof x === 'string' ? x : (x?.subject || ''))
      .filter(Boolean);
    return {
      subject: strItems[0] || '',
      matchPhrases: strItems.slice(1)
    };
  }
  if (scene && typeof scene === 'object') {
    const subject =
      scene.subject ||
      scene.main ||
      (scene.visual && scene.visual.subject) ||
      '';
    let matchPhrases = [];
    if (Array.isArray(scene.matchPhrases)) matchPhrases = scene.matchPhrases;
    else if (Array.isArray(scene.tokens)) matchPhrases = scene.tokens;
    return { subject, matchPhrases };
  }
  return { subject: '', matchPhrases: [] };
}

// ===========================================================
// DOWNLOAD + VALIDATE (with simple retry)
// ===========================================================
async function downloadAndValidate(r2Key, workDir, sceneIdx, jobId, usedClips) {
  const unique = uuidv4();
  const outPath = path.join(workDir, `scene${sceneIdx + 1}-r2-${unique}.mp4`);

  if (isValidLocalFile(outPath)) {
    console.log(`[10A][R2][${jobId}] File already downloaded: ${outPath}`);
    return outPath;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[10A][R2][${jobId}] Downloading R2 clip (attempt ${attempt}): ${r2Key} -> ${outPath}`);
      const getCmd = new GetObjectCommand({ Bucket: R2_LIBRARY_BUCKET, Key: r2Key });
      const resp = await s3Client.send(getCmd);

      await new Promise((resolve, reject) => {
        const stream = resp.Body;
        const fileStream = fs.createWriteStream(outPath);
        stream.pipe(fileStream);
        stream.on('error', (err) => {
          console.error(`[10A][R2][${jobId}][ERR] Stream error during download:`, err);
          reject(err);
        });
        fileStream.on('finish', resolve);
        fileStream.on('error', (err) => {
          console.error(`[10A][R2][${jobId}][ERR] Write error during download:`, err);
          reject(err);
        });
      });

      if (!isValidLocalFile(outPath)) {
        console.warn(`[10A][R2][${jobId}] Downloaded file is invalid/broken: ${outPath}`);
        continue;
      }
      usedClips?.push(r2Key);
      return outPath;
    } catch (err) {
      console.error(`[10A][R2][${jobId}][ERR] Download attempt ${attempt} failed:`, err?.message || err);
    }
  }

  console.warn(`[10A][R2][${jobId}] Giving up on download for: ${r2Key}`);
  return null;
}

// ===========================================================
// CATEGORY INFERENCE FROM KEY (folder naming heuristic)
// ===========================================================
function inferCategoryFromKey(key = '') {
  const k = String(key);
  const cats = [
    'lore_history_mystery_horror',
    'sports_fitness',
    'cars_vehicles',
    'animals_primates',
    'food_cooking',
    'health_wellness',
    'holidays_events',
    'human_emotion_social',
    'kids_family',
    'love_relationships',
    'money_business_success',
    'motivation_success',
    'music_dance',
    'science_nature',
    'technology_innovation',
    'travel_adventure',
    'viral_trendy_content',
    'misc'
  ];
  const found = cats.find(c => k.includes(`/${c}/`) || k.startsWith(`${c}/`) || k.includes(`/${c}/jobs/`));
  return found || 'misc';
}

// ===========================================================
// MAIN MATCHER (VIDEO-FIRST, STRICT FILTERS)
// ===========================================================
async function findR2ClipForScene(scene, workDir, sceneIdx = 0, jobId = '', usedClips = []) {
  const { subject, matchPhrases } = extractSubjectAndPhrases(scene);
  if (!subject || typeof subject !== 'string' || subject.length < 2) {
    console.error(`[10A][R2][${jobId}] No valid subject for R2 lookup! Input:`, scene);
    return null;
  }

  const normalizedSubject = normalize(subject);
  console.log(`[10A][R2][${jobId}] findR2ClipForScene | subject="${subject}" (norm="${normalizedSubject}") | sceneIdx=${sceneIdx} | usedClips=${JSON.stringify(usedClips)}`);

  try {
    // 1) Pull all objects (cached 60s) then keep only mp4 not used and not excluded
    let objs = await listAllObjectsInR2('', jobId);
    if (!objs.length) {
      console.warn(`[10A][R2][${jobId}][WARN] No objects found in R2 bucket!`);
      return null;
    }

    let mp4Objs = objs.filter(o => isMp4Key(o.Key));
    if (!mp4Objs.length) {
      console.warn(`[10A][R2][${jobId}] No .mp4 objects found in R2 bucket!`);
      return null;
    }

    // Exclude composed outputs and job artifacts
    mp4Objs = mp4Objs.filter(o => !isExcludedKey(o.Key));
    if (!mp4Objs.length) {
      console.warn(`[10A][R2][${jobId}] All mp4 objects are excluded by pattern filters.`);
      return null;
    }

    // Filter out used (by key, basename and stem)
    mp4Objs = mp4Objs.filter(o => !looksUsed(o.Key, usedClips));
    if (!mp4Objs.length) {
      console.warn(`[10A][R2][${jobId}] After dedupe, no mp4 candidates remain.`);
      return null;
    }

    // 2) Optional recent-first bias only as *secondary* tie-breaker
    if (PREFER_RECENT) {
      mp4Objs.sort((a, b) => {
        const ta = new Date(a.LastModified || 0).getTime();
        const tb = new Date(b.LastModified || 0).getTime();
        return tb - ta; // newest first
      });
    }

    // 3) Token prefilter to reduce heavy scoring load (keeps subject-related only)
    const subjTokens = tokenize(subject);
    const phraseTokens = (matchPhrases || []).flatMap(tokenize);
    const allTokens = [...new Set([...subjTokens, ...phraseTokens])];

    let prefiltered = mp4Objs;
    if (allTokens.length) {
      const tokenSet = new Set(allTokens);
      prefiltered = mp4Objs.filter(o => {
        const base = normalize(path.basename(o.Key, path.extname(o.Key)));
        const baseTokens = new Set(tokenize(base));
        // keep if any token overlaps OR filename contains normalizedSubject
        const overlap = [...tokenSet].some(t => baseTokens.has(t));
        const containsSubject = base.includes(normalizedSubject);
        return overlap || containsSubject;
      });
      console.log(`[10A][R2][${jobId}] Token prefilter: ${prefiltered.length}/${mp4Objs.length} retained (tokens=${[...tokenSet].join(',') || 'none'})`);
    }

    // safety bounds
    if (prefiltered.length > TOKEN_PREFILTER_MAX) {
      prefiltered = prefiltered.slice(0, TOKEN_PREFILTER_MAX);
      console.log(`[10A][R2][${jobId}] Prefilter trimmed to ${TOKEN_PREFILTER_MAX} for safety.`);
    }

    // If prefiltering is too aggressive and we lost everything, fall back to a capped recent set
    if (!prefiltered.length) {
      prefiltered = mp4Objs.slice(0, PREFILTER_LIMIT);
      console.log(`[10A][R2][${jobId}] Prefilter empty — falling back to top ${prefiltered.length} recent mp4s.`);
    } else if (prefiltered.length > PREFILTER_LIMIT) {
      prefiltered = prefiltered.slice(0, PREFILTER_LIMIT);
      console.log(`[10A][R2][${jobId}] Prefilter too large — capped to ${PREFILTER_LIMIT} for scoring.`);
    }

    // 4) Build candidates + score (use 10G)
    const keywords = [subject, ...(matchPhrases || [])];
    const candidates = prefiltered.map(o => {
      const base = path.basename(o.Key, '.mp4');
      // topic inferred as first meaningful token, remainder is "angle"
      const parts = base.split(/[_-]+/).filter(Boolean);
      const topicPart = parts[0] || '';
      const angle = parts.slice(1).join('_');

      return {
        type: 'video',
        provider: 'r2',
        source: 'r2',
        path: o.Key,
        filename: path.basename(o.Key),
        subject,
        matchPhrases: keywords,
        category: inferCategoryFromKey(o.Key),
        topic: normalize(topicPart),
        angle: normalize(angle),
        scene,
        isVideo: true,
        lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : null,
        size: o.Size || null,
      };
    });

    // Hard preference bonus if filename stem contains the full normalizedSubject
    const normalizedSubjectStem = normalize(subject);
    let scored = candidates.map(c => {
      const stem = normalize(c.filename.replace(/\.mp4$/i, ''));
      const containsFull = stem.includes(normalizedSubjectStem);
      const subjectBonus = containsFull ? 12 : 0; // small nudge toward literal matches
      return {
        ...c,
        score: scoreSceneCandidate(c, c.scene, usedClips, /*realVideoExists=*/true) + subjectBonus
      };
    });

    if (!scored.length) {
      console.log(`[10A][R2][${jobId}][CANDIDATE] No candidates to score.`);
      return null;
    }

    // Log top 12 scored
    scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .forEach((s, i) => {
        console.log(`[10A][R2][${jobId}][CANDIDATE][${i + 1}] ${s.path} | score=${s.score} | topic=${s.topic} | angle=${s.angle} | lm=${s.lastModified}`);
      });

    // 5) Prefer multi-angle if topic equals normalizedSubject
    const targetTopic = normalize(subject);
    const multiAngle = scored.filter(s => s.topic && s.topic === targetTopic);
    if (multiAngle.length) {
      multiAngle.sort((a, b) => b.score - a.score || (PREFER_RECENT
        ? (new Date(b.lastModified || 0) - new Date(a.lastModified || 0))
        : 0));
      const bestAngle = multiAngle[0];
      if (bestAngle && bestAngle.score >= 35 && !looksUsed(bestAngle.path, usedClips)) {
        console.log(`[10A][R2][${jobId}][MULTIANGLE][SELECTED] ${bestAngle.path} | score=${bestAngle.score}`);
        const out = await downloadAndValidate(bestAngle.path, workDir, sceneIdx, jobId, usedClips);
        return out || null;
      }
    }

    // 6) If there is a strong match (>=80) ignore bottom junk (<20)
    const maxScore = Math.max(...scored.map(s => s.score));
    const hasGood = maxScore >= 80;
    let eligible = scored;
    if (hasGood) {
      const before = eligible.length;
      eligible = eligible.filter(s => s.score >= 20);
      const blocked = before - eligible.length;
      if (blocked > 0) {
        console.log(`[10A][R2][${jobId}] [FILTER] Blocked ${blocked} weak candidates (<20) since strong matches exist.`);
      }
    }

    // 7) Sort by score (tie-breaker: newer first if available)
    eligible.sort((a, b) => {
      const ds = b.score - a.score;
      if (ds !== 0) return ds;
      if (PREFER_RECENT) {
        const ta = new Date(a.lastModified || 0).getTime();
        const tb = new Date(b.lastModified || 0).getTime();
        return tb - ta;
      }
      return 0;
    });

    // 8) Pick best that isn't used (by key/basename/stem)
    let best = eligible.find(e => !looksUsed(e.path, usedClips));
    if (!best) {
      console.warn(`[10A][R2][${jobId}] All eligible were already used — allowing lowest-risk fallback.`);
      best = eligible[0];
    }
    if (!best) {
      console.warn(`[10A][R2][${jobId}] [FALLBACK][FATAL] No suitable candidates for subject "${subject}".`);
      return null;
    }

    // Decision logs
    if (best.score >= 100) {
      console.log(`[10A][R2][${jobId}][SELECTED][STRICT] ${best.path} | score=${best.score}`);
    } else if (best.score >= 80) {
      console.log(`[10A][R2][${jobId}][SELECTED][STRONG] ${best.path} | score=${best.score}`);
    } else if (best.score >= 35) {
      console.log(`[10A][R2][${jobId}][SELECTED][FUZZY] ${best.path} | score=${best.score}`);
    } else if (best.score >= 20) {
      console.log(`[10A][R2][${jobId}][SELECTED][PARTIAL] ${best.path} | score=${best.score}`);
    } else {
      console.warn(`[10A][R2][${jobId}][FALLBACK][LAST_RESORT] Using best available: ${best.path} | score=${best.score}`);
    }

    // 9) Download and return local path
    const out = await downloadAndValidate(best.path, workDir, sceneIdx, jobId, usedClips);
    return out || null;

  } catch (err) {
    console.error(`[10A][R2][${jobId}][ERR] findR2ClipForScene failed:`, err);
    return null;
  }
}

// ===========================================================
// STATIC EXPORT: getAllFiles (used by 5D for scans)
// Returns an array of mp4 keys (strings), cached for 60s.
// Accepts optional subject and categoryFolder to prefilter server-side.
// ===========================================================
findR2ClipForScene.getAllFiles = async function(subject = null, categoryFolder = null) {
  try {
    const objs = await listAllObjectsInR2('', 'STATIC');
    let mp4s = objs
      .map(o => o.Key)
      .filter(k => isMp4Key(k))
      .filter(k => !isExcludedKey(k)); // do not expose composed outputs to scanners

    if (categoryFolder) {
      mp4s = mp4s.filter(k => hasCategoryPrefix(k, categoryFolder));
    }

    if (subject) {
      const normSubj = normalize(subject);
      const tokens = new Set(tokenize(subject));
      mp4s = mp4s.filter(k => {
        const base = normalize(path.basename(k, path.extname(k)));
        const baseTokens = new Set(tokenize(base));
        const overlap = [...tokens].some(t => baseTokens.has(t));
        const containsSubject = base.includes(normSubj);
        return overlap || containsSubject;
      });
    }

    console.log(`[10A][STATIC] getAllFiles: Found ${mp4s.length} mp4s in R2 (cached=${Date.now() - _listCache.when < LIST_CACHE_TTL_MS}, subject=${subject ? 'Y' : 'N'}, category=${categoryFolder || 'none'})`);
    return mp4s;
  } catch (err) {
    console.error('[10A][STATIC][ERR] getAllFiles failed:', err);
    return [];
  }
};

module.exports = { findR2ClipForScene };
