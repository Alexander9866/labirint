/* ============================================================
   ЛАБИРИНТ — многопользовательский клиент
   Требует на странице: <canvas id="view">, <canvas id="map">,
   элементы #overlay, #startBtn, #diffRow, #hpFill, #batFill,
   #keysIcons, #scoreHud, #distHud, #stateBadge, #posInfo,
   #fpsInfo, #newBtn, #sensS/#sensV, #fovS/#fovV, #volS/#volV.
   ============================================================ */
(() => {
'use strict';

/* =========================================================
   КОНСТАНТЫ
   ========================================================= */
const VIEW_W = 480, VIEW_H = 270, TS = 128;
// Генераторы текстур написаны в исходных координатах 64×64 (xs = x/S, ys = y/S),
// поэтому с ростом TS растёт только разрешение сэмплирования, а вид узоров
// (размер кирпича, швов, зерна) сохраняется.
const S = TS / 64;
const PLAYER_SPEED = 2.7, PLAYER_RUN = 4.6;
const CATCH_DIST = 0.6;
const NET_HZ = 30;                  // частота отправки своей позиции
const NET_DT = 1 / NET_HZ;

/* =========================================================
   КАНВАС
   ========================================================= */
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { alpha: false });
canvas.width = VIEW_W; canvas.height = VIEW_H;
const imgData = ctx.createImageData(VIEW_W, VIEW_H);
const buf = new Uint32Array(imgData.data.buffer);
const perpBuf = new Float32Array(VIEW_W);

const mapCanvas = document.getElementById('map');
const mctx = mapCanvas.getContext('2d');

/* =========================================================
   НАСТРОЙКИ
   ========================================================= */
const settings = {
  sensitivity: 2.2, fov: 66, volume: 0.7,
  mouseMode: 'lock',        // 'lock' — pointer lock, 'rdp' — видимый курсор (обзор от центра)
  load() {
    try {
      const s = JSON.parse(localStorage.getItem('maze_settings') || '{}');
      if (s.sensitivity) this.sensitivity = s.sensitivity;
      if (s.fov) this.fov = s.fov;
      if (typeof s.volume === 'number') this.volume = s.volume;
      if (s.mouseMode === 'rdp' || s.mouseMode === 'lock') this.mouseMode = s.mouseMode;
    } catch(e) {}
  },
  save() {
    try {
      localStorage.setItem('maze_settings', JSON.stringify({
        sensitivity: this.sensitivity, fov: this.fov, volume: this.volume,
        mouseMode: this.mouseMode,
      }));
    } catch(e) {}
  }
};
settings.load();

let PLANE = Math.tan((settings.fov * Math.PI / 180) / 2);

/* =========================================================
   ШУМ
   ========================================================= */
function hash2(x, y) {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf*xf*(3-2*xf), v = yf*yf*(3-2*yf);
  const a = hash2(xi, yi), b = hash2(xi+1, yi);
  const c = hash2(xi, yi+1), d = hash2(xi+1, yi+1);
  return a + (b-a)*u + (c-a)*v + (a-b-c+d)*u*v;
}
function fbm(x, y, oct) {
  let val = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    val += amp * vnoise(x*freq, y*freq);
    norm += amp; freq *= 2; amp *= 0.5;
  }
  return val / norm;
}

/* =========================================================
   ТЕКСТУРЫ
   ========================================================= */
function makeTex(fn) {
  const t = new Uint32Array(TS * TS);
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const c = fn(x, y);
    let r = c[0]|0, g = c[1]|0, b = c[2]|0;
    if (r>255) r=255; else if (r<0) r=0;
    if (g>255) g=255; else if (g<0) g=0;
    if (b>255) b=255; else if (b<0) b=0;
    t[y*TS+x] = (255<<24)|(b<<16)|(g<<8)|r;
  }
  return t;
}

const texBrick = makeTex((x,y) => {
  const xs = x / S, ys = y / S;          // координаты в исходном масштабе 64×64
  const bw = 32, bh = 16, m = 2;
  const row = (ys/bh)|0, sh = (row&1)*(bw>>1);
  const bx = (xs+sh)%bw, by = ys%bh;
  // раствор с лёгким затемнением у краёв кирпича
  if (bx<m || by<m) {
    const n = fbm(xs*0.4, ys*0.4, 3);
    const depth = Math.min(bx, by) / m;                 // 0 у кирпича, 1 в середине шва
    const v = (0.40 + n*0.2) * (0.8 + depth*0.25);
    return [138*v, 128*v, 114*v];
  }
  const idx = ((xs+sh)/bw)|0;
  const bid = hash2(idx*29+row*7, row*13+idx);
  const br = 138+bid*60, bg = 56+bid*34, bb = 42+bid*26;
  // тонкие горизонтальные слои глины внутри кирпича
  const strata = Math.sin(by*1.9 + bid*9.3) * 0.05;
  // фаска: свет сверху, тень снизу (свет из «потолка»)
  const bevelTop = Math.max(0, 1 - (by-m)/2.2);
  const bevelBot = Math.max(0, 1 - (bh-1-by-m)/2.2);
  const bevel = 1 + bevelTop*0.16 - bevelBot*0.2;
  const grain = fbm(xs*0.6, ys*0.6, 4);
  const fine = hash2(x*7+1, y*11+5)*0.10;
  const speck = hash2(x*13+2, y*17+3) > 0.965 ? 0.7 : 1;   // тёмные поры
  // высолы — белёсые выцветшие пятна
  const eff = fbm(xs*0.11+9.2, ys*0.11+3.4, 3);
  const effK = eff > 0.68 ? 1 + (eff-0.68)*0.9 : 1;
  // сколы углов: чем ближе к углу кирпича, тем рванее
  const ex = Math.min(bx-m, bw-1-bx), ey = Math.min(by-m, bh-1-by);
  const edge = 0.55 + Math.min(1, Math.min(ex,ey)/5)*0.45;
  const cornerChip = (ex < 1.2 && ey < 1.2 && hash2(idx*3+row, x*5+y) > 0.5) ? 0.7 : 1;
  const crack = fbm(xs*0.18+3.7, ys*0.18+1.3, 2);
  const ck = crack > 0.68 ? 0.62 : 1;
  const v = (0.64 + grain*0.34 + fine + strata) * edge * ck * effK * bevel * speck * cornerChip;
  return [br*v, bg*v, bb*v];
});

const texStone = makeTex((x,y) => {
  const xs = x / S, ys = y / S;
  const bw = 32, bh = 20, m = 2;
  const row = (ys/bh)|0, sh = (row&1)*(bw>>1);
  const bx = (xs+sh)%bw, by = ys%bh;
  if (bx<m || by<m) {
    const n = fbm(xs*0.35, ys*0.35, 3);
    const v = 0.24 + n*0.15;
    return [64*v, 66*v, 72*v];
  }
  const idx = ((xs+sh)/bw)|0;
  const bid = hash2(idx*31+row, row*17+idx*5);
  const baseV = 0.5 + bid*0.32;
  const grain = fbm(xs*0.65, ys*0.65, 4);
  const lumpy = fbm(xs*0.15+2.3, ys*0.15+7.1, 3);
  // следы зубила — редкие диагональные штрихи
  const chis = Math.sin(bx*0.9 + by*1.7 + bid*20) > 0.86 ? 0.88 : 1;
  const ex = Math.min(bx-m, bw-1-bx), ey = Math.min(by-m, bh-1-by);
  const edge = 0.55 + Math.min(1, Math.min(ex,ey)/6)*0.45;
  const bevelTop = Math.max(0, 1 - (by-m)/2.5);
  const bevel = 1 + bevelTop*0.14 - Math.max(0, 1 - (bh-1-by-m)/2.5)*0.18;
  const pit = fbm(xs*0.95+11, ys*0.95+4, 2);
  const pk = pit > 0.78 ? 0.6 : 1;
  // мох и лишайник пятнами
  const moss = fbm(xs*0.09+5.5, ys*0.09+8.8, 3);
  const mossT = moss > 0.62 ? Math.min(0.5, (moss-0.62)*1.6) : 0;
  const v = (0.66 + grain*0.3 + lumpy*0.14) * edge * baseV * pk * chis * bevel;
  let r = 116*v, g = 122*v, b = 138*v;
  if (mossT > 0) {
    r = r*(1-mossT) + 74*mossT;
    g = g*(1-mossT) + 106*mossT;
    b = b*(1-mossT) + 60*mossT;
  }
  return [r, g, b];
});

const texMetal = makeTex((x,y) => {
  const xs = x / S, ys = y / S;
  const pw = 32, ph = 32;
  const bx = xs%pw, by = ys%ph;
  const bIn = 3;
  const isBorder = bx<bIn || by<bIn || bx>=pw-bIn || by>=ph-bIn;
  const rv = [[6,6],[pw-7,6],[6,ph-7],[pw-7,ph-7]];
  for (let i=0;i<4;i++) {
    const dx = bx-rv[i][0], dy = by-rv[i][1];
    const d = Math.sqrt(dx*dx+dy*dy);
    if (d < 2.6) {
      const v = 1.0 + (1-d/2.6)*(1-d/2.6)*0.55;
      return [128*v, 140*v, 158*v];
    }
  }
  const brush = fbm(xs*0.06, ys*2.4, 3);
  const grain = fbm(xs*0.55, ys*0.55, 4);
  const rust = fbm(xs*0.12+5.3, ys*0.12+9.7, 4);
  // потёки ржавчины под заклёпками
  let drip = 0;
  for (let i=0;i<4;i++) {
    if (Math.abs(bx-rv[i][0]) < 2.2 && by > rv[i][1]) {
      const l = (by - rv[i][1]) / 15;
      if (l < 1) drip = Math.max(drip, (1-l) * 0.45);
    }
  }
  const rustAmt = Math.min(1, Math.max(0, rust-0.58)*2.4 + drip);
  const scratch = fbm(xs*0.75+13, ys*0.75+21, 2);
  const sa = scratch>0.8 ? 0.18 : 0;
  let baseV = 0.68 + brush*0.2 + grain*0.16;
  if (isBorder) baseV *= 0.5;
  // грязь и копоть оседают к низу панели
  baseV *= 1 - (by/pw)*0.15;
  // светлая кромка сверху панели
  if (by >= bIn && by < bIn + 1) baseV *= 1.25;
  let r = 92*baseV + sa*90, g = 108*baseV + sa*90, b = 132*baseV + sa*90;
  if (rustAmt > 0) {
    const t = Math.min(1, rustAmt);
    r = r*(1-t) + 168*t; g = g*(1-t) + 80*t; b = b*(1-t) + 38*t;
  }
  return [r, g, b];
});
const WALL_TEX = [texBrick, texStone, texMetal];

/* Дверь зала (клетка 4): дерево с железными полосами и замочной скважиной */
const texDoor = makeTex((x, y) => {
  const xs = x / S, ys = y / S;
  const plank = ys % 16;
  const grain = fbm(xs * 0.5, ys * 0.18, 3);
  const seam = (xs < 1 || xs >= 63) ? 0.4 : (plank < 1 ? 0.55 : 1);
  const v = (0.5 + grain * 0.3) * seam;
  let r = 96 * v, g = 58 * v, b = 30 * v;
  const band = (ys > 12 && ys < 19) || (ys > 44 && ys < 51);
  if (band) {
    const bv = 0.5 + fbm(xs * 0.6, ys * 0.6, 2) * 0.3;
    r = 92 * bv; g = 96 * bv; b = 104 * bv;
  }
  const kx = Math.abs(xs - 32), ky = Math.abs(ys - 31);
  const inCircle = kx * kx + (ys - 28) * (ys - 28) < 20;
  const inSlot = ky > 4 && ky < 15 && kx < 2.5;
  if (inCircle || inSlot) { r = 14; g = 14; b = 14; }
  return [r, g, b];
});

const texFloor = makeTex((x,y) => {
  const xs = x / S, ys = y / S;
  const ts = 32, tx = xs%ts, ty = ys%ts, gap = 1.5;
  if (tx<gap || ty<gap) { const v = 0.2; return [40*v, 36*v, 32*v]; }
  const tid = hash2(((xs/ts)|0)*19+3, ((ys/ts)|0)*23+7);
  const br = 100+tid*46, bg = 92+tid*38, bb = 78+tid*32;
  const grain = fbm(xs*0.7, ys*0.7, 4);
  const stain = fbm(xs*0.13+7.3, ys*0.13+11.9, 3);
  const stainK = 0.7 + stain*0.42;
  const ex = Math.min(tx-gap, ts-1-tx), ey = Math.min(ty-gap, ts-1-ty);
  const edge = 0.62 + Math.min(1, Math.min(ex,ey)/5)*0.38;
  // фаска плитки: свет у верхнего края, тень у нижнего
  const bev = 1 + Math.max(0, 1-(ty-gap)/2.4)*0.1 - Math.max(0, 1-(ts-1-ty-gap)/2.4)*0.13;
  // трещины и потёртости
  const crack = fbm(xs*0.21+4.4, ys*0.21+9.9, 2);
  const ck = crack > 0.74 ? 0.62 : 1;
  const wear = fbm(xs*0.3+1.1, ys*0.3+6.6, 2);
  const wk = wear > 0.72 ? 1.08 : 1;
  const v = (0.68 + grain*0.36) * stainK * edge * bev * ck * wk;
  return [br*v, bg*v, bb*v];
});

const texCeil = makeTex((x,y) => {
  const xs = x / S, ys = y / S;
  const grain = fbm(xs*0.55, ys*0.55, 4);
  const large = fbm(xs*0.1+3.1, ys*0.1+6.5, 3);
  const stain = fbm(xs*0.2+13.7, ys*0.2+17.3, 3);
  let v = 0.44 + grain*0.24 + large*0.18;
  const sa = Math.max(0, stain-0.6)*1.6;
  v *= (1 - sa*0.35);
  let r = 70*v, g = 76*v, b = 90*v;
  const crack = fbm(xs*0.22+5.7, ys*0.22+2.1, 3);
  if (crack>0.72) { r*=0.5; g*=0.5; b*=0.5; }
  return [r, g, b];
});

/* =========================================================
   СПРАЙТЫ
   ========================================================= */
/* Спрайты рисуются в исходных координатах 64×64 и растягиваются трансформацией
   на весь холст SPR_SIZE×SPR_SIZE — при росте SPR_SIZE растёт разрешение
   растеризации кривых и градиентов, а не масштаб картинки. */
const SPR_SIZE = 128;
const SPR_S = SPR_SIZE / 64;

