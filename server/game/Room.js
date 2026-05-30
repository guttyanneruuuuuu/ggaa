// ============================================================
// Room - 1つのゲームルーム(セッション)を管理
//   - プレイヤー(人間/AI)の参加管理
//   - レベルロード/ステーション生成
//   - ゲームループ(物理, 調理進行, 注文生成, スコア)
//   - クライアントへ配信する状態スナップショット生成
// ============================================================

import {
  TILE, TICK_RATE, INGREDIENTS, RECIPES, LEVELS, CRATE_MAP,
  COOK_TIME, BURN_TIME, CHOP_TIME, PLAYER_SPEED, PLAYER_RADIUS,
} from './config.js';
import { AIController } from './AIController.js';

let _idSeq = 1;
const nextId = () => 'e' + (_idSeq++);

// ---------- アイテム(持てる物) ----------
// type: 'ingredient' | 'plate'
// ingredient: { type:'ingredient', kind:'tomato', state:'raw'|'chopped'|'cooked'|'burnt' }
// plate:      { type:'plate', contents:[ {kind,state}, ... ] }
function makeIngredient(kind, state = 'raw') {
  return { type: 'ingredient', kind, state };
}
function makePlate(contents = []) {
  return { type: 'plate', contents };
}

export class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.players = new Map();   // socketId or aiId -> player
    this.hostId = null;
    this.mode = 'friends';      // 'friends' | 'ai'
    this.state = 'lobby';       // 'lobby' | 'playing' | 'result'
    this.levelIndex = 0;
    this.tickHandle = null;

    // ゲーム実体
    this.stations = [];         // {id,type,gx,gy, ...stationState}
    this.cols = 0; this.rows = 0;
    this.spawns = [];
    this.orders = [];           // 現在の注文
    this.score = 0;
    this.timeLeft = 0;
    this.orderTimer = 0;
    this.level = null;
    this.lastTime = Date.now();
    this.ais = [];              // AIController[]
    this.tipsCombo = 0;
  }

  get playerCount() {
    return [...this.players.values()].filter(p => !p.isAI).length;
  }

  isEmpty() {
    return this.playerCount === 0;
  }

  // ---------- プレイヤー管理 ----------
  addPlayer(id, name, isAI = false) {
    const colors = ['#ff5d73', '#37c4f0', '#ffd23f', '#7be06b', '#b66dff', '#ff9f1c'];
    const idx = this.players.size;
    const player = {
      id, name: name || ('Chef' + (idx + 1)), isAI,
      color: colors[idx % colors.length],
      x: 2 + idx, y: 2,            // ワールド座標(タイル)
      vx: 0, vy: 0,
      dir: 0,                      // 向き(ラジアン)
      facing: { x: 0, y: 1 },
      holding: null,               // 持っているアイテム
      input: { mx: 0, my: 0, action: false, dash: false },
      chopProgress: 0,             // 刻み進行(まな板の前にいるとき)
      dashCd: 0,
      ready: false,
      emote: null,
      emoteT: 0,
    };
    this.players.set(id, player);
    if (!this.hostId && !isAI) this.hostId = id;
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p && p.holding) this.dropHeld(p); // 落とす
    this.players.delete(id);
    if (id === this.hostId) {
      const next = [...this.players.values()].find(pl => !pl.isAI);
      this.hostId = next ? next.id : null;
    }
  }

  setReady(id, ready) {
    const p = this.players.get(id);
    if (p) p.ready = ready;
  }

  // ---------- レベルロード ----------
  loadLevel(index) {
    this.levelIndex = Math.max(0, Math.min(index, LEVELS.length - 1));
    const lvl = LEVELS[this.levelIndex];
    this.level = lvl;
    this.stations = [];
    this.spawns = [];
    const grid = lvl.grid;
    this.rows = grid.length;
    this.cols = grid[0].length;
    this.solid = [];            // 通行判定用 2次元(壁/カウンター/設備)

    for (let y = 0; y < this.rows; y++) {
      this.solid[y] = [];
      for (let x = 0; x < this.cols; x++) {
        const ch = grid[y][x];
        let solid = false;
        let st = null;
        if (ch === '#') { solid = true; }
        else if (ch === 'C') { st = { type: 'counter', item: null }; solid = true; }
        else if (ch === 'X') { st = { type: 'cutting', item: null, chop: 0 }; solid = true; }
        else if (ch === 'O') { st = { type: 'stove', item: null, cook: 0, cooking: false, burn: 0 }; solid = true; }
        else if (ch === 'P') { st = { type: 'plates' }; solid = true; }
        else if (ch === 'S') { st = { type: 'serve' }; solid = true; }
        else if (ch === 'T') { st = { type: 'trash' }; solid = true; }
        else if (CRATE_MAP[ch]) { st = { type: 'crate', kind: CRATE_MAP[ch] }; solid = true; }
        else if (ch >= '1' && ch <= '4') { this.spawns.push({ x: x + 0.5, y: y + 0.5 }); }

        this.solid[y][x] = solid;
        if (st) {
          this.stations.push({ id: nextId(), gx: x, gy: y, ...st });
        }
      }
    }
    // スポーンにプレイヤー配置
    let i = 0;
    for (const p of this.players.values()) {
      const sp = this.spawns[i % Math.max(1, this.spawns.length)] || { x: 2.5, y: 2.5 };
      p.x = sp.x; p.y = sp.y; p.holding = null; p.chopProgress = 0;
      i++;
    }
  }

  stationAt(gx, gy) {
    return this.stations.find(s => s.gx === gx && s.gy === gy);
  }

  // ---------- ゲーム開始 ----------
  start(mode, aiCount = 0) {
    this.mode = mode;
    this.state = 'playing';
    this.score = 0;
    this.tipsCombo = 0;

    // AIプレイヤー追加
    this.ais = [];
    if (mode === 'ai') {
      // 既存AIを除去
      for (const [id, p] of [...this.players]) if (p.isAI) this.players.delete(id);
      for (let i = 0; i < aiCount; i++) {
        const aid = 'ai' + (i + 1);
        const ap = this.addPlayer(aid, 'AIシェフ' + (i + 1), true);
        this.ais.push(new AIController(this, ap));
      }
    }

    this.loadLevel(this.levelIndex);
    this.timeLeft = this.level.duration;
    this.orders = [];
    this.orderTimer = 2.5;       // 開始2.5秒後に最初の注文

    this.lastTime = Date.now();
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  stop() {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  // ---------- 入力 ----------
  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || p.isAI) return;
    p.input.mx = clamp(input.mx ?? 0, -1, 1);
    p.input.my = clamp(input.my ?? 0, -1, 1);
    p.input.dash = !!input.dash;
  }

  // アクションボタン押下(掴む/置く/調理操作)
  doAction(id) {
    const p = this.players.get(id);
    if (p) this.interact(p);
  }
  doDash(id) {
    const p = this.players.get(id);
    if (p) p.input.dash = true;
  }

  // ---------- メインループ ----------
  tick() {
    const now = Date.now();
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > 0.1) dt = 0.1;

    if (this.state !== 'playing') return;

    // AI思考
    for (const ai of this.ais) ai.update(dt);

    // プレイヤー更新
    for (const p of this.players.values()) {
      this.updatePlayer(p, dt);
    }

    // ステーション(調理/焦げ)更新
    this.updateStations(dt);

    // 注文タイマー
    this.updateOrders(dt);

    // 全体時間
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.endLevel();
    }

    // emote減衰
    for (const p of this.players.values()) {
      if (p.emoteT > 0) { p.emoteT -= dt; if (p.emoteT <= 0) p.emote = null; }
    }

    this.broadcastState();
  }

  updatePlayer(p, dt) {
    let mx = p.input.mx, my = p.input.my;
    const mag = Math.hypot(mx, my);
    if (mag > 0.05) {
      const nx = mx / mag, ny = my / mag;
      p.facing = { x: nx, y: ny };
      p.dir = Math.atan2(ny, nx);
      let speed = PLAYER_SPEED * Math.min(1, mag);
      // ダッシュ
      if (p.dashCd > 0) p.dashCd -= dt;
      if (p.input.dash && p.dashCd <= 0) {
        p.dashCd = 1.0;
        p.dashImpulse = 0.18;
      }
      if (p.dashImpulse > 0) { speed *= 2.4; p.dashImpulse -= dt; }
      this.moveWithCollision(p, nx * speed * dt, ny * speed * dt);
    } else {
      if (p.dashImpulse > 0) p.dashImpulse -= dt;
      if (p.dashCd > 0) p.dashCd -= dt;
    }
    p.input.dash = false;

    // まな板の前で持っていない状態 → 自動で刻み進行(人間はactionホールド、AIは別途)
    // 刻みは interactチョップで進めるため、ここでは時間管理のみ
  }

  // タイル衝突を考慮した移動
  moveWithCollision(p, dx, dy) {
    const r = PLAYER_RADIUS;
    // X移動
    let nx = p.x + dx;
    if (!this.circleBlocked(nx, p.y, r)) p.x = nx;
    // Y移動
    let ny = p.y + dy;
    if (!this.circleBlocked(p.x, ny, r)) p.y = ny;
    // 場外防止
    p.x = clamp(p.x, 0.5, this.cols - 0.5);
    p.y = clamp(p.y, 0.5, this.rows - 0.5);
  }

  circleBlocked(cx, cy, r) {
    // 円周辺のタイルをチェック
    const minX = Math.floor(cx - r), maxX = Math.floor(cx + r);
    const minY = Math.floor(cy - r), maxY = Math.floor(cy + r);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (y < 0 || x < 0 || y >= this.rows || x >= this.cols) return true;
        if (this.solid[y][x]) {
          // タイル矩形と円の最近接点
          const nearX = clamp(cx, x, x + 1);
          const nearY = clamp(cy, y, y + 1);
          const ddx = cx - nearX, ddy = cy - nearY;
          if (ddx * ddx + ddy * ddy < r * r) return true;
        }
      }
    }
    return false;
  }

  // プレイヤーが向いている先のステーション
  facingStation(p) {
    // 足元の前方1タイルを見る
    const fx = Math.floor(p.x + p.facing.x * 0.7);
    const fy = Math.floor(p.y + p.facing.y * 0.7);
    let st = this.stationAt(fx, fy);
    if (st) return st;
    // 補助: 前方0.9
    const fx2 = Math.floor(p.x + p.facing.x * 0.95);
    const fy2 = Math.floor(p.y + p.facing.y * 0.95);
    return this.stationAt(fx2, fy2);
  }

  // ---------- インタラクション(掴む/置く/合成) ----------
  interact(p) {
    const st = this.facingStation(p);
    if (!st) {
      // 床: 何もしない(落とさない)
      return;
    }
    switch (st.type) {
      case 'crate': {
        // 食材を取り出す。手が空のときのみ
        if (!p.holding) {
          p.holding = makeIngredient(st.kind, 'raw');
          this.emote(p, '🥕');
        }
        break;
      }
      case 'plates': {
        if (!p.holding) {
          p.holding = makePlate([]);
        }
        break;
      }
      case 'counter': {
        this.counterInteract(p, st);
        break;
      }
      case 'cutting': {
        this.cuttingInteract(p, st);
        break;
      }
      case 'stove': {
        this.stoveInteract(p, st);
        break;
      }
      case 'serve': {
        this.serveInteract(p);
        break;
      }
      case 'trash': {
        if (p.holding) {
          if (p.holding.type === 'plate') {
            p.holding.contents = []; // 皿の中身だけ捨てる、皿は残す
          } else {
            p.holding = null;
          }
          this.emote(p, '🗑️');
        }
        break;
      }
    }
  }

  // カウンター: 置く / 取る / 皿に乗せる
  counterInteract(p, st) {
    if (p.holding && !st.item) {
      st.item = p.holding; p.holding = null; return;
    }
    if (!p.holding && st.item) {
      p.holding = st.item; st.item = null; return;
    }
    // 両方ある → 合成を試みる(皿+食材 等)
    if (p.holding && st.item) {
      const res = this.combine(p.holding, st.item);
      if (res.ok) {
        st.item = res.result;
        p.holding = res.remainHeld;
      }
    }
  }

  // まな板: 食材を置く / 刻む(actionで進行) / 取る
  cuttingInteract(p, st) {
    // 置く
    if (p.holding && p.holding.type === 'ingredient' && !st.item) {
      const ing = INGREDIENTS[p.holding.kind];
      if (p.holding.state === 'raw' && ing.needsChop) {
        st.item = p.holding; p.holding = null; st.chop = 0;
      } else {
        // 刻む必要ない食材は置けない(間違い防止)。一旦置けるようにする
        st.item = p.holding; p.holding = null;
      }
      return;
    }
    // 取る
    if (!p.holding && st.item) {
      p.holding = st.item; st.item = null; st.chop = 0;
      return;
    }
    // 持ち物あり&まな板にあり → 皿合成など
    if (p.holding && st.item) {
      const res = this.combine(p.holding, st.item);
      if (res.ok) { st.item = res.result; p.holding = res.remainHeld; }
    }
  }

  // まな板で刻み続ける(アクション長押し/連打)。人間/AI共通で呼ぶ
  chopAt(st, dt) {
    if (!st || st.type !== 'cutting' || !st.item) return false;
    if (st.item.type !== 'ingredient') return false;
    if (st.item.state !== 'raw') return false;
    const ing = INGREDIENTS[st.item.kind];
    if (!ing.needsChop) return false;
    st.chop += dt;
    if (st.chop >= CHOP_TIME) {
      st.item.state = 'chopped';
      st.chop = 0;
      return true; // 完了
    }
    return false;
  }

  // コンロ: 鍋に食材/置く / 取る
  stoveInteract(p, st) {
    // 食材を置いて調理開始
    if (p.holding && p.holding.type === 'ingredient' && !st.item) {
      const ing = INGREDIENTS[p.holding.kind];
      // 調理は raw or chopped から cooked へ(肉/魚/米/芋)
      if (ing.needsCook && (p.holding.state === 'raw' || p.holding.state === 'chopped')) {
        st.item = p.holding; p.holding = null;
        st.cook = 0; st.cooking = true; st.burn = 0;
      } else {
        st.item = p.holding; p.holding = null; st.cooking = false;
      }
      return;
    }
    // 取る
    if (!p.holding && st.item) {
      p.holding = st.item; st.item = null; st.cooking = false; st.cook = 0; st.burn = 0;
      return;
    }
    if (p.holding && st.item) {
      const res = this.combine(p.holding, st.item);
      if (res.ok) { st.item = res.result; p.holding = res.remainHeld; }
    }
  }

  // 提供: 持っている皿を注文と照合
  serveInteract(p) {
    if (!p.holding || p.holding.type !== 'plate') return;
    const plate = p.holding;
    if (plate.contents.length === 0) return;
    // 注文照合
    const match = this.matchOrder(plate.contents);
    if (match) {
      const recipe = RECIPES[match.recipe];
      // タイムボーナス: 残り時間割合
      const ratio = match.timeLeft / recipe.time;
      let pts = recipe.score;
      this.tipsCombo += 1;
      const comboBonus = Math.min(this.tipsCombo - 1, 5) * 5;
      if (ratio > 0.5) pts += 20; // 早だしボーナス
      pts += comboBonus;
      this.score += pts;
      this.orders = this.orders.filter(o => o.id !== match.id);
      p.holding = makePlate([]); // 皿だけ戻る(きれいな皿)
      this.emote(p, '✨');
      this.io.to(this.code).emit('fx', { type: 'serve', x: p.x, y: p.y, pts, combo: this.tipsCombo });
    } else {
      // 注文と合わない → ペナルティなし、コンボリセット
      this.tipsCombo = 0;
      this.emote(p, '❓');
    }
  }

  // 皿の中身と注文を照合(状態まで一致)
  matchOrder(contents) {
    for (const order of this.orders) {
      const recipe = RECIPES[order.recipe];
      if (this.contentsMatchRecipe(contents, recipe)) {
        return { id: order.id, recipe: order.recipe, timeLeft: order.timeLeft };
      }
    }
    return null;
  }

  contentsMatchRecipe(contents, recipe) {
    if (contents.length !== recipe.items.length) return false;
    const need = recipe.items.map(it => it.ingredient + ':' + it.state).sort();
    const have = contents.map(c => c.kind + ':' + c.state).sort();
    for (let i = 0; i < need.length; i++) if (need[i] !== have[i]) return false;
    return true;
  }

  // ---------- 合成ロジック ----------
  // held と target を合成。皿に食材を乗せる / 食材を皿に
  combine(held, target) {
    // held皿 + target食材
    if (held && held.type === 'plate' && target && target.type === 'ingredient') {
      if (this.canPlate(target)) {
        held.contents.push({ kind: target.kind, state: target.state });
        return { ok: true, result: null, remainHeld: held };
        // targetは消費されるので station側は null になる
      }
    }
    // held食材 + target皿
    if (held && held.type === 'ingredient' && target && target.type === 'plate') {
      if (this.canPlate(held)) {
        target.contents.push({ kind: held.kind, state: held.state });
        return { ok: true, result: target, remainHeld: null };
      }
    }
    return { ok: false };
  }
  tryCombine() { return null; } // 互換用ダミー

  canPlate(ing) {
    // 皿に乗せられる状態か(生肉/生魚はダメ等)
    const def = INGREDIENTS[ing.kind];
    if (def.needsCook && ing.state !== 'cooked') return false; // 要調理は調理済のみ
    if (def.needsChop && ing.state === 'raw') return false;    // 要刻みは刻み済以降
    if (ing.state === 'burnt') return false;
    return true;
  }

  dropHeld(p) {
    // 退出時など。近くのカウンターに置くか消す
    p.holding = null;
  }

  // ---------- ステーション進行 ----------
  updateStations(dt) {
    for (const st of this.stations) {
      if (st.type === 'stove' && st.item) {
        if (st.cooking && st.item.state !== 'cooked' && st.item.state !== 'burnt') {
          st.cook += dt;
          if (st.cook >= COOK_TIME) {
            st.item.state = 'cooked';
            st.cooking = false;
            st.burn = 0;
          }
        } else if (st.item.state === 'cooked') {
          st.burn += dt;
          if (st.burn >= BURN_TIME) {
            st.item.state = 'burnt';
          }
        }
      }
    }
  }

  // ---------- 注文管理 ----------
  updateOrders(dt) {
    // 既存注文のカウントダウン
    for (const o of this.orders) {
      o.timeLeft -= dt;
    }
    // 期限切れ
    const before = this.orders.length;
    this.orders = this.orders.filter(o => o.timeLeft > 0);
    if (this.orders.length < before) {
      this.tipsCombo = 0; // 失敗でコンボリセット
      this.score = Math.max(0, this.score - 10);
    }

    // 新規注文
    this.orderTimer -= dt;
    const maxOrders = 4;
    if (this.orderTimer <= 0 && this.orders.length < maxOrders) {
      this.spawnOrder();
      // 時間経過で注文ペースを上げる
      const prog = 1 - this.timeLeft / this.level.duration;
      this.orderTimer = Math.max(5, 11 - prog * 6);
    }
  }

  spawnOrder() {
    const pool = this.level.recipes;
    const recipe = pool[Math.floor(Math.random() * pool.length)];
    const def = RECIPES[recipe];
    this.orders.push({
      id: nextId(),
      recipe,
      time: def.time,
      timeLeft: def.time,
    });
  }

  // ---------- レベル終了 ----------
  endLevel() {
    this.state = 'result';
    this.stop();
    const passed = this.score >= this.level.targetScore;
    const stars = this.computeStars();
    this.io.to(this.code).emit('levelEnd', {
      score: this.score,
      targetScore: this.level.targetScore,
      passed, stars,
      levelIndex: this.levelIndex,
      hasNext: this.levelIndex < LEVELS.length - 1,
      levelName: this.level.name,
    });
  }

  computeStars() {
    const t = this.level.targetScore;
    if (this.score >= t * 1.5) return 3;
    if (this.score >= t * 1.15) return 2;
    if (this.score >= t) return 1;
    return 0;
  }

  // ---------- 演出 ----------
  emote(p, e) { p.emote = e; p.emoteT = 0.9; }

  // ---------- 状態スナップショット ----------
  snapshot() {
    return {
      code: this.code,
      state: this.state,
      mode: this.mode,
      levelIndex: this.levelIndex,
      levelName: this.level ? this.level.name : '',
      cols: this.cols, rows: this.rows,
      tile: TILE,
      score: this.score,
      targetScore: this.level ? this.level.targetScore : 0,
      timeLeft: Math.ceil(this.timeLeft),
      combo: this.tipsCombo,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, isAI: p.isAI,
        x: p.x, y: p.y, dir: p.dir, facing: p.facing,
        holding: p.holding, emote: p.emote, dashCd: p.dashCd,
      })),
      stations: this.stations.map(s => ({
        id: s.id, type: s.type, gx: s.gx, gy: s.gy,
        kind: s.kind || null,
        item: s.item || null,
        cook: s.cook || 0, cooking: !!s.cooking, burn: s.burn || 0,
        chop: s.chop || 0,
      })),
      orders: this.orders.map(o => ({
        id: o.id, recipe: o.recipe, time: o.time, timeLeft: Math.max(0, o.timeLeft),
        items: RECIPES[o.recipe].items,
        name: RECIPES[o.recipe].name,
        emoji: RECIPES[o.recipe].emoji,
      })),
    };
  }

  lobbySnapshot() {
    return {
      code: this.code,
      state: this.state,
      mode: this.mode,
      hostId: this.hostId,
      levelIndex: this.levelIndex,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, isAI: p.isAI, ready: p.ready,
      })),
    };
  }

  broadcastState() {
    this.io.to(this.code).emit('state', this.snapshot());
  }

  broadcastLobby() {
    this.io.to(this.code).emit('lobby', this.lobbySnapshot());
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
