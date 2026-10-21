// KungWatch — desktop pet ที่ขยับตามงานของ Claude Code (แชทละตัว แยกสี)
// อาร์ตตัวละคร: tokibean (MIT, github.com/ZGhey/tokibean) อยู่ใน vendor/
// hook.js + statusline-bridge.js POST มาที่ :7788/event → state แยกตาม session → ส่งให้ตัวของ session นั้นทุก 100ms
const { app, BrowserWindow, ipcMain, screen, Menu, Notification, globalShortcut, dialog } = require('electron');
const http = require('http'), fs = require('fs'), path = require('path');
const { Worker } = require('worker_threads');
const { execFile, spawn } = require('child_process');
const STRINGS = require('./i18n');

const PORT = 7788;
const W0 = 288, H0 = 184, GROUND = 170;        // ขนาด canvas ของ tokibean, เท้าอยู่ที่ y≈170
const PANEL_W = 340, PANEL_H = 550;
const SKIN_IDS = ['classic', 'tabby', 'shiba', 'maneki', 'daruma', 'tuerye'];
const SCALES = [0.75, 1, 1.25, 1.5];
// hue-rotate จากสีส้มเดิม เรียงตามลำดับที่แจกให้แชทใหม่ — แชทที่เปิดอยู่พร้อมกันห้ามสีซ้ำ (ชื่อสีอยู่ใน i18n.js)
const HUES = [0, 200, 110, 280, 330, 50, 165, 240, 80, 305, 260, 345];
const WARN_PCT = 80;
const IDLE_KEY = '_idle';                        // ตัวที่ยืนรอตอนไม่มีแชทเลย
const LOGIN = { path: process.execPath, args: [path.resolve(__dirname)], name: 'KungWatch' };
const HOTKEY = 'Control+Alt+K', HOTKEY_LABEL = 'Ctrl+Alt+K';   // ซ่อน/เรียกตัวละครกลับ

if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId('KungWatch');

// ---------- config ----------
const CFG_FILE = path.join(app.getPath('userData'), 'config.json');
// colors: ชื่อโปรเจกต์ → hue ที่เลือกเอง · lang: null = ตามภาษาเครื่อง · rude: ข้อความจิ้มแบบหยาบ
// dndUntil: ห้ามรบกวนถึงเวลานี้ (ms) · dndNightly: ห้ามรบกวนทุกคืน 22:00–08:00
const cfg = { skin: 'classic', scale: 1, notify: true, sound: true, rude: false, lang: null, x: null, colors: {},
  dndUntil: 0, dndNightly: false };
try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch {}
const saveCfg = () => { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg)); } catch {} };
let T = STRINGS.en;                              // ตั้งจริงตอน app ready (ต้องรู้ locale ก่อน)

// ---------- state แยกตาม session (พอร์ตจาก tokibean src-tauri/src/reducer.rs) ----------
const sessions = new Map();                      // session_id → Session
const quota = { five: null, week: null, at: 0 };  // จาก statusline: {pct, resetsAt(ms)}
const costs = new Map();                         // session_id → {usd, day}
const log = [];
let warned = 0;                                  // แจ้งเตือนโควตา 80% ไปแล้วสำหรับรอบรีเซ็ตไหน
let idleBubble = { text: null, until: 0 };       // ฟองข้อความของตัวที่ยืนรอ

const newSession = (now) => ({ base: 'idle', since: now, doneUntil: 0, lastSeen: now, proj: '',
  bubble: null, bubbleUntil: 0, toolNote: null, toolUntil: 0, celebrate: 0, oopsUntil: 0, agents: [], bg: [],
  pid: null, inTool: false, stallWarned: false, ctx: null, ctxWarned: 0 });
const snippet = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const sayTo = (s, text, secs) => { s.bubble = text; s.bubbleUntil = Date.now() + secs * 1000; };
const today = () => new Date().toDateString();

function sayPet(pet, text, secs) {
  const s = sessions.get(pet.key);
  if (s) sayTo(s, text, secs);
  else idleBubble = { text, until: Date.now() + secs * 1000 };
}
const sayAll = (text, secs) => { for (const p of pets.values()) sayPet(p, text, secs); };

