// ============================================================
//  index.js — Express + Socket.IO サーバー
//  ルーム管理 / マッチング / co-op & AIモード / ゲーム駆動
// ============================================================
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import { Game } from './game.js';
import { STAGES } from './recipes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

// ====== ルーム管理 ======
const rooms = new Map();   // code -> room
const PLAYER_COLORS = ['#ff5a5f', '#4fc3f7', '#ffd54f', '#81c784', '#ba68c8', '#ff9248'];
const AI_NAMES = ['ロボ', 'メカ', 'ボット', 'ナノ', 'ピコ', 'チップ'];

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function makeRoom(hostId, mode) {
  const code = genCode();
  const room = {
    code, hostId, mode,            // mode: 'coop' | 'ai'
    players: [],                   // { id, name, isAI, color, ready }
    stageId: STAGES[0].id,
    game: null,
    state: 'lobby',                // 'lobby' | 'playing' | 'over'
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function colorFor(room) {
  const used = new Set(room.players.map(p => p.color));
  return PLAYER_COLORS.find(c => !used.has(c)) || PLAYER_COLORS[room.players.length % PLAYER_COLORS.length];
}

function addPlayer(room, id, name, isAI = false) {
  if (room.players.length >= 4) return null;
  const p = { id, name: name || (isAI ? 'AI' : 'シェフ'), isAI, color: colorFor(room) };
  room.players.push(p);
  return p;
}

function aiId() { return 'ai_' + Math.random().toString(36).slice(2, 9); }

function lobbyPayload(room) {
  return {
    code: room.code, mode: room.mode, hostId: room.hostId,
    stageId: room.stageId, state: room.state,
    stages: STAGES.map(s => ({ id: s.id, name: s.name, desc: s.desc,
      duration: s.duration, targetScore: s.targetScore })),
    players: room.players.map(p => ({ id: p.id, name: p.name, isAI: p.isAI, color: p.color })),
  };
}

function pushLobby(room) {
  io.to(room.code).emit('room:lobby', lobbyPayload(room));
}

function cleanupRoom(room) {
  if (room.game) { room.game.stop(); room.game = null; }
  rooms.delete(room.code);
}

// ====== Socket 接続 ======
io.on('connection', (socket) => {
  let myRoom = null;

  function leaveRoom() {
    if (!myRoom) return;
    const room = myRoom;
    // ゲーム中なら退場
    if (room.game) room.game.removePlayer(socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(room.code);
    myRoom = null;
    // ホスト不在 or 人間ゼロなら閉じる
    const humans = room.players.filter(p => !p.isAI);
    if (humans.length === 0) {
      cleanupRoom(room);
    } else {
      if (room.hostId === socket.id) room.hostId = humans[0].id;
      pushLobby(room);
    }
  }

  // --- AIモード: 部屋を作りAIを足す ---
  socket.on('room:createAI', ({ name, aiCount }, cb) => {
    leaveRoom();
    const room = makeRoom(socket.id, 'ai');
    myRoom = room;
    socket.join(room.code);
    addPlayer(room, socket.id, name);
    const n = Math.max(1, Math.min(3, aiCount || 1));
    for (let i = 0; i < n; i++) {
      addPlayer(room, aiId(), AI_NAMES[i % AI_NAMES.length], true);
    }
    cb && cb({ ok: true, code: room.code });
    pushLobby(room);
  });

  // --- co-opモード: 部屋を作る ---
  socket.on('room:create', ({ name }, cb) => {
    leaveRoom();
    const room = makeRoom(socket.id, 'coop');
    myRoom = room;
    socket.join(room.code);
    addPlayer(room, socket.id, name);
    cb && cb({ ok: true, code: room.code });
    pushLobby(room);
  });

  // --- 部屋に参加 ---
  socket.on('room:join', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { cb && cb({ ok: false, error: 'ルームが見つからないよ' }); return; }
    if (room.state !== 'lobby') { cb && cb({ ok: false, error: 'もうゲームが始まってるよ' }); return; }
    if (room.players.filter(p => !p.isAI).length >= 4) { cb && cb({ ok: false, error: '満員だよ' }); return; }
    leaveRoom();
    myRoom = room;
    socket.join(room.code);
    addPlayer(room, socket.id, name);
    cb && cb({ ok: true, code: room.code });
    pushLobby(room);
  });

  // --- ステージ選択（ホストのみ） ---
  socket.on('room:setStage', ({ stageId }) => {
    if (!myRoom || myRoom.hostId !== socket.id) return;
    if (STAGES.find(s => s.id === stageId)) {
      myRoom.stageId = stageId;
      pushLobby(myRoom);
    }
  });

  // --- AI追加/削除（ホストのみ） ---
  socket.on('room:addAI', () => {
    if (!myRoom || myRoom.hostId !== socket.id) return;
    if (myRoom.players.length >= 4) return;
    const idx = myRoom.players.filter(p => p.isAI).length;
    addPlayer(myRoom, aiId(), AI_NAMES[idx % AI_NAMES.length], true);
    pushLobby(myRoom);
  });
  socket.on('room:removeAI', () => {
    if (!myRoom || myRoom.hostId !== socket.id) return;
    const lastAIidx = [...myRoom.players].reverse().findIndex(p => p.isAI);
    if (lastAIidx === -1) return;
    const realIdx = myRoom.players.length - 1 - lastAIidx;
    myRoom.players.splice(realIdx, 1);
    pushLobby(myRoom);
  });

  // --- ゲーム開始（ホストのみ） ---
  socket.on('game:start', () => {
    const room = myRoom;
    if (!room || room.hostId !== socket.id || room.state === 'playing') return;
    if (room.players.length === 0) return;
    room.state = 'playing';
    room.game = new Game(room, io, () => {
      room.state = 'over';
    });
    io.to(room.code).emit('game:init', {
      static: room.game.staticInfo(),
      players: room.players.map(p => ({ id: p.id, name: p.name, isAI: p.isAI, color: p.color })),
      youId: null, // 各自で判定
    });
    // 少し待ってからスタート（カウントダウンはクライアント側）
    setTimeout(() => { if (room.game) room.game.start(); }, 3200);
  });

  // --- 入力 ---
  socket.on('in:move', ({ x, y }) => {
    if (myRoom && myRoom.game) myRoom.game.setMove(socket.id, x, y);
  });
  socket.on('in:interact', () => {
    if (myRoom && myRoom.game) myRoom.game.doInteract(socket.id);
  });
  socket.on('in:dash', () => {
    if (myRoom && myRoom.game) myRoom.game.doDash(socket.id);
  });

  // --- ロビーに戻る / もう一度 ---
  socket.on('game:backToLobby', () => {
    const room = myRoom;
    if (!room || room.hostId !== socket.id) return;
    if (room.game) { room.game.stop(); room.game = null; }
    room.state = 'lobby';
    pushLobby(room);
  });

  socket.on('disconnect', () => { leaveRoom(); });
  socket.on('room:leave', () => { leaveRoom(); pushLobby && myRoom && pushLobby(myRoom); });
});

// ヘルスチェック
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🍳 Kitchen Chaos server running on http://0.0.0.0:${PORT}`);
});
