// The whole UI. Everything from the server is written with textContent, never as HTML.
// This page shows verdicts and sends taps. All decisions about money are made on the server.
import { drawChart, shortDate } from './chart.js';
import { el } from './dom.js';
import { createLedger } from './ledger.js';
import { raceUpTo } from './race.js';

const app = document.getElementById('app');
const modeTag = document.getElementById('mode');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function icon(kind, size = 16) {
  const paths = {
    lock: 'M6 7V5a4 4 0 0 1 8 0v2M5 7h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z',
    check: 'M4 10.5l4 4 8-9',
    clock: 'M10 5v5l3 2M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
    arrow: 'M4 10h12M11 5l5 5-5 5',
    play: 'M7 4.5l8 5.5-8 5.5z',
    pause: 'M7 5v10M13 5v10',
    copy: 'M7 7V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3M4 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[kind]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const fullDate = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const addDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function setMode(mode) {
  modeTag.hidden = false;
  modeTag.textContent = mode === 'sample' ? 'Sample mode: recorded PayPal and AI replies, no money' : 'PayPal sandbox: test money only';
}

// ---------- Landing ----------
// The body only picks which fixed contract to start. The server sets every amount.
async function startHold(button, notice, body) {
  button.disabled = true;
  notice.hidden = true;
  const { ok, status, data } = await api('/api/contracts', body).catch(() => ({ ok: false, status: 0, data: {} }));
  if (ok && data.approveUrl) return location.assign(data.approveUrl);
  if (ok) return location.assign(`/c/${encodeURIComponent(data.id)}`);
  button.disabled = false;
  notice.hidden = false;
  notice.textContent = status === 429 ? 'Too many new holds this minute. Try again shortly.' : 'The hold could not be started. No money moved. Please try again.';
}

async function loadMode() {
  const health = await api('/healthz').catch(() => null);
  const mode = health?.data?.mode;
  if (mode) setMode(mode);
  return mode;
}

function holdStarter(label, body = {}) {
  const notice = el('p', { class: 'notice', hidden: true, role: 'status' });
  const button = el('button', { class: 'release ready start-btn', type: 'button', on: { click: () => startHold(button, notice, body) } }, label, icon('arrow', 18));
  return { button, notice };
}

// Opening this page creates nothing, so a link preview or a crawler can't place a hold. Each press starts a new one,
// which also means a judge never meets an authorization that has expired.
async function renderJudge() {
  const mode = await loadMode();
  const { button, notice } = holdStarter('Start a fresh hold');
  const steps = [
    ['Start a fresh hold', mode === 'sample' ? '$100.00 goes on hold for two milestones. You land on Oct 12, 2020, with the inverter at zero and Release locked.' : 'Approve $100.00 on PayPal with the sandbox buyer login in the README. You land on Oct 12, 2020, with the inverter at zero and Release locked.'],
    ['Tap Oct 22', 'Output returns, and Release stays locked. One good day isn\'t enough. Or press Play to watch the whole month run, one recorded day at a time.'],
    ['Tap Oct 26', 'Back to zero. A rule that pays after one good day would already have paid, on Oct 23 and 24.'],
    ['Tap Nov 19, then Release $40.00', 'The last 7 days pass the check, so Release unlocks. Nothing is captured until you tap it.'],
    ['Tap Dec 19, then Release $60.00', 'The second milestone is checked 30 days later. Releasing it closes the hold.'],
    ['Check our work', 'In the ledger, tap Rules disagree and download the CSV. Or start another hold and give the money back.'],
  ];
  app.replaceChildren(el('section', { class: 'landing judge' },
    el('div', { class: 'landing-copy' },
      el('p', { class: 'kicker' }, 'Guided test · about 3 minutes'),
      el('h1', {}, 'Seven taps through a real outage.'),
      el('p', { class: 'lede' }, 'These are real 2020 readings from a commercial roof in Maui. Try to get paid before the system has proved itself.'),
      el('div', { class: 'start' }, button, el('small', {}, mode === 'sample' ? 'Sample mode: no login and no money. PayPal and AI replies are recorded.' : 'Real PayPal sandbox calls. Test money only.')),
      notice,
    ),
    el('ol', { class: 'checklist' }, ...steps.map(([title, text], i) => el('li', {}, el('span', { class: 'num mono' }, String(i + 1).padStart(2, '0')), el('div', {}, el('b', {}, title), el('p', {}, text))))),
  ));
}

// Every line here is a measured fact from the replay, not an illustration.
const STORY = [
  ['Oct 9', 'hold', 'Inverter 01 drops to 0 kWh. The other inverters on the roof keep producing.'],
  ['Oct 22', 'hold', 'Output comes back for four days. One good day isn\'t enough here.'],
  ['Oct 26', 'hold', 'Back to zero for 16 more recorded days. A pay-after-one-good-day rule paid on Oct 23.'],
  ['Nov 19', 'ready', 'A full healthy week. The check passes, and a person can release $40.00.'],
];

async function renderLanding() {
  const mode = await loadMode();
  const { button, notice } = holdStarter('Hold $100.00 and watch the check');
  // Shown only once the race has loaded, so a failed read leaves no empty panel.
  const raceSlot = el('div', { class: 'landing-race-slot', hidden: true });
  renderLandingRace(raceSlot);
  const steps = [
    ['PayPal holds the money', 'The buyer approves a $100.00 authorization for two milestones. Nothing is captured.'],
    ['The data decides', 'A fixed rule compares this inverter with the others on the same roof and with measured sun.'],
    ['The AI explains', 'Claude explains the result and drafts a question for the installer. It can\'t change the result or move money.'],
    ['A person releases', 'Release stays locked until the data passes. Then a person taps, and PayPal captures that milestone.'],
  ];
  app.replaceChildren(el('section', { class: 'landing' },
    el('div', { class: 'landing-copy' },
      el('p', { class: 'kicker' }, 'Solar milestone payments on PayPal'),
      el('h1', {}, 'Your solar installer gets paid when the system proves it\'s producing.'),
      el('p', { class: 'lede' }, 'Replay a real 2020 outage on a real roof. A rule that pays after one good day would have paid during a four-day recovery, just before 16 more recorded days at zero. This one keeps the money on hold.'),
      el('div', { class: 'start' }, button, el('small', {}, mode === 'sample' ? 'Sample mode: no login and no money. PayPal replies are recorded.' : 'You\'ll approve the hold with a PayPal sandbox buyer. Test money only.')),
      notice,
      el('p', { class: 'guide-link' }, el('a', { href: '/judge' }, 'Judging this? Follow the guided test'), icon('arrow', 14)),
    ),
    el('div', { class: 'landing-side' },
      el('figure', { class: 'hero-art' },
        el('img', { src: '/hero.svg', alt: 'Illustration: power from a solar roof flows into a locked hold, then to a released payment.', width: 560, height: 360 }),
        el('figcaption', {}, el('span', { class: 'cap-hold' }, 'Held'), el('span', { class: 'cap-arrow', ariaHidden: 'true' }, '→'), el('span', { class: 'cap-ready' }, 'Released by a person')),
      ),
      el('aside', { class: 'story', ariaLabel: 'The 2020 outage in four dates' },
        el('p', { class: 'story-head' }, el('span', {}, 'Inverter 01, Maui, 2020'), el('span', { class: 'pill quiet' }, 'measured')),
        el('ol', {}, ...STORY.map(([date, kind, text]) => el('li', { class: kind },
          el('span', { class: 'when mono' }, date),
          el('span', { class: `pill ${kind}` }, icon(kind === 'ready' ? 'check' : 'lock', 12), kind === 'ready' ? 'READY' : 'HOLD'),
          el('p', {}, text),
        ))),
      ),
    ),
    raceSlot,
    el('ol', { class: 'steps' }, ...steps.map(([title, text], i) => el('li', {}, el('span', { class: 'num mono' }, String(i + 1).padStart(2, '0')), el('b', {}, title), el('span', {}, text)))),
    renderPeople(),
    renderNeighbourPitch(mode),
  ));
}

// The same roof, a second contract. Amounts are from the recorded weeks, worked out in test/neighbour.test.ts.
function renderNeighbourPitch(mode) {
  const { button, notice } = holdStarter('Hold $120.00 for four weeks of power', { kind: 'neighbour' });
  const weeks = [
    ['Week 1', '224.7 kWh', '$22.47'],
    ['Week 2', '86.1 kWh', '$8.61'],
    ['Week 3', '0.0 kWh', '$0.00'],
    ['Week 4', '97.4 kWh', '$9.74'],
  ];
  return el('section', { class: 'neighbour-pitch' },
    el('div', { class: 'neighbour-copy' },
      el('p', { class: 'kicker' }, 'Second contract · same roof'),
      el('h2', {}, 'A neighbour buys this roof\'s power.'),
      el('p', { class: 'lede' }, 'PayPal holds $120.00 for four weeks at a demo price of $0.10 a kWh. Each week is billed from the inverter\'s own readings once the week is over, and a person taps to capture it. The outage week costs nothing, and whatever isn\'t used goes back.'),
      el('div', { class: 'start' }, button, el('small', {}, mode === 'sample' ? 'Sample mode: no login and no money.' : 'You\'ll approve the hold with a PayPal sandbox buyer. Test money only.')),
      notice,
    ),
    el('aside', { class: 'story bill-preview', ariaLabel: 'What the four weeks come to' },
      el('p', { class: 'story-head' }, el('span', {}, 'Inverter 01, Sep 28 to Oct 25, 2020'), el('span', { class: 'pill quiet' }, 'measured')),
      el('ol', { class: 'bill-rows' }, ...weeks.map(([week, kwh, cents]) => el('li', {}, el('span', {}, week), el('span', { class: 'mono' }, kwh), el('b', { class: 'mono' }, cents)))),
      el('p', { class: 'bill-total' }, el('span', {}, 'Captured $40.82'), el('span', {}, 'Back to the buyer $79.18')),
      el('p', { class: 'credit' }, 'A commercial roof\'s readings and a demo price, so this shows how billing works, not a real bill.'),
    ),
  );
}

// Captions say only what each photo shows. The people in them have nothing to do with this project or the Maui roof.
const PHOTOS = [
  ['/img/roof-carry.webp', 'A man in a rain jacket and safety harness carries a solar panel on his back across a wet green metal roof.', 'An installer carries a panel across a metal roof.'],
  ['/img/roof-panels.webp', 'A technician in a cap and safety harness kneels on a green metal roof beside a row of solar panels.', 'A technician works on a rooftop array.'],
];

function renderPeople() {
  return el('section', { class: 'people' },
    el('div', { class: 'people-copy' },
      el('h2', {}, 'The work happens on the roof. The money waits for proof.'),
      el('p', {}, 'When a milestone is due, the installer has already done the work, and the buyer can\'t yet know the system works. Here neither has to take the other\'s word for it. PayPal holds the money, the roof\'s own readings decide when it can move, and a person taps Release.'),
    ),
    el('div', { class: 'people-photos' }, ...PHOTOS.map(([src, alt, caption]) => el('figure', { class: 'photo' },
      // Plain loading: lazy or low-priority photos came out blank in full-page screenshots. Both together are 188 KB.
      el('img', { src, alt, width: 1200, height: 800 }),
      el('figcaption', {}, caption),
    ))),
    el('p', { class: 'credit' }, 'Photos: Stephen Yang / The Solutions Project, 2016, public domain, via Wikimedia Commons. The people shown aren\'t connected to this project.'),
  );
}

// ---------- Contract ----------
const state = { tab: 'ai', id: null, view: null, json: '', notice: null, explanationKey: null, explanation: null, agentKey: null, agent: null, copied: null, recordKey: null, record: null, excuse: { key: null, draft: '', busy: false, result: null }, confirmVoid: false, busy: false, holdNote: null, playing: false };
let explainTimer = 0;
let agentTimer = 0;
// Play waits at least this long between recorded days, so a fast connection doesn't blur the month.
// Oct 12 to Nov 19 is 38 steps, so about 15 s on a local server. A distant host is slower, because each step is two requests.
const PLAY_STEP_MS = 400;
let chartHost = null;
let chartDays = [];

function currentMilestone(view) {
  return view.milestones.find((m) => m.isCurrent) ?? null;
}

async function refresh() {
  const { ok, status, data } = await api(`/api/contracts/${encodeURIComponent(state.id)}/view`).catch(() => ({ ok: false, status: 0, data: {} }));
  if (status === 404) return renderGone();
  if (!ok) {
    state.notice = { text: 'Couldn\'t reach the server. The last state is still shown, and nothing has moved because of this.', good: false };
    if (state.view !== null) render();
    return;
  }
  const json = JSON.stringify(data);
  if (json === state.json) return;
  state.json = json;
  state.view = data;
  setMode(data.mode);
  render();
  // While Play runs, the AI answer and PayPal's record wait for the last day, so a 38-day replay doesn't make 38 calls each.
  if (state.playing) return;
  loadExplanation();
  loadAgent();
  loadRecord();
}

function renderGone() {
  // Clearing the view also stops the polling, so the page doesn't keep asking for a hold that's gone.
  state.view = null;
  app.replaceChildren(el('section', { class: 'landing' }, el('div', {},
    el('h1', {}, 'This hold is no longer here.'),
    el('p', { class: 'lede' }, 'The demo keeps holds in memory, so a server restart clears them. Any sandbox authorization expires by itself. No money has moved.'),
    el('div', { class: 'start' }, el('a', { class: 'btn go', href: '/' }, 'Start a new hold')),
  )));
}

function loadExplanation() {
  // A metered week has no verdict, so there's nothing for the AI to explain.
  if (state.view.kind === 'neighbour') return;
  const verdict = currentMilestone(state.view)?.verdict ?? null;
  const key = verdict === null || state.view.status !== 'HELD' ? null : `${verdict.date}|${verdict.status}`;
  if (key === state.explanationKey) return;
  state.explanationKey = key;
  state.explanation = null;
  // A new verdict starts a fresh excuse check, so findings never sit next to a different hold.
  if (state.excuse.key !== key) { state.excuse = { key, draft: '', busy: false, result: null }; state.forge = { busy: false, result: null }; }
  clearTimeout(explainTimer);
  renderAi();
  if (key === null) return;
  // Waits for the clicking to stop, so stepping through days doesn't ask about every one.
  explainTimer = setTimeout(async () => {
    const { ok, data } = await api(`/api/contracts/${encodeURIComponent(state.id)}/explanation`).catch(() => ({ ok: false, data: {} }));
    if (state.explanationKey !== key) return;
    state.explanation = ok && data.explanation ? data : { failed: true };
    renderAi();
  }, 500);
}

function aiLabel(answer) {
  if (answer.source === 'model') return `${answer.model} on AWS Bedrock, checked against the evidence`;
  if (answer.source === 'recorded') return `Recorded answer from a real run of ${answer.model} on AWS Bedrock`;
  if (answer.templateReason === 'NO_MODEL') return 'Plain template: no saved AI answer for this day';
  if (answer.templateReason === 'CALL_LIMIT') return 'Plain template: the demo\'s AI call limit was reached';
  return `Plain template: the AI answer was not used (${answer.templateReason})`;
}

let aiHost = null;
const TABS = [['ai', 'Why'], ['reply', 'Installer\'s reply'], ['forge', 'Try to fake it']];

function renderExplanation(view, milestone) {
  const parts = [];
  if (view.status !== 'HELD') {
    parts.push(el('p', { class: 'text' }, view.status === 'AWAITING_APPROVAL' ? 'The AI explains each result once the hold is placed.' : 'There\'s nothing left to explain: this contract has finished.'));
  } else if (state.playing) {
    parts.push(el('p', { class: 'text' }, 'The AI explains the day Play stops on. It isn\'t asked about every day on the way.'));
  } else if (milestone?.verdict === null || milestone === null) {
    parts.push(el('p', { class: 'text' }, `There's no result to explain yet. The AI explains this milestone once it opens on ${milestone?.opensOn ? fullDate(milestone.opensOn) : 'its date'}.`));
  } else if (state.explanation === null) {
    parts.push(el('p', { class: 'label pulse' }, 'Reading the evidence…'), el('p', { class: 'text quiet' }, 'The verdict is already final, and this explanation can\'t change it.'));
  } else if (state.explanation.failed) {
    parts.push(el('p', { class: 'text' }, 'The explanation could not load. The verdict and the data on this page are unaffected.'));
  } else {
    const answer = state.explanation;
    parts.push(el('p', { class: 'label' }, aiLabel(answer)), el('p', { class: 'text' }, answer.explanation));
    if (answer.installerQuestion) parts.push(el('div', { class: 'ask' }, el('b', {}, 'Suggested question for the installer'), el('p', {}, answer.installerQuestion)));
  }
  return parts;
}

function renderAi() {
  if (aiHost === null || state.view === null) return;
  const view = state.view;
  const milestone = currentMilestone(view);
  // While Play runs, the reply and forge tabs are hidden: their results belong to the day Play started from.
  const onHold = !state.playing && view.status === 'HELD' && milestone?.verdict?.status === 'HOLD';
  const tab = onHold ? state.tab : 'ai';
  const head = el('div', { class: 'push-head' },
    el('h2', {}, onHold ? 'Push on the verdict' : 'What the AI says'),
    el('p', { class: 'limit' }, 'The AI can\'t change the verdict, unlock Release or move money.'));
  const parts = [head];
  if (onHold) {
    const list = el('div', { class: 'tabs', role: 'tablist', ariaLabel: 'Ways to test this hold' });
    TABS.forEach(([key, label], i) => {
      const b = el('button', { class: 'tab', type: 'button', role: 'tab', id: `tab-${key}`, tabIndex: key === tab ? 0 : -1 }, label);
      b.setAttribute('aria-selected', String(key === tab));
      b.setAttribute('aria-controls', `panel-${key}`);
      b.addEventListener('click', () => { state.tab = key; renderAi(); document.getElementById(`tab-${key}`)?.focus(); });
      b.addEventListener('keydown', (e) => {
        const move = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (move === 0) return;
        e.preventDefault();
        state.tab = TABS[(i + move + TABS.length) % TABS.length][0];
        renderAi();
        document.getElementById(`tab-${state.tab}`)?.focus();
      });
      list.append(b);
    });
    parts.push(list);
    const panels = { ai: renderExplanation(view, milestone), reply: [renderExcuse(view)], forge: [renderForge()] };
    for (const [key] of TABS) {
      const panel = el('div', { class: 'panel', role: 'tabpanel', id: `panel-${key}`, hidden: key !== tab }, ...panels[key]);
      panel.setAttribute('aria-labelledby', `tab-${key}`);
      parts.push(panel);
    }
  } else {
    parts.push(el('div', { class: 'panel' }, ...renderExplanation(view, milestone)));
  }
  aiHost.replaceChildren(...parts);
}

// ---------- AI agent ----------
// Claude with four read-only tools: the verdict, the recorded days, PayPal's record and a check on its own draft.
// It proposes a next step. It sends nothing, and the Release button stays a person's to press.
function loadAgent() {
  if (state.view.kind === 'neighbour') return;
  const index = state.view.milestones.findIndex((m) => m.isCurrent);
  const verdict = index < 0 ? null : state.view.milestones[index].verdict ?? null;
  const key = verdict === null || state.view.status !== 'HELD' ? null : `${index}|${verdict.date}|${verdict.status}`;
  if (key === state.agentKey) return;
  state.agentKey = key;
  state.agent = null;
  state.copied = null;
  clearTimeout(agentTimer);
  renderAgent();
  if (key === null) return;
  // A live run makes several model calls, so it waits a little longer than the explanation for the clicking to stop.
  agentTimer = setTimeout(async () => {
    const { ok, data } = await api(`/api/contracts/${encodeURIComponent(state.id)}/agent`).catch(() => ({ ok: false, data: {} }));
    if (state.agentKey !== key) return;
    state.agent = ok && data.run ? data.run : { failed: true };
    renderAgent();
  }, 1000);
}

function agentLabel(run) {
  if (run.source === 'model') return `${run.model} on AWS Bedrock: ${run.calls} model call${run.calls === 1 ? '' : 's'}, its answer checked by the server.`;
  if (run.source === 'recorded') return `Recorded run of ${run.model} on AWS Bedrock. Its tool calls were made again against this hold, and its answer passed the same checks.`;
  if (run.fallbackReason === 'NO_MODEL') return 'Plain run: the same reads in a fixed order, with no saved AI run for this day.';
  if (run.fallbackReason === 'CALL_LIMIT') return 'Plain run: the demo\'s AI call limit was reached.';
  return `Plain run: the AI's answer was not used (${run.fallbackReason}).`;
}

const NEXT_TEXT = { ASK_INSTALLER: 'Ask the installer', PROPOSE_RELEASE: 'Release this milestone', WAIT: 'Wait' };

let agentHost = null;
function renderAgent() {
  if (agentHost === null || state.view === null) return;
  const view = state.view;
  const milestone = currentMilestone(view);
  const parts = [el('div', { class: 'push-head' },
    el('h2', {}, 'AI agent'),
    el('p', { class: 'limit' }, 'It has four read-only tools and no payment tools. It sends nothing and can\'t change the verdict or move money.'))];
  const run = state.agent;
  if (view.status !== 'HELD') {
    parts.push(el('p', { class: 'text' }, view.status === 'AWAITING_APPROVAL' ? 'The agent starts watching once the hold is placed.' : 'This contract has finished, so there\'s nothing left to watch.'));
  } else if (state.playing) {
    parts.push(el('p', { class: 'text' }, 'The agent looks at the day Play stops on.'));
  } else if (milestone === null || milestone.verdict === null) {
    parts.push(el('p', { class: 'text' }, `Milestone ${milestone ? view.milestones.indexOf(milestone) + 1 : ''} opens on ${milestone?.opensOn ? fullDate(milestone.opensOn) : 'its date'}. The agent starts then.`));
  } else if (run === null) {
    parts.push(el('p', { class: 'label pulse' }, view.mode === 'sample' ? 'Replaying a recorded run…' : 'Working: reading the verdict, the days and PayPal\'s record…'),
      el('p', { class: 'text quiet' }, view.mode === 'sample' ? 'Each saved tool call is made again against this hold.' : 'A live run makes a few model calls and takes about 20 seconds.'));
  } else if (run.failed) {
    parts.push(el('p', { class: 'text' }, 'The agent couldn\'t run just now. The verdict and the money on this page are unaffected.'));
  } else {
    parts.push(el('p', { class: 'label' }, agentLabel(run)));
    parts.push(el('ol', { class: 'tool-steps' }, ...run.steps.map((step) => el('li', { class: step.ok ? 'ok' : 'no' },
      el('code', {}, step.tool), el('span', {}, step.said)))));
    parts.push(el('div', { class: `proposal ${run.nextStep === 'PROPOSE_RELEASE' ? 'go' : ''}` },
      el('b', {}, `Proposed next step: ${NEXT_TEXT[run.nextStep] ?? run.nextStep}`),
      el('p', {}, run.summary),
      run.nextStep === 'PROPOSE_RELEASE' ? el('p', { class: 'note' }, 'The Release button above is yours to press. The agent can\'t press it.') : null,
      run.nextStep === 'WAIT' ? el('p', { class: 'note' }, 'Nothing to do yet.') : null,
    ));
    if (run.nextStep === 'ASK_INSTALLER' && run.messageToInstaller) {
      const message = run.messageToInstaller;
      const copy = el('button', { class: 'btn', type: 'button', on: { click: () => {
        const done = (ok) => { if (state.agent === run) { state.copied = ok; renderAgent(); } };
        (navigator.clipboard?.writeText(message) ?? Promise.reject(new Error('no clipboard'))).then(() => done(true), () => done(false));
      } } }, icon('copy', 14), 'Copy');
      parts.push(el('div', { class: 'ask' },
        el('b', {}, 'Draft to the installer. Not sent'),
        el('p', { class: 'draft' }, message),
        el('div', { class: 'copy-row' }, copy, state.copied === null ? null : el('span', { class: 'note', role: 'status' },
          state.copied ? 'Copied. Send it yourself if you want to.' : 'Couldn\'t copy here. Select the text instead.')),
      ));
    }
  }
  agentHost.replaceChildren(...parts);
}

// ---------- Excuse check ----------
const KIND_TEXT = { WEATHER: 'Weather', SITE_WIDE: 'Whole site', MONITORING: 'Monitoring', OTHER: 'Other', NOT_A_CLAIM: 'Not a claim' };
const FINDING_TEXT = { SUPPORTED: 'Data supports it', NOT_SUPPORTED: 'Data doesn\'t support it', MIXED: 'Data partly fits', CANT_CHECK: 'Can\'t be checked' };
const MAX_REPLY = 600;

function splitLabel(result) {
  if (result.source === 'model') return `Claims found by ${result.model} on AWS Bedrock. Each one was tested by fixed rules, not by the AI.`;
  if (result.source === 'recorded') return `Claims found in a recorded run of ${result.model} on AWS Bedrock. Each one was tested by fixed rules, not by the AI.`;
  const why = result.fallbackReason === 'NO_MODEL' ? 'no AI in sample mode for this reply' : result.fallbackReason === 'CALL_LIMIT' ? 'the demo\'s AI call limit was reached' : `the AI answer was not used (${result.fallbackReason})`;
  return `Claims found by keyword matching, one per sentence: ${why}. Each one was tested by fixed rules.`;
}

async function tryForge() {
  const forge = state.forge;
  if (forge.busy) return;
  forge.busy = true;
  forge.result = null;
  renderAi();
  const res = await fetch(`/api/contracts/${encodeURIComponent(state.id)}/forge`).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) : null;
  if (state.forge !== forge) return;
  forge.busy = false;
  forge.result = data ?? { failed: true };
  renderAi();
}

