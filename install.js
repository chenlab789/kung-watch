// ติดตั้ง KungWatch: npm install + ลง hook/statusLine ใน ~/.claude/settings.json (สำรองไฟล์เดิมก่อน) + shortcut บนเดสก์ท็อป
// ใช้: node install.js [--settings <path>] [--no-shortcut] [--skip-npm]
const fs = require('fs'), path = require('path'), os = require('os'), { execSync } = require('child_process');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const ROOT = __dirname;
const fwd = (p) => p.replace(/\\/g, '/');
const HOOK = `node "${fwd(path.join(ROOT, 'hook.js'))}"`;
const BRIDGE = `node "${fwd(path.join(ROOT, 'statusline-bridge.js'))}"`;
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'Notification', 'SubagentStop', 'SessionStart', 'SessionEnd'];
const SETTINGS = opt('--settings') || path.join(os.homedir(), '.claude', 'settings.json');

if (process.platform !== 'win32') console.warn('! KungWatch is built for Windows — other platforms are untested.');

// 1) dependencies
if (!flag('--skip-npm')) {
  console.log('> npm install (Electron, ~100 MB)…');
  execSync('npm install --no-audit --no-fund', { cwd: path.join(ROOT, 'app'), stdio: 'inherit' });
}

// 2) settings.json
let s = {};
if (fs.existsSync(SETTINGS)) {
  const backup = `${SETTINGS}.bak-kungwatch-${Date.now()}`;
  fs.copyFileSync(SETTINGS, backup);
  console.log(`> backed up settings → ${backup}`);
  s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
} else {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
}
s.hooks = s.hooks || {};
let added = 0;
for (const ev of EVENTS) {
  s.hooks[ev] = s.hooks[ev] || [];
  if (JSON.stringify(s.hooks[ev]).includes('kung-watch') || JSON.stringify(s.hooks[ev]).includes(fwd(path.join(ROOT, 'hook.js')))) continue;
  s.hooks[ev].push({ hooks: [{ type: 'command', command: HOOK, timeout: 5 }] });
  added++;
}
console.log(`> hooks: added ${added}, already present ${EVENTS.length - added}`);

const cur = s.statusLine && s.statusLine.command;
if (!cur) {
  s.statusLine = { type: 'command', command: BRIDGE, padding: 0 };
  console.log('> statusLine: set to KungWatch bridge');
} else if (cur.includes('statusline-bridge.js')) {
  console.log('> statusLine: bridge already installed');
} else {
  s.statusLine.command = `${BRIDGE} ${cur}`;
  console.log('> statusLine: wrapped your existing statusline (output unchanged)');
}
fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));

// 3) shortcut บนเดสก์ท็อป
if (!flag('--no-shortcut') && !opt('--settings') && process.platform === 'win32') {
  const exe = path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'electron.exe');
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'KungWatch.lnk'));`
    + `$s.TargetPath='${exe}';$s.Arguments='"${path.join(ROOT, 'app')}"';$s.WorkingDirectory='${path.join(ROOT, 'app')}';`
    + `$s.IconLocation='${path.join(ROOT, 'app', 'icon.ico')},0';$s.Save()`;
  try { execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`); console.log('> desktop shortcut created'); }
  catch { console.warn('! could not create desktop shortcut'); }
}

console.log('\nDone. Start it with start.vbs (or the desktop shortcut), then restart Claude Code or run /hooks.');
console.log('Right-click a pet → "Start at login" to launch it automatically.');
