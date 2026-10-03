'use strict';

const http    = require('http');
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');
const { WebSocketServer, OPEN } = require('ws');

/* =========================================================
   КОНФИГ
   ========================================================= */
const PORT          = process.env.PORT || 3000;
const TICK_RATE     = 30;            // Гц — частота рассылки состояний
const MAX_PLAYERS   = 16;
const NAME_MAX_LEN  = 16;
const JOIN_TIMEOUT  = 10_000;        // мс на отправку имени
const PLAYER_RADIUS = 0.22;
const MAX_SPEED     = 6.0;           // для мягкой анти-чит проверки

/* =========================================================
   ГЕНЕРАЦИЯ ЛАБИРИНТА
   ========================================================= */
const CELLS_X = 24, CELLS_Y = 24;
const MAPW = CELLS_X * 2 + 1;      // 49×49
const MAPH = CELLS_Y * 2 + 1;

const KEY_COUNT     = 5;           // все 5 нужны, чтобы открыть дверь
const BATTERY_COUNT = 6;           // +45 % заряда фонарика; респавн 30 с (на клиенте)
const MEDKIT_COUNT  = 4;           // аптечки; респавн 30 с (на клиенте)
const AMMO_COUNT    = 8;           // призы-патроны (+30); респавн 30 с (на клиенте)
const SKELETON_COUNT = 40;         // одновременно в лабиринте
const SKELETON_HITS_TO_KILL = 2;   // выстрелов дробовика на одного скелета
const SKELETON_VISION = 9;         // дальность прямой видимости для погони
const SKELETON_SPEED  = 1.9;       // клеток/с — заметно быстрее прежнего

function generateMaze() {
  const W = MAPW, H = MAPH;
  const g = new Uint8Array(W * H).fill(1);
  const vis = new Uint8Array(CELLS_X * CELLS_Y);
  const stack = [[0, 0]];
  vis[0] = 1;
  g[1 * W + 1] = 0;

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const avail = [];
    for (let i = 0; i < 4; i++) {
      const nx = cx + DIRS[i][0], ny = cy + DIRS[i][1];
      if (nx >= 0 && ny >= 0 && nx < CELLS_X && ny < CELLS_Y &&
          !vis[ny * CELLS_X + nx]) {
        avail.push(DIRS[i]);
      }
    }
    if (!avail.length) { stack.pop(); continue; }
    const d = avail[(Math.random() * avail.length) | 0];
    const nx = cx + d[0], ny = cy + d[1];
    vis[ny * CELLS_X + nx] = 1;
    g[(cy * 2 + 1 + d[1]) * W + (cx * 2 + 1 + d[0])] = 0;
    g[(ny * 2 + 1) * W + (nx * 2 + 1)] = 0;
    stack.push([nx, ny]);
  }

  // Случайные проломы в тупиках
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (g[y * W + x] !== 1) continue;
      const hz = g[(y - 1) * W + x] === 0 && g[(y + 1) * W + x] === 0;
      const vt = g[y * W + x - 1] === 0 && g[y * W + x + 1] === 0;
      if ((hz || vt) && Math.random() < 0.09) g[y * W + x] = 0;
    }
  }

  // Границы
  for (let x = 0; x < W; x++) { g[x] = 2; g[(H - 1) * W + x] = 2; }
  for (let y = 0; y < H; y++) { g[y * W] = 2; g[y * W + W - 1] = 2; }

  // «Металлические» блоки
  for (let i = 0; i < W * H; i++) {
    if (g[i] === 1 && Math.random() < 0.12) g[i] = 3;
  }

  return g;
}

/* Зал с дверью в центре. Стены кольца (все с чётными координатами) — это
   либо обычные стены, либо «лишние» проломы, их закрытие связность
   лабиринта не ломает; внутрь ведёт единственная дверь (клетка = 4). */