function friendlyTool(tool, input) {
  if (tool === 'Bash' || tool === 'PowerShell') {
    const c = String(input.command || '').toLowerCase();
    if (/(^|\s)git(\s|$)/.test(c)) return 'git';
    if (/pytest|jest|vitest|mocha|cargo test|go test|rspec|phpunit/.test(c) || (/ test/.test(c) && /npm|yarn|pnpm|make/.test(c))) return 'testing';
    if (/npm (install|i |ci)|yarn (add|install)|pnpm (add|install)|pip3? install|cargo add/.test(c)) return 'deps';
    return 'cmd';
  }
  const known = { Edit: 'coding', Write: 'coding', NotebookEdit: 'coding', Read: 'reading', Grep: 'searching',
    Glob: 'searching', WebFetch: 'browsing', WebSearch: 'browsing', TodoWrite: 'planning',
    TaskCreate: 'planning', TaskUpdate: 'planning' }[tool];
  return known || snippet(tool.split('__').pop(), 12);
}

// ---------- ห้ามรบกวน / ซ่อน ----------
// ห้ามรบกวน = ไม่มี toast ไม่มีเสียง (ฟองข้อความยังขึ้น) · ซ่อน = กดปุ่มลัดเอง หรือมีแอปเต็มจออยู่ข้างหน้า
let hidden = false, fullscreen = false;
const shown = () => !hidden && !fullscreen;
const nightHour = (d) => d.getHours() >= 22 || d.getHours() < 8;
function next8am() { const d = new Date(); if (d.getHours() >= 8) d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); }
// ห้ามรบกวนถึงเมื่อไหร่ (ms) หรือ 0 = ไม่ได้ห้าม
function dndEnd() {
  const now = Date.now(), end = cfg.dndUntil > now ? cfg.dndUntil : 0;
  return cfg.dndNightly && nightHour(new Date()) ? Math.max(end, next8am()) : end;
}
function setDnd(until, nightly) {
  cfg.dndUntil = until; cfg.dndNightly = nightly; saveCfg();
  sayAll(dndEnd() ? T.dndBubble : T.dndOffBubble, 3);
}

function applyVisibility() {
  // hide()→show() บน Windows ทำ forward ของ setIgnoreMouseEvents พัง (เมาส์ทะลุถาวร ลากไม่ได้) → ตอนโชว์สร้างหน้าต่างใหม่แทน
  for (const p of pets.values()) {
    if (p.win.isDestroyed()) continue;
    if (!shown()) { p.win.hide(); continue; }
    const old = p.win; createWindow(p, old.getPosition()[0]); old.destroy();
  }
  if (!shown() && panel && !panel.isDestroyed()) panel.close();
}
const setHidden = (on) => { hidden = on; applyVisibility(); };

// แอปเต็มจอ (หนัง/เกม/พรีเซนต์) → ซ่อนตัวละครและงดเสียง; fullscreen.ps1 พิมพ์ 1/0 ทุกครั้งที่สถานะเปลี่ยน
let fsWatcher = null, quitting = false;
function watchFullscreen() {
  if (process.platform !== 'win32') return;
  fsWatcher = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fullscreen.ps1'), String(process.pid)],
    { windowsHide: true });
  fsWatcher.stdout.on('data', (b) => {
    const on = String(b).trim().split(/\s+/).pop() === '1';
    if (on !== fullscreen) { fullscreen = on; applyVisibility(); }
  });
  fsWatcher.on('exit', () => { if (!quitting) setTimeout(watchFullscreen, 10e3); });   // ตายเองก็เปิดใหม่
}

function notify(title, body) {
  if (!cfg.notify || dndEnd() || !Notification.isSupported()) return;
  new Notification({ title, body, silent: cfg.sound }).show();   // มีเสียงของเราเองแล้ว ไม่ต้องติ๊งของ Windows ซ้อน
}

// เสียงเล่นในหน้าต่างตัวละครของแชทนั้น (WebAudio) — kind: done | attention | warn
function sound(sid, kind) {
  if (!cfg.sound || dndEnd() || fullscreen) return;
  const pet = pets.get(sid) || pets.values().next().value;
  if (pet && !pet.win.isDestroyed()) pet.win.webContents.send('sound', kind);
}

