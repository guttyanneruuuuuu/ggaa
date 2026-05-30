// ============================================================
// Kitchen Chaos - ゲーム設定 / レシピ / 食材 / レベル定義
// (Overcooked風 協力料理ゲーム)
// すべてのワールド座標は「タイル」単位。1タイル = 64px相当。
// ============================================================

export const TILE = 64;            // 1タイルのピクセルサイズ(描画基準)
export const TICK_RATE = 30;       // サーバーtick/秒
export const TICK_MS = 1000 / TICK_RATE;

// --- 食材 (ingredients) ---
// state: raw(生) / chopped(刻んだ) / cooked(調理済) / burnt(焦げ)
export const INGREDIENTS = {
  tomato:  { name: 'トマト',   color: '#e63946', emoji: '🍅', needsChop: true,  needsCook: false },
  lettuce: { name: 'レタス',   color: '#7bc043', emoji: '🥬', needsChop: true,  needsCook: false },
  onion:   { name: 'たまねぎ', color: '#e9c46a', emoji: '🧅', needsChop: true,  needsCook: false },
  meat:    { name: 'にく',     color: '#c1440e', emoji: '🥩', needsChop: true,  needsCook: true  },
  fish:    { name: 'さかな',   color: '#a8dadc', emoji: '🐟', needsChop: true,  needsCook: true  },
  rice:    { name: 'こめ',     color: '#f1faee', emoji: '🍚', needsChop: false, needsCook: true  },
  bread:   { name: 'パン',     color: '#d4a373', emoji: '🍞', needsChop: false, needsCook: false },
  potato:  { name: 'じゃがいも', color: '#e9c46a', emoji: '🥔', needsChop: true,  needsCook: true  },
};

// --- レシピ (recipes) ---
// items: 必要な {ingredient, state} の配列。順不同。
// time:  注文の制限時間(秒)。score: 成功時のスコア。
export const RECIPES = {
  salad: {
    name: 'サラダ', emoji: '🥗', score: 60, time: 60,
    items: [
      { ingredient: 'tomato',  state: 'chopped' },
      { ingredient: 'lettuce', state: 'chopped' },
    ],
  },
  onionSalad: {
    name: 'オニオンサラダ', emoji: '🥗', score: 80, time: 65,
    items: [
      { ingredient: 'lettuce', state: 'chopped' },
      { ingredient: 'onion',   state: 'chopped' },
      { ingredient: 'tomato',  state: 'chopped' },
    ],
  },
  burger: {
    name: 'バーガー', emoji: '🍔', score: 100, time: 75,
    items: [
      { ingredient: 'bread', state: 'raw' },
      { ingredient: 'meat',  state: 'cooked' },
      { ingredient: 'lettuce', state: 'chopped' },
    ],
  },
  steak: {
    name: 'ステーキ', emoji: '🍖', score: 90, time: 70,
    items: [
      { ingredient: 'meat',   state: 'cooked' },
      { ingredient: 'potato', state: 'cooked' },
    ],
  },
  sushi: {
    name: 'すし', emoji: '🍣', score: 110, time: 75,
    items: [
      { ingredient: 'rice', state: 'cooked' },
      { ingredient: 'fish', state: 'chopped' },
    ],
  },
  riceBowl: {
    name: 'どんぶり', emoji: '🍲', score: 95, time: 70,
    items: [
      { ingredient: 'rice', state: 'cooked' },
      { ingredient: 'meat', state: 'cooked' },
      { ingredient: 'onion', state: 'chopped' },
    ],
  },
};

// 調理時間(秒)
export const COOK_TIME = 5;       // 鍋/コンロで調理完了までの時間
export const BURN_TIME = 6;       // 調理完了後、放置するとこの秒数で焦げる
export const CHOP_TIME = 2.0;     // まな板で刻むのに必要な合計押下時間
export const PLAYER_SPEED = 4.2;  // タイル/秒
export const PLAYER_RADIUS = 0.34;

// ステーションの種類
// floor      : 通路
// wall       : 壁(通行不可)
// counter    : カウンター(物を置ける)
// cutting    : まな板(刻む)
// stove      : コンロ(鍋で調理)
// crate_*    : 食材箱(取り出す) 例 crate_tomato
// plates     : 皿置き場
// serve      : 提供口
// trash      : ゴミ箱
// wash       : 洗い場(汚れた皿を洗う) ※簡易版では未使用可

// --- レベル定義 ---
// グリッドは文字列の配列。各文字が1タイル。
// 凡例:
//  '.' floor   '#' wall   'C' counter
//  'X' cutting 'O' stove  'P' plates  'S' serve  'T' trash
//  数字/英字 crate: a=tomato b=lettuce c=onion d=meat e=fish f=rice g=bread h=potato
//  '1'..'4' プレイヤースポーン
export const CRATE_MAP = {
  a: 'tomato', b: 'lettuce', c: 'onion', d: 'meat',
  e: 'fish',   f: 'rice',    g: 'bread', h: 'potato',
};

export const LEVELS = [
  {
    name: 'はじめてのキッチン',
    duration: 150,
    targetScore: 200,
    recipes: ['salad', 'onionSalad'],
    grid: [
      '#############',
      '#a..........#',
      '#b...CCCC...X#',
      '#c..........#',
      'C...1....2..X',
      'P...........#',
      '#...CCCC....S',
      '#..........T#',
      '#############',
    ],
  },
  {
    name: 'やきもの食堂',
    duration: 180,
    targetScore: 350,
    recipes: ['burger', 'steak', 'salad'],
    grid: [
      '###############',
      '#g..C....C..d.#',
      '#b..C....C....X',
      '#h............X',
      'C....1....2...O',
      'P.............O',
      'C....3....4...#',
      '#....CCCC.....S',
      '#............T#',
      '###############',
    ],
  },
  {
    name: 'すし名人への道',
    duration: 200,
    targetScore: 500,
    recipes: ['sushi', 'riceBowl', 'onionSalad', 'burger'],
    grid: [
      '################',
      '#f..e....a..b..#',
      '#c..d....g..h..X',
      'C..............X',
      'C....1....2....O',
      'P..............O',
      'C....3....4....O',
      '#....CCCCCC....S',
      '#.............T#',
      '################',
    ],
  },
];
