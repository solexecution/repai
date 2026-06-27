class VoiceAssistant {
  constructor(app) {
    this.app = app;
    this.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = null;
    this.isActive = false;
    this.indicator = document.getElementById('voice-indicator');
    this.toast = document.getElementById('voice-toast');
    this.toastTimeout = null;

    if (this.SpeechRecognition) {
      this.recognition = new this.SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = false;
      this.recognition.lang = 'en-US';

      this.recognition.onresult = this._handleResult.bind(this);
      this.recognition.onerror = this._handleError.bind(this);
      this.recognition.onend = this._handleEnd.bind(this);
    } else {
      console.warn("Speech Recognition API not supported in this browser.");
    }
  }

  isSupported() {
    return !!this.SpeechRecognition;
  }

  start() {
    if (!this.recognition || this.isActive) return;
    try {
      this.recognition.start();
      this.isActive = true;
      if (this.indicator) {
        this.indicator.classList.add('voice-active');
        this.indicator.title = 'Voice Commands (Listening)';
      }
      this._showToast('🎙️ Voice Assistant Active');
    } catch (e) {
      console.error('Speech recognition error', e);
    }
  }

  stop() {
    if (!this.recognition || !this.isActive) return;
    this.isActive = false;
    this.recognition.stop();
    if (this.indicator) {
      this.indicator.classList.remove('voice-active');
      this.indicator.title = 'Voice Commands (Disabled)';
    }
    this._showToast('Voice Assistant Paused');
  }

  _handleResult(event) {
    const lastResult = event.results[event.results.length - 1];
    if (lastResult.isFinal) {
      const command = lastResult[0].transcript.toLowerCase().trim();
      this._parseCommand(command);
    }
  }

  _handleError(event) {
    console.error('Speech Recognition Error:', event.error);
    if (event.error === 'not-allowed') {
      this.stop();
      this._showToast('Microphone access denied');
      const toggle = document.getElementById('voice-toggle');
      if (toggle) toggle.checked = false;
    }
  }

  _handleEnd() {
    if (this.isActive) {
      setTimeout(() => {
        if (this.isActive) {
          try { this.recognition.start(); } catch(e){}
        }
      }, 500);
    }
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
    console.log("Voice Command parsed:", cmd);

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
      this._showToast(`🔊 "${cmd}"`);
    }
  }
}