function canvasToTex(c, size) {
  const data = c.getContext('2d').getImageData(0,0,size,size).data;
  const tex = new Uint32Array(size*size);
  for (let i = 0; i < size*size; i++) {
    const r = data[i*4], g = data[i*4+1], b = data[i*4+2], a = data[i*4+3];
    tex[i] = ((a&255)<<24)|((b&255)<<16)|((g&255)<<8)|(r&255);
  }
  return tex;
}

const texGhost = (() => {
  const size = SPR_SIZE;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(SPR_S, SPR_S);
  const glow = g.createRadialGradient(32,32,4,32,32,31);
  glow.addColorStop(0,'rgba(210,240,255,0.55)');
  glow.addColorStop(0.45,'rgba(140,200,245,0.28)');
  glow.addColorStop(1,'rgba(70,130,210,0)');
  g.fillStyle = glow; g.fillRect(0,0,size,size);
  g.save(); g.globalAlpha = 0.9;
  g.beginPath();
  g.moveTo(10,34);
  g.bezierCurveTo(10,5,54,5,54,34);
  g.lineTo(54,50);
  g.bezierCurveTo(50,57,46,45,42,52);
  g.bezierCurveTo(38,59,34,45,30,52);
  g.bezierCurveTo(26,59,22,45,18,52);
  g.bezierCurveTo(14,59,10,45,10,52);
  g.closePath();
  const bodyGrad = g.createLinearGradient(0,5,0,58);
  bodyGrad.addColorStop(0,'#f4faff'); bodyGrad.addColorStop(0.4,'#d4e8fa');
  bodyGrad.addColorStop(0.75,'#a8c8ec'); bodyGrad.addColorStop(1,'#7aa8d8');
  g.fillStyle = bodyGrad; g.fill(); g.restore();
  g.strokeStyle = 'rgba(225,245,255,0.75)'; g.lineWidth = 1.1; g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.beginPath(); g.ellipse(24,19,8,10,-0.3,0,Math.PI*2); g.fill();
  g.fillStyle = '#0d1a28';
  g.beginPath(); g.ellipse(24,27,4.6,6.2,0,0,Math.PI*2); g.fill();
  g.beginPath(); g.ellipse(40,27,4.6,6.2,0,0,Math.PI*2); g.fill();
  g.save();
  g.fillStyle = 'rgba(160,225,255,0.9)';
  g.shadowColor = '#aaeeff'; g.shadowBlur = 6;
  g.beginPath(); g.ellipse(24,27,1.9,2.5,0,0,Math.PI*2); g.fill();
  g.beginPath(); g.ellipse(40,27,1.9,2.5,0,0,Math.PI*2); g.fill();
  g.restore();
  g.fillStyle = 'rgba(15,30,50,0.55)';
  g.beginPath(); g.ellipse(32,39,3.2,2.3,0,0,Math.PI*2); g.fill();
  return canvasToTex(c, size);
})();

/* ---- Спрайт удалённого игрока (гуманоидная фигура, будет тинтоваться) ---- */
const texPlayer = (() => {
  const size = SPR_SIZE;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(SPR_S, SPR_S);

  // Лёгкое свечение вокруг
  const glow = g.createRadialGradient(32, 34, 6, 32, 34, 30);
  glow.addColorStop(0, 'rgba(255,255,255,0.20)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow; g.fillRect(0,0,size,size);

  // Тело — базовая "белая" фигура, цвет задаётся tint'ом
  g.fillStyle = '#ffffff';

  // Голова (капюшон)
  g.beginPath();
  g.moveTo(32, 6);
  g.bezierCurveTo(18, 6, 16, 22, 20, 28);
  g.lineTo(44, 28);
  g.bezierCurveTo(48, 22, 46, 6, 32, 6);
  g.closePath(); g.fill();

  // Плечи и корпус
  g.beginPath();
  g.moveTo(20, 28);
  g.bezierCurveTo(10, 30, 10, 52, 14, 60);
  g.lineTo(50, 60);
  g.bezierCurveTo(54, 52, 54, 30, 44, 28);
  g.closePath(); g.fill();

  // Лёгкая тень по низу — чтобы «стоял на земле»
  const grad = g.createLinearGradient(0, 28, 0, 60);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = grad; g.fillRect(0,0,size,size);
  g.globalCompositeOperation = 'source-over';

  // Контур — он останется тёмным, не затинтуется
  g.strokeStyle = 'rgba(15,20,30,0.9)';
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(32, 6);
  g.bezierCurveTo(18, 6, 16, 22, 20, 28);
  g.bezierCurveTo(10, 30, 10, 52, 14, 60);
  g.lineTo(50, 60);
  g.bezierCurveTo(54, 52, 54, 30, 44, 28);
  g.bezierCurveTo(48, 22, 46, 6, 32, 6);
  g.closePath(); g.stroke();

  // Глаза (тёмные — не затинтуются)
  g.fillStyle = 'rgba(10,15,20,0.95)';
  g.beginPath(); g.arc(27, 17, 1.9, 0, Math.PI*2); g.fill();
  g.beginPath(); g.arc(37, 17, 1.9, 0, Math.PI*2); g.fill();

  return canvasToTex(c, size);
})();

const texSkeleton = (() => {
  const size = SPR_SIZE;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(SPR_S, SPR_S);
  const glow = g.createRadialGradient(32, 32, 2, 32, 32, 24);
  glow.addColorStop(0, 'rgba(220,230,240,0.35)');
  glow.addColorStop(1, 'rgba(120,140,160,0)');
  g.fillStyle = glow; g.fillRect(0, 0, size, size);
  g.save();
  g.shadowColor = 'rgba(200,220,240,0.8)'; g.shadowBlur = 6 * SPR_S;
  g.fillStyle = '#e6ecf2';
  // череп
  g.beginPath(); g.arc(32, 16, 8, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(10,15,20,0.95)';
  g.beginPath(); g.arc(29, 15, 2, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(35, 15, 2, 0, Math.PI * 2); g.fill();
  // позвоночник, рёбра, таз, ноги
  g.fillStyle = '#e6ecf2';
  g.fillRect(30, 24, 4, 18);
  for (let i = 0; i < 3; i++) g.fillRect(22, 27 + i * 5, 20, 2.5);
  g.fillRect(26, 42, 12, 4);
  g.fillRect(27, 46, 3, 12);
  g.fillRect(34, 46, 3, 12);
  g.restore();
  return canvasToTex(c, size);
})();

const texAmmo = (() => {
  const size = SPR_SIZE;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(SPR_S, SPR_S);
  const glow = g.createRadialGradient(32, 32, 2, 32, 32, 26);
  glow.addColorStop(0, 'rgba(255,180,90,0.5)');
  glow.addColorStop(1, 'rgba(160,60,10,0)');
  g.fillStyle = glow; g.fillRect(0, 0, size, size);
  // коробка
  g.fillStyle = '#7a4a20';
  g.fillRect(14, 24, 36, 24);
  g.fillStyle = '#5d3818';
  g.fillRect(14, 24, 36, 6);
  g.fillStyle = '#e8d9b0';
  g.font = 'bold 9px monospace';
  g.textAlign = 'center';
  g.fillText('12k', 32, 42);
  // патроны сверху
  for (let i = 0; i < 4; i++) {
    g.fillStyle = '#c8302a';
    g.fillRect(18 + i * 8, 14, 5, 12);
    g.fillStyle = '#d8b04a';
    g.fillRect(18 + i * 8, 22, 5, 4);
  }
  return canvasToTex(c, size);
})();

const texKey = (() => {
  const size = SPR_SIZE;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(SPR_S, SPR_S);
  const glow = g.createRadialGradient(32,32,2,32,32,28);
  glow.addColorStop(0,'rgba(255,215,90,0.65)');
  glow.addColorStop(1,'rgba(255,180,30,0)');
  g.fillStyle = glow; g.fillRect(0,0,size,size);
  g.save();
  g.shadowColor = '#ffd54a'; g.shadowBlur = 10 * SPR_S;
  g.strokeStyle = '#ffd54a'; g.lineWidth = 4;
  g.beginPath(); g.arc(32, 18, 8, 0, Math.PI*2); g.stroke();
  g.fillStyle = '#ffd54a';
  g.fillRect(30, 26, 4, 22);
  g.fillRect(34, 38, 6, 4);
  g.fillRect(34, 44, 8, 4);
  g.restore();
  g.fillStyle = 'rgba(255,255,255,0.65)';
  g.fillRect(31, 28, 1, 16);
  return canvasToTex(c, size);
})();

const texMedkit = (() => {
  const size = SPR_SIZE;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(SPR_S, SPR_S);
  const glow = g.createRadialGradient(32,32,2,32,32,26);
  glow.addColorStop(0,'rgba(220,80,80,0.5)');
  glow.addColorStop(1,'rgba(160,20,20,0)');
  g.fillStyle = glow; g.fillRect(0,0,size,size);
  g.fillStyle = '#e8e8e8';
  g.fillRect(16, 22, 32, 22);
  g.fillStyle = '#c8c8c8';
  g.fillRect(16, 22, 32, 5);
  g.fillStyle = '#d83838';
  g.fillRect(29, 27, 6, 14);
  g.fillRect(24, 32, 16, 6);
  g.strokeStyle = '#888'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(26, 22); g.lineTo(26, 18);
  g.lineTo(38, 18); g.lineTo(38, 22); g.stroke();
  return canvasToTex(c, size);
})();

const texBattery = (() => {
  const size = SPR_SIZE;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(SPR_S, SPR_S);
  const glow = g.createRadialGradient(32,32,2,32,32,26);
  glow.addColorStop(0,'rgba(140,255,200,0.5)');
  glow.addColorStop(1,'rgba(40,120,80,0)');
  g.fillStyle = glow; g.fillRect(0,0,size,size);
  g.fillStyle = '#1a1a1a';
  g.fillRect(24, 16, 16, 34);
  g.fillStyle = '#7dffb0';
  g.fillRect(24, 16, 16, 8);
  g.fillStyle = '#222';
  g.fillRect(28, 12, 8, 5);
  g.fillStyle = '#7dffb0';
  g.fillRect(28, 30, 8, 14);
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillRect(25, 16, 2, 34);
  return canvasToTex(c, size);
})();

/* =========================================================
   АУДИО
   ========================================================= */
let audioCtx = null;
function initAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){}
  }
}
function playTone(freq, dur, type, vol) {
  if (!audioCtx || settings.volume <= 0) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type || 'sine';
  o.frequency.value = freq;
  g.gain.value = (vol || 0.1) * settings.volume;
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  o.connect(g); g.connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + dur);
}
function playNoise(dur, vol, cutoff) {
  if (!audioCtx || settings.volume <= 0) return;
  const bs = audioCtx.sampleRate * dur;
  const b = audioCtx.createBuffer(1, bs, audioCtx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < bs; i++) d[i] = Math.random()*2 - 1;
  const s = audioCtx.createBufferSource(); s.buffer = b;
  const f = audioCtx.createBiquadFilter(); f.type = 'lowpass';
  f.frequency.value = cutoff || 800;
  const g = audioCtx.createGain();
  g.gain.value = (vol || 0.1) * settings.volume;
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  s.connect(f); f.connect(g); g.connect(audioCtx.destination);
  s.start(); s.stop(audioCtx.currentTime + dur);
}
let heartbeatTimer = 0;
function playHeartbeat(intensity) {
  if (!audioCtx || settings.volume <= 0) return;
  const now = audioCtx.currentTime;
  const o1 = audioCtx.createOscillator();
  const g1 = audioCtx.createGain();
  o1.type = 'sine'; o1.frequency.value = 55;
  g1.gain.setValueAtTime(0.0001, now);
  g1.gain.linearRampToValueAtTime(0.25*intensity*settings.volume, now + 0.02);
  g1.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  o1.connect(g1); g1.connect(audioCtx.destination);
  o1.start(); o1.stop(now + 0.2);
  const o2 = audioCtx.createOscillator();
  const g2 = audioCtx.createGain();
  o2.type = 'sine'; o2.frequency.value = 48;
  g2.gain.setValueAtTime(0.0001, now + 0.22);
  g2.gain.linearRampToValueAtTime(0.2*intensity*settings.volume, now + 0.24);
  g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
  o2.connect(g2); g2.connect(audioCtx.destination);
  o2.start(); o2.stop(now + 0.45);
}
function playKeySound() {
  playTone(880, 0.15, 'triangle', 0.15);
  setTimeout(() => playTone(1320, 0.25, 'triangle', 0.12), 80);
}
function playPickupSound() {
  playTone(660, 0.1, 'square', 0.08);
  setTimeout(() => playTone(990, 0.15, 'square', 0.06), 60);
}
function playHitSound() {
  playNoise(0.35, 0.35, 400);
  playTone(90, 0.3, 'sawtooth', 0.15);
}
function playWhisper() { playNoise(0.9, 0.05, 500); }
function playFootstep() { playNoise(0.06, 0.05, 350); }
function playJoinSound() {
  playTone(523, 0.12, 'triangle', 0.10);
  setTimeout(() => playTone(784, 0.18, 'triangle', 0.09), 100);
}

/* =========================================================
   СЕТЬ
   ========================================================= */
let ws = null;
let myId = null;
let myName = 'Игрок';
let serverConnected = false;
let netAccum = 0;
/** @type {Map<string, {id:string,name:string,x:number,y:number,dirX:number,dirY:number,color:number,hp:number,score:number}>} */
const remotePlayers = new Map();
/** @type {Map<string, {id:string,x:number,y:number,rx:number,ry:number}>} */
const remoteSkeletons = new Map();

