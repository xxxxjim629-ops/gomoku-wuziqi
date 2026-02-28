const $ = (id) => document.getElementById(id);

const PUNISHMENTS = ['按摩5分钟', '人肉坐垫', '遵命！', '变小狗', '挠痒痒15秒'];
const WHEEL_COLORS = ['#e74c3c', '#e67e22', '#f39c12', '#27ae60', '#2980b9'];

const screenMenu = $('screen-menu');
const screenWaiting = $('screen-waiting');
const screenGame = $('screen-game');
const canvas = $('board-canvas');
const ctx = canvas.getContext('2d');
const confirmBtn = $('btn-confirm-float');

const state = {
  ws: null,
  myColor: null,
  board: null,
  currentTurn: null,
  gameOver: false,
  lastMove: null,
  winCells: new Set(),
  pendingMove: null,
  myOriginalIndex: 0, // fixed identity from server
};

let logicalSize = 350;
let timerInterval = null;
let timeLeft = 60;
let wsReady = false;
let pendingMessages = [];

// --- Screen Navigation ---

function showScreen(screen) {
  screenMenu.classList.remove('active');
  screenWaiting.classList.remove('active');
  screenGame.classList.remove('active');
  screen.classList.add('active');
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2100);
}

// --- Scoreboard ---

function updateScores(scores) {
  $('score-p1').textContent = scores[0];
  $('score-p2').textContent = scores[1];
  $('score-card-p1').className = 'score-card ' + (state.myOriginalIndex === 0 ? 'score-me' : 'score-other');
  $('score-card-p2').className = 'score-card ' + (state.myOriginalIndex === 1 ? 'score-me' : 'score-other');
}

// --- Timer ---

function startTimer() {
  stopTimer();
  timeLeft = 60;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTimerDisplay();
    if (timeLeft <= 0) {
      stopTimer();
      if (state.currentTurn === state.myColor && !state.gameOver) {
        cancelPendingMove();
        const emptySpots = [];
        for (let r = 0; r < 15; r++)
          for (let c = 0; c < 15; c++)
            if (!state.board[r][c]) emptySpots.push({ row: r, col: c });
        if (emptySpots.length > 0) {
          const pick = emptySpots[Math.floor(Math.random() * emptySpots.length)];
          sendMsg({ type: 'place_stone', row: pick.row, col: pick.col });
        }
      }
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay() {
  const el = $('timer');
  el.textContent = timeLeft + 's';
  if (timeLeft <= 10) {
    el.classList.add('urgent');
  } else {
    el.classList.remove('urgent');
  }
}

// --- Pending Move (floating confirm) ---

function setPendingMove(row, col) {
  state.pendingMove = { row, col };
  drawBoard();
  positionConfirmBtn();
}

function cancelPendingMove() {
  state.pendingMove = null;
  confirmBtn.classList.add('hidden');
  drawBoard();
}

function confirmMove() {
  if (!state.pendingMove) return;
  const { row, col } = state.pendingMove;
  state.pendingMove = null;
  confirmBtn.classList.add('hidden');
  sendMsg({ type: 'place_stone', row, col });
}

function positionConfirmBtn() {
  if (!state.pendingMove) return;
  const { row, col } = state.pendingMove;
  const rect = canvas.getBoundingClientRect();
  const cellSize = rect.width / 16;
  const offset = cellSize;

  const cx = rect.left + offset + col * cellSize;
  const cy = rect.top + offset + row * cellSize;

  const btnSize = 44;
  let top = cy - cellSize * 0.5 - btnSize - 4;
  if (top < rect.top) {
    top = cy + cellSize * 0.5 + 4;
  }
  let left = cx - btnSize / 2;

  confirmBtn.style.left = left + 'px';
  confirmBtn.style.top = top + 'px';
  confirmBtn.classList.remove('hidden');
}

// --- WebSocket ---

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsReady = false;
  state.ws = new WebSocket(`${protocol}//${location.host}`);
  state.ws.onopen = () => {
    wsReady = true;
    for (const msg of pendingMessages) {
      state.ws.send(JSON.stringify(msg));
    }
    pendingMessages = [];
  };
  state.ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  state.ws.onclose = () => {
    state.ws = null;
    wsReady = false;
  };
}

function sendMsg(msg) {
  if (state.ws && wsReady) {
    state.ws.send(JSON.stringify(msg));
  } else {
    pendingMessages.push(msg);
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'room_created':
      $('room-code').textContent = msg.code;
      showScreen(screenWaiting);
      break;

    case 'game_start':
      state.myColor = msg.color;
      state.myOriginalIndex = msg.you;
      state.board = Array.from({ length: 15 }, () => Array(15).fill(null));
      state.currentTurn = 'black';
      state.gameOver = false;
      state.lastMove = null;
      state.pendingMove = null;
      state.winCells.clear();
      $('btn-rematch').classList.add('hidden');
      confirmBtn.classList.add('hidden');
      $('status-bar').className = '';
      removeWheelOverlay();
      updateScores(msg.scores);
      showScreen(screenGame);
      resizeCanvas();
      updateStatus();
      startTimer();
      break;

    case 'move_made':
      state.board[msg.row][msg.col] = msg.color;
      state.currentTurn = msg.nextTurn;
      state.lastMove = { row: msg.row, col: msg.col };
      state.pendingMove = null;
      confirmBtn.classList.add('hidden');
      drawBoard();
      updateStatus();
      startTimer();
      break;

    case 'game_over':
      state.gameOver = true;
      state.pendingMove = null;
      confirmBtn.classList.add('hidden');
      state.winCells = new Set(msg.winCells.map(([r, c]) => `${r},${c}`));
      stopTimer();
      $('timer').textContent = '';
      drawBoard();
      updateScores(msg.scores);
      updateGameOver(msg.winner);
      $('btn-rematch').classList.remove('hidden');
      break;

    case 'opponent_left':
      stopTimer();
      showToast('对手已离开');
      setTimeout(() => {
        showScreen(screenMenu);
        reconnect();
      }, 1500);
      break;

    case 'restart_request':
      showToast('对手请求再来一局');
      $('btn-rematch').classList.remove('hidden');
      break;

    case 'restart_accepted':
      state.myColor = msg.color;
      state.myOriginalIndex = msg.you;
      state.board = Array.from({ length: 15 }, () => Array(15).fill(null));
      state.currentTurn = 'black';
      state.gameOver = false;
      state.lastMove = null;
      state.pendingMove = null;
      state.winCells.clear();
      $('btn-rematch').classList.add('hidden');
      confirmBtn.classList.add('hidden');
      $('status-bar').className = '';
      removeTaunt();
      removeWheelOverlay();
      updateScores(msg.scores);
      drawBoard();
      updateStatus();
      startTimer();
      break;

    case 'match_over':
      $('btn-rematch').classList.add('hidden');
      setTimeout(() => {
        removeTaunt();
        showWheelOverlay(msg.matchWinner !== state.myOriginalIndex, msg.punishmentIndex);
      }, 2000);
      break;

    case 'new_match_request':
      showToast('对手请求再来一场');
      break;

    case 'error':
      showToast(msg.message);
      break;
  }
}

function reconnect() {
  stopTimer();
  removeTaunt();
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }
  state.ws = null;
  wsReady = false;
  pendingMessages = [];
  connect();
}

