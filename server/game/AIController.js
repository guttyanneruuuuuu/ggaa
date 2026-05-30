// ============================================================
// AIController - AIシェフの頭脳
//   注文を見て「次に必要な食材」を判断し、
//   取り出す→刻む→焼く→皿に乗せる→提供 を自律的に行う。
//   グリッド上の経路探索(BFS)で目的ステーションへ移動する。
// ============================================================

import { INGREDIENTS, RECIPES, CHOP_TIME, PLAYER_SPEED } from './config.js';

export class AIController {
  constructor(room, player) {
    this.room = room;
    this.p = player;
    this.task = null;       // 現在のサブタスク
    this.path = null;       // タイル経路
    this.pathIdx = 0;
    this.thinkCd = 0;
    this.actCd = 0;
    this.targetStation = null;
    this.stuck = 0;
    this.lastPos = { x: player.x, y: player.y };
  }

  update(dt) {
    const p = this.p;
    this.thinkCd -= dt;
    this.actCd -= dt;

    // 行き詰まり検知
    const moved = Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y);
    if (moved < 0.01) this.stuck += dt; else this.stuck = 0;
    this.lastPos = { x: p.x, y: p.y };

    if (this.thinkCd <= 0) {
      this.decide();
      this.thinkCd = 0.35;
    }