function connectToServer(name) {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${proto}//${location.host}`;
    try {
      ws = new WebSocket(url);
    } catch (e) { reject(e); return; }

    const timeout = setTimeout(() => {
      try { ws.close(); } catch(e){}
      reject(new Error('Таймаут подключения'));
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', name }));
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch(e) { return; }
      if (!m || typeof m !== 'object') return;

      switch (m.type) {
        case 'init': {
          clearTimeout(timeout);
          myId = m.id;
          myName = m.name;
          applyServerMap(m);
          serverConnected = true;
          // Заполняем карту удалённых игроков (кроме себя)
          remotePlayers.clear();
          for (const p of (m.players || [])) {
            if (p.id === myId) continue;
            p.rx = p.x; p.ry = p.y;
            remotePlayers.set(p.id, p);
          }
          remoteSkeletons.clear();
          for (const s of (m.skeletons || [])) {
            s.rx = s.x; s.ry = s.y;
            remoteSkeletons.set(s.id, s);
          }
          updatePlayersHud();
          playJoinSound();
          resolve(m);
          break;
        }
        case 'state': {
          if (!Array.isArray(m.players)) break;
          for (const p of m.players) {
            if (p.id === myId) continue;
            // Переносим сглаженную позицию на новый объект: рендер тянет
            // rx/ry к целевой x/y, чтобы спрайты не прыгали между снапшотами
            const old = remotePlayers.get(p.id);
            p.rx = old ? old.rx : p.x;
            p.ry = old ? old.ry : p.y;
            remotePlayers.set(p.id, p);
          }
          // Чистим тех, кого больше нет
          const seen = new Set(m.players.map(p => p.id));
          for (const id of [...remotePlayers.keys()]) {
            if (!seen.has(id)) remotePlayers.delete(id);
          }
          if (Array.isArray(m.skeletons)) {
            const seenS = new Set();
            for (const s of m.skeletons) {
              seenS.add(s.id);
              const oldS = remoteSkeletons.get(s.id);
              s.rx = oldS ? oldS.rx : s.x;
              s.ry = oldS ? oldS.ry : s.y;
              remoteSkeletons.set(s.id, s);
            }
            for (const id of [...remoteSkeletons.keys()]) {
              if (!seenS.has(id)) remoteSkeletons.delete(id);
            }
          }
          updatePlayersHud();
          break;
        }
        case 'playerJoined':
          if (m.player && m.player.id !== myId) {
            m.player.rx = m.player.x;
            m.player.ry = m.player.y;
            remotePlayers.set(m.player.id, m.player);
            updatePlayersHud();
            playTone(660, 0.12, 'triangle', 0.06);
          }
          break;
        case 'playerLeft':
          remotePlayers.delete(m.id);
          updatePlayersHud();
          break;
        case 'newMap': {
          // Сервер перегенерировал общую карту и расселил всех заново
          if (!m.map || !Array.isArray(m.players)) break;
          const wasOverlay = document.getElementById('overlay').classList.contains('show');
          const me = m.players.find(pp => pp.id === myId);
          applyServerMap({ map: m.map, spawn: me ? { x: me.x, y: me.y } : null });
          remotePlayers.clear();
          for (const pp of m.players) {
            if (pp.id === myId) continue;
            pp.rx = pp.x; pp.ry = pp.y;
            remotePlayers.set(pp.id, pp);
          }
          remoteSkeletons.clear();
          for (const s of (m.skeletons || [])) {
            s.rx = s.x; s.ry = s.y;
            remoteSkeletons.set(s.id, s);
          }
          // Свой счёт сервер сбросил на 0
          if (me) state.score = me.score || 0;
          updatePlayersHud();
          // Кто сидел в паузе/меню — остаётся там, мир обновится за оверлеем
          if (!wasOverlay) {
            hideOverlay();
            running = true;
          }
          showMessage('НОВАЯ КАРТА');
          break;
        }
        case 'gameEnd': {
          // Кто-то открыл дверь зала — раунд окончен для всех
          if (grid) grid[doorY * MAPW + doorX] = 0;   // дверь открыта
          won = true;
          running = false;
          if (document.pointerLockElement) document.exitPointerLock();
          const iAmWinner = m.winnerId === myId;
          if (iAmWinner) saveRecord(state.diff, state.score);
          showOverlay(
            iAmWinner ? 'ДВЕРЬ ОТКРЫТА!' : 'ИГРА ОКОНЧЕНА',
            '<b style="color:#ffd54a">' + escapeHtml(m.winner || 'Игрок') + '</b>' +
            ' собрал 5 ключей и открыл дверь зала в центре.<br>' +
            'Очки победителя: <b style="color:#ffd54a">' + (m.score || 0) + '</b>',
            'НОВЫЙ ЗАБЕГ', 'new', 'ghost',
            iAmWinner ? state.score : undefined);
          break;
        }
        case 'chat':
          addChatLine(m.name, m.text);
          break;
        case 'error':
          clearTimeout(timeout);
          reject(new Error(m.message || 'Ошибка сервера'));
          break;
        case 'pong':
          break;
      }
    };

    ws.onerror = () => { clearTimeout(timeout); reject(new Error('Ошибка WebSocket')); };
    ws.onclose = () => {
      serverConnected = false;
      if (running && !won && !dead) {
        running = false;
        showOverlay('СВЯЗЬ ПОТЕРЯНА',
          'Соединение с сервером разорвано.<br>Перезагрузите страницу, чтобы войти заново.',
          'ПЕРЕЗАГРУЗИТЬ', 'reload', 'danger');
      }
    };
  });
}

function sendMove() {
  if (!ws || ws.readyState !== 1 || !serverConnected) return;
  ws.send(JSON.stringify({
    type: 'move',
    x: +posX.toFixed(3),
    y: +posY.toFixed(3),
    dirX: +dirX.toFixed(3),
    dirY: +dirY.toFixed(3),
  }));
}

function sendChat(text) {
  if (!ws || ws.readyState !== 1) return;
  text = String(text || '').slice(0, 120);
  if (!text) return;
  ws.send(JSON.stringify({ type: 'chat', text }));
}

/* =========================================================
   СЛЕДЫ ОТ ВЫСТРЕЛОВ на стенах: привязаны к конкретной грани клетки.
   Ключ грани: сторона + линия пересечения + номер клетки вдоль неё.
   ========================================================= */
const DECAL_R = 0.09;              // радиус следа в долях клетки
const wallDecals = [];             // {key, u} — всего не больше 60
const decalMap = new Map();        // key -> [u, ...] (макс. 3 на грань)

function addDecal(key, u) {
  let arr = decalMap.get(key);
  if (!arr) { arr = []; decalMap.set(key, arr); }
  if (arr.length >= 3) arr.shift();
  arr.push(u);
  wallDecals.push({ key, u });
  if (wallDecals.length > 60) {
    const old = wallDecals.shift();
    const a = decalMap.get(old.key);
    if (a) {
      const i = a.indexOf(old.u);
      if (i >= 0) a.splice(i, 1);
    }
  }
}

/* Луч пули: идём по DDA, как рендер, до первой стены — туда «прилипает» след */
function castBulletDecal() {
  let mapX = Math.floor(posX), mapY = Math.floor(posY);
  const deltaX = dirX === 0 ? 1e30 : Math.abs(1/dirX);
  const deltaY = dirY === 0 ? 1e30 : Math.abs(1/dirY);
  let stepX, stepY, sideDistX, sideDistY;
  if (dirX < 0) { stepX = -1; sideDistX = (posX-mapX)*deltaX; }
  else { stepX = 1; sideDistX = (mapX+1-posX)*deltaX; }
  if (dirY < 0) { stepY = -1; sideDistY = (posY-mapY)*deltaY; }
  else { stepY = 1; sideDistY = (mapY+1-posY)*deltaY; }
  let side = 0;
  for (let it = 0; it < 128; it++) {
    if (sideDistX < sideDistY) { sideDistX += deltaX; mapX += stepX; side = 0; }
    else { sideDistY += deltaY; mapY += stepY; side = 1; }
    if (mapX < 0 || mapY < 0 || mapX >= MAPW || mapY >= MAPH) return;
    if (grid[mapY*MAPW + mapX] > 0) {
      const perp = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
      let u = side === 0 ? posY + perp*dirY : posX + perp*dirX;
      u -= Math.floor(u);
      const key = side === 0
        ? `0:${stepX > 0 ? mapX : mapX + 1}:${mapY}`
        : `1:${mapX}:${stepY > 0 ? mapY : mapY + 1}`;
      addDecal(key, u);
      return;
    }
  }
}

/* =========================================================
   ЛАБИРИНТ (получаем с сервера)
   ========================================================= */
let grid = null, MAPW = 0, MAPH = 0;
let doorX = 0, doorY = 0;           // дверь зала в центре
let serverItems = [];               // общие позиции предметов (с сервера)
let explored = null;
let visited = null;                 // клетки, где игрок уже стоял (след памяти)
let fogCanvas = null;
let serverSpawn = { x: 1.5, y: 1.5 };

function applyServerMap(init) {
  if (!init || !init.map) return;
  MAPW = init.map.w | 0;
  MAPH = init.map.h | 0;
  grid = new Uint8Array(init.map.cells);
  doorX = init.map.door ? init.map.door.x : (MAPW >> 1);
  doorY = init.map.door ? init.map.door.y : (MAPH >> 1);
  serverItems = Array.isArray(init.map.items) ? init.map.items : [];
  explored = new Uint8Array(MAPW * MAPH);
  visited = new Uint8Array(MAPW * MAPH);
  mapCanvas.width = MAPW * 11;
  mapCanvas.height = MAPH * 11;
  buildFogCanvas();
  serverSpawn = init.spawn || { x: 1.5, y: 1.5 };
  resetLocal();
}

/* =========================================================
   ТУМАН ВОЙНЫ (пре-рендер фона)
   ========================================================= */
function buildFogCanvas() {
  const W = MAPW * 11, H = MAPH * 11;
  fogCanvas = document.createElement('canvas');
  fogCanvas.width = W; fogCanvas.height = H;
  const fg = fogCanvas.getContext('2d');

  fg.fillStyle = '#141b28';
  fg.fillRect(0, 0, W, H);

  for (let i = 0; i < 60; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 15 + Math.random() * 40;
    const a = 0.10 + Math.random() * 0.22;
    const isDark = Math.random() < 0.5;
    const grad = fg.createRadialGradient(x, y, 0, x, y, r);
    if (isDark) {
      grad.addColorStop(0, `rgba(8,12,20,${a})`);
      grad.addColorStop(1, 'rgba(8,12,20,0)');
    } else {
      grad.addColorStop(0, `rgba(50,68,92,${a})`);
      grad.addColorStop(1, 'rgba(50,68,92,0)');
    }
    fg.fillStyle = grad;
    fg.beginPath(); fg.arc(x, y, r, 0, Math.PI*2); fg.fill();
  }

  for (let i = 0; i < W * H / 30; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 0.4 + Math.random() * 1.6;
    const a = Math.random() * 0.18;
    fg.fillStyle = `rgba(140,165,195,${a})`;
    fg.beginPath(); fg.arc(x, y, r, 0, Math.PI*2); fg.fill();
  }
}

/* =========================================================
   ПРЕДМЕТЫ: общие позиции с сервера, собирает каждый игрок свой
   экземпляр. Батарейки, патроны и аптечки появляются снова через
   30 с на том же месте; ключи (5 шт.) — без респавна.
   ========================================================= */
let items = [];
let totalKeys = 5;

let doorOpening = false;      // защита от повторной отправки win
let pendingExplore = 0;       // новые клетки с прошлого батча
let exploreAccum = 0;
let attackCooldown = 0;
const ATTACK_COOLDOWN = 0.5;  // перезарядка дробовика, 0.5 с
const SHOT_HITS_TO_KILL = 2;  // выстрелов на скелета (считает сервер)
const SHOT_RANGE = 7.2;       // дальность поражения, клеток
const AMMO_MAX = 30;          // максимум патронов в запасе (приз даёт +30)
let shotRecoil = 0;           // отдача 1 → 0
const SHOT_RECOIL_T = 0.25;   // длительность отдачи, с
let shotFlash = 0;            // вспышка у дула, с

function addScore(n) { state.score += n; }

function sendScoreMsg(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function buildItems() {
  items = serverItems.map(it => ({
    x: it.x, y: it.y, type: it.type,
    tex: it.type === 'key' ? texKey :
         it.type === 'battery' ? texBattery :
         it.type === 'ammo' ? texAmmo : texMedkit,
    taken: false,
    respawnAt: 0,
  }));
}

/* =========================================================
   СОСТОЯНИЕ
   ========================================================= */
let posX = 1.5, posY = 1.5;
let dirX = 1, dirY = 0;
let planeX = 0, planeY = PLANE;
let running = false, won = false, dead = false, locked = false;
let bobPhase = 0, bobAmount = 0;
let stepSoundAccum = 0;

const state = {
  diff: 'normal',
  health: 100,
  battery: 100,
  ammo: 30,                 // запас дробовика, максимум 30
  keysFound: 0,
  score: 0,
  flashlightOn: true,
  invuln: 0,
  elapsed: 0,
  message: '',
  messageTimer: 0
};

let ghostX = 0, ghostY = 0;
let ghostTX = null, ghostTY = null;
let ghostState = 'patrol';
let ghostLastSeenX = 0, ghostLastSeenY = 0;
let ghostLostTimer = 0;
let ghostBobPhase = 0;
let ghostWhisperTimer = 0;

// Скорость привидения равна скорости скелета (SKELETON_SPEED на сервере)
const GHOST_SPEED = 1.9;

const DIFFS = {
  easy:   { speed: 0.35, dmg: 22, vision: 5,  loseTime: 3.5 },
  normal: { speed: 0.5,  dmg: 40, vision: 8,  loseTime: 2.5 },
  hard:   { speed: 0.65, dmg: 60, vision: 13, loseTime: 1.5 }
};
function diff() { return DIFFS[state.diff]; }

/* =========================================================
   ПОИСК ПУТИ (BFS)
   ========================================================= */
const bdx = [1,-1,0,0], bdy = [0,0,1,-1];

function bfsNextStep(fx, fy, tx, ty) {
  const W = MAPW, H = MAPH;
  const sx = Math.floor(fx), sy = Math.floor(fy);
  const gx = Math.floor(tx), gy = Math.floor(ty);
  if (sx===gx && sy===gy) return null;
  if (gx<0 || gy<0 || gx>=W || gy>=H) return null;
  if (grid[gy*W+gx] !== 0) return null;
  const start = sy*W+sx, goal = gy*W+gx;
  const prev = new Int32Array(W*H).fill(-2);
  prev[start] = -1;
  const queue = [start];
  let head = 0, found = false;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === goal) { found = true; break; }
    const cx = cur%W, cy = (cur/W)|0;
    for (let i = 0; i < 4; i++) {
      const nx = cx+bdx[i], ny = cy+bdy[i];
      if (nx<0 || ny<0 || nx>=W || ny>=H) continue;
      const ni = ny*W+nx;
      if (prev[ni] !== -2) continue;
      if (grid[ni] !== 0) continue;
      prev[ni] = cur; queue.push(ni);
    }
  }
  if (!found) return null;
  let cur = goal;
  while (prev[cur] !== start) { cur = prev[cur]; if (cur < 0) return null; }
  return [cur%W + 0.5, ((cur/W)|0) + 0.5];
}