const STALL_MS = 5 * 60e3, STALL_IN_TOOL_MS = 20 * 60e3;   // เงียบนานเท่านี้ = อาจค้าง (คำสั่งยาวๆ ให้เวลามากกว่า)
const CTX_WARN = [90, 80];

function readQuota(v) {
  const conv = q => q && q.used_percentage != null
    ? { pct: Number(q.used_percentage), resetsAt: q.resets_at ? Number(q.resets_at) * 1000 : null } : null;
  if (v.five_hour) quota.five = conv(v.five_hour);
  if (v.seven_day) quota.week = conv(v.seven_day);
  quota.at = Date.now();
  if (v.session_id && v.cost != null) costs.set(v.session_id, { usd: Number(v.cost), day: today() });
  const s = sessions.get(v.session_id);
  if (s && v.ctx != null) {
    s.ctx = Math.round(Number(v.ctx));
    if (s.ctx < 50) s.ctxWarned = 0;              // compact แล้ว เตือนใหม่ได้
    for (const lvl of CTX_WARN) {
      if (s.ctx >= lvl && s.ctxWarned < lvl) {
        s.ctxWarned = lvl;
        sayTo(s, T.ctxBubble(s.ctx, lvl >= 90), 15);
        sound(v.session_id, 'warn');
        if (lvl >= 90) notify(T.ctxTitle(s.proj || 'Claude', s.ctx), T.ctxBody);
        break;
      }
    }
  }
  for (const [q, name] of [[quota.five, T.quota5h], [quota.week, T.quotaWeek]]) {
    if (q && q.pct >= WARN_PCT && q.resetsAt && warned !== q.resetsAt) {
      warned = q.resetsAt;
      sound(null, 'warn');
      sayAll(T.quotaBubble(name, Math.round(q.pct)), 10);
      notify(T.quotaTitle(name, Math.round(q.pct)),
        T.quotaBody(new Date(q.resetsAt).toLocaleString(app.getLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })));
    }
  }
}

function handle(v) {
  const name = v.event || '';
  if (name === 'Quota') return readQuota(v);
  const now = Date.now();
  const sid = v.session_id || 'default';
  if (name === 'SessionEnd') { sessions.delete(sid); return; }
  // Notification มีสองแบบ: ขออนุญาต (สำคัญ) กับ "waiting for your input" หลังว่าง 60 วิ (ซ้ำกับ Stop — ข้าม)
  if (name === 'Notification' && /waiting for your input/i.test(v.message || '')) return;
  let s = sessions.get(sid);
  if (!s) sessions.set(sid, s = newSession(now));
  if (name === 'Pid') { s.pid = Number(v.pid) || null; return; }
  s.lastSeen = now;
  if (s.stallWarned) { s.stallWarned = false; if (s.bubble && s.bubble.startsWith(T.stallPrefix)) s.bubble = null; }
  if (v.project) s.proj = v.project;
  const proj = s.proj || 'Claude';

  switch (name) {
    case 'UserPromptSubmit':
      if (s.base !== 'working') s.since = now;
      s.base = 'working'; s.doneUntil = 0; s.inTool = false;
      s.bubble = null; s.toolNote = null;
      break;
    case 'PreToolUse': {
      if (s.base !== 'working') { s.base = 'working'; s.since = now; }
      s.inTool = true;
      const tool = v.tool || '', input = v.tool_input || {};
      if (tool === 'Agent' || tool === 'Task') s.agents.push(now + 30 * 60e3);
      else if (tool) { s.toolNote = friendlyTool(tool, input); s.toolUntil = now + 10e3; }
      if (input.run_in_background) s.bg.push(now + 15 * 60e3);
      log.unshift(`${new Date().toTimeString().slice(0, 8)}  ${proj} · ${tool}${v.detail ? ' · ' + snippet(v.detail, 30) : ''}`);
      log.length = Math.min(log.length, 8);
      break;
    }
    case 'PostToolUse':
      s.inTool = false;
      if (v.tool_error) s.oopsUntil = now + 4e3;
      break;
    case 'Stop': {
      const worked = s.base === 'working' ? Math.round((now - s.since) / 1000) : 0;
      const level = worked >= 600 ? 2 : worked >= 60 ? 1 : 0;
      const dwell = level === 2 ? 20 : 12;
      s.base = 'done'; s.since = now; s.doneUntil = now + dwell * 1000; s.inTool = false;
      s.celebrate = Math.max(s.celebrate, level);
      sound(sid, 'done');
      const head = T.doneHead(worked >= 60 ? Math.round(worked / 60) : 0);
      const msg = snippet(v.last_message, 40);
      sayTo(s, msg ? `${head}: ${msg}` : head + '!', dwell);
      s.toolNote = null;
      if (worked >= 30) notify(T.doneTitle(proj), snippet(v.last_message, 80) || T.doneBody);
      setTimeout(scanUsage, 3000);
      break;
    }
    case 'Notification':
      if (s.base !== 'attention') s.since = now;
      s.base = 'attention'; s.doneUntil = 0;
      s.toolNote = null;
      sayTo(s, T.waiting(proj), 30);
      sound(sid, 'attention');
      notify(T.waiting(proj), snippet(v.message, 80) || T.waitingBody);
      break;
    case 'SessionStart':
      sayTo(s, T.sessionStart(proj), 6);
      break;
    case 'SubagentStop':
      s.agents.pop();
      break;
  }
}

