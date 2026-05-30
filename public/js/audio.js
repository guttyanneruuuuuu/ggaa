// ============================================================
// audio.js - WebAudioで効果音/BGMを合成(外部ファイル不要)
//   ポップで軽快な効果音をその場で生成。
//   モバイルのオーディオ制限対策として、最初のタッチで初期化。
// ============================================================

(function () {
  'use strict';

  class AudioFX {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.bgmGain = null;
      this.enabled = true;
      this.bgmTimer = null;
      this._initOnGesture();
    }

    _initOnGesture() {
      const init = () => {
        if (this.ctx) return;
        try {
          this.ctx = new (window.AudioContext || window.webkitAudioContext)();
          this.master = this.ctx.createGain();
          this.master.gain.value = 0.5;
          this.master.connect(this.ctx.destination);
          this.bgmGain = this.ctx.createGain();
          this.bgmGain.gain.value = 0.16;
          this.bgmGain.connect(this.master);
        } catch (e) { /* noop */ }
      };
      ['touchstart', 'mousedown', 'keydown'].forEach(ev =>
        window.addEventListener(ev, init, { once: false }));
    }

    _resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

    tone(freq, dur, type = 'sine', vol = 0.3, slide = 0) {
      if (!this.ctx || !this.enabled) return;
      this._resume();
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, this.ctx.currentTime);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), this.ctx.currentTime + dur);
      g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(vol, this.ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
      o.connect(g); g.connect(this.master);
      o.start(); o.stop(this.ctx.currentTime + dur + 0.02);
    }

    // 効果音プリセット
    pickup()  { this.tone(520, 0.08, 'square', 0.18, 120); }
    place()   { this.tone(300, 0.08, 'triangle', 0.16, -60); }
    chop()    { this.tone(180 + Math.random()*40, 0.05, 'square', 0.12, -40); }
    cook()    { this.tone(660, 0.12, 'sine', 0.14, 200); }
    serve()   { // 成功ファンファーレ
      const seq = [523, 659, 784, 1046];
      seq.forEach((f, i) => setTimeout(() => this.tone(f, 0.14, 'triangle', 0.22), i * 70));
    }
    combo(n)  { this.tone(700 + n * 60, 0.16, 'sawtooth', 0.18, 200); }
    fail()    { this.tone(200, 0.3, 'sawtooth', 0.2, -120); }
    dash()    { this.tone(420, 0.12, 'sine', 0.14, 380); }
    button()  { this.tone(440, 0.07, 'square', 0.15, 80); }
    countdown(){ this.tone(660, 0.15, 'square', 0.25); }
    go()      { this.tone(880, 0.4, 'sawtooth', 0.28, 200); }
    win()     { [523,659,784,1046,1318].forEach((f,i)=>setTimeout(()=>this.tone(f,0.2,'triangle',0.25),i*110)); }
    lose()    { [400,360,300,240].forEach((f,i)=>setTimeout(()=>this.tone(f,0.25,'sawtooth',0.2),i*150)); }

    // 軽快なループBGM(簡易アルペジオ)
    startBGM() {
      if (!this.ctx || this.bgmTimer) return;
      this._resume();
      const scale = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63]; // C E G C ...
      const bass = [130.81, 130.81, 196.0, 174.61];
      let step = 0;
      const beat = 0.22;
      this.bgmTimer = setInterval(() => {
        if (!this.enabled || !this.ctx) return;
        const t = this.ctx.currentTime;
        // メロディ
        const f = scale[step % scale.length];
        this._bgmNote(f, beat * 0.9, 'triangle', 0.5);
        // ベース(2拍ごと)
        if (step % 2 === 0) this._bgmNote(bass[(step / 2) % bass.length], beat * 1.8, 'sine', 0.7);
        step++;
      }, beat * 1000);
    }

    _bgmNote(freq, dur, type, vol) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(vol * 0.5, this.ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
      o.connect(g); g.connect(this.bgmGain);
      o.start(); o.stop(this.ctx.currentTime + dur + 0.02);
    }

    stopBGM() {
      if (this.bgmTimer) { clearInterval(this.bgmTimer); this.bgmTimer = null; }
    }

    toggle() {
      this.enabled = !this.enabled;
      return this.enabled;
    }
  }

  window.audioFX = new AudioFX();
})();