function renderForge() {
  const forge = state.forge ?? (state.forge = { busy: false, result: null });
  const button = el('button', { class: 'btn', type: 'button' }, forge.busy ? 'Forging…' : 'Forge these days');
  button.disabled = forge.busy;
  button.addEventListener('click', tryForge);
  const parts = [
    el('p', { class: 'note' }, 'What if someone rewrote the low daily totals to look normal? This runs on a copy. The hold on this page doesn\'t change.'),
    button,
  ];
  const result = forge.result;
  if (result?.failed) parts.push(el('p', { class: 'note' }, 'The test could not run. The hold and the data on this page are unaffected.'));
  else if (result && result.days.length === 0) parts.push(el('p', { class: 'note' }, 'No day in this window is low enough to forge.'));
  else if (result) {
    parts.push(el('p', {}, result.forgedStatus === 'RELEASE_READY' ? 'On forged totals alone, the check would pass.' : 'Even on forged totals, the check would still hold.'));
    parts.push(el('ul', { class: 'claims' }, ...result.days.map((day) => el('li', { class: `claim ${day.flagged ? 'not_supported' : 'cant_check'}` },
      el('p', { class: 'claim-head' }, el('span', { class: 'kind' }, shortDate(day.date)), el('span', { class: 'finding' }, day.flagged ? 'Caught' : 'Not caught')),
      el('p', {}, `${day.realKwh.toFixed(1)} kWh rewritten to ${day.forgedKwh.toFixed(1)} kWh. Highest DC voltage logged: ${day.dcMaxV === null ? 'no reading' : `${day.dcMaxV.toFixed(1)} V`}${result.usualDcPeakV === null ? '' : `, against a usual ${result.usualDcPeakV.toFixed(1)} V`}.`),
    ))));
    parts.push(el('p', { class: 'note' }, 'The logger catches a forged day when its DC voltage was far too low to make that power. It can\'t see a small real output made larger, and someone who rewrote every raw reading would pass. This makes faking harder, not impossible.'));
  }
  return el('div', { class: 'excuse forge' }, ...parts);
}