function carveCenterRoom(g) {
  const W = MAPW;
  const cx = MAPW >> 1, cy = MAPH >> 1;
  for (let y = cy - 1; y <= cy + 1; y++)
    for (let x = cx - 1; x <= cx + 1; x++) g[y * W + x] = 0;
  for (let x = cx - 2; x <= cx + 2; x++) { g[(cy - 2) * W + x] = 1; g[(cy + 2) * W + x] = 1; }
  for (let y = cy - 2; y <= cy + 2; y++) { g[y * W + cx - 2] = 1; g[y * W + cx + 2] = 1; }
  g[(cy - 3) * W + cx] = 0;          // подход к двери из коридора
  g[(cy - 2) * W + cx] = 4;          // ДВЕРЬ (непроходима, пока не открыта)
  return { x: cx, y: cy - 2 };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* Предметы общие для всех (позиции одинаковые), собирает каждый свой.
   Ключи — в тупиках подальше от двери; батарейки/аптечки — по коридорам. */
function placeServerItems(g, door) {
  const deadEnds = [];
  const openCells = [];
  for (let y = 1; y < MAPH - 1; y++) {
    for (let x = 1; x < MAPW - 1; x++) {
      if (g[y * MAPW + x] !== 0) continue;
      const wx = x + 0.5, wy = y + 0.5;
      let open = 0;
      if (g[(y - 1) * MAPW + x] === 0) open++;
      if (g[(y + 1) * MAPW + x] === 0) open++;
      if (g[y * MAPW + x - 1] === 0) open++;
      if (g[y * MAPW + x + 1] === 0) open++;
      if (open === 1) deadEnds.push([wx, wy]);
      openCells.push([wx, wy]);
    }
  }

  const doorCx = door.x + 0.5, doorCy = door.y + 0.5;
  const items = [];

  const keySpots = shuffle(deadEnds.filter(
    ([x, y]) => Math.hypot(x - doorCx, y - doorCy) > 8));
  for (let i = 0; i < KEY_COUNT && i < keySpots.length; i++) {
    items.push({ x: keySpots[i][0], y: keySpots[i][1], type: 'key' });
  }

  const free = shuffle(openCells.filter(([x, y]) =>
    Math.hypot(x - doorCx, y - doorCy) > 3 &&
    !items.some(it => Math.hypot(it.x - x, it.y - y) < 2)));
  const totalPrizes = BATTERY_COUNT + MEDKIT_COUNT + AMMO_COUNT;
  let placed = 0;
  for (const [x, y] of free) {
    if (placed >= totalPrizes) break;
    if (items.some(it => Math.hypot(it.x - x, it.y - y) < 2)) continue;
    items.push({
      x, y,
      type: placed < BATTERY_COUNT ? 'battery'
           : placed < BATTERY_COUNT + MEDKIT_COUNT ? 'medkit'
           : 'ammo',
    });
    placed++;
  }
  return items;
}

/* =========================================================
   СОСТОЯНИЕ СЕРВЕРА
   ========================================================= */
function buildRound() {
  const grid = generateMaze();
  const door = carveCenterRoom(grid);
  const items = placeServerItems(grid, door);
  return { grid, door, items };
}

let round = buildRound();
let mazeGrid = round.grid;
const mazeData = Array.from(mazeGrid);   // для отправки клиенту
let roundOver = false;

/** @type {Map<string, Player>} */
const players = new Map();

let lastMapGen = 0;   // защита от спама перегенерацией карты

/* ---------- Скелеты (общие для всех) ---------- */
const skeletons = [];
let skeletonSeq = 0;

function isWallCell(cx, cy) {
  if (cx < 0 || cy < 0 || cx >= MAPW || cy >= MAPH) return true;
  return mazeGrid[cy * MAPW + cx] > 0;
}

function canWalk(x, y, r) {
  r = r || 0.22;
  return !isWallCell(Math.floor(x - r), Math.floor(y - r)) &&
         !isWallCell(Math.floor(x + r), Math.floor(y - r)) &&
         !isWallCell(Math.floor(x - r), Math.floor(y + r)) &&
         !isWallCell(Math.floor(x + r), Math.floor(y + r));
}

function hasLOS(x1, y1, x2, y2) {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.ceil(dist * 3);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWallCell(Math.floor(x1 + (x2 - x1) * t), Math.floor(y1 + (y2 - y1) * t))) return false;
  }
  return true;
}

