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

  // 如果当前法官不存在或者不在房间内
  if (!room.judgeId || !room.players[room.judgeId]) {
    const firstPlayerId = playerIds[0];
    room.judgeId = firstPlayerId;
    room.players[firstPlayerId].isJudge = true;
    room.players[firstPlayerId].role = null;
  }
}

// 广播房间信息：法官看所有人底牌，普通玩家只能看自己底牌
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
  // 加入房间
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
        rolesConfig: { werewolf: 3, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 0, idiot: 0 }
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

  // 法官请求移交权限 -> 发送给目标玩家确认
  socket.on('requestTransferJudge', (targetId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || socket.id !== room.judgeId || !room.players[targetId]) return;

    const fromJudgeName = room.players[socket.id].name;
    // 通知被移交的目标玩家进行确认
    io.to(targetId).emit('askJudgeAccept', { fromId: socket.id, fromName: fromJudgeName });
    socket.emit('errorMsg', '移交请求已发出，等待对方确认...');
  });

  // 目标玩家响应移交请求
  socket.on('responseTransferJudge', ({ accept, fromId }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || room.judgeId !== fromId) return;

    if (accept) {
      // 同意移交
      room.players[fromId].isJudge = false;
      room.players[socket.id].isJudge = true;
      room.players[socket.id].role = null;
      room.judgeId = socket.id;
      broadcastRoom(roomId);
    } else {
      // 拒绝移交，通知法官
      const targetName = room.players[socket.id]?.name || '该玩家';
      io.to(fromId).emit('errorMsg', `${targetName} 拒绝了法官移交请求。`);
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
      for (let i = 0; i < config[role]; i++) {
        rolePool.push(role);
      }
    }

    if (playerIds.length === 0) {
      socket.emit('errorMsg', '房间内暂无普通玩家');
      return;
    }

    if (rolePool.length !== playerIds.length) {
      socket.emit('errorMsg', `配置角色数(${rolePool.length})与玩家人数(${playerIds.length})不一致`);
      return;
    }

    // 洗牌
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

  // 结束本局，重置房间
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
      broadcastRoom(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`狼人杀服务端已启动: 端口 ${PORT}`);
});