async function sendExcuse(reply) {
  const excuse = state.excuse;
  const text = reply.trim();
  if (text === '' || excuse.busy) return;
  excuse.draft = reply;
  excuse.busy = true;
  excuse.result = null;
  renderAi();
  const { ok, status, data } = await api(`/api/contracts/${encodeURIComponent(state.id)}/excuse`, { reply: text }).catch(() => ({ ok: false, status: 0, data: {} }));
  if (state.excuse !== excuse) return;
  excuse.busy = false;
  if (ok) excuse.result = { ...data, reply: text };
  else if (status === 429) excuse.result = { failed: 'The demo is checking a lot of replies right now. Try again in a minute.' };
  else if (status === 409) excuse.result = { failed: 'This milestone isn\'t on hold any more, so there\'s nothing to answer.' };
  else excuse.result = { failed: 'The reply could not be checked. The hold and the data on this page are unaffected.' };
  renderAi();
}

function renderExcuse(view) {
  const excuse = state.excuse;
  const box = el('textarea', { id: 'excuse-reply', rows: 3, maxLength: MAX_REPLY, placeholder: 'Type what the installer says, or pick one above' });
  box.value = excuse.draft;
  box.addEventListener('input', () => { excuse.draft = box.value; });
  const send = el('button', { class: 'btn', type: 'button' }, excuse.busy ? 'Checking…' : 'Check this reply');
  send.disabled = excuse.busy;
  send.addEventListener('click', () => sendExcuse(box.value));
  const presets = el('div', { class: 'presets' }, ...view.excusePresets.map((preset) => {
    const chip = el('button', { class: 'btn chip', type: 'button' }, preset.label);
    chip.disabled = excuse.busy;
    chip.addEventListener('click', () => sendExcuse(preset.reply));
    return chip;
  }));
  const parts = [
    el('p', { class: 'note' }, 'The AI splits the reply into claims. Fixed rules check each claim against this roof\'s measured data.'),
    presets,
    el('label', { class: 'sr-only', htmlFor: 'excuse-reply' }, 'Installer\'s reply'),
    box,
    send,
  ];
  const result = excuse.result;
  if (result?.failed) parts.push(el('p', { class: 'note' }, result.failed));
  else if (result) {
    parts.push(el('p', { class: 'said' }, el('b', {}, 'Installer: '), `“${result.reply}”`));
    parts.push(el('ul', { class: 'claims' }, ...result.claims.map((claim) => el('li', { class: `claim ${claim.finding.toLowerCase()}` },
      el('p', { class: 'claim-head' }, el('span', { class: 'kind' }, KIND_TEXT[claim.kind] ?? claim.kind), el('span', { class: 'finding' }, FINDING_TEXT[claim.finding] ?? claim.finding)),
      el('p', { class: 'quote' }, `“${claim.quote}”`),
      el('p', {}, claim.sentence),
    ))));
    parts.push(el('p', { class: 'label' }, splitLabel(result)));
    parts.push(el('p', { class: 'note still-locked' }, 'Release is still locked. A reply can\'t change the hold: only new production data can.'));
  }
  return el('div', { class: 'excuse' }, ...parts);
}