function randomOpenCell(minDistFromPlayers) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const x = 1.5 + Math.random() * (MAPW - 3);
    const y = 1.5 + Math.random() * (MAPH - 3);
    if (!canWalk(x, y, 0.3)) continue;
    if (minDistFromPlayers) {
      let ok = true;
      for (const p of players.values()) {
        if (Math.hypot(p.x - x, p.y - y) < minDistFromPlayers) { ok = false; break; }
      }
      if (!ok) continue;
    }
    return [x, y];
  }
  return [1.5, 1.5];
}

/* Точки спавна скелетов — все проходимые клетки лабиринта, они же кандидаты
   для респавна. Каждый следующий скелет встаёт в самую удалённую от уже
   стоящих точку (farthest-point sampling), поэтому скелеты покрывают карту
   равномерно и не могут появиться в одной точке — ни на старте, ни при
   респавне. Раньше случайный выбор с постепенным смягчением дистанции
   (6 → … → 0.9) мог в крайнем случае поставить скелетов вплотную. */
let spawnPts = [];

function buildSpawnPts() {
  spawnPts = [];
  for (let cy = 1; cy < MAPH - 1; cy++) {
    for (let cx = 1; cx < MAPW - 1; cx++) {
      if (mazeGrid[cy * MAPW + cx] !== 0) continue;
      const x = cx + 0.5, y = cy + 0.5;
      if (canWalk(x, y, 0.28)) spawnPts.push([x, y]);
    }
  }
}

/* Самая «пустая» точка карты: максимум расстояния до ближайшего живого
   скелета; точки ближе 4 клеток к игрокам не рассматриваются. Ничьи
   разыгрываются случайно, чтобы не было смещения к началу списка. */
function farthestSpawnPoint() {
  let best = null, bestD2 = -1, ties = 0;
  for (const pt of spawnPts) {
    let blocked = false;
    for (const p of players.values()) {
      const dx = p.x - pt[0], dy = p.y - pt[1];
      if (dx * dx + dy * dy < 16) { blocked = true; break; }
    }
    if (blocked) continue;
    let nearest2 = Infinity;
    for (const o of skeletons) {
      if (!o.alive) continue;
      const dx = o.x - pt[0], dy = o.y - pt[1];
      const d2 = dx * dx + dy * dy;
      if (d2 < nearest2) nearest2 = d2;
    }
    if (nearest2 > bestD2) { bestD2 = nearest2; best = pt; ties = 1; }
    else if (nearest2 === bestD2 && Math.random() < 1 / ++ties) best = pt;
  }
  return best;
}

/* Запасной вариант, если совсем нет подходящих точек (игроки перекрыли
   окрестности): любые открытые клетки, лишь бы не вплотную к другим. */
function fallbackSpawnPoint() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [x, y] = randomOpenCell(0);
    let ok = true;
    for (const p of players.values()) {
      if (Math.hypot(p.x - x, p.y - y) < 4) { ok = false; break; }
    }
    if (!ok) continue;
    for (const o of skeletons) {
      if (o.alive && Math.hypot(o.x - x, o.y - y) < 1.2) { ok = false; break; }
    }
    if (ok) return [x, y];
  }
  return randomOpenCell(0);
}

function pickSkeletonSpot() {
  return farthestSpawnPoint() || fallbackSpawnPoint();
}

function spawnSkeleton() {
  const [x, y] = pickSkeletonSpot();
  return {
    id: 's' + (++skeletonSeq),
    x, y,
    tx: null, ty: null,       // дальняя цель патруля
    wx: null, wy: null,       // путевая точка (центр следующей клетки)
    alive: true,
    hits: 0,                  // попаданий дробовика до смерти
    respawnAt: 0,
    lastHitAt: 0,
    retargetAt: 0,
  };
}

function resetSkeletons() {
  buildSpawnPts();
  skeletons.length = 0;
  for (let i = 0; i < SKELETON_COUNT; i++) skeletons.push(spawnSkeleton());
  // диагностика раскладки: минимальная и средняя дистанция до ближайшего соседа
  let minPair = Infinity, sumNearest = 0;
  for (let i = 0; i < skeletons.length; i++) {
    let nearest = Infinity;
    for (let j = 0; j < skeletons.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(skeletons[i].x - skeletons[j].x, skeletons[i].y - skeletons[j].y);
      if (d < nearest) nearest = d;
      if (d < minPair) minPair = d;
    }
    sumNearest += nearest;
  }
  console.log(`[skeletons] ${skeletons.length} шт., дистанция до соседа: мин ${minPair.toFixed(2)}, `
    + `средняя ${(sumNearest / skeletons.length).toFixed(2)} (точек-кандидатов: ${spawnPts.length})`);
}
resetSkeletons();

