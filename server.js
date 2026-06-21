/* FIREUNG authoritative multiplayer server v1
   Run: npm install && npm start
*/
'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const TILE_FLOOR = 0;
const TILE_SOLID = 1;
const TILE_SOFT = 2;
const COLS = 20;
const ROWS = 15;
const ROUND_LIMIT = 300;
const SHRINK_STEP = 12;
const MAX_SHRINK = 5;
const TICK_RATE = 30;
const SNAPSHOT_RATE = 30;
const MAX_PLAYERS = 4;
const SPAWNS = [
  { x: 1, y: 1 },
  { x: COLS - 2, y: ROWS - 2 },
  { x: 1, y: ROWS - 2 },
  { x: COLS - 2, y: 1 }
];

const POWER_DEFS = {
  bomb:     { icon: '💣' },
  flame:    { icon: '🔥' },
  speed:    { icon: '⚡' },
  life:     { icon: '💗' },
  shield:   { icon: '🛡' },
  remote:   { icon: '📡' },
  kick:     { icon: '👟' },
  bombpass: { icon: '👻' },
  wallpass: { icon: '🧱' }
};

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, name: 'FIREUNG authoritative server', lobbies: lobbies.size }));
});

const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: info => {
    if (!ALLOWED_ORIGINS.length) return true;
    const origin = info.origin || '';
    return ALLOWED_ORIGINS.includes(origin);
  }
});

const lobbies = new Map();
const clients = new Map();

function uid(prefix = '') {
  return prefix + crypto.randomBytes(5).toString('hex');
}

function lobbyCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function send(ws, data) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }
}

function broadcast(lobby, data) {
  for (const c of lobby.clients.values()) send(c.ws, data);
}

function publicLobby() {
  for (const lobby of lobbies.values()) {
    if (lobby.type === 'public' && lobby.status === 'waiting' && lobby.clients.size < MAX_PLAYERS) return lobby;
  }
  return null;
}

