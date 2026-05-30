// ============================================================
//  recipes.js — 食材・レシピ・ステージ定義（サーバー権威）
//  オーバークック風の調理ロジックの中核データ
// ============================================================

// ---- 食材定義 ----
// state: raw(生) -> chopped(切った) -> cooked(調理済) など
export const INGREDIENTS = {
  tomato:   { name: 'トマト',     emoji: '🍅', color: '#e74c3c', canChop: true,  canCook: false },
  lettuce:  { name: 'レタス',     emoji: '🥬', color: '#27ae60', canChop: true,  canCook: false },
  onion:    { name: 'たまねぎ',   emoji: '🧅', color: '#c9a26b', canChop: true,  canCook: false },
  cucumber: { name: 'きゅうり',   emoji: '🥒', color: '#2ecc71', canChop: true,  canCook: false },
  meat:     { name: 'お肉',       emoji: '🥩', color: '#d35480', canChop: false, canCook: true  },
  fish:     { name: 'おさかな',   emoji: '🐟', color: '#5dade2', canChop: false, canCook: true  },
  rice:     { name: 'お米',       emoji: '🍚', color: '#f4f4f4', canChop: false, canCook: true  },
  bread:    { name: 'パン',       emoji: '🍞', color: '#e0a96d', canChop: false, canCook: false },
  potato:   { name: 'じゃがいも', emoji: '🥔', color: '#d8b56b', canChop: false, canCook: true  },
};

// ---- 調理アクションの所要時間(ミリ秒) ----
export const CHOP_TIME = 2600;   // まな板で切る
export const COOK_TIME = 5200;   // コンロで調理
export const BURN_TIME = 4200;   // 調理完了後これだけ放置すると焦げる
export const WASH_TIME = 1800;   // 皿洗い1枚あたり

// ---- レシピ定義 ----
// items: 必要な「調理済み食材」の集合（順不同）
//   各要素は { id, state } 。state: 'chopped' | 'cooked'
// plate: 盛り付けが必要か（基本true）
export const RECIPES = {
  salad: {
    name: 'サラダ', emoji: '🥗', color: '#27ae60', reward: 14, time: 50,
    items: [ { id: 'tomato', state: 'chopped' }, { id: 'lettuce', state: 'chopped' } ],
  },
  greek_salad: {
    name: 'グリークサラダ', emoji: '🥙', color: '#16a085', reward: 20, time: 60,
    items: [ { id: 'tomato', state: 'chopped' }, { id: 'cucumber', state: 'chopped' }, { id: 'onion', state: 'chopped' } ],
  },
  steak: {
    name: 'ステーキ', emoji: '🍖', color: '#c0392b', reward: 22, time: 60,
    items: [ { id: 'meat', state: 'cooked' } ],
  },
  burger: {
    name: 'バーガー', emoji: '🍔', color: '#e67e22', reward: 28, time: 70,
    items: [ { id: 'meat', state: 'cooked' }, { id: 'lettuce', state: 'chopped' }, { id: 'tomato', state: 'chopped' } ],
  },
  fish_dish: {
    name: 'ムニエル', emoji: '🐠', color: '#2980b9', reward: 24, time: 65,
    items: [ { id: 'fish', state: 'cooked' }, { id: 'lettuce', state: 'chopped' } ],
  },
  rice_bowl: {
    name: 'ライスボウル', emoji: '🍱', color: '#8e44ad', reward: 26, time: 65,
    items: [ { id: 'rice', state: 'cooked' }, { id: 'meat', state: 'cooked' } ],
  },
  fries: {
    name: 'フライドポテト', emoji: '🍟', color: '#f39c12', reward: 18, time: 55,
    items: [ { id: 'potato', state: 'cooked' } ],
  },
};

// レシピのマッチ判定。盛り付け済みの皿(content配列)が、あるレシピに一致するか
export function matchRecipe(content) {
  if (!content || content.length === 0) return null;
  for (const [key, rec] of Object.entries(RECIPES)) {
    if (rec.items.length !== content.length) continue;
    // content の各要素 {id,state} がレシピの items と多重集合として一致するか
    const need = rec.items.map(i => i.id + ':' + i.state).sort();
    const have = content.map(c => c.id + ':' + c.state).sort();
    if (need.length === have.length && need.every((v, idx) => v === have[idx])) {
      return key;
    }
  }
  return null;
}

// ============================================================
//  ステージ（レベル）定義
//  grid: 文字列の2D配列。1文字=1タイル。
//   ' ' 床 / '#' 壁(通行不可・装飾) / 'C' まな板 / 'K' コンロ
//   'P' 皿置き場(空き皿が出る) / 'S' 提供口 / 'W' シンク(皿洗い)
//   'T' ゴミ箱 / 数字や英字小文字 = 食材箱(下のboxesで定義)
//   '@' プレイヤースポーン候補
// ============================================================

// 食材箱の記号割り当て（各ステージで使用）
// 例: 'a'->tomato。stationsで参照。
function box(id) { return { type: 'box', ingredient: id }; }

export const STAGES = [
  {
    id: 'kitchen1',
    name: 'はじめてのキッチン',
    desc: 'サラダとステーキで肩慣らし',
    duration: 130,          // 秒
    targetScore: 70,
    starScores: [70, 120, 170],
    orderMenu: ['salad', 'steak', 'greek_salad'],
    orderInterval: [6500, 9500],
    maxOrders: 4,
    grid: [
      '#########',
      '#a  C   S#',
      '#b      .#',
      '#  @  @  W#',
      '#c  K   P#',
      '#d  K   T#',
      '#########',
    ],
    boxes: { a: 'tomato', b: 'lettuce', c: 'meat', d: 'onion' },
  },
  {
    id: 'kitchen2',
    name: 'いそがしランチ',
    desc: 'バーガーとムニエル！分担がカギ',
    duration: 150,
    targetScore: 110,
    starScores: [110, 170, 240],
    orderMenu: ['burger', 'fish_dish', 'salad', 'steak'],
    orderInterval: [5500, 8500],
    maxOrders: 5,
    grid: [
      '###########',
      '#a  C C   S#',
      '#b        .#',
      '#c  @  @   W#',
      '#e        P#',
      '#f  K K   T#',
      '###########',
    ],
    boxes: { a: 'tomato', b: 'lettuce', c: 'meat', e: 'fish', f: 'onion' },
  },
  {
    id: 'kitchen3',
    name: 'ディナーラッシュ',
    desc: '高難度！ライスボウルにポテトに大忙し',
    duration: 170,
    targetScore: 150,
    starScores: [150, 230, 320],
    orderMenu: ['rice_bowl', 'fries', 'burger', 'greek_salad', 'fish_dish'],
    orderInterval: [4800, 7500],
    maxOrders: 6,
    grid: [
      '#############',
      '#a C  C  C  S#',
      '#b          .#',
      '#c   @  @    W#',
      '#e          P#',
      '#f K  K  K  T#',
      '#g          .#',
      '#############',
    ],
    boxes: { a: 'tomato', b: 'lettuce', c: 'meat', e: 'fish', f: 'rice', g: 'potato' },
  },
];

export function getStage(id) {
  return STAGES.find(s => s.id === id) || STAGES[0];
}
