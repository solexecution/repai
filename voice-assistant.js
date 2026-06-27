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
      this._showToast('Loading Offline Voice Model... (may take a moment)');
      
      // Ensure Vosk is loaded
      if (typeof window.Vosk === 'undefined') {
        throw new Error("Vosk library not loaded");
      }

      // Initialize the model from the local directory
      this.model = await window.Vosk.createModel('./vosk/vosk-model-small-en-us-0.15');
      this.recognizer = new this.model.KaldiRecognizer(16000);
      this.recognizer.setWords(true);
      
      this.recognizer.on("result", (message) => {
        const res = message.result;
        if (res && res.text) {
          this._parseCommand(res.text.toLowerCase().trim());
        }
      });
      
      this.isModelLoaded = true;
      this._showToast('Voice Model Loaded!');
    } catch(err) {
      console.error("Vosk initialization error", err);
      this._showToast('Failed to load voice model');
    }
  }

  async start() {
    if (this.isActive) return;
    try {
      if (!this.isModelLoaded) {
        await this.initModel();
      }
      
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 16000
        } 
      });
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      this.mediaStreamSource = this.audioContext.createMediaStreamSource(this.stream);
      
      this.scriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.scriptNode.onaudioprocess = (event) => {
        if (!this.isActive) return;
        try {
          this.recognizer.acceptWaveform(event.inputBuffer.getChannelData(0));
        } catch(e) {
          console.error("Error processing audio", e);
        }
      };
      
      this.mediaStreamSource.connect(this.scriptNode);
      this.scriptNode.connect(this.audioContext.destination);
      
      this.isActive = true;
      if (this.indicator) {
        this.indicator.classList.add('voice-active');
        this.indicator.title = 'Voice Commands (Listening)';
      }
      this._showToast('Voice Assistant Active');
    } catch (e) {
      console.error('Microphone access denied or error', e);
      this._showToast('Microphone error');
      const toggle = document.getElementById('voice-toggle');
      if (toggle) toggle.checked = false;
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
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
    }
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
