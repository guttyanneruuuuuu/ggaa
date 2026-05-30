// ============================================================
// game.js - クライアント全体の統括
//   - Socket.IO 接続/イベント処理
//   - 画面遷移(メニュー / ロビー / ゲーム / リザルト)
//   - サーバー状態の補間描画(60fps)
//   - HUD(注文/タイマー/スコア)更新
//   - 効果音・トースト・カウントダウン演出
// ============================================================

(function () {
  'use strict';

  const socket = io();
  const $ = (id) => document.getElementById(id);
  const screens = {
    menu: $('screen-menu'),
    lobby: $('screen-lobby'),
    game: $('screen-game'),
    result: $('screen-result'),
  };

  // ---- 状態 ----
  const G = {
    you: null,
    code: null,
    isHost: false,
    mode: 'friends',
    selectedLevel: 0,
    aiCount: 1,
    gameData: null,        // /api/gamedata
    serverState: null,     // 最新スナップショット
    renderState: null,     // 補間用
    prevState: null,
    lastSnapshotT: 0,
    playing: false,
  };

  let renderer = null;
  let controls = null;

  // ============ 画面遷移 ============
  function show(name) {
    for (const k in screens) screens[k].classList.toggle('active', k === name);
  }

  // ============ ゲームデータ取得 ============
  async function loadGameData() {
    try {
      const res = await fetch('/api/gamedata');
      G.gameData = await res.json();
    } catch (e) {
      console.error('gamedata取得失敗', e);
      G.gameData = { levels: [], recipes: {}, ingredients: {} };
    }
  }

  // ============ メニュー ============
  function getName() {
    const v = ($('player-name').value || '').trim();
    return v || ('シェフ' + Math.floor(Math.random() * 99 + 1));
  }

  $('btn-ai').addEventListener('click', () => {
    audioFX.button();
    // AIモード: 自分1人でルーム作成 → AI追加
    socket.emit('createRoom', { name: getName() }, (resp) => {
      if (resp.ok) {
        G.you = resp.you; G.code = resp.code; G.isHost = true;
        G.mode = 'ai';
        enterLobby();
      }
    });
  });

  $('btn-create').addEventListener('click', () => {
    audioFX.button();
    socket.emit('createRoom', { name: getName() }, (resp) => {
      if (resp.ok) {
        G.you = resp.you; G.code = resp.code; G.isHost = true;
        G.mode = 'friends';
        enterLobby();
      }
    });
  });

  $('btn-join').addEventListener('click', () => {
    audioFX.button();
    $('join-box').classList.toggle('hidden');
    // URLにコードがあれば自動入力
    $('join-code').focus();
  });

  $('btn-join-go').addEventListener('click', doJoin);
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  function doJoin() {
    const code = ($('join-code').value || '').toUpperCase().trim();
    if (code.length < 4) { showMenuError('コードを4文字いれてね'); return; }
    audioFX.button();
    socket.emit('joinRoom', { code, name: getName() }, (resp) => {
      if (resp.ok) {
        G.you = resp.you; G.code = resp.code; G.isHost = false;
        G.mode = 'friends';
        enterLobby();
      } else {
        showMenuError(resp.error || '参加できませんでした');
      }
    });
  }
  function showMenuError(msg) {
    const el = $('menu-error'); el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
  }

  // URLパラメータでルーム自動参加 (?room=XXXX)
  function checkUrlRoom() {
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) {
      $('join-box').classList.remove('hidden');
      $('join-code').value = room.toUpperCase();
    }
  }

  // ============ ロビー ============
  function enterLobby() {
    show('lobby');
    $('lobby-code').textContent = G.code;
    renderLevelButtons();
    updateLobbyMode();
  }

  function updateLobbyMode() {
    const hint = $('lobby-mode-hint');
    const aiActions = $('btn-add-ai').parentElement;
    if (G.mode === 'ai') {
      hint.textContent = '🤖 AIモード: AIシェフと協力プレイ';
      aiActions.style.display = 'flex';
      $('share-row').style.display = 'none';
    } else {
      hint.textContent = '👥 友達モード: コードを共有して招待しよう';
      aiActions.style.display = G.isHost ? 'flex' : 'none';
      $('share-row').style.display = 'flex';
    }
  }

  function renderLevelButtons() {
    const box = $('level-buttons');
    box.innerHTML = '';
    if (!G.gameData) return;
    G.gameData.levels.forEach((lv, i) => {
      const b = document.createElement('button');
      b.className = 'level-btn' + (i === G.selectedLevel ? ' sel' : '');
      const recipeEmojis = lv.recipes.map(r => (G.gameData.recipes[r] || {}).emoji || '🍽️').join(' ');
      b.innerHTML = `<div class="lv-name">${i + 1}. ${lv.name}</div>
        <div class="lv-meta">⏱ ${lv.duration}秒 ・ 🎯 ${lv.targetScore}点 ・ ${recipeEmojis}</div>`;
      b.addEventListener('click', () => {
        if (!G.isHost) return;
        G.selectedLevel = i;
        socket.emit('selectLevel', { index: i });
        renderLevelButtons();
        audioFX.button();
      });
      box.appendChild(b);
    });
    // 非ホストはグレーアウト気味
    if (!G.isHost) box.style.opacity = '0.7';
    else box.style.opacity = '1';
  }

  $('btn-copy').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?room=${G.code}`;
    try {
      await navigator.clipboard.writeText(link);
      $('copy-done').textContent = '✅ コピーしたよ！';
    } catch {
      $('copy-done').textContent = link;
    }
    setTimeout(() => $('copy-done').textContent = '', 3000);
  });

  $('btn-add-ai').addEventListener('click', () => {
    if (G.aiCount < 3) G.aiCount++;
    updateAiNote();
    audioFX.button();
  });
  $('btn-remove-ai').addEventListener('click', () => {
    if (G.aiCount > 1) G.aiCount--;
    updateAiNote();
    audioFX.button();
  });
  function updateAiNote() {
    $('lobby-note').textContent = G.mode === 'ai'
      ? `AIシェフ ${G.aiCount}人 と一緒にプレイ (あなた + AI${G.aiCount}人)`
      : '';
  }

  $('btn-leave').addEventListener('click', () => {
    socket.emit('leaveRoom');
    G.code = null; G.isHost = false;
    show('menu');
    audioFX.button();
  });

  $('btn-start').addEventListener('click', () => {
    if (!G.isHost) { $('lobby-note').textContent = 'ホストがスタートを押すまで待ってね'; return; }
    audioFX.button();
    socket.emit('startGame', { mode: G.mode, aiCount: G.aiCount });
  });

  // ============ Socket イベント ============
  socket.on('lobby', (lobby) => {
    if (!G.code) return;
    G.isHost = (lobby.hostId === G.you);
    G.selectedLevel = lobby.levelIndex;
    G.mode = lobby.mode || G.mode;
    // プレイヤーリスト
    const list = $('player-list');
    list.innerHTML = '';
    lobby.players.forEach((p) => {
      const chip = document.createElement('div');
      chip.className = 'player-chip';
      const isHost = p.id === lobby.hostId;
      chip.innerHTML = `
        <span class="player-dot" style="background:${p.color}"></span>
        <span class="pname">${escapeHtml(p.name)}</span>
        ${p.isAI ? '<span class="ptag ai-tag">🤖AI</span>' : ''}
        ${isHost ? '<span class="ptag host-tag">👑ホスト</span>' : ''}
      `;
      list.appendChild(chip);
    });
    const human = lobby.players.filter(p => !p.isAI).length;
    $('player-count').textContent = `(${human}人)`;
    renderLevelButtons();
    updateLobbyMode();
    updateAiNote();
    // スタートボタンの有効化
    $('btn-start').disabled = !G.isHost;
    $('btn-start').textContent = G.isHost ? 'スタート！🔥' : 'ホスト待ち…';
  });

  socket.on('gameStart', ({ levelIndex }) => {
    G.selectedLevel = levelIndex;
    startGameScreen();
  });

  socket.on('state', (state) => {
    G.prevState = G.serverState;
    G.serverState = state;
    G.lastSnapshotT = performance.now();
    updateHUD(state);
  });

  socket.on('fx', (fx) => {
    if (fx.type === 'serve') {
      audioFX.serve();
      if (renderer) {
        renderer.addParticles(fx.x, fx.y, '#ffd23f', 18, { speed: 3, life: 0.9, size: 5 });
        renderer.addParticles(fx.x, fx.y - 0.3, '#7be06b', 6, { text: `+${fx.pts}`, life: 1.0, size: 6, speed: 1 });
      }
      showToast(`+${fx.pts}点！`, false);
      if (fx.combo > 1) {
        audioFX.combo(fx.combo);
        showToast(`🔥${fx.combo}コンボ!`, true);
      }
    }
  });

  socket.on('levelEnd', (res) => {
    showResult(res);
  });

  socket.on('disconnect', () => {
    if (G.playing) showToast('接続が切れました…', true);
  });

  // ============ ゲーム画面開始 ============
  function startGameScreen() {
    show('game');
    G.playing = true;
    if (!renderer) renderer = new Renderer($('game-canvas'));
    if (!controls) setupControls();
    audioFX.startBGM();
    runCountdown();
    requestAnimationFrame(gameLoop);
  }

  function setupControls() {
    controls = new Controls();
    controls.on('input', (d) => socket.emit('input', d));
    controls.on('action', () => { socket.emit('action'); audioFX.place(); });
    controls.on('dash', () => { socket.emit('dash'); audioFX.dash(); });
    controls.on('chopHold', () => {
      socket.emit('chopHold');
      // 軽いチョップ音(間引き)
      if (Math.random() < 0.3) audioFX.chop();
    });
  }

  function runCountdown() {
    const el = $('countdown');
    el.classList.remove('hidden');
    let n = 3;
    const tick = () => {
      if (n > 0) {
        el.innerHTML = `<span class="cd-num">${n}</span>`;
        audioFX.countdown();
        n--;
        setTimeout(tick, 1000);
      } else {
        el.innerHTML = `<span class="cd-num" style="color:#7be06b">START!</span>`;
        audioFX.go();
        setTimeout(() => el.classList.add('hidden'), 700);
      }
    };
    tick();
  }

  // ============ 描画ループ(補間) ============
  let lastT = performance.now();
  function gameLoop(now) {
    if (!G.playing) return;
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

    const interp = interpolateState(now);
    if (interp && renderer) {
      renderer.draw(interp, G.you, dt);
      // ダッシュクールダウン表示
      const me = interp.players.find(p => p.id === G.you);
      if (me && controls) controls.setDashCooldown(me.dashCd > 0);
    }
    requestAnimationFrame(gameLoop);
  }

  // サーバースナップショット間を線形補間して滑らかに
  function interpolateState(now) {
    const s = G.serverState;
    if (!s) return null;
    const prev = G.prevState;
    if (!prev || prev.players.length !== s.players.length) return s;
    const SNAP_MS = 1000 / 30;
    const t = Math.min(1, (now - G.lastSnapshotT) / SNAP_MS);
    // playerだけ補間(ステーション/注文はそのまま)
    const players = s.players.map((p) => {
      const pp = prev.players.find(q => q.id === p.id);
      if (!pp) return p;
      return {
        ...p,
        x: pp.x + (p.x - pp.x) * t,
        y: pp.y + (p.y - pp.y) * t,
      };
    });
    return { ...s, players };
  }

  // ============ HUD ============
  function updateHUD(state) {
    // タイマー
    const tEl = $('hud-timer');
    const m = Math.floor(state.timeLeft / 60);
    const sec = state.timeLeft % 60;
    tEl.textContent = `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    tEl.classList.toggle('warn', state.timeLeft <= 15);

    // スコア
    $('hud-score').textContent = state.score;
    $('hud-target').textContent = `/ ${state.targetScore}`;

    // 注文チケット
    const box = $('hud-orders');
    box.innerHTML = '';
    state.orders.forEach((o) => {
      const ratio = o.timeLeft / o.time;
      const t = document.createElement('div');
      t.className = 'order-ticket' + (ratio < 0.3 ? ' urgent' : '');
      const items = o.items.map(it => {
        const vis = (window.INGREDIENT_VIS && window.INGREDIENT_VIS[it.ingredient]) || {};
        return vis.emoji || '🍽️';
      }).join('');
      t.innerHTML = `
        <div class="ot-name">${o.emoji} ${escapeHtml(o.name)}</div>
        <div class="ot-items">${items}</div>
        <div class="ot-bar"><i style="width:${Math.max(0, ratio*100)}%"></i></div>
      `;
      box.appendChild(t);
    });
  }

  function showToast(text, combo) {
    const zone = $('toast-zone');
    const el = document.createElement('div');
    el.className = 'toast' + (combo ? ' combo' : '');
    el.textContent = text;
    zone.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  // ============ リザルト ============
  function showResult(res) {
    G.playing = false;
    audioFX.stopBGM();
    show('result');
    $('result-title').textContent = res.passed ? 'クリア！🎉' : 'ざんねん…😢';
    if (res.passed) audioFX.win(); else audioFX.lose();

    // 星
    const starsEl = $('result-stars');
    starsEl.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const s = document.createElement('span');
      s.className = 'star ' + (i < res.stars ? 'on' : 'off');
      s.textContent = '⭐';
      starsEl.appendChild(s);
    }

    $('result-score').textContent = res.score;
    $('result-target').textContent = res.targetScore;
    let msg = '';
    if (res.stars === 3) msg = 'パーフェクト！神シェフ！👑';
    else if (res.stars === 2) msg = 'すごい！いいチームワーク！';
    else if (res.stars === 1) msg = 'クリア！次はもっと上を目指そう';
    else msg = '目標まであと少し！もう一度挑戦しよう';
    $('result-msg').textContent = msg;

    // 次へボタン制御
    const againBtn = $('btn-again');
    if (res.passed && res.hasNext) {
      againBtn.textContent = '次のステージ →';
      againBtn.onclick = () => { audioFX.button(); socket.emit('nextLevel'); };
    } else {
      againBtn.textContent = 'もう一度！';
      againBtn.onclick = () => { audioFX.button(); socket.emit('retryLevel'); };
    }
    // ホスト以外は操作不可
    againBtn.disabled = !G.isHost;
    $('btn-home').disabled = !G.isHost;
  }

  $('btn-home').addEventListener('click', () => {
    audioFX.button();
    socket.emit('backToLobby');
    enterLobby();
  });

  // ============ ユーティリティ ============
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ============ 初期化 ============
  (async function init() {
    await loadGameData();
    checkUrlRoom();
    show('menu');
  })();

})();
