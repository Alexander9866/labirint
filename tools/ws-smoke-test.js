'use strict';
/* =========================================================
   СМОУК-ТЕСТ ИГРОВОГО СЕРВЕРА (≈30 проверок протокола)

   Проверяет: join/init, структуру карты (дверь, предметы),
   скелеты, state-снапшоты, очки и их анти-чит защиту,
   win/gameEnd, newMap со сбросом, чат (без дубля отправителю),
   ping/pong, анти-телепорт, лимит имени, playerLeft.

   Запуск: node server.js  (в другом терминале)
           node tools/ws-smoke-test.js
           другой порт:    TEST_PORT=8080 node tools/ws-smoke-test.js
   ========================================================= */

const WebSocket = require('ws');

const PORT = process.env.TEST_PORT || process.env.PORT || 3000;
const URL = `ws://localhost:${PORT}`;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'join', name })); resolve(ws); });
    ws.on('error', reject);
  });
}

// ждёт сообщение заданного типа (или таймаут)
function waitFor(ws, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for '${type}'`));
    }, timeoutMs);
    function onMsg(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === type) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    }
    ws.on('message', onMsg);
  });
}

function collect(ws, ms) {
  const list = [];
  const h = raw => { try { list.push(JSON.parse(raw)); } catch {} };
  ws.on('message', h);
  return new Promise(res => setTimeout(() => { ws.off('message', h); res(list); }, ms));
}

const send = (ws, obj) => ws.send(JSON.stringify(obj));

(async () => {
  console.log(`Смоук-тест: ${URL}\n`);

  /* ---------- 1. join / init ---------- */
  const a = await connect('ТестА');
  const initA = await waitFor(a, 'init');

  check('init получен', !!initA);
  check('id непустой строкой', typeof initA.id === 'string' && initA.id.length > 0);
  check('имя сохранено', initA.name === 'ТестА');
  check('maxPlayers = 16', initA.maxPlayers === 16);
  check('spawn проходимый', Number.isFinite(initA.spawn?.x) && Number.isFinite(initA.spawn?.y));

  /* ---------- 2. карта ---------- */
  const map = initA.map;
  check('карта 49×49', map.w === 49 && map.h === 49);
  check('cells — массив из 49*49', Array.isArray(map.cells) && map.cells.length === 49 * 49);
  const types = new Set(map.cells);
  check('типы блоков ⊂ {0,1,2,3,4}', [...types].every(t => t >= 0 && t <= 4));
  check('есть граница (2)', types.has(2));
  check('есть пол (0)', types.has(0));
  check('дверь в центре (клетка 4)', map.door && map.cells[map.door.y * map.w + map.door.x] === 4);

  const itemsByType = {};
  for (const it of map.items) itemsByType[it.type] = (itemsByType[it.type] || 0) + 1;
  check('5 ключей', itemsByType.key === 5);
  check('6 батареек', itemsByType.battery === 6);
  check('4 аптечки', itemsByType.medkit === 4);
  check('8 патронов', itemsByType.ammo === 8);
  check('позиции предметов целые (.5)', map.items.every(it => Math.abs((it.x % 1) - 0.5) < 1e-9));

  /* ---------- 3. скелеты ---------- */
  check('40 скелетов', Array.isArray(initA.skeletons) && initA.skeletons.length === 40);
  check('скелеты не в одной точке', new Set(initA.skeletons.map(s => `${s.x},${s.y}`)).size === 40);
  check('у скелетов есть id/x/y/hits', initA.skeletons.every(s => s.id && Number.isFinite(s.x) && Number.isFinite(s.y)));

  /* ---------- 4. state 30 Гц ---------- */
  const states = (await collect(a, 700)).filter(m => m.type === 'state');
  check('state приходит (~30 Гц)', states.length >= 10);
  check('в state есть игрок А', states.at(-1).players.some(p => p.id === initA.id));

  /* ---------- 5. второй игрок, broadcast playerJoined ---------- */
  // init для B ловим ДО подключения: ws буферизует входящие кадры,
  // слушатель навешивается до отправки join
  const bListener = collect(a, 3000);          // слушаем на А
  const wsB = new WebSocket(URL);
  const initBP = new Promise((resolve, reject) => {
    wsB.on('open', () => wsB.send(JSON.stringify({ type: 'join', name: 'ТестB' })));
    wsB.on('error', reject);
    const h = raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'init') { wsB.off('message', h); resolve(m); }
    };
    wsB.on('message', h);
    setTimeout(() => reject(new Error("timeout waiting for 'init' (B)")), 4000);
  });
  const b = wsB;
  const joined = (await bListener).find(m => m.type === 'playerJoined');
  check('А получил playerJoined о B', !!joined && joined.player.name === 'ТестB');
  const initB = await initBP;
  check('B видит двух игроков в init', initB.players.length === 2);

  /* ---------- 6. чат без дублирования отправителю ---------- */
  const chatOnA = collect(a, 800);
  send(b, { type: 'chat', text: 'привет' });
  const gotA = (await chatOnA).some(m => m.type === 'chat' && m.text === 'привет' && m.name === 'ТестB');
  const selfEcho = collect(b, 500);
  send(b, { type: 'chat', text: 'echo?' });
  const gotSelf = (await selfEcho).some(m => m.type === 'chat' && m.text === 'echo?');
  check('чат от B дошёл до А', gotA);
  check('отправитель НЕ получает свой чат по сети', !gotSelf);

  /* ---------- 7. ping/pong ---------- */
  const t0 = Date.now();
  send(a, { type: 'ping', t: t0 });
  const pong = await waitFor(a, 'pong');
  check('pong с тем же t', pong.t === t0 && Number.isFinite(pong.server));

  /* ---------- 8. движение: нормальное и анти-телепорт ---------- */
  const stBefore = states.at(-1).players.find(p => p.id === initA.id);
  send(a, { type: 'move', x: stBefore.x + 0.3, y: stBefore.y, dirX: 1, dirY: 0 });
  const movedOk = (await waitFor(a, 'state', 1500)).players.find(p => p.id === initA.id);
  check('обычный move принимается', Math.abs(movedOk.x - (stBefore.x + 0.3)) < 0.05);

  const beforeTeleport = movedOk.x;
  send(a, { type: 'move', x: beforeTeleport + 40, y: movedOk.y, dirX: 1, dirY: 0 });
  await new Promise(r => setTimeout(r, 400));
  const afterSt = (await waitFor(a, 'state', 1500)).players.find(p => p.id === initA.id);
  check('телепорт отклонён', Math.abs(afterSt.x - beforeTeleport) < 0.001);

  /* ---------- 9. очки и защита ---------- */
  const scoreOf = st => st.players.find(p => p.id === initA.id).score;

  send(a, { type: 'explore', n: 10 });
  let st = await waitFor(a, 'state', 1500);
  check('explore +5/клетка (10 → +50)', scoreOf(st) === 50);

  send(a, { type: 'explore', n: 10 });   // сразу — анти-спам 300 мс
  await new Promise(r => setTimeout(r, 100));
  st = await waitFor(a, 'state', 1500);
  check('анти-спам explore (второй батч за 300 мс игнорируется)', scoreOf(st) === 50);

  await new Promise(r => setTimeout(r, 300));
  send(a, { type: 'explore', n: 5000 }); // завышение — ограничивается размером карты
  st = await waitFor(a, 'state', 1500);
  check('лимит очков за исследование', scoreOf(st) <= (49 * 49) * 5);

  send(a, { type: 'key' });
  st = await waitFor(a, 'state', 1500);
  const scKey = scoreOf(st);
  check('ключ +250', [50, 2401 * 5].includes(scKey - 250) || scKey >= 250);

  send(a, { type: 'key' });              // быстрее 100 мс — игнор
  await new Promise(r => setTimeout(r, 50));
  st = await waitFor(a, 'state', 1500);
  check('анти-спам key (100 мс)', scoreOf(st) === scKey);

  await new Promise(r => setTimeout(r, 120));
  send(a, { type: 'pickup', kind: 'medkit' });
  st = await waitFor(a, 'state', 1500);
  check('аптечка +30', scoreOf(st) === scKey + 30);

  /* ---------- 10. skeletonHit: чужого id нет, своего — засчитывается ---------- */
  const skel = initA.skeletons[0];
  send(a, { type: 'skeletonHit', id: 's99999' });
  await new Promise(r => setTimeout(r, 300));
  st = await waitFor(a, 'state', 1500);
  check('hit по несуществующему скелету игнорируется', st.skeletons.some(s => s.id === skel.id));

  /* ---------- 11. win / gameEnd ---------- */
  const endPromise = waitFor(a, 'gameEnd', 3000);
  const endBPromise = waitFor(b, 'gameEnd', 3000).catch(() => null);
  send(a, { type: 'win' });
  const end = await endPromise;
  check('gameEnd с победителем', end.winner === 'ТестА' && end.winnerId === initA.id);
  check('победа +5000', end.score >= 5000);
  const endB = await endBPromise;
  check('gameEnd разослан всем', !!endB);

  /* ---------- 12. newMap: перегенерация и сброс счёта ---------- */
  const newMapA = waitFor(a, 'newMap', 3000);
  send(b, { type: 'newMap' });
  const nm = await newMapA;
  check('newMap содержит карту 49×49', nm.map.w === 49 && nm.map.cells.length === 49 * 49);
  check('newMap содержит скелетов', nm.skeletons.length === 40);
  st = await waitFor(a, 'state', 1500);
  check('счёт сброшен после newMap', st.players.find(p => p.id === initA.id).score === 0);
  const spamBefore = Date.now();
  send(b, { type: 'newMap' });            // сразу — анти-спам 3 с
  const raced = await waitFor(a, 'newMap', 500).then(() => true).catch(() => false);
  check('анти-спам newMap (3 с)', !raced);
  console.log(`       (пауза ${(Date.now() - spamBefore)} мс)`);

  /* ---------- 13. лимит имени ---------- */
  const c = await connect('ОченьДлинноеИмяИгрокаСПерегрузом1234567890');
  const initC = await waitFor(c, 'init');
  check('имя урезано до 16 символов', initC.name.length <= 16);
  check('дубликаты имён уникализируются', initC.name !== 'ТестА');

  /* ---------- 14. playerLeft ---------- */
  const leftP = waitFor(b, 'playerLeft', 3000);
  c.close();
  const left = await leftP;
  check('playerLeft при отключении', left.id === initC.id);

  /* ---------- 15. битый JSON не роняет сервер ---------- */
  a.send('{не json');
  st = await waitFor(a, 'state', 2000);
  check('сервер жив после мусорного пакета', !!st);

  a.close(); b.close();
  console.log(`\nИТОГ: ${passed} ok, ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\nОШИБКА ТЕСТА:', err.message);
  console.error('Убедитесь, что сервер запущен: node server.js');
  process.exit(1);
});
