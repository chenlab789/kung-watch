// อ่าน token จาก log ของ Claude Code ใน worker thread — ถ้าทำใน main process ไฟล์ใหญ่จะทำ main ค้าง
// แล้ว Windows ถอด mouse hook ของ Electron ทิ้ง (คลิก/ลากตัวละครไม่ได้อีกเลย)
const { parentPort } = require('worker_threads');
const fs = require('fs'), path = require('path'), os = require('os');

const HORIZON = 8 * 86400e3;
const offsets = new Map();                       // file → byte ที่อ่านถึงแล้ว (อ่านต่อจากเดิม ไม่อ่านซ้ำ)
const seen = new Map();                          // message id → ts (กันนับซ้ำ)
let rows = [];                                   // {ts, tok}

async function scan() {
  const since = Date.now() - HORIZON;
  const files = [];
  const walk = async (dir, depth) => {
    let ents = [];
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try { const st = await fs.promises.stat(p); if (st.mtimeMs > since) files.push([p, st.size]); } catch {}
      }
    }
  };
  await walk(path.join(os.homedir(), '.claude', 'projects'), 0);
  for (const [f, size] of files) {
    let off = offsets.get(f) || 0;
    if (size < off) off = 0;                     // ไฟล์ถูกเขียนใหม่
    while (off < size) {
      const len = Math.min(size - off, 8 << 20);
      const buf = Buffer.alloc(len);
      const fh = await fs.promises.open(f, 'r');
      try { await fh.read(buf, 0, len, off); } finally { await fh.close(); }
      const cut = buf.lastIndexOf(0x0a);         // เฉพาะบรรทัดที่เขียนจบแล้ว ที่เหลือรอรอบหน้า
      if (cut < 0) break;
      for (const line of buf.toString('utf8', 0, cut).split('\n')) {
        if (!line.includes('"usage"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const u = j.message && j.message.usage, ts = Date.parse(j.timestamp);
        if (!u || !(ts > since)) continue;
        const key = j.message.id ? j.message.id + ':' + (j.requestId || '') : j.uuid;
        if (key && seen.has(key)) continue;
        if (key) seen.set(key, ts);
        rows.push({ ts, tok: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
                          + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) });
      }
      off += cut + 1;
    }
    offsets.set(f, off);
  }
  rows = rows.filter(r => r.ts > since);
  for (const [k, ts] of seen) if (ts <= since) seen.delete(k);
}

function summary() {
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const top = Math.floor(now / 3600e3) * 3600e3 + 3600e3;
  const hourly = Array.from({ length: 24 }, (_, i) => ({ t: top - (24 - i) * 3600e3, tok: 0 }));
  let today = 0, week = 0;
  for (const r of rows) {
    if (r.ts >= midnight.getTime()) today += r.tok;
    if (r.ts >= now - 7 * 86400e3) week += r.tok;
    const i = 23 - Math.floor((top - 1 - r.ts) / 3600e3);
    if (i >= 0 && i < 24) hourly[i].tok += r.tok;
  }
  return { today, week, hourly };
}

let busy = false;
parentPort.on('message', async () => {
  if (busy) return;
  busy = true;
  try { await scan(); parentPort.postMessage(summary()); } catch {} finally { busy = false; }
});
