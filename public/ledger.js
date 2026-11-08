// The production ledger: every recorded day, with our rule beside a pay-after-one-good-day rule.
// It only reads data. Rows come from the server and stop at the day being judged.
// All grid rules are functions, not strings, because our content policy doesn't allow code built from strings.
import { el } from './dom.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const number = (digits) => (params) => (params.value === null || params.value === undefined ? '–' : params.value.toFixed(digits));
const whole = (params) => (params.value === null || params.value === undefined ? '–' : `${Math.round(params.value)}%`);
const asPercent = (field) => (params) => (params.data?.[field] === null || params.data?.[field] === undefined ? null : params.data[field] * 100);

const OUR_RULE = { RELEASE_READY: 'Ready', HOLD: 'Hold' };
const SIMPLE_RULE = { PAYS: 'Pays', NO: 'No', NO_CALL: 'No call' };

const PRESETS = [
  { key: 'all', label: 'All days', pass: () => true },
  { key: 'disagree', label: 'Rules disagree', pass: (row) => row.disagree },
  { key: 'floor', label: 'Under the 30% floor', pass: (row) => row.belowFloor },
];

const numberColumn = (extra) => ({ filter: 'agNumberColumnFilter', type: 'rightAligned', cellClass: 'g-num', width: 104, ...extra });

const COLUMNS = [
  {
    // No floating filter here: the date box clips in this width, and the column menu still has the full filter.
    field: 'date', headerName: 'Day', pinned: 'left', width: 136, sort: 'desc', cellDataType: 'dateString', filter: 'agDateColumnFilter', floatingFilter: false,
    valueFormatter: (params) => niceDate(params.value), useValueFormatterForExport: false, cellClass: 'g-num',
  },
  {
    headerName: 'The two rules',
    children: [
      {
        headerName: 'Ours', width: 104, filter: 'agTextColumnFilter', valueGetter: (params) => OUR_RULE[params.data?.status],
        cellClassRules: { 'g-ready': (params) => params.value === 'Ready', 'g-hold': (params) => params.value === 'Hold' },
      },
      {
        headerName: 'One good day', width: 132, filter: 'agTextColumnFilter', valueGetter: (params) => SIMPLE_RULE[params.data?.oneGoodDay],
        cellClassRules: { 'g-low': (params) => params.data?.disagree === true },
      },
    ],
  },
  {
    headerName: 'Share of usual',
    children: [
      numberColumn({ headerName: 'That day', valueGetter: asPercent('share'), valueFormatter: whole, cellClassRules: { 'g-low': (params) => params.data?.belowFloor === true } }),
      numberColumn({ headerName: '7-day avg', valueGetter: asPercent('mean'), valueFormatter: whole }),
    ],
  },
  {
    headerName: 'Readings',
    children: [
      numberColumn({ field: 'kwh', headerName: 'kWh', valueFormatter: number(1) }),
      numberColumn({ field: 'peerMedianKwh', headerName: 'Others', valueFormatter: number(1) }),
      numberColumn({ field: 'sun', headerName: 'Sun', valueFormatter: number(2) }),
    ],
  },
  { field: 'reasons', headerName: 'Why ours held', filter: 'agTextColumnFilter', minWidth: 280, flex: 1, tooltipField: 'reasons', valueFormatter: (params) => params.value || '–' },
];

let gridLoad = null;
function loadGrid() {
  gridLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/ag-grid.min.js';
    script.onload = () => resolve(window.agGrid);
    script.onerror = () => reject(new Error('grid did not load'));
    document.head.append(script);
  });
  return gridLoad;
}

function makeTheme(agGrid) {
  // These read the page's colour tokens, so the grid matches the page without any code.
  return agGrid.themeQuartz.withParams({
    backgroundColor: 'var(--card)',
    foregroundColor: 'var(--ink)',
    headerBackgroundColor: 'var(--card-2)',
    headerTextColor: 'var(--ink-2)',
    borderColor: 'var(--line)',
    accentColor: 'var(--brand)',
    browserColorScheme: 'inherit',
    fontFamily: '"Plex Sans", system-ui, sans-serif',
    fontSize: 13,
    spacing: 6,
    wrapperBorderRadius: 12,
  });
}

