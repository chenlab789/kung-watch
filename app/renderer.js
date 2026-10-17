// วาดตัวละคร tokibean ตาม state จาก main + จัดการเมาส์ (คลิกทะลุส่วนโปร่งใส, ลาก, ลูบหัว, จั๊กจี้, ตาตามเมาส์)
const params = new URLSearchParams(location.search);
const skin = params.get('skin') || 'classic';
const scale = Number(params.get('scale')) || 1;
const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d');
const W0 = canvas.width, H0 = canvas.height;

function setup() {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = W0 * scale + 'px';
  canvas.style.height = H0 * scale + 'px';
  canvas.width = Math.round(W0 * dpr * scale);
  canvas.height = Math.round(H0 * dpr * scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr * scale, dpr * scale);
  // pet.js อ่านความกว้างจาก clientWidth — ล็อกให้เป็นพิกัดตรรกะ 288 เสมอแม้จะขยายตัว
  Object.defineProperty(canvas, 'clientWidth', { get: () => W0, configurable: true });
}

let cur = { state: 'idle', bubble: null };
let frame = 0, gazeX = null, gazeY = null, pat = false, tickleUntil = 0, lastMX = null, hit = false;
let lastDir = 0, flips = [];                    // จั๊กจี้ = ส่ายเมาส์กลับไปกลับมาเร็วๆ บนตัว ไม่ใช่แค่ขยับเร็ว
const tag = document.getElementById('tag');
let shownHue = null, shownLabel = null;
window.kw.onState((s) => {
  cur = s;
  // แชทละสี: หมุนสีทั้งตัวด้วย hue-rotate + ป้ายชื่อโปรเจกต์ใต้เท้า
  if (s.hue !== shownHue) { shownHue = s.hue; canvas.style.filter = s.hue ? `hue-rotate(${s.hue}deg)` : ''; tag.style.filter = tag.style.background ? '' : canvas.style.filter; }
  // ป้าย: ชื่อโปรเจกต์ + context % (≥70 เหลือง, ≥85 แดง — สีเตือนไม่หมุนตาม hue)
  const label = s.label ? s.label + (s.ctx != null ? ` · ${s.ctx}%` : '') : '';
  if (label !== shownLabel) {
    shownLabel = label;
    tag.textContent = label; tag.hidden = !label;
    const hot = s.ctx >= 85 ? '#d23c3c' : s.ctx >= 70 ? '#c98a12' : '';
    tag.style.background = hot;
    tag.style.filter = hot ? '' : canvas.style.filter;
  }
});

// เสียงแจ้งเตือนสังเคราะห์ด้วย WebAudio (ไม่ต้องมีไฟล์เสียง)
let audio = null;
const TONES = {
  done: [[784, 0, 0.12], [1047, 0.11, 0.22]],                 // ติ๊ง-ติ๋ง ขึ้น
  attention: [[880, 0, 0.09], [880, 0.15, 0.09], [880, 0.3, 0.12]],   // ติ๊ด x3
  warn: [[659, 0, 0.14], [523, 0.16, 0.24]],                  // ลงต่ำ
};
window.kw.onSound((kind) => {
  try {
    audio = audio || new AudioContext();
    const t0 = audio.currentTime + 0.02;
    for (const [freq, at, len] of TONES[kind] || []) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      o.connect(g).connect(audio.destination);
      o.start(t0 + at); o.stop(t0 + at + len + 0.02);
    }
  } catch {}
});

// วาด 30 fps แต่นับเฟรมทีละ 2 — อนิเมชันของ tokibean จูนไว้ที่ 60 fps ความเร็วจึงเท่าเดิม ใช้ CPU ครึ่งเดียว
let lastDraw = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (now - lastDraw < 30) return;
  lastDraw = now;
  frame += 2;
  // pet.js ล้างด้วย clearRect(canvas.width…) ใต้ ctx.scale — ถ้าขนาด < 1 จะล้างไม่ครบกรอบ เงาซ้อนจนดำ/ภาพค้าง
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
  window.PetRenderer.draw(ctx, canvas, cur.state, !!cur.warn, cur.bubble, frame, {
    sessions: cur.sessions, workSecs: cur.workSecs, attnSecs: cur.attnSecs, toolNote: cur.toolNote,
    celebrate: cur.celebrate, oops: cur.oops, bgCount: cur.bgCount, agentCount: cur.agentCount,
    resetSecs: cur.resetSecs, gazeX, gazeY, tickle: performance.now() < tickleUntil,
    dragging: cur.dragging, pat: pat && !cur.dragging, textScale: 1.2,
  });
}

// ส่วนที่มีสีเท่านั้นที่กดได้ ที่เหลือคลิกทะลุไปหน้าต่างข้างหลัง
function opaqueAt(x, y) {
  const dpr = window.devicePixelRatio || 1;
  try { return ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data[3] > 100; }   // เงาจางๆ ไม่นับ
  catch { return false; }
}

window.addEventListener('mousemove', (e) => {
  const on = opaqueAt(e.offsetX, e.offsetY);
  if (on !== hit) { hit = on; window.kw.send('hit', on); }
  pat = on;
  gazeX = e.offsetX / scale; gazeY = e.offsetY / scale;
  const now = performance.now();
  if (lastMX !== null) {
    const dx = e.offsetX - lastMX;
    const dir = Math.abs(dx) >= 3 ? Math.sign(dx) : 0;
    if (dir && lastDir && dir !== lastDir) flips.push(now);
    if (dir) lastDir = dir;
  }
  lastMX = e.offsetX;
  flips = flips.filter((t) => now - t < 600);
  if (pat && flips.length >= 3) tickleUntil = now + 350;
});
document.addEventListener('mouseleave', () => {
  pat = false; gazeX = gazeY = null; tickleUntil = 0;
  lastMX = null; lastDir = 0; flips = [];
  if (hit) { hit = false; window.kw.send('hit', false); }
});
// pointer capture: ได้ pointerup แน่นอนแม้ปล่อยเมาส์ตอนเคอร์เซอร์หลุดนอกหน้าต่าง
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  if (!opaqueAt(e.offsetX, e.offsetY)) return;
  if (e.button === 0) { dragging = true; canvas.setPointerCapture(e.pointerId); window.kw.send('drag-start'); }
  if (e.button === 2) window.kw.send('menu');
});
const endDrag = () => { if (dragging) { dragging = false; window.kw.send('drag-end'); } };
canvas.addEventListener('pointerup', (e) => { if (e.button === 0) endDrag(); });
canvas.addEventListener('lostpointercapture', endDrag);
window.addEventListener('contextmenu', (e) => e.preventDefault());

function start() { setup(); requestAnimationFrame(loop); }
if (skin === 'classic') start();
else {
  const s = document.createElement('script');
  s.src = `vendor/skins/${skin}.js`;
  s.onload = start;
  s.onerror = start;
  document.body.appendChild(s);
}
