// ============================================================
// render.js - 2.5D風 Canvas 描画エンジン
//   トップダウンのワールド座標に「擬似的な高さ(厚み)」を付与し、
//   ブロスタのような立体的でポップな見た目を作る。
//   - タイル床: 市松模様 + 縁の影
//   - 壁/カウンター/設備: 上面 + 側面(厚み) で立体表現
//   - キャラ: 丸い影 + 体 + コック帽 + 持ち物
// ============================================================

(function () {
  'use strict';

  // 食材/料理の見た目定義(色とラベル)
  const INGREDIENT_VIS = {
    tomato:  { color: '#e63946', emoji: '🍅' },
    lettuce: { color: '#7bc043', emoji: '🥬' },
    onion:   { color: '#e9c46a', emoji: '🧅' },
    meat:    { color: '#c1440e', emoji: '🥩' },
    fish:    { color: '#a8dadc', emoji: '🐟' },
    rice:    { color: '#f1faee', emoji: '🍚' },
    bread:   { color: '#d4a373', emoji: '🍞' },
    potato:  { color: '#e9c46a', emoji: '🥔' },
  };
  const STATE_EMOJI = { raw: '', chopped: '🔪', cooked: '🔥', burnt: '💀' };

  const RECIPE_EMOJI = {
    salad: '🥗', onionSalad: '🥗', burger: '🍔', steak: '🍖', sushi: '🍣', riceBowl: '🍲',
  };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.cam = { x: 0, y: 0, scale: 48 }; // scale = 1タイルあたりpx
      this.lift = 0.42;   // 高さ係数(1タイルの厚み割合)
      this.t = 0;
      this.particles = [];
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    resize() {
      const w = window.innerWidth, h = window.innerHeight;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.vw = w; this.vh = h;
    }

    // ワールド→スクリーン。yに応じてわずかに上へずらし疑似3D感を出す
    fitCamera(state) {
      // マップ全体を画面に収める
      const cols = state.cols, rows = state.rows;
      const margin = 1.0;
      const availW = this.vw - 24;
      const availH = this.vh - 120; // 上部HUD分
      const scaleX = availW / (cols + margin);
      const scaleY = availH / (rows + margin + this.lift);
      this.cam.scale = Math.max(20, Math.min(scaleX, scaleY));
      const s = this.cam.scale;
      const worldW = cols * s;
      const worldH = rows * s;
      this.originX = (this.vw - worldW) / 2;
      this.originY = (this.vh - worldH) / 2 + 18;
    }

    w2s(wx, wy, wz = 0) {
      const s = this.cam.scale;
      return {
        x: this.originX + wx * s,
        y: this.originY + wy * s - wz * s * this.lift,
      };
    }

    addParticles(wx, wy, color, count = 10, opts = {}) {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (opts.speed || 2) * (0.4 + Math.random());
        this.particles.push({
          x: wx, y: wy, z: opts.z || 0.4,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: 2 + Math.random() * 2,
          life: opts.life || 0.7, max: opts.life || 0.7,
          color, size: (opts.size || 5) * (0.6 + Math.random() * 0.8),
          text: opts.text || null,
        });
      }
    }

    updateParticles(dt) {
      for (const p of this.particles) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vz -= 9 * dt; p.z += p.vz * dt;
        if (p.z < 0) { p.z = 0; p.vz *= -0.4; p.vx *= 0.6; p.vy *= 0.6; }
        p.life -= dt;
      }
      this.particles = this.particles.filter(p => p.life > 0);
    }

    // メイン描画
    draw(state, youId, dt) {
      this.t += dt;
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.vw, this.vh);

      // 背景グラデ
      const bg = ctx.createLinearGradient(0, 0, 0, this.vh);
      bg.addColorStop(0, '#241546');
      bg.addColorStop(1, '#0e0820');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, this.vw, this.vh);

      if (!state || !state.cols) return;
      this.fitCamera(state);
      this.updateParticles(dt);

      // 床描画
      this.drawFloor(state);

      // 描画オブジェクトを集めてY順ソート(奥→手前)で疑似3D重なり
      const drawables = [];
      for (const st of state.stations) {
        drawables.push({ kind: 'station', y: st.gy, gx: st.gx, data: st });
      }
      for (const p of state.players) {
        drawables.push({ kind: 'player', y: p.y, data: p });
      }
      // パーティクルも
      for (const pt of this.particles) {
        drawables.push({ kind: 'particle', y: pt.y, data: pt });
      }
      drawables.sort((a, b) => a.y - b.y);

      for (const d of drawables) {
        if (d.kind === 'station') this.drawStation(d.data, state);
        else if (d.kind === 'player') this.drawPlayer(d.data, youId === d.data.id);
        else if (d.kind === 'particle') this.drawParticle(d.data);
      }
    }

    drawFloor(state) {
      const ctx = this.ctx;
      const s = this.cam.scale;
      for (let y = 0; y < state.rows; y++) {
        for (let x = 0; x < state.cols; x++) {
          // 設備があるタイルは床も描く(下地)
          const p = this.w2s(x, y);
          const even = (x + y) % 2 === 0;
          ctx.fillStyle = even ? '#3f3066' : '#372a5c';
          ctx.fillRect(p.x, p.y, s + 0.6, s + 0.6);
          // タイル目地
          ctx.strokeStyle = 'rgba(0,0,0,0.12)';
          ctx.lineWidth = 1;
          ctx.strokeRect(p.x + 0.5, p.y + 0.5, s, s);
        }
      }
      // 外周の床に柔らかいビネット
      const g = ctx.createRadialGradient(
        this.originX + state.cols * s / 2, this.originY + state.rows * s / 2, s,
        this.originX + state.cols * s / 2, this.originY + state.rows * s / 2, state.cols * s
      );
      g.addColorStop(0, 'rgba(255,255,255,0.04)');
      g.addColorStop(1, 'rgba(0,0,0,0.3)');
      ctx.fillStyle = g;
      ctx.fillRect(this.originX, this.originY, state.cols * s, state.rows * s);
    }

    // 立方体(厚みのあるブロック)を描く。上面色・側面色を指定
    drawBlock(gx, gy, h, topColor, sideColor, inset = 0.04) {
      const ctx = this.ctx;
      const s = this.cam.scale;
      const x0 = gx + inset, y0 = gy + inset, x1 = gx + 1 - inset, y1 = gy + 1 - inset;
      const topTL = this.w2s(x0, y0, h);
      const topTR = this.w2s(x1, y0, h);
      const topBR = this.w2s(x1, y1, h);
      const topBL = this.w2s(x0, y1, h);
      const botBL = this.w2s(x0, y1, 0);
      const botBR = this.w2s(x1, y1, 0);
      const botTR = this.w2s(x1, y0, 0);

      // 接地影
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      const sh = this.w2s(x0 - 0.04, y1 + 0.02, 0);
      ctx.ellipse(sh.x + s * 0.5, sh.y, s * 0.52, s * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();

      // 右側面
      ctx.fillStyle = shade(sideColor, -22);
      ctx.beginPath();
      ctx.moveTo(topTR.x, topTR.y); ctx.lineTo(topBR.x, topBR.y);
      ctx.lineTo(botBR.x, botBR.y); ctx.lineTo(botTR.x, botTR.y);
      ctx.closePath(); ctx.fill();

      // 前側面
      ctx.fillStyle = sideColor;
      ctx.beginPath();
      ctx.moveTo(topBL.x, topBL.y); ctx.lineTo(topBR.x, topBR.y);
      ctx.lineTo(botBR.x, botBR.y); ctx.lineTo(botBL.x, botBL.y);
      ctx.closePath(); ctx.fill();

      // 上面
      ctx.fillStyle = topColor;
      ctx.beginPath();
      ctx.moveTo(topTL.x, topTL.y); ctx.lineTo(topTR.x, topTR.y);
      ctx.lineTo(topBR.x, topBR.y); ctx.lineTo(topBL.x, topBL.y);
      ctx.closePath(); ctx.fill();
      // 上面ハイライト
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      return { topTL, topTR, topBR, topBL, cx: (topTL.x + topBR.x) / 2, cy: (topTL.y + topBR.y) / 2 };
    }

    drawStation(st, state) {
      const ctx = this.ctx;
      const s = this.cam.scale;
      let top, side, h = 0.5;
      switch (st.type) {
        case 'wall':    top = '#5a4a86'; side = '#3a2d5e'; h = 0.85; break;
        case 'counter': top = '#caa472'; side = '#9c7b4f'; h = 0.5; break;
        case 'cutting': top = '#e8d9b8'; side = '#b59a6a'; h = 0.5; break;
        case 'stove':   top = '#4a4a52'; side = '#2e2e36'; h = 0.5; break;
        case 'plates':  top = '#d8e8f0'; side = '#a5bcc9'; h = 0.5; break;
        case 'serve':   top = '#ffd23f'; side = '#c79e23'; h = 0.5; break;
        case 'trash':   top = '#556070'; side = '#333b47'; h = 0.5; break;
        case 'crate':   top = '#a9743f'; side = '#7a5026'; h = 0.62; break;
        default:        top = '#6a5a96'; side = '#473a6e'; h = 0.8;
      }
      const face = this.drawBlock(st.gx, st.gy, h, top, side);
      const cx = (face.topTL.x + face.topBR.x) / 2;
      const cy = (face.topTL.y + face.topBR.y) / 2;

      // 設備ごとのアイコン/装飾
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const fs = s * 0.5;
      ctx.font = `${fs}px sans-serif`;

      if (st.type === 'crate') {
        const vis = INGREDIENT_VIS[st.kind];
        // 箱のフタ表現
        ctx.font = `${s * 0.46}px sans-serif`;
        ctx.fillText(vis ? vis.emoji : '📦', cx, cy - s * 0.02);
      } else if (st.type === 'serve') {
        ctx.font = `${s * 0.46}px sans-serif`;
        ctx.fillText('🍽️', cx, cy);
        // 矢印アニメ
        const off = Math.sin(this.t * 4) * 2;
        ctx.fillStyle = 'rgba(58,33,104,0.6)';
        ctx.font = `${s * 0.3}px sans-serif`;
      } else if (st.type === 'trash') {
        ctx.font = `${s * 0.46}px sans-serif`;
        ctx.fillText('🗑️', cx, cy);
      } else if (st.type === 'plates') {
        // 皿の積み重ね
        ctx.fillStyle = '#fff';
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.ellipse(cx, cy - i * 2 - s*0.04, s * 0.28, s * 0.1, 0, 0, Math.PI * 2);
          ctx.fillStyle = i % 2 ? '#eef4f8' : '#fff';
          ctx.fill();
          ctx.strokeStyle = '#b9cdd9'; ctx.lineWidth = 1; ctx.stroke();
        }
      } else if (st.type === 'stove') {
        // バーナー
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.26, 0, Math.PI * 2);
        ctx.fillStyle = '#1d1d22'; ctx.fill();
        if (st.cooking && st.item) {
          // 炎ゆらぎ
          for (let i = 0; i < 5; i++) {
            const fa = (this.t * 6 + i) ;
            const fx = cx + Math.cos(i * 1.3) * s * 0.12;
            const fy = cy + s * 0.06 + Math.sin(fa) * 2;
            ctx.beginPath();
            ctx.fillStyle = i % 2 ? '#ff8a1e' : '#ffd23f';
            ctx.arc(fx, fy, s * 0.07, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // ステーション上のアイテム
      if (st.item) {
        this.drawItem(st.item, cx, cy - s * 0.12, s * 0.62);
        // チョップ進行バー
        if (st.type === 'cutting' && st.item.type === 'ingredient' && st.item.state === 'raw') {
          this.drawProgressBar(cx, cy - s * 0.5, s * 0.7, st.chop / 2.0, '#37c4f0');
        }
        // 調理進行
        if (st.type === 'stove' && st.cooking) {
          this.drawProgressBar(cx, cy - s * 0.5, s * 0.7, st.cook / 5.0, '#7be06b');
        } else if (st.type === 'stove' && st.item.state === 'cooked') {
          const danger = st.burn / 6.0;
          if (danger > 0.4) this.drawProgressBar(cx, cy - s * 0.5, s * 0.7, danger, '#ff5d73');
        }
      }
    }

    drawProgressBar(cx, cy, w, ratio, color) {
      const ctx = this.ctx;
      ratio = Math.max(0, Math.min(1, ratio));
      const h = 6;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      roundRect(ctx, cx - w / 2, cy, w, h, 3); ctx.fill();
      ctx.fillStyle = color;
      roundRect(ctx, cx - w / 2, cy, w * ratio, h, 3); ctx.fill();
    }

    // 持てるアイテム(食材/皿)
    drawItem(item, cx, cy, size) {
      const ctx = this.ctx;
      if (item.type === 'ingredient') {
        const vis = INGREDIENT_VIS[item.kind] || { emoji: '❓', color: '#888' };
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        // 焦げ
        if (item.state === 'burnt') {
          ctx.font = `${size}px sans-serif`;
          ctx.fillText('💀', cx, cy);
          return;
        }
        ctx.font = `${size}px sans-serif`;
        ctx.fillText(vis.emoji, cx, cy);
        // 状態バッジ
        const badge = STATE_EMOJI[item.state];
        if (badge) {
          ctx.font = `${size * 0.5}px sans-serif`;
          ctx.fillText(badge, cx + size * 0.34, cy - size * 0.3);
        }
      } else if (item.type === 'plate') {
        // 皿
        ctx.beginPath();
        ctx.ellipse(cx, cy + size * 0.05, size * 0.5, size * 0.2, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.strokeStyle = '#b9cdd9'; ctx.lineWidth = 1.5; ctx.stroke();
        // 中身
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const n = item.contents.length;
        item.contents.forEach((c, i) => {
          const vis = INGREDIENT_VIS[c.kind] || { emoji: '❓' };
          const ox = (i - (n - 1) / 2) * size * 0.28;
          ctx.font = `${size * 0.46}px sans-serif`;
          ctx.fillText(vis.emoji, cx + ox, cy - size * 0.08);
        });
      }
    }

    drawPlayer(p, isYou) {
      const ctx = this.ctx;
      const s = this.cam.scale;
      const bob = Math.sin(this.t * 8 + p.x + p.y) * (Math.hypot(p.facing.x, p.facing.y) > 0 ? 0.02 : 0.008);
      const base = this.w2s(p.x, p.y, 0);
      const bodyH = 0.62 + bob;
      const top = this.w2s(p.x, p.y, bodyH);

      // 影
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.ellipse(base.x, base.y, s * 0.3, s * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();

      // 体(カプセル風) - 側面の柱
      const r = s * 0.26;
      ctx.fillStyle = shade(p.color, -28);
      ctx.beginPath();
      ctx.moveTo(base.x - r, base.y);
      ctx.lineTo(base.x - r, top.y);
      ctx.lineTo(base.x + r, top.y);
      ctx.lineTo(base.x + r, base.y);
      ctx.closePath();
      ctx.fill();
      // 体 上の丸
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(top.x, top.y, r, 0, Math.PI * 2);
      ctx.fill();
      // 底の丸
      ctx.beginPath();
      ctx.arc(base.x, base.y, r, 0, Math.PI * 2);
      ctx.fillStyle = shade(p.color, -10);
      ctx.fill();
      // 体ハイライト
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.arc(top.x - r * 0.35, top.y - r * 0.35, r * 0.3, 0, Math.PI * 2);
      ctx.fill();

      // コック帽
      const hatY = top.y - r * 0.9;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(top.x, hatY, r * 0.85, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(top.x - r*0.4, hatY - r*0.2, r*0.4, 0, Math.PI*2);
      ctx.arc(top.x + r*0.4, hatY - r*0.2, r*0.4, 0, Math.PI*2);
      ctx.arc(top.x, hatY - r*0.45, r*0.45, 0, Math.PI*2);
      ctx.fill();
      // 帽子バンド(プレイヤー色)
      ctx.fillStyle = p.color;
      ctx.fillRect(top.x - r * 0.8, hatY + r * 0.25, r * 1.6, r * 0.22);

      // 目(向きで位置調整)
      const ex = p.facing.x * r * 0.25;
      const ey = p.facing.y * r * 0.18;
      ctx.fillStyle = '#2a2a3a';
      ctx.beginPath();
      ctx.arc(top.x - r * 0.3 + ex, top.y + ey, r * 0.12, 0, Math.PI * 2);
      ctx.arc(top.x + r * 0.3 + ex, top.y + ey, r * 0.12, 0, Math.PI * 2);
      ctx.fill();

      // 自分マーカー(矢印)
      if (isYou) {
        const ay = hatY - r * 1.4 + Math.sin(this.t * 4) * 3;
        ctx.fillStyle = '#ffd23f';
        ctx.beginPath();
        ctx.moveTo(top.x, ay + 12);
        ctx.lineTo(top.x - 8, ay);
        ctx.lineTo(top.x + 8, ay);
        ctx.closePath();
        ctx.fill();
      }

      // 持ち物(頭の少し前)
      if (p.holding) {
        const hx = top.x + p.facing.x * r * 0.4;
        const hy = top.y - r * 0.2 + p.facing.y * r * 0.2;
        this.drawItem(p.holding, hx, hy, s * 0.55);
      }

      // 名前
      ctx.font = `bold ${Math.max(10, s*0.22)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      const ny = base.y + s * 0.42;
      ctx.strokeText(p.name, base.x, ny);
      ctx.fillStyle = p.isAI ? '#9fe0ff' : '#fff';
      ctx.fillText(p.name, base.x, ny);

      // エモート
      if (p.emote) {
        ctx.font = `${s * 0.5}px sans-serif`;
        ctx.fillText(p.emote, top.x, hatY - r * 1.0);
      }
    }

    drawParticle(pt) {
      const ctx = this.ctx;
      const pos = this.w2s(pt.x, pt.y, pt.z);
      const a = pt.life / pt.max;
      ctx.globalAlpha = Math.max(0, a);
      if (pt.text) {
        ctx.font = `bold ${pt.size * 3}px sans-serif`;
        ctx.fillStyle = pt.color;
        ctx.textAlign = 'center';
        ctx.fillText(pt.text, pos.x, pos.y);
      } else {
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, pt.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // ===== ユーティリティ =====
  function shade(hex, amt) {
    const c = hexToRgb(hex);
    if (!c) return hex;
    const f = (v) => Math.max(0, Math.min(255, v + amt));
    return `rgb(${f(c.r)},${f(c.g)},${f(c.b)})`;
  }
  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
  }
  function roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  window.Renderer = Renderer;
  window.RECIPE_EMOJI = RECIPE_EMOJI;
  window.INGREDIENT_VIS = INGREDIENT_VIS;
})();
