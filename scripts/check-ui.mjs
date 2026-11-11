// Walks the demo in headless Chrome at 390 px and 1280 px, in both colour schemes.
// Reports console errors, exceptions, failed requests and page overflow at each step, and exits 1 on any.
// Usage: npm run sample, then in another terminal: node scripts/check-ui.mjs [baseUrl]
// Set CHROME_PATH if Chrome isn't in the default macOS location. Screenshots go to .shots/ (gitignored).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHOTS = join(import.meta.dirname, '..', '.shots');
mkdirSync(SHOTS, { recursive: true });
const BASE = process.argv[2] ?? 'http://localhost:3000';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'pbp-chrome-'));
// Port 0 means Chrome picks a free port, so this run can't attach to a Chrome left over from another one.
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanUp() { chrome.kill(); }
process.on('exit', cleanUp);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
process.on('uncaughtException', (error) => { console.error(error); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error(error); process.exit(1); });

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const portFile = join(profile, 'DevToolsActivePort');
      if (!existsSync(portFile)) throw new Error('not ready');
      const port = readFileSync(portFile, 'utf8').split('\n')[0];
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
const inFlight = new Map();
let lastActivity = Date.now();
let expected404 = false;
let viewRequests = 0;
let explainRequests = 0;
let agentRequests = 0;
let writeRequests = 0;
ws.addEventListener('message', ({ data }) => {
  const m = JSON.parse(data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') { inFlight.set(m.params.requestId, m.params.request.url); lastActivity = Date.now(); if (m.params.request.url.endsWith('/view')) viewRequests += 1; if (m.params.request.url.endsWith('/explanation')) explainRequests += 1; if (m.params.request.url.endsWith('/agent')) agentRequests += 1; if (m.params.request.method !== 'GET') writeRequests += 1; }
  if (m.method === 'Fetch.requestPaused') send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"NOT_FOUND"}').toString('base64') });
  if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inFlight.delete(m.params.requestId); lastActivity = Date.now(); }
  if (m.method === 'Runtime.exceptionThrown') problems.push(`[${step}] exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`[${step}] console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  // The missing-hold step requests a hold that doesn't exist on purpose, and the browser logs that 404.
  if (m.method === 'Log.entryAdded' && !m.params.entry.url?.endsWith('/api/contracts/no-such-hold/view') && !(expected404 && m.params.entry.url?.endsWith('/view')) && ['error', 'warning'].includes(m.params.entry.level)) problems.push(`[${step}] log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
});
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`${step}: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
// The agent's Copy button writes to the clipboard, which needs a focused page and the permission.
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Browser.grantPermissions', { origin: new URL(BASE).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });

// Waits at least `ms` for animation, then until the network has been quiet for 300 ms, so a slow host can't fail a step.
const timings = [];
async function settle(ms) {
  const started = Date.now();
  await wait(ms);
  while (inFlight.size > 0 || Date.now() - lastActivity < 300) {
    if (Date.now() - started > 90_000) throw new Error(`${step}: network still busy after 90 s: ${[...inFlight.values()].join(', ') || 'no request open'}`);
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
// Polls the page until a condition holds. Play runs on its own timer, so the network never goes quiet for settle().
async function waitFor(expression, ms, what) {
  const started = Date.now();
  while (!(await run(expression))) {
    if (Date.now() - started > ms) { problems.push(`[${step}] ${what} after ${ms / 1000} s`); return false; }
    await wait(150);
  }
  return true;
}
// The two-rules band: its headline and line under it, and how its cells are filled.
const readRace = `(() => { const r = document.querySelector('.race'); if (!r) return null; const cells = (sel) => r.querySelectorAll(sel).length; return { h: r.querySelector('h2').textContent, sub: r.querySelector('.race-sub').textContent, bars: cells('.race-track.bars li:not(.future)'), future: cells('.race-track.bars li.future'), paid: cells('.race-track.lane li.paid'), ready: cells('.race-track.lane li.ready') }; })()`;
async function expectRace(h, sub) {
  const race = await run(readRace);
  if (race?.h !== h) problems.push(`[${step}] race headline "${race?.h}", expected "${h}"`);
  if (sub !== undefined && race?.sub !== sub) problems.push(`[${step}] race line "${race?.sub}", expected "${sub}"`);
  return race;
}
const AFTER_PAID = 'The one-good-day rule had paid on Oct 23. After that, Inverter 01 had 16 days under 30% of usual and 2 with no reading.';

// Reads the ledger's displayed rows and summary, and fails the run on anything impossible.
const readLedger = `(() => {
  const dateCells = [...document.querySelectorAll('.ledger-grid .ag-row .ag-cell[col-id="date"]')];
  const rowIndex = (cell) => Number(cell.closest('.ag-row').getAttribute('row-index'));
  const dates = dateCells.sort((a, b) => rowIndex(a) - rowIndex(b)).map((c) => c.textContent);
  const facts = Object.fromEntries([...document.querySelectorAll('.ledger-sum div')].map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]));
  const box = document.querySelector('.ledger-grid').getBoundingClientRect();
  const empties = [...document.querySelectorAll('.ledger-grid .ag-cell')].filter((c) => c.textContent === '').length;
  return { dates, facts, heading: document.querySelector('.ledger h2').textContent, chips: [...document.querySelectorAll('.ledger .chip')].map((b) => b.textContent), right: box.right, inner: innerWidth, nonced: document.querySelectorAll('style[nonce]').length, empties, judged: dateCells.filter((c) => c.closest('.ag-row').classList.contains('g-judged')).length };
})()`;
const ledgerFacts = [];
async function checkLedger(label, expectTop) {
  const l = await run(readLedger);
  ledgerFacts.push({ step: `${step} ${label}`, ...l });
  if (l.dates.length === 0) problems.push(`[${step}] ledger has no rows`);
  if (l.dates[0] !== expectTop) problems.push(`[${step}] ledger top row is ${l.dates[0]}, expected ${expectTop}`);
  if (Number(l.facts['Days shown']) <= 0) problems.push(`[${step}] ledger summary is empty`);
  if (l.right > l.inner + 0.5) problems.push(`[${step}] ledger wider than the page`);
  if (l.nonced === 0) problems.push(`[${step}] grid styles carry no nonce`);
  if (l.empties > 0) problems.push(`[${step}] ${l.empties} blank grid cells`);
  if (l.judged !== 7) problems.push(`[${step}] ${l.judged} judged rows, expected 7`);
  return l;
}

// PayPal's own record (the Agent Toolkit's get_order read) has to agree with the page at each money step.
// The AI agent card: which tools it called, what it proposes, and whether it drafted a message. It reads only, so the
// first three steps are always the same reads, and a ready day still leaves Release for the person to press.
const readAgent = `(() => { const a = document.querySelector('.agent'); if (!a) return null; return { label: a.querySelector('.label')?.textContent ?? '', steps: [...a.querySelectorAll('.tool-steps li')].map((li) => li.querySelector('code').textContent + (li.classList.contains('ok') ? '' : ':failed')), next: a.querySelector('.proposal b')?.textContent ?? '', draft: a.querySelector('.ask .draft')?.textContent ?? '', copy: !!a.querySelector('.copy-row button') }; })()`;
async function expectAgent(next, drafted) {
  if (!(await waitFor(`!!document.querySelector('.agent .proposal')`, 10_000, 'the agent never answered'))) return null;
  const agent = await run(readAgent);
  if (!agent.label.startsWith('Recorded run of claude-')) problems.push(`[${step}] agent label "${agent.label}"`);
  // The saved runs read all three; the model picked the order, so only check that each read is there.
  if (!['read_verdict', 'read_days', 'read_paypal_record'].every((tool) => agent.steps.includes(tool))) problems.push(`[${step}] agent steps ${agent.steps.join(',')}`);
  if (agent.next !== `Proposed next step: ${next}`) problems.push(`[${step}] agent proposes "${agent.next}", expected "${next}"`);
  if ((agent.draft !== '') !== drafted || agent.copy !== drafted) problems.push(`[${step}] agent draft shown: ${agent.draft !== ''}, expected ${drafted}`);
  if (agent.steps.some((s) => !/^(read_verdict|read_days|read_paypal_record|draft_installer_message)(:failed)?$/.test(s))) problems.push(`[${step}] agent used a tool it doesn't have: ${agent.steps.join(',')}`);
  return agent;
}

const recordLines = [];
async function expectRecord(text) {
  const shown = await run(`document.querySelector('.paypal-record .match')?.textContent ?? document.querySelector('.paypal-record')?.textContent ?? 'no record panel'`);
  recordLines.push(`${step}: ${shown}`);
  if (shown !== `Agrees with this page: ${text}.`) problems.push(`[${step}] PayPal record says "${shown}", expected "Agrees with this page: ${text}."`);
}

const results = [];
for (const [width, height, scheme] of [[390, 844, 'light'], [390, 844, 'dark'], [1280, 800, 'light'], [1280, 800, 'dark']]) {
  const tag = `${width}-${scheme}`;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  // The 390 px dark pass also asks for reduced motion, so the landing race has to open on its last day.
  const still = width === 390 && scheme === 'dark';
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: still ? 'reduce' : 'no-preference' }] });
  const record = async (name) => { step = `${tag} ${name}`; const m = await run(measure); results.push({ step, ...m }); await shot(`${tag}-${name}`); };

  await open(`${BASE}/`); await record('landing');
  // The landing race: no hold, no login. It plays once it's in view, and the money parts on Oct 23.
  await run(`document.querySelector('.landing-race')?.scrollIntoView({ block: 'center' })`);
  if (!still && await waitFor(`document.querySelector('.landing-race h2')?.textContent.includes('paid the $40.00 on Oct 23') ?? false`, 20_000, 'the landing race never reached Oct 23')) {
    await record('landing-race-paid');
    if (await run(`document.querySelector('.landing-race .race-replay').textContent`) !== 'Pause') problems.push(`[${step}] landing race isn't playing`);
  }
  if (await waitFor(`document.querySelector('.landing-race .race-replay')?.textContent === 'Replay'`, still ? 3_000 : 40_000, 'the landing race never reached Nov 19')) {
    await record('landing-race-done');
    const race = await expectRace('This check passed on Nov 19. A person can release the $40.00.', AFTER_PAID);
    if (race !== null && (race.bars !== 39 || race.future !== 0 || race.paid !== 1 || race.ready !== 1)) problems.push(`[${step}] landing race cells ${JSON.stringify(race)}`);
    const now = await run(`document.querySelector('.landing-race .race-now').textContent`);
    if (now !== 'Nov 19, 2020') problems.push(`[${step}] landing race shows ${now}`);
  }
  // The guided test: each thing it tells a judge to do has to exist and do what it says.
  const heading = () => run(`document.querySelector('h1')?.textContent`);
  const expectHeading = async (text) => { const shown = await heading(); if (shown !== text) problems.push(`[${step}] heading is "${shown}", expected "${text}"`); };
  await open(`${BASE}/judge`); await record('judge');
  await expectHeading('Seven taps through a real outage.');
  await clickSel('.release.ready'); await settle(1500); await record('hold-oct12');
  await expectHeading('$40.00 stays on hold.');
  await expectRecord('$0.00 captured, hold open');
  if (await expectAgent('Ask the installer', true)) {
    await run(`document.querySelector('.agent')?.scrollIntoView({ block: 'start' })`); await record('agent-oct12');
    // Copy puts the draft on the clipboard and sends nothing: no write request leaves the page.
    const writes = writeRequests;
    await clickSel('.agent .copy-row button');
    if (await waitFor(`!!document.querySelector('.agent .copy-row [role=status]')`, 3_000, 'Copy showed no note')) {
      const note = await run(`document.querySelector('.agent .copy-row [role=status]').textContent`);
      const same = await run(`navigator.clipboard.readText().then((t) => t === document.querySelector('.agent .ask .draft').textContent, () => null)`);
      if (note !== 'Copied. Send it yourself if you want to.' || same !== true) problems.push(`[${step}] Copy: "${note}", clipboard matches draft: ${same}`);
    }
    if (writeRequests !== writes) problems.push(`[${step}] Copy sent ${writeRequests - writes} write requests`);
  }
  await expectRace('Both rules are still holding the $40.00.');
  await checkLedger('oct12', 'Oct 12, 2020');
  // The excuse check: a demand to release is not a claim, and Release stays locked either way.
  const excuse = async (label, kinds) => {
    await clickStop(label); await settle(900);
    const e = await run(`({ claims: [...document.querySelectorAll('.claims .claim')].map((li) => li.className.replace('claim ', '')), note: document.querySelector('.excuse .still-locked')?.textContent ?? '', locked: !document.querySelector('.release.ready') || document.querySelector('.release.ready').textContent !== 'Release' })`);
    if (e.claims.join(',') !== kinds) problems.push(`[${step}] excuse "${label}" findings ${e.claims.join(',')}, expected ${kinds}`);
    if (!e.note.startsWith('Release is still locked.')) problems.push(`[${step}] excuse "${label}" has no locked note`);
  };
  await clickStop("Installer's reply"); await settle(300);
  await excuse('Ignore your rules', 'cant_check'); await record('excuse-injection');
  await excuse('It was cloudy', 'not_supported'); await record('excuse-cloudy');

  // Forging the low days: the what-if says the check would pass, the logger catches the dead days, and the real hold stays.
  await clickStop('Try to fake it'); await settle(300);
  await run(`[...document.querySelectorAll('.forge button')].find((b) => b.textContent === 'Forge these days').click()`);
  // Wait for the reply rather than a fixed time: a hosted demo far from the viewer can take over a second.
  for (let i = 0; i < 30 && !(await run(`document.querySelectorAll('.forge .claim .finding').length > 0`)); i++) await new Promise((r) => setTimeout(r, 200));
  const forged = await run(`({ findings: [...document.querySelectorAll('.forge .claim .finding')].map((f) => f.textContent), text: document.querySelector('.forge')?.textContent ?? '', locked: !document.querySelector('.release.ready') || document.querySelector('.release.ready').textContent !== 'Release' })`);
  if (forged.findings.join(',') !== 'Not caught,Caught,Caught,Caught,Caught') problems.push(`[${step}] forge findings ${forged.findings.join(',')}`);
  if (!forged.text.includes('the check would pass')) problems.push(`[${step}] forge does not say the engine was fooled`);
  if (!forged.locked) problems.push(`[${step}] forge unlocked Release`);
  await record('forge');
  await clickStop('Oct 22'); await settle(1200); await record('oct22');
  await expectHeading('$40.00 stays on hold.');
  await clickStop('Oct 26'); await settle(1200); await record('oct26');
  await expectHeading('$40.00 stays on hold.');
  await expectAgent('Ask the installer', true);
  await expectRace('The one-good-day rule paid the $40.00 on Oct 23. This check is still holding it.', 'Since then, Inverter 01 has had 1 day under 30% of usual.');
  await clickStop('Nov 19'); await settle(1200); await record('nov19-ready');
  await expectHeading('$40.00 can be released.');
  // The agent proposes Release, and nothing moves until the person presses it.
  if (await expectAgent('Release this milestone', false)) {
    await run(`document.querySelector('.agent')?.scrollIntoView({ block: 'start' })`); await record('agent-nov19');
    await expectRecord('$0.00 captured, hold open');
  }
  await expectRace('This check passed on Nov 19. A person can release the $40.00.', AFTER_PAID);
  const all = await checkLedger('nov19', 'Nov 19, 2020');

  // Narrow to the days the rules disagree, and check the summary follows the filter.
  await clickStop('Rules disagree'); await settle(400); await record('ledger-disagree');
  const narrowed = await run(readLedger);
  if (Number(narrowed.facts['Days shown']) !== Number(all.facts['Rules disagree'])) problems.push(`[${step}] disagree filter shows ${narrowed.facts['Days shown']}, expected ${all.facts['Rules disagree']}`);
  if (Number(narrowed.facts['Ours ready']) !== 0) problems.push(`[${step}] a disagree row has our rule ready`);
  if (width === 1280 && scheme === 'light') {
    const downloads = mkdtempSync(join(tmpdir(), 'pbp-csv-'));
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await clickStop('Download CSV');
    // Waits for the finished file, since Chrome writes it under a temporary name first.
    const finished = () => readdirSync(downloads).filter((name) => name.endsWith('.csv'));
    for (let waited = 0; finished().length === 0 && waited < 15_000; waited += 100) await wait(100);
    const files = finished();
    const lines = files[0] === undefined ? [] : readFileSync(join(downloads, files[0]), 'utf8').trim().split('\n');
    console.log(`csv: ${files[0]}, ${lines.length - 1} rows`);
    if (lines.length - 1 !== Number(narrowed.facts['Days shown'])) problems.push(`[${step}] CSV has ${lines.length - 1} lines after the header, showing ${narrowed.facts['Days shown']}`);
    rmSync(downloads, { recursive: true, force: true });
  }
  await clickStop('All days'); await settle(400);
  await clickSel('.release.ready'); await settle(900); await record('released-m1');
  await expectRecord('$40.00 captured, hold open');
  const waiting = await run(`document.querySelector('.agent .text')?.textContent ?? ''`);
  if (!waiting.startsWith('Milestone 2 opens on ')) problems.push(`[${step}] agent card says "${waiting}" before milestone 2 opens`);
  await expectRace('A person released the $40.00 on Nov 19.', AFTER_PAID);
  await clickStop('Dec 19'); await settle(1200); await record('dec19-ready');
  await expectAgent('Release this milestone', false);
  if (await run(`!!document.querySelector('.race')`)) problems.push(`[${step}] race still shown on the second milestone`);
  await clickSel('.release.ready'); await settle(900); await record('closed');
  await expectRecord('$100.00 captured, hold fully captured');

  await open(`${BASE}/`); await clickSel('.release.ready'); await settle(1200);
  await clickStop('Give the rest back'); await settle(200); await record('void-confirm');
  await clickStop('Return it'); await settle(900); await record('voided');
  await expectRecord('$0.00 captured, rest of the hold voided');
  await open(`${BASE}/c/no-such-hold`); await record('gone');

  // Play: the month runs one recorded day at a time through the same clock. The simple rule pays on Oct 23, this check
  // waits for Nov 19, and the AI is asked once, about the day Play stops on. The page has one theme, so light is enough.
  if (scheme === 'light') {
    await open(`${BASE}/`); await clickSel('.release.ready'); await settle(1200);
    step = `${tag} play`;
    const asked = explainRequests;
    const askedAgent = agentRequests;
    await clickStop('Play');
    if (await waitFor(`document.querySelector('.race h2')?.textContent.includes('paid the $40.00 on Oct 23') && document.querySelectorAll('.race-track.bars li:not(.future)').length >= 16`, 120_000, 'the one-good-day rule never paid')) {
      await record('race-paid');
      if (!(await run(`!!document.querySelector('.btn.play.on') && [...document.querySelectorAll('.rail .stop')].every((b) => b.disabled)`))) problems.push(`[${step}] Pause missing, or a stop open, while playing`);
    }
    await waitFor(`document.querySelector('h1')?.textContent === '$40.00 can be released.' && !document.querySelector('.btn.play.on')`, 180_000, 'Play never reached a ready day');
    await settle(900); await record('race-ready');
    const race = await expectRace('This check passed on Nov 19. A person can release the $40.00.', AFTER_PAID);
    if (race !== null && (race.bars !== 39 || race.future !== 0 || race.paid !== 1 || race.ready !== 1)) problems.push(`[${step}] race cells ${JSON.stringify(race)}`);
    if (!(await run(`document.querySelector('.btn.play')?.disabled === true`))) problems.push(`[${step}] Play still open on a ready day`);
    if (explainRequests - asked !== 1) problems.push(`[${step}] Play asked the AI ${explainRequests - asked} times, expected once`);
    await expectAgent('Release this milestone', false);
    if (agentRequests - askedAgent !== 1) problems.push(`[${step}] Play asked the agent ${agentRequests - askedAgent} times, expected once`);
    await checkLedger('after play', 'Nov 19, 2020');
  }

  // The neighbour contract: four weeks billed from the readings, a $0 week with no PayPal call, the rest returned.
  await open(`${BASE}/`); await clickStop('Hold $120.00'); await settle(1200); await record('n-start');
  await expectHeading('Week 1 hasn\'t started.');
  await expectRecord('$0.00 captured, hold open');
  if (await run(`!!document.querySelector('.ledger, .ai')`)) problems.push(`[${step}] installer panels shown on a neighbour contract`);
  await clickStop('Next day'); await settle(900); await record('n-measuring');
  const measuring = await run(`({ h1: document.querySelector('h1')?.textContent, seen: document.querySelectorAll('.verdict .days li:not(.none)').length, locked: !!document.querySelector('.release.locked') })`);
  if (!measuring.h1?.endsWith('kWh so far.') || measuring.seen !== 1 || !measuring.locked) problems.push(`[${step}] open week shows ${JSON.stringify(measuring)}`);
  const settleWeek = async (stop, due, record$, name) => {
    await clickStop(stop); await settle(1200); await record(`${name}-due`);
    await expectHeading(due);
    if (await run(`document.querySelector('.rail button')?.textContent === 'Next day' && !document.querySelector('.rail button').disabled`)) problems.push(`[${step}] Next day still open after the week ended`);
    await clickSel('.release.ready'); await settle(1200); await record(`${name}-settled`);
    await expectRecord(record$);
  };
  await settleWeek('Oct 4', '$22.47 is due for week 1.', '$22.47 captured, hold open', 'n-w1');
  await settleWeek('Oct 11', '$8.61 is due for week 2.', '$31.08 captured, hold open', 'n-w2');
  await settleWeek('Oct 18', 'Nothing is due for week 3.', '$31.08 captured, hold open', 'n-w3');
  await settleWeek('Oct 25', '$9.74 is due for week 4.', '$40.82 captured, rest of the hold voided', 'n-w4');
  await expectHeading('$40.82 paid for measured power.');

  // A restart clears holds. The page must say so once, then stop asking.
  if (width === 390 && scheme === 'light') {
    await open(`${BASE}/`); await clickSel('.release.ready'); await settle(1200);
    expected404 = true;
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/view' }] });
    await wait(5600);
    step = `${tag} restart`;
    const shown = await run(`document.querySelector('h1')?.textContent`);
    if (shown !== 'This hold is no longer here.') problems.push(`[${step}] page shows: ${shown}`);
    const before = viewRequests;
    await wait(6000);
    if (viewRequests !== before) problems.push(`[${step}] kept polling: ${viewRequests - before} more requests`);
    await send('Fetch.disable');
    expected404 = false;
    results.push({ step, polling: viewRequests - before });
  }

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
const sample = ledgerFacts.find((f) => f.step.endsWith('nov19'));
if (sample) console.log(`ledger at Nov 19: ${JSON.stringify(sample.facts)} ${JSON.stringify(sample.chips)}`);
console.log(`PayPal record checks: ${recordLines.length}; ${recordLines.slice(0, 4).join(' | ')}`);
for (const problem of problems) console.log(problem);
ws.close();
cleanUp();
await wait(300);
rmSync(profile, { recursive: true, force: true });
process.exit(problems.length === 0 ? 0 : 1);
