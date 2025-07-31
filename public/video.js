// ================================ 
// SECTION 1: DOM READY & UTILITIES
// ================================
document.addEventListener('DOMContentLoaded', function() {
  // === LOGGING HELPERS ===
  function log(...args) { try { console.log('[LOG]', ...args); } catch(_){} }
  function logWarn(...args) { try { console.warn('[WARN]', ...args); } catch(_){} }
  function logError(...args) { try { console.error('[ERROR]', ...args); } catch(_){} }

  // ==============================
  // SECTION 2: NAV + UI SETUP
  // ==============================
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileNav = document.getElementById('mobileNav');
  if (hamburgerBtn && mobileNav) {
    hamburgerBtn.addEventListener('click', () => {
      hamburgerBtn.classList.toggle('active');
      log('NAV', 'Hamburger clicked, toggling mobile menu.');
      mobileNav.style.display = mobileNav.style.display === 'flex' ? 'none' : 'flex';
    });
  }

  // Paid/Pro logic (update as needed)
  const isPaidUser = false;
  const isOverLimit = false;
  const isProUser = false;

  log('DOM', 'DOMContentLoaded');
  loadVoices();
  setupSparkie();
  window.scrollTo(0,0);
  document.getElementById('brandingToggleRow').style.display = isPaidUser ? "flex" : "none";
  document.getElementById('scriptTextarea').addEventListener('input', updateGenerateVideoBtnState);
  updateGenerateVideoBtnState();

  function updateGenerateVideoBtnState() {
    const scriptVal = document.getElementById('scriptTextarea').value.trim();
    const btn = document.getElementById('generateVideoBtn');
    btn.disabled = (!scriptVal || isOverLimit);
    log('UI', 'updateGenerateVideoBtnState', { scriptVal, isOverLimit, disabled: btn.disabled });
  }

  // ==============================
  // SECTION 3: VOICE LOADING/PREVIEW
  // ==============================
  let voices = [];
  let selectedVoice = null;

  async function loadVoices() {
    const sel = document.getElementById('voiceSelect');
    sel.disabled = true;
    sel.innerHTML = '<option>Loading…</option>';
    log('VOICES', 'Loading voices...');
    try {
      const resp = await fetch('/api/voices');
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
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
      document.getElementById('previewBtn').disabled = !selectedVoice.preview;
      log('VOICES', 'Voices loaded', voices);
    } catch (e) {
      sel.innerHTML = '<option>Error loading voices</option>';
      logError('VOICES', e);
    } finally {
      sel.disabled = false;
    }
  }

  document.getElementById('voiceSelect').addEventListener('change', function() {
    selectedVoice = voices[this.selectedIndex];
    log('VOICES', 'Voice selected', selectedVoice);
    document.getElementById('previewBtn').disabled = !selectedVoice.preview;
  });

  document.getElementById('previewBtn').addEventListener('click', function() {
    if (selectedVoice?.preview) {
      const audio = document.getElementById('voicePreviewAudio');
      audio.src = selectedVoice.preview;
      audio.play();
      log('VOICES', 'Preview played', selectedVoice);
    }
  });

  // ==============================
  // SECTION 4: SCRIPT GENERATION
  // ==============================
  let genStatusTimer = null;

  function startGenStatusAnimation() {
    const status = document.getElementById('genStatus');
    let dots = 1;
    status.textContent = "Generating script .";
    genStatusTimer = setInterval(() => {
      dots = (dots % 3) + 1;
      status.textContent = "Generating script " + ".".repeat(dots);
    }, 480);
  }

  function stopGenStatusAnimation() {
    clearInterval(genStatusTimer);
    document.getElementById('genStatus').textContent = "";
  }

  document.getElementById('generateScriptBtn').onclick = async () => {
    const idea = document.getElementById('ideaInput').value.trim();
    const out  = document.getElementById('output');
    if (!idea) { out.textContent = 'Enter an idea.'; return; }
    out.textContent = '';
    startGenStatusAnimation();
    try {
      const res  = await fetch('/api/generate-script', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ idea })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      document.getElementById('scriptTextarea').value = data.script;
      updateGenerateVideoBtnState();
      showMetaData(data.title, data.description, data.tags || data.hashtags);
    } catch (err) {
      out.textContent = 'Error generating script.';
      logError('SCRIPT', err);
    } finally {
      stopGenStatusAnimation();
    }
  };

  function showMetaData(title, description, tags) {
    document.getElementById('metaDataBox').innerHTML = `
      <div class="meta-group"><div class="meta-label">Title<button class="copy-btn" data-copy="title"></button></div><div class="meta-value" id="meta-title">${title}</div></div>
      <div class="meta-group"><div class="meta-label">Description<button class="copy-btn" data-copy="description"></button></div><div class="meta-value" id="meta-description">${description}</div></div>
      <div class="meta-group"><div class="meta-label">Tags<button class="copy-btn" data-copy="tags"></button></div><div class="meta-value" id="meta-tags">${tags}</div></div>`;
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

  document.getElementById('generateVideoBtn').onclick = async () => {
    const script = document.getElementById('scriptTextarea').value.trim();
    const voice = document.getElementById('voiceSelect').value;
    const out = document.getElementById('output');
    const player = document.getElementById('videoPlayer');
    const downloadBtn = document.getElementById('downloadBtn');
    const shareBtn = document.getElementById('shareBtn');
    const progressBarWrap = document.getElementById('progressBarWrap');
    const progressBar = document.getElementById('progressBar');
    const progressStatus = document.getElementById('progressStatus');

    if (!script || !voice) {
      out.textContent = !script ? 'Generate script first.' : 'Select a voice.';
      logWarn('VIDEO', 'Missing script or voice for generation.', { script, voice });
      return;
    }

    out.textContent = '';
    progressBarWrap.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.textContent = '0%';
    progressStatus.textContent = 'Starting…';
    player.style.display = 'none';

    // Clear any old video for a clean reload!
    player.removeAttribute('src');
    player.load();

    downloadBtn.style.display = shareBtn.style.display = 'none';

    simulatedPercent = 0;
    clearInterval(simInterval);
    simInterval = setInterval(() => {
      if (simulatedPercent < 94) simulatedPercent += Math.random();
      progressBar.style.width = `${simulatedPercent}%`;
      progressBar.textContent = `${Math.round(simulatedPercent)}%`;
    }, 800);

    try {
      const payload = {
        script,
        voice,
        paidUser: isPaidUser,
        removeWatermark: isPaidUser && document.getElementById('removeBrandingSwitch').checked,
        addMusic: document.getElementById('addMusicSwitch').checked
      };

      const res = await fetch('/api/generate-video', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!data.jobId) throw new Error('Failed to start video generation.');
      log('VIDEO', 'Job started', data);

      pollingInterval = setInterval(async () => {
        const resp = await fetch(`/api/progress/${data.jobId}`);
        const p = await resp.json();
        let displayPercent = Math.max(simulatedPercent, p.percent || 0);
        progressBar.style.width = `${displayPercent}%`;
        progressBar.textContent = `${Math.round(displayPercent)}%`;
        progressStatus.textContent = p.status || '';

        if (p.percent >= 100) {
          clearInterval(pollingInterval);
          clearInterval(simInterval);

          // FINAL VIDEO URL RESOLUTION (PRO FIX!)
          let videoUrl = null;
          if (p.output && p.output.startsWith('https://videos.socialstormai.com/')) {
            videoUrl = p.output;
            log('VIDEO', 'Using custom R2 domain for videoUrl:', videoUrl);
          } else if (p.output && p.output.startsWith('https://')) {
            // Only fallback if absolutely necessary, never use dev R2 if custom domain should work
            videoUrl = p.output;
            logWarn('VIDEO', 'Output is not from custom R2 domain, using as fallback:', videoUrl);
          } else {
            logError('VIDEO', 'Backend did not return valid video URL:', p.output);
          }

          if (videoUrl) {
            // Set .src directly for universal browser compatibility
            player.src = videoUrl;
            log('VIDEO', 'Set <video> src:', player.src);

            // Pause, reset, load (some browsers need this order)
            player.pause();
            player.currentTime = 0;
            player.load();
            log('VIDEO', 'Called player.load() after setting src');
          } else {
            out.textContent = p.status || 'Generation failed.';
            progressBarWrap.style.display = 'none';
            logError('VIDEO', 'Missing videoUrl after job finish!');
            return;
          }

          player.style.display = 'block';

          // Event: video loaded
          player.onloadeddata = () => {
            player.muted = false;
            player.volume = 1.0;
            progressStatus.textContent = 'Click ▶︎ to play your video.';
            downloadBtn.style.display = 'inline-block';
            shareBtn.style.display = 'inline-block';
            downloadBtn.href = videoUrl;
            downloadBtn.setAttribute('download', 'socialstormai-video.mp4');
            shareBtn.onclick = () => {
              navigator.clipboard.writeText(videoUrl);
              alert('Video link copied!');
            };
            progressBar.style.width = '100%';
            progressBar.textContent = '100%';
            setTimeout(() => progressBarWrap.style.display = 'none', 2000);
            showThumbUpsell();
            log('VIDEO', 'Loaded and ready', videoUrl);
          };

          // Event: video error
          player.onerror = (e) => {
            progressStatus.textContent = 'Error loading video. Retry.';
            logError('VIDEO', 'Error loading video.', videoUrl, e);
          };
        }
      }, 1200);

    } catch (err) {
      clearInterval(simInterval);
      progressStatus.textContent = 'Error generating video.';
      progressBarWrap.style.display = 'none';
      logError('VIDEO', err);
    }
  };

  // ==============================
  // SECTION 6: THUMBNAIL UPSELL UI
  // ==============================
  function showThumbUpsell() {
    if (isProUser) {
      document.getElementById('thumbIncluded').style.display = 'block';
      document.querySelectorAll('.thumb-option').forEach(opt => opt.style.display = 'none');
    }
    document.getElementById('thumbnail-upsell').style.display = 'flex';
    setTimeout(() => {
      document.getElementById('thumbnail-upsell').scrollIntoView({behavior:'smooth',block:'center'});
    }, 450);
  }

  // ==============================
  // SECTION 7: CHATBOT SPARKIE
  // ==============================
  function setupSparkie() {
    document.getElementById('chatbot-bubble').onclick = () => {
      alert("Sparkie: Hey! The chat feature is coming soon. For now, send feedback or ideas through the contact page. ⚡️");
    };
  }

}); // END DOMContentLoaded