function bfsFarthest(sx, sy) {
  const W = MAPW, H = MAPH;
  const start = Math.floor(sy)*W + Math.floor(sx);
  const dist = new Int32Array(W*H).fill(-1);
  dist[start] = 0;
  const q = [start];
  let head = 0, farthest = start, maxD = 0;
  while (head < q.length) {
    const cur = q[head++];
    const cx = cur%W, cy = (cur/W)|0;
    if (dist[cur] > maxD) { maxD = dist[cur]; farthest = cur; }
    for (let i = 0; i < 4; i++) {
      const nx = cx+bdx[i], ny = cy+bdy[i];
      if (nx<0 || ny<0 || nx>=W || ny>=H) continue;
      const ni = ny*W+nx;
      if (dist[ni] !== -1) continue;
      if (grid[ni] !== 0) continue;
      dist[ni] = dist[cur]+1; q.push(ni);
    }
  }
  return [farthest%W + 0.5, ((farthest/W)|0) + 0.5];
}

/* =========================================================
   ЛОКАЛЬНАЯ ИНИЦИАЛИЗАЦИЯ (после получения карты)
   ========================================================= */
/* keepProgress=true — возрождение после смерти: ключи, счёт и уже
   подобранные предметы сохраняются; keepProgress=false — новый забег. */
function resetLocal(keepProgress) {
  if (!grid) return;
  // Спавн — выдал сервер
  posX = serverSpawn.x;
  posY = serverSpawn.y;
  dirX = 1; dirY = 0;
  planeX = 0; planeY = PLANE;
  bobPhase = 0; bobAmount = 0;
  won = false; dead = false;

  state.health = 100;
  state.battery = 100;
  state.ammo = AMMO_MAX;
  if (!keepProgress) {
    state.keysFound = 0;
    state.score = 0;
  }
  state.flashlightOn = true;
  state.invuln = 0;
  state.elapsed = 0;
  state.message = ''; state.messageTimer = 0;

  doorOpening = false;
  if (!keepProgress) {
    // При возрождении мир остаётся как есть: подобранные ключи
    // не возвращаются на карту, таймеры респавна предметов продолжают идти
    pendingExplore = 0;
    wallDecals.length = 0;
    decalMap.clear();
    if (visited) visited.fill(0);   // след памяти — только для текущего забега
    buildItems();
  }

  const sp = bfsFarthest(posX, posY);
  ghostX = sp[0]; ghostY = sp[1];
  ghostTX = null; ghostTY = null;
  ghostState = 'patrol';
  ghostBobPhase = 0;
  ghostLostTimer = 0;
  ghostWhisperTimer = 0;

  updateKeysHud();
  running = false;
}

/* =========================================================
   ВВОД
   ========================================================= */
const keys = new Set();

function pauseGame() {
  if (!running || won || dead) return;
  running = false;
  showOverlay('ПАУЗА', 'Нажмите «Продолжить», чтобы вернуться.', 'ПРОДОЛЖИТЬ', 'resume', false);
}

window.addEventListener('keydown', (e) => {
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'KeyF' && running) toggleFlashlight();
  if (e.code === 'Space' && running) attack();
  if (e.code === 'Enter' && running) {
    const text = prompt('Сообщение:');
    if (text) sendChat(text);
  }
  // В режиме захвата Esc сначала выходит из pointer lock (пауза по
  // pointerlockchange), в курсорном режиме паузим напрямую
  if (e.code === 'Escape' && settings.mouseMode === 'rdp') pauseGame();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
let rmbHeld = false;                  // ПКМ зажата — бежим
window.addEventListener('blur', () => {
  keys.clear();
  rmbHeld = false;
  // В курсорном режиме нет потери pointer lock — паузим по уходу со страницы
  if (settings.mouseMode === 'rdp') pauseGame();
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) { rmbHeld = true; return; }   // ПКМ — бег, пока зажата
  if (!running || won || dead) return;
  // Первый клик в режиме захвата только захватывает курсор;
  // дальше ЛКМ (или пробел) — выстрел
  if (settings.mouseMode === 'lock' && !locked) { lockPointer(); return; }
  attack();
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 2) rmbHeld = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('pointerlockchange', () => {
  locked = (document.pointerLockElement === canvas);
  mouseTel.lockChanges++;
  if (!locked && running && !won && !dead) {
    running = false;
    showOverlay('ПАУЗА', 'Нажмите «Продолжить», чтобы вернуться.', 'ПРОДОЛЖИТЬ', 'resume', false);
  }
});

/* Курсорный режим захват не использует — если lock остался от другого
   режима, снимаем его */
document.addEventListener('pointerlockchange', () => {
  if (settings.mouseMode === 'rdp' && document.pointerLockElement) {
    try { document.exitPointerLock(); } catch (e) {}
  }
});

/* =========================================================
   МЫШЬ (два режима: pointer lock и курсорный — для RDP)
   ========================================================= */
let mouseAccumX = 0;           // накопленная дельта за кадр (режим захвата)
let mouseAccumY = 0;
let mouseBigJumps = 0;         // диагностика: сколько раз прилетели гигантские дельты
let rdpDetected = false;       // грубая эвристика «мы работаем по RDP»

/* Курсорный режим (settings.mouseMode === 'rdp'): без pointer lock.
   Взгляд поворачивается со скоростью, пропорциональной смещению
   видимого курсора от центра экрана. RDP надёжно работает с абсолютным
   позиционированием и ненадёжно — с относительными дельтами movementX,
   которые там то гигантские (700+ px), то нулевые при живом потоке событий. */
let rdpMouseX = null, rdpMouseY = null;  // clientX/Y последнего события
let rdpTurnRate = 0;                     // сглаженная скорость поворота, рад/с
const RDP_MAX_RATE  = 4.2;    // рад/с при курсоре на краю экрана (~240°/с: разворот ~0.75 с)
const RDP_DEADZONE  = 0.06;   // доля полуширины экрана — мёртвая зона в центре
const RDP_SMOOTH    = 12;     // скорость сглаживания, 1/с
/* Обычный режим: дельта мыши применяется 1:1, без потолка угловой скорости —
   одно движение мыши даёт ровно свой поворот, поэтому разворот срабатывает
   сразу. В курсорном режиме скорость задаёт смещение курсора от центра. */
const MOUSE_SCALE = 0.0014;   // рад на px с учётом чувствительности (+40 % к прежнему)

document.addEventListener('mousemove', (e) => {
  // Курсорный режим: просто следим за положением курсора
  if (settings.mouseMode === 'rdp') {
    rdpMouseX = e.clientX;
    rdpMouseY = e.clientY;
    mouseTel.events++;
    mouseTel.lastEventAt = performance.now();
    return;
  }

  if (!locked) return;

  let mx = e.movementX;
  let my = e.movementY;

  // ТЕЛЕМЕТРИЯ: сырые дельты до всяких отсечек
  mouseTel.events++;
  mouseTel.sumAbs += Math.abs(mx);
  if (Math.abs(mx) > mouseTel.maxAbs) mouseTel.maxAbs = Math.abs(mx);
  if (Math.abs(mx) > 200) mouseTel.bigEvents++;
  mouseTel.lastEventAt = performance.now();

  // Некоторые RDP-клиенты/старые драйверы возвращают undefined/NaN
  if (typeof mx !== 'number' || !Number.isFinite(mx)) mx = 0;
  if (typeof my !== 'number' || !Number.isFinite(my)) my = 0;

  // Диагностика «мусорных» дельт (для бейджа телеметрии и подсказки)
  if (Math.abs(mx) > 200 || Math.abs(my) > 200) {
    mouseBigJumps++;
    if (mouseBigJumps > 5 && !rdpDetected) {
      rdpDetected = true;
      console.warn('[maze] Обнаружены большие дельты мыши — похоже на RDP. ' +
        'Совет: включите «Режим мыши: КУРСОР» в настройках');
      showMessage('Рывки мыши? Esc → включите «Режим мыши: КУРСОР»');
    }
  }

  mouseAccumX += mx;
  mouseAccumY += my;
});

/* Захват курсора. unadjustedMovement отключает ускорение ОС — заметно
   на RDP/высоких DPI; если браузер опцию не поддерживает, тихо повторяем
   без неё, чтобы захват не ломался совсем. В курсорном режиме не нужен.
   Оба отказа (синхронный и промисный) глотаем — без жеста пользователя
   или в неподходящий момент браузер отклоняет захват, и это норма. */
function lockPointer() {
  if (settings.mouseMode === 'rdp') return;
  const attempt = (opts) => {
    try {
      const p = opts === undefined
        ? canvas.requestPointerLock()
        : canvas.requestPointerLock(opts);
      return p && typeof p.then === 'function' ? p : Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  };
  // Сначала с unadjustedMovement; отказ (не поддерживается/нет жеста/
  // неподходящий момент) — тихо повторяем без опции
  attempt({ unadjustedMovement: true }).catch(() => attempt(undefined));
}

/* =========================================================
   СЧЁТЧИКИ МЫШИ (диагностика RDP, только в консоли: window.__mouseTel)
   ========================================================= */
const mouseTel = {
  events: 0,        // mousemove за окно
  sumAbs: 0,        // сумма |movementX| за окно (сырые)
  maxAbs: 0,        // максимальная |movementX| за окно
  bigEvents: 0,     // событий с |movementX| > 200
  degApplied: 0,    // градусов, реально применённых к обзору
  lockChanges: 0,   // переподключений/потерь захвата за окно
  lastEventAt: 0,   // performance.now() последнего события
  windowStart: performance.now(),
};
// Для ручного осмотра в консоли: window.__mouseTel
window.__mouseTel = mouseTel;

function toggleFlashlight() {
  state.flashlightOn = !state.flashlightOn;
  playTone(state.flashlightOn ? 800 : 400, 0.05, 'square', 0.05);
}

/* =========================================================
   МАТЕМАТИКА
   ========================================================= */
function rotate(a) {
  const c = Math.cos(a), s = Math.sin(a);
  const ox = dirX;
  dirX = dirX*c - dirY*s; dirY = ox*s + dirY*c;
  const opx = planeX;
  planeX = planeX*c - planeY*s; planeY = opx*s + planeY*c;
}
function isWall(x, y) {
  const mx = Math.floor(x), my = Math.floor(y);
  if (mx<0 || my<0 || mx>=MAPW || my>=MAPH) return true;
  return grid[my*MAPW+mx] > 0;
}
function canWalk(x, y) {
  const r = 0.22;
  return !isWall(x-r,y-r) && !isWall(x+r,y-r) && !isWall(x-r,y+r) && !isWall(x+r,y+r);
}
function hasLOS(x1, y1, x2, y2) {
  const dx = x2-x1, dy = y2-y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.01) return true;
  const steps = Math.ceil(dist * 8);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWall(x1 + dx*t, y1 + dy*t)) return false;
  }
  return true;
}

/* =========================================================
   ОБНОВЛЕНИЕ
   ========================================================= */
function update(dt) {
  state.elapsed += dt;
  if (state.invuln > 0) state.invuln -= dt;
  if (state.messageTimer > 0) state.messageTimer -= dt;

  const run = rmbHeld;
  const moveSpeed = (run ? PLAYER_RUN : PLAYER_SPEED) * dt;
  const rotSpeed = 2.3 * dt;

  let fwd = 0, str = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
  if (keys.has('KeyA')) str -= 1;
  if (keys.has('KeyD')) str += 1;
  if (keys.has('ArrowLeft')) rotate(-rotSpeed);
  if (keys.has('ArrowRight')) rotate(rotSpeed);

  // Поворот мышью
  if (settings.mouseMode === 'rdp') {
    // Курсорный режим: скорость от смещения курсора от центра, со сглаживанием
    if (rdpMouseX !== null) {
      const rect = canvas.getBoundingClientRect();
      const halfW = Math.max(1, rect.width / 2);
      let nx = (rdpMouseX - (rect.left + halfW)) / halfW;
      nx = Math.max(-1, Math.min(1, nx));
      const dz = RDP_DEADZONE;
      const mag = Math.abs(nx) < dz ? 0 : (nx - Math.sign(nx) * dz) / (1 - dz);
      const target = mag * RDP_MAX_RATE;
      rdpTurnRate += (target - rdpTurnRate) * Math.min(1, dt * RDP_SMOOTH);
      const rotRad = rdpTurnRate * dt;
      if (rotRad !== 0) {
        rotate(rotRad);
        mouseTel.degApplied += Math.abs(rotRad) * 180 / Math.PI;
      }
    }
  } else if (mouseAccumX !== 0) {
    // Режим захвата: дельта мыши применяется целиком (1:1). Потолок угловой
    // скорости убран — он резал быстрые движения: разворот в тупике отдавал
    // лишь часть поворота, и его приходилось «докручивать» несколькими
    // движениями мыши. Медленные движения как и раньше идут точно.
    const scale = settings.sensitivity * MOUSE_SCALE;
    const rotRad = mouseAccumX * scale;
    rotate(rotRad);
    mouseTel.degApplied += Math.abs(rotRad) * 180 / Math.PI;
    mouseAccumX = 0;
    mouseAccumY = 0;
  }

  let moved = false;
  if (fwd !== 0 || str !== 0) {
    const len = Math.hypot(fwd, str);
    fwd /= len; str /= len;
    const nx = posX + dirX*fwd*moveSpeed + (-dirY)*str*moveSpeed;
    const ny = posY + dirY*fwd*moveSpeed + ( dirX)*str*moveSpeed;
    if (canWalk(nx, posY)) { posX = nx; moved = true; }
    if (canWalk(posX, ny)) { posY = ny; moved = true; }
  }

  if (moved) {
    bobPhase += dt * (run ? 15 : 10);
    bobAmount += (1-bobAmount) * Math.min(1, dt*9);
    stepSoundAccum += dt;
    if (stepSoundAccum > (run ? 0.32 : 0.5)) {
      stepSoundAccum = 0;
      playFootstep();
    }
  } else {
    bobAmount += (0-bobAmount) * Math.min(1, dt*9);
  }

  if (state.flashlightOn && state.battery > 0) {
    // Полный заряд — 150 с (на 40 % медленнее прежних 90 с)
    state.battery = Math.max(0, state.battery - dt * (100/150));
    if (state.battery <= 0) state.flashlightOn = false;
  }

  collectItems();
  updateGhost(dt);
  if (attackCooldown > 0) attackCooldown -= dt;
  if (shotRecoil > 0) shotRecoil = Math.max(0, shotRecoil - dt / SHOT_RECOIL_T);
  if (shotFlash > 0) shotFlash -= dt;

  // Дверь зала в центре: с 5 ключами открываем — победа для всех
  const ddx = posX - (doorX + 0.5), ddy = posY - (doorY + 0.5);
  if (!won && !dead && ddx*ddx + ddy*ddy < 0.75) {
    if (state.keysFound >= totalKeys) tryOpenDoor();
    else if (state.messageTimer <= 0) {
      state.message = 'ДВЕРЬ ЗАПЕРТА. НУЖНО ' + totalKeys + ' КЛЮЧЕЙ (' + state.keysFound + '/' + totalKeys + ')';
      state.messageTimer = 2.5;
    }
  }

  // Скелеты: урон при контакте
  updateSkeletonContact();

  // След памяти: отмечаем клетку, где игрок стоит сейчас, — потолок в ней
  // будет светлее, когда игрок вернётся сюда (или увидит её из коридора)
  if (visited) visited[(posY | 0) * MAPW + (posX | 0)] = 1;

  // Очки за исследование батчами раз в 2 с
  exploreAccum += dt;
  if (exploreAccum >= 2 && pendingExplore > 0) {
    exploreAccum = 0;
    sendScoreMsg({ type: 'explore', n: pendingExplore });
    pendingExplore = 0;
  }

  // Отправка позиции на сервер с частотой NET_HZ
  netAccum += dt;
  if (netAccum >= NET_DT) {
    netAccum = 0;
    sendMove();
  }
}

