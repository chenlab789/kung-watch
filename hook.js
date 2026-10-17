// Claude Code hook: ส่ง event ไปที่ KungWatch (:7788) แบบตัดให้เล็ก — เงียบ และไม่บล็อกถ้าแอปไม่ได้เปิด
const http = require('http'), path = require('path'), { execFileSync } = require('child_process');
let killer = setTimeout(() => process.exit(0), 800);

const cut = (s, n) => (s == null ? undefined : String(s).slice(0, n));

function post(obj, done) {
  const body = JSON.stringify(obj);
  const req = http.request({
    host: '127.0.0.1', port: 7788, path: '/event', method: 'POST', timeout: 300,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => { let r = ''; res.on('data', c => r += c); res.on('end', () => done(r)); });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}

// หา pid ของ claude.exe ที่เป็นแม่ของ hook นี้ (ทำครั้งเดียวต่อแชท ตอนแอปขอ) — ใช้ตอนคลิกตัวละครเพื่อเด้งหน้าต่างแชท
function claudePid() {
  const ps = `$m=@{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | % { $m[[int]$_.ProcessId]=$_ };`
    + `$p=${process.ppid}; for($i=0;$i -lt 10 -and $m.ContainsKey($p);$i++){ if($m[$p].Name -match '^(claude|node)\\.exe$'){ $p; exit }; $p=[int]$m[$p].ParentProcessId }`;
  try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 2500 }).toString().trim()) || null; }
  catch { return null; }
}

let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  let d;
  try { d = JSON.parse(raw); } catch { process.exit(0); }
  const i = d.tool_input || {}, r = d.tool_response || {};
  let detail = '';
  if (i.file_path || i.notebook_path) detail = path.basename(i.file_path || i.notebook_path);
  else if (i.command) detail = String(i.command).split('\n')[0];
  else if (i.pattern) detail = i.pattern;
  else if (i.url) detail = String(i.url).replace(/^https?:\/\//, '');
  else if (i.query) detail = i.query;
  else if (i.description) detail = i.description;

  post({
    event: d.hook_event_name,
    session_id: d.session_id,
    project: d.cwd ? path.basename(d.cwd) : '',
    tool: d.tool_name || '',
    detail: cut(detail, 60),
    tool_input: { command: cut(i.command, 200), run_in_background: !!i.run_in_background },
    tool_error: !!(r.is_error || r.error || r.success === false),
    last_message: cut(d.last_assistant_message, 200),
    message: cut(d.message, 200),
  }, (reply) => {
    if (reply !== 'need-pid') process.exit(0);
    clearTimeout(killer);
    killer = setTimeout(() => process.exit(0), 3000);
    const pid = claudePid();
    if (!pid) process.exit(0);
    post({ event: 'Pid', session_id: d.session_id, pid }, () => process.exit(0));
  });
});