/* BFS по открытому лабиринту: следующий шаг от (fx,fy) к (tx,ty) */
const bfsPrev = new Int32Array(MAPW * MAPH);
const bfsQueue = new Int32Array(MAPW * MAPH);
function bfsNextStep(fx, fy, tx, ty) {
  const W = MAPW;
  const sx = Math.floor(fx), sy = Math.floor(fy);
  const gx = Math.floor(tx), gy = Math.floor(ty);
  if (sx === gx && sy === gy) return null;
  if (isWallCell(gx, gy)) return null;
  bfsPrev.fill(-1);
  let head = 0, tail = 0;
  bfsQueue[tail++] = sy * W + sx;
  bfsPrev[sy * W + sx] = sy * W + sx;
  while (head < tail) {
    const cur = bfsQueue[head++];
    if (cur === gy * W + gx) break;
    const cx = cur % W, cy = (cur / W) | 0;
    for (let i = 0; i < 4; i++) {
      const nx = cx + (i === 0 ? 1 : i === 1 ? -1 : 0);
      const ny = cy + (i === 2 ? 1 : i === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= MAPW || ny >= MAPH) continue;
      const ni = ny * W + nx;
      if (bfsPrev[ni] !== -1 || mazeGrid[ni] !== 0) continue;
      bfsPrev[ni] = cur;
      bfsQueue[tail++] = ni;
    }
  }
  if (bfsPrev[gy * W + gx] === -1) return null;
  // шаг назад от цели до старта
  let cur = gy * W + gx;
  while (bfsPrev[cur] !== sy * W + sx && bfsPrev[cur] !== cur) cur = bfsPrev[cur];
  if (bfsPrev[cur] !== sy * W + sx) return null;
  return [cur % W + 0.5, ((cur / W) | 0) + 0.5];
}

/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} name
 * @property {import('ws').WebSocket} ws
 * @property {number} x
 * @property {number} y
 * @property {number} dirX
 * @property {number} dirY
 * @property {number} color
 * @property {number} hp
 * @property {number} score           — очки раунда (сервер — источник истины)
 * @property {number} exploredTotal   — защита от завышения очков за клетки
 * @property {number} lastExploreAt
 * @property {number} lastScoreMsgAt
 * @property {number} lastSeen
 * @property {number} lastMoveTime
 * @property {number} lastX
 * @property {number} lastY
 */

/* =========================================================
   УТИЛИТЫ
   ========================================================= */
function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Игрок';
  const clean = raw
    .replace(/[\u0000-\u001f\u007f<>"'`&]/g, '')
    .trim()
    .slice(0, NAME_MAX_LEN);
  return clean || 'Игрок';
}

function uniqueName(base) {
  if (![...players.values()].some(p => p.name === base)) return base;
  let n = 2;
  while ([...players.values()].some(p => p.name === base + n)) n++;
  return (base + n).slice(0, NAME_MAX_LEN);
}

function pickSpawn() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const x = 1.5 + Math.random() * (MAPW - 3);
    const y = 1.5 + Math.random() * (MAPH - 3);
    if (!canWalk(x, y)) continue;
    let ok = true;
    for (const p of players.values()) {
      if (Math.hypot(p.x - x, p.y - y) < 3) { ok = false; break; }
    }
    if (ok) return [x, y];
  }
  return [1.5, 1.5];
}

function randomColor() {
  const palette = [0xff6b6b, 0x4ecdc4, 0xffe66d, 0x95e1d3,
                   0xf38181, 0xaa96da, 0xfcbad3, 0xa8d8ea];
  return palette[(Math.random() * palette.length) | 0];
}