/* =========================================================
   СБОР ПРЕДМЕТОВ
   ========================================================= */
function collectItems() {
  const now = Date.now();
  for (const it of items) {
    if (it.taken || it.respawnAt > now) continue;
    const dx = it.x - posX, dy = it.y - posY;
    if (dx*dx + dy*dy >= 0.4) continue;

    if (it.type === 'key') {
      it.taken = true;
      state.keysFound++;
      addScore(250);
      sendScoreMsg({ type: 'key' });
      playKeySound();
      showMessage('КЛЮЧ НАЙДЕН (' + state.keysFound + '/' + totalKeys + ')');
      updateKeysHud();
    } else if (it.type === 'medkit') {
      if (state.health >= 100) continue;
      it.respawnAt = now + 30000;   // через 30 с появится на этом же месте
      state.health = Math.min(100, state.health + 30);
      addScore(30);
      sendScoreMsg({ type: 'pickup', kind: 'medkit' });
      playPickupSound();
      showMessage('+30 ЗДОРОВЬЯ');
    } else if (it.type === 'ammo') {
      // Принцип батареек: +30 патронов, через 30 с приз снова на этом месте
      if (state.ammo >= AMMO_MAX) continue;
      it.respawnAt = now + 30000;
      state.ammo = Math.min(AMMO_MAX, state.ammo + 30);
      playPickupSound();
      showMessage('+30 ПАТРОНОВ');
    } else if (it.type === 'battery') {
      if (state.battery >= 50) continue;
      it.respawnAt = now + 30000;   // через 30 с появится на этом же месте
      state.battery = Math.min(100, state.battery + 45);
      addScore(20);
      sendScoreMsg({ type: 'pickup', kind: 'battery' });
      playPickupSound();
      const wasOff = !state.flashlightOn;
      if (wasOff) {
        state.flashlightOn = true;
        showMessage('+45% ЗАРЯДА · ФОНАРИК ВКЛЮЧЁН');
      } else {
        showMessage('+45% ЗАРЯДА');
      }
    }
  }
}

function showMessage(t) { state.message = t; state.messageTimer = 2.2; }

function updateKeysHud() {
  const box = document.getElementById('keysIcons');
  if (!box) return;
  box.innerHTML = '';
  for (let i = 0; i < totalKeys; i++) {
    const d = document.createElement('div');
    d.className = 'keySlot' + (i < state.keysFound ? ' got' : '');
    d.textContent = '⚿';
    box.appendChild(d);
  }
}

/* =========================================================
   ПРИВИДЕНИЕ (локальное для каждого игрока)
   ========================================================= */
function updateGhost(dt) {
  if (won || dead) return;
  const d = diff();
  const pdx = posX - ghostX, pdy = posY - ghostY;
  const pdist = Math.hypot(pdx, pdy);

  let frozen = false;
  if (pdist > 0.01 && pdist < 10) {
    const dot = (pdx*dirX + pdy*dirY) / pdist;
    if (dot > 0.86 && hasLOS(ghostX, ghostY, posX, posY)) frozen = true;
  }

  const canSee = pdist < d.vision && hasLOS(ghostX, ghostY, posX, posY);
  const run = rmbHeld;
  const hearRange = run ? 9 : 4.5;
  const canHear = pdist < hearRange;

  if (canSee || canHear) {
    ghostState = 'chase';
    ghostLastSeenX = posX; ghostLastSeenY = posY;
    ghostLostTimer = 0;
  } else if (ghostState === 'chase') {
    ghostLostTimer += dt;
    if (ghostLostTimer > d.loseTime) {
      ghostState = 'search';
      ghostTX = null; ghostTY = null;
    }
  }

  ghostWhisperTimer -= dt;
  if (ghostWhisperTimer <= 0 && pdist < 12) {
    ghostWhisperTimer = 4 + Math.random() * 6;
    playWhisper();
  }

  heartbeatTimer -= dt;
  if (heartbeatTimer <= 0 && pdist < 12) {
    const inten = Math.max(0, 1 - pdist/12);
    playHeartbeat(inten);
    heartbeatTimer = 1.0 - inten * 0.55;
  }

  let speedMul = frozen ? 0.08 : 1;
  // скорость привидения — как у скелета, без зависимости от сложности
  const speed = GHOST_SPEED * speedMul * dt;
  const target = getGhostTarget();
  if (!target) return;
  const tdx = target[0] - ghostX, tdy = target[1] - ghostY;
  const td = Math.hypot(tdx, tdy);
  if (td > 0.001) {
    const step = Math.min(speed, td);
    const nx = ghostX + (tdx/td) * step;
    const ny = ghostY + (tdy/td) * step;
    if (canWalk(nx, ny)) { ghostX = nx; ghostY = ny; }
    else { ghostTX = null; ghostTY = null; }
  }

  if (pdist < CATCH_DIST && state.invuln <= 0) {
    state.health -= diff().dmg;
    state.invuln = 1.2;
    playHitSound();
    flashDamage();
    if (state.health <= 0) { state.health = 0; die(); }
  }
}

function getGhostTarget() {
  if (ghostTX !== null && ghostTY !== null) {
    const dx = ghostTX - ghostX, dy = ghostTY - ghostY;
    if (dx*dx + dy*dy < 0.0025) { ghostTX = null; ghostTY = null; }
    else return [ghostTX, ghostTY];
  }
  if (ghostState === 'chase') {
    const nxt = bfsNextStep(ghostX, ghostY, posX, posY);
    if (nxt) { ghostTX = nxt[0]; ghostTY = nxt[1]; return [ghostTX, ghostTY]; }
    return [posX, posY];
  }
  if (ghostState === 'search') {
    const nxt = bfsNextStep(ghostX, ghostY, ghostLastSeenX, ghostLastSeenY);
    if (nxt) { ghostTX = nxt[0]; ghostTY = nxt[1]; return [ghostTX, ghostTY]; }
    ghostState = 'patrol';
    return null;
  }
  const rnd = bfsFarthest(ghostX, ghostY);
  const nxt = bfsNextStep(ghostX, ghostY, rnd[0], rnd[1]);
  if (nxt) { ghostTX = nxt[0]; ghostTY = nxt[1]; return [ghostTX, ghostTY]; }
  return null;
}

/* =========================================================
   ЭФФЕКТЫ
   ========================================================= */
function flashDamage() {
  const el = document.getElementById('damage');
  if (!el) return;
  el.style.transition = 'none';
  el.style.opacity = '1';
  requestAnimationFrame(() => {
    el.style.transition = 'opacity .35s';
    el.style.opacity = '0';
  });
}

/* =========================================================
   РЕНДЕР
   ========================================================= */
const FOG_R = 18, FOG_G = 22, FOG_B = 32;
const FOG_NEAR = 3.0, FOG_FAR = 15.0;

function render(nameLabels) {
  if (!grid) {
    // Карты ещё нет — просто чёрный экран
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    return;
  }

  perpBuf.fill(1e30);
  const halfH = VIEW_H >> 1;
  const rdx0 = dirX - planeX, rdy0 = dirY - planeY;
  const rdx1 = dirX + planeX, rdy1 = dirY + planeY;

  const flashOn = state.flashlightOn && state.battery > 0;
  const flashDim = (state.battery < 20 && flashOn) ?
    (Math.random() < 0.15 ? 0.15 : 1) : 1;

  const ambientWall  = flashOn ? 1.0 : 0.08;
  const ambientFloor = flashOn ? 1.0 : 0.06;

  const fogMul = flashOn ? 1.0 : 0.18;
  const fR = FOG_R * fogMul;
  const fG = FOG_G * fogMul;
  const fB = FOG_B * fogMul;

  /* ---------- Пол и потолок ---------- */
  for (let y = halfH + 1; y < VIEW_H; y++) {
    const p = y - halfH;
    const rowDist = halfH / p;
    const stepX = rowDist * (rdx1 - rdx0) / VIEW_W;
    const stepY = rowDist * (rdy1 - rdy0) / VIEW_W;
    let fx = posX + rowDist * rdx0;
    let fy = posY + rowDist * rdy0;

    let s = 1.9 / (1 + rowDist * 0.42);
    if (s > 1) s = 1;

    let lightF = ambientFloor;
    if (flashOn) {
      const distFall = 1 / (1 + rowDist * rowDist * 0.06);
      lightF *= 1 + 0.55 * distFall * flashDim;
    }
    const sF = s * lightF;
    const sC = s * 0.72 * lightF * 0.85;

    const fog = Math.min(1, Math.max(0, (rowDist - FOG_NEAR) / (FOG_FAR - FOG_NEAR)));
    const fogInv = 1 - fog;

    const rowF = y * VIEW_W;
    const rowC = (VIEW_H - 1 - y) * VIEW_W;

    for (let x = 0; x < VIEW_W; x++) {
      const cx = Math.floor(fx), cy = Math.floor(fy);
      const tx = ((fx - cx) * TS) & (TS - 1);
      const ty = ((fy - cy) * TS) & (TS - 1);
      const ti = ty * TS + tx;
      fx += stepX; fy += stepY;

      const fc = texFloor[ti];
      let r = (fc & 255) * sF;
      let g = ((fc >> 8) & 255) * sF;
      let b = ((fc >> 16) & 255) * sF;
      r = r * fogInv + fR * fog;
      g = g * fogInv + fG * fog;
      b = b * fogInv + fB * fog;
      if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
      buf[rowF + x] = 0xFF000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);

      const cc = texCeil[ti];
      // Потолок в клетках, где игрок уже стоял, светлее — подсказка
      // «здесь я был»; множитель + добавка, чтобы подсветка читалась
      // и при выключенном фонарике
      const wasHere = visited && visited[cy * MAPW + cx] === 1;
      const ceilK = wasHere ? sC * 1.45 : sC;
      const ceilAdd = wasHere ? 10 : 0;
      r = (cc & 255) * ceilK + ceilAdd;
      g = ((cc >> 8) & 255) * ceilK + ceilAdd;
      b = ((cc >> 16) & 255) * ceilK + ceilAdd;
      r = r * fogInv + fR * fog;
      g = g * fogInv + fG * fog;
      b = b * fogInv + fB * fog;
      if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
      buf[rowC + x] = 0xFF000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
    }
  }

  /* ---------- Стены (raycasting) ---------- */
  for (let x = 0; x < VIEW_W; x++) {
    const cameraX = 2 * x / VIEW_W - 1;
    const rayDirX = dirX + planeX * cameraX;
    const rayDirY = dirY + planeY * cameraX;
    let mapX = Math.floor(posX), mapY = Math.floor(posY);
    const deltaX = rayDirX === 0 ? 1e30 : Math.abs(1/rayDirX);
    const deltaY = rayDirY === 0 ? 1e30 : Math.abs(1/rayDirY);
    let stepX, stepY, sideDistX, sideDistY;
    if (rayDirX < 0) { stepX = -1; sideDistX = (posX-mapX)*deltaX; }
    else { stepX = 1; sideDistX = (mapX+1-posX)*deltaX; }
    if (rayDirY < 0) { stepY = -1; sideDistY = (posY-mapY)*deltaY; }
    else { stepY = 1; sideDistY = (mapY+1-posY)*deltaY; }
    let side = 0, tile = 0;
    for (let it = 0; it < 256; it++) {
      if (sideDistX < sideDistY) { sideDistX += deltaX; mapX += stepX; side = 0; }
      else { sideDistY += deltaY; mapY += stepY; side = 1; }
      if (mapX<0 || mapY<0 || mapX>=MAPW || mapY>=MAPH) { tile = 2; break; }
      const t = grid[mapY*MAPW + mapX];
      if (t > 0) { tile = t; break; }
    }
    const perp = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
    if (perp <= 0.0001) continue;
    perpBuf[x] = perp;
    const lineHeight = VIEW_H / perp;
    let drawStart = -lineHeight/2 + halfH;
    let drawEnd = lineHeight/2 + halfH;
    let y0 = drawStart|0; if (y0 < 0) y0 = 0;
    let y1 = Math.ceil(drawEnd); if (y1 > VIEW_H) y1 = VIEW_H;
    if (y0 >= y1) continue;
    let wallX = side === 0 ? posY + perp*rayDirY : posX + perp*rayDirX;
    wallX -= Math.floor(wallX);
    let texX = (wallX*TS)|0;
    if (side === 0 && rayDirX > 0) texX = TS - texX - 1;
    if (side === 1 && rayDirY < 0) texX = TS - texX - 1;
    if (texX < 0) texX = 0; else if (texX > TS-1) texX = TS-1;

    // Следы от выстрелов на этой грани стены. Радиус ограничен и в мире,
    // и на экране (~26 px), чтобы вплотную след не раздувался на весь экран.
    let decalHits = null;
    if (decalMap.size) {
      const rEff = Math.min(DECAL_R, 26 / lineHeight);
      const dKey = side === 0
        ? `0:${stepX > 0 ? mapX : mapX + 1}:${mapY}`
        : `1:${mapX}:${stepY > 0 ? mapY : mapY + 1}`;
      const arr = decalMap.get(dKey);
      if (arr) {
        for (let di = 0; di < arr.length; di++) {
          const du = wallX - arr[di];
          if (du > -rEff && du < rEff) (decalHits || (decalHits = [])).push(du);
        }
        if (decalHits) decalHits.rEff = rEff;
      }
    }

    let s = 2.0 / (1 + perp * 0.38);
    if (s > 1) s = 1;
    if (side === 1) s *= 0.72;
    if (s < 0.03) s = 0.03;

    let lightW = ambientWall;
    if (flashOn) {
      const cone = Math.exp(-cameraX * cameraX * 2.4);
      const distFall = 1 / (1 + perp * perp * 0.08);
      lightW *= 1 + 1.3 * cone * distFall * flashDim;
    }
    s *= lightW;

    const fog = Math.min(1, Math.max(0, (perp - FOG_NEAR) / (FOG_FAR - FOG_NEAR)));
    const fogInv = 1 - fog;

    const tex = tile === 4 ? texDoor : WALL_TEX[(tile-1) % WALL_TEX.length];
    const step = TS / lineHeight;
    let texPos = (y0 - halfH + lineHeight/2) * step;

    for (let y = y0; y < y1; y++) {
      const texY = Math.floor(texPos) & (TS-1);
      texPos += step;
      const c = tex[texY*TS + texX];
      let r = (c & 255)*s;
      let g = ((c>>8)&255)*s;
      let b = ((c>>16)&255)*s;
      if (decalHits) {
        // подгоревший круг на стене: темнее к центру
        const rEff = decalHits.rEff;
        const dyw = (y - halfH) / lineHeight;
        for (let di = 0; di < decalHits.length; di++) {
          const du = decalHits[di];
          const dd = du*du + dyw*dyw;
          if (dd < rEff*rEff) {
            const k = dd < rEff*rEff*0.2 ? 0.22 : 0.45;
            r *= k; g *= k; b *= k;
            break;
          }
        }
      }
      r = r*fogInv + fR*fog;
      g = g*fogInv + fG*fog;
      b = b*fogInv + fB*fog;
      if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
      buf[y*VIEW_W + x] = 0xFF000000 | ((b|0)<<16) | ((g|0)<<8) | (r|0);
    }
  }

  /* ---------- Спрайты ---------- */
  renderSprites(nameLabels);

  ctx.putImageData(imgData, 0, 0);

  /* ---------- Лёгкий синий флёр, когда привидение рядом ---------- */
  const dGhost = Math.hypot(posX - ghostX, posY - ghostY);
  if (dGhost < 6) {
    const alpha = (1 - dGhost/6) * 0.35;
    ctx.save();
    const grad = ctx.createRadialGradient(VIEW_W/2, VIEW_H/2, 40, VIEW_W/2, VIEW_H/2, VIEW_W*0.7);
    grad.addColorStop(0, 'rgba(80,150,220,0)');
    grad.addColorStop(1, 'rgba(60,120,220,' + alpha + ')');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.restore();
  }

  /* ---------- Имена удалённых игроков ---------- */
  drawNameLabels(nameLabels);

  /* ---------- Дробовик в руках, направлен в центр экрана ---------- */
  drawShotgun(ctx);

  /* ---------- Всплывающие сообщения снизу ---------- */
  if (state.messageTimer > 0 && state.message) {
    ctx.save();
    ctx.font = 'bold 12px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    const w = ctx.measureText(state.message).width + 24;
    ctx.fillRect(VIEW_W/2 - w/2, VIEW_H - 46, w, 22);
    ctx.fillStyle = '#7dffb0';
    ctx.fillText(state.message, VIEW_W/2, VIEW_H - 31);
    ctx.restore();
  }
}