// อัปเดตเวลาหมดอายุของทุก session (เรียกทุก tick)
function expire(now) {
  for (const [id, s] of sessions) {
    if (s.base === 'done' && now > s.doneUntil) { s.base = 'idle'; s.since = now; s.celebrate = 0; }
    // ทำงานอยู่แต่เงียบนานผิดปกติ = อาจค้าง (เตือนครั้งเดียว event ถัดไปล้างเอง)
    const quiet = now - s.lastSeen;
    if (s.base === 'working' && !s.stallWarned && quiet > (s.inTool ? STALL_IN_TOOL_MS : STALL_MS)) {
      s.stallWarned = true;
      const min = Math.round(quiet / 60e3);
      sayTo(s, T.stallBubble(min), 600);
      sound(id, 'warn');
      notify(T.stallTitle(s.proj || 'Claude', min), s.inTool ? T.stallInTool : T.stallIdle);
    }
    if (s.base === 'working' && quiet > 30 * 60e3) s.base = 'idle';   // ค้างเพราะพลาด Stop
    if (s.base === 'idle' && now - s.lastSeen > 2 * 3600e3) sessions.delete(id);  // แชทที่ปิดไปโดยไม่มี SessionEnd
    if (s.bubble && now > s.bubbleUntil) s.bubble = null;
    if (s.toolNote && now > s.toolUntil) s.toolNote = null;
    s.agents = s.agents.filter(t => t > now);
    s.bg = s.bg.filter(t => t > now);
  }
  if (idleBubble.text && now > idleBubble.until) idleBubble.text = null;
}

// ปิดหน้าต่างเทอร์มินัลทิ้ง (ไม่ได้ /exit) = ไม่มี SessionEnd → ดูว่า claude.exe ของแชทยังอยู่ไหม ตายแล้วลบตัวทันที
function reapDead() {
  for (const [id, s] of sessions) {
    if (!s.pid) continue;
    try { process.kill(s.pid, 0); } catch (e) { if (e.code === 'ESRCH') sessions.delete(id); }
  }
}

function frameFor(pet, now) {
  const s = sessions.get(pet.key);
  const spent = [quota.five, quota.week].find(q => q && q.pct >= 100 && (!q.resetsAt || q.resetsAt > now));
  const base = {
    warn: [quota.five, quota.week].some(q => q && q.pct >= WARN_PCT && q.pct < 100),
    resetSecs: spent && spent.resetsAt ? Math.round((spent.resetsAt - now) / 1000) : null,
    dragging: !!pet.drag, label: s ? s.proj || 'Claude' : '', hue: pet.hue, ctx: s ? s.ctx : null,
  };
  if (!s) return { ...base, state: spent ? 'limit' : 'idle', bubble: idleBubble.text };
  const secs = Math.round((now - s.since) / 1000);
  return {
    ...base,
    state: s.base === 'idle' && spent ? 'limit' : s.base,
    bubble: s.bubble,
    sessions: 0, workSecs: s.base === 'working' ? secs : 0, attnSecs: s.base === 'attention' ? secs : 0,
    toolNote: s.base === 'working' ? s.toolNote : null,
    celebrate: s.base === 'done' ? s.celebrate : 0, oops: now < s.oopsUntil,
    bgCount: s.bg.length, agentCount: s.agents.length,
  };
}