function publicPlayer(p) {
  return {
    id:   p.id,
    name: p.name,
    x:    +p.x.toFixed(3),
    y:    +p.y.toFixed(3),
    dirX: +p.dirX.toFixed(3),
    dirY: +p.dirY.toFixed(3),
    color: p.color,
    hp:    p.hp,
    score: p.score,
  };
}

function snapshotSkeletons() {
  const out = [];
  for (const s of skeletons) {
    if (!s.alive) continue;
    out.push({ id: s.id, x: +s.x.toFixed(2), y: +s.y.toFixed(2), hits: s.hits });
  }
  return out;
}

function snapshotPlayers() {
  const out = [];
  for (const p of players.values()) out.push(publicPlayer(p));
  return out;
}

function send(ws, data) {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data, exceptId = null) {
  const raw = JSON.stringify(data);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === OPEN) p.ws.send(raw);
  }
}

/* =========================================================
   EXPRESS
   ========================================================= */
const app = express();
// Без maxAge: ETag/Last-Modified дают 304-ревалидацию, и браузер всегда
// видит свежий client.js после правок (часовой кэш маскировал изменения).
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, players: players.size, max: MAX_PLAYERS });
});

const server = http.createServer(app);

/* =========================================================
   WEBSOCKET
   ========================================================= */
const wss = new WebSocketServer({ server, maxPayload: 4096 });

/* Heartbeat: сокет, не ответивший на ping, убиваем принудительно — иначе
   «молчаливый» обрыв (сон ноутбука, RDP, Wi-Fi) держит слот игрока минутами */
