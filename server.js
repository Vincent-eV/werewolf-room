const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, name }) => {
    if (!roomId || !name) return;
    socket.roomId = roomId;
    socket.name = name;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        config: [
          { roleName: '狼人', count: 3 },
          { roleName: '村民', count: 3 },
          { roleName: '预言家', count: 1 },
          { roleName: '女巫', count: 1 },
          { roleName: '猎人', count: 1 }
        ],
        gameStarted: false
      };
    }

    rooms[roomId].players[socket.id] = {
      name,
      role: null,
      isJudge: false
    };

    updateRoom(roomId);
  });

  socket.on('claimJudge', () => {
    const room = rooms[socket.roomId];
    if (!room || room.gameStarted) return;

    Object.keys(room.players).forEach(id => {
      room.players[id].isJudge = (id === socket.id);
    });

    updateRoom(socket.roomId);
  });

  socket.on('updateConfig', (config) => {
    const room = rooms[socket.roomId];
    if (!room || room.gameStarted) return;
    room.config = config;
    io.to(socket.roomId).emit('configUpdated', config);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomId];
    if (!room) return;

    const allPlayerIds = Object.keys(room.players);
    const judgeId = allPlayerIds.find(id => room.players[id].isJudge);

    if (!judgeId) {
      return socket.emit('errorMsg', '必须先有一位玩家自选为法官！');
    }

    const nonJudgeIds = allPlayerIds.filter(id => !room.players[id].isJudge);

    let rolePool = [];
    room.config.forEach(item => {
      const cnt = parseInt(item.count, 10) || 0;
      for (let i = 0; i < cnt; i++) {
        rolePool.push(item.roleName);
      }
    });

    if (rolePool.length !== nonJudgeIds.length) {
      return socket.emit(
        'errorMsg',
        `身份牌总数 (${rolePool.length}) 与游戏玩家数 (${nonJudgeIds.length}，不含法官) 不一致！`
      );
    }

    for (let i = rolePool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rolePool[i], rolePool[j]] = [rolePool[j], rolePool[i]];
    }

    nonJudgeIds.forEach((id, index) => {
      room.players[id].role = rolePool[index];
    });
    room.players[judgeId].role = '法官 (上帝视角)';
    room.gameStarted = true;

    const fullRolesSummary = Object.entries(room.players).map(([id, p]) => ({
      name: p.name,
      role: p.role,
      isJudge: p.isJudge
    }));

    allPlayerIds.forEach(id => {
      const player = room.players[id];
      if (player.isJudge) {
        io.to(id).emit('dealCards', {
          isJudge: true,
          myRole: player.role,
          allRoles: fullRolesSummary
        });
      } else {
        io.to(id).emit('dealCards', {
          isJudge: false,
          myRole: player.role
        });
      }
    });

    updateRoom(socket.roomId);
  });

  socket.on('resetGame', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.gameStarted = false;
    Object.keys(room.players).forEach(id => {
      room.players[id].role = null;
    });
    io.to(socket.roomId).emit('gameReset');
    updateRoom(socket.roomId);
  });

  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      delete rooms[socket.roomId].players[socket.id];
      if (Object.keys(rooms[socket.roomId].players).length === 0) {
        delete rooms[socket.roomId];
      } else {
        updateRoom(socket.roomId);
      }
    }
  });
});

function updateRoom(roomId) {
  if (!rooms[roomId]) return;
  const room = rooms[roomId];
  const playerList = Object.entries(room.players).map(([id, p]) => ({
    name: p.name,
    isJudge: p.isJudge
  }));
  io.to(roomId).emit('roomData', {
    players: playerList,
    config: room.config,
    gameStarted: room.gameStarted
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`狼人杀服务端已启动: 端口 ${PORT}`);
});