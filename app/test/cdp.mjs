// Headless Chrome driver: no visible window, nothing in the user's own Chrome.
//   node cdp.mjs URL [--wait MS] [--size W,H] [--eval 'async function body; return value']... [--shot OUT.png]
// Prints one JSON object: {evals:[…], console:[errors/warnings], exceptions:[…]}.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const a = process.argv.slice(2);
const url = a[0];
const evals = []; let shot = null, wait = 1500, size = '1440,900';
for (let i = 1; i < a.length; i++) {
  if (a[i] === '--eval') evals.push(a[++i]);
  else if (a[i] === '--shot') shot = a[++i];
  else if (a[i] === '--wait') wait = +a[++i];
  else if (a[i] === '--size') size = a[++i];
}
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = mkdtempSync(join(tmpdir(), 'texc-cdp-'));
const port = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${size}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { evals: [], console: [], exceptions: [] };
let ws, seq = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function main() {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = l.find((t) => t.type === 'page'); } catch (_) {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('headless Chrome did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let loaded = null; const loadP = new Promise((r) => (loaded = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); return; }
    if (d.method === 'Page.loadEventFired') loaded();
    if (d.method === 'Runtime.consoleAPICalled' && /error|warn/.test(d.params.type))
      out.console.push(`${d.params.type}: ` + d.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
    if (d.method === 'Runtime.exceptionThrown') out.exceptions.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url });
  await Promise.race([loadP, sleep(15000)]);
  await sleep(wait);
  for (const body of evals) {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 60000 });
    out.evals.push(r.exceptionDetails ? { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text } : { value: r.result.value });
  }
  if (shot) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(shot, Buffer.from(r.data, 'base64')); out.shot = shot; }
}
main().then(() => 0, (e) => { out.error = String(e && e.message || e); return 1; }).then((rc) => {
  console.log(JSON.stringify(out, null, 1));
  try { ws && ws.close(); } catch (_) {}
  chrome.kill('SIGKILL');
  setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch (_) {} process.exit(rc); }, 300);
});