    this.executeMovement(dt);
    this.executeWork(dt);
  }

  // ---------- 意思決定 ----------
  decide() {
    const room = this.room;
    const p = this.p;

    // 手に皿があり完成 → 提供へ
    if (p.holding && p.holding.type === 'plate' && p.holding.contents.length > 0) {
      // 完成した注文に合致するか確認
      const match = room.matchOrder(p.holding.contents);
      if (match) {
        this.setTask({ kind: 'goServe' });
        return;
      }
      // 注文に合致する見込みがあるなら続行(後述)、無ければ続ける食材を探す
    }

    // 焦げた食材を持っている → ゴミ箱
    if (p.holding && p.holding.type === 'ingredient' && p.holding.state === 'burnt') {
      this.setTask({ kind: 'trash' });
      return;
    }

    // 注文から、まだ皿に乗っていない必要食材を1つ選ぶ
    const need = this.pickNeededIngredient();

    if (!need) {
      // やることが無ければ皿を準備 or 待機
      if (!p.holding) {
        // 皿を取りに行く(将来の提供に備える)... ただし注文が無ければ待機
        if (room.orders.length > 0) {
          this.setTask({ kind: 'getPlate' });
        } else {
          this.task = { kind: 'idle' };
        }
      }
      return;
    }

    // need = {kind, state}
    // 現在の手持ちで対応
    if (p.holding) {
      if (p.holding.type === 'ingredient') {
        const h = p.holding;
        // 既に目的食材を持っている → 必要工程へ
        if (h.kind === need.kind) {
          this.routeIngredient(h, need);
          return;
        } else {
          // 違う食材を持っている → カウンターに一旦置く
          this.setTask({ kind: 'stash' });
          return;
        }
      }
      if (p.holding.type === 'plate') {
        // 皿を持っている。必要食材が皿の状態(plateable)で既にカウンター等にあるなら拾って乗せる
        const ready = this.findReadyItem(need);
        if (ready) {
          this.setTask({ kind: 'plateFrom', station: ready, need });
          return;
        }
        // 無ければ皿を置いて食材作りに行く
        this.setTask({ kind: 'stashPlate' });
        return;
      }
    } else {
      // 手ぶら → 必要食材がどこかに「ちょうど良い状態」で置いてあれば拾う
      const ready = this.findReadyItem(need);
      if (ready) {
        // 皿が必要なので、まず皿を持って…ではなく食材を完成させて皿へ。
        // ここでは「皿を取りに行く」を優先
        this.setTask({ kind: 'getPlate' });
        return;
      }
      // 食材箱から取り出す
      this.setTask({ kind: 'getCrate', kind2: need.kind, need });
      return;
    }
  }

  // 注文の中で、まだ用意されていない食材を1つ選ぶ
  pickNeededIngredient() {
    const room = this.room;
    // 最も時間が少ない注文を優先
    const orders = [...room.orders].sort((a, b) => a.timeLeft - b.timeLeft);
    for (const o of orders) {
      const recipe = RECIPES[o.recipe];
      // この注文を担当中の他AIと被らないよう、簡易に分散
      for (const item of recipe.items) {
        // すでにこの状態の食材が用意されている数を数える
        const ready = this.countReady(item) + this.countInProgress(item);
        const required = recipe.items.filter(i => i.ingredient === item.ingredient && i.state === item.state).length;
        if (ready < required) {
          return { kind: item.ingredient, state: item.state, order: o.id };
        }
      }
    }
    return null;
  }

  countReady(item) {
    let n = 0;
    for (const st of this.room.stations) {
      if ((st.type === 'counter' || st.type === 'cutting' || st.type === 'stove') && st.item &&
          st.item.type === 'ingredient' &&
          st.item.kind === item.ingredient && st.item.state === item.state) n++;
    }
    return n;
  }
  countInProgress(item) {
    // 他プレイヤーが持っている同種食材を概算
    let n = 0;
    for (const pl of this.room.players.values()) {
      if (pl.holding && pl.holding.type === 'ingredient' &&
          pl.holding.kind === item.ingredient) n++;
    }
    return n;
  }

  // 必要状態の食材が置いてあるステーションを探す
  findReadyItem(need) {
    for (const st of this.room.stations) {
      if ((st.type === 'counter' || st.type === 'cutting' || st.type === 'stove') &&
          st.item && st.item.type === 'ingredient' &&
          st.item.kind === need.kind && st.item.state === need.state) {
        return st;
      }
    }
    return null;
  }

  // 持っている食材を必要状態へ進めるための経路を決める
  routeIngredient(h, need) {
    const def = INGREDIENTS[h.kind];
    // 目標状態
    if (need.state === 'chopped' && h.state === 'raw' && def.needsChop) {
      this.setTask({ kind: 'chop' });
      return;
    }
    if (need.state === 'cooked') {
      if (def.needsChop && h.state === 'raw') {
        // 肉/魚など: まず刻む → 焼く ではなくOvercooked簡略で raw->cook OK
        // ここではcrate由来rawを直接焼ける(肉/魚/米/芋)
        this.setTask({ kind: 'cook' });
        return;
      }
      if (h.state === 'raw' || h.state === 'chopped') {
        this.setTask({ kind: 'cook' });
        return;
      }
      if (h.state === 'cooked') {
        // 完成 → 皿へ。皿を取りに行くため一旦置く
        this.setTask({ kind: 'stash' });
        return;
      }
    }
    if (need.state === 'raw') {
      // パンなど。完成状態。皿へ → 一旦置く
      this.setTask({ kind: 'stash' });
      return;
    }
    // 既に目的状態 → 一旦カウンターに置いて皿で拾う
    if (h.state === need.state) {
      this.setTask({ kind: 'stash' });
      return;
    }
    this.setTask({ kind: 'stash' });
  }

  // ---------- タスク設定(目的地決定) ----------
  setTask(task) {
    this.task = task;
    let target = null;
    switch (task.kind) {
      case 'getCrate':
        target = this.nearestStation(s => s.type === 'crate' && s.kind === task.kind2);
        break;
      case 'getPlate':
        target = this.nearestStation(s => s.type === 'plates');
        break;
      case 'chop':
        target = this.nearestStation(s => s.type === 'cutting' && !s.item);
        if (!target) target = this.nearestStation(s => s.type === 'cutting');
        break;
      case 'cook':
        target = this.nearestStation(s => s.type === 'stove' && !s.item);
        if (!target) target = this.nearestStation(s => s.type === 'stove');
        break;
      case 'goServe':
        target = this.nearestStation(s => s.type === 'serve');
        break;
      case 'trash':
        target = this.nearestStation(s => s.type === 'trash');
        break;
      case 'stash':
      case 'stashPlate':
        target = this.nearestStation(s => s.type === 'counter' && !s.item);
        if (!target) target = this.nearestStation(s => s.type === 'counter');
        break;
      case 'plateFrom':
        target = task.station;
        break;
      case 'idle':
        target = null;
        break;
    }
    this.targetStation = target;
    if (target) this.computePath(target);
    else { this.path = null; }
  }

  // ---------- 経路探索(BFS, 隣接タイルへ) ----------
  computePath(station) {
    const room = this.room;
    const start = { x: Math.floor(this.p.x), y: Math.floor(this.p.y) };
    // ステーションは solid。隣接する床タイルをゴールにする
    const goals = this.adjacentFloors(station.gx, station.gy);
    if (goals.length === 0) { this.path = null; return; }

    const key = (x, y) => x + ',' + y;
    const goalSet = new Set(goals.map(g => key(g.x, g.y)));
    const q = [start];
    const came = new Map();
    came.set(key(start.x, start.y), null);
    let found = null;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    while (q.length) {
      const cur = q.shift();
      if (goalSet.has(key(cur.x, cur.y))) { found = cur; break; }
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= room.cols || ny >= room.rows) continue;
        if (room.solid[ny][nx]) continue;
        const k = key(nx, ny);
        if (!came.has(k)) {
          came.set(k, cur);
          q.push({ x: nx, y: ny });
        }
      }
    }
    if (!found) { this.path = null; return; }
    // 復元
    const path = [];
    let c = found;
    while (c) { path.push({ x: c.x + 0.5, y: c.y + 0.5 }); c = came.get(key(c.x, c.y)); }
    path.reverse();
    this.path = path;
    this.pathIdx = 0;
  }

  adjacentFloors(gx, gy) {
    const room = this.room;
    const res = [];
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= room.cols || ny >= room.rows) continue;
      if (!room.solid[ny][nx]) res.push({ x: nx, y: ny });
    }
    return res;
  }

  nearestStation(pred) {
    let best = null, bestD = Infinity;
    for (const s of this.room.stations) {
      if (!pred(s)) continue;
      const d = Math.hypot(s.gx + 0.5 - this.p.x, s.gy + 0.5 - this.p.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // ---------- 移動実行 ----------
  executeMovement(dt) {
    const p = this.p;
    if (!this.path || this.pathIdx >= this.path.length) {
      p.input.mx = 0; p.input.my = 0;
      return;
    }
    let wp = this.path[this.pathIdx];
    let dx = wp.x - p.x, dy = wp.y - p.y;
    let dist = Math.hypot(dx, dy);
    if (dist < 0.12) {
      this.pathIdx++;
      if (this.pathIdx >= this.path.length) { p.input.mx = 0; p.input.my = 0; return; }
      wp = this.path[this.pathIdx];
      dx = wp.x - p.x; dy = wp.y - p.y; dist = Math.hypot(dx, dy);
    }
    if (dist > 0.001) {
      p.input.mx = dx / dist;
      p.input.my = dy / dist;
    }
    // 詰まり時に再計算
    if (this.stuck > 0.6 && this.targetStation) {
      this.computePath(this.targetStation);
      this.stuck = 0;
    }
  }

  atTarget() {
    if (!this.targetStation) return false;
    // ステーションに隣接 & 向いているか
    const adj = this.adjacentFloors(this.targetStation.gx, this.targetStation.gy);
    for (const a of adj) {
      if (Math.hypot(a.x + 0.5 - this.p.x, a.y + 0.5 - this.p.y) < 0.5) return true;
    }
    return false;
  }

  faceTarget() {
    if (!this.targetStation) return;
    const dx = this.targetStation.gx + 0.5 - this.p.x;
    const dy = this.targetStation.gy + 0.5 - this.p.y;
    const m = Math.hypot(dx, dy) || 1;
    this.p.facing = { x: dx / m, y: dy / m };
    this.p.dir = Math.atan2(dy, dx);
  }

  // ---------- 作業実行(到着後のインタラクション) ----------
  executeWork(dt) {
    const p = this.p, room = this.room;
    if (!this.task || this.task.kind === 'idle') return;
    if (!this.atTarget()) return;
    this.faceTarget();

    const st = this.targetStation;
    if (!st) return;

    switch (this.task.kind) {
      case 'getCrate':
        if (!p.holding) { room.interact(p); this.thinkCd = 0; this.task = null; }
        else { this.task = null; this.thinkCd = 0; }
        break;
      case 'getPlate':
        if (!p.holding) { room.interact(p); this.thinkCd = 0; this.task = null; }
        else { this.task = null; this.thinkCd = 0; }
        break;
      case 'chop': {
        // 置く → 刻む → 取る
        if (p.holding && p.holding.type === 'ingredient' && !st.item) {
          room.interact(p); // 置く
        } else if (st.item && st.item.type === 'ingredient' && st.item.state === 'raw') {
          const done = room.chopAt(st, dt);
          if (done) { /* 完了、次tickで取る */ }
        } else if (!p.holding && st.item && st.item.state !== 'raw') {
          room.interact(p); // 取る
          this.task = null; this.thinkCd = 0;
        }
        break;
      }
      case 'cook': {
        if (p.holding && p.holding.type === 'ingredient' && !st.item) {
          room.interact(p); // 置いて調理開始
          this.task = null; this.thinkCd = 0.5;
        } else if (!p.holding && st.item && st.item.state === 'cooked') {
          room.interact(p); // 取る
          this.task = null; this.thinkCd = 0;
        } else {
          // 調理待ち。少し待って別の事を考える(ここでは待機)
          this.task = null; this.thinkCd = 0.4;
        }
        break;
      }
      case 'goServe':
        if (this.actCd <= 0) {
          room.interact(p);
          this.actCd = 0.5; this.task = null; this.thinkCd = 0;
        }
        break;
      case 'trash':
        room.interact(p); this.task = null; this.thinkCd = 0;
        break;
      case 'stash':
      case 'stashPlate':
        if (p.holding && !st.item) { room.interact(p); this.task = null; this.thinkCd = 0; }
        else { this.task = null; this.thinkCd = 0.2; }
        break;
      case 'plateFrom': {
        // 皿を持って食材があるステーションから拾い上げる(=合成)
        if (p.holding && p.holding.type === 'plate' && st.item) {
          room.interact(p); // combineで皿に乗る
          this.task = null; this.thinkCd = 0;
        } else {
          this.task = null; this.thinkCd = 0.2;
        }
        break;
      }
    }
  }
}
