// ===========================================================
// SECTION 5H: JOB CLEANUP & PROGRESS TRACKING
// Handles cleanup of temp files, progress map, error logging
// MAX LOGGING EVERY STEP
// ===========================================================

const fs = require('fs');
const path = require('path');

console.log('[5H][INIT] Cleanup & progress module loaded.');

/**
 * Cleans up all temp files and folders for a given job.
 * @param {string} jobId - The job's unique identifier
 */
function cleanupJob(jobId) {
  console.log(`[5H][CLEANUP] Called for job: ${jobId}`);
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

  // Optionally, also remove from global progress tracking (support both global/provided progress):
  if (typeof global.progress === 'object' && global.progress !== null) {
    if (global.progress[jobId]) {
      delete global.progress[jobId];
      console.log(`[5H][CLEANUP] Removed job ${jobId} from global progress.`);
    } else {
      console.log(`[5H][CLEANUP] Job ${jobId} not present in global progress.`);
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
 */
function jobFatalError(jobId, errorMsg, err = null) {
  const prog = getGlobalProgressMap();
  prog[jobId] = { percent: 100, status: `Failed: ${errorMsg}` };
  console.error(`[5H][FATAL] [${jobId}] ${errorMsg}`, err ? err.stack || err : '');
  cleanupJob(jobId);
}

module.exports = {
  cleanupJob,
  getGlobalProgressMap,
  updateJobProgress,
  jobFatalError
};