const HEARTBEAT_MS = 15000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* мёртвый сокет закроется через 'close' */ }
  }
}, HEARTBEAT_MS);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (players.size >= MAX_PLAYERS) {
    send(ws, { type: 'error', message: 'Сервер переполнен' });
    ws.close(1013, 'Server full');
    return;
  }

  const id = makeId();
  let joined = false;
  const ip = req.socket.remoteAddress;

  const joinTimer = setTimeout(() => {
    if (!joined) ws.close(1008, 'Join timeout');
  }, JOIN_TIMEOUT);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    /* ---------- первое сообщение — join ---------- */
    if (!joined) {
      if (msg.type !== 'join') return;
      const name = uniqueName(sanitizeName(msg.name));
      const [x, y] = pickSpawn();

      /** @type {Player} */
      const player = {
        id, name, ws,
        x, y,
        dirX: 1, dirY: 0,
        color: randomColor(),
        hp: 100,
        score: 0,
        exploredTotal: 0,
        lastExploreAt: 0,
        lastScoreMsgAt: 0,
        lastSeen: Date.now(),
        lastMoveTime: Date.now(),
        lastX: x, lastY: y,
      };
      players.set(id, player);
      joined = true;
      clearTimeout(joinTimer);

      send(ws, {
        type: 'init',
        id,
        name,
        map: {
          w: MAPW,
          h: MAPH,
          cells: mazeData,          // 0 пол · 1 кирпич · 2 граница · 3 металл · 4 дверь
          door: round.door,         // дверь зала в центре
          items: round.items,       // общие позиции предметов
        },
        spawn: { x, y },
        players: snapshotPlayers(),
        skeletons: snapshotSkeletons(),
        maxPlayers: MAX_PLAYERS,
      });

      broadcast({ type: 'playerJoined', player: publicPlayer(player) }, id);
      console.log(`[+] ${name} (${id}) ${ip} — всего: ${players.size}`);
      return;
    }

    /* ---------- далее — от уже подключённого ---------- */
    const p = players.get(id);
    if (!p) return;

    switch (msg.type) {
      case 'move': {
        const nx = Number(msg.x), ny = Number(msg.y);
        const dx = Number(msg.dirX), dy = Number(msg.dirY);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

        // мягкая защита: не даём телепортироваться
        const now = Date.now();
        const dt = Math.max(0.001, (now - p.lastMoveTime) / 1000);
        const maxDist = MAX_SPEED * dt + 0.5;
        const moved = Math.hypot(nx - p.lastX, ny - p.lastY);
        if (moved > maxDist) return;

        if (!canWalk(nx, ny)) return;

        p.x = nx; p.y = ny;
        p.dirX = dx; p.dirY = dy;
        p.lastSeen = now;
        p.lastMoveTime = now;
        p.lastX = nx; p.lastY = ny;
        break;
      }

      case 'newMap': {
        // Перегенерация ОБЩЕЙ карты и расселение всех игроков заново.
        // Не чаще одного раза в 3 секунды, чтобы нельзя было заспамить.
        const t = Date.now();
        if (t - lastMapGen < 3000) break;
        lastMapGen = t;

        round = buildRound();
        mazeGrid = round.grid;
        for (let i = 0; i < mazeData.length; i++) mazeData[i] = mazeGrid[i];
        roundOver = false;
        resetSkeletons();

        for (const pl of players.values()) {
          const [sx, sy] = pickSpawn();
          pl.x = sx; pl.y = sy;
          pl.lastX = sx; pl.lastY = sy;
          pl.lastMoveTime = t;
          pl.score = 0;
          pl.exploredTotal = 0;
        }

        broadcast({
          type: 'newMap',
          map: { w: MAPW, h: MAPH, cells: mazeData, door: round.door, items: round.items },
          players: snapshotPlayers(),
          skeletons: snapshotSkeletons(),
        });
        console.log(`[map] ${p.name} (${id}) перегенерировал карту`);
        break;
      }

      /* ---------- Очки (сервер — источник истины для hi-score) ---------- */
      case 'explore': {
        const now = Date.now();
        if (now - p.lastExploreAt < 300) break;   // клиент шлёт батчи раз в 2 с
        p.lastExploreAt = now;
        const n = Math.floor(Number(msg.n));
        if (!Number.isFinite(n) || n <= 0) break;
        const capped = Math.min(n, MAPW * MAPH - p.exploredTotal);
        if (capped <= 0) break;
        p.exploredTotal += capped;
        p.score += capped * 5;
        break;
      }
      case 'key': {
        const now = Date.now();
        if (now - p.lastScoreMsgAt < 100) break;
        p.lastScoreMsgAt = now;
        p.score += 250;
        break;
      }
      case 'pickup': {
        const now = Date.now();
        if (now - p.lastScoreMsgAt < 100) break;
        p.lastScoreMsgAt = now;
        p.score += msg.kind === 'medkit' ? 30 : 20;
        break;
      }
      case 'skeletonHit': {
        // Дробовик: скелет должен быть в прямой видимости рядом с игроком,
        // на смерть нужно SKELETON_HITS_TO_KILL (2) попадания. Сервер считает попадания.
        const now = Date.now();
        if (now - p.lastScoreMsgAt < 100) break;
        const s = skeletons.find(k => k.id === msg.id);
        if (!s || !s.alive) break;
        if (Math.hypot(s.x - p.x, s.y - p.y) > 8) break;   // выстрел не «через всю карту»
        if (!hasLOS(s.x, s.y, p.x, p.y)) break;
        p.lastScoreMsgAt = now;
        s.hits++;
        if (s.hits >= SKELETON_HITS_TO_KILL) {
          s.alive = false;
          s.hits = 0;
          s.respawnAt = now + 20000;
          p.score += 50;
        }
        break;
      }
      case 'win': {
        if (roundOver) break;
        roundOver = true;
        p.score += 5000;
        broadcast({ type: 'gameEnd', winner: p.name, winnerId: p.id, score: p.score });
        console.log(`[win] ${p.name} открыл дверь — ${p.score} очков`);
        break;
      }

      case 'chat': {
        const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, '').slice(0, 120);
        if (!text) return;
        // Отправителю не дублируем: он уже показал строку локально
        broadcast({ type: 'chat', id, name: p.name, text }, id);
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong', t: msg.t, server: Date.now() });
        break;
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    if (players.has(id)) {
      players.delete(id);
      broadcast({ type: 'playerLeft', id });
      console.log(`[-] ${id} — всего: ${players.size}`);
    }
  });

  ws.on('error', () => { /* игнорируем */ });
});

/* =========================================================
   ЦИКЛ РАССЫЛКИ СОСТОЯНИЙ
   ========================================================= */
