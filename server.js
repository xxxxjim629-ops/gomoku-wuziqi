const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// MIME types for static files
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

// HTTP static file server
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
});

// Room storage
const rooms = new Map();

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += Math.floor(Math.random() * 10);
  } while (rooms.has(code));
  return code;
}

function createEmptyBoard() {
  return Array.from({ length: 15 }, () => Array(15).fill(null));
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function checkWin(board, row, col, color) {
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of directions) {
    const cells = [[row, col]];
    for (let i = 1; i < 5; i++) {
      const r = row + dr * i, c = col + dc * i;
      if (r < 0 || r >= 15 || c < 0 || c >= 15 || board[r][c] !== color) break;
      cells.push([r, c]);
    }
    for (let i = 1; i < 5; i++) {
      const r = row - dr * i, c = col - dc * i;
      if (r < 0 || r >= 15 || c < 0 || c >= 15 || board[r][c] !== color) break;
      cells.push([r, c]);
    }
    if (cells.length >= 5) return cells;
  }
  return null;
}

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerIndex = null;
  ws.originalIndex = null; // fixed identity: 0=creator, 1=joiner

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create_room': {
        const code = generateCode();
        const room = {
          code,
          players: [ws, null],
          board: createEmptyBoard(),
          currentTurn: 'black',
          moveCount: 0,
          gameOver: false,
          restartVotes: new Set(),
          scores: [0, 0], // [player0 wins, player1 wins]
        };
        rooms.set(code, room);
        ws.roomCode = code;
        ws.playerIndex = 0;
        ws.originalIndex = 0;
        send(ws, { type: 'room_created', code });
        break;
      }

      case 'join_room': {
        const code = (msg.code || '').trim();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', message: '房间不存在' });
          return;
        }
        if (room.players[1]) {
          send(ws, { type: 'error', message: '房间已满' });
          return;
        }
        room.players[1] = ws;
        ws.roomCode = code;
        ws.playerIndex = 1;
        ws.originalIndex = 1;
        send(room.players[0], { type: 'game_start', color: 'black', scores: room.scores, you: room.players[0].originalIndex });
        send(room.players[1], { type: 'game_start', color: 'white', scores: room.scores, you: room.players[1].originalIndex });
        break;
      }

      case 'place_stone': {
        const room = rooms.get(ws.roomCode);
        if (!room || room.gameOver) return;
        const { row, col } = msg;
        if (row < 0 || row >= 15 || col < 0 || col >= 15) return;
        if (room.board[row][col]) return;

        const color = ws.playerIndex === 0 ? 'black' : 'white';
        if (room.currentTurn !== color) return;

        room.board[row][col] = color;
        room.moveCount++;
        room.currentTurn = color === 'black' ? 'white' : 'black';

        const moveMsg = { type: 'move_made', row, col, color, nextTurn: room.currentTurn };
        send(room.players[0], moveMsg);
        send(room.players[1], moveMsg);

        const winCells = checkWin(room.board, row, col, color);
        if (winCells) {
          room.gameOver = true;
          room.scores[ws.originalIndex]++;
          const overMsg = { type: 'game_over', winner: color, winCells, scores: room.scores };
          send(room.players[0], overMsg);
          send(room.players[1], overMsg);
        } else if (room.moveCount >= 225) {
          room.gameOver = true;
          const overMsg = { type: 'game_over', winner: 'draw', winCells: [], scores: room.scores };
          send(room.players[0], overMsg);
          send(room.players[1], overMsg);
        }
        break;
      }

      case 'restart': {
        const room = rooms.get(ws.roomCode);
        if (!room || !room.gameOver) return;
        room.restartVotes.add(ws.playerIndex);

        if (room.restartVotes.size < 2) {
          const opponentIdx = ws.playerIndex === 0 ? 1 : 0;
          send(room.players[opponentIdx], { type: 'restart_request' });
        } else {
          // Both agreed — swap colors and reset
          [room.players[0], room.players[1]] = [room.players[1], room.players[0]];
          room.players[0].playerIndex = 0;
          room.players[1].playerIndex = 1;
          room.board = createEmptyBoard();
          room.currentTurn = 'black';
          room.moveCount = 0;
          room.gameOver = false;
          room.restartVotes.clear();
          send(room.players[0], { type: 'restart_accepted', color: 'black', scores: room.scores, you: room.players[0].originalIndex });
          send(room.players[1], { type: 'restart_accepted', color: 'white', scores: room.scores, you: room.players[1].originalIndex });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const opponentIdx = ws.playerIndex === 0 ? 1 : 0;
    const opponent = room.players[opponentIdx];
    if (opponent) send(opponent, { type: 'opponent_left' });
    rooms.delete(ws.roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Gomoku server running at http://localhost:${PORT}`);
});