function createLobby(type, hostClient) {
  let code;
  do { code = type === 'public' ? 'P' + lobbyCode().slice(1) : lobbyCode(); } while (lobbies.has(code));

  const lobby = {
    code,
    type,
    status: 'waiting',
    hostId: hostClient.id,
    clients: new Map(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    game: null,
    tickTimer: null,
    snapshotTimer: null
  };
  lobbies.set(code, lobby);
  addClientToLobby(lobby, hostClient);
  return lobby;
}

function lowestFreeSlot(lobby) {
  const used = new Set([...lobby.clients.values()].map(c => c.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return -1;
}

function addClientToLobby(lobby, client) {
  const slot = lowestFreeSlot(lobby);
  if (slot < 0) return false;
  client.lobbyCode = lobby.code;
  client.slot = slot;
  client.input = emptyInput();
  client.lastSeen = Date.now();
  lobby.clients.set(client.id, client);
  lobby.updatedAt = Date.now();
  sendLobbyInfo(lobby);
  return true;
}

function sendLobbyInfo(lobby) {
  const players = [...lobby.clients.values()].map(c => ({
    id: c.id,
    slot: c.slot,
    name: c.name,
    skin: c.skin,
    host: c.id === lobby.hostId
  })).sort((a, b) => a.slot - b.slot);

  for (const c of lobby.clients.values()) {
    send(c.ws, {
      type: 'lobby',
      code: lobby.code,
      lobbyType: lobby.type,
      playerId: c.slot,
      isHost: c.id === lobby.hostId,
      players
    });
  }
}

function emptyInput() {
  return { up: false, down: false, left: false, right: false, bomb: false, detonate: false };
}

function cleanText(text, max = 24) {
  return String(text || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'Hrac';
}

function sanitizeSkin(skin) {
  const allowed = new Set(['red', 'blue', 'green', 'yellow', 'purpleStripe', 'cyanCheck', 'orangeFire', 'monoStar']);
  return allowed.has(skin) ? skin : 'red';
}

function makeEmptyMap() {
  const map = [];
  for (let y = 0; y < ROWS; y++) {
    const row = [];
    for (let x = 0; x < COLS; x++) row.push(x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1 ? TILE_SOLID : TILE_FLOOR);
    map.push(row);
  }
  return map;
}

function nearSpawn(x, y) {
  return SPAWNS.some(s => Math.abs(s.x - x) + Math.abs(s.y - y) <= 2);
}

function clearSpawn(map, sx, sy) {
  const cells = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1]];
  for (const [dx, dy] of cells) {
    const x = sx + dx, y = sy + dy;
    if (x > 0 && y > 0 && x < COLS - 1 && y < ROWS - 1) map[y][x] = TILE_FLOOR;
  }
}

function makeMap(seed = Math.random()) {
  const map = makeEmptyMap();
  // solid ornamenty / mřížka, symetricky přes střed
  for (let y = 2; y < ROWS - 2; y += 2) {
    for (let x = 2; x < COLS - 2; x += 2) {
      if (!nearSpawn(x, y)) map[y][x] = TILE_SOLID;
    }
  }
  const ornaments = [
    [5, 3], [14, 3], [5, 11], [14, 11],
    [9, 4], [10, 4], [9, 10], [10, 10],
    [7, 7], [12, 7]
  ];
  for (const [x, y] of ornaments) if (!nearSpawn(x, y)) map[y][x] = TILE_SOLID;

  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (map[y][x] !== TILE_FLOOR || nearSpawn(x, y)) continue;
      const n = (x * 37 + y * 53 + Math.floor(seed * 10000)) % 100;
      if (n < 56) map[y][x] = TILE_SOFT;
    }
  }

  for (const s of SPAWNS) clearSpawn(map, s.x, s.y);

  // zaručené cesty ke středu schované pod bednami
  const center = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
  for (const s of SPAWNS) {
    let x = s.x, y = s.y;
    while (x !== center.x) {
      x += Math.sign(center.x - x);
      if (map[y][x] !== TILE_SOLID && !nearSpawn(x, y)) map[y][x] = TILE_SOFT;
    }
    while (y !== center.y) {
      y += Math.sign(center.y - y);
      if (map[y][x] !== TILE_SOLID && !nearSpawn(x, y)) map[y][x] = TILE_SOFT;
    }
  }
  for (const s of SPAWNS) clearSpawn(map, s.x, s.y);
  return map;
}

function makePlayer(slot, client, bot = false) {
  const s = SPAWNS[slot];
  return {
    id: slot,
    clientId: client?.id || null,
    name: bot ? `Bot ${slot + 1}` : cleanText(client?.name || `P${slot + 1}`),
    colorName: bot ? ['red','blue','green','yellow'][slot] : sanitizeSkin(client?.skin),
    gridX: s.x + 0.5,
    gridY: s.y + 0.5,
    alive: true,
    bot,
    lives: 3,
    maxBombs: 1,
    bombRange: 1,
    speedLevel: 0,
    placedBombs: 0,
    canKick: false,
    shieldUntil: 0,
    wallpassUntil: 0,
    remoteUntil: 0,
    bombpassUntil: 0,
    invulnUntil: Date.now() + 2200,
    nextBombAt: 0,
    nextDetonateAt: 0,
    lastDir: { x: 0, y: 1 },
    walking: false,
    walkAnim: 0,
    hitAt: 0,
    score: 0,
    kills: 0,
    deaths: 0,
    input: emptyInput(),
    botThinkAt: 0,
    botDir: { x: 0, y: 0 },
    botPlantAt: 0
  };
}