// `amountCents` is what the page last showed. For a metered week the server works out the bill at the
// tap, and the reply's amount is the one PayPal was asked for.
async function tapRelease(milestone, button, amountCents) {
  button.disabled = true;
  state.notice = null;
  const metered = state.view.kind === 'neighbour';
  const path = `/api/contracts/${encodeURIComponent(state.id)}/milestones/${encodeURIComponent(milestone.id)}`;
  const tap = await api(`${path}/tap`, {}).catch(() => null);
  if (tap?.data?.outcome !== 'READY') {
    state.notice = { text: metered ? 'The server refused: this week isn\'t over yet. No money moved.' : 'The server refused the release because the verdict is not ready. No money moved.', good: false };
    state.json = '';
    return refresh();
  }
  const result = await api(`${path}/release`, { tap: tap.data.token }).catch(() => null);
  const outcome = result?.data?.outcome;
  const amount = usd(result?.data?.milestone?.amountCents ?? amountCents);
  const messages = {
    CAPTURED: { text: `PayPal captured ${amount}.`, good: true },
    PENDING: { text: `PayPal accepted the capture of ${amount}, and it is pending.`, good: true },
    NOTHING_DUE: { text: `${milestone.title} closed at $0.00. Nothing was owed, so PayPal wasn't called.`, good: true },
    ALREADY_RELEASED: { text: metered ? 'This week was already settled, so nothing was captured twice.' : 'This milestone was already released, so nothing was captured twice.', good: true },
    DECLINED: { text: `PayPal declined this capture. The ${metered ? 'week' : 'milestone'} is still unpaid, and you can try again.`, good: false },
    REJECTED: { text: `PayPal refused the capture, so no money moved: ${result?.data?.error ?? ''}`, good: false },
    LOCKED: { text: metered ? 'This week isn\'t over yet, so nothing was captured.' : 'The verdict changed before the capture, so nothing was captured.', good: false },
  };
  state.notice = messages[outcome] ?? { text: 'PayPal didn\'t give a clear answer. Don\'t assume the money moved or didn\'t: a retry is safe and can\'t capture twice.', good: false };
  state.json = '';
  await refresh();
  // The last week also returns the unused hold.
  if (metered && state.view?.status === 'VOIDED' && state.notice?.good) {
    state.notice = { text: `${state.notice.text} The unused ${usd(state.view.returnedCents)} went back to the buyer.`, good: true };
    render();
  }
}

async function moveTo(date) {
  if (state.busy) return;
  state.busy = true;
  state.notice = null;
  const { ok } = await api(`/api/contracts/${encodeURIComponent(state.id)}/replay`, { to: date }).catch(() => ({ ok: false }));
  if (!ok) state.notice = { text: 'Those recorded days could not be added.', good: false };
  state.busy = false;
  state.json = '';
  await refresh();
}

// Presses Next day for the reader, through the same server clock, until the check passes or the recorded days run out.
// It stops on any refusal, and when the reader presses Pause. Each run has a number, so a quick Pause and Play can't leave two loops going.
let playRun = 0;
async function play() {
  if (state.playing || state.busy) return;
  const run = ++playRun;
  state.playing = true;
  render();
  while (state.playing && run === playRun) {
    const view = state.view;
    const milestone = view === null ? null : currentMilestone(view);
    if (view === null || view.status !== 'HELD' || milestone === null || view.clock.waitingUntil !== null) break;
    if (view.clock.date >= view.clock.lastDate || milestone.verdict?.status === 'RELEASE_READY') break;
    const started = Date.now();
    await moveTo(addDays(view.clock.date, 1));
    if (state.view === null || state.view.clock.date === view.clock.date || (state.notice !== null && !state.notice.good)) break;
    const rest = PLAY_STEP_MS - (Date.now() - started);
    if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
  }
  if (run !== playRun) return;
  state.playing = false;
  if (state.view === null) return;
  render();
  loadExplanation();
  loadAgent();
  loadRecord();
}

function renderPlay(view) {
  if (state.playing) {
    const pause = el('button', { class: 'btn play on', type: 'button', on: { click: () => { state.playing = false; render(); } } }, icon('pause', 14), 'Pause');
    pause.setAttribute('aria-pressed', 'true');
    return pause;
  }
  const done = view.clock.date >= view.clock.lastDate || currentMilestone(view)?.verdict?.status === 'RELEASE_READY';
  const button = el('button', { class: 'btn play', type: 'button', disabled: state.busy || done, on: { click: play } }, icon('play', 14), 'Play');
  button.setAttribute('aria-pressed', 'false');
  return button;
}

async function voidRest() {
  const tap = await api(`/api/contracts/${encodeURIComponent(state.id)}/void/tap`, {}).catch(() => null);
  const result = tap?.data?.token ? await api(`/api/contracts/${encodeURIComponent(state.id)}/void`, { tap: tap.data.token }).catch(() => null) : null;
  state.confirmVoid = false;
  state.notice = result?.data?.outcome === 'VOIDED'
    ? { text: 'The rest of the hold went back to the buyer.', good: true }
    : { text: 'The hold could not be voided, so it is still in place.', good: false };
  state.json = '';
  await refresh();
}

// The rule, drawn: the 7-day average against the 70% line, and each judged day against the 30% floor.
function renderMeter(verdict) {
  const SCALE = 1.3;
  const pos = (r) => `${(Math.min(Math.max(r, 0), SCALE) / SCALE) * 100}%`;
  const ready = verdict.status === 'RELEASE_READY';
  const parts = [];
  if (verdict.mean !== null) {
    const fill = el('span', { class: 'meter-fill' });
    fill.style.width = pos(verdict.mean);
    const mark = el('span', { class: 'meter-mark' });
    mark.style.left = pos(0.7);
    parts.push(
      el('div', { class: 'meter-top' }, el('span', {}, '7-day average, share of usual'), el('b', { class: 'mono' }, `${Math.round(verdict.mean * 100)}%`)),
      el('div', { class: 'meter-track', role: 'img', ariaLabel: `7-day average ${Math.round(verdict.mean * 100)}% of usual; release needs 70%` }, fill, mark),
      el('div', { class: 'meter-scale mono' }, el('span', {}, '0%'), (() => { const t = el('span', { class: 'need' }, 'needs 70%'); t.style.left = pos(0.7); return t; })(), el('span', {}, '130%')),
    );
  }
  if (verdict.window.length > 0) {
    parts.push(el('ol', { class: 'days', ariaLabel: 'Each judged day, share of usual. No day may fall under 30%.' }, ...verdict.window.map((day) => {
      const r = day.ratio;
      const kind = r === null ? 'none' : r < 0.3 ? 'low' : r < 0.7 ? 'mid' : 'ok';
      return el('li', { class: kind, title: `${fullDate(day.date)}: ${r === null ? 'no reading' : `${Math.round(r * 100)}% of usual`}` },
        el('span', { class: 'd' }, shortDate(day.date)),
        el('b', { class: 'mono' }, r === null ? '—' : `${Math.round(r * 100)}%`));
    })));
    parts.push(el('p', { class: 'meter-key' }, 'Each judged day, share of usual. No day may fall under 30%.'));
  }
  return el('div', { class: `meter ${ready ? 'is-ready' : 'is-hold'}` }, ...parts);
}