// ---------- token จาก log ในเครื่อง (อ่านใน worker thread ไม่ให้ main ค้าง) ----------
const usageWorker = new Worker(path.join(__dirname, 'usage-worker.js'));
let usage = { today: 0, week: 0, hourly: [] };
usageWorker.on('message', (m) => { usage = m; });
const scanUsage = () => usageWorker.postMessage('scan');

function stats() {
  const now = Date.now();
  const cost = [...costs.values()].filter(c => c.day === today()).reduce((a, c) => a + c.usd, 0);
  const order = { attention: 0, working: 1, done: 2, idle: 3 };
  const list = [...sessions.entries()].map(([id, s]) => ({
    proj: s.proj || id.slice(0, 8), base: s.base, secs: Math.round((now - s.since) / 1000),
    hue: pets.has(id) ? pets.get(id).hue : null,
  })).sort((a, b) => order[a.base] - order[b.base]);
  return { lang: T === STRINGS.th ? 'th' : 'en', quota, today: usage.today, week: usage.week, hourly: usage.hourly, cost, sessions: list };
}

// ---------- ตัวละคร: หน้าต่างละตัว ----------
const pets = new Map();                          // key (session_id | IDLE_KEY) → Pet
const size = () => ({ w: Math.round(W0 * cfg.scale), h: Math.round(H0 * cfg.scale) });
const floorY = (x) => {
  const { w } = size();
  const wa = screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: 0 }).workArea;
  return wa.y + wa.height - Math.round(GROUND * cfg.scale);
};
const petOf = (sender) => [...pets.values()].find(p => !p.win.isDestroyed() && p.win.webContents === sender);

function spawnX() {
  const { w } = size();
  const wa = screen.getPrimaryDisplay().workArea;
  if (!pets.size) return cfg.x != null ? cfg.x : wa.x + wa.width - w - 60;
  // ต่อแถวไปทางซ้ายของตัวที่อยู่ซ้ายสุด ล้นจอก็วนกลับไปขวา
  const left = Math.min(...[...pets.values()].map(p => p.win.getPosition()[0]));
  const x = left - Math.round(w * 0.55);
  return x < wa.x ? wa.x + wa.width - w - 60 : x;
}

// สีที่จำไว้ใช้ชื่อโปรเจกต์ (ชื่อโฟลเดอร์) เป็นกุญแจ — session id เปลี่ยนทุกแชท แต่โฟลเดอร์เดิม
const colorKey = (key) => key === IDLE_KEY ? IDLE_KEY : (sessions.get(key) || {}).proj || null;
const savedHue = (key) => { const k = colorKey(key); return k && cfg.colors[k] != null ? cfg.colors[k] : null; };

const usedHues = (except) => new Set([...pets.values()].filter(p => p !== except).map(p => p.hue));

// สีที่จำไว้ของโฟลเดอร์นี้ ถ้ายังว่าง; ไม่งั้นสีแรกที่ยังไม่มีใครใช้ (เกิน 12 แชทถึงจะยอมซ้ำ)
function pickHue(key, except) {
  const used = usedHues(except), saved = savedHue(key);
  if (saved != null && !used.has(saved)) return saved;
  return HUES.find(h => !used.has(h)) ?? HUES[used.size % HUES.length];
}

function createPet(key) {
  const hue = pickHue(key, null);
  const pet = { key, hue, drag: null, fall: null };
  createWindow(pet, spawnX());
  pets.set(key, pet);
  return pet;
}

function createWindow(pet, x) {
  const { w, h } = size();
  pet.win = new BrowserWindow({
    width: w, height: h, x, y: floorY(x), transparent: true, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false,
                      autoplayPolicy: 'no-user-gesture-required' },   // ให้ WebAudio เล่นเสียงแจ้งเตือนได้โดยไม่ต้องคลิกก่อน
  });
  pet.win.setAlwaysOnTop(true, 'screen-saver');
  pet.win.setIgnoreMouseEvents(true, { forward: true });   // เรียกครั้งเดียวตอนสร้าง (เรียกซ้ำแล้ว forward พัง)
  loadPet(pet);
  pet.win.once('ready-to-show', () => { if (shown()) pet.win.showInactive(); });
}
const loadPet = (pet) => pet.win.loadFile(path.join(__dirname, 'index.html'), { query: { skin: cfg.skin, scale: String(cfg.scale) } });