function startGame(lobby) {
  if (lobby.status === 'playing') return;
  const players = [];
  const bySlot = new Map([...lobby.clients.values()].map(c => [c.slot, c]));
  for (let i = 0; i < MAX_PLAYERS; i++) players.push(makePlayer(i, bySlot.get(i), !bySlot.has(i)));

  lobby.status = 'playing';
  lobby.game = {
    map: makeMap(Math.random()),
    players,
    bombs: [],
    explosions: [],
    powerups: [],
    startedAt: Date.now(),
    shrinkLevel: 0,
    lastShrinkLevel: 0,
    winnerText: '',
    gameState: 'playing',
    events: [],
    resultSent: false,
    activeKey: 'server'
  };
  broadcast(lobby, { type: 'event', name: 'start' });
  startTimers(lobby);
}

function startTimers(lobby) {
  stopTimers(lobby);
  let last = Date.now();
  lobby.tickTimer = setInterval(() => {
    const t = Date.now();
    const dt = Math.min(0.08, (t - last) / 1000);
    last = t;
    tickLobby(lobby, dt, t);
  }, 1000 / TICK_RATE);
  lobby.snapshotTimer = setInterval(() => {
    if (lobby.game) broadcast(lobby, { type: 'snapshot', state: snapshot(lobby.game) });
  }, 1000 / SNAPSHOT_RATE);
}

function stopTimers(lobby) {
  if (lobby.tickTimer) clearInterval(lobby.tickTimer);
  if (lobby.snapshotTimer) clearInterval(lobby.snapshotTimer);
  lobby.tickTimer = null;
  lobby.snapshotTimer = null;
}

function inBounds(x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS; }
function tileAt(game, x, y) { return inBounds(x, y) ? game.map[y][x] : TILE_SOLID; }
function bombAt(game, x, y) { return game.bombs.find(b => !b.dead && b.x === x && b.y === y); }
function isShrunkCell(game, x, y, level = game.shrinkLevel) {
  return level > 0 && (x < level || y < level || x >= COLS - level || y >= ROWS - level);
}
function passable(game, p, x, y) {
  if (!inBounds(x, y) || isShrunkCell(game, x, y)) return false;
  const tile = tileAt(game, x, y);
  const n = Date.now();
  if (tile === TILE_SOLID) return false;
  if (tile === TILE_SOFT && p.wallpassUntil < n) return false;
  const b = bombAt(game, x, y);
  if (b && p.bombpassUntil < n && b.ownerId !== p.id) return false;
  return true;
}

function centerTile(p) {
  return { x: Math.floor(p.gridX), y: Math.floor(p.gridY) };
}

function movePlayer(game, p, input, dt, time) {
  if (!p.alive) return;
  let dx = 0, dy = 0;
  if (input.left) dx -= 1;
  if (input.right) dx += 1;
  if (input.up) dy -= 1;
  if (input.down) dy += 1;
  if (Math.abs(dx) + Math.abs(dy) > 1) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  if (input.bomb) plantBomb(game, p, time);
  if (input.detonate) detonateRemote(game, p, time);

  p.walking = false;
  if (!dx && !dy) {
    p.walkAnim += dt * 1.3;
    return;
  }

  const speed = (2.85 + p.speedLevel * 0.38) * dt;
  const oldX = p.gridX, oldY = p.gridY;
  const nx = p.gridX + dx * speed;
  const ny = p.gridY + dy * speed;
  const tx = Math.floor(nx), ty = Math.floor(ny);
  if (passable(game, p, tx, ty)) {
    p.gridX = Math.max(0.5, Math.min(COLS - 0.5, nx));
    p.gridY = Math.max(0.5, Math.min(ROWS - 0.5, ny));
  } else {
    // jednoduché zarovnání do chodby
    if (dx !== 0) p.gridY += Math.max(-speed * 0.7, Math.min(speed * 0.7, Math.floor(p.gridY) + 0.5 - p.gridY));
    if (dy !== 0) p.gridX += Math.max(-speed * 0.7, Math.min(speed * 0.7, Math.floor(p.gridX) + 0.5 - p.gridX));
  }
  p.walking = Math.hypot(p.gridX - oldX, p.gridY - oldY) > 0.005;
  if (p.walking) {
    p.lastDir = { x: Math.sign(dx), y: Math.sign(dy) };
    p.walkAnim += dt * (9.5 + p.speedLevel * 0.65);
  }
}

