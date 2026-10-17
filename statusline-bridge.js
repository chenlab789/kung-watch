// statusLine ของ Claude Code → ส่ง % โควตา / context / ค่าใช้จ่าย ไปให้ KungWatch (:7788)
// ใช้ได้ 2 แบบ:
//   node statusline-bridge.js                       → แสดงบรรทัดสั้นๆ ของเราเอง
//   node statusline-bridge.js <คำสั่ง statusline เดิม> → ส่งข้อมูลให้แอป แล้วแสดงผลของ statusline เดิมตามปกติ
const http = require('http'), { spawn } = require('child_process');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let json = null;
  try { json = JSON.parse(input); } catch {}
  if (json) send(json);
  const wrapped = process.argv.slice(2).join(' ');
  if (wrapped) {
    const child = spawn(wrapped, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(input);
    child.on('exit', () => {});
  } else if (json) {
    process.stdout.write(line(json) + '\n');
  }
});

function line(json) {
  const parts = [];
  const model = json.model && json.model.display_name;
  if (model) parts.push(model);
  const ctx = json.context_window && json.context_window.used_percentage;
  if (ctx != null) parts.push(`ctx ${Math.round(ctx)}%`);
  const rl = json.rate_limits || {};
  if (rl.five_hour && rl.five_hour.used_percentage != null) parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl.seven_day && rl.seven_day.used_percentage != null) parts.push(`wk ${Math.round(rl.seven_day.used_percentage)}%`);
  return parts.join(' | ');
}

function send(json) {
  const rl = json.rate_limits || {};
  const cwd = (json.workspace && json.workspace.current_dir) || '';
  const body = JSON.stringify({
    event: 'Quota',
    session_id: json.session_id,
    project: cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop(),
    five_hour: rl.five_hour || null,
    seven_day: rl.seven_day || null,
    cost: json.cost && json.cost.total_cost_usd,
    ctx: json.context_window && json.context_window.used_percentage,
  });
  const req = http.request({
    host: '127.0.0.1', port: 7788, path: '/event', method: 'POST', timeout: 150,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => res.resume());
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}
