const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// 检查并确保房间内至少有一个法官
function ensureJudge(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const playerIds = Object.keys(room.players);
  if (playerIds.length === 0) return;

  if (!room.judgeId || !room.players[room.judgeId]) {
    const firstPlayerId = playerIds[0];
    room.judgeId = firstPlayerId;
    room.players[firstPlayerId].isJudge = true;
    room.players[firstPlayerId].role = null;
  }
}

// 广播房间信息
function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  ensureJudge(roomId);

  Object.keys(room.players).forEach(socketId => {
    const isJudge = (socketId === room.judgeId);
    
    const sanitizedRoom = {
      judgeId: room.judgeId,
      sheriffId: room.sheriffId,
      gameStarted: room.gameStarted,
      rolesConfig: room.rolesConfig,
      players: {}
    };

    Object.keys(room.players).forEach(pId => {
      const p = room.players[pId];
      sanitizedRoom.players[pId] = {
        id: p.id,
        name: p.name,
        isJudge: p.isJudge,
        isDead: p.isDead,
        role: (isJudge || pId === socketId) ? p.role : null
      };
    });

    io.to(socketId).emit('roomUpdate', sanitizedRoom);
  });
}

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, playerName, isJudge }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        judgeId: null,
        players: {},
        sheriffId: null,
        gameStarted: false,
        pendingTransfer: null,
        rolesConfig: { '狼人': 3, '村民': 3, '预言家': 1, '女巫': 1, '猎人': 1, '守卫': 0 }
      };
    }

    const room = rooms[roomId];
    let actualIsJudge = false;

    if (isJudge && !room.judgeId) {
      room.judgeId = socket.id;
      actualIsJudge = true;
    } else if (isJudge && room.judgeId) {
      socket.emit('errorMsg', '房间内已有法官，你已作为普通玩家加入');
    }

    socket.isJudge = actualIsJudge;

    room.players[socket.id] = {
      id: socket.id,
      name: playerName,
      isJudge: actualIsJudge,
      isDead: false,
      role: null
    };

    broadcastRoom(roomId);
  });

  // 法官发起移交请求
  socket.on('requestTransferJudge', (targetId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || socket.id !== room.judgeId || !room.players[targetId]) return;

    room.pendingTransfer = { fromId: socket.id, toId: targetId };
    const fromJudgeName = room.players[socket.id].name;
    const targetName = room.players[targetId].name;

    // 向被移交玩家发送弹窗邀请
    io.to(targetId).emit('askJudgeAccept', { fromId: socket.id, fromName: fromJudgeName });
    // 向原法官发送等待弹窗
    socket.emit('transferWaitingStart', { targetName, targetId });
  });

  // 法官主动取消移交
  socket.on('cancelTransferJudge', () => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || !room.pendingTransfer || room.pendingTransfer.fromId !== socket.id) return;

    const targetId = room.pendingTransfer.toId;
    room.pendingTransfer = null;

    socket.emit('transferWaitingEnd');
    io.to(targetId).emit('transferCancelledByJudge');
  });

  // 被移交玩家响应请求
  socket.on('responseTransferJudge', ({ accept, fromId }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || !room.pendingTransfer || room.pendingTransfer.toId !== socket.id) return;

    const originalJudgeId = room.pendingTransfer.fromId;
    const targetName = room.players[socket.id]?.name || '该玩家';
    room.pendingTransfer = null;

    if (accept) {
      room.players[originalJudgeId].isJudge = false;
      room.players[socket.id].isJudge = true;
      room.players[socket.id].role = null;
      room.judgeId = socket.id;
      
      io.to(originalJudgeId).emit('transferWaitingEnd');
      socket.emit('transferAcceptedSuccess');
      broadcastRoom(roomId);
    } else {
      // 目标玩家点击拒绝
      io.to(originalJudgeId).emit('transferWaitingEnd');
      io.to(originalJudgeId).emit('transferRejectedNotify', { targetName });
      socket.emit('transferRejectedSelf');
    }
  });

  // 更新角色配置
  socket.on('updateConfig', (config) => {
    const roomId = socket.roomId;
    if (rooms[roomId] && socket.id === rooms[roomId].judgeId) {
      rooms[roomId].rolesConfig = config;
      io.to(roomId).emit('configUpdate', config);
    }
  });

  // 开始发牌
  socket.on('startGame', () => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || socket.id !== room.judgeId) return;

    if (room.gameStarted) {
      socket.emit('errorMsg', '当前对局已在进行中，请先点击【结束本局 (开始下一轮)】');
      return;
    }

    const playerIds = Object.keys(room.players).filter(id => !room.players[id].isJudge);
    const config = room.rolesConfig;
    
    const rolePool = [];
    for (let role in config) {
      const count = parseInt(config[role]) || 0;
      for (let i = 0; i < count; i++) {
        rolePool.push(role);
      }
    }

    if (playerIds.length === 0) {
      socket.emit('errorMsg', '房间内暂无普通玩家');
      return;
    }

    if (rolePool.length !== playerIds.length) {
      socket.emit('errorMsg', `配置角色总数(${rolePool.length})与普通玩家人数(${playerIds.length})不一致`);
      return;
    }

    for (let i = rolePool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rolePool[i], rolePool[j]] = [rolePool[j], rolePool[i]];
    }

    room.gameStarted = true;
    room.sheriffId = null;
    playerIds.forEach((id, index) => {
      room.players[id].role = rolePool[index];
      room.players[id].isDead = false;
    });

    broadcastRoom(roomId);
  });

  // 结束本局重置
  socket.on('resetGame', () => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || socket.id !== room.judgeId) return;

    room.gameStarted = false;
    room.sheriffId = null;
    Object.keys(room.players).forEach(id => {
      room.players[id].role = null;
      room.players[id].isDead = false;
    });

    broadcastRoom(roomId);
  });

  // 标记死亡/存活
  socket.on('toggleDeath', (targetId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (room && socket.id === room.judgeId && room.players[targetId]) {
      room.players[targetId].isDead = !room.players[targetId].isDead;
      broadcastRoom(roomId);
    }
  });

  // 警长任命 / 移交
  socket.on('setSheriff', (targetId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;

    if (socket.id === room.judgeId && !room.sheriffId) {
      room.sheriffId = targetId;
      broadcastRoom(roomId);
      return;
    }

    const currentSheriff = room.players[room.sheriffId];
    if (currentSheriff && currentSheriff.isDead) {
      if (socket.id === room.sheriffId || socket.id === room.judgeId) {
        room.sheriffId = targetId;
        broadcastRoom(roomId);
      }
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (rooms[roomId] && rooms[roomId].players[socket.id]) {
      delete rooms[roomId].players[socket.id];
      if (rooms[roomId].judgeId === socket.id) {
        rooms[roomId].judgeId = null;
      }
      if (rooms[roomId].sheriffId === socket.id) {
        rooms[roomId].sheriffId = null;
      }
      if (rooms[roomId].pendingTransfer) {
        if (rooms[roomId].pendingTransfer.fromId === socket.id || rooms[roomId].pendingTransfer.toId === socket.id) {
          rooms[roomId].pendingTransfer = null;
        }
      }
      broadcastRoom(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`狼人杀服务端已启动: 端口 ${PORT}`);
});