function rekey(pet, key) {
  pets.delete(pet.key); pet.key = key; pets.set(key, pet);
  const saved = savedHue(key);
  if (saved != null && !usedHues(pet).has(saved)) pet.hue = saved;
}

// ให้จำนวนตัวตรงกับแชทที่เปิดอยู่: แชทใหม่ = ตัวใหม่, แชทหาย = ตัวหาย, ไม่มีแชท = เหลือตัวยืนรอหนึ่งตัว
function syncPets() {
  for (const key of sessions.keys()) {
    if (pets.has(key)) continue;
    const idle = pets.get(IDLE_KEY);
    if (idle) rekey(idle, key);                  // ตัวที่ยืนรอรับงานแชทแรกไปเลย ไม่ต้องสร้างใหม่
    else createPet(key);
  }
  for (const pet of [...pets.values()]) {
    if (pet.key === IDLE_KEY || sessions.has(pet.key) || pet.drag) continue;
    if (pets.size === 1) rekey(pet, IDLE_KEY);   // ตัวสุดท้ายไม่หาย กลับไปยืนรอ
    else { pets.delete(pet.key); pet.win.destroy(); }
  }
  if (!pets.size) createPet(IDLE_KEY);
}

function setBounds(pet, x, y) {
  const { w, h } = size();
  pet.win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
}

// ---------- แผงสถิติ ----------
let panel = null;
function togglePanel(pet) {
  if (panel && !panel.isDestroyed()) { panel.close(); return; }
  const [px, py] = pet.win.getPosition(), { w } = size();
  const wa = screen.getDisplayNearestPoint({ x: px + w / 2, y: py }).workArea;
  const x = Math.min(Math.max(px + w / 2 - PANEL_W / 2, wa.x + 8), wa.x + wa.width - PANEL_W - 8);
  const y = Math.max(wa.y + 8, py + Math.round(40 * cfg.scale) - PANEL_H);
  panel = new BrowserWindow({
    width: PANEL_W, height: PANEL_H, x: Math.round(x), y: Math.round(y), frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#0b0c0e',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.loadFile(path.join(__dirname, 'panel.html'));
  // show() เฉยๆ จะไม่ขึ้นเพราะ Windows ห้ามแอปเบื้องหลังแย่งโฟกัส → โชว์แบบไม่แย่งก่อนแล้วค่อยขอโฟกัส
  panel.webContents.once('did-finish-load', () => { panel.showInactive(); panel.focus(); pushStats(); });
  panel.on('blur', () => { if (panel && !panel.isDestroyed()) panel.close(); });
}
const pushStats = () => { if (panel && !panel.isDestroyed()) panel.webContents.send('stats', stats()); };
ipcMain.on('panel-close', () => { if (panel && !panel.isDestroyed()) panel.close(); });

// ---------- เมาส์ ----------
ipcMain.on('hit', (e, on) => {
  const pet = petOf(e.sender);
  if (pet && !pet.drag) pet.win.setIgnoreMouseEvents(!on, { forward: true });
});

ipcMain.on('drag-start', (e) => {
  const pet = petOf(e.sender);
  if (!pet) return;
  const c = screen.getCursorScreenPoint(), [wx, wy] = pet.win.getPosition();
  pet.fall = null;
  const d = pet.drag = { ox: c.x - wx, oy: c.y - wy, sx: c.x, sy: c.y, moved: false, t0: Date.now(), hist: [[Date.now(), c.x, c.y]] };
  d.timer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (!d.moved && Math.abs(p.x - d.sx) + Math.abs(p.y - d.sy) > 4) d.moved = true;
    if (d.moved) setBounds(pet, p.x - d.ox, p.y - d.oy);
    d.hist.push([Date.now(), p.x, p.y]);
    if (d.hist.length > 8) d.hist.shift();
    if (Date.now() - d.t0 > 60e3) endDrag(pet);   // กันค้าง: ลากนานเกิน 1 นาที ปล่อยเอง
  }, 16);
});
ipcMain.on('drag-end', (e) => { const pet = petOf(e.sender); if (pet) endDrag(pet); });

