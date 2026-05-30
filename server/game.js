// ============================================================
//  game.js — サーバー権威のゲームエンジン（1ルーム=1インスタンス）
//  オーバークック風の協力調理ロジック本体
// ============================================================
import { INGREDIENTS, RECIPES, STAGES, getStage, matchRecipe,
         CHOP_TIME, COOK_TIME, BURN_TIME, WASH_TIME } from './recipes.js';

const TILE = 1;                 // タイル論理サイズ
const PLAYER_SPEED = 4.2;       // タイル/秒
const PLAYER_RADIUS = 0.34;
const TICK_MS = 1000 / 30;      // 30fps シミュレーション

// タイル種別の解析
function parseGrid(stage) {
  const grid = stage.grid;
  const rows = grid.length;
  const cols = Math.max(...grid.map(r => r.length));
  const tiles = [];        // tiles[y][x] = { type, ... }
  const stations = [];     // 相互作用可能なステーション一覧
  const spawns = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      const ch = grid[y][x] || ' ';
      let t = { type: 'floor', x, y };
      if (ch === '#' || ch === '.') t = { type: 'wall', x, y };
      else if (ch === ' ') t = { type: 'floor', x, y };
      else if (ch === '@') { t = { type: 'floor', x, y }; spawns.push({ x, y }); }
      else if (ch === 'C') t = { type: 'counter', station: 'chop', x, y };
      else if (ch === 'K') t = { type: 'counter', station: 'cook', x, y };
      else if (ch === 'P') t = { type: 'counter', station: 'plates', x, y };
      else if (ch === 'S') t = { type: 'counter', station: 'serve', x, y };
      else if (ch === 'W') t = { type: 'counter', station: 'sink', x, y };
      else if (ch === 'T') t = { type: 'counter', station: 'trash', x, y };
      else if (stage.boxes && stage.boxes[ch]) {
        t = { type: 'counter', station: 'box', ingredient: stage.boxes[ch], x, y };
      } else {
        t = { type: 'wall', x, y };
      }
      // ステーションは内部状態(置かれているアイテム/調理進捗)を持つ
      if (t.type === 'counter') {
        t.item = null;          // カウンターに置かれているアイテム
        t.progress = 0;         // 0..1 調理/切る進捗
        t.action = null;        // 'chop' | 'cook' | null
        t.cookState = null;     // 'cooking' | 'done' | 'burning' | 'burnt'
        t.cookTimer = 0;        // 焦げ判定用
        t.washQueue = 0;        // シンクの汚れ皿の数
        stations.push(t);
      }
      row.push(t);
    }
    tiles.push(row);
  }
  return { tiles, stations, spawns, rows, cols };
}

// アイテム表現
//  食材:  { kind:'ingredient', id, state:'raw'|'chopped'|'cooked'|'burnt' }
//  皿:    { kind:'plate', clean:true, content:[ {id,state}, ... ], cookedDish:null|recipeKey }
function makeIngredient(id, state = 'raw') { return { kind: 'ingredient', id, state }; }
function makeCleanPlate() { return { kind: 'plate', clean: true, content: [], dish: null }; }
function makeDirtyPlate() { return { kind: 'plate', clean: false, content: [], dish: null }; }

