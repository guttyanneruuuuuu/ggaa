// ============================================================
// Kitchen Chaos - サーバー (Express + Socket.IO)
//   - 静的配信(public)
//   - ルーム作成/参加(ルームコード)
//   - 友達モード / AIモード
//   - リアルタイム入力 → ゲーム状態配信
// ============================================================

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import { Room } from './game/Room.js';
import { LEVELS } from './game/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ---------- ルーム管理 ----------
const rooms = new Map();  // code -> Room

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code, io);
    rooms.set(code, room);
  }
  return room;
}

function cleanupRoom(room) {
  if (room.isEmpty()) {
    room.stop();
    rooms.delete(room.code);
  }
}

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = 'Chef';

  // ルーム作成
  socket.on('createRoom', ({ name }, cb) => {
    const code = genCode();
    const room = getOrCreateRoom(code);
    playerName = (name || 'Chef').slice(0, 12);
    room.addPlayer(socket.id, playerName, false);
    socket.join(code);
    currentRoom = room;
    cb && cb({ ok: true, code, you: socket.id });
    room.broadcastLobby();
  });

  // ルーム参加
  socket.on('joinRoom', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { cb && cb({ ok: false, error: 'ルームが見つかりません' }); return; }
    if (room.playerCount >= 4) { cb && cb({ ok: false, error: '満員です(最大4人)' }); return; }
    if (room.state === 'playing') { cb && cb({ ok: false, error: 'ゲーム進行中です' }); return; }
    playerName = (name || 'Chef').slice(0, 12);
    room.addPlayer(socket.id, playerName, false);
    socket.join(code);
    currentRoom = room;
    cb && cb({ ok: true, code, you: socket.id });
    room.broadcastLobby();
  });

  // レベル選択(ホスト)
  socket.on('selectLevel', ({ index }) => {
    if (!currentRoom || socket.id !== currentRoom.hostId) return;
    currentRoom.levelIndex = Math.max(0, Math.min(index, LEVELS.length - 1));
    currentRoom.broadcastLobby();
  });

  // 準備完了トグル
  socket.on('toggleReady', ({ ready }) => {
    if (!currentRoom) return;
    currentRoom.setReady(socket.id, ready);
    currentRoom.broadcastLobby();
  });

  // ゲーム開始(ホスト)
  socket.on('startGame', ({ mode, aiCount }) => {
    if (!currentRoom || socket.id !== currentRoom.hostId) return;
    const m = mode === 'ai' ? 'ai' : 'friends';
    let cnt = 0;
    if (m === 'ai') {
      // 人間1人 + AI(指定数, 最大3)
      cnt = Math.max(1, Math.min(aiCount || 1, 3));
    }
    currentRoom.start(m, cnt);
    io.to(currentRoom.code).emit('gameStart', { levelIndex: currentRoom.levelIndex });
  });

  // 次のレベルへ(ホスト)
  socket.on('nextLevel', () => {
    if (!currentRoom || socket.id !== currentRoom.hostId) return;
    if (currentRoom.levelIndex < LEVELS.length - 1) {
      currentRoom.levelIndex++;
    }
    const prevMode = currentRoom.mode;
    const aiCnt = currentRoom.ais.length;
    currentRoom.start(prevMode, aiCnt);
    io.to(currentRoom.code).emit('gameStart', { levelIndex: currentRoom.levelIndex });
  });

  // リトライ(ホスト)
  socket.on('retryLevel', () => {
    if (!currentRoom || socket.id !== currentRoom.hostId) return;
    const aiCnt = currentRoom.ais.length;
    currentRoom.start(currentRoom.mode, aiCnt);
    io.to(currentRoom.code).emit('gameStart', { levelIndex: currentRoom.levelIndex });
  });

  // ロビーへ戻る(ホスト)
  socket.on('backToLobby', () => {
    if (!currentRoom || socket.id !== currentRoom.hostId) return;
    currentRoom.stop();
    currentRoom.state = 'lobby';
    // AI除去
    for (const [id, p] of [...currentRoom.players]) if (p.isAI) currentRoom.players.delete(id);
    currentRoom.ais = [];
    currentRoom.broadcastLobby();
  });

  // 入力(移動スティック)
  socket.on('input', (data) => {
    if (currentRoom) currentRoom.setInput(socket.id, data);
  });
  // アクションボタン
  socket.on('action', () => {
    if (currentRoom) currentRoom.doAction(socket.id);
  });
  // ダッシュ
  socket.on('dash', () => {
    if (currentRoom) currentRoom.doDash(socket.id);
  });
  // チョップ長押し(まな板で進行)
  socket.on('chopHold', () => {
    if (!currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (!p) return;
    const st = currentRoom.facingStation(p);
    if (st && st.type === 'cutting') {
      currentRoom.chopAt(st, 1 / 30);
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      currentRoom.removePlayer(socket.id);
      currentRoom.broadcastLobby();
      cleanupRoom(currentRoom);
    }
  });

  socket.on('leaveRoom', () => {
    if (currentRoom) {
      socket.leave(currentRoom.code);
      currentRoom.removePlayer(socket.id);
      currentRoom.broadcastLobby();
      cleanupRoom(currentRoom);
      currentRoom = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🍳 Kitchen Chaos server running on port ${PORT}`);
});