// --- Status ---

function updateStatus() {
  const colorName = state.currentTurn === 'black' ? '黑' : '白';
  const myTurn = state.currentTurn === state.myColor;
  const myColorName = state.myColor === 'black' ? '黑' : '白';
  $('status-text').textContent = myTurn
    ? `你的回合 (${myColorName}棋)`
    : `对手回合 (${colorName}棋)`;
  $('status-bar').className = '';
}

function updateGameOver(winner) {
  const bar = $('status-bar');
  if (winner === 'draw') {
    $('status-text').textContent = '平局！';
    bar.className = 'draw';
  } else if (winner === state.myColor) {
    $('status-text').textContent = '你赢了！';
    bar.className = 'win';
    showTaunt('你是天才！', 'win');
  } else {
    $('status-text').textContent = '你输了';
    bar.className = 'lose';
    showTaunt('菜！叫爸爸', 'lose');
  }
}

// --- Taunt ---

function showTaunt(text, type) {
  removeTaunt();
  const overlay = document.createElement('div');
  overlay.className = 'taunt-overlay';
  overlay.id = 'taunt-overlay';
  const textEl = document.createElement('div');
  textEl.className = 'taunt-text' + (type === 'win' ? ' taunt-win' : '');
  textEl.textContent = text;
  overlay.appendChild(textEl);
  overlay.addEventListener('click', removeTaunt);
  document.body.appendChild(overlay);
}

function removeTaunt() {
  const el = $('taunt-overlay');
  if (el) el.remove();
}

// --- Canvas Rendering ---

function resizeCanvas() {
  logicalSize = Math.min(window.innerWidth * 0.9, window.innerHeight * 0.6, 450);
  canvas.style.width = logicalSize + 'px';
  canvas.style.height = logicalSize + 'px';
  const dpr = window.devicePixelRatio || 1;
  canvas.width = logicalSize * dpr;
  canvas.height = logicalSize * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBoard();
  if (state.pendingMove) positionConfirmBtn();
}