/* ---------- Список спрайтов ---------- */
/* Скелеты ближе этого расстояния (клетки) считаются «сбившимися в одну
   точку»: их спрайты визуально накладываются, поэтому над кучей показываем
   цифру — сколько скелетов там вместе. Одиночек и стоящих по соседним
   клеткам (1.0) не подписываем — они не сливаются в одно пятно. */
const SKEL_CLUSTER_D = 0.9;
/* Кучи, для которых в этом кадре уже есть метка: id → объект подписи.
   Спрайты рисуются от дальних к ближним, поэтому ближайший видимый член
   кучи перезаписывает позицию метки — она всегда над передним скелетом. */
const clusteredDrawn = new Map();

function renderSprites(nameLabels) {
  const flashOn = state.flashlightOn && state.battery > 0;
  const itemAmbient = flashOn ? 1 : 0.35;

  const spriteList = [];

  const nowMs = Date.now();
  for (const it of items) {
    if (it.taken || it.respawnAt > nowMs) continue;
    const dx = it.x - posX, dy = it.y - posY;
    const dist2 = dx*dx + dy*dy;
    if (dist2 < 400) spriteList.push({
      x: it.x, y: it.y, tex: it.tex, size: 0.55, dist: dist2
    });
  }

  // Скелеты (общие, с сервера). Собираем их в связные группы: скелеты,
  // наложившиеся друг на друга, образуют «кучу», и над её ближайшим
  // к игроку видимым представителем рисуется счётчик (clusterN).
  const skelNear = [];
  for (const s of remoteSkeletons.values()) {
    const dx = s.rx - posX, dy = s.ry - posY;
    const d2 = dx*dx + dy*dy;
    if (d2 > 400) continue;
    skelNear.push({ s, d2 });
  }
  skelNear.sort((a, b) => a.d2 - b.d2);   // ближние первыми

  // Кластеризация «по лидеру»: ближайший скелет становится центром кучи,
  // все в радиусе SKEL_CLUSTER_D от него — её члены. Радиус ограничен,
  // поэтому цепочки («паровозик» из скелетов через всю карту) не склеиваются
  // в одну кучу.
  const groupOf = new Int16Array(skelNear.length).fill(-1);
  let groupCount = 0;
  for (let i = 0; i < skelNear.length; i++) {
    if (groupOf[i] !== -1) continue;
    const leader = skelNear[i].s;
    const id = groupCount++;
    groupOf[i] = id;
    for (let j = i + 1; j < skelNear.length; j++) {
      if (groupOf[j] !== -1) continue;
      const b = skelNear[j].s;
      if (Math.hypot(leader.rx - b.rx, leader.ry - b.ry) < SKEL_CLUSTER_D) {
        groupOf[j] = id;
      }
    }
  }
  const groupSize = new Array(groupCount).fill(0);
  for (let i = 0; i < skelNear.length; i++) groupSize[groupOf[i]]++;
  clusteredDrawn.clear();
  for (let i = 0; i < skelNear.length; i++) {
    const e = skelNear[i];
    const g = groupOf[i];
    spriteList.push({
      x: e.s.rx, y: e.s.ry, tex: texSkeleton, size: 0.85, dist: e.d2,
      // Вся группа знает свой размер и id; саму цифру ставит ближайший
      // видимый скелет кучи (см. renderOneSprite), поэтому она не пропадает,
      // если центр закрыт стеной, и всегда ложится поверх кучи.
      clusterN: groupSize[g] > 1 ? groupSize[g] : 0,
      clusterId: g,
    });
  }

  const gdx = ghostX - posX, gdy = ghostY - posY;
  spriteList.push({
    x: ghostX, y: ghostY, tex: texGhost, size: 1.05,
    dist: gdx*gdx + gdy*gdy, isGhost: true
  });

  // Другие игроки
  for (const p of remotePlayers.values()) {
    const dx = p.rx - posX, dy = p.ry - posY;
    const d2 = dx*dx + dy*dy;
    if (d2 > 500) continue;
    spriteList.push({
      x: p.rx, y: p.ry, tex: texPlayer, size: 0.95,
      dist: d2, isPlayer: true, color: p.color || 0xffffff,
      name: p.name, id: p.id
    });
  }

  spriteList.sort((a, b) => b.dist - a.dist);

  for (const sp of spriteList) {
    renderOneSprite(sp, itemAmbient, nameLabels);
  }
}

/* ---------- Один спрайт ---------- */
function renderOneSprite(sp, itemAmbient, nameLabels) {
  const spriteX = sp.x - posX;
  const spriteY = sp.y - posY;
  const invDet = 1.0 / (planeX*dirY - dirX*planeY);
  const transformX = invDet * (dirY*spriteX - dirX*spriteY);
  const transformY = invDet * (-planeY*spriteX + planeX*spriteY);
  if (transformY <= 0.15) return;

  const screenX = Math.floor((VIEW_W/2) * (1 + transformX/transformY));
  const baseSize = Math.abs(VIEW_H / transformY);
  const h = baseSize * sp.size;
  const w = baseSize * sp.size * 0.85;

  let bobOffset = 0, pulse = 1;
  if (sp.isGhost) {
    ghostBobPhase += 0.045;
    bobOffset = Math.sin(ghostBobPhase) * (baseSize * 0.03);
    pulse = 1 + Math.sin(ghostBobPhase * 0.7) * 0.025;
  } else if (sp.isPlayer) {
    bobOffset = Math.sin(state.elapsed * 3 + sp.x * 5) * baseSize * 0.015;
  } else {
    bobOffset = Math.sin(state.elapsed * 2 + sp.x) * baseSize * 0.02;
  }

  const dh = h * pulse, dw = w * pulse;
  const dsy = Math.floor(-dh/2 + VIEW_H/2 + bobOffset);
  const dey = Math.floor(dh/2 + VIEW_H/2 + bobOffset);
  const dsx = Math.floor(-dw/2 + screenX);
  const dex = Math.floor(dw/2 + screenX);

  const x0 = Math.max(0, dsx), x1 = Math.min(VIEW_W, dex);
  const y0 = Math.max(0, dsy), y1 = Math.min(VIEW_H, dey);

  /* --- Собираем подпись с именем, если спрайт хоть частично на экране --- */
  if (sp.isPlayer && nameLabels && x0 < x1 && y0 < y1) {
    const cx = Math.max(0, Math.min(VIEW_W - 1, screenX | 0));
    // Проверяем, что нас не перекрывает стена
    if (transformY < perpBuf[cx]) {
      nameLabels.push({
        x: screenX,
        y: dsy - 4,
        name: sp.name,
        dist: transformY
      });
    }
  }

  /* --- Счётчик скелетов в куче: цифра над ближайшим видимым скелетом группы --- */
  if (sp.clusterN > 1 && nameLabels && x0 < x1 && y0 < y1) {
    const cx = Math.max(0, Math.min(VIEW_W - 1, screenX | 0));
    if (transformY < perpBuf[cx]) {
      const prev = clusteredDrawn.get(sp.clusterId);
      if (!prev) {
        const lb = { x: screenX, y: dsy - 6, count: sp.clusterN, dist: transformY };
        clusteredDrawn.set(sp.clusterId, lb);
        nameLabels.push(lb);
      } else if (transformY < prev.dist) {
        // этот скелет ближе — переносим цифру на него
        prev.x = screenX; prev.y = dsy - 6; prev.dist = transformY;
      }
    }
  }

  if (x0 >= x1 || y0 >= y1) return;

  let light = 2.0 / (1 + transformY * 0.4);
  if (light > 1) light = 1;
  if (light < 0.15) light = 0.15;
  if (sp.isGhost) light = Math.min(1.05, light * 1.35);
  else if (sp.isPlayer) light = Math.min(1, light * 1.1);
  else light *= itemAmbient;

  // Тинт для спрайта игрока — умножаем каналы на цвет
  let tr = 1, tg = 1, tb = 1;
  if (sp.isPlayer && sp.color) {
    tr = ((sp.color >> 16) & 255) / 255;
    tg = ((sp.color >> 8) & 255) / 255;
    tb = (sp.color & 255) / 255;
    // Подтягиваем яркость — иначе тёмные цвета становятся слишком тёмными
    tr = 0.35 + tr * 0.65;
    tg = 0.35 + tg * 0.65;
    tb = 0.35 + tb * 0.65;
  }

  const fog = Math.min(1, Math.max(0, (transformY - FOG_NEAR)/(FOG_FAR-FOG_NEAR)));
  const fogInv = 1 - fog;
  const invW = SPR_SIZE / dw, invH = SPR_SIZE / dh;

  for (let x = x0; x < x1; x++) {
    if (transformY >= perpBuf[x]) continue;
    const texX = ((x - dsx) * invW) | 0;
    if (texX < 0 || texX >= SPR_SIZE) continue;
    for (let y = y0; y < y1; y++) {
      const texY = ((y - dsy) * invH) | 0;
      if (texY < 0 || texY >= SPR_SIZE) continue;
      const c = sp.tex[texY*SPR_SIZE + texX];
      const a = (c >>> 24) & 255;
      if (a < 40) continue;
      let r = (c & 255) * light * tr;
      let g = ((c >>> 8) & 255) * light * tg;
      let b = ((c >>> 16) & 255) * light * tb;
      r = r*fogInv + FOG_R*fog;
      g = g*fogInv + FOG_G*fog;
      b = b*fogInv + FOG_B*fog;
      if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
      if (a < 220) {
        const old = buf[y*VIEW_W + x];
        const or_ = old & 255, og = (old >> 8) & 255, ob = (old >> 16) & 255;
        const t = a / 255;
        r = r*t + or_*(1-t);
        g = g*t + og*(1-t);
        b = b*t + ob*(1-t);
      }
      buf[y*VIEW_W + x] = 0xFF000000 | ((b|0)<<16) | ((g|0)<<8) | (r|0);
    }
  }
}