export class Game {
  constructor(room, io, onEnd) {
    this.room = room;
    this.io = io;
    this.onEnd = onEnd;
    this.stage = getStage(room.stageId);
    const parsed = parseGrid(this.stage);
    Object.assign(this, parsed);

    this.players = {};         // id -> player state
    this.orders = [];          // 現在のオーダー
    this.orderSeq = 0;
    this.score = 0;
    this.timeLeft = this.stage.duration;
    this.running = false;
    this.ended = false;
    this.nextOrderAt = 1500;    // 開始から少し待ってから最初のオーダー
    this._elapsed = 0;
    this._lastBroadcast = 0;
    this.tutorialHint = '';

    // プレイヤー生成
    let si = 0;
    for (const p of room.players) {
      const sp = this.spawns[si % this.spawns.length] || { x: 2, y: 2 };
      si++;
      this.players[p.id] = {
        id: p.id, name: p.name, isAI: !!p.isAI, color: p.color,
        x: sp.x + 0.5, y: sp.y + 0.5,
        dir: { x: 0, y: 1 },
        moveInput: { x: 0, y: 0 },
        held: null,             // 持っているアイテム
        action: null,           // 'chop'|'cook'|'wash' 実行中
        actionStation: null,
        dashCd: 0,
        dashTime: 0,
        ai: p.isAI ? { task: null, path: null, retarget: 0, cooldown: 0 } : null,
      };
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.ended = false;
    this._loop = setInterval(() => this.tick(), TICK_MS);
    this._secondTimer = setInterval(() => {
      if (!this.running) return;
      this.timeLeft = Math.max(0, this.timeLeft - 1);
      if (this.timeLeft <= 0) this.finish();
    }, 1000);
  }

  stop() {
    this.running = false;
    if (this._loop) clearInterval(this._loop);
    if (this._secondTimer) clearInterval(this._secondTimer);
    this._loop = this._secondTimer = null;
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    const stars = this.computeStars();
    const win = this.score >= this.stage.targetScore;
    this.io.to(this.room.code).emit('game:over', {
      score: this.score, target: this.stage.targetScore,
      win, stars, stageId: this.stage.id, stageName: this.stage.name,
    });
    if (this.onEnd) this.onEnd();
  }

  computeStars() {
    const s = this.stage.starScores;
    let stars = 0;
    for (const th of s) if (this.score >= th) stars++;
    return stars;
  }

  // ====== 入力処理 ======
  setMove(playerId, ix, iy) {
    const p = this.players[playerId];
    if (!p) return;
    const m = Math.hypot(ix, iy);
    if (m > 0.1) {
      p.moveInput = { x: ix / Math.max(m, 1), y: iy / Math.max(m, 1) };
      // 入力強度を保持（アナログ）
      const mag = Math.min(1, m);
      p.moveInput.x = (ix / m) * mag;
      p.moveInput.y = (iy / m) * mag;
      p.dir = { x: ix / m, y: iy / m };
    } else {
      p.moveInput = { x: 0, y: 0 };
    }
  }

  doInteract(playerId) {
    const p = this.players[playerId];
    if (!p || this.ended) return;
    this.interact(p);
  }

  doDash(playerId) {
    const p = this.players[playerId];
    if (!p || p.dashCd > 0) return;
    p.dashCd = 1.1;
    p.dashTime = 0.18;
  }

  // 前方の隣接ステーションを取得
  facingStation(p) {
    const fx = Math.round(p.x - 0.5 + p.dir.x * 0.9);
    const fy = Math.round(p.y - 0.5 + p.dir.y * 0.9);
    if (fy < 0 || fy >= this.rows || fx < 0 || fx >= this.cols) return null;
    const t = this.tiles[fy][fx];
    if (t && t.type === 'counter') return t;
    // 斜め含めて最も近いカウンターを探す
    let best = null, bestD = 99;
    for (const s of this.stations) {
      const cx = s.x + 0.5, cy = s.y + 0.5;
      const dx = cx - p.x, dy = cy - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 1.05) {
        // 向きが合っているか
        const dot = (dx / (d || 1)) * p.dir.x + (dy / (d || 1)) * p.dir.y;
        if (dot > 0.25 && d < bestD) { bestD = d; best = s; }
      }
    }
    return best;
  }

