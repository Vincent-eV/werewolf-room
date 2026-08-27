const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 房间状态存储
const rooms = {};

io.on('connection', (socket) => {
  // 加入房间
  socket.on('joinRoom', ({ roomId, playerName, isJudge }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName;
    socket.isJudge = isJudge;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        judgeId: isJudge ? socket.id : null,
        players: {},
        sheriffId: null,
        gameStarted: false,
        rolesConfig: { werewolf: 0, villager: 0, seer: 0, witch: 0, hunter: 0, guard: 0, idiot: 0 }
      };
    }

    if (isJudge) {
      rooms[roomId].judgeId = socket.id;
    }

    rooms[roomId].players[socket.id] = {
      id: socket.id,
      name: playerName,
      isJudge: isJudge,
      isDead: false,
      role: null
    };

    io.to(roomId).emit('roomUpdate', rooms[roomId]);
  });

  // 更新角色配置（仅法官）
  socket.on('updateConfig', (config) => {
    const roomId = socket.roomId;
    if (rooms[roomId] && socket.id === rooms[roomId].judgeId) {
      rooms[roomId].rolesConfig = config;
      io.to(roomId).emit('configUpdate', config);
    }
  });

  // 开始发牌（仅法官）
  socket.on('startGame', () => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || socket.id !== room.judgeId) return;

    // 收集所有普通玩家（排除法官）
    const playerIds = Object.keys(room.players).filter(id => !room.players[id].isJudge);
    const config = room.rolesConfig;
    
    const rolePool = [];
    for (let role in config) {
      for (let i = 0; i < config[role]; i++) {
        rolePool.push(role);
      }
    }

    if (playerIds.length === 0) {
      socket.emit('errorMsg', '房间内暂无玩家');
      return;
    }

    if (rolePool.length !== playerIds.length) {
      socket.emit('errorMsg', `配置角色数(${rolePool.length})与玩家人数(${playerIds.length})不一致`);
      return;
    }

    // 洗牌算法
    for (let i = rolePool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rolePool[i], rolePool[j]] = [rolePool[j], rolePool[i]];
    }

    // 重置状态与分配
    room.gameStarted = true;
    room.sheriffId = null;
    playerIds.forEach((id, index) => {
      room.players[id].role = rolePool[index];
      room.players[id].isDead = false;
      io.to(id).emit('roleAssigned', rolePool[index]);
    });

    io.to(roomId).emit('roomUpdate', room);
  });

  // 标记存活/死亡状态（仅法官）
  socket.on('toggleDeath', (targetId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (room && socket.id === room.judgeId && room.players[targetId]) {
      room.players[targetId].isDead = !room.players[targetId].isDead;
      io.to(roomId).emit('roomUpdate', room);
    }
  });

  // 警长任命 / 移交徽章
  socket.on('setSheriff', (targetId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;

    // 情况 1: 首次竞选由法官直接任命
    if (socket.id === room.judgeId && !room.sheriffId) {
      room.sheriffId = targetId;
      io.to(roomId).emit('roomUpdate', room);
      return;
    }

    // 情况 2: 原警长已阵亡，移交警徽（原警长操作或法官协助）
    const currentSheriff = room.players[room.sheriffId];
    if (currentSheriff && currentSheriff.isDead) {
      if (socket.id === room.sheriffId || socket.id === room.judgeId) {
        room.sheriffId = targetId; // 传 null 为撕警徽，传 targetId 为移交
        io.to(roomId).emit('roomUpdate', room);
      }
    }
  });

  // 断开连接处理
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
      io.to(roomId).emit('roomUpdate', rooms[roomId]);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`狼人杀服务端已启动: 端口 ${PORT}`);
});