// คลิกตัวละคร = เด้งหน้าต่างของแชทนั้นขึ้นมา (ไล่จาก claude.exe ขึ้นไปหาเทอร์มินัล); หาไม่เจอ = เปิดแผงสถิติแทน
function focusChat(pet) {
  const s = sessions.get(pet.key);
  if (!s || !s.pid) { togglePanel(pet); return; }
  if (pet.focusing) return;   // ดับเบิลคลิก = สคริปต์สองตัวแย่งเปลี่ยนชื่อแท็บกัน → รอตัวแรกจบก่อน
  pet.focusing = true;
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'focus.ps1'), String(s.pid)],
    { timeout: 5000, windowsHide: true }, (err, out) => {
      pet.focusing = false;
      if (err || !String(out).startsWith('focused')) { s.pid = null; s.pidAsked = false; togglePanel(pet); }   // claude.exe ตายแล้ว → ขอ pid ใหม่รอบหน้า
    });
}

function endDrag(pet) {
  const d = pet.drag;
  if (!d) return;
  clearInterval(d.timer);
  pet.drag = null;
  if (!d.moved) { focusChat(pet); return; }
  const now = Date.now(), recent = d.hist.filter(h => now - h[0] < 100);
  const a = recent[0] || d.hist[d.hist.length - 1], b = d.hist[d.hist.length - 1];
  const dt = Math.max(16, b[0] - a[0]);
  const [x, y] = pet.win.getPosition();
  pet.fall = { x, y, vx: (b[1] - a[1]) / dt * 16, vy: (b[2] - a[2]) / dt * 16 };
}

function physics(pet) {
  const f = pet.fall;
  if (!f || pet.drag) return;
  const { w } = size();
  f.vy += 1.6; f.vx *= 0.98;
  f.x += f.vx; f.y += f.vy;
  const d = screen.getDisplayNearestPoint({ x: Math.round(f.x + w / 2), y: Math.round(f.y) }).workArea;
  const minX = d.x - w * 0.3, maxX = d.x + d.width - w * 0.7;
  if (f.x < minX || f.x > maxX) { f.x = Math.min(Math.max(f.x, minX), maxX); f.vx = -f.vx * 0.4; }
  const fy = floorY(f.x);
  if (f.y >= fy) {
    f.y = fy;
    if (f.vy > 14) { f.vy = -f.vy * 0.35; sayPet(pet, T.ouch, 1.5); }
    else { setBounds(pet, f.x, f.y); pet.fall = null; if (pets.size === 1) { cfg.x = Math.round(f.x); saveCfg(); } return; }
  }
  setBounds(pet, f.x, f.y);
}

const atLogin = () => app.getLoginItemSettings(LOGIN).openAtLogin;
const setLogin = (on) => app.setLoginItemSettings({ ...LOGIN, openAtLogin: on });

