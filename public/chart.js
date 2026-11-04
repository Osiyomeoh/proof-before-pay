// Production chart: this inverter against the median of the others, with measured sun below on its
// own scale. Gaps in the data stay as gaps in the line, so a missing day never looks like a reading.
const NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function svgEl(name, attrs, parent, text) {
  const el = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}

export const shortDate = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const value = (v, unit) => (v === null ? 'no reading' : `${v.toFixed(1)} ${unit}`);

function linePath(days, key, x, y) {
  let path = '';
  let drawing = false;
  days.forEach((day, i) => {
    const v = day[key];
    if (v === null) {
      drawing = false;
      return;
    }
    path += `${drawing ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    drawing = true;
  });
  return path;
}

export function drawChart(host, days, windowDays) {
  host.replaceChildren();
  const width = Math.max(host.clientWidth, 280);
  const left = 28;
  const right = 8;
  const top = 20;
  const lineHeight = width < 480 ? 170 : 230;
  const gap = 28;
  const sunHeight = 44;
  const height = top + lineHeight + gap + sunHeight + 22;
  const plotW = width - left - right;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Daily production of this inverter and the median of the other inverters, with measured sun below. The same days are in the table underneath.' }, host);
  // Half a day of padding each side, so the sun bars stay inside the plot.
  const pad = plotW / days.length / 2;
  const x = (i) => left + pad + (days.length === 1 ? 0 : (i / (days.length - 1)) * (plotW - 2 * pad));

  const highest = Math.max(1, ...days.flatMap((d) => [d.kwh ?? 0, d.peerMedianKwh ?? 0]));
  const yMax = Math.ceil(highest / 25) * 25;
  const y = (v) => top + lineHeight - (v / yMax) * lineHeight;

  // The days the verdict is judged on.
  const bandStart = x(Math.max(0, days.length - windowDays)) - pad;
  svgEl('rect', { class: 'band', x: bandStart, y: top, width: width - right - bandStart, height: lineHeight }, svg);

  for (let tick = 0; tick <= yMax; tick += 25) {
    svgEl('line', { class: tick === 0 ? 'base' : 'grid', x1: left, x2: width - right, y1: y(tick), y2: y(tick) }, svg);
    svgEl('text', { x: left - 6, y: y(tick) + 4, 'text-anchor': 'end' }, svg, String(tick));
  }
  svgEl('text', { x: left, y: top - 8 }, svg, 'kWh a day');

  svgEl('path', { class: 'peers', d: linePath(days, 'peerMedianKwh', x, y) }, svg);
  svgEl('path', { class: 'own', d: linePath(days, 'kwh', x, y) }, svg);

  // Direct labels sit above each line's last stretch, and are pushed apart when the lines meet.
  const labelTop = (key) => {
    const recent = days.slice(-Math.ceil(90 / (plotW / days.length))).map((d) => d[key]).filter((v) => v !== null);
    return recent.length === 0 ? null : Math.max(top + 12, y(Math.max(...recent)) - 8);
  };
  const peerLabel = labelTop('peerMedianKwh');
  let ownLabel = labelTop('kwh');
  if (ownLabel !== null && peerLabel !== null && Math.abs(ownLabel - peerLabel) < 16) ownLabel = peerLabel + 18;
  if (peerLabel !== null) svgEl('text', { class: 'end', x: width - right - 6, y: peerLabel, 'text-anchor': 'end' }, svg, 'Others');
  if (ownLabel !== null) svgEl('text', { class: 'end', x: width - right - 6, y: ownLabel, 'text-anchor': 'end' }, svg, 'This inverter');

  // Measured sun, on its own small scale.
  const sunTop = top + lineHeight + gap;
  const sunMax = Math.max(1, ...days.map((d) => d.sun ?? 0));
  svgEl('text', { x: left, y: sunTop - 4 }, svg, `Measured sun, up to ${sunMax.toFixed(1)} kWh/m²`);
  const barWidth = Math.max(2, (2 * pad) - 2);
  days.forEach((day, i) => {
    if (day.sun === null) return;
    const h = Math.max(1, (day.sun / sunMax) * sunHeight);
    svgEl('rect', { class: 'sun', x: x(i) - barWidth / 2, y: sunTop + sunHeight - h, width: barWidth, height: h, rx: 1 }, svg);
  });
  svgEl('line', { class: 'base', x1: left, x2: width - right, y1: sunTop + sunHeight, y2: sunTop + sunHeight }, svg);

  const tickCount = width < 480 ? 3 : 5;
  for (let t = 0; t < tickCount; t += 1) {
    const i = Math.round((t / (tickCount - 1)) * (days.length - 1));
    const anchor = t === 0 ? 'start' : t === tickCount - 1 ? 'end' : 'middle';
    const day = days[i];
    if (day !== undefined) svgEl('text', { x: x(i), y: sunTop + sunHeight + 16, 'text-anchor': anchor }, svg, shortDate(day.date));
  }

  // Crosshair and tooltip.
  const cross = svgEl('line', { class: 'cross', y1: top, y2: sunTop + sunHeight, visibility: 'hidden' }, svg);
  const ownDot = svgEl('circle', { class: 'dot-own', r: 5, visibility: 'hidden' }, svg);
  const peerDot = svgEl('circle', { class: 'dot-peers', r: 5, visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  host.append(tip);

  function hide() {
    tip.hidden = true;
    for (const el of [cross, ownDot, peerDot]) el.setAttribute('visibility', 'hidden');
  }

  function show(event) {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const i = Math.min(days.length - 1, Math.max(0, Math.round(((px - left - pad) / (plotW - 2 * pad)) * (days.length - 1))));
    const day = days[i];
    if (day === undefined) return;
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    for (const [dot, v] of [[ownDot, day.kwh], [peerDot, day.peerMedianKwh]]) {
      if (v === null) {
        dot.setAttribute('visibility', 'hidden');
      } else {
        dot.setAttribute('cx', x(i));
        dot.setAttribute('cy', y(v));
        dot.setAttribute('visibility', 'visible');
      }
    }
    const title = document.createElement('b');
    title.textContent = shortDate(day.date) + ', ' + day.date.slice(0, 4);
    const lines = [`This inverter ${value(day.kwh, 'kWh')}`, `Others ${value(day.peerMedianKwh, 'kWh')}`, `Sun ${day.sun === null ? 'no reading' : `${day.sun.toFixed(2)} kWh/m²`}`];
    tip.replaceChildren(title, ...lines.map((line) => {
      const row = document.createElement('div');
      row.textContent = line;
      return row;
    }));
    tip.hidden = false;
    const scale = box.width / width;
    const tipWidth = tip.offsetWidth;
    const centre = x(i) * scale;
    tip.style.left = `${Math.min(box.width - tipWidth, Math.max(0, centre - tipWidth / 2))}px`;
    tip.style.top = '8px';
  }

  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
}
