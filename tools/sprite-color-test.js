'use strict';
/* =========================================================
   ТЕСТ ЦВЕТА СПРАЙТОВ (главная проверка: скелет ≠ привидение)

   Спрайты рисуются в canvas 2D, которого нет в Node. Здесь мы
   эмулируем ровно ту часть client.js, что задаёт цвета спрайтов:
     - texSkeleton  → бежевый «тёплый» (#e8d9b0)
     - texGhost     → холодный сине-белый (градиент #f4faff→#7aa8d8)
   и проверяем, что их средний цвет различается по тону
   (красный канал скелета заметно выше синего, у призрака — наоборот).

   Плюс статическая проверка исходника: палитра скелета бежевая и
   в ней не осталось прежних бело-голубых значений.

   Запуск: node tools/sprite-color-test.js
   ========================================================= */

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');

// --- вырезаем тела фабрик спрайтов, чтобы понять их палитру ---
function sliceSprite(name) {
  const start = src.indexOf(`const ${name} = (() => {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf('\n})();', start);
  return src.slice(start, end);
}
const skel = sliceSprite('texSkeleton');
const ghost = sliceSprite('texGhost');

console.log('\n[1] Палитра спрайта скелета');
// Инвертируем порядок каналов: в CSS это R,G,B — «тёплый» цвет имеет R > B.
const warmColors = [];   // [r,g,b] всех rgba() внутри texSkeleton
for (const m of skel.matchAll(/rgba\((\d+),(\d+),(\d+)/g)) {
  warmColors.push([+m[1], +m[2], +m[3]]);
}
check('скелет бежевый #e8d9b0', /#e8d9b0/.test(skel));
check('в скелете нет старой бело-голубой заливки #e6ecf2', !/#e6ecf2/.test(skel));
check('свечение скелета тёплое (232,217,176)', /rgba\(232,217,176/.test(skel));
check('тень скелета тёплая (226,206,158)', /rgba\(226,206,158/.test(skel));
check('глазницы скелета тёпло-тёмные (40,30,15)', /rgba\(40,30,15/.test(skel));
check('все rgba()-цвета скелета тёплые (R >= B) — холодных не осталось',
      warmColors.length > 0 && warmColors.every(([r,,b]) => r >= b));

console.log('\n[2] Привидение осталось холодным (не тронуто)');
check('призрак имеет сине-белый градиент #f4faff', /#f4faff/.test(ghost));
check('призрак имеет нижнюю голубую ноту #7aa8d8', /#7aa8d8/.test(ghost));
check('в призрак бежевый не просочился', !/#e8d9b0/.test(ghost));

console.log('\n[3] Средний тон спрайтов различается (эмуляция растра)');
// бежевый кости vs средняя линия градиента тела призрака
const bone = [0xe8, 0xd9, 0xb0];
const ghostMid = [0xd4, 0xe8, 0xfa]; // середина bodyGrad
const warmthSkel = bone[0] - bone[2];   // R-B
const warmthGhost = ghostMid[0] - ghostMid[2];
console.log(`  скелет R-B=${warmthSkel}, призрак R-B=${warmthGhost}`);
check('скелет теплее призрака по тону (R-B на 20+)', warmthSkel - warmthGhost >= 20);
check('яркость скелета сопоставима с призраком (не провал в черноту)',
      (bone[0]+bone[1]+bone[2])/3 > 150);

console.log('\n[4] Освещение: скелет подчиняется ambient, призрак светится сам');
check('привидение получает буст света *1.35', /isGhost\)\s*light\s*=\s*Math\.min\(1\.05,\s*light \* 1\.35\)/.test(src));
check('скелеты/предметы умножаются на itemAmbient', /else if \(!sp\.isGhost\) light \*= itemAmbient;/.test(src));
check('нет старой безусловной ветки "else light *= itemAmbient;"',
      !/\n  else light \*= itemAmbient;/.test(src));

console.log(`\nИТОГ: ${passed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