function renderVerdict(view) {
  const milestone = currentMilestone(view);
  const parts = [];
  const pill = (kind, iconName, text) => el('span', { class: `pill ${kind}` }, icon(iconName, 14), text);

  if (view.status === 'AWAITING_APPROVAL') {
    parts.push(
      el('div', { class: 'eyebrow' }, el('span', {}, 'Hold not placed yet'), pill('quiet', 'clock', 'WAITING')),
      el('h1', {}, `Approve the ${usd(view.totalCents)} hold on PayPal.`),
      el('p', { class: 'sub' }, state.holdNote ?? 'Approving only places a hold. No money moves until a milestone is released.'),
    );
    if (view.approveUrl) parts.push(el('a', { class: 'release ready', href: view.approveUrl }, 'Continue to PayPal', icon('arrow', 18)));
  } else if (view.status === 'VOIDED') {
    parts.push(
      el('div', { class: 'eyebrow' }, el('span', {}, 'Contract finished'), pill('quiet', 'check', 'VOIDED')),
      el('h1', {}, `${usd(view.returnedCents)} went back to the buyer.`),
      el('p', { class: 'sub' }, view.releasedCents > 0 ? `${usd(view.releasedCents)} was released before that.` : 'Nothing was captured.'),
    );
  } else if (milestone === null) {
    parts.push(
      el('div', { class: 'eyebrow' }, el('span', {}, 'Contract finished'), pill('ready', 'check', 'PAID')),
      el('h1', {}, `All ${usd(view.releasedCents)} released.`),
      el('p', { class: 'sub' }, 'Each milestone was released by a person, only after the data passed.'),
    );
  } else {
    const number = view.milestones.indexOf(milestone) + 1;
    const label = `Milestone ${number} of ${view.milestones.length} · ${milestone.title}`;
    const verdict = milestone.verdict;
    if (verdict === null) {
      parts.push(
        el('div', { class: 'eyebrow' }, el('span', {}, label), pill('quiet', 'clock', 'NOT DUE')),
        el('h1', {}, `${usd(milestone.amountCents)} stays on hold.`),
        el('p', { class: 'sub' }, `This milestone is first checked on ${fullDate(milestone.opensOn)}, 30 days after the last release.`),
        el('button', { class: 'release locked', type: 'button', disabled: true }, icon('lock', 18), 'Release locked'),
      );
    } else if (verdict.status === 'RELEASE_READY') {
      const button = el('button', { class: 'release ready', type: 'button', on: { click: () => tapRelease(milestone, button, milestone.amountCents) } }, `Release ${usd(milestone.amountCents)}`);
      parts.push(
        el('div', { class: 'eyebrow' }, el('span', {}, label), pill('ready', 'check', 'RELEASE_READY')),
        el('h1', {}, `${usd(milestone.amountCents)} can be released.`),
        el('p', { class: 'sub' }, `The check passed on ${fullDate(verdict.date)}. Nothing is captured until a person taps.`),
        renderMeter(verdict),
        button,
        el('p', { class: 'after' }, 'The data can only unlock this button. PayPal captures only if you tap it.'),
      );
    } else {
      parts.push(
        el('div', { class: 'eyebrow' }, el('span', {}, label), pill('hold', 'lock', 'HOLD')),
        el('h1', {}, `${usd(milestone.amountCents)} stays on hold.`),
        el('p', { class: 'sub' }, `Judged on ${fullDate(verdict.date)}. No money has moved.`),
        renderMeter(verdict),
        el('ul', { class: 'reasons' }, ...verdict.reasonText.map((text) => el('li', {}, text))),
        el('button', { class: 'release locked', type: 'button', disabled: true }, icon('lock', 18), 'Release locked'),
        el('p', { class: 'after' }, 'Only new production data can change this. A message from the installer can\'t.'),
      );
    }
  }
  if (state.notice !== null) parts.push(el('p', { class: `notice${state.notice.good ? ' good' : ''}`, role: 'status' }, state.notice.text));
  const verdict = milestone?.verdict ?? null;
  const tone = view.status === 'HELD' && verdict !== null ? (verdict.status === 'RELEASE_READY' ? 'ready' : 'hold') : milestone === null && view.status !== 'VOIDED' && view.status !== 'AWAITING_APPROVAL' ? 'ready' : 'quiet';
  return el('section', { class: `card verdict tone-${tone}` }, ...parts);
}

function renderClock(view) {
  const { clock } = view;
  const live = view.kind === 'neighbour' ? currentWeek(view) : currentMilestone(view);
  const canMove = view.status === 'HELD' && live !== null;
  // A billing week's clock stops at its last day, until that week is settled.
  const weekOver = view.kind === 'neighbour' && live?.due === true;
  const controls = [];
  const player = view.kind === 'install' && canMove && clock.waitingUntil === null ? renderPlay(view) : null;
  if (canMove) {
    if (clock.waitingUntil === null) {
      controls.push(el('button', { class: 'btn', type: 'button', disabled: clock.date >= clock.lastDate || weekOver || state.busy || state.playing, on: { click: () => moveTo(addDays(clock.date, 1)) } }, 'Next day'));
    }
    for (const stop of clock.stops) {
      controls.push(el('button', { class: 'btn stop', type: 'button', disabled: state.busy || state.playing, on: { click: () => moveTo(stop.date) } }, shortDate(stop.date), el('small', {}, stop.label)));
    }
  }
  const cap = weekOver ? `${live.title} is over. Settle it to start the next week.`
    : state.playing ? 'Playing one recorded day at a time. Pause any time.'
      : canMove ? 'Newest recorded day shown. One way only, like real time.' : 'Last recorded day used.';
  return el('section', { class: 'rail', ariaLabel: 'Replay' },
    el('div', { class: 'now' },
      el('span', { class: 'kicker' }, canMove ? 'Replaying real readings' : 'Replay finished'),
      el('b', { class: 'mono' }, clock.label),
      el('span', { class: 'cap' }, cap),
    ),
    controls.length > 0 ? el('div', { class: 'controls' }, player, el('span', { class: 'jump' }, 'Jump to'), ...controls) : null,
  );
}

// ---------- Two rules, one month ----------
// The first milestone's money under the one-good-day rule and under this check, one cell per recorded day.
// The server sends only days already seen. The rest of the month is drawn empty, so its length shows without its data.
const dayCount = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isReleased = (milestone) => milestone.status === 'CAPTURED' || milestone.status === 'PENDING';

// `hint` ends the opening line, so the hold page can point at Play and the landing page can stay quiet.
function raceWords(race, { unit, released, ready, hint }) {
  const amount = usd(race.amountCents);
  const after = `${plural(race.underFloorSincePaid, 'day')} under 30% of usual${race.noReadingSincePaid > 0 ? ` and ${race.noReadingSincePaid} with no reading` : ''}`;
  const looking = race.simplePaidOn === null ? 'The one-good-day rule hadn\'t paid either.' : `The one-good-day rule had paid on ${shortDate(race.simplePaidOn)}. After that, ${unit} had ${after}.`;
  if (released) return [`A person released the ${amount} on ${shortDate(race.through)}.`, looking];
  if (ready) return [`This check passed on ${shortDate(race.oursReadyOn ?? race.through)}. A person can release the ${amount}.`, looking];
  if (race.simplePaidOn !== null) {
    const since = race.underFloorSincePaid + race.noReadingSincePaid === 0
      ? `It paid on the first day ${unit} reached 70% of its usual share. This check needs a 7-day average of 70%, with no day under 30%.`
      : `Since then, ${unit} has had ${after}.`;
    return [`The one-good-day rule paid the ${amount} on ${shortDate(race.simplePaidOn)}. This check is still holding it.`, since];
  }
  return [`Both rules are still holding the ${amount}.`, `The one-good-day rule pays on the first day ${unit} reaches 70% of its usual share.${hint}`];
}

function renderRace(view) {
  if (!view.race) return null;
  const first = view.milestones[0];
  const opts = { unit: view.source.unit, released: isReleased(first), ready: first.verdict?.status === 'RELEASE_READY', hint: state.playing ? '' : ' Press Play to watch the month.' };
  return el('section', { class: 'card race', ariaLabel: `${usd(view.race.amountCents)} under two pay rules` },
    el('p', { class: 'kicker' }, `Same ${usd(view.race.amountCents)}, two rules`),
    ...raceParts(view.race, opts),
  );
}

