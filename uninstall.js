// ถอน KungWatch: เอา hook/statusLine bridge ออกจาก settings.json, ลบ shortcut และรายการเปิดตอนบูต
// ใช้: node uninstall.js [--settings <path>]
const fs = require('fs'), path = require('path'), os = require('os'), { execSync } = require('child_process');

const args = process.argv.slice(2);
const i = args.indexOf('--settings');
const SETTINGS = i >= 0 ? args[i + 1] : path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_FILE = path.join(__dirname, 'hook.js').replace(/\\/g, '/');

if (fs.existsSync(SETTINGS)) {
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  let removed = 0;
  for (const ev of Object.keys(s.hooks || {})) {
    const before = s.hooks[ev].length;
    s.hooks[ev] = s.hooks[ev].filter((h) => !JSON.stringify(h).includes(HOOK_FILE));
    removed += before - s.hooks[ev].length;
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  const cmd = s.statusLine && s.statusLine.command;
  if (cmd && cmd.includes('statusline-bridge.js')) {
    const rest = cmd.replace(/^node\s+"[^"]*statusline-bridge\.js"\s*/, '').trim();
    if (rest) s.statusLine.command = rest; else delete s.statusLine;
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
  console.log(`> removed ${removed} hook(s) and the statusLine bridge from ${SETTINGS}`);
}

// ระบุ --settings เอง (เช่นตอนเทสกับไฟล์จำลอง) = แตะแค่ไฟล์นั้น ไม่ลบ shortcut/Startup ของเครื่องจริง
if (process.platform === 'win32' && i < 0) {
  try { execSync(`powershell -NoProfile -Command "Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'KungWatch.lnk') -ErrorAction SilentlyContinue"`); } catch {}
  try { execSync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v KungWatch /f', { stdio: 'ignore' }); } catch {}
  console.log('> removed desktop shortcut and start-at-login entry');
}
console.log('Done. You can now delete this folder.');
