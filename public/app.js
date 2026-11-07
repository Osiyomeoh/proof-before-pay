// The whole UI. Everything from the server is written with textContent, never as HTML.
// This page shows verdicts and sends taps. All decisions about money are made on the server.
import { drawChart, shortDate } from './chart.js';
import { el } from './dom.js';
import { createLedger } from './ledger.js';

const app = document.getElementById('app');
const modeTag = document.getElementById('mode');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function icon(kind, size = 16) {
  const paths = {
    lock: 'M6 7V5a4 4 0 0 1 8 0v2M5 7h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z',
    check: 'M4 10.5l4 4 8-9',
    clock: 'M10 5v5l3 2M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
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
async function startHold(button, notice) {
  button.disabled = true;
  notice.hidden = true;
  const { ok, status, data } = await api('/api/contracts', {}).catch(() => ({ ok: false, status: 0, data: {} }));
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

function holdStarter(label) {
  const notice = el('p', { class: 'notice', hidden: true });
  const button = el('button', { class: 'release ready', type: 'button', on: { click: () => startHold(button, notice) } }, label);
  button.style.width = 'auto';
  button.style.paddingInline = '24px';
  return { button, notice };
}

// Opening this page creates nothing, so a link preview or a crawler can't place a hold. Each press starts a new one,
// which also means a judge never meets an authorization that has expired.
async function renderJudge() {
  const mode = await loadMode();
  const { button, notice } = holdStarter('Start a fresh hold');
  const steps = [
    ['Start a fresh hold', mode === 'sample' ? '$100.00 goes on hold for two milestones. You land on Oct 12, 2020, with the inverter at zero and Release locked.' : 'Approve $100.00 on PayPal with the sandbox buyer login in the README. You land on Oct 12, 2020, with the inverter at zero and Release locked.'],
    ['Tap Oct 22', 'Output returns, and Release stays locked. One good day isn\'t enough.'],
    ['Tap Oct 26', 'Back to zero. A rule that pays after one good day would already have paid, on Oct 23 and 24.'],
    ['Tap Nov 19, then Release $40.00', 'The last 7 days pass the check, so Release unlocks. Nothing is captured until you tap it.'],
    ['Tap Dec 19, then Release $60.00', 'The second milestone is checked 30 days later. Releasing it closes the hold.'],
    ['Check our work', 'In the ledger, tap Rules disagree and download the CSV. Or start another hold and give the money back.'],
  ];
  app.replaceChildren(el('section', { class: 'landing' },
    el('div', {},
      el('h1', {}, 'Seven taps through a real outage.'),
      el('p', { class: 'lede' }, 'These are real 2020 readings from a commercial roof in Maui. Try to get paid before the system has proved itself.'),
      el('div', { class: 'start' },
        button,
        el('small', {}, mode === 'sample' ? 'Sample mode: no login and no money. PayPal and AI replies are recorded.' : 'Real PayPal sandbox calls. Test money only.'),
      ),
      notice,
    ),
    el('ol', { class: 'steps guide' }, ...steps.map(([title, text]) => el('li', {}, el('b', {}, title), el('span', {}, text)))),
  ));
}

async function renderLanding() {
  const mode = await loadMode();
  const { button, notice } = holdStarter('Hold $100.00 and watch the check');

  const steps = [
    ['PayPal holds the money', 'The buyer approves a $100.00 authorization for two milestones. Nothing is captured.'],
    ['The data decides', 'A fixed rule compares this inverter with others on the same roof and with measured sun.'],
    ['The AI explains', 'Claude explains the result and drafts a question for the installer. It can\'t change the result or move money.'],
    ['A person releases', 'Release stays locked until the data passes. Then a person taps, and PayPal captures that milestone.'],
  ];

  app.replaceChildren(el('section', { class: 'landing' },
    el('div', {},
      el('h1', {}, 'Your solar installer gets paid when the system proves it\'s producing.'),
      el('p', { class: 'lede' }, 'Replay a real 2020 outage on a real roof. A rule that pays after one good day would have paid during a four-day recovery, just before 18 more days at zero. This one keeps the money on hold.'),
      el('div', { class: 'start' },
        button,
        el('small', {}, mode === 'sample' ? 'Sample mode: no login and no money. PayPal replies are recorded.' : 'You\'ll approve the hold with a PayPal sandbox buyer. Test money only.'),
      ),
      notice,
      el('p', { class: 'guide-link' }, el('a', { href: '/judge' }, 'Judging this? Follow the guided test')),
    ),
    el('ol', { class: 'steps' }, ...steps.map(([title, text]) => el('li', {}, el('b', {}, title), el('span', {}, text)))),
  ));
}

// ---------- Contract ----------
const state = { id: null, view: null, json: '', notice: null, explanationKey: null, explanation: null, recordKey: null, record: null, excuse: { key: null, draft: '', busy: false, result: null }, confirmVoid: false, busy: false, holdNote: null };
let explainTimer = 0;
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
  loadExplanation();
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
function renderAi() {
  if (aiHost === null || state.view === null) return;
  const view = state.view;
  const milestone = currentMilestone(view);
  const parts = [el('h2', {}, 'What the AI says')];
  if (view.status !== 'HELD') {
    parts.push(el('p', { class: 'text' }, view.status === 'AWAITING_APPROVAL' ? 'The AI explains each result once the hold is placed.' : 'There\'s nothing left to explain: this contract has finished.'));
  } else if (milestone?.verdict === null || milestone === null) {
    parts.push(el('p', { class: 'text' }, `There's no result to explain yet. The AI explains this milestone once it opens on ${milestone?.opensOn ? fullDate(milestone.opensOn) : 'its date'}.`));
  } else if (state.explanation === null) {
    parts.push(el('p', { class: 'label' }, 'Reading the evidence…'), el('p', { class: 'text' }, 'The verdict on the left is already final, and this explanation can\'t change it.'));
  } else if (state.explanation.failed) {
    parts.push(el('p', { class: 'text' }, 'The explanation could not load. The verdict and the data on this page are unaffected.'));
  } else {
    const answer = state.explanation;
    parts.push(el('p', { class: 'label' }, aiLabel(answer)), el('p', { class: 'text' }, answer.explanation));
    if (answer.installerQuestion) parts.push(el('div', { class: 'ask' }, el('b', {}, 'Suggested question for the installer'), el('p', {}, answer.installerQuestion)));
  }
  if (view.status === 'HELD' && milestone?.verdict?.status === 'HOLD') parts.push(renderExcuse(view), renderForge());
  parts.push(el('p', { class: 'limit' }, 'The AI can\'t change the verdict, unlock Release or move money.'));
  aiHost.replaceChildren(...parts);
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
    el('h3', {}, 'Try to fake it'),
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
    el('h3', {}, 'Test the installer\'s reply'),
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

async function tapRelease(milestone, button) {
  button.disabled = true;
  state.notice = null;
  const path = `/api/contracts/${encodeURIComponent(state.id)}/milestones/${encodeURIComponent(milestone.id)}`;
  const tap = await api(`${path}/tap`, {}).catch(() => null);
  if (tap?.data?.outcome !== 'READY') {
    state.notice = { text: 'The server refused the release because the verdict is not ready. No money moved.', good: false };
    state.json = '';
    return refresh();
  }
  const result = await api(`${path}/release`, { tap: tap.data.token }).catch(() => null);
  const outcome = result?.data?.outcome;
  const messages = {
    CAPTURED: { text: `PayPal captured ${usd(milestone.amountCents)}.`, good: true },
    PENDING: { text: `PayPal accepted the capture of ${usd(milestone.amountCents)}, and it is pending.`, good: true },
    ALREADY_RELEASED: { text: 'This milestone was already released, so nothing was captured twice.', good: true },
    DECLINED: { text: 'PayPal declined this capture. The milestone is still unpaid, and you can try again.', good: false },
    REJECTED: { text: `PayPal refused the capture, so no money moved: ${result?.data?.error ?? ''}`, good: false },
    LOCKED: { text: 'The verdict changed before the capture, so nothing was captured.', good: false },
  };
  state.notice = messages[outcome] ?? { text: 'PayPal didn\'t give a clear answer. Don\'t assume the money moved or didn\'t: a retry is safe and can\'t capture twice.', good: false };
  state.json = '';
  await refresh();
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
    if (view.approveUrl) {
      const link = el('a', { class: 'release ready', href: view.approveUrl }, 'Continue to PayPal');
      link.style.textDecoration = 'none';
      link.style.marginTop = '16px';
      parts.push(link);
    }
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
    const label = `Milestone ${number} of ${view.milestones.length}: ${milestone.title}`;
    const verdict = milestone.verdict;
    if (verdict === null) {
      parts.push(
        el('div', { class: 'eyebrow' }, el('span', {}, label), pill('quiet', 'clock', 'NOT DUE')),
        el('h1', {}, `${usd(milestone.amountCents)} stays on hold.`),
        el('p', { class: 'sub' }, `This milestone is first checked on ${fullDate(milestone.opensOn)}, 30 days after the last release.`),
        el('div', { class: 'reasons' }),
        el('button', { class: 'release locked', type: 'button', disabled: true }, icon('lock', 18), 'Release locked'),
      );
    } else if (verdict.status === 'RELEASE_READY') {
      const button = el('button', { class: 'release ready', type: 'button', on: { click: () => tapRelease(milestone, button) } }, `Release ${usd(milestone.amountCents)}`);
      const share = verdict.mean === null ? '' : ` It averaged ${Math.round(verdict.mean * 100)}% of its usual share over the last 7 days.`;
      parts.push(
        el('div', { class: 'eyebrow' }, el('span', {}, label), pill('ready', 'check', 'RELEASE_READY')),
        el('h1', {}, `${usd(milestone.amountCents)} can be released.`),
        el('p', { class: 'sub' }, `The check passed on ${fullDate(verdict.date)}.${share}`),
        el('div', { class: 'reasons' }),
        button,
        el('p', { class: 'after' }, 'The data can only unlock this button. PayPal captures only if you tap it.'),
      );
    } else {
      parts.push(
        el('div', { class: 'eyebrow' }, el('span', {}, label), pill('hold', 'lock', 'HOLD')),
        el('h1', {}, `${usd(milestone.amountCents)} stays on hold.`),
        el('p', { class: 'sub' }, `Judged on ${fullDate(verdict.date)}. No money has moved.`),
        el('ul', { class: 'reasons' }, ...verdict.reasonText.map((text) => el('li', {}, text))),
        el('button', { class: 'release locked', type: 'button', disabled: true }, icon('lock', 18), 'Release locked'),
        el('p', { class: 'after' }, 'Only new production data can change this. A message from the installer can\'t.'),
      );
    }
  }
  if (state.notice !== null) parts.push(el('p', { class: `notice${state.notice.good ? ' good' : ''}`, role: 'status' }, state.notice.text));
  return el('div', { class: 'verdict' }, ...parts);
}

function renderClock(view) {
  const { clock } = view;
  const canMove = view.status === 'HELD' && currentMilestone(view) !== null;
  const controls = [];
  if (canMove) {
    if (clock.waitingUntil === null) {
      controls.push(
        el('button', { class: 'btn', type: 'button', disabled: clock.date >= clock.lastDate, on: { click: () => moveTo(addDays(clock.date, 1)) } }, 'Next day'),
      );
    }
    for (const stop of clock.stops) {
      controls.push(el('button', { class: 'btn stop', type: 'button', on: { click: () => moveTo(stop.date) } }, shortDate(stop.date), el('small', {}, stop.label)));
    }
  }
  return el('div', { class: 'clock' },
    el('div', { class: 'now' },
      el('b', {}, clock.label),
      el('span', {}, canMove ? 'Newest recorded day shown. This replays real 2020 readings, one way only.' : 'Last recorded day used.'),
    ),
    controls.length > 0 ? el('div', { class: 'controls' }, ...controls) : null,
  );
}

function renderEvidence(view) {
  chartHost = el('div', { class: 'chart' });
  chartDays = view.history;
  return el('section', { class: 'card' },
    renderClock(view),
    el('h2', {}, `${view.source.unit}: last 45 days`),
    el('div', { class: 'legend' },
      el('span', {}, el('i', { class: 'k-own' }), 'This inverter'),
      el('span', {}, el('i', { class: 'k-peers' }), 'Other inverters on the roof (median)'),
      el('span', {}, el('i', { class: 'k-window' }), '7 days judged'),
    ),
    chartHost,
  );
}

function renderMoney(view) {
  const parts = [
    el('h2', {}, 'PayPal hold'),
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
  return el('section', { class: 'card' }, ...parts);
}

// PayPal's own record of this order, read with the Agent Toolkit's get_order tool. It's asked for
// again only when the money changes, so stepping through days doesn't call PayPal.
function loadRecord() {
  const view = state.view;
  const key = view.authorizationId ? JSON.stringify([view.status, view.authorizationId, view.milestones.map((m) => [m.status, m.captureId])]) : null;
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
};

function renderMilestones(view) {
  return el('section', { class: 'card' },
    el('h2', {}, 'Milestones'),
    el('ol', { class: 'miles' }, ...view.milestones.map((m) => {
      let note = STATUS_TEXT[m.status] ?? m.status;
      if (m.status === 'WAITING' && !m.isCurrent) note = view.status === 'VOIDED' ? 'Not paid' : 'Checked 30 days after the milestone before it is released';
      if (m.status === 'WAITING' && m.isCurrent && view.status === 'VOIDED') note = 'Not paid';
      if (m.captureId) note += ` · ${m.captureId}`;
      return el('li', {}, el('span', { class: 't' }, m.title), el('span', { class: 'a' }, usd(m.amountCents)), el('span', { class: 's' }, note));
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
};

function renderTimeline(view) {
  const sources = { app: 'App', paypal: view.mode === 'sample' ? 'Recorded' : 'PayPal', webhook: 'Webhook' };
  // Stepping through days adds many entries, so only the latest of a run is shown.
  const entries = view.timeline.filter((entry, i, all) => !(entry.type === 'RECORDED_DAYS_ADDED' && all[i + 1]?.type === 'RECORDED_DAYS_ADDED'));
  return el('section', { class: 'card' },
    el('h2', {}, 'Timeline'),
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

function render() {
  const view = state.view;
  if (boardHost === null || !boardHost.isConnected) {
    boardHost = el('div');
    ledger = createLedger();
    app.replaceChildren(boardHost, ledger.section);
  }
  aiHost = el('div', { class: 'ai' });
  boardHost.replaceChildren(el('div', { class: 'board' },
    el('section', { class: 'card hero' }, renderVerdict(view), aiHost),
    el('div', { class: 'lower' },
      el('div', { class: 'col' }, renderEvidence(view)),
      el('div', { class: 'col' }, renderMoney(view), renderMilestones(view), renderTimeline(view)),
    ),
  ));
  renderAi();
  renderRecord();
  drawChart(chartHost, chartDays, 7);
  ledger.show(view.id, view.clock.date, view.source.unit);
}

let lastWidth = 0;
new ResizeObserver(() => {
  if (chartHost === null || !chartHost.isConnected) return;
  const width = chartHost.clientWidth;
  if (Math.abs(width - lastWidth) > 4) {
    lastWidth = width;
    drawChart(chartHost, chartDays, 7);
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