export function createLedger() {
  const heading = el('h2', {}, 'Every recorded day');
  const tools = el('div', { class: 'ledger-tools' });
  const summary = el('dl', { class: 'ledger-sum', ariaLive: 'polite' });
  const status = el('p', { class: 'ledger-status', role: 'status' }, 'Loading every recorded day…');
  const host = el('div', { class: 'scroll ledger-grid', hidden: true });
  const section = el('section', { class: 'card ledger', ariaLabel: 'Production ledger' },
    heading,
    el('p', { class: 'ledger-note' }, 'Two rules on the same readings. Ours needs 7 straight days: an average of at least 70% of the usual share, with no day under 30%. The other pays after one day at 70%. Shaded rows are the last 7 days. This table can\'t release money. It shows where the rules differ, not which was right, because the dataset has no fault log.'),
    el('p', { class: 'ledger-note' }, 'Across 9 inverters on this roof and 13,257 judged days: when ours paid, a day under 30% followed within 14 days 7.2% of the time. For the one-good-day rule it was 8.7%. The cost: ours held 641 days the other rule paid. Most of the gap comes from one inverter, and with no fault log this isn\'t accuracy.'),
    tools, summary, status, host,
  );

  let api = null;
  let preset = PRESETS[0];
  let rows = [];
  let judgedFrom = '';
  let latest = '';
  let through = '';
  let unitId = '';

  const fact = (term, value) => el('div', {}, el('dt', {}, term), el('dd', {}, value));

  // Counts what's on screen after every filter, so it changes as the reader narrows the table.
  function renderSummary() {
    let days = 0;
    let kwh = 0;
    let ours = 0;
    let simple = 0;
    let disagree = 0;
    api.forEachNodeAfterFilter(({ data }) => {
      days += 1;
      kwh += data.kwh ?? 0;
      if (data.status === 'RELEASE_READY') ours += 1;
      if (data.oneGoodDay === 'PAYS') simple += 1;
      if (data.disagree) disagree += 1;
    });
    summary.replaceChildren(
      fact('Days shown', String(days)),
      fact('Ours ready', String(ours)),
      fact('One good day pays', String(simple)),
      fact('Rules disagree', String(disagree)),
      fact('kWh made', Math.round(kwh).toLocaleString('en-US')),
    );
  }

  function renderTools() {
    tools.replaceChildren(
      ...PRESETS.map((item) => {
        const count = rows.filter(item.pass).length;
        return el('button', {
          class: 'btn chip', type: 'button', disabled: count === 0, ariaPressed: String(item === preset),
          on: { click: () => { preset = item; renderTools(); api.onFilterChanged(); } },
        }, `${item.label} (${count})`);
      }),
      el('button', {
        class: 'btn csv', type: 'button',
        on: { click: () => api.exportDataAsCsv({ skipColumnGroupHeaders: true, fileName: `proof-before-pay-inverter-${unitId}-through-${through}.csv` }) },
      }, 'Download CSV'),
    );
  }

  async function ensureGrid() {
    if (api !== null) return;
    const agGrid = await loadGrid();
    if (api !== null) return;
    agGrid.ModuleRegistry.registerModules([agGrid.AllCommunityModule]);
    host.hidden = false;
    api = agGrid.createGrid(host, {
      theme: makeTheme(agGrid),
      styleNonce: document.querySelector('meta[name="style-nonce"]').content,
      columnDefs: COLUMNS,
      defaultColDef: { sortable: true, resizable: true, floatingFilter: true },
      rowData: [],
      getRowId: (params) => params.data.date,
      rowClassRules: { 'g-judged': (params) => params.data?.date >= judgedFrom },
      isExternalFilterPresent: () => preset.key !== 'all',
      doesExternalFilterPass: (node) => preset.pass(node.data),
      enableBrowserTooltips: true,
      suppressMovableColumns: true,
      localeText: { noRowsToShow: 'No days match these filters.' },
      onModelUpdated: renderSummary,
    });
  }

  async function show(contractId, date, unit) {
    if (date === latest) return;
    latest = date;
    try {
      const [res] = await Promise.all([fetch(`/api/contracts/${encodeURIComponent(contractId)}/ledger`), ensureGrid()]);
      if (!res.ok) throw new Error(`ledger ${res.status}`);
      const data = await res.json();
      if (latest !== date) return;
      rows = data.rows;
      judgedFrom = data.judgedFrom;
      through = data.through;
      unitId = data.unit;
      heading.textContent = `${unit}: every recorded day through ${niceDate(data.through)}`;
      status.hidden = true;
      renderTools();
      api.setGridOption('rowData', rows);
      api.redrawRows();
    } catch {
      if (latest !== date) return;
      latest = '';
      status.hidden = false;
      status.textContent = 'The ledger could not load. The verdict and the chart above are unaffected.';
    }
  }

  return { section, show };
}