  // 相互作用の本体
  interact(p) {
    const s = this.facingStation(p);
    if (!s) return;

    switch (s.station) {
      case 'box': {
        // 食材箱: 何も持っていなければ生食材を取る
        if (!p.held) {
          p.held = makeIngredient(s.ingredient, 'raw');
          this.emitFx(p.x, p.y, 'pick');
        }
        break;
      }
      case 'plates': {
        if (!p.held) { p.held = makeCleanPlate(); this.emitFx(p.x, p.y, 'pick'); }
        break;
      }
      case 'chop': {
        this.handleCounterPlace(p, s, 'chop');
        break;
      }
      case 'cook': {
        this.handleCounterPlace(p, s, 'cook');
        break;
      }
      case 'serve': {
        // 提供口: 完成皿を出す
        if (p.held && p.held.kind === 'plate' && p.held.content.length > 0) {
          this.tryServe(p);
        }
        break;
      }
      case 'sink': {
        // シンク: 汚れ皿を置いて洗う / 洗い終わった皿を取る
        if (p.held && p.held.kind === 'plate' && !p.held.clean) {
          s.washQueue = (s.washQueue || 0) + 1;
          p.held = null;
          this.emitFx(p.x, p.y, 'place');
        } else if (!p.held && s.item && s.item.kind === 'plate' && s.item.clean) {
          p.held = s.item; s.item = null;
          this.emitFx(p.x, p.y, 'pick');
        }
        break;
      }
      case 'trash': {
        if (p.held) {
          if (p.held.kind === 'plate') {
            // 皿の中身だけ捨てる（皿は汚れる）
            p.held.content = []; p.held.dish = null; p.held.clean = false;
          } else {
            p.held = null;
          }
          this.emitFx(p.x, p.y, 'trash');
        }
        break;
      }
    }
  }

  // 一般カウンター(chop/cook)へ置く/取る/合体させる
  handleCounterPlace(p, s, kind) {
    // 1) 何も持っていない: ステーションのアイテムを取る
    if (!p.held) {
      if (s.item) {
        p.held = s.item; s.item = null;
        this.resetStationAction(s);
        this.emitFx(p.x, p.y, 'pick');
      }
      return;
    }
    // 2) 持っている & ステーションが空: 置く
    if (!s.item) {
      s.item = p.held; p.held = null;
      this.evaluateStation(s, kind);
      this.emitFx(p.x, p.y, 'place');
      return;
    }
    // 3) 両方アイテムあり: 合体を試みる（皿に食材を盛る など）
    const merged = this.tryCombine(s.item, p.held);
    if (merged === 'into-station') {
      // p.held の中身が s.item に吸収された
      p.held = null;
      this.emitFx(p.x, p.y, 'place');
    } else if (merged === 'into-hand') {
      s.item = null;
      this.resetStationAction(s);
      this.emitFx(p.x, p.y, 'pick');
    }
  }

  // アイテム合体ロジック。皿+食材 / 皿+皿。戻り値: どちらに集約したか
  tryCombine(stationItem, handItem) {
    // 皿(station) に 食材(hand) を盛る
    if (stationItem.kind === 'plate' && stationItem.clean && handItem.kind === 'ingredient') {
      if (this.canPlate(handItem)) {
        stationItem.content.push({ id: handItem.id, state: handItem.state });
        stationItem.dish = matchRecipe(stationItem.content);
        return 'into-station';
      }
    }
    // 食材(station) を 皿(hand) に盛る
    if (handItem.kind === 'plate' && handItem.clean && stationItem.kind === 'ingredient') {
      if (this.canPlate(stationItem)) {
        handItem.content.push({ id: stationItem.id, state: stationItem.state });
        handItem.dish = matchRecipe(handItem.content);
        return 'into-hand';
      }
    }
    return null;
  }

  canPlate(ing) {
    // 盛れるのは chopped か cooked のみ（生はダメ、焦げもダメ）
    return ing.state === 'chopped' || ing.state === 'cooked';
  }

  // ステーションにアイテムが置かれた直後の評価（自動で調理開始判定）
  evaluateStation(s, kind) {
    s.progress = 0; s.action = null; s.cookState = null; s.cookTimer = 0;
    if (!s.item) return;
    if (kind === 'chop' && s.item.kind === 'ingredient' && s.item.state === 'raw'
        && INGREDIENTS[s.item.id].canChop) {
      s.action = 'chop'; // プレイヤーが押し続けて切る
    }
    if (kind === 'cook' && s.item.kind === 'ingredient'
        && (s.item.state === 'chopped' || s.item.state === 'raw')
        && INGREDIENTS[s.item.id].canCook) {
      s.action = 'cook';
      s.cookState = 'cooking';
    }
  }