// The headline, the line under it, the three tracks and the key. The hold page and the landing page draw the same parts.
function raceParts(race, { unit, released, ready, hint }) {
  const amount = usd(race.amountCents);
  const seen = new Map(race.days.map((day) => [day.date, day]));
  const dates = Array.from({ length: dayCount(race.from, race.end) + 1 }, (_, k) => addDays(race.from, k));
  const tip = (day, text) => `${fullDate(day.date)}: ${text}`;
  const reading = (day) => (day.noReading ? 'no reading' : day.share === null ? 'no share for this day' : `${Math.round(day.share * 100)}% of usual`);

  const track = (kind, cellFor) => {
    const list = el('ol', { class: `race-track ${kind}`, ariaHidden: 'true' }, ...dates.map((date) => {
      const day = seen.get(date);
      const cell = day === undefined ? el('li', { class: 'future' }) : cellFor(day);
      if (date === race.through) cell.classList.add('is-new');
      return cell;
    }));
    list.style.setProperty('--days', String(dates.length));
    return list;
  };
  const SCALE = 1.3;
  const bars = track('bars', (day) => {
    const kind = day.noReading || day.share === null ? 'none' : day.belowFloor ? 'low' : day.share < 0.7 ? 'mid' : 'ok';
    const bar = el('li', { class: kind, title: tip(day, reading(day)) });
    if (day.share !== null) bar.style.setProperty('--h', String(Math.min(Math.max(day.share, 0), SCALE) / SCALE));
    return bar;
  });
  const simple = track('lane', (day) => {
    if (day.simple === 'WAITING') return el('li', { class: 'held', title: tip(day, `holding ${amount}`) });
    if (day.date === race.simplePaidOn) return el('li', { class: 'paid', title: tip(day, `paid ${amount}`) });
    return el('li', { class: `gone${day.noReading ? ' none' : day.belowFloor ? ' low' : ''}`, title: tip(day, `already paid, inverter at ${reading(day)}`) });
  });
  const ours = track('lane', (day) => (day.ours === 'RELEASE_READY'
    ? el('li', { class: released && day.date === race.through ? 'ready released' : 'ready', title: tip(day, 'check passes') })
    : el('li', { class: 'held', title: tip(day, `holding ${amount}`) })));

  const label = (name, status, kind) => el('div', { class: 'race-label' }, el('b', {}, name), status === null ? null : el('small', { class: kind }, status));
  const row = (head, list) => el('div', { class: 'race-row' }, head, list);
  const axis = el('div', { class: 'race-axis', ariaHidden: 'true' }, el('span', { class: 'a-from' }, shortDate(race.from)), el('span', { class: 'a-end' }, shortDate(race.end)));
  axis.style.setProperty('--days', String(dates.length));
  if (race.simplePaidOn !== null) {
    const mark = el('span', { class: 'a-paid' }, `${shortDate(race.simplePaidOn)} · paid`);
    mark.style.gridColumn = `${dayCount(race.from, race.simplePaidOn) + 1} / -1`;
    axis.append(mark);
  }
  const [headline, sub] = raceWords(race, { unit, released, ready, hint });
  const key = (kind, text) => el('span', {}, el('i', { class: `k-${kind}` }), text);

  return [
    el('h2', {}, headline),
    el('p', { class: 'race-sub' }, sub),
    el('div', { class: 'race-rows' },
      row(label(unit, 'share of usual', 'quiet'), bars),
      row(label('Pays after one good day', race.simplePaidOn === null ? 'holding' : `paid ${shortDate(race.simplePaidOn)}`, race.simplePaidOn === null ? 'held' : 'paid'), simple),
      row(label('This check', released ? 'released' : ready ? 'passed' : 'holding', released || ready ? 'ready' : 'held'), ours),
      row(el('div', { class: 'race-label' }), axis),
    ),
    el('p', { class: 'race-legend' },
      key('held', `Holding ${amount}`),
      key('paid', 'Paid out'),
      key('gone-low', 'Already paid, inverter under 30%'),
      key('gone-none', 'Already paid, no reading'),
      key('ready', 'Check passes'),
    ),
  ];
}

// ---------- The race on the landing page ----------
// The same month and the same drawing as the hold page, with no hold behind it. It plays once when it scrolls into view,
// one recorded day at a time, and stops longer where the two rules part. With reduced motion it opens on the last day.
const RACE_STEP_MS = 320;
const RACE_PAUSE_MS = 1600;

function renderLandingRace(slot) {
  let race = null;
  let unit = '';
  let shown = 0;
  let timer = null;
  const when = el('span', { class: 'race-now mono' });
  const button = el('button', { class: 'btn race-replay', type: 'button', on: { click: () => (timer === null ? play() : stop()) } });
  const body = el('div', { class: 'race-body' });
  const draw = () => {
    const now = raceUpTo(race, shown);
    when.textContent = fullDate(now.through);
    body.replaceChildren(...raceParts(now, { unit, released: false, ready: now.oursReadyOn !== null, hint: '' }));
    const done = shown >= race.days.length;
    button.replaceChildren(icon(timer === null ? 'play' : 'pause', 14), timer === null ? (done ? 'Replay' : 'Play') : 'Pause');
  };
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    draw();
  };
  const tick = () => {
    shown += 1;
    const before = raceUpTo(race, shown - 1);
    const now = raceUpTo(race, shown);
    const parted = now.simplePaidOn !== null && before.simplePaidOn === null;
    const passed = now.oursReadyOn !== null && before.oursReadyOn === null;
    if (shown >= race.days.length) {
      timer = null;
      draw();
      return;
    }
    timer = setTimeout(tick, parted || passed ? RACE_PAUSE_MS : RACE_STEP_MS);
    draw();
  };
  const play = () => {
    if (shown >= race.days.length) shown = 1;
    timer = setTimeout(tick, RACE_STEP_MS);
    draw();
  };

  api('/api/race').then(({ ok, data }) => {
    if (!ok || !data.race || data.race.days.length === 0) return;
    race = data.race;
    unit = data.unit;
    const amount = usd(race.amountCents);
    slot.replaceChildren(el('section', { class: 'card race landing-race', ariaLabel: `${amount} under two pay rules, ${fullDate(race.from)} to ${fullDate(race.end)}` },
      el('div', { class: 'race-top' },
        el('p', { class: 'kicker' }, `Same ${amount}, two rules`),
        el('span', { class: 'race-replaying' }, 'Replaying ', when),
        button,
      ),
      body,
      el('p', { class: 'race-note' }, `${unit}'s recorded days, judged by the same code as a real hold. Nothing is held and no money moves here. Start a hold above to try Release yourself.`),
    ));
    slot.hidden = false;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    shown = still ? race.days.length : 1;
    draw();
    if (still || !('IntersectionObserver' in window)) return;
    const watch = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      watch.disconnect();
      if (timer === null && shown === 1) play();
    }, { threshold: 0.4 });
    watch.observe(slot);
  }).catch(() => {});
}

// The chart's shaded band: the 7 judged days, or the days of the billing week seen so far.
let chartWindow = 7;
let chartLabel;

function renderEvidence(view) {
  chartHost = el('div', { class: 'chart' });
  chartDays = view.history;
  const neighbour = view.kind === 'neighbour';
  chartWindow = neighbour ? (currentWeek(view)?.days.length ?? 0) : 7;
  chartLabel = neighbour ? 'Daily production of this inverter and the median of the other inverters, with measured sun below. This week\'s days are listed in the bill above.' : undefined;
  return el('section', { class: 'card evidence' },
    el('div', { class: 'card-head' }, el('h2', {}, `${view.source.unit}: last 45 days`), el('span', { class: 'unit mono' }, 'kWh a day')),
    el('div', { class: 'legend' },
      el('span', {}, el('i', { class: 'k-own' }), 'This inverter'),
      el('span', {}, el('i', { class: 'k-peers' }), 'Other inverters (median)'),
      chartWindow > 0 ? el('span', {}, el('i', { class: 'k-window' }), neighbour ? 'This billing week' : '7 days judged') : null,
    ),
    chartHost,
  );
}

function renderMoney(view) {
  const parts = [
    el('div', { class: 'card-head' }, el('h2', {}, 'PayPal hold'), el('span', { class: 'unit mono' }, usd(view.totalCents))),
    el('dl', { class: 'money' },
      el('div', {}, el('dt', {}, 'Held'), el('dd', {}, usd(view.heldCents))),
      el('div', {}, el('dt', {}, 'Released'), el('dd', {}, usd(view.releasedCents))),
      el('div', {}, el('dt', {}, 'Returned'), el('dd', {}, usd(view.returnedCents))),
    ),
  ];
  const bar = el('div', { class: 'bar', role: 'presentation' });
  for (const [cents, cls] of [[view.releasedCents, 'b-out'], [view.heldCents, 'b-held'], [view.returnedCents, 'b-back']]) {
    if (cents > 0) {
      const part = el('span', { class: cls });
      part.style.flex = `${cents} 0 0`;
      bar.append(part);
    }
  }
  parts.push(bar);
  const facts = [];
  if (view.authorizationId) facts.push(el('span', {}, 'Authorization ', el('span', { class: 'mono' }, view.authorizationId)));
  if (view.expiresAt && view.status === 'HELD') facts.push(el('span', {}, `Hold expires ${fullDate(view.expiresAt.slice(0, 10))}`));
  if (facts.length > 0) parts.push(el('div', { class: 'facts' }, ...facts));
  parts.push(view.kind === 'neighbour' ? renderWeeks(view) : renderMilestones(view));
  recordHost = el('div', { class: 'paypal-record' });
  parts.push(recordHost);
  if (view.status === 'HELD' && view.heldCents > 0) {
    parts.push(state.confirmVoid
      ? el('div', { class: 'void' },
        el('span', {}, `Return ${usd(view.heldCents)} to the buyer?`),
        el('button', { class: 'btn', type: 'button', on: { click: voidRest } }, 'Return it'),
        el('button', { class: 'linkish', type: 'button', on: { click: () => { state.confirmVoid = false; render(); } } }, 'Keep holding'))
      : el('div', { class: 'void' }, el('button', { class: 'linkish', type: 'button', on: { click: () => { state.confirmVoid = true; render(); } } }, 'Give the rest back to the buyer')));
  }
  parts.push(renderTimeline(view));
  return el('section', { class: 'card money-card' }, ...parts);
}

// PayPal's own record of this order, read with the Agent Toolkit's get_order tool. It's asked for
// again only when the money changes, so stepping through days doesn't call PayPal.
function loadRecord() {
  const view = state.view;
  const key = view.authorizationId ? JSON.stringify([view.status, view.authorizationId, (view.milestones ?? view.weeks).map((m) => [m.status, m.captureId])]) : null;
  if (key === state.recordKey) return;
  state.recordKey = key;
  state.record = null;
  renderRecord();
  if (key === null) return;
  api(`/api/contracts/${encodeURIComponent(state.id)}/paypal-record`).catch(() => ({ ok: false, data: {} })).then(({ ok, data }) => {
    if (state.recordKey !== key) return;
    state.record = ok && data.record ? data : { failed: true };
    renderRecord();
  });
}