function plantBomb(game, p, time) {
  if (!p.alive || time < p.nextBombAt || p.placedBombs >= p.maxBombs) return;
  p.nextBombAt = time + 220;
  const g = centerTile(p);
  if (tileAt(game, g.x, g.y) !== TILE_FLOOR || bombAt(game, g.x, g.y)) return;
  const remote = p.remoteUntil > time;
  game.bombs.push({
    x: g.x,
    y: g.y,
    ownerId: p.id,
    range: p.bombRange,
    explodeAt: time + (remote ? 5000 : 2600),
    remote,
    born: time,
    dead: false
  });
  p.placedBombs++;
  game.events.push({ name: 'bomb' });
}

function detonateRemote(game, p, time) {
  if (p.remoteUntil < time || time < p.nextDetonateAt) return;
  p.nextDetonateAt = time + 250;
  const owned = game.bombs.filter(b => !b.dead && b.remote && b.ownerId === p.id).sort((a, b) => a.born - b.born);
  if (owned[0]) explodeBomb(game, owned[0], time);
}

function explosionCells(game, bomb) {
  const cells = [{ x: bomb.x, y: bomb.y, dx: 0, dy: 0 }];
  for (const d of [[1,0],[-1,0],[0,1],[0,-1]]) {
    for (let i = 1; i <= bomb.range; i++) {
      const x = bomb.x + d[0] * i, y = bomb.y + d[1] * i;
      const tile = tileAt(game, x, y);
      if (tile === TILE_SOLID) break;
      cells.push({ x, y, dx: d[0], dy: d[1] });
      if (tile === TILE_SOFT) break;
    }
  }
  return cells;
}

function explodeBomb(game, bomb, time) {
  if (!bomb || bomb.dead) return;
  bomb.dead = true;
  const owner = game.players[bomb.ownerId];
  if (owner) owner.placedBombs = Math.max(0, owner.placedBombs - 1);
  game.events.push({ name: 'explode' });

  const cells = explosionCells(game, bomb);
  for (const c of cells) {
    game.explosions.push({ x: c.x, y: c.y, dx: c.dx, dy: c.dy, ownerId: bomb.ownerId, born: time, until: time + 550 });
    if (tileAt(game, c.x, c.y) === TILE_SOFT) {
      game.map[c.y][c.x] = TILE_FLOOR;
      maybeDropPower(game, c.x, c.y, time);
    }
    const otherBomb = bombAt(game, c.x, c.y);
    if (otherBomb && otherBomb !== bomb) otherBomb.explodeAt = Math.min(otherBomb.explodeAt, time + 80);
  }
}

function maybeDropPower(game, x, y, time) {
  if (Math.random() > 0.23) return;
  const weighted = [
    ['bomb', 20], ['flame', 18], ['speed', 13], ['life', 5], ['shield', 7], ['remote', 5], ['bombpass', 3], ['wallpass', 1], ['kick', 1]
  ];
  const sum = weighted.reduce((a, b) => a + b[1], 0);
  let r = Math.random() * sum;
  let type = 'bomb';
  for (const [k, w] of weighted) { r -= w; if (r <= 0) { type = k; break; } }
  game.powerups.push({ type, icon: POWER_DEFS[type].icon, x, y, born: time });
}

function collectPower(game, p, time) {
  const g = centerTile(p);
  const idx = game.powerups.findIndex(po => po.x === g.x && po.y === g.y);
  if (idx < 0) return;
  const po = game.powerups.splice(idx, 1)[0];
  if (po.type === 'bomb') p.maxBombs = Math.min(8, p.maxBombs + 1);
  if (po.type === 'flame') p.bombRange = Math.min(7, p.bombRange + 1);
  if (po.type === 'speed') p.speedLevel = Math.min(5, p.speedLevel + 1);
  if (po.type === 'life') p.lives = Math.min(6, p.lives + 1);
  if (po.type === 'shield') p.shieldUntil = Math.max(p.shieldUntil, time + 9000);
  if (po.type === 'remote') p.remoteUntil = Math.max(p.remoteUntil, time + 18000);
  if (po.type === 'bombpass') p.bombpassUntil = Math.max(p.bombpassUntil, time + 15000);
  if (po.type === 'wallpass') p.wallpassUntil = Math.max(p.wallpassUntil, time + 9000);
  if (po.type === 'kick') p.canKick = true;
  p.score += 25;
  game.events.push({ name: 'power' });
}

