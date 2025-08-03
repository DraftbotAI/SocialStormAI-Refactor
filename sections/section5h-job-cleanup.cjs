// ===========================================================
// SECTION 5H: JOB CLEANUP & PROGRESS TRACKING
// Handles cleanup of temp files, progress map, error logging
// Post-job: Ingests any queued external clips to R2 in background!
// MAX LOGGING EVERY STEP
// ===========================================================

const fs = require('fs');
const path = require('path');
const { uploadToR2 } = require('./section10e-upload-to-r2.cjs');

console.log('[5H][INIT] Cleanup & progress module loaded.');

// --- Utility to ensure only this module deletes progress ---
function safeDeleteProgressEntry(jobId) {
  if (typeof global.progress === 'object' && global.progress !== null) {
    if (global.progress[jobId]) {
      delete global.progress[jobId];
      console.log(`[5H][CLEANUP] Progress entry deleted for job ${jobId} (delayed 30s).`);
    } else {
      console.log(`[5H][CLEANUP] Progress entry for job ${jobId} was already deleted before timer fired.`);
    }
  } else {
    console.warn('[5H][CLEANUP][WARN] Tried to delete progress, but global progress is missing or invalid.');
  }
}

/**
 * Fires off post-job R2 ingestion of all external clips queued in jobContext.clipsToIngest.
 * Runs as background, does not block cleanup or delivery!
 * @param {object} jobContext - Should have .clipsToIngest array
 * @param {string} jobId
 */
function fireAndForgetPostJobUploads(jobContext, jobId = '') {
  if (
    jobContext &&
    Array.isArray(jobContext.clipsToIngest) &&
    jobContext.clipsToIngest.length
  ) {
    console.log(`[5H][UPLOAD][${jobId}] Starting post-job R2 ingestion for ${jobContext.clipsToIngest.length} clips...`);
    jobContext.clipsToIngest.forEach(clip => {
      if (!clip.localPath || !clip.subject || clip.sceneIdx === undefined || !clip.source) {
        console.error(`[5H][UPLOAD][${jobId}] Missing info for queued clip:`, clip);
        return;
      }
      // Pass categoryFolder if present (for smart foldering)
      uploadToR2(
        clip.localPath,
        clip.subject,
        clip.sceneIdx,
        clip.source,
        clip.categoryFolder || null
      )
        .then(r2Dest => {
          if (r2Dest) {
            console.log(`[5H][UPLOAD][${jobId}] Uploaded to R2: ${r2Dest}`);
          } else {
            console.error(`[5H][UPLOAD][${jobId}] Failed to upload:`, clip.localPath);
          }
        })
        .catch(err => {
          console.error(`[5H][UPLOAD][${jobId}] R2 upload error:`, err);
        });
    });
  } else {
    console.log(`[5H][UPLOAD][${jobId}] No clips queued for post-job R2 ingestion.`);
  }
}

/**
 * Cleans up all temp files and folders for a given job.
 * DELAYS removal from progress map by 30 seconds to allow frontend to fetch final result.
 * @param {string} jobId - The job's unique identifier
 * @param {object} [jobContext] - Optional, for post-job R2 uploads
 */
function cleanupJob(jobId, jobContext = null) {
  console.log(`[5H][CLEANUP] Called for job: ${jobId}`);

  // 1. Trigger post-job R2 ingestion (fire-and-forget, does not block)
  try {
    fireAndForgetPostJobUploads(jobContext, jobId);
  } catch (err) {
    console.error(`[5H][CLEANUP][${jobId}] Error launching post-job R2 ingestion:`, err);
  }

  // 2. Remove temp files
  try {
    const rendersDir = path.resolve(__dirname, '..', 'renders', jobId);
    if (fs.existsSync(rendersDir)) {
      fs.rmSync(rendersDir, { recursive: true, force: true });
      console.log(`[5H][CLEANUP] Removed renders dir for job ${jobId}: ${rendersDir}`);
    } else {
      console.log(`[5H][CLEANUP] No renders dir for job ${jobId} to remove: ${rendersDir}`);
    }
  } catch (err) {
    console.error(`[5H][CLEANUP][ERR] Failed to clean up files for job ${jobId}:`, err);
  }

  // 3. Delay removal from global progress tracking to prevent "not found" warnings
  if (typeof global.progress === 'object' && global.progress !== null) {
    if (global.progress[jobId]) {
      console.log(`[5H][CLEANUP] Scheduling progress entry removal for job ${jobId} in 30 seconds.`);
      setTimeout(() => {
        safeDeleteProgressEntry(jobId);
      }, 30000);
    } else {
      console.log(`[5H][CLEANUP] Job ${jobId} not present in global progress (no delayed deletion needed).`);
    }
  } else {
    console.warn('[5H][CLEANUP][WARN] Global progress map missing or invalid.');
  }
}

/**
 * Sets up or retrieves a progress tracking object (singleton style).
 * Call this at app boot, or pass your own.
 */
function getGlobalProgressMap() {
  if (!global.progress || typeof global.progress !== 'object') {
    global.progress = {};
    console.log('[5H][PROGRESS] Initialized global progress object.');
  }
  return global.progress;
}

/**
 * Logs job progress with a clear, scannable message.
 * @param {string} jobId
 * @param {object} statusObj
 */
function updateJobProgress(jobId, statusObj) {
  const prog = getGlobalProgressMap();
  prog[jobId] = { ...statusObj };
  console.log(`[5H][PROGRESS] [${jobId}] Progress updated:`, statusObj);
}

/**
 * Utility to log fatal job errors, update status, and trigger cleanup.
 * @param {string} jobId
 * @param {string} errorMsg
 * @param {object} [err] - Optional error object
 * @param {object} [jobContext] - Optional, for post-job R2 uploads
 */
function jobFatalError(jobId, errorMsg, err = null, jobContext = null) {
  const prog = getGlobalProgressMap();
  prog[jobId] = { percent: 100, status: `Failed: ${errorMsg}` };
  console.error(`[5H][FATAL] [${jobId}] ${errorMsg}`, err ? err.stack || err : '');
  cleanupJob(jobId, jobContext);
}

module.exports = {
  cleanupJob,
  getGlobalProgressMap,
  updateJobProgress,
  jobFatalError,
  fireAndForgetPostJobUploads
};