const AUTH_TEXT = { CREATED: 'hold open', PARTIALLY_CAPTURED: 'hold open', PENDING: 'hold open', CAPTURED: 'hold fully captured', VOIDED: 'rest of the hold voided', EXPIRED: 'hold expired', DENIED: 'hold denied' };

let recordHost = null;
function renderRecord() {
  if (recordHost === null || state.view === null) return;
  const sample = state.view.mode === 'sample';
  const parts = [el('h3', {}, 'PayPal\'s own record')];
  const reply = state.record;
  if (state.recordKey === null) {
    parts.push(el('p', { class: 'note' }, 'Appears once the hold is placed.'));
  } else if (reply === null) {
    parts.push(el('p', { class: 'note' }, sample ? 'Loading the recorded reply…' : 'Asking PayPal…'));
  } else if (reply.failed) {
    parts.push(el('p', { class: 'note' }, 'Couldn\'t read PayPal\'s record just now. This doesn\'t change the hold.'));
  } else {
    const { record, check } = reply;
    const auth = record.authorizations.find((a) => a.id === state.view.authorizationId) ?? null;
    const captured = check.capturedCents.paypal;
    parts.push(el('dl', { class: 'record' },
      el('div', {}, el('dt', {}, 'Order'), el('dd', { class: 'mono' }, record.status ?? 'not given')),
      el('div', {}, el('dt', {}, 'Authorization'), el('dd', { class: 'mono' }, auth?.status ?? 'not listed')),
      el('div', {}, el('dt', {}, 'Captured'), el('dd', { class: 'mono' }, captured === null ? 'unreadable' : usd(captured))),
    ));
    const hold = AUTH_TEXT[auth?.status] ?? `authorization ${auth?.status ?? 'not listed'}`;
    parts.push(check.agrees
      ? el('p', { class: 'match yes' }, `Agrees with this page: ${usd(check.capturedCents.app)} captured, ${hold}.`)
      : el('p', { class: 'match no' }, `Differs from this page. PayPal: ${captured === null ? 'an amount this page can\'t read' : usd(captured)} captured, ${hold}. This page: ${usd(check.capturedCents.app)} captured, hold ${state.view.status === 'HELD' ? 'open' : 'closed'}.`));
    parts.push(el('p', { class: 'note' }, sample
      ? 'Recorded reply in the shape of the Agent Toolkit\'s get_order tool, built from this demo\'s state. No PayPal call in sample mode.'
      : `Read live from the PayPal sandbox with the Agent Toolkit's get_order tool at ${reply.readAt.slice(11, 19)} UTC. Read-only.`));
  }
  parts.push(el('p', { class: 'note' }, 'This read can\'t move money: the app only ever calls get_order, and no AI is involved.'));
  recordHost.replaceChildren(...parts);
}

const STATUS_TEXT = {
  WAITING: 'Waiting for proof',
  CAPTURING: 'Capturing…',
  CAPTURE_UNKNOWN: 'PayPal gave no clear answer. A retry can\'t capture twice.',
  PENDING: 'Capture pending at PayPal',
  CAPTURED: 'Released by a person and captured',
  DECLINED: 'PayPal declined. Not paid.',
  REFUNDED: 'Refunded',
  REVERSED: 'Reversed',
  NOTHING_DUE: 'Nothing measured, so closed at $0.00. PayPal wasn\'t called.',
};

function renderMilestones(view) {
  return el('div', { class: 'miles-wrap' },
    el('h3', {}, 'Milestones'),
    el('ol', { class: 'miles' }, ...view.milestones.map((m) => {
      let note = STATUS_TEXT[m.status] ?? m.status;
      if (m.status === 'WAITING' && !m.isCurrent) note = view.status === 'VOIDED' ? 'Not paid' : 'Checked 30 days after the milestone before it is released';
      if (m.status === 'WAITING' && m.isCurrent && view.status === 'VOIDED') note = 'Not paid';
      if (m.captureId) note += ` · ${m.captureId}`;
      const kind = m.status === 'CAPTURED' ? 'paid' : m.isCurrent && view.status === 'HELD' ? 'now' : 'later';
      return el('li', { class: kind }, el('span', { class: 't' }, m.title), el('span', { class: 'a' }, usd(m.amountCents)), el('span', { class: 's' }, note));
    })),
  );
}

const EVENT_TEXT = {
  ORDER_CREATED: 'Order created',
  HOLD_PLACED: 'Hold placed. No money moved.',
  RECORDED_DAYS_ADDED: 'Recorded days added',
  RELEASE_REFUSED_HOLD: 'Release refused: verdict is HOLD',
  HUMAN_TAPPED_RELEASE: 'A person tapped Release',
  CAPTURE_CAPTURED: 'Capture completed',
  CAPTURE_PENDING: 'Capture pending',
  CAPTURE_DECLINED: 'Capture declined',
  CAPTURE_REJECTED: 'Capture refused',
  CAPTURE_UNKNOWN: 'No clear answer from PayPal',
  CAPTURE_REFUNDED: 'Capture refunded',
  CAPTURE_REVERSED: 'Capture reversed',
  CONTRACT_CLOSED: 'Contract closed',
  HOLD_VOIDED: 'Rest of the hold voided',
  HOLD_VOIDED_OR_EXPIRED: 'Hold voided or expired',
  HOLD_REAUTHORIZED: 'Hold reauthorized',
  RELEASE_REFUSED_OPEN_WEEK: 'Release refused: the week isn\'t over',
  HUMAN_CLOSED_EMPTY_WEEK: 'A person closed a $0.00 week. No PayPal call.',
  REST_RETURNED: 'Unused hold voided and returned to the buyer',
  REST_NOT_RETURNED: 'PayPal didn\'t confirm the void. The rest is still held.',
};

function renderTimeline(view) {
  const sources = { app: 'App', paypal: view.mode === 'sample' ? 'Recorded' : 'PayPal', webhook: 'Webhook' };
  // Stepping through days adds many entries, so only the latest of a run is shown.
  const entries = view.timeline.filter((entry, i, all) => !(entry.type === 'RECORDED_DAYS_ADDED' && all[i + 1]?.type === 'RECORDED_DAYS_ADDED'));
  return el('details', { class: 'timeline' },
    el('summary', {}, `Timeline · ${entries.length} ${entries.length === 1 ? 'event' : 'events'}`),
    el('ol', { class: 'feed' }, ...[...entries].reverse().map((entry) => el('li', {},
      el('span', { class: 'src' }, sources[entry.source] ?? entry.source),
      el('span', { class: 'tx' }, EVENT_TEXT[entry.type] ?? entry.type,
        entry.detail ? el('small', {}, `through ${fullDate(entry.detail)}`) : null,
        entry.debugId ? el('small', { class: 'mono' }, `debug ${entry.debugId}`) : null),
    ))),
  );
}

// The ledger sits outside the part that gets rebuilt, so its sort, filters and scroll position survive a new view.
let boardHost = null;
let ledger = null;

// ---------- Neighbour contract ----------
const kwh = (tenths) => `${(tenths / 10).toFixed(1)} kWh`;

function currentWeek(view) {
  return view.weeks.find((w) => w.isCurrent) ?? null;
}

const weekDates = (w) => `${shortDate(w.from)} to ${shortDate(w.through)}`;

// Seven cells, one per day. Days not recorded yet stay blank, so nothing ahead of the clock shows.
function renderWeekDays(week) {
  const cells = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(week.from, i);
    const day = week.days.find((d) => d.date === date);
    if (day === undefined) return el('li', { class: 'none', title: `${fullDate(date)}: not recorded yet` }, el('span', { class: 'd' }, shortDate(date)), el('b', { class: 'mono' }, '·'));
    const kind = day.tenths === null ? 'none' : day.tenths === 0 ? 'low' : 'ok';
    return el('li', { class: kind, title: `${fullDate(date)}: ${day.tenths === null ? 'no reading, counted as 0' : kwh(day.tenths)}` },
      el('span', { class: 'd' }, shortDate(date)),
      el('b', { class: 'mono' }, day.tenths === null ? '—' : (day.tenths / 10).toFixed(1)));
  });
  return el('div', { class: 'meter bill' },
    el('div', { class: 'meter-top' }, el('span', {}, `${kwh(week.tenths)} × $0.10 a kWh`), el('b', { class: 'mono' }, usd(week.cents))),
    el('ol', { class: 'days', ariaLabel: 'Measured kWh each day of this week' }, ...cells),
    el('p', { class: 'meter-key' }, `kWh each day, read to the tenth and rounded down. A missing day counts as 0. Capped at ${usd(week.capCents)} a week.`),
  );
}

