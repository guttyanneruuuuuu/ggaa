// ============================================================
// controls.js - タッチ/マウス操作
//   - 左: バーチャルジョイスティック(移動ベクトルmx,my)
//   - 右: アクション(つかむ/おく/調理) + ダッシュ
//   - マルチタッチ対応(両手同時操作)
//   - キーボードもサポート(PCテスト用: WASD/矢印 + Space + Shift)
//   入力は onInput(mx,my) / onAction() / onDash() / onChopHold() で通知。
// ============================================================

(function () {
  'use strict';

  class Controls {
    constructor() {
      this.move = { x: 0, y: 0 };
      this.callbacks = {};
      this.joyTouchId = null;
      this.actionBtn = document.getElementById('btn-act');
      this.dashBtn = document.getElementById('btn-dash');
      this.joystick = document.getElementById('joystick');
      this.knob = document.getElementById('joy-knob');
      this.maxDist = 52;
      this.chopHolding = false;
      this._bind();
      this._keys = {};
      this._bindKeyboard();
      this._sendLoop();
    }

    on(evt, cb) { this.callbacks[evt] = cb; }
    _emit(evt, ...a) { if (this.callbacks[evt]) this.callbacks[evt](...a); }

    _bind() {
      // ---- ジョイスティック ----
      const startJoy = (clientX, clientY, id) => {
        this.joyTouchId = id;
        const rect = this.joystick.getBoundingClientRect();
        this.joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        this._updateJoy(clientX, clientY);
      };
      const moveJoy = (clientX, clientY) => { this._updateJoy(clientX, clientY); };
      const endJoy = () => {
        this.joyTouchId = null;
        this.move = { x: 0, y: 0 };
        this.knob.style.transform = 'translate(-50%, -50%)';
      };

      // タッチ
      this.joystick.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const t = e.changedTouches[0];
        startJoy(t.clientX, t.clientY, t.identifier);
      }, { passive: false });
      window.addEventListener('touchmove', (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === this.joyTouchId) { e.preventDefault(); moveJoy(t.clientX, t.clientY); }
        }
      }, { passive: false });
      window.addEventListener('touchend', (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === this.joyTouchId) endJoy();
        }
      });
      window.addEventListener('touchcancel', (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === this.joyTouchId) endJoy();
        }
      });

      // マウス(PC)
      this.joystick.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startJoy(e.clientX, e.clientY, 'mouse');
        const mm = (ev) => moveJoy(ev.clientX, ev.clientY);
        const mu = () => { endJoy(); window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
        window.addEventListener('mousemove', mm);
        window.addEventListener('mouseup', mu);
      });

      // ---- アクションボタン ----
      const press = (el, down, up) => {
        el.addEventListener('touchstart', (e) => { e.preventDefault(); down(); }, { passive: false });
        el.addEventListener('touchend', (e) => { e.preventDefault(); up && up(); }, { passive: false });
        el.addEventListener('mousedown', (e) => { e.preventDefault(); down(); });
        el.addEventListener('mouseup', (e) => { e.preventDefault(); up && up(); });
        el.addEventListener('mouseleave', () => { up && up(); });
      };

      press(this.actionBtn, () => {
        this._emit('action');
        // 長押しでチョップ進行を続ける
        this.chopHolding = true;
      }, () => { this.chopHolding = false; });

      press(this.dashBtn, () => { this._emit('dash'); }, null);
    }

    _updateJoy(clientX, clientY) {
      if (!this.joyCenter) return;
      let dx = clientX - this.joyCenter.x;
      let dy = clientY - this.joyCenter.y;
      const dist = Math.hypot(dx, dy);
      if (dist > this.maxDist) { dx = dx / dist * this.maxDist; dy = dy / dist * this.maxDist; }
      this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      this.move = { x: dx / this.maxDist, y: dy / this.maxDist };
    }

    _bindKeyboard() {
      window.addEventListener('keydown', (e) => {
        if (e.repeat) {
          if (e.code === 'Space' || e.code === 'KeyE') return; // 連射防止
        }
        this._keys[e.code] = true;
        if (e.code === 'Space' || e.code === 'KeyE') {
          this._emit('action');
          this.chopHolding = true;
        }
        if (e.code === 'ShiftLeft' || e.code === 'KeyJ') this._emit('dash');
      });
      window.addEventListener('keyup', (e) => {
        this._keys[e.code] = false;
        if (e.code === 'Space' || e.code === 'KeyE') this.chopHolding = false;
      });
    }

    _readKeyboard() {
      let x = 0, y = 0;
      if (this._keys['KeyA'] || this._keys['ArrowLeft']) x -= 1;
      if (this._keys['KeyD'] || this._keys['ArrowRight']) x += 1;
      if (this._keys['KeyW'] || this._keys['ArrowUp']) y -= 1;
      if (this._keys['KeyS'] || this._keys['ArrowDown']) y += 1;
      return { x, y };
    }

    // 30fpsで入力を送信
    _sendLoop() {
      let lastChop = 0;
      const tick = () => {
        let mx = this.move.x, my = this.move.y;
        const kb = this._readKeyboard();
        if (kb.x || kb.y) {
          const m = Math.hypot(kb.x, kb.y) || 1;
          mx = kb.x / m; my = kb.y / m;
        }
        this._emit('input', { mx, my });

        // チョップ長押し送信
        if (this.chopHolding) {
          const now = performance.now();
          if (now - lastChop > 30) { this._emit('chopHold'); lastChop = now; }
        }
        this._raf = requestAnimationFrame(tick);
      };
      tick();
    }

    setDashCooldown(active) {
      if (active) this.dashBtn.classList.add('cooldown');
      else this.dashBtn.classList.remove('cooldown');
    }
  }

  window.Controls = Controls;
})();