function hurtPlayer(game, p, ownerId, time) {
  if (!p.alive || time < p.invulnUntil) return;
  if (p.shieldUntil > time) { p.shieldUntil = 0; p.invulnUntil = time + 900; game.events.push({ name: 'hurt' }); return; }
  p.lives--;
  p.hitAt = time;
  game.events.push({ name: p.lives <= 0 ? 'dead' : 'hurt' });
  if (ownerId >= 0 && ownerId !== p.id && game.players[ownerId]) {
    game.players[ownerId].score += 100;
    game.players[ownerId].kills++;
  }
  if (p.lives <= 0) {
    p.alive = false;
    p.deaths++;
    return;
  }
  const s = SPAWNS[p.id] || SPAWNS[0];
  p.gridX = s.x + 0.5;
  p.gridY = s.y + 0.5;
  p.invulnUntil = time + 2200;
}

function updateBot(game, p, dt, time) {
  if (time > p.botThinkAt) {
    p.botThinkAt = time + 250 + Math.random() * 350;
    const g = centerTile(p);
    let target = null;
    let best = Infinity;
    for (const po of game.powerups) {
      const d = Math.abs(po.x - g.x) + Math.abs(po.y - g.y);
      if (d < best) { best = d; target = po; }
    }
    for (const h of game.players.filter(x => x.alive && !x.bot)) {
      const hg = centerTile(h);
      const d = Math.abs(hg.x - g.x) + Math.abs(hg.y - g.y);
      if (d < best + 3) { best = d; target = hg; }
    }
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    dirs.sort((a, b) => {
      if (!target) return Math.random() - 0.5;
      const da = Math.abs(g.x + a[0] - target.x) + Math.abs(g.y + a[1] - target.y);
      const db = Math.abs(g.x + b[0] - target.x) + Math.abs(g.y + b[1] - target.y);
      return da - db + (Math.random() - 0.5) * 0.5;
    });
    const chosen = dirs.find(d => passable(game, p, g.x + d[0], g.y + d[1])) || [0, 0];
    p.botDir = { x: chosen[0], y: chosen[1] };

    const nearSoft = dirs.some(d => tileAt(game, g.x + d[0], g.y + d[1]) === TILE_SOFT);
    const nearHuman = game.players.some(h => h.alive && !h.bot && Math.abs(centerTile(h).x - g.x) + Math.abs(centerTile(h).y - g.y) <= p.bombRange);
    if ((nearSoft || nearHuman) && time > p.botPlantAt && Math.random() < (nearHuman ? 0.42 : 0.18)) {
      p.botPlantAt = time + 1800;
      p.input.bomb = true;
    } else p.input.bomb = false;
  }
  p.input.left = p.botDir.x < 0;
  p.input.right = p.botDir.x > 0;
  p.input.up = p.botDir.y < 0;
  p.input.down = p.botDir.y > 0;
}