/* ---------- Подписи: имена игроков и счётчики скелетов в куче ---------- */
function drawNameLabels(nameLabels) {
  if (!nameLabels || !nameLabels.length) return;
  // Сортируем по дистанции — дальние рисуем первыми
  nameLabels.sort((a, b) => b.dist - a.dist);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const lb of nameLabels) {
    if (lb.y < -8 || lb.y > VIEW_H + 8) continue;
    if (lb.x < -60 || lb.x > VIEW_W + 60) continue;
    // Плавное затухание с расстоянием
    const fade = Math.max(0.25, Math.min(1, 1 - (lb.dist - 4) / 18));
    ctx.globalAlpha = fade;

    if (lb.count) {
      // Куча скелетов: янтарная цифра со скелетным значком
      const txt = '☠×' + lb.count;
      ctx.font = 'bold 12px Consolas, monospace';
      const w = ctx.measureText(txt).width;
      ctx.fillStyle = 'rgba(20,10,4,0.62)';
      ctx.fillRect(lb.x - w/2 - 4, lb.y - 14, w + 8, 15);
      ctx.strokeStyle = 'rgba(255,196,90,0.75)';
      ctx.lineWidth = 1;
      ctx.strokeRect(lb.x - w/2 - 3.5, lb.y - 13.5, w + 7, 14);
      ctx.fillStyle = '#ffc45a';
      ctx.fillText(txt, lb.x, lb.y - 2);
      continue;
    }

    // Имя игрока
    ctx.font = 'bold 11px Consolas, monospace';
    const w = ctx.measureText(lb.name).width;
    // Фон
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(lb.x - w/2 - 4, lb.y - 12, w + 8, 13);
    // Обводка
    ctx.strokeStyle = 'rgba(120,220,255,0.65)';
    ctx.lineWidth = 1;
    ctx.strokeRect(lb.x - w/2 - 4 + 0.5, lb.y - 12 + 0.5, w + 8 - 1, 13 - 1);
    // Текст
    ctx.fillStyle = '#dff1ff';
    ctx.fillText(lb.name, lb.x, lb.y - 1);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/* =========================================================
   ТУМАН ВОЙНЫ НА МИНИ-КАРТЕ
   ========================================================= */
function updateExplored() {
  if (!grid || !explored) return;
  const R = 5.0;
  const R2 = R * R;
  const px = Math.floor(posX), py = Math.floor(posY);
  const range = 6;
  let newly = 0;
  for (let y = py - range; y <= py + range; y++) {
    for (let x = px - range; x <= px + range; x++) {
      if (x < 0 || y < 0 || x >= MAPW || y >= MAPH) continue;
      if (explored[y*MAPW + x]) continue;
      const cx = x + 0.5, cy = y + 0.5;
      const dx = cx - posX, dy = cy - posY;
      const d2 = dx*dx + dy*dy;
      if (d2 > R2) continue;

      const isWallCell = grid[y*MAPW + x] > 0;
      const dist = Math.sqrt(d2);

      if (isWallCell) {
        if (dist < 0.8) { explored[y*MAPW + x] = 1; newly++; continue; }
        const stopDist = dist - 0.7;
        const ex = posX + (dx/dist) * stopDist;
        const ey = posY + (dy/dist) * stopDist;
        if (hasLOS(posX, posY, ex, ey)) { explored[y*MAPW + x] = 1; newly++; }
      } else {
        if (hasLOS(posX, posY, cx, cy)) { explored[y*MAPW + x] = 1; newly++; }
      }
    }
  }
  // +5 очков за каждую новую открытую клетку (туман войны у каждого свой)
  if (newly > 0) {
    addScore(newly * 5);
    pendingExplore += newly;
  }
}

/* ---------- Иконки ---------- */
function drawAmmoIcon(px, py) {
  mctx.fillStyle = '#e05a2b';
  mctx.shadowColor = '#e05a2b'; mctx.shadowBlur = 6;
  mctx.fillRect(px - 3, py - 3, 6, 6);
  mctx.shadowBlur = 0;
  mctx.fillStyle = '#ffd54a';
  mctx.fillRect(px - 3, py + 1, 6, 2);
}

function drawHeartIcon(cx, cy, size, color) {
  mctx.save();
  mctx.fillStyle = color;
  mctx.shadowColor = color;
  mctx.shadowBlur = 6;
  const s = size;
  mctx.beginPath();
  mctx.moveTo(cx, cy + s * 1.1);
  mctx.bezierCurveTo(cx - s * 1.6, cy - s * 0.15,
                     cx - s * 0.7, cy - s * 1.15,
                     cx, cy - s * 0.35);
  mctx.bezierCurveTo(cx + s * 0.7, cy - s * 1.15,
                     cx + s * 1.6, cy - s * 0.15,
                     cx, cy + s * 1.1);
  mctx.closePath();
  mctx.fill();
  mctx.restore();
}
function drawBatteryIcon(cx, cy, color) {
  mctx.save();
  mctx.fillStyle = color;
  mctx.shadowColor = color;
  mctx.shadowBlur = 6;
  mctx.fillRect(cx - 3.5, cy - 4.5, 7, 9);
  mctx.fillRect(cx - 1.8, cy - 6.5, 3.6, 2);
  mctx.fillStyle = 'rgba(10,15,20,0.6)';
  mctx.shadowBlur = 0;
  mctx.fillRect(cx - 2.5, cy - 1, 5, 1);
  mctx.restore();
}

/* ---------- Мини-карта ---------- */
function drawMinimap() {
  if (!grid || !explored) return;
  const C = 11;
  const W = mapCanvas.width, H = mapCanvas.height;

  if (fogCanvas) {
    mctx.drawImage(fogCanvas, 0, 0);
  } else {
    mctx.fillStyle = '#141b28';
    mctx.fillRect(0, 0, W, H);
  }

  for (let y = 0; y < MAPH; y++) {
    for (let x = 0; x < MAPW; x++) {
      if (!explored[y*MAPW + x]) continue;
      const t = grid[y*MAPW + x];
      let col;
      if (t === 0)      col = '#1a2230';
      else if (t === 2) col = '#4a6a8a';
      else if (t === 3) col = '#385d78';
      else              col = '#355a7a';
      mctx.fillStyle = col;
      mctx.fillRect(x*C, y*C, C, C);
    }
  }

  mctx.strokeStyle = 'rgba(90,140,180,.10)';
  mctx.lineWidth = 1;
  for (let y = 0; y < MAPH; y++) {
    for (let x = 0; x < MAPW; x++) {
      if (!explored[y*MAPW + x]) continue;
      mctx.strokeRect(x*C + 0.5, y*C + 0.5, C - 1, C - 1);
    }
  }

  if (explored[doorY*MAPW + doorX]) {
    // Дверь зала в центре: закрыта — янтарная, открыта — зелёная
    const opened = grid[doorY*MAPW + doorX] === 0;
    mctx.fillStyle = opened ? '#2ee06a' : '#ffb347';
    mctx.shadowColor = opened ? '#2ee06a' : '#ffb347';
    mctx.shadowBlur = 10;
    mctx.fillRect(doorX*C + 1, doorY*C + 1, C - 2, C - 2);
    mctx.shadowBlur = 0;
  }

  const nowMs = Date.now();
  for (const it of items) {
    if (it.taken || it.respawnAt > nowMs) continue;
    const mx = Math.floor(it.x), my = Math.floor(it.y);
    if (!explored[my*MAPW + mx]) continue;
    const px = it.x * C, py = it.y * C;

    if (it.type === 'key') {
      mctx.fillStyle = '#ffd54a';
      mctx.shadowColor = '#ffd54a';
      mctx.shadowBlur = 8;
      mctx.beginPath(); mctx.arc(px, py, 3, 0, Math.PI * 2); mctx.fill();
      mctx.shadowBlur = 0;
    } else if (it.type === 'medkit') {
      drawHeartIcon(px, py, 3.6, '#ff5a6a');
    } else if (it.type === 'battery') {
      drawBatteryIcon(px, py, '#7dffb0');
    } else if (it.type === 'ammo') {
      drawAmmoIcon(px, py);
    }
  }

  /* --- Другие игроки на мини-карте (только если в зоне видимости) --- */
  for (const p of remotePlayers.values()) {
    const mx = Math.floor(p.rx), my = Math.floor(p.ry);
    if (mx < 0 || my < 0 || mx >= MAPW || my >= MAPH) continue;
    if (!explored[my*MAPW + mx]) continue;
    const gdx = p.rx - posX, gdy = p.ry - posY;
    const gdist = Math.hypot(gdx, gdy);
    const visible = gdist < 12 && hasLOS(posX, posY, p.rx, p.ry);
    if (!visible) continue;
    const ex = p.rx * C, ey = p.ry * C;
    // Цвет игрока
    const col = '#' + (p.color || 0xaaddff).toString(16).padStart(6, '0');
    mctx.fillStyle = col;
    mctx.shadowColor = col; mctx.shadowBlur = 10;
    mctx.beginPath(); mctx.arc(ex, ey, C*0.42, 0, Math.PI*2); mctx.fill();
    mctx.shadowBlur = 0;
    // Точка направления
    mctx.strokeStyle = col; mctx.lineWidth = 1.5;
    mctx.beginPath();
    mctx.moveTo(ex, ey);
    mctx.lineTo(ex + (p.dirX || 0) * C * 2, ey + (p.dirY || 0) * C * 2);
    mctx.stroke();
  }

  /* --- Привидение --- */
  const gdx2 = ghostX - posX, gdy2 = ghostY - posY;
  const gdist2 = Math.hypot(gdx2, gdy2);
  const ghostVisible = gdist2 < diff().vision && hasLOS(ghostX, ghostY, posX, posY);
  if (ghostVisible) {
    const ex = ghostX * C, ey = ghostY * C;
    mctx.fillStyle = 'rgba(170,220,255,0.3)';
    mctx.beginPath(); mctx.arc(ex, ey, C*1.15, 0, Math.PI*2); mctx.fill();
    mctx.fillStyle = '#aaddff';
    mctx.shadowColor = '#88ccff'; mctx.shadowBlur = 12;
    mctx.beginPath(); mctx.arc(ex, ey, C*0.44, 0, Math.PI*2); mctx.fill();
    mctx.shadowBlur = 0;
  }

  /* --- Локальный игрок --- */
  const px = posX * C, py = posY * C;
  mctx.strokeStyle = 'rgba(255,204,51,.35)'; mctx.lineWidth = 2;
  mctx.beginPath(); mctx.moveTo(px, py);
  mctx.lineTo(px + dirX * C * 4, py + dirY * C * 4); mctx.stroke();
  mctx.fillStyle = '#ffcc33'; mctx.shadowColor = '#ffcc33'; mctx.shadowBlur = 8;
  mctx.beginPath(); mctx.arc(px, py, C*0.42, 0, Math.PI*2); mctx.fill();
  mctx.shadowBlur = 0;
}

/* =========================================================
   ГЛАВНЫЙ ЦИКЛ
   ========================================================= */
let lastTime = performance.now();
let fpsAccum = 0, fpsFrames = 0, fpsValue = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime)/1000);
  lastTime = now;

  if (running && grid) update(dt);

  // Сглаживание чужих игроков: снапшоты приходят на 30 Гц,
  // между ними рендерим промежуточные позиции
  for (const p of remotePlayers.values()) {
    const k = 1 - Math.exp(-dt * 14);
    p.rx += (p.x - p.rx) * k;
    p.ry += (p.y - p.ry) * k;
  }

  // Скелеты движутся на 10 Гц — сглаживаем так же
  for (const s of remoteSkeletons.values()) {
    const k = 1 - Math.exp(-dt * 10);
    s.rx += (s.x - s.rx) * k;
    s.ry += (s.y - s.ry) * k;
  }

  const nameLabels = [];
  render(nameLabels);
  if (grid) {
    updateExplored();
    drawMinimap();
  }

  const hpEl = document.getElementById('hpFill');
  if (hpEl) hpEl.style.width = state.health + '%';
  const batEl = document.getElementById('batFill');
  if (batEl) batEl.style.width = state.battery + '%';
  const am = document.getElementById('ammoHud');
  if (am) am.textContent = state.ammo + '/' + AMMO_MAX;
  const sh = document.getElementById('scoreHud');
  if (sh) sh.textContent = state.score;

  if (grid) {
    const d = Math.hypot(posX - ghostX, posY - ghostY);
    const dh = document.getElementById('distHud');
    if (dh) dh.textContent = d.toFixed(1) + 'м';
  }
  const badge = document.getElementById('stateBadge');
  if (badge) {
    if (ghostState === 'chase') { badge.textContent = '⚡ ПРЕСЛЕДУЕТ'; badge.classList.add('chase'); }
    else if (ghostState === 'search') { badge.textContent = '👁 ИЩЕТ'; badge.classList.remove('chase'); }
    else { badge.textContent = '· патруль'; badge.classList.remove('chase'); }
  }

  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.5) { fpsValue = Math.round(fpsFrames/fpsAccum); fpsAccum = 0; fpsFrames = 0; }
  const fpsEl = document.getElementById('fpsInfo');
  if (fpsEl) fpsEl.textContent = fpsValue + ' FPS';

  requestAnimationFrame(frame);
}

/* =========================================================
   UI
   ========================================================= */
const overlay = document.getElementById('overlay');
const ovTitle = document.getElementById('ovTitle');
const ovText = document.getElementById('ovText');
const ovScore = document.getElementById('ovScore');
const startBtn = document.getElementById('startBtn');
const diffRow = document.getElementById('diffRow');
let overlayAction = 'start';

function showOverlay(title, text, btn, action, ghost, score) {
  ovTitle.textContent = title;
  ovTitle.classList.remove('ghost'); ovTitle.classList.remove('danger');
  if (ghost === 'ghost') ovTitle.classList.add('ghost');
  if (ghost === 'danger') ovTitle.classList.add('danger');
  ovText.innerHTML = text;
  startBtn.textContent = btn;
  overlayAction = action;
  if (score !== undefined) {
    ovScore.style.display = 'block';
    ovScore.textContent = 'ОЧКИ: ' + score;
  } else {
    ovScore.style.display = 'none';
  }
  overlay.classList.add('show');
}
function hideOverlay() { overlay.classList.remove('show'); }

/* --- Поле «Имя» в панели старта (добавляем динамически) --- */
(function injectNameInput() {
  const panel = document.querySelector('.panel');
  if (!panel) return;
  const row = document.createElement('div');
  row.className = 'setRow';
  row.style.marginTop = '14px';
  row.innerHTML =
    '<span>Имя</span>' +
    '<input type="text" id="nameInput" maxlength="16" ' +
    'style="flex:1;background:#0d151c;border:1px solid #35485a;' +
    'color:#cfe4f5;padding:5px 8px;border-radius:3px;' +
    'font-family:inherit;font-size:11px;outline:none">';
  // Вставляем перед блоком подсказок с клавишами
  const hint = panel.querySelector('p[style*="5b7386"]');
  if (hint) panel.insertBefore(row, hint);
  else panel.appendChild(row);
  const inp = document.getElementById('nameInput');
  inp.value = localStorage.getItem('maze_name') || 'Игрок';
  inp.addEventListener('keydown', e => {
    if (e.code === 'Enter') { e.preventDefault(); startBtn.click(); }
  });
})();

startBtn.addEventListener('click', async () => {
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

  if (overlayAction === 'reload') {
    location.reload();
    return;
  }

  if (overlayAction === 'respawn') {
    // Возрождение после смерти: прогресс (ключи, счёт, подобранные предметы) сохраняется
    resetLocal(true);
    hideOverlay();
    running = true;
    lastTime = performance.now();
    if (!locked) lockPointer();
    return;
  }

  if (overlayAction === 'new') {
    // Локальный сброс на той же серверной карте
    resetLocal();
    hideOverlay();
    running = true;
    lastTime = performance.now();
    if (!locked) lockPointer();
    return;
  }

  if (overlayAction === 'resume') {
    hideOverlay();
    running = true;
    lastTime = performance.now();
    if (!locked) lockPointer();
    return;
  }

  // action === 'start' — подключаемся к серверу
  const inp = document.getElementById('nameInput');
  const name = (inp ? inp.value.trim() : '') || 'Игрок';
  localStorage.setItem('maze_name', name);

  startBtn.disabled = true;
  const oldLabel = startBtn.textContent;
  startBtn.textContent = 'ПОДКЛЮЧЕНИЕ…';

  try {
    await connectToServer(name);
    hideOverlay();
    running = true;
    lastTime = performance.now();
    if (!locked) lockPointer();
  } catch (err) {
    showOverlay('НЕ УДАЛОСЬ ПОДКЛЮЧИТЬСЯ',
      (err && err.message ? err.message : 'Неизвестная ошибка') +
      '<br><span style="color:#5b7386">Проверьте, что сервер запущен и доступен по ' +
      location.host + '</span>',
      'ПОВТОРИТЬ', 'start', 'danger');
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = overlayAction === 'start' ? oldLabel : startBtn.textContent;
  }
});

