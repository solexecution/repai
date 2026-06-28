class VoiceAssistant {
  constructor(app) {
    this.app = app;
    this.isActive = false;
    this.indicator = document.getElementById('voice-indicator');
    this.toast = document.getElementById('voice-toast');
    this.toastTimeout = null;
    
    this.model = null;
    this.recognizer = null;
    this.audioContext = null;
    this.mediaStreamSource = null;
    this.scriptNode = null;
    this.stream = null;
    this.isModelLoaded = false;
  }

  isSupported() {
    return true; // We are forcing offline WASM
  }

  async initModel() {
    if (this.isModelLoaded) return;
    try {
      if (this.indicator) {
        this.indicator.classList.remove('voice-inactive');
        this.indicator.classList.add('voice-loading');
        this.indicator.title = 'Voice Model Loading...';
      }
      this._showToast('Loading Offline Voice Model... (may take a moment)');
      
      // Ensure Vosk is loaded
      if (typeof window.Vosk === 'undefined') {
        throw new Error("Vosk library not loaded");
      }

      // Fetch the model with progress
      const url = './vosk/vosk-model-small-en-us-0.15.tar.gz';
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch model: ${response.statusText}`);
      
      const contentLength = response.headers.get('content-length');
      const total = parseInt(contentLength, 10);
      let loaded = 0;
      
      const progressContainer = document.getElementById('voice-download-progress');
      const progressFill = document.getElementById('voice-progress-fill');
      const progressText = document.getElementById('voice-progress-text');
      
      if (progressContainer) progressContainer.classList.remove('hidden');

      const reader = response.body.getReader();
      const chunks = [];
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total && progressFill && progressText) {
          const percent = Math.round((loaded / total) * 100);
          progressFill.style.width = `${percent}%`;
          progressText.textContent = `${percent}%`;
        }
      }
      
      // Download complete — now extracting and loading into WASM (this takes 10-30s)
      if (progressFill) {
        progressFill.style.width = '100%';
        progressFill.classList.add('preparing'); // triggers shimmer animation
      }
      if (progressText) progressText.textContent = 'Loading…';

      const progressLabel = document.getElementById('voice-progress-label');
      if (progressLabel) progressLabel.textContent = 'Preparing Voice AI…';

      const blob = new Blob(chunks);
      const blobUrl = URL.createObjectURL(blob);

      // Initialize the model from the fetched blob url
      this.model = await window.Vosk.createModel(blobUrl);
      this.recognizer = new this.model.KaldiRecognizer(16000);
      this.recognizer.setWords(true);
      
      // Now fully ready — hide progress bar
      if (progressContainer) progressContainer.classList.add('hidden');

      this.isModelLoaded = true;
      if (this.indicator) {
        this.indicator.classList.remove('voice-loading');
      }
      this._showToast('Voice Ready ✓');
    } catch(err) {
      console.error("Vosk initialization error", err);
      if (this.indicator) {
        this.indicator.classList.remove('voice-loading');
        this.indicator.classList.add('voice-inactive');
        this.indicator.title = 'Voice Error';
      }
      this._showToast('Failed to load voice model');
      throw err;
    }
  }

  async start(stream) {
    if (this.isActive) return;
    try {
      this.stream = stream;
      // Create audio context immediately during user gesture to prevent suspension!
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      
      if (!this.isModelLoaded) {
        await this.initModel();
      }
      
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // ── Wire Vosk event listeners BEFORE sending audio ────────────────────
      // Vosk is fully event-driven — results come via events, NOT by calling result()
      this.recognizer.on('result', (message) => {
        const text = message?.result?.text || '';
        if (text.trim()) {
          console.log('Vosk result:', text);
          this._parseCommand(text.toLowerCase().trim());
        }
      });

      this.recognizer.on('partialresult', (message) => {
        const partial = message?.result?.partial || '';
        if (partial && this.indicator) {
          this.indicator.title = `Hearing: "${partial}"`;
        }
      });
      
      this.mediaStreamSource = this.audioContext.createMediaStreamSource(this.stream);
      
      this.scriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.scriptNode.onaudioprocess = (event) => {
        if (!this.isActive) return;
        try {
          const float32Array = event.inputBuffer.getChannelData(0);
          
          // Calculate volume for visual pulsing indicator
          let sum = 0;
          for (let i = 0; i < float32Array.length; i++) sum += float32Array[i] * float32Array[i];
          const rms = Math.sqrt(sum / float32Array.length);
          const vol = Math.min(1, rms * 15);
          
          if (this.indicator) {
            this.indicator.style.boxShadow = `0 0 ${10 + vol * 30}px rgba(255, 51, 102, ${0.4 + vol})`;
          }

          // Send audio to Vosk worker — results come back via the 'result' event above
          const mockAudioBuffer = {
            numberOfChannels: 1,
            sampleRate: this.audioContext.sampleRate,
            getChannelData: () => float32Array
          };
          this.recognizer.acceptWaveform(mockAudioBuffer);

        } catch(e) {
          console.error('Error processing audio', e);
        }
      };
      
      this.mediaStreamSource.connect(this.scriptNode);
      this.scriptNode.connect(this.audioContext.destination);
      
      this.isActive = true;
      if (this.indicator) {
        this.indicator.classList.remove('voice-loading');
        this.indicator.classList.remove('voice-inactive');
        this.indicator.classList.add('voice-active');
        this.indicator.title = 'Voice Commands (Listening)';
      }
      this._showToast('Voice Assistant Active');
    } catch (e) {
      console.error('Microphone access denied or error', e);
      if (this.indicator) {
        this.indicator.classList.remove('voice-loading');
        this.indicator.classList.add('voice-inactive');
      }
      this._showToast('Microphone error or Model failed');
    }
  }

  stop() {
    if (!this.isActive) return;
    this.isActive = false;
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.mediaStreamSource.disconnect();
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.scriptNode = null;
    this.mediaStreamSource = null;
    // NOTE: Do NOT stop the stream.getTracks() here — the mic stream is managed by app._startMic()
    if (this.indicator) {
      this.indicator.classList.remove('voice-active');
      this.indicator.title = 'Voice Commands (Disabled)';
    }
    this._showToast('Voice Assistant Paused');
  }

  _showToast(msg) {
    if (!this.toast) return;
    this.toast.textContent = msg;
    this.toast.classList.remove('hidden');
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      this.toast.classList.add('hidden');
    }, 3000);
  }

  _parseCommand(cmd) {
    let handled = false;
    console.log("Offline Voice Command parsed:", cmd);

    if (cmd.includes('start') || cmd.includes('begin') || cmd.includes('go')) {
      if (!this.app.isWorkoutActive) this.app._startWorkout();
      handled = true;
    }
    else if (cmd.includes('pause') || cmd.includes('stop')) {
      if (this.app.isWorkoutActive) this.app._pauseWorkout();
      handled = true;
    }
    else if (cmd.includes('reset') || cmd.includes('finish') || cmd.includes('done') || cmd.includes('restart')) {
      this.app._finishSet();
      handled = true;
    }

    else if (cmd.includes('push up') || cmd.includes('pushup')) {
      document.getElementById('btn-pushup').click();
      handled = true;
    }
    else if (cmd.includes('pull up') || cmd.includes('pullup')) {
      document.getElementById('btn-pullup').click();
      handled = true;
    }
    else if (cmd.includes('sit up') || cmd.includes('situp')) {
      document.getElementById('btn-situp').click();
      handled = true;
    }
    else if (cmd.includes('squat') || cmd.includes('squad')) {
      document.getElementById('btn-squat').click();
      handled = true;
    }
    else if (cmd.includes('plank')) {
      document.getElementById('btn-plank').click();
      handled = true;
    }

    else if (cmd.includes('hide camera')) {
      this.app.setLayout('reference');
      handled = true;
    }
    else if (cmd.includes('hide video') || cmd.includes('hide reference')) {
      this.app.setLayout('camera');
      handled = true;
    }
    else if (cmd.includes('split') || cmd.includes('show both') || cmd.includes('both')) {
      this.app.setLayout('split');
      handled = true;
    }
    else if (cmd.includes('picture in picture') || cmd.includes('pip') || cmd.includes('floating')) {
      this.app.setLayout('pip');
      handled = true;
    }
    else if (cmd.includes('flip video') || cmd.includes('swap video')) {
      const btn = document.getElementById('layout-btn');
      if (btn) btn.click();
      handled = true;
    }
    else if (cmd.includes('privacy') || cmd.includes('hide me')) {
      const toggle = document.getElementById('privacy-toggle');
      if (toggle && !toggle.checked) toggle.click();
      handled = true;
    }
    else if (cmd.includes('show me')) {
      const toggle = document.getElementById('privacy-toggle');
      if (toggle && toggle.checked) toggle.click();
      handled = true;
    }
    else if (cmd.includes('show camera')) {
      this.app.setLayout('split');
      handled = true;
    }
    else if (cmd.includes('show video') || cmd.includes('show reference')) {
      this.app.setLayout('split');
      handled = true;
    }

    if (handled) {
      this._showToast(`Command: "${cmd}"`);
    }
  }
}
