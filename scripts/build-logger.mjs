// Builds daily logger summaries for the excuse check from the raw NREL PVDAQ rows (system 2105).
// Run spike/fetch-data.sh first, then: node scripts/build-logger.mjs
// Writes data/maui-2105/logger_inv{id}.json: for each local date, the number of logger rows, the
// median AC voltage, the highest DC voltage and the highest inverter temperature that day.
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const INVERTERS = ['01', '02', '03', '07'];
const RAW = new URL('../spike/data/', import.meta.url);
const OUT = new URL('../data/maui-2105/', import.meta.url);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const num = (text) => (text === '' || text === undefined ? null : Number(text));
const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);

for (const id of INVERTERS) {
  const days = new Map();
  const lines = createInterface({ input: createReadStream(new URL(`2105_inv${id}_data.csv`, RAW)) });
  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      // Columns: measured_on, AC kWh, power factor, AC volts, DC volts, temperature.
      if (!/ac_voltage.*dc_voltage.*temperature/.test(line)) throw new Error(`unexpected columns in inv${id}: ${line}`);
      continue;
    }
    const [time, , , ac, dc, temp] = line.split(',');
    const date = time.slice(0, 10);
    let day = days.get(date);
    if (day === undefined) {
      day = { rows: 0, ac: [], dcMax: null, tempMax: null };
      days.set(date, day);
    }
    day.rows += 1;
    const acV = num(ac);
    const dcV = num(dc);
    const t = num(temp);
    if (acV !== null && Number.isFinite(acV)) day.ac.push(acV);
    if (dcV !== null && Number.isFinite(dcV)) day.dcMax = Math.max(day.dcMax ?? dcV, dcV);
    if (t !== null && Number.isFinite(t)) day.tempMax = Math.max(day.tempMax ?? t, t);
  }
  const out = {};
  for (const date of [...days.keys()].sort()) {
    const day = days.get(date);
    out[date] = [day.rows, round1(day.ac.length ? median(day.ac) : null), round1(day.dcMax), round1(day.tempMax)];
  }
  const file = new URL(`logger_inv${id}.json`, OUT);
  writeFileSync(file, `${JSON.stringify({
    source: 'NREL PVDAQ system 2105 raw rows (doi:10.25984/1846021), summarised by scripts/build-logger.mjs',
    fields: ['rows', 'ac_voltage_median_v', 'dc_voltage_max_v', 'temperature_max_c'],
    days: out,
  })}\n`);
  console.log(`inv${id}: ${days.size} days`);
}
