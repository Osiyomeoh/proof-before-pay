// Walks the demo in headless Chrome at 390 px and 1280 px, in both colour schemes.
// Reports console errors, exceptions, failed requests and page overflow at each step, and exits 1 on any.
// Usage: npm run sample, then in another terminal: node scripts/check-ui.mjs [baseUrl]
// Set CHROME_PATH if Chrome isn't in the default macOS location. Screenshots go to .shots/ (gitignored).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHOTS = join(import.meta.dirname, '..', '.shots');
mkdirSync(SHOTS, { recursive: true });
const BASE = process.argv[2] ?? 'http://localhost:3000';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'pbp-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* still starting */ }
    await wait(250);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const problems = [];
let step = '';
const inFlight = new Set();
let lastActivity = Date.now();
ws.addEventListener('message', ({ data }) => {
  const m = JSON.parse(data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') { inFlight.add(m.params.requestId); lastActivity = Date.now(); }
  if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inFlight.delete(m.params.requestId); lastActivity = Date.now(); }
  if (m.method === 'Runtime.exceptionThrown') problems.push(`[${step}] exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`[${step}] console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  // The missing-hold step requests a hold that doesn't exist on purpose, and the browser logs that 404.
  if (m.method === 'Log.entryAdded' && !m.params.entry.url?.endsWith('/api/contracts/no-such-hold/view') && ['error', 'warning'].includes(m.params.entry.level)) problems.push(`[${step}] log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
});
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`${step}: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');

// Waits at least `ms` for animation, then until the network has been quiet for 300 ms, so a slow host can't fail a step.
const timings = [];
async function settle(ms) {
  const started = Date.now();
  await wait(ms);
  while (inFlight.size > 0 || Date.now() - lastActivity < 300) {
    if (Date.now() - started > 90_000) throw new Error(`${step}: network still busy after 90 s`);
    await wait(50);
  }
  return Date.now() - started;
}
async function open(url) {
  const started = Date.now();
  await send('Page.navigate', { url });
  await settle(900);
  timings.push(Date.now() - started - 300);
}
const measure = `(() => { const w = document.documentElement; const wide = [...document.querySelectorAll('body *')].filter((e) => { if (e.closest('.scroll') || e.closest('svg')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 0.5; }).slice(0, 4).map((e) => e.tagName + '.' + e.className); return { overflow: w.scrollWidth - innerWidth, wide, h1: document.querySelector('h1')?.textContent, labels: [...document.querySelectorAll('.chart text.end')].map((t) => { const b = t.getBBox(); return t.textContent + '@' + Math.round(b.x) + ',' + Math.round(b.y); }) }; })()`;
async function shot(name, full = true) {
  const metrics = full ? await send('Page.getLayoutMetrics') : null;
  const clip = full ? { x: 0, y: 0, width: metrics.result.cssContentSize.width, height: metrics.result.cssContentSize.height, scale: 1 } : undefined;
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}
const clickStop = (text) => run(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.startsWith(${JSON.stringify(text)})); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); })()`);
const clickSel = (sel) => run(`document.querySelector(${JSON.stringify(sel)}).click()`);

const results = [];
for (const [width, height, scheme] of [[390, 844, 'light'], [390, 844, 'dark'], [1280, 800, 'light'], [1280, 800, 'dark']]) {
  const tag = `${width}-${scheme}`;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  const record = async (name) => { step = `${tag} ${name}`; const m = await run(measure); results.push({ step, ...m }); await shot(`${tag}-${name}`); };

  await open(`${BASE}/`); await record('landing');
  await clickSel('.release.ready'); await settle(1500); await record('hold-oct12');
  await clickStop('Oct 22'); await settle(1200); await record('oct22');
  await clickStop('Oct 26'); await settle(1200); await record('oct26');
  await clickStop('Nov 19'); await settle(1200); await record('nov19-ready');
  await clickSel('.release.ready'); await settle(900); await record('released-m1');
  await clickStop('Dec 19'); await settle(1200); await record('dec19-ready');
  await clickSel('.release.ready'); await settle(900); await record('closed');

  await open(`${BASE}/`); await clickSel('.release.ready'); await settle(1200);
  await clickStop('Give the rest back'); await settle(200); await record('void-confirm');
  await clickStop('Return it'); await settle(900); await record('voided');
  await open(`${BASE}/c/no-such-hold`); await record('gone');

  // Hover the chart on the wide layout, to check the tooltip stays in bounds.
  await open(`${BASE}/`); await clickSel('.release.ready'); await settle(1200);
  const box = await run(`(() => { const r = document.querySelector('.chart svg').getBoundingClientRect(); window.scrollTo(0, r.top + scrollY - 40); const n = document.querySelector('.chart svg').getBoundingClientRect(); return { x: n.left, y: n.top, w: n.width }; })()`);
  await wait(150);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + box.w - 6, y: box.y + 90 });
  await wait(200); step = `${tag} tooltip`;
  const tip = await run(`(() => { const t = document.querySelector('.tip'); const r = t.getBoundingClientRect(); return { hidden: t.hidden, left: Math.round(r.left), right: Math.round(r.right), inner: innerWidth, text: t.textContent }; })()`);
  results.push({ step, tip });
  await shot(`${tag}-tooltip`, false);
}
for (const r of results) {
  if (r.overflow > 0 || r.wide?.length) problems.push(`[${r.step}] overflow ${r.overflow} ${r.wide ?? ''}`);
  if (r.tip && (r.tip.hidden || r.tip.left < 0 || r.tip.right > r.tip.inner)) problems.push(`[${r.step}] tooltip out of bounds`);
}
timings.sort((a, b) => a - b);
console.log(`${results.length} steps, ${problems.length} problems`);
console.log(`page load to network quiet: ${timings.length} loads, median ${timings[timings.length >> 1]} ms, slowest ${timings.at(-1)} ms`);
for (const problem of problems) console.log(problem);
ws.close();
chrome.kill();
await wait(300);
rmSync(profile, { recursive: true, force: true });
process.exit(problems.length === 0 ? 0 : 1);