diffRow.addEventListener('click', (e) => {
  const b = e.target.closest('.diffBtn');
  if (!b) return;
  state.diff = b.dataset.d;
  [...diffRow.querySelectorAll('.diffBtn')].forEach(x => x.classList.toggle('sel', x === b));
});

function tryOpenDoor() {
  if (won || dead || doorOpening) return;
  doorOpening = true;
  addScore(5000);
  sendScoreMsg({ type: 'win' });
  showMessage('ОТКРЫВАЕМ ДВЕРЬ...');
  playTone(160, 0.7, 'sawtooth', 0.12);
}

/* Скелеты бьют при контакте (урон локальный, как у призрака) */
function updateSkeletonContact() {
  if (won || dead) return;
  for (const s of remoteSkeletons.values()) {
    const dx = s.rx - posX, dy = s.ry - posY;
    if (dx*dx + dy*dy > 0.36) continue;      // ближе 0.6 клетки
    if (state.invuln > 0) return;
    state.health -= 15;
    state.invuln = 1.0;
    playHitSound();
    flashDamage();
    if (state.health <= 0) { state.health = 0; die(); }
    return;
  }
}

/* Выстрел дробовика: дальность 7.2 клетки, конус ~20°, прямая видимость.
   На скелета нужно 2 попадания — их считает сервер. Патроны конечны:
   запас не больше 30, пополнение — только призами-патронами (+30). */
function attack() {
  if (!running || won || dead || attackCooldown > 0) return;
  if (state.ammo <= 0) {
    attackCooldown = 0.3;
    playTone(300, 0.05, 'square', 0.04);      // сухой щелчок
    showMessage('НЕТ ПАТРОНОВ — ИЩИТЕ ПРИЗЫ');
    return;
  }
  attackCooldown = ATTACK_COOLDOWN;
  state.ammo--;
  shotRecoil = 1;
  shotFlash = 0.09;
  castBulletDecal();                          // след на стене
  playTone(70, 0.25, 'sawtooth', 0.18);       // бас выстрела
  playTone(110, 0.15, 'square', 0.12);
  for (const s of remoteSkeletons.values()) {
    const dx = s.x - posX, dy = s.y - posY;
    const dist = Math.hypot(dx, dy);
    if (dist > SHOT_RANGE) continue;
    const dot = (dx*dirX + dy*dirY) / dist;
    if (dot < 0.9) continue;                  // целимся в него
    if (!hasLOS(posX, posY, s.x, s.y)) continue;
    sendScoreMsg({ type: 'skeletonHit', id: s.id });
    const hitsDone = (s.hits || 0) + 1;
    if (hitsDone >= SHOT_HITS_TO_KILL) {
      showMessage('СКЕЛЕТ УНИЧТОЖЕН · +50');
      playTone(660, 0.15, 'triangle', 0.08);
    } else {
      showMessage('ПОПАДАНИЕ · ЕЩЁ ' + (SHOT_HITS_TO_KILL - hitsDone));
    }
    return;
  }

  // В привидение попасть нельзя — но пусть выстрел «в него» имеет отклик
  const gdx = ghostX - posX, gdy = ghostY - posY;
  const gdist = Math.hypot(gdx, gdy);
  if (gdist <= SHOT_RANGE) {
    const gdot = (gdx*dirX + gdy*dirY) / gdist;
    if (gdot >= 0.9 && hasLOS(posX, posY, ghostX, ghostY)) {
      showMessage('ПРОТИВ ПРИВИДЕНИЯ ОРУЖИЕ БЕСПОЛЕЗЕН');
      playWhisper();
    }
  }
}

/* Дробовик от первого лица — по центру, как в классических шутерах:
   вид сзади, широкий низ уходит за нижний край, ствол сужается к дулу,
   направленному в центр экрана. Без руки. При выстреле — отдача и вспышка. */
function drawShotgun(ctx) {
  if (!grid || won || dead) return;
  const recoil = shotRecoil;                    // 1 сразу после выстрела → 0
  const kick = recoil * recoil * 14;            // отдача: оружие ныряет вниз
  const bob = Math.sin(state.elapsed * 5) * 2;  // лёгкое покачивание на ходу
  const cx = VIEW_W / 2 + bob + recoil * 2;
  const baseY = VIEW_H + 6 + kick;
  const muzzleY = -81 + kick * 0.4;             // короче на четверть (было -108)

  ctx.save();
  ctx.translate(cx, baseY);

  // нижняя часть (казённик) — широкая, уходит за нижний край
  ctx.fillStyle = '#1d2126';
  ctx.beginPath(); ctx.ellipse(0, 10, 30, 22, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2b3138';
  ctx.beginPath(); ctx.ellipse(0, 4, 26, 18, 0, 0, Math.PI * 2); ctx.fill();

  // ствол — сужается к дулу
  ctx.fillStyle = '#20242a';
  ctx.beginPath();
  ctx.moveTo(-16, -18);
  ctx.lineTo(-7, muzzleY);
  ctx.lineTo(7, muzzleY);
  ctx.lineTo(16, -18);
  ctx.closePath(); ctx.fill();
  // блик по левой грани
  ctx.fillStyle = '#3a424c';
  ctx.beginPath();
  ctx.moveTo(-16, -18);
  ctx.lineTo(-7, muzzleY);
  ctx.lineTo(-3, muzzleY);
  ctx.lineTo(-9, -18);
  ctx.closePath(); ctx.fill();
  // кольцо на стволе
  ctx.fillStyle = '#15181c';
  ctx.fillRect(-11, -35, 22, 5);

  // дуло и мушка
  ctx.fillStyle = '#121519';
  ctx.fillRect(-9, muzzleY - 6, 18, 8);
  ctx.fillStyle = '#39424d';
  ctx.fillRect(-2, muzzleY - 10, 4, 5);

  ctx.restore();

  // вспышка у дула
  if (shotFlash > 0) {
    const mx = cx, my = baseY + muzzleY - 8;
    const a = Math.min(1, shotFlash / 0.09);
    const g = ctx.createRadialGradient(mx, my, 2, mx, my, 52);
    g.addColorStop(0, `rgba(255,240,180,${0.95 * a})`);
    g.addColorStop(0.4, `rgba(255,180,60,${0.55 * a})`);
    g.addColorStop(1, 'rgba(255,120,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(mx - 56, my - 56, 112, 112);
  }
}

function die() {
  if (won || dead) return;
  running = false; dead = true;
  if (document.pointerLockElement) document.exitPointerLock();
  showOverlay('ПРИВИДЕНИЕ ВАС ПОГЛОТИЛО',
    'Ледяное касание оборвало ваш путь.<br>Найденные ключи и очки останутся с вами.',
    'ВОЗРОДИТЬСЯ', 'respawn', 'danger');
}

document.getElementById('newBtn').addEventListener('click', () => {
  if (!grid) return;
  // Карта общая — перегенерировать её должен сервер, для всех игроков
  if (ws && ws.readyState === 1 && serverConnected) {
    ws.send(JSON.stringify({ type: 'newMap' }));
    showMessage('ЗАПРОС НОВОЙ КАРТЫ...');
    return;
  }
  resetLocal();
  hideOverlay();
  running = true;
  lastTime = performance.now();
  if (!locked) lockPointer();
});

function diffLabel(d) {
  return d === 'easy' ? 'ЛЁГКАЯ' : d === 'hard' ? 'СЛОЖНАЯ' : 'ОБЫЧНАЯ';
}

function saveRecord(d, score) {
  try {
    const cur = parseInt(localStorage.getItem('maze_best_' + d) || '0', 10);
    if (score > cur) localStorage.setItem('maze_best_' + d, score);
  } catch(e) {}
}
function loadRecord(d) {
  try { return parseInt(localStorage.getItem('maze_best_' + d) || '0', 10); }
  catch(e) { return 0; }
}

/* =========================================================
   ПАНЕЛЬ ИГРОКОВ (динамически добавляем в сайдбар)
   ========================================================= */
(function ensurePlayersBox() {
  const side = document.getElementById('side');
  if (!side || document.getElementById('playersBox')) return;
  const legend = side.querySelector('.legend');
  const box = document.createElement('div');
  box.id = 'playersBox';
  box.style.cssText =
    'font-size:13px;color:#8fa6b8;border-top:1px solid #16202b;padding-top:10px;';
  box.innerHTML =
    '<div style="color:#7d94a8;font-size:11px;letter-spacing:2px;margin-bottom:7px">' +
    'HI-SCORE · ИГРОКИ И ОЧКИ</div>' +
    '<div id="playersList"></div>' +
    '<div style="margin-top:8px">' +
    '<input id="chatInput" type="text" maxlength="120" placeholder="Enter — написать…" ' +
    'style="width:100%;background:#0d151c;border:1px solid #35485a;' +
    'color:#cfe4f5;padding:5px 8px;border-radius:3px;' +
    'font-family:inherit;font-size:10.5px;outline:none">' +
    '</div>' +
    '<div id="chatLog" style="margin-top:6px;max-height:80px;overflow-y:auto;' +
    'font-size:10.5px;color:#8fa6b8;line-height:1.4"></div>';
  if (legend && legend.nextSibling) side.insertBefore(box, legend.nextSibling);
  else side.appendChild(box);

  const chatInput = document.getElementById('chatInput');
  chatInput.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const t = chatInput.value.trim();
      if (t) { sendChat(t); addChatLine(myName, t, true); }
      chatInput.value = '';
      chatInput.blur();
    }
    // Не даём WASD попасть в игровой цикл, пока фокус в чате
    e.stopPropagation();
  });
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

let playersHudSig = '';
function updatePlayersHud() {
  const el = document.getElementById('playersList');
  if (!el) return;
  const rows = [];
  let sig = state.score + '|';
  rows.push(`<div style="display:flex;gap:8px;align-items:center;margin:4px 0">
    <span style="width:10px;height:10px;border-radius:50%;background:#7dffb0"></span>
    <span style="color:#7dffb0">${escapeHtml(myName)} (вы)</span>
    <span style="margin-left:auto;color:#ffd54a;font-weight:700;font-size:14px">${state.score}</span></div>`);
  const sorted = [...remotePlayers.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const p of sorted) {
    const col = '#' + (p.color || 0xaaddff).toString(16).padStart(6, '0');
    const sc = p.score || 0;
    sig += p.id + ':' + sc + '|';
    rows.push(`<div style="display:flex;gap:8px;align-items:center;margin:4px 0">
      <span style="width:10px;height:10px;border-radius:50%;background:${col}"></span>
      <span style="color:#c8d4e0">${escapeHtml(p.name)}</span>
      <span style="margin-left:auto;color:#ffd54a;font-weight:700;font-size:14px">${sc}</span></div>`);
  }
  if (sig === playersHudSig) return;   // перерисовываем только при изменении
  playersHudSig = sig;
  el.innerHTML = rows.join('');
}

function addChatLine(name, text, self) {
  const log = document.getElementById('chatLog');
  if (!log) return;
  const line = document.createElement('div');
  line.style.marginBottom = '2px';
  line.innerHTML = `<span style="color:${self?'#7dffb0':'#ffd54a'}">${escapeHtml(name)}:</span> ` +
                   `<span>${escapeHtml(text)}</span>`;
  log.appendChild(line);
  while (log.children.length > 30) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

/* =========================================================
   НАСТРОЙКИ UI
   ========================================================= */
const sensS = document.getElementById('sensS');
const sensV = document.getElementById('sensV');
const fovS = document.getElementById('fovS');
const fovV = document.getElementById('fovV');
const volS = document.getElementById('volS');
const volV = document.getElementById('volV');

if (sensS) {
  sensS.value = settings.sensitivity * 10;
  sensV.textContent = settings.sensitivity.toFixed(1);
  sensS.addEventListener('input', () => {
    settings.sensitivity = parseFloat(sensS.value) / 10;
    sensV.textContent = settings.sensitivity.toFixed(1);
    settings.save();
  });
}
if (fovS) {
  fovS.value = settings.fov;
  fovV.textContent = settings.fov + '°';
  fovS.addEventListener('input', () => {
    settings.fov = parseInt(fovS.value, 10);
    fovV.textContent = settings.fov + '°';
    PLANE = Math.tan((settings.fov * Math.PI/180) / 2);
    planeX = -dirY * PLANE;
    planeY = dirX * PLANE;
    settings.save();
  });
}
if (volS) {
  volS.value = settings.volume * 100;
  volV.textContent = Math.round(settings.volume * 100);
  volS.addEventListener('input', () => {
    settings.volume = parseInt(volS.value, 10) / 100;
    volV.textContent = Math.round(settings.volume * 100);
    settings.save();
  });
}

const mouseModeBtn = document.getElementById('mouseModeBtn');
if (mouseModeBtn) {
  const mouseModeLabel = () => {
    mouseModeBtn.textContent = settings.mouseMode === 'rdp' ? 'КУРСОР (RDP)' : 'ЗАХВАТ КУРСОРА';
  };
  mouseModeLabel();
  mouseModeBtn.addEventListener('click', () => {
    settings.mouseMode = settings.mouseMode === 'rdp' ? 'lock' : 'rdp';
    mouseModeLabel();
    rdpTurnRate = 0;
    settings.save();
    // Переключение на захват прямо во время игры — захватываем курсор
    if (settings.mouseMode === 'lock' && running && !locked) lockPointer();
  });
}

/* =========================================================
   СТАРТ
   ========================================================= */
// Карта ещё не получена — просто запускаем цикл рендера (чёрный экран)
requestAnimationFrame(frame);

// Периодическое обновление отладочной информации
setInterval(() => {
  const el = document.getElementById('posInfo');
  if (el && grid) el.textContent = `X:${posX.toFixed(1)} Y:${posY.toFixed(1)}`;
}, 200);

// Пингуем сервер каждые 15 сек (чтобы прокси не разрывали соединение)
setInterval(() => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
  }
}, 15000);

})();