function tickLobby(lobby, dt, time) {
  const game = lobby.game;
  if (!game || game.gameState !== 'playing') return;

  const elapsed = (time - game.startedAt) / 1000;
  const newShrink = elapsed < ROUND_LIMIT ? 0 : Math.min(MAX_SHRINK, Math.floor((elapsed - ROUND_LIMIT) / SHRINK_STEP) + 1);
  if (newShrink > game.shrinkLevel) {
    game.lastShrinkLevel = game.shrinkLevel;
    game.shrinkLevel = newShrink;
    game.events.push({ name: 'shrink' });
  }

  for (const p of game.players) {
    if (!p.alive) continue;
    if (p.bot) updateBot(game, p, dt, time);
    else {
      const client = [...lobby.clients.values()].find(c => c.slot === p.id);
      p.input = client?.input || emptyInput();
    }
    const pg = centerTile(p);
    if (isShrunkCell(game, pg.x, pg.y)) hurtPlayer(game, p, -1, time);
    movePlayer(game, p, p.input, dt, time);
    collectPower(game, p, time);
  }

  for (const b of [...game.bombs]) {
    if (!b.dead && time >= b.explodeAt) explodeBomb(game, b, time);
  }
  game.bombs = game.bombs.filter(b => !b.dead);
  game.explosions = game.explosions.filter(e => time < e.until);

  for (const e of game.explosions) {
    for (const p of game.players) {
      if (!p.alive) continue;
      const g = centerTile(p);
      if (g.x === e.x && g.y === e.y) hurtPlayer(game, p, e.ownerId, time);
    }
  }

  const alive = game.players.filter(p => p.alive);
  if (alive.length <= 1) finishGame(lobby, alive[0] || null, time);

  if (game.events.length) {
    for (const ev of game.events.splice(0)) broadcast(lobby, { type: 'event', name: ev.name });
  }
}

function finishGame(lobby, winner, time) {
  const game = lobby.game;
  if (!game || game.resultSent) return;
  game.gameState = 'gameover';
  game.winnerText = winner ? `${winner.name} wins!` : 'Draw!';
  game.resultSent = true;
  const results = game.players.map(p => ({
    slot: p.id,
    name: p.name,
    bot: p.bot,
    won: winner && winner.id === p.id ? 1 : 0,
    kills: p.kills || 0,
    deaths: p.deaths || (p.alive ? 0 : 1),
    survival_seconds: Math.floor((time - game.startedAt) / 1000),
    score: p.score || 0
  }));
  broadcast(lobby, { type: 'snapshot', state: snapshot(game) });
  broadcast(lobby, { type: 'result', winnerText: game.winnerText, results });
  setTimeout(() => {
    stopTimers(lobby);
    lobby.status = 'waiting';
    lobby.game = null;
    sendLobbyInfo(lobby);
  }, 9000);
}

function snapshot(game) {
  const time = Date.now();
  return {
    gameState: game.gameState,
    winnerText: game.winnerText,
    activeKey: game.activeKey,
    elapsed: Math.max(0, (time - game.startedAt) / 1000),
    map: game.map,
    state: { shake: 0, flash: 0, shrinkLevel: game.shrinkLevel, lastShrinkLevel: game.lastShrinkLevel },
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      colorName: p.colorName,
      x: 240 + p.gridX * 40,
      y: p.gridY * 40,
      r: 13,
      bot: p.bot,
      alive: p.alive,
      lives: p.lives,
      maxBombs: p.maxBombs,
      bombRange: p.bombRange,
      speedLevel: p.speedLevel,
      placedBombs: p.placedBombs,
      canKick: p.canKick,
      lastDir: p.lastDir,
      walking: p.walking,
      walkAnim: p.walkAnim,
      score: p.score,
      shieldLeft: Math.max(0, (p.shieldUntil - time) / 1000),
      wallpassLeft: Math.max(0, (p.wallpassUntil - time) / 1000),
      remoteLeft: Math.max(0, (p.remoteUntil - time) / 1000),
      bombpassLeft: Math.max(0, (p.bombpassUntil - time) / 1000),
      invulnLeft: Math.max(0, (p.invulnUntil - time) / 1000),
      hitAge: p.hitAt ? Math.max(0, (time - p.hitAt) / 1000) : 99
    })),
    bombs: game.bombs.map(b => ({
      x: b.x, y: b.y, ownerId: b.ownerId, range: b.range, remote: b.remote, bornAge: Math.max(0, (time - b.born) / 1000), explodeIn: Math.max(0, (b.explodeAt - time) / 1000)
    })),
    explosions: game.explosions.map(e => ({
      x: e.x, y: e.y, dx: e.dx, dy: e.dy, ownerId: e.ownerId, untilIn: Math.max(0, (e.until - time) / 1000), bornAge: Math.max(0, (time - e.born) / 1000)
    })),
    powerups: game.powerups.map(p => ({ ...p, bornAge: Math.max(0, (time - p.born) / 1000) })),
    particles: []
  };
}