  resetStationAction(s) {
    s.action = null; s.progress = 0; s.cookState = null; s.cookTimer = 0;
  }

  // 提供
  tryServe(p) {
    const plate = p.held;
    const dish = matchRecipe(plate.content);
    if (!dish) {
      // 不正な皿: 失敗エフェクトのみ（出せない）
      this.emitFx(p.x, p.y, 'fail');
      return;
    }
    // 一致するオーダーを探す（最も古いもの優先）
    let idx = -1;
    for (let i = 0; i < this.orders.length; i++) {
      if (this.orders[i].recipe === dish) { idx = i; break; }
    }
    if (idx === -1) {
      this.emitFx(p.x, p.y, 'fail');
      return;
    }
    const order = this.orders[idx];
    // 残り時間に応じてボーナス
    const rec = RECIPES[dish];
    const ratio = order.timeLeft / order.timeTotal;
    let reward = rec.reward;
    let tip = 0;
    if (ratio > 0.6) tip = Math.round(rec.reward * 0.4);
    else if (ratio > 0.3) tip = Math.round(rec.reward * 0.2);
    this.score += reward + tip;
    this.orders.splice(idx, 1);
    // 皿は汚れて消費（提供後はシンク行き想定→ここでは消す＝外に下げる）
    p.held = makeDirtyPlate();
    this.combo = (this.combo || 0) + 1;
    this.emitFx(p.x, p.y, 'serve');
    this.io.to(this.room.code).emit('game:served', {
      by: p.name, dish, reward: reward + tip, tip, score: this.score,
    });
  }

  emitFx(x, y, type) {
    this.io.to(this.room.code).emit('game:fx', { x, y, type });
  }

  // ====== オーダー管理 ======
  spawnOrder() {
    if (this.orders.length >= this.stage.maxOrders) return;
    const menu = this.stage.orderMenu;
    const key = menu[Math.floor(Math.random() * menu.length)];
    const rec = RECIPES[key];
    this.orders.push({
      id: ++this.orderSeq,
      recipe: key,
      timeTotal: rec.time,
      timeLeft: rec.time,
    });
    this.io.to(this.room.code).emit('game:neworder', { recipe: key });
  }

