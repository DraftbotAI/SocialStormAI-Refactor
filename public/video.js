// ================================
// SECTION 1: DOM READY & UTILITIES
// ================================
console.log('[TEST][BOOT] video.js loaded (TOP OF FILE)');

document.addEventListener('DOMContentLoaded', function() {
  console.log('[TEST][DOM] DOMContentLoaded running');

  // === LOGGING HELPERS ===
  function log(...args) { try { console.log('[LOG]', ...args); } catch(_){} }
  function logWarn(...args) { try { console.warn('[WARN]', ...args); } catch(_){} }
  function logError(...args) { try { console.error('[ERROR]', ...args); } catch(_){} }

  log('[INIT] Starting up video.js DOM logic');

  // ==============================
  // SECTION 2: NAV + UI SETUP
  // ==============================
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileNav = document.getElementById('mobileNav');
  log('[DOM] hamburgerBtn:', hamburgerBtn, '| mobileNav:', mobileNav);
  if (hamburgerBtn && mobileNav) {
    hamburgerBtn.addEventListener('click', () => {
      hamburgerBtn.classList.toggle('active');
      log('NAV', 'Hamburger clicked, toggling mobile menu.');
      mobileNav.style.display = mobileNav.style.display === 'flex' ? 'none' : 'flex';
    });
  } else {
    logWarn('[UI] Hamburger or mobileNav missing');
  }

  // Fix logo size at runtime
  const logoImg = document.querySelector('.nav-logo img');
  log('[DOM] logoImg:', logoImg);
  if (logoImg) {
    logoImg.style.height = '200px';
    logoImg.style.width = 'auto';
    logoImg.style.maxWidth = '90vw';
    logoImg.style.transition = 'height 0.22s';
    log('LOGO', 'Set logo height to 200px');
  }

  // Fix video player container and video to standard YouTube size (16:9, max 720px)
  const videoContainer = document.querySelector('.video-container');
  log('[DOM] videoContainer:', videoContainer);
  if (videoContainer) {
    videoContainer.style.maxWidth = '720px';
    videoContainer.style.minHeight = '405px';
    videoContainer.style.aspectRatio = '16/9';
    videoContainer.style.width = '100%';
    log('VIDEO-CONTAINER', 'Set max-width:720px; min-height:405px; aspect-ratio:16/9');
  }
  const player = document.getElementById('videoPlayer');
  log('[DOM] player:', player);
  if (player) {
    player.style.width = '100%';
    player.style.maxWidth = '720px';
    player.style.aspectRatio = '16/9';
    player.style.background = '#000';
    player.style.borderRadius = '14px';
    player.style.objectFit = 'contain';
    log('VIDEO', 'Set player to standard YouTube size');
  }

  // Paid/Pro logic (update as needed)
  const isPaidUser = false;
  const isOverLimit = false;
  const isProUser = false;

  log('[INIT] After UI setup');
  try {
    loadVoices();
    setupSparkie();
    window.scrollTo(0,0);
    log('[INIT] Called loadVoices and setupSparkie');
  } catch(e) {
    logError('[INIT] Error calling loadVoices/setupSparkie', e);
  }

  // Show branding/music/outro toggles if paid
  const brandingToggleRow = document.getElementById('brandingToggleRow');
  const outroToggleRow = document.getElementById('outroToggleRow');
  const watermarkToggleRow = document.getElementById('watermarkToggleRow');
  log('[DOM] Branding/Outro/Watermark rows:', brandingToggleRow, outroToggleRow, watermarkToggleRow);
  if (isPaidUser) {
    if (brandingToggleRow) brandingToggleRow.style.display = "flex";
    if (outroToggleRow) outroToggleRow.style.display = "flex";
    if (watermarkToggleRow) watermarkToggleRow.style.display = "flex";
  } else {
    if (brandingToggleRow) brandingToggleRow.style.display = "none";
    if (outroToggleRow) outroToggleRow.style.display = "none";
    if (watermarkToggleRow) watermarkToggleRow.style.display = "none";
  }

  const scriptTextarea = document.getElementById('scriptTextarea');
  const generateVideoBtn = document.getElementById('generateVideoBtn');
  log('[DOM] scriptTextarea:', scriptTextarea, '| generateVideoBtn:', generateVideoBtn);

  if (scriptTextarea && generateVideoBtn) {
    scriptTextarea.addEventListener('input', updateGenerateVideoBtnState);
    updateGenerateVideoBtnState();
  } else {
    logWarn('[UI] scriptTextarea or generateVideoBtn missing');
  }

  function updateGenerateVideoBtnState() {
    const scriptVal = scriptTextarea ? scriptTextarea.value.trim() : '';
    const btn = generateVideoBtn;
    if (btn) btn.disabled = (!scriptVal || isOverLimit);
    log('UI', 'updateGenerateVideoBtnState', { scriptVal, isOverLimit, disabled: btn ? btn.disabled : null });
  }

  // ==============================
  // SECTION 3: VOICE LOADING/PREVIEW
  // ==============================
  let voices = [];
  let selectedVoice = null;

  async function loadVoices() {
    log('[VOICES] loadVoices() called');
    const sel = document.getElementById('voiceSelect');
    if (!sel) { logError('[VOICES] voiceSelect element not found!'); return; }
    sel.disabled = true;
    sel.innerHTML = '<option>Loading…</option>';
    log('[VOICES] Loading voices...');
    try {
      const resp = await fetch('/api/voices', { cache: "reload" });
      const data = await resp.json();
      log('[VOICES] Response from /api/voices:', data);

      if (!data.success || !Array.isArray(data.voices)) throw new Error(data.error || 'No voices in response.');
      voices = data.voices;

      voices.sort((a, b) => {
        if (a.tier === 'Free' && b.tier !== 'Free') return -1;
        if (a.tier !== 'Free' && b.tier === 'Free') return 1;
        return 0;
      });

      sel.innerHTML = '';
      let defaultIdx = voices.findIndex(v => v.name.toLowerCase() === 'andrew');
      defaultIdx = defaultIdx !== -1 ? defaultIdx : 0;

      voices.forEach((v, i) => {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = `${v.name} — ${v.description}` + (v.disabled ? " (Pro Only)" : "");
        o.disabled = v.disabled;
        sel.appendChild(o);
      });

      sel.selectedIndex = defaultIdx;
      selectedVoice = voices[defaultIdx];
      const previewBtn = document.getElementById('previewBtn');
      if (previewBtn) previewBtn.disabled = !selectedVoice?.preview;
      log('[VOICES] Voices loaded', voices);
    } catch (e) {
      sel.innerHTML = '<option>Error loading voices</option>';
      logError('[VOICES] loadVoices error:', e);
    } finally {
      sel.disabled = false;
    }
  }

  const voiceSelect = document.getElementById('voiceSelect');
  if (voiceSelect) {
    voiceSelect.addEventListener('change', function() {
      selectedVoice = voices[this.selectedIndex];
      log('[VOICES] Voice selected', selectedVoice);
      const previewBtn = document.getElementById('previewBtn');
      if (previewBtn) previewBtn.disabled = !selectedVoice?.preview;
    });
  } else {
    logWarn('[VOICES] voiceSelect not found for change event');
  }

  const previewBtn = document.getElementById('previewBtn');
  if (previewBtn) {
    previewBtn.addEventListener('click', function() {
      log('[VOICES] PreviewBtn clicked, selectedVoice:', selectedVoice);
      if (selectedVoice && selectedVoice.preview) {
        const audio = document.getElementById('voicePreviewAudio');
        if (audio) {
          audio.src = selectedVoice.preview;
          audio.play();
          log('[VOICES] Preview played', selectedVoice);
        } else {
          logWarn('[VOICES] voicePreviewAudio element missing');
        }
      } else {
        logWarn('[VOICES] No preview available for selectedVoice');
      }
    });
  } else {
    logWarn('[VOICES] previewBtn not found');
  }

  // ==============================
  // SECTION 4: SCRIPT GENERATION
  // ==============================
  let genStatusTimer = null;

  function startGenStatusAnimation() {
    const status = document.getElementById('genStatus');
    if (!status) { logWarn('[SCRIPT] genStatus element missing'); return; }
    let dots = 1;
    status.textContent = "Generating script .";
    genStatusTimer = setInterval(() => {
      dots = (dots % 3) + 1;
      status.textContent = "Generating script " + ".".repeat(dots);
    }, 480);
  }

  function stopGenStatusAnimation() {
    clearInterval(genStatusTimer);
    const status = document.getElementById('genStatus');
    if (status) status.textContent = "";
  }

  const generateScriptBtn = document.getElementById('generateScriptBtn');
  log('[DOM] generateScriptBtn:', generateScriptBtn);

  if (generateScriptBtn) {
    generateScriptBtn.onclick = async () => {
      log('[SCRIPT] GenerateScriptBtn clicked');
      const idea = document.getElementById('ideaInput')?.value.trim();
      const out  = document.getElementById('output');
      log('[SCRIPT] ideaInput:', idea, '| output:', out);
      if (!idea) { if (out) out.textContent = 'Enter an idea.'; return; }
      if (out) out.textContent = '';
      startGenStatusAnimation();
      try {
        const res  = await fetch('/api/generate-script', {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({ idea })
        });
        const data = await res.json();
        log('[SCRIPT] Response from /api/generate-script:', data);
        if (!data.success) throw new Error(data.error);
        const scriptTextarea = document.getElementById('scriptTextarea');
        if (scriptTextarea) scriptTextarea.value = data.script;
        updateGenerateVideoBtnState();
        showMetaData(data.title, data.description, data.tags || data.hashtags);
      } catch (err) {
        if (out) out.textContent = 'Error generating script.';
        logError('[SCRIPT] Error:', err);
      } finally {
        stopGenStatusAnimation();
      }
    };
  } else {
    logWarn('[SCRIPT] generateScriptBtn missing');
  }

  function showMetaData(title, description, tags) {
    const metaDataBox = document.getElementById('metaDataBox');
    if (!metaDataBox) { logWarn('[SCRIPT] metaDataBox missing'); return; }
    metaDataBox.innerHTML = `
      <div class="meta-group"><div class="meta-label">Title<button class="copy-btn" data-copy="title"></button></div><div class="meta-value" id="meta-title">${title || ''}</div></div>
      <div class="meta-group"><div class="meta-label">Description<button class="copy-btn" data-copy="description"></button></div><div class="meta-value" id="meta-description">${description || ''}</div></div>
      <div class="meta-group"><div class="meta-label">Tags<button class="copy-btn" data-copy="tags"></button></div><div class="meta-value" id="meta-tags">${tags || ''}</div></div>`;
    setupCopyButtons();
  }

  function setupCopyButtons() {
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.textContent = '📋';
      btn.onclick = () => {
        const val = document.getElementById('meta-' + btn.dataset.copy).innerText;
        navigator.clipboard.writeText(val);
        btn.textContent = '✅';
        setTimeout(() => btn.textContent = '📋', 1000);
      };
    });
  }

  // ==============================
  // SECTION 5: VIDEO GENERATION UI LOGIC
  // ==============================
  let pollingInterval, simInterval, simulatedPercent = 0;

  if (generateVideoBtn) {
    generateVideoBtn.onclick = async () => {
      log('[VIDEO] generateVideoBtn clicked');
      const scriptTextarea = document.getElementById('scriptTextarea');
      const script = scriptTextarea ? scriptTextarea.value.trim() : '';
      const voiceSelect = document.getElementById('voiceSelect');
      const voice = voiceSelect ? voiceSelect.value : '';
      const out = document.getElementById('output');
      const player = document.getElementById('videoPlayer');
      const downloadBtn = document.getElementById('downloadBtn');
      const shareBtn = document.getElementById('shareBtn');
      const progressBarWrap = document.getElementById('progressBarWrap');
      const progressBar = document.getElementById('progressBar');
      const progressStatus = document.getElementById('progressStatus');
      log('[VIDEO] Inputs:', { script, voice, out, player, downloadBtn, shareBtn, progressBarWrap, progressBar, progressStatus });

      const removeWatermark = isPaidUser && document.getElementById('removeBrandingSwitch')?.checked;
      const removeOutro = isPaidUser && document.getElementById('removeOutroSwitch')?.checked;

      if (!script || !voice) {
        if (out) out.textContent = !script ? 'Generate script first.' : 'Select a voice.';
        logWarn('VIDEO', 'Missing script or voice for generation.', { script, voice });
        return;
      }

      if (out) out.textContent = '';
      if (progressBarWrap) progressBarWrap.style.display = 'block';
      if (progressBar) { progressBar.style.width = '0%'; progressBar.textContent = '0%'; }
      if (progressStatus) progressStatus.textContent = 'Starting…';
      if (player) player.style.display = 'none';

      if (player) {
        player.removeAttribute('src');
        player.load();
      }
      if (downloadBtn && shareBtn) {
        downloadBtn.style.display = shareBtn.style.display = 'none';
      }

      simulatedPercent = 0;
      clearInterval(simInterval);
      simInterval = setInterval(() => {
        if (simulatedPercent < 94) simulatedPercent += 0.5 + Math.random();
        if (simulatedPercent > 99) simulatedPercent = 99;
        if (progressBar) {
          progressBar.style.width = `${simulatedPercent}%`;
          progressBar.textContent = `${Math.round(simulatedPercent)}%`;
        }
      }, 400);

      try {
        const payload = {
          script,
          voice,
          paidUser: isPaidUser,
          removeWatermark,
          removeOutro,
          addMusic: document.getElementById('addMusicSwitch')?.checked
        };
        log('[VIDEO] Payload:', payload);

        const res = await fetch('/api/generate-video', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        log('[VIDEO] Response from /api/generate-video:', data);
        if (!data.jobId) throw new Error('Failed to start video generation.');
        log('VIDEO', 'Job started', data);

        pollingInterval = setInterval(async () => {
          const resp = await fetch(`/api/progress/${data.jobId}`);
          const p = await resp.json();
          let displayPercent = Math.max(simulatedPercent, p.percent || 0);
          if (displayPercent > 100) displayPercent = 100;
          if (progressBar) {
            progressBar.style.width = `${displayPercent}%`;
            progressBar.textContent = `${Math.round(displayPercent)}%`;
          }
          if (progressStatus) progressStatus.textContent = p.status || '';

          log('[VIDEO] Progress poll:', p);

          if (p.percent >= 100) {
            clearInterval(pollingInterval);
            clearInterval(simInterval);

            let videoUrl = null;
            if (p.output && p.output.startsWith('https://videos.socialstormai.com/')) {
              videoUrl = p.output;
              log('VIDEO', 'Using custom R2 domain for videoUrl:', videoUrl);
            } else if (p.output && p.output.startsWith('https://')) {
              videoUrl = p.output;
              logWarn('VIDEO', 'Output is not from custom R2 domain, using as fallback:', videoUrl);
            } else {
              logError('VIDEO', 'Backend did not return valid video URL:', p.output);
            }

            if (videoUrl && player) {
              player.src = videoUrl;
              player.setAttribute('playsinline', 'true');
              player.setAttribute('crossorigin', 'anonymous');
              player.style.display = 'block';
              player.style.width = '100%';
              player.style.maxWidth = '720px';
              player.style.aspectRatio = '16/9';
              player.style.height = '';
              player.style.objectFit = 'contain';
              log('VIDEO', 'Set <video> src & style:', player.src);

              player.pause();
              player.currentTime = 0;
              player.load();
              log('VIDEO', 'Called player.load() after setting src');
            } else {
              if (out) out.textContent = p.status || 'Generation failed.';
              if (progressBarWrap) progressBarWrap.style.display = 'none';
              logError('VIDEO', 'Missing videoUrl after job finish!');
              return;
            }

            if (player) {
              player.onloadeddata = () => {
                player.muted = false;
                player.volume = 1.0;
                if (progressStatus) progressStatus.textContent = 'Click ▶︎ to play your video.';
                if (downloadBtn) downloadBtn.style.display = 'inline-block';
                if (shareBtn) shareBtn.style.display = 'inline-block';
                if (downloadBtn) {
                  downloadBtn.href = videoUrl;
                  downloadBtn.setAttribute('download', 'socialstormai-video.mp4');
                  downloadBtn.onclick = (e) => {
                    e.preventDefault();
                    fetch(videoUrl)
                      .then(r => r.blob())
                      .then(blob => {
                        const a = document.createElement('a');
                        a.style.display = 'none';
                        document.body.appendChild(a);
                        const url = window.URL.createObjectURL(blob);
                        a.href = url;
                        a.download = 'socialstormai-video.mp4';
                        a.click();
                        setTimeout(() => {
                          window.URL.revokeObjectURL(url);
                          document.body.removeChild(a);
                        }, 1000);
                      })
                      .catch(() => {
                        alert('Unable to download video. Try right-click Save As.');
                      });
                  };
                }
                if (shareBtn) {
                  shareBtn.onclick = async () => {
                    if (navigator.share) {
                      try {
                        await navigator.share({
                          title: 'Check out my AI video!',
                          url: videoUrl
                        });
                      } catch (_) {}
                    } else {
                      navigator.clipboard.writeText(videoUrl);
                      alert('Video link copied!');
                    }
                  };
                }
                if (progressBar) {
                  progressBar.style.width = '100%';
                  progressBar.textContent = '100%';
                }
                setTimeout(() => { if (progressBarWrap) progressBarWrap.style.display = 'none'; }, 2000);
                showThumbUpsell();
                log('VIDEO', 'Loaded and ready', videoUrl);
              };
              player.onerror = (e) => {
                if (progressStatus) progressStatus.textContent = 'Error loading video. Retry.';
                logError('VIDEO', 'Error loading video.', player.src, e);
              };
            }
          }
        }, 1200);

      } catch (err) {
        clearInterval(simInterval);
        if (progressStatus) progressStatus.textContent = 'Error generating video.';
        if (progressBarWrap) progressBarWrap.style.display = 'none';
        logError('[VIDEO] Error generating video:', err);
      }
    };
  } else {
    logWarn('[VIDEO] generateVideoBtn missing');
  }

  // ==============================
  // SECTION 6: THUMBNAIL UPSELL UI
  // ==============================
  function showThumbUpsell() {
    log('[UI] showThumbUpsell called');
    if (isProUser) {
      const thumbIncluded = document.getElementById('thumbIncluded');
      if (thumbIncluded) thumbIncluded.style.display = 'block';
      document.querySelectorAll('.thumb-option').forEach(opt => opt.style.display = 'none');
    }
    const upsell = document.getElementById('thumbnail-upsell');
    if (upsell) {
      upsell.style.display = 'flex';
      setTimeout(() => {
        upsell.scrollIntoView({behavior:'smooth',block:'center'});
      }, 450);
    } else {
      logWarn('[UI] thumbnail-upsell missing');
    }
  }

  // ==============================
  // SECTION 7: CHATBOT SPARKIE
  // ==============================
  function setupSparkie() {
    log('[UI] setupSparkie called');
    const bubble = document.getElementById('chatbot-bubble');
    if (bubble) {
      bubble.onclick = () => {
        alert("Sparkie: Hey! The chat feature is coming soon. For now, send feedback or ideas through the contact page. ⚡️");
      };
    } else {
      logWarn('[UI] chatbot-bubble not found');
    }
  }

  log('[BOOT] DOMContentLoaded COMPLETED — video.js');
}); // END DOMContentLoaded

console.log('[TEST][BOTTOM] video.js file fully parsed');
