/**
 * app.js — RepCount PWA
 *
 * Bootstraps camera, pose engine, rep counters, and all UI interactions.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const EXERCISE_CONFIG = {
  pushup: {
    label:     'PUSHUPS',
    icon:      '💪',
    accent:    '#4facfe',
    accentGlow:'rgba(79,172,254,0.45)',
    guide:     'Position yourself sideways to the camera for best detection',
    phase: {
      up:   'ARMS EXTENDED',
      down: 'CHEST DOWN',
    },
  },
  pullup: {
    label:     'PULLUPS',
    icon:      '🏋️',
    accent:    '#00f2c3',
    accentGlow:'rgba(0,242,195,0.45)',
    guide:     'Face the camera while hanging from the bar',
    phase: {
      up:   'PULLED UP',
      down: 'HANGING',
    },
  },
  situp: {
    label:     'SITUPS',
    icon:      '🔥',
    accent:    '#ff5e62',
    accentGlow:'rgba(255,94,98,0.45)',
    guide:     'Position yourself sideways so the camera sees your full torso',
    phase: {
      up:   'SITTING UP',
      down: 'LYING FLAT',
    },
  },
  plank: {
    label:     'PLANKS',
    icon:      '🧱',
    accent:    '#b5179e',
    accentGlow:'rgba(181,23,158,0.45)',
    guide:     'Hold a straight plank sideways to the camera',
    phase: {
      holding: 'HOLDING',
      'bad form': 'HIPS SAGGING!',
    },
  },
};

// ─── Workout DB ──────────────────────────────────────────────────────────────
class WorkoutDB {
  constructor() {
    this.key = 'repai_history_v2';
    this.data = this._load();
  }
  
  _load() {
    try { return JSON.parse(localStorage.getItem(this.key)) || {}; } 
    catch { return {}; }
  }
  
  _save() {
    localStorage.setItem(this.key, JSON.stringify(this.data));
  }
  
  _today() {
    return new Date().toISOString().split('T')[0];
  }
  
  addSet(exercise, volume) {
    const date = this._today();
    if (!this.data[date]) this.data[date] = { totalVolume: 0, exercises: {} };
    if (!this.data[date].exercises[exercise]) {
      this.data[date].exercises[exercise] = { sets: 0, volume: 0 };
    }
    
    this.data[date].exercises[exercise].sets += 1;
    this.data[date].exercises[exercise].volume += volume;
    this.data[date].totalVolume += volume; // Simple aggregation for heat map
    
    this._save();
  }
  
  getAverageVolume(days = 7) {
    const dates = Object.keys(this.data).sort().reverse();
    if (dates.length === 0) return 0;
    
    const recentDates = dates.slice(0, days);
    let sum = 0;
    for (let d of recentDates) sum += this.data[d].totalVolume;
    return sum / recentDates.length;
  }
}

// ─── App Class ────────────────────────────────────────────────────────────────

class App {
  constructor() {
    // ── DOM refs ────────────────────────────────────────────────
    this.$ = id => document.getElementById(id);
    this.loadingScreen   = this.$('loading-screen');
    this.loadingBar      = this.$('loading-bar');
    this.loadingSubtitle = this.$('loading-subtitle');
    this.permScreen      = this.$('permission-screen');
    this.videoEl         = this.$('camera-feed');
    this.canvas          = this.$('skeleton-canvas');
    this.ctx             = this.canvas.getContext('2d');
    this.repBubble       = this.$('rep-bubble');
    this.repCountEl      = this.$('rep-count');
    this.repLabelEl      = this.$('rep-label');
    this.phaseEl         = this.$('phase-indicator');
    this.angleEl         = this.$('angle-display');
    this.statusDot       = this.$('status-dot');
    this.statusText      = this.$('status-text');
    this.timerEl         = this.$('workout-timer');
    this.setBadge        = this.$('set-badge');
    this.startBtn        = this.$('start-btn');
    this.guideOverlay    = this.$('guide-overlay');
    this.historyPanel    = this.$('history-panel');
    this.settingsPanel   = this.$('settings-panel');
    this.setsList        = this.$('sets-list');

    // ── State ───────────────────────────────────────────────────
    this.exercise        = 'pushup';
    this.isWorkoutActive = false;
    this.facingMode      = 'user';
    this.stream          = null;
    this.animFrameId     = null;
    this.detectionActive = false;
    
    this.db              = new WorkoutDB();
    this.currentSetNum   = 1;
    this.sets            = [];
    this.workoutStartMs  = null;
    this.timerInterval   = null;

    this.audioEnabled   = true;
    this.audioCtx       = null;

    // Settings (loaded from localStorage)
    this.settings = {
      audioEnabled:   true,
      showAngle:      true,
      strictMode:     true, // Default strict
      sensitivity:    50,   // 0–100; maps to elbow angle thresholds
    };
    this._loadSettings();

    // ── Engine + Counters ────────────────────────────────────────
    this.poseEngine  = new PoseEngine();
    this.counters    = {
      pushup: new PushupCounter(),
      pullup: new PullupCounter(),
      situp:  new SitupCounter(),
      plank:  new PlankCounter(),
    };

    // ── Guide visibility tracker ─────────────────────────────────
    this.noDetectFrames = 0;
    this.GUIDE_THRESHOLD = 60; // frames without detection before showing guide

    // ── Init ─────────────────────────────────────────────────────
    this._init();
  }

  // ─── Initialisation ─────────────────────────────────────────────────────────

  async _init() {
    this._registerSW();
    this._bindUI();
    this._applyExerciseTheme();
    this._setProgress(10);

    // Step 1: Start camera early (parallel with model load)
    this._setStatus('loading', 'Starting camera…');
    let cameraOk = false;
    try {
      await this._startCamera();
      cameraOk = true;
      this._setProgress(40);
    } catch (err) {
      this._showPermissionScreen();
      return; // wait for user action
    }

    // Step 2: Load the pose model
    this._setStatus('loading', 'Loading AI model…');
    try {
      await this.poseEngine.load(msg => {
        this.loadingSubtitle.textContent = msg;
      });
      this._setProgress(90);
    } catch (err) {
      this._setStatus('error', 'Model failed to load');
      this.loadingSubtitle.textContent = 'Could not load AI model. Please reload.';
      return;
    }

    this._setProgress(100);

    // Step 3: Show app
    await this._sleep(400);
    this.loadingScreen.classList.add('fade-out');
    await this._sleep(500);
    this.loadingScreen.style.display = 'none';

    this._setStatus('ready', 'Ready — tap START');

    // Start the detection loop (but only count if workout active)
    this._startDetectionLoop();
  }

  _registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .catch(err => console.warn('SW registration failed:', err));
    }
  }

  // ─── Camera ──────────────────────────────────────────────────────────────────

  async _startCamera(facing = null) {
    if (facing) this.facingMode = facing;

    // Stop existing stream
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }

    const constraints = {
      video: {
        facingMode: { ideal: this.facingMode },
        width:      { ideal: 1920 },
        height:     { ideal: 1080 },
        frameRate:  { ideal: 30 },
      },
      audio: false,
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.videoEl.srcObject = this.stream;
    this.videoEl.playsInline = true;
    this.videoEl.muted = true;

    await new Promise((resolve, reject) => {
      this.videoEl.onloadedmetadata = () => {
        this.videoEl.play().then(resolve).catch(reject);
      };
      this.videoEl.onerror = reject;
      setTimeout(reject, 10000); // 10s timeout
    });

    // Mirror canvas when using front camera
    this.canvas.style.transform = this.facingMode === 'user' ? 'scaleX(-1)' : '';
  }

  async _flipCamera() {
    const newFacing = this.facingMode === 'environment' ? 'user' : 'environment';
    try {
      await this._startCamera(newFacing);
    } catch {
      // revert
      await this._startCamera(this.facingMode === 'user' ? 'environment' : 'user');
    }
  }

  // ─── Detection Loop ──────────────────────────────────────────────────────────

  _startDetectionLoop() {
    const loop = async () => {
      if (this.videoEl.readyState >= 2 && this.videoEl.videoWidth > 0) {
        // Resize canvas to match display size (responsive)
        if (this.canvas.width  !== this.canvas.offsetWidth ||
            this.canvas.height !== this.canvas.offsetHeight) {
          this.canvas.width  = this.canvas.offsetWidth;
          this.canvas.height = this.canvas.offsetHeight;
        }

        // Detect keypoints
        const keypoints = await this.poseEngine.detect(this.videoEl);

        // Accent color based on current exercise
        const cfg     = EXERCISE_CONFIG[this.exercise];
        const accent  = cfg.accent;

        // Draw the frame + skeleton
        drawSkeletonOnCanvas(this.ctx, this.videoEl, keypoints, accent);

        // Count reps only if workout is active
        if (this.isWorkoutActive && keypoints.length > 0) {
          const counter = this.counters[this.exercise];
          counter.isStrict = this.settings.strictMode;
          const result  = counter.update(keypoints);

          this._updateAngleDisplay(result.raw);
          this._updatePhaseDisplay(result.phase);
          this._updateBreathingPacer(this.exercise, result.phase, result.progress);

          if (result.repCompleted) {
            this._onRepCompleted(counter.count);
            if (counter.isStrict && result.countAdded < 1.0) {
              this._setStatus('error', `Half rep! +${result.countAdded}`);
            } else {
              this._setStatus('detecting', 'Detecting…');
            }
          } else if (!this.statusDot.classList.contains('error')) {
            this._setStatus('detecting', 'Detecting…');
          }
          
          if (!this.isWorkoutActive) {
            this._updateBreathingPacer(null, null, null); // Hide
          }

          if (keypoints.length > 0) {
            this.noDetectFrames = 0;
            this.detectionActive = true;
            this._setStatus('detecting', 'Detecting…');
            this.guideOverlay.classList.remove('visible');
          }
        } else if (this.isWorkoutActive) {
          // No keypoints
          this.noDetectFrames++;
          if (this.noDetectFrames > this.GUIDE_THRESHOLD) {
            this.guideOverlay.classList.add('visible');
            this._setStatus('ready', 'No person detected');
          }
        } else {
          // Idle — still draw frames but don't count
          if (keypoints.length > 0) {
            this._updateAngleDisplay(null);
          }
        }
      }

      this.animFrameId = requestAnimationFrame(loop);
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  // ─── Rep Completed ───────────────────────────────────────────────────────────

  _onRepCompleted(newCount) {
    // Update display
    if (this.exercise === 'plank') {
       const secs = Math.floor(newCount);
       const ms = Math.floor((newCount % 1) * 10);
       this.repCountEl.textContent = `${secs}.${ms}`;
       this.repLabelEl.textContent = 'SEC';
    } else {
       this.repCountEl.textContent = Number.isInteger(newCount) ? newCount : newCount.toFixed(1);
       this.repLabelEl.textContent = 'REPS';
    }

    // Flash animation
    this.repBubble.classList.remove('rep-flash');
    void this.repBubble.offsetWidth; // reflow
    this.repBubble.classList.add('rep-flash');

    // Audio beep
    if (this.settings.audioEnabled) this._playBeep();
  }

  // ─── Workout Control ─────────────────────────────────────────────────────────

  _startWorkout() {
    this.isWorkoutActive = true;
    this.counters[this.exercise].reset();
    
    if (this.exercise === 'plank') {
      this.repCountEl.textContent = '0.0';
      this.repLabelEl.textContent = 'SEC';
    } else {
      this.repCountEl.textContent = '0';
      this.repLabelEl.textContent = 'REPS';
    }
    this.workoutStartMs = Date.now();

    this.startBtn.textContent = '⏸ PAUSE';
    this.startBtn.classList.add('active');

    // Timer
    clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => this._updateTimer(), 1000);
    this._updateTimer();

    this._setStatus('detecting', 'Detecting…');
    this.noDetectFrames = 0;
  }

  _pauseWorkout() {
    this.isWorkoutActive = false;
    clearInterval(this.timerInterval);
    this.startBtn.textContent = '▶ RESUME';
    this.startBtn.classList.remove('active');
    this._setStatus('ready', 'Paused');
    this.guideOverlay.classList.remove('visible');
  }

  // ─── History / Dashboard ──────────────────────────────────────────────────────

  _finishSet() {
    if (!this.isWorkoutActive) return;

    const count = this.counters[this.exercise].count;
    if (count > 0) {
      this.db.addSet(this.exercise, count);
      this.currentSetNum++;
    }

    this._resetWorkout();
  }

  _renderCalendar() {
    const grid = this.$('heatmap-grid');
    if (!grid) return;
    grid.innerHTML = '';
    
    const today = new Date();
    const startDate = new Date();
    startDate.setDate(today.getDate() - 364);
    
    const avgVolume = this.db.getAverageVolume(7);
    
    for (let i = 0; i < 365; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      
      const dot = document.createElement('div');
      dot.className = 'heat-dot';
      
      const dayData = this.db.data[dateStr];
      if (dayData) {
        const vol = dayData.totalVolume;
        if (vol > avgVolume * 1.2 && avgVolume > 0) dot.classList.add('lvl-4'); // Improvement
        else if (vol > 100) dot.classList.add('lvl-3');
        else if (vol > 40) dot.classList.add('lvl-2');
        else dot.classList.add('lvl-1');
      } else {
        dot.classList.add('lvl-0');
      }
      
      dot.addEventListener('click', () => {
        this.$('.heat-dot.selected')?.classList.remove('selected');
        dot.classList.add('selected');
        this._showDayDetails(dateStr);
      });
      
      grid.appendChild(dot);
    }
    
    this._showDayDetails(this.db._today());
    
    // Scroll to right side (today)
    setTimeout(() => {
      const scroll = this.$('.heatmap-scroll');
      if (scroll) scroll.scrollLeft = scroll.scrollWidth;
    }, 10);
  }

  _showDayDetails(dateStr) {
    const dateEl = this.$('detail-date');
    if (!dateEl) return;
    
    const dateObj = new Date(dateStr);
    dateEl.textContent = dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    
    const statsContainer = this.$('detail-stats');
    statsContainer.innerHTML = '';
    
    const dayData = this.db.data[dateStr];
    if (!dayData || Object.keys(dayData.exercises).length === 0) {
      statsContainer.innerHTML = '<p class="empty-stats">No workouts on this date.</p>';
      return;
    }
    
    for (const [ex, stats] of Object.entries(dayData.exercises)) {
      const cfg = EXERCISE_CONFIG[ex];
      const item = document.createElement('div');
      item.className = 'detail-item';
      
      const unit = ex === 'plank' ? 'sec' : 'reps';
      
      item.innerHTML = `
        <div class="detail-icon">${cfg.icon}</div>
        <div class="detail-text">
          <div class="detail-ex">${cfg.label}</div>
          <div class="detail-vol">${Math.round(stats.volume * 10)/10} <span style="font-size:12px;color:var(--text-dim)">${unit}</span></div>
          <div class="detail-sets">${stats.sets} sets</div>
        </div>
      `;
      statsContainer.appendChild(item);
    }
  }

  _resetWorkout() {
    this.isWorkoutActive = false;
    clearInterval(this.timerInterval);
    this.counters[this.exercise].reset();
    
    if (this.exercise === 'plank') {
      this.repCountEl.textContent = '0.0';
      this.repLabelEl.textContent = 'SEC';
    } else {
      this.repCountEl.textContent = '0';
      this.repLabelEl.textContent = 'REPS';
    }
    
    this.timerEl.textContent    = '0:00';
    this.workoutStartMs         = null;

    this.startBtn.textContent = '▶ START';
    this.startBtn.classList.remove('active');
    this.setBadge.textContent = `SET ${this.currentSetNum}`;
    this._setStatus('ready', 'Ready — tap START');
    this.guideOverlay.classList.remove('visible');
    this._updateAngleDisplay(null);
    this._updatePhaseDisplay(null);
    this._updateBreathingPacer(null, null, null);
  }

  // ─── UI Updates ──────────────────────────────────────────────────────────────

  _applyExerciseTheme() {
    const cfg = EXERCISE_CONFIG[this.exercise];

    // CSS variable update
    document.documentElement.style.setProperty('--accent',      cfg.accent);
    document.documentElement.style.setProperty('--accent-glow', cfg.accentGlow);

    // Mode classes on key elements
    ['rep-bubble', 'start-btn'].forEach(id => {
      const el = this.$(id);
      if (!el) return;
      el.classList.remove('pushup-mode', 'pullup-mode', 'situp-mode', 'plank-mode');
      el.classList.add(`${this.exercise}-mode`);
    });

    if (!this.isWorkoutActive) {
      if (this.exercise === 'plank') {
        this.repCountEl.textContent = '0.0';
        this.repLabelEl.textContent = 'SEC';
      } else {
        this.repCountEl.textContent = '0';
        this.repLabelEl.textContent = 'REPS';
      }
    }

    // Guide text
    const guideText = document.querySelector('.guide-text');
    if (guideText) guideText.textContent = cfg.guide;

    // Guide icon
    const guideIcon = document.querySelector('.guide-silhouette');
    if (guideIcon) guideIcon.textContent = cfg.icon;
  }

  _setStatus(state, text) {
    this.statusDot.className  = 'status-dot ' + state;  // 'loading' | 'detecting' | 'ready' | 'error'
    this.statusText.textContent = text;
  }

  _setProgress(pct) {
    if (this.loadingBar) this.loadingBar.style.width = pct + '%';
  }

  _updateTimer() {
    if (!this.workoutStartMs) return;
    const elapsed = Math.floor((Date.now() - this.workoutStartMs) / 1000);
    this.timerEl.textContent = this._formatDuration(elapsed);
  }

  _updateAngleDisplay(val) {
    if (!this.settings.showAngle || val === null) {
      this.angleEl.textContent = '';
      return;
    }
    if (this.exercise === 'situp') {
      this.angleEl.textContent = `RATIO ${val.toFixed(2)}`;
    } else {
      this.angleEl.textContent = `∠ ${Math.round(val)}°`;
    }
  }

  _updatePhaseDisplay(phase) {
    if (!phase) {
      this.phaseEl.textContent = '—';
      this.phaseEl.style.color = 'var(--text-dim)';
      return;
    }
    const cfg = EXERCISE_CONFIG[this.exercise];
    const label = cfg.phase[phase] ?? phase.toUpperCase();
    this.phaseEl.textContent = label;
    this.phaseEl.style.color = phase === 'up' ? cfg.accent : 'var(--text-muted)';
  }

  _showPermissionScreen() {
    this.loadingScreen.style.display = 'none';
    this.permScreen.classList.add('show');
  }

  _updateBreathingPacer(exercise, phase, progress) {
    const pacer = this.$('breathing-pacer');
    const icon = this.$('breath-icon');
    const text = this.$('breath-text');
    if (!pacer) return;
    
    if (!this.isWorkoutActive || !exercise) {
      pacer.className = 'hidden';
      return;
    }

    pacer.className = ''; 
    if (exercise === 'plank') {
       // Box breathing: 4s inhale, 4s hold, 4s exhale, 4s hold
       const t = Date.now() / 1000;
       const cycle = t % 16;
       if (cycle < 4) {
         pacer.classList.add('inhale'); icon.textContent='🔵'; text.textContent='INHALE';
       } else if (cycle < 8) {
         pacer.classList.add('hold'); icon.textContent='🟢'; text.textContent='HOLD';
       } else if (cycle < 12) {
         pacer.classList.add('exhale'); icon.textContent='🔴'; text.textContent='EXHALE';
       } else {
         pacer.classList.add('hold'); icon.textContent='🟢'; text.textContent='HOLD';
       }
    } else {
       // Movement-based breathing
       if (phase === 'rest' || progress < 0.3) {
          pacer.classList.add('inhale'); icon.textContent='🔵'; text.textContent='INHALE';
       } else {
          pacer.classList.add('exhale'); icon.textContent='🔴'; text.textContent='EXHALE';
       }
    }
  }

  // ─── Audio ────────────────────────────────────────────────────────────────────

  _getAudioCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.audioCtx;
  }

  _playBeep() {
    try {
      const ctx  = this._getAudioCtx();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.12);

      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch { /* silence */ }
  }

  // ─── Settings ────────────────────────────────────────────────────────────────

  _loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('repcount-settings') || '{}');
      Object.assign(this.settings, saved);
    } catch {}
  }

  _saveSettings() {
    try {
      localStorage.setItem('repcount-settings', JSON.stringify(this.settings));
    } catch {}
  }

  _applySensitivity(val) {
    // val: 0–100. Default = 50.
    // Map to threshold adjustments: higher sensitivity = tighter (smaller) angles
    const pushCounter = this.counters.pushup;
    const pullCounter = this.counters.pullup;

    // Pushup thresholds: UP 140–165, DOWN 75–100
    pushCounter.UP_THRESHOLD   = 140 + ((val / 100) * 25);   // 140 @ 0%, 165 @ 100%
    pushCounter.DOWN_THRESHOLD = 100 - ((val / 100) * 25);   // 100 @ 0%,  75 @ 100%

    // Pullup thresholds: DOWN 130–160, UP 45–70
    pullCounter.DOWN_THRESHOLD = 130 + ((val / 100) * 30);   // 130 @ 0%, 160 @ 100%
    pullCounter.UP_THRESHOLD   = 70  - ((val / 100) * 25);   //  70 @ 0%,  45 @ 100%
  }

  // ─── UI Bindings ─────────────────────────────────────────────────────────────

  _bindUI() {
    // Exercise toggle
    document.querySelectorAll('.ex-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.isWorkoutActive) return; // don't switch mid-set
        const ex = btn.dataset.ex;
        if (ex === this.exercise) return;

        document.querySelectorAll('.ex-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.exercise = ex;
        this.repCountEl.textContent = '0';
        this._applyExerciseTheme();
        this._updatePhaseDisplay(null);
        this._updateAngleDisplay(null);
      });
    });

    // Start / Pause / Resume
    this.startBtn.addEventListener('click', () => {
      if (!this.isWorkoutActive) {
        this._startWorkout();
      } else {
        this._pauseWorkout();
      }
    });

    // Finish set button
    const finishBtn = this.$('finish-btn');
    if (finishBtn) finishBtn.addEventListener('click', () => this._finishSet());

    // Camera flip
    const flipBtn = this.$('flip-btn');
    if (flipBtn) {
      flipBtn.addEventListener('click', async () => {
        flipBtn.style.pointerEvents = 'none';
        await this._flipCamera();
        flipBtn.style.pointerEvents = '';
      });
    }

    // Panels: History (Dashboard)
    const histBtn = this.$('history-btn');
    if (histBtn) {
      histBtn.addEventListener('click', () => {
        this._renderCalendar();
        this.$('dashboard-overlay').classList.remove('hidden');
      });
    }
    const closeDashBtn = this.$('close-dashboard-btn');
    if (closeDashBtn) {
      closeDashBtn.addEventListener('click', () => {
        this.$('dashboard-overlay').classList.add('hidden');
      });
    }

    // Close panels on canvas click
    this.canvas.addEventListener('click', () => {
      this.historyPanel.classList.remove('open');
      this.settingsPanel.classList.remove('open');
    });

    // Permission button
    const permBtn = this.$('grant-camera-btn');
    if (permBtn) {
      permBtn.addEventListener('click', async () => {
        this.permScreen.classList.remove('show');
        this.loadingScreen.style.display = 'flex';
        this.loadingScreen.classList.remove('fade-out');
        this._setProgress(10);
        await this._init();
      });
    }

    // Settings: audio toggle
    const audioToggle = this.$('audio-toggle');
    if (audioToggle) {
      audioToggle.checked = this.settings.audioEnabled;
      audioToggle.addEventListener('change', () => {
        this.settings.audioEnabled = audioToggle.checked;
        this._saveSettings();
      });
    }

    // Settings: show angle toggle
    const angleToggle = this.$('angle-toggle');
    if (angleToggle) {
      angleToggle.checked = this.settings.showAngle;
      angleToggle.addEventListener('change', () => {
        this.settings.showAngle = angleToggle.checked;
        if (!this.settings.showAngle) this.angleEl.textContent = '';
        this._saveSettings();
      });
    }

    // Settings: strict mode toggle
    const strictToggle = this.$('strict-toggle');
    if (strictToggle) {
      strictToggle.checked = this.settings.strictMode;
      strictToggle.addEventListener('change', () => {
        this.settings.strictMode = strictToggle.checked;
        this._saveSettings();
      });
    }

    // Settings: sensitivity slider
    const sensSlider = this.$('sensitivity-slider');
    const sensValue  = this.$('sensitivity-value');
    if (sensSlider) {
      sensSlider.value = this.settings.sensitivity;
      if (sensValue) sensValue.textContent = this.settings.sensitivity + '%';
      sensSlider.addEventListener('input', () => {
        const val = parseInt(sensSlider.value, 10);
        this.settings.sensitivity = val;
        if (sensValue) sensValue.textContent = val + '%';
        this._applySensitivity(val);
        this._saveSettings();
      });
      this._applySensitivity(this.settings.sensitivity);
    }

    // Long-press rep count to reset
    let pressTimer = null;
    this.repBubble.addEventListener('pointerdown', () => {
      pressTimer = setTimeout(() => {
        if (this.isWorkoutActive) return;
        this.counters[this.exercise].reset();
        this.repCountEl.textContent = '0';
      }, 800);
    });
    this.repBubble.addEventListener('pointerup',    () => clearTimeout(pressTimer));
    this.repBubble.addEventListener('pointerleave', () => clearTimeout(pressTimer));
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  _formatDuration(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  window.repCountApp = new App();
});