function removeClient(client) {
  clients.delete(client.id);
  const lobby = client.lobbyCode ? lobbies.get(client.lobbyCode) : null;
  if (!lobby) return;
  lobby.clients.delete(client.id);
  if (lobby.clients.size === 0) {
    stopTimers(lobby);
    lobbies.delete(lobby.code);
    return;
  }
  if (lobby.hostId === client.id) {
    const first = [...lobby.clients.values()][0];
    lobby.hostId = first.id;
  }
  sendLobbyInfo(lobby);
}

function handleMessage(client, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  client.lastSeen = Date.now();

  if (msg.type === 'hello') {
    client.name = cleanText(msg.name, 24);
    client.skin = sanitizeSkin(msg.skin);
    send(client.ws, { type: 'hello', ok: true, clientId: client.id });
    return;
  }

  if (msg.type === 'joinPublic') {
    client.name = cleanText(msg.name, 24);
    client.skin = sanitizeSkin(msg.skin);
    let lobby = publicLobby();
    if (!lobby) lobby = createLobby('public', client);
    else addClientToLobby(lobby, client);
    return;
  }

  if (msg.type === 'createPrivate') {
    client.name = cleanText(msg.name, 24);
    client.skin = sanitizeSkin(msg.skin);
    createLobby('private', client);
    return;
  }

  if (msg.type === 'joinCode') {
    client.name = cleanText(msg.name, 24);
    client.skin = sanitizeSkin(msg.skin);
    const code = String(msg.code || '').trim().toUpperCase();
    const lobby = lobbies.get(code);
    if (!lobby) return send(client.ws, { type: 'error', message: 'Lobby nenalezena.' });
    if (lobby.status !== 'waiting') return send(client.ws, { type: 'error', message: 'Lobby už hraje.' });
    if (lobby.clients.size >= MAX_PLAYERS) return send(client.ws, { type: 'error', message: 'Lobby je plná.' });
    addClientToLobby(lobby, client);
    return;
  }

  const lobby = client.lobbyCode ? lobbies.get(client.lobbyCode) : null;
  if (!lobby) return;

  if (msg.type === 'startMatch') {
    if (lobby.hostId !== client.id) return send(client.ws, { type: 'error', message: 'Start může dát jen host.' });
    startGame(lobby);
    return;
  }

  if (msg.type === 'input') {
    client.input = {
      up: !!msg.input?.up,
      down: !!msg.input?.down,
      left: !!msg.input?.left,
      right: !!msg.input?.right,
      bomb: !!msg.input?.bomb,
      detonate: !!msg.input?.detonate
    };
  }
}

wss.on('connection', (ws, req) => {
  const client = {
    id: uid('c_'),
    ws,
    name: 'Hrac',
    skin: 'red',
    lobbyCode: '',
    slot: -1,
    input: emptyInput(),
    lastSeen: Date.now()
  };
  clients.set(client.id, client);
  send(ws, { type: 'hello', ok: true, clientId: client.id });
  ws.on('message', raw => handleMessage(client, raw));
  ws.on('close', () => removeClient(client));
  ws.on('error', () => removeClient(client));
});

setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 20;
  for (const lobby of [...lobbies.values()]) {
    if (lobby.clients.size === 0 || (lobby.status === 'waiting' && lobby.updatedAt < cutoff)) {
      stopTimers(lobby);
      lobbies.delete(lobby.code);
    }
  }
}, 30000);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`FIREUNG server-side multiplayer běží na portu ${PORT}`);
});