ipcMain.on('menu', (e) => {
  const pet = petOf(e.sender);
  if (!pet) return;
  const M = T.menu, pokes = cfg.rude ? T.rudePokes : T.pokes;
  const end = dndEnd(), hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
  const m = Menu.buildFromTemplate([
    { label: M.panel, click: () => togglePanel(pet) },
    { label: M.recent, click: () => sayPet(pet, log.length ? log.slice(0, 3).join('  /  ') : T.nothingYet, 8) },
    { label: M.poke, click: () => sayPet(pet, pokes[Math.floor(Math.random() * pokes.length)], 3) },
    { type: 'separator' },
    { label: M.hide(HOTKEY_LABEL), click: () => setHidden(true) },
    { label: end ? M.dndActive(hhmm(end)) : M.dnd, submenu: [
      { label: M.dndOff, enabled: cfg.dndUntil > Date.now(), click: () => setDnd(0, cfg.dndNightly) },
      { label: M.dnd1h, click: () => setDnd(Date.now() + 3600e3, cfg.dndNightly) },
      { label: M.dndMorning, click: () => setDnd(next8am(), cfg.dndNightly) },
      { type: 'separator' },
      { label: M.dndNightly, type: 'checkbox', checked: cfg.dndNightly, click: (i) => setDnd(cfg.dndUntil, i.checked) },
    ] },
    { type: 'separator' },
    { label: M.color, submenu: HUES.map((h, i) => ({
      label: usedHues(pet).has(h) ? `${T.colors[i]} (${M.colorUsed})` : T.colors[i], type: 'radio', checked: pet.hue === h,
      enabled: !usedHues(pet).has(h),
      click: () => {
        pet.hue = h;
        const k = colorKey(pet.key);
        if (k) { cfg.colors[k] = h; saveCfg(); }   // จำไว้ เปิดแชทโฟลเดอร์นี้ครั้งหน้าได้สีเดิม
      } })) },
    { label: M.skin, submenu: SKIN_IDS.map((id) => ({ label: T.skins[id], type: 'radio', checked: cfg.skin === id,
      click: () => { cfg.skin = id; saveCfg(); for (const p of pets.values()) loadPet(p); } })) },
    { label: M.size, submenu: SCALES.map((s, i) => ({ label: T.scales[i], type: 'radio', checked: cfg.scale === s,
      click: () => {
        cfg.scale = s; saveCfg();
        for (const p of pets.values()) { const old = p.win; createWindow(p, old.getPosition()[0]); old.destroy(); }
      } })) },
    { label: M.notify, type: 'checkbox', checked: cfg.notify, click: (i) => { cfg.notify = i.checked; saveCfg(); } },
    { label: M.sound, type: 'checkbox', checked: cfg.sound, click: (i) => { cfg.sound = i.checked; saveCfg(); if (i.checked) sound(pet.key, 'done'); } },
    { label: M.rude, type: 'checkbox', checked: cfg.rude, click: (i) => { cfg.rude = i.checked; saveCfg(); } },
    { label: M.login, type: 'checkbox', checked: atLogin(), click: (i) => setLogin(i.checked) },
    { type: 'separator' },
    { label: M.quit, click: () => app.quit() },
  ]);
  m.popup({ window: pet.win });
});

// ---------- hook server ----------
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/event') { res.writeHead(404); return res.end(); }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let v = null;
    try { v = JSON.parse(body); handle(v); } catch {}
    // แชทที่ยังไม่รู้ pid ของ claude.exe → บอก hook ให้หาแล้วส่งกลับมา (ทำครั้งเดียวต่อแชท)
    const s = v && v.event !== 'Quota' && v.event !== 'Pid' && v.event !== 'SessionEnd' && sessions.get(v.session_id);
    res.end(s && !s.pid && !s.pidAsked ? (s.pidAsked = true, 'need-pid') : 'ok');
  });
});
// พอร์ตชน = โปรแกรมอื่นจองไว้ (KungWatch ตัวที่สองโดน single-instance lock กันไปแล้ว) → บอกให้รู้ ไม่ปิดเงียบ
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') dialog.showErrorBox(T.portTitle, T.portBody(PORT));
  app.quit();
});

// กด shortcut ซ้ำตอนเปิดอยู่แล้ว = เรียกตัวที่ซ่อนอยู่กลับมาด้วย
app.on('second-instance', () => { if (hidden) setHidden(false); sayAll(T.here, 3); });
app.on('will-quit', () => { quitting = true; globalShortcut.unregisterAll(); if (fsWatcher) fsWatcher.kill(); });

app.whenReady().then(() => {
  T = STRINGS[cfg.lang || (app.getLocale().startsWith('th') ? 'th' : 'en')] || STRINGS.en;
  server.listen(PORT, '127.0.0.1');
  syncPets();
  scanUsage();
  globalShortcut.register(HOTKEY, () => setHidden(!hidden));
  watchFullscreen();
  setInterval(reapDead, 10e3);
  setInterval(scanUsage, 60e3);
  setInterval(() => { for (const p of pets.values()) physics(p); }, 16);
  setInterval(() => {
    const now = Date.now();
    expire(now);
    syncPets();
    for (const p of pets.values()) if (!p.win.isDestroyed()) p.win.webContents.send('state', frameFor(p, now));
  }, 100);
  setInterval(pushStats, 1000);
  setInterval(() => { if (shown()) for (const p of pets.values()) if (!p.win.isDestroyed()) p.win.setAlwaysOnTop(true, 'screen-saver'); }, 5000);
});
app.on('window-all-closed', () => { if (!pets.size) app.quit(); });