function renderWeekCard(view) {
  const week = currentWeek(view);
  const parts = [];
  const pill = (kind, iconName, text) => el('span', { class: `pill ${kind}` }, icon(iconName, 14), text);
  let tone = 'quiet';

  if (view.status === 'AWAITING_APPROVAL') {
    parts.push(
      el('div', { class: 'eyebrow' }, el('span', {}, 'Hold not placed yet'), pill('quiet', 'clock', 'WAITING')),
      el('h1', {}, `Approve the ${usd(view.totalCents)} hold on PayPal.`),
      el('p', { class: 'sub' }, state.holdNote ?? 'Approving only places a hold. Each week is billed from the readings, and only after a person taps.'),
    );
    if (view.approveUrl) parts.push(el('a', { class: 'release ready', href: view.approveUrl }, 'Continue to PayPal', icon('arrow', 18)));
  } else if (view.status === 'VOIDED') {
    tone = view.releasedCents > 0 ? 'ready' : 'quiet';
    parts.push(
      el('div', { class: 'eyebrow' }, el('span', {}, 'Contract finished'), pill('quiet', 'check', 'SETTLED')),
      el('h1', {}, `${usd(view.releasedCents)} paid for measured power.`),
      el('p', { class: 'sub' }, `The unused ${usd(view.returnedCents)} went back to the buyer.`),
    );
  } else if (week === null && view.status === 'HELD') {
    // Every week is settled but money is still held: the last capture is pending, or PayPal didn't confirm the void.
    const pending = view.weeks.some((w) => w.status === 'PENDING');
    parts.push(
      el('div', { class: 'eyebrow' }, el('span', {}, 'All weeks settled'), pill('hold', 'lock', 'STILL HELD')),
      el('h1', {}, `${usd(view.heldCents)} is still held.`),
      el('p', { class: 'sub' }, pending
        ? 'A capture is still pending at PayPal, so the unused hold wasn\'t returned yet. You can give it back below.'
        : 'PayPal didn\'t confirm returning the unused hold. You can try again below. Nothing more can be captured.'),
    );
  } else if (week === null) {
    tone = 'ready';
    parts.push(
      el('div', { class: 'eyebrow' }, el('span', {}, 'Contract finished'), pill('ready', 'check', 'PAID')),
      el('h1', {}, `${usd(view.releasedCents)} paid for measured power.`),
      el('p', { class: 'sub' }, 'Every week was billed at its cap, so the whole hold was used.'),
    );
  } else {
    const label = `${week.title} of ${view.weeks.length} · ${weekDates(week)}`;
    if (!week.due) {
      const seen = week.days.length;
      parts.push(
        el('div', { class: 'eyebrow' }, el('span', {}, label), pill('quiet', 'clock', 'MEASURING')),
        el('h1', {}, seen === 0 ? `${week.title} hasn't started.` : `${kwh(week.tenths)} so far.`),
        el('p', { class: 'sub' }, `${seen} of 7 days recorded. The bill is worked out after ${fullDate(week.through)}, from the inverter's readings.`),
        renderWeekDays(week),
        el('button', { class: 'release locked', type: 'button', disabled: true }, icon('lock', 18), 'Locked until the week ends'),
        el('p', { class: 'after' }, `Up to ${usd(week.capCents)} of the hold covers this week. Nothing is captured while it runs.`),
      );
    } else if (week.cents > 0) {
      tone = 'ready';
      const button = el('button', { class: 'release ready', type: 'button', on: { click: () => tapRelease(week, button, week.cents) } }, `Release ${usd(week.cents)}`);
      parts.push(
        el('div', { class: 'eyebrow' }, el('span', {}, label), pill('ready', 'check', 'BILL READY')),
        el('h1', {}, `${usd(week.cents)} is due for ${week.title.toLowerCase()}.`),
        el('p', { class: 'sub' }, `The inverter measured ${kwh(week.tenths)}. Nothing is captured until a person taps.`),
        renderWeekDays(week),
        button,
        el('p', { class: 'after' }, 'The readings set the amount, on the server. You only decide whether it goes.'),
      );
    } else {
      const button = el('button', { class: 'release ready', type: 'button', on: { click: () => tapRelease(week, button, 0) } }, `Close ${week.title.toLowerCase()} at $0.00`);
      parts.push(
        el('div', { class: 'eyebrow' }, el('span', {}, label), pill('hold', 'lock', 'NOTHING DUE')),
        el('h1', {}, `Nothing is due for ${week.title.toLowerCase()}.`),
        el('p', { class: 'sub' }, `The inverter measured ${kwh(week.tenths)}, so there's no charge and no PayPal call.`),
        renderWeekDays(week),
        button,
        el('p', { class: 'after' }, 'Closing the week records it. No money moves.'),
      );
    }
    if (week.lastError) parts.push(el('p', { class: 'notice' }, `Last attempt: ${week.lastError}`));
  }
  if (state.notice !== null) parts.push(el('p', { class: `notice${state.notice.good ? ' good' : ''}`, role: 'status' }, state.notice.text));
  return el('section', { class: `card verdict tone-${tone}` }, ...parts);
}

function renderWeeks(view) {
  return el('div', { class: 'miles-wrap' },
    el('h3', {}, `Weeks · $0.10 a kWh, up to ${view.terms.capKwh} kWh a week`),
    el('ol', { class: 'miles' }, ...view.weeks.map((w) => {
      let note;
      let amount = `up to ${usd(w.capCents)}`;
      if (w.status === 'CAPTURED' || w.status === 'PENDING') {
        note = `${kwh(w.tenths)} measured. ${STATUS_TEXT[w.status]}`;
        amount = usd(w.cents);
      } else if (w.status === 'NOTHING_DUE') {
        note = STATUS_TEXT.NOTHING_DUE;
        amount = usd(0);
      } else if (view.status !== 'HELD') {
        note = 'Not billed';
      } else if (w.isCurrent && w.due) {
        note = `Over: ${kwh(w.tenths)} measured, waiting for a person`;
        amount = usd(w.cents);
      } else if (w.isCurrent) {
        note = `Running: ${kwh(w.tenths)} so far`;
      } else {
        note = STATUS_TEXT[w.status] === undefined || w.status === 'WAITING' ? 'Not started' : STATUS_TEXT[w.status];
      }
      if (w.captureId) note += ` · ${w.captureId}`;
      const kind = w.status === 'CAPTURED' ? 'paid' : w.isCurrent && view.status === 'HELD' ? 'now' : 'later';
      return el('li', { class: kind }, el('span', { class: 't' }, `${w.title} · ${weekDates(w)}`), el('span', { class: 'a' }, amount), el('span', { class: 's' }, note));
    })),
  );
}

// Said on the page, not only in the README.
function renderLimits(view) {
  return el('section', { class: 'card limits' },
    el('h2', {}, 'What this shows, and what it doesn\'t'),
    el('ul', {},
      el('li', {}, 'It bills what this inverter measured, not what a neighbour used. A real setup needs a meter on the neighbour\'s line.'),
      el('li', {}, 'Selling power to a neighbour can need the utility\'s or a regulator\'s permission. That depends on where you are, and this demo doesn\'t check it.'),
      el('li', {}, `These are 2020 readings from ${view.source.site}, not a home. The dataset's kWh figures run high, so the amounts show how billing works, not a real bill.`),
      el('li', {}, `$0.10 a kWh is a demo price, not a tariff. Each week is capped at ${view.terms.capKwh} kWh, above this inverter's best full week of 2020 before Sep 28.`),
      el('li', {}, `The contract runs ${view.terms.weeks} weeks, because a PayPal authorization is valid for 29 days.`),
    ),
  );
}

function renderNeighbour(view) {
  boardHost = null;
  aiHost = null;
  agentHost = null;
  app.replaceChildren(renderClock(view), el('div', { class: 'stage' },
    el('div', { class: 'main-col' }, renderWeekCard(view), renderEvidence(view), renderLimits(view)),
    el('div', { class: 'side-col' }, renderMoney(view)),
  ));
  renderRecord();
  drawChart(chartHost, chartDays, chartWindow, chartLabel);
}

function render() {
  const view = state.view;
  if (view.kind === 'neighbour') return renderNeighbour(view);
  if (boardHost === null || !boardHost.isConnected) {
    boardHost = el('div');
    ledger = createLedger();
    app.replaceChildren(boardHost, ledger.section);
  }
  aiHost = el('section', { class: 'card push' });
  agentHost = el('section', { class: 'card agent', ariaLabel: 'AI agent' });
  boardHost.replaceChildren(...[renderClock(view), renderRace(view), el('div', { class: 'stage' },
    el('div', { class: 'main-col' }, renderVerdict(view), agentHost, renderEvidence(view), aiHost),
    el('div', { class: 'side-col' }, renderMoney(view)),
  )].filter(Boolean));
  renderAi();
  renderAgent();
  renderRecord();
  drawChart(chartHost, chartDays, chartWindow, chartLabel);
  // The table catches up when Play stops, rather than rebuilding its grid every recorded day.
  if (!state.playing) ledger.show(view.id, view.clock.date, view.source.unit);
}

let lastWidth = 0;
new ResizeObserver(() => {
  if (chartHost === null || !chartHost.isConnected) return;
  const width = chartHost.clientWidth;
  if (Math.abs(width - lastWidth) > 4) {
    lastWidth = width;
    drawChart(chartHost, chartDays, chartWindow, chartLabel);
  }
}).observe(document.documentElement);

async function main() {
  if (location.pathname === '/judge') return renderJudge();
  const match = location.pathname.match(/^\/c\/([^/]+)$/);
  if (match === null) return renderLanding();
  state.id = decodeURIComponent(match[1]);
  const hold = new URLSearchParams(location.search).get('hold');
  if (hold === 'failed') state.holdNote = 'PayPal didn\'t confirm the hold, so no money moved. You can approve it again.';
  if (hold === 'cancelled') state.holdNote = 'You cancelled on PayPal, so no hold was placed.';
  await refresh();
  // Webhooks change the timeline without a click.
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.view !== null && (state.view.status === 'HELD' || state.view.status === 'AWAITING_APPROVAL')) refresh();
  }, 5000);
}

main().catch(() => {
  app.replaceChildren(el('p', { class: 'loading' }, 'The page could not load. Please refresh.'));
});