  // ====== AI ロジック ======
  updateAI(p, dt) {
    if (!p.ai) return;
    const ai = p.ai;
    ai.cooldown -= dt; ai.retarget -= dt;

    // 行動を一定間隔で再計画
    if (!ai.task || ai.retarget <= 0) {
      ai.task = this.planAITask(p);
      ai.retarget = 0.6 + Math.random() * 0.4;
    }
    if (!ai.task) { p.moveInput = { x: 0, y: 0 }; return; }

    // 目標タイルに向かって移動
    const target = ai.task.tile;
    if (target) {
      const tx = target.x + 0.5, ty = target.y + 0.5;
      // ステーションの手前（隣の床）に立つ
      const stand = this.standCellFor(target);
      const gx = stand.x + 0.5, gy = stand.y + 0.5;
      const dx = gx - p.x, dy = gy - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.18) {
        p.moveInput = { x: dx / dist, y: dy / dist };
        p.dir = { x: dx / dist, y: dy / dist };
      } else {
        p.moveInput = { x: 0, y: 0 };
        // ステーションの方を向く
        const fdx = tx - p.x, fdy = ty - p.y;
        const fl = Math.hypot(fdx, fdy) || 1;
        p.dir = { x: fdx / fl, y: fdy / fl };
        // 相互作用
        if (ai.cooldown <= 0) {
          this.aiPerform(p, ai.task);
          ai.cooldown = 0.25;
          if (ai.task.once) { ai.task = null; ai.retarget = 0; }
        }
      }
    }
  }

  // AIの相互作用実行（chop/cook は押し続け扱いなのでフラグで継続）
  aiPerform(p, task) {
    const s = this.facingStation(p);
    if (!s) { this.interact(p); return; }
    if (task.type === 'chopping' || task.type === 'cooking') {
      // 切る/焼く対象なら何もしない（updateで進む）。完了なら取りに来るのは別タスク
      return;
    }
    this.interact(p);
  }

  // AIタスク計画（簡易ユーティリティAI）
  planAITask(p) {
    const orders = this.orders;
    if (orders.length === 0) {
      // 暇なら待機 or 皿を洗う
      const sink = this.stations.find(s => s.station === 'sink' && (s.washQueue > 0));
      if (sink && !p.held) return { tile: sink, type: 'wash', once: false };
      return null;
    }

    // 持っているものに応じて行動
    if (p.held) {
      const h = p.held;
      // 完成皿 → 提供口
      if (h.kind === 'plate' && matchRecipe(h.content)) {
        const serve = this.stations.find(s => s.station === 'serve');
        return { tile: serve, type: 'serve', once: true };
      }
      // 汚れ皿 → シンク
      if (h.kind === 'plate' && !h.clean) {
        const sink = this.stations.find(s => s.station === 'sink');
        return { tile: sink, type: 'dropdirty', once: true };
      }
      // 生で切れる食材 → まな板（空き）
      if (h.kind === 'ingredient' && h.state === 'raw' && INGREDIENTS[h.id].canChop && !INGREDIENTS[h.id].canCook) {
        const chop = this.freeStation('chop');
        if (chop) return { tile: chop, type: 'placechop', once: true };
      }
      // 生で焼ける（肉魚） → コンロ
      if (h.kind === 'ingredient' && (h.state === 'raw' || h.state === 'chopped') && INGREDIENTS[h.id].canCook) {
        // 肉などは切らずに焼く設計（chopped不要）。raw のままコンロへ
        const cook = this.freeStation('cook');
        if (cook) return { tile: cook, type: 'placecook', once: true };
      }
      // 切った/焼いた食材 → 皿に盛る or 皿を取りに行く
      if (h.kind === 'ingredient' && (h.state === 'chopped' || h.state === 'cooked')) {
        // 既に作りかけの皿（counter上）があればそこへ。なければ皿置き場の皿に盛る
        const plates = this.stations.find(s => s.station === 'plates');
        return { tile: plates, type: 'plate-need', once: true };
      }
      // それ以外（手詰まり）→ ゴミ箱
      const trash = this.stations.find(s => s.station === 'trash');
      return { tile: trash, type: 'trash', once: true };
    }

    // 手ぶら: 必要な食材を集める。最優先オーダーの不足食材を取りに行く
    const order = orders[0];
    const needed = this.computeNeeded(order.recipe);
    if (needed.length > 0) {
      const ni = needed[0];
      // すでに切れた/焼けた食材がカウンターにあるなら取りに行く
      const ready = this.stations.find(s => s.item && s.item.kind === 'ingredient'
        && s.item.id === ni.id && s.item.state === ni.state);
      if (ready) return { tile: ready, type: 'takeready', once: true };
      // 調理が必要な状態なら、生食材を箱から取りに行く
      const box = this.stations.find(s => s.station === 'box' && s.ingredient === ni.id);
      if (box) return { tile: box, type: 'getbox', once: true };
    }
    // 完成皿を作るために皿を用意する人がいないなら皿を取る
    const platesStation = this.stations.find(s => s.station === 'plates');
    if (platesStation) return { tile: platesStation, type: 'getplate', once: true };
    return null;
  }

  freeStation(type) {
    return this.stations.find(s => s.station === type && !s.item);
  }

  // オーダーに必要で、まだ皿に盛られていない調理済み食材
  computeNeeded(recipeKey) {
    const rec = RECIPES[recipeKey];
    if (!rec) return [];
    // ここでは単純に全項目を「必要」とみなす（皿状況の厳密追跡は省略）
    return rec.items.map(i => ({ id: i.id, state: i.state }));
  }

  // ステーションの手前に立つべき床セル
  standCellFor(tile) {
    const cand = [
      { x: tile.x, y: tile.y + 1 }, { x: tile.x, y: tile.y - 1 },
      { x: tile.x + 1, y: tile.y }, { x: tile.x - 1, y: tile.y },
    ];
    for (const c of cand) {
      if (c.y >= 0 && c.y < this.rows && c.x >= 0 && c.x < this.cols) {
        const t = this.tiles[c.y][c.x];
        if (t && t.type === 'floor') return c;
      }
    }
    return { x: tile.x, y: tile.y + 1 };
  }

  // ====== メインシミュレーション ======
  tick() {
    const dt = TICK_MS / 1000;
    this._elapsed += TICK_MS;

    // オーダー出現
    this.nextOrderAt -= TICK_MS;
    if (this.nextOrderAt <= 0 && this.orders.length < this.stage.maxOrders) {
      this.spawnOrder();
      const [lo, hi] = this.stage.orderInterval;
      this.nextOrderAt = lo + Math.random() * (hi - lo);
    }

    // オーダーの時間経過
    for (let i = this.orders.length - 1; i >= 0; i--) {
      this.orders[i].timeLeft -= dt;
      if (this.orders[i].timeLeft <= 0) {
        this.orders.splice(i, 1);
        this.score = Math.max(0, this.score - 6);  // 失敗ペナルティ
        this.combo = 0;
        this.io.to(this.room.code).emit('game:expired', { score: this.score });
      }
    }

    // 各プレイヤー処理
    for (const id in this.players) {
      const p = this.players[id];
      if (p.dashCd > 0) p.dashCd -= dt;
      if (p.dashTime > 0) p.dashTime -= dt;

      if (p.isAI) this.updateAI(p, dt);

      // 移動
      let speed = PLAYER_SPEED;
      if (p.dashTime > 0) speed = PLAYER_SPEED * 2.6;
      const vx = p.moveInput.x * speed * dt;
      const vy = p.moveInput.y * speed * dt;
      this.moveWithCollision(p, vx, vy);

      // 切る/焼く進捗（プレイヤーが対象ステーションの前にいる時に進む）
      this.updateActiveStation(p, dt);
    }

    // 全コンロの自動進行（プレイヤー不在でも焼ける／焦げる）
    for (const s of this.stations) {
      if (s.station !== 'cook') continue;
      if (s.cookState === 'cooking' && s.item && s.item.kind === 'ingredient') {
        s.progress += dt / (COOK_TIME / 1000);
        if (s.progress >= 1) {
          s.progress = 1;
          s.item.state = 'cooked';
          s.cookState = 'done';
          s.cookTimer = 0;
          this.emitFx(s.x, s.y, 'cook-done');
        }
      } else if (s.cookState === 'done' && s.item && s.item.kind === 'ingredient') {
        s.cookTimer += dt;
        if (s.cookTimer >= BURN_TIME / 1000) {
          s.item.state = 'burnt';
          s.cookState = 'burnt';
          this.emitFx(s.x, s.y, 'burn');
        }
      }
    }

    // ブロードキャスト（約20fps）
    this._lastBroadcast += TICK_MS;
    if (this._lastBroadcast >= 50) {
      this._lastBroadcast = 0;
      this.broadcastState();
    }
  }

  // プレイヤーが前方ステーションで「切る/焼く/洗う」を進める
  updateActiveStation(p, dt) {
    const s = this.facingStation(p);
    p.actionStation = s ? { x: s.x, y: s.y } : null;

    if (!s) { p.action = null; return; }

    // 切る: chop ステーションに raw 食材があり、プレイヤーが手ぶらで前に立つと進む
    if (s.station === 'chop' && s.item && s.item.kind === 'ingredient'
        && s.item.state === 'raw' && INGREDIENTS[s.item.id].canChop && !p.held) {
      p.action = 'chop';
      s.progress += dt / (CHOP_TIME / 1000);
      if (s.progress >= 1) {
        s.item.state = 'chopped'; s.progress = 0; s.action = null;
        this.emitFx(s.x, s.y, 'chop-done');
      }
      return;
    }

    // 焼く: cook ステーションは自動進行（プレイヤー不要）だが、ここで done 判定
    if (s.station === 'cook' && s.item && s.item.kind === 'ingredient'
        && s.cookState === 'cooking') {
      // 自動進行は下のブロックで（プレイヤー不在でも進むべき）
    }

    // 皿洗い: sink に washQueue>0 で手ぶらなら進む
    if (s.station === 'sink' && s.washQueue > 0 && !p.held && !s.item) {
      p.action = 'wash';
      s.progress += dt / (WASH_TIME / 1000);
      if (s.progress >= 1) {
        s.progress = 0; s.washQueue -= 1; s.item = makeCleanPlate();
        this.emitFx(s.x, s.y, 'wash-done');
      }
      return;
    }

    p.action = null;
  }

  // コンロは自動で焼ける（プレイヤーが置いたら勝手に進む）— tick全体で処理
  // 上のtickに統合: cookingの進行をここで回す
  // （updateActiveStationとは別に、全コンロを毎tick進める）

  moveWithCollision(p, vx, vy) {
    // X方向
    let nx = p.x + vx;
    if (!this.blocked(nx, p.y)) p.x = nx;
    let ny = p.y + vy;
    if (!this.blocked(p.x, ny)) p.y = ny;
    // 範囲クランプ
    p.x = Math.max(0.4, Math.min(this.cols - 0.4, p.x));
    p.y = Math.max(0.4, Math.min(this.rows - 0.4, p.y));
  }

  blocked(x, y) {
    const r = PLAYER_RADIUS;
    const cells = [
      [x - r, y - r], [x + r, y - r], [x - r, y + r], [x + r, y + r],
    ];
    for (const [cx, cy] of cells) {
      const gx = Math.floor(cx), gy = Math.floor(cy);
      if (gy < 0 || gy >= this.rows || gx < 0 || gx >= this.cols) return true;
      const t = this.tiles[gy][gx];
      if (!t || t.type !== 'floor') return true;
    }
    return false;
  }

  // 状態を全クライアントへ送る（描画用にシリアライズ）
  broadcastState() {
    const players = Object.values(this.players).map(p => ({
      id: p.id, name: p.name, isAI: p.isAI, color: p.color,
      x: +p.x.toFixed(3), y: +p.y.toFixed(3),
      dir: { x: +p.dir.x.toFixed(2), y: +p.dir.y.toFixed(2) },
      held: serializeItem(p.held),
      action: p.action,
      dashCd: +p.dashCd.toFixed(2),
    }));
    const stations = this.stations.map(s => ({
      x: s.x, y: s.y, station: s.station, ingredient: s.ingredient || null,
      item: serializeItem(s.item),
      progress: +(s.progress || 0).toFixed(3),
      cookState: s.cookState || null,
      cookTimer: +(s.cookTimer || 0).toFixed(2),
      washQueue: s.washQueue || 0,
    }));
    const orders = this.orders.map(o => ({
      id: o.id, recipe: o.recipe,
      timeLeft: +o.timeLeft.toFixed(1), timeTotal: o.timeTotal,
    }));
    this.io.to(this.room.code).emit('game:state', {
      t: Date.now(), players, stations, orders,
      score: this.score, timeLeft: this.timeLeft,
      combo: this.combo || 0,
    });
  }

  // 静的なステージ情報（開始時に1度送る）
  staticInfo() {
    return {
      stage: { id: this.stage.id, name: this.stage.name, desc: this.stage.desc,
               duration: this.stage.duration, targetScore: this.stage.targetScore,
               starScores: this.stage.starScores },
      cols: this.cols, rows: this.rows,
      tiles: this.tiles.map(row => row.map(t => ({
        type: t.type, station: t.station || null, ingredient: t.ingredient || null,
      }))),
    };
  }

  removePlayer(id) {
    const p = this.players[id];
    if (p && p.held) {
      // 持っていたものはドロップ消滅（簡易）
    }
    delete this.players[id];
  }
}

function serializeItem(it) {
  if (!it) return null;
  if (it.kind === 'ingredient') return { kind: 'ingredient', id: it.id, state: it.state };
  if (it.kind === 'plate') return { kind: 'plate', clean: it.clean, content: it.content.slice(), dish: it.dish || matchRecipe(it.content) };
  return null;
}