let lastTick = Date.now();
setInterval(() => {
  lastTick = Date.now();
  if (players.size === 0) return;

  broadcast({
    type: 'state',
    t: lastTick,
    players: snapshotPlayers(),
    skeletons: snapshotSkeletons(),
  });
}, 1000 / TICK_RATE);

/* =========================================================
   ТИК СКЕЛЕТОВ (10 Гц): патруль, погоня при прямой видимости.
   Движение — по путевым точкам (центры клеток) со скольжением вдоль
   стен, чтобы скелеты не цеплялись и не застревали на поворотах.
   ========================================================= */
setInterval(() => {
  const dt = 0.1;
  const now = Date.now();
  for (const s of skeletons) {
    if (!s.alive) {
      if (s.respawnAt && now >= s.respawnAt) {
        const [x, y] = pickSkeletonSpot();
        s.x = x; s.y = y;
        s.tx = null; s.ty = null;
        s.wx = null; s.wy = null;
        s.alive = true;
        s.respawnAt = 0;
      }
      continue;
    }

    // Цель: ближайший игрок в прямой видимости, иначе патруль
    let chase = null, chaseDist = Infinity;
    for (const p of players.values()) {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d < SKELETON_VISION && d < chaseDist && hasLOS(s.x, s.y, p.x, p.y)) { chase = p; chaseDist = d; }
    }

    // Вплотную к игроку — идём ПРЯМО на него, без клеточных путевых точек:
    // иначе скелет останавливается в центре клетки рядом и «машет воздухом»
    if (chase && chaseDist < 1.4) {
      const dx = chase.x - s.x, dy = chase.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.001) {
        const step = Math.min(SKELETON_SPEED * dt, d);
        const nx = s.x + dx / d * step;
        const ny = s.y + dy / d * step;
        if (canWalk(nx, ny, 0.28)) { s.x = nx; s.y = ny; }
        else if (canWalk(nx, s.y, 0.28)) s.x = nx;
        else if (canWalk(s.x, ny, 0.28)) s.y = ny;
      }
      continue;
    }

    let tx, ty;
    if (chase) {
      tx = chase.x; ty = chase.y;
      s.wx = null; s.wy = null;          // путь к живому игроку пересчитываем всегда
    } else {
      if (s.tx === null || Math.hypot(s.tx - s.x, s.ty - s.y) < 0.3) {
        const [rx, ry] = randomOpenCell(0);
        s.tx = rx; s.ty = ry;
      }
      tx = s.tx; ty = s.ty;
    }

    // путевая точка: следующий шаг BFS, берём новый только когда дошли
    if (s.wx === null || Math.hypot(s.wx - s.x, s.wy - s.y) < 0.12) {
      const nxt = bfsNextStep(s.x, s.y, tx, ty);
      if (nxt) { s.wx = nxt[0]; s.wy = nxt[1]; }
      else { s.tx = null; s.ty = null; s.wx = null; s.wy = null; }
    }

    if (s.wx !== null) {
      const dx = s.wx - s.x, dy = s.wy - s.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.001) {
        const step = Math.min(SKELETON_SPEED * dt, d);
        const nx = s.x + dx / d * step;
        const ny = s.y + dy / d * step;
        if (canWalk(nx, ny, 0.28)) { s.x = nx; s.y = ny; }
        else if (canWalk(nx, s.y, 0.28)) s.x = nx;       // скольжение по стене
        else if (canWalk(s.x, ny, 0.28)) s.y = ny;
        else { s.wx = null; s.wy = null; }               // упёрлись — новый путь
      }
    }
  }
}, 100);

/* =========================================================
   СТАРТ
   ========================================================= */
// 0.0.0.0 — слушать все интерфейсы, чтобы играть можно было не только с localhost
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ЛАБИРИНТ-СЕРВЕР запущен`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Карта: ${MAPW}×${MAPH}, тик ${TICK_RATE} Гц, лимит ${MAX_PLAYERS} игроков\n`);
});

/* Перезапуск сервера по Ctrl+C без висящих сокетов */
process.on('SIGINT', () => {
  console.log('\nОстановка...');
  for (const p of players.values()) {
    try { p.ws.close(1001, 'Server shutdown'); } catch {}
  }
  wss.close(() => server.close(() => process.exit(0)));
});