function drawBoard() {
  if (!state.board) return;

  const size = logicalSize;
  const cellSize = size / 16;
  const offset = cellSize;

  // Background
  ctx.fillStyle = '#DEB887';
  ctx.fillRect(0, 0, size, size);

  // Watermark text
  ctx.save();
  ctx.font = `bold ${size * 0.07}px sans-serif`;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-Math.PI / 12);
  ctx.fillText('王咿人别急眼', 0, 0);
  ctx.restore();

  // Grid lines — bold
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1.8;
  for (let i = 0; i < 15; i++) {
    const pos = offset + i * cellSize;
    ctx.beginPath();
    ctx.moveTo(offset, pos);
    ctx.lineTo(offset + 14 * cellSize, pos);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pos, offset);
    ctx.lineTo(pos, offset + 14 * cellSize);
    ctx.stroke();
  }

  // Star points
  const stars = [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]];
  for (const [r, c] of stars) {
    ctx.beginPath();
    ctx.arc(offset + c * cellSize, offset + r * cellSize, cellSize * 0.15, 0, Math.PI * 2);
    ctx.fillStyle = '#222';
    ctx.fill();
  }

  // Stones
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (!state.board[r][c]) continue;
      drawStone(offset + c * cellSize, offset + r * cellSize, cellSize * 0.43, state.board[r][c]);
    }
  }

  // Pending move preview (semi-transparent)
  if (state.pendingMove) {
    const { row, col } = state.pendingMove;
    const px = offset + col * cellSize;
    const py = offset + row * cellSize;
    ctx.globalAlpha = 0.5;
    drawStone(px, py, cellSize * 0.43, state.myColor);
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = '#e74c3c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, cellSize * 0.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Last move indicator
  if (state.lastMove) {
    const { row, col } = state.lastMove;
    const cx = offset + col * cellSize;
    const cy = offset + row * cellSize;
    ctx.beginPath();
    ctx.arc(cx, cy, cellSize * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = '#e74c3c';
    ctx.fill();
  }

  // Win highlight
  if (state.winCells.size > 0) {
    ctx.strokeStyle = '#e74c3c';
    ctx.lineWidth = 2.5;
    for (const key of state.winCells) {
      const [r, c] = key.split(',').map(Number);
      ctx.beginPath();
      ctx.arc(offset + c * cellSize, offset + r * cellSize, cellSize * 0.47, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawStone(x, y, radius, color) {
  const gradient = ctx.createRadialGradient(
    x - radius * 0.3, y - radius * 0.3, radius * 0.1,
    x, y, radius
  );
  if (color === 'black') {
    gradient.addColorStop(0, '#555');
    gradient.addColorStop(1, '#111');
  } else {
    gradient.addColorStop(0, '#fff');
    gradient.addColorStop(1, '#bbb');
  }
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = color === 'black' ? '#000' : '#999';
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

// --- Click/Touch Handling ---

canvas.addEventListener('click', (e) => {
  if (state.gameOver || state.currentTurn !== state.myColor) return;

  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (logicalSize / rect.width);
  const y = (e.clientY - rect.top) * (logicalSize / rect.height);

  const cellSize = logicalSize / 16;
  const offset = cellSize;

  const col = Math.round((x - offset) / cellSize);
  const row = Math.round((y - offset) / cellSize);

  if (row < 0 || row > 14 || col < 0 || col > 14) return;
  if (state.board[row][col]) return;

  setPendingMove(row, col);
});

window.addEventListener('resize', () => {
  if (screenGame.classList.contains('active')) {
    resizeCanvas();
  }
});

// --- UI Event Wiring ---

$('btn-create').addEventListener('click', () => {
  sendMsg({ type: 'create_room' });
});

$('btn-join').addEventListener('click', () => {
  const code = $('input-code').value.trim();
  if (code.length !== 4) {
    showToast('请输入4位房间码');
    return;
  }
  sendMsg({ type: 'join_room', code });
});

$('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});

$('btn-copy').addEventListener('click', () => {
  const code = $('room-code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    showToast('已复制');
  });
});

$('btn-back').addEventListener('click', () => {
  showScreen(screenMenu);
  reconnect();
});

confirmBtn.addEventListener('click', () => {
  confirmMove();
});

$('btn-rematch').addEventListener('click', () => {
  sendMsg({ type: 'restart' });
  $('btn-rematch').classList.add('hidden');
  showToast('已发送再来一局请求');
});

$('btn-leave').addEventListener('click', () => {
  stopTimer();
  removeTaunt();
  showScreen(screenMenu);
  reconnect();
});

// --- Punishment Wheel ---

function removeWheelOverlay() {
  const el = $('wheel-overlay');
  if (el) el.remove();
}

function showWheelOverlay(loserIsMe, punishmentIndex) {
  removeWheelOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'wheel-overlay';
  overlay.className = 'wheel-overlay';

  const title = document.createElement('div');
  title.className = 'wheel-title';
  title.textContent = loserIsMe ? '你输了！转动惩罚转盘！' : '对手接受惩罚！';

  const container = document.createElement('div');
  container.className = 'wheel-container';

  const pointer = document.createElement('div');
  pointer.className = 'wheel-pointer';
  pointer.textContent = '▼';

  const wCanvas = document.createElement('canvas');
  wCanvas.id = 'wheel-canvas';
  const wSize = Math.min(window.innerWidth * 0.75, 280);
  wCanvas.width = wSize;
  wCanvas.height = wSize;

  container.appendChild(pointer);
  container.appendChild(wCanvas);

  const btnNew = document.createElement('button');
  btnNew.id = 'btn-new-match';
  btnNew.className = 'hidden';
  btnNew.textContent = '再来一场';
  btnNew.addEventListener('click', () => {
    sendMsg({ type: 'new_match' });
    btnNew.disabled = true;
    showToast('已发送再来一场请求');
  });

  overlay.appendChild(title);
  overlay.appendChild(container);
  overlay.appendChild(btnNew);
  document.body.appendChild(overlay);

  drawWheel(0);
  setTimeout(() => spinWheel(punishmentIndex), 800);
}

function drawWheel(angle) {
  const wCanvas = document.getElementById('wheel-canvas');
  if (!wCanvas) return;
  const wCtx = wCanvas.getContext('2d');
  const N = PUNISHMENTS.length;
  const segAngle = (Math.PI * 2) / N;
  const cx = wCanvas.width / 2;
  const cy = wCanvas.height / 2;
  const r = Math.min(cx, cy) - 6;

  wCtx.clearRect(0, 0, wCanvas.width, wCanvas.height);

  for (let i = 0; i < N; i++) {
    const startAngle = angle + i * segAngle;
    const endAngle = startAngle + segAngle;

    wCtx.beginPath();
    wCtx.moveTo(cx, cy);
    wCtx.arc(cx, cy, r, startAngle, endAngle);
    wCtx.closePath();
    wCtx.fillStyle = WHEEL_COLORS[i];
    wCtx.fill();
    wCtx.strokeStyle = '#fff';
    wCtx.lineWidth = 2;
    wCtx.stroke();

    wCtx.save();
    wCtx.translate(cx, cy);
    wCtx.rotate(startAngle + segAngle / 2);
    wCtx.textAlign = 'right';
    wCtx.fillStyle = '#fff';
    wCtx.font = `bold ${Math.max(11, r * 0.13)}px sans-serif`;
    wCtx.shadowColor = 'rgba(0,0,0,0.5)';
    wCtx.shadowBlur = 3;
    wCtx.fillText(PUNISHMENTS[i], r - 10, 5);
    wCtx.restore();
  }

  // Center circle
  wCtx.beginPath();
  wCtx.arc(cx, cy, 16, 0, Math.PI * 2);
  wCtx.fillStyle = '#fff';
  wCtx.fill();
  wCtx.strokeStyle = '#ccc';
  wCtx.lineWidth = 2;
  wCtx.stroke();
}

function spinWheel(target) {
  const N = PUNISHMENTS.length;
  const segAngle = (Math.PI * 2) / N;

  // Pointer is at top (3π/2). We want center of segment `target` to be at 3π/2.
  // Center of segment i = finalAngle + i*segAngle + segAngle/2
  // So: finalAngle = 3π/2 - (target + 0.5)*segAngle  (mod 2π)
  const baseAngle = 3 * Math.PI / 2 - (target + 0.5) * segAngle;
  const normalized = ((baseAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  // Extra rotations MUST be a whole integer to not disturb the final angle
  const extraSpins = 6 + Math.floor(Math.random() * 4);
  const totalSpin = normalized + Math.PI * 2 * extraSpins;

  const duration = 5000;
  const startTime = performance.now();

  function animate(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4);
    drawWheel(eased * totalSpin);
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      setTimeout(() => showWheelResult(target), 400);
    }
  }

  requestAnimationFrame(animate);
}

function showWheelResult(target) {
  const overlay = $('wheel-overlay');
  if (!overlay) return;

  const result = document.createElement('div');
  result.className = 'wheel-result';
  result.innerHTML = `<span>惩罚结果</span>${PUNISHMENTS[target]}`;

  const btnNew = $('btn-new-match');
  overlay.insertBefore(result, btnNew);
  if (btnNew) btnNew.classList.remove('hidden');
}

// --- Init ---
connect();
