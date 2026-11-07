// The one-hour fake-data test. Run: node spike/forge-test.ts. Results in spike/SPIKE-FAKE.md.
import { judge } from '../src/proof/engine.ts';
import { loadMauiLogger } from '../src/proof/claims.ts';
import { MAUI_INVERTERS, loadMauiFleet, commonDates } from '../src/proof/maui.ts';
const fleet = loadMauiFleet() as any; const logger = loadMauiLogger(MAUI_INVERTERS);
const peers = ['02','03','07'];
const med = (v: number[]) => { const s=[...v].sort((a,b)=>a-b); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
// Forger: replace inv01's daily kWh from Oct 8 to Nov 18, 2020 with its usual share of the peers' median (share from Sep 2020).
const sep = Object.keys(fleet['01']).filter(d=>d.startsWith('2020-09'));
const share = med(sep.map(d=>fleet['01'][d].kwh/med(peers.map(p=>fleet[p][d].kwh))));
const forged = structuredClone(fleet);
const days = commonDates(fleet).filter(d=>d>='2020-10-08'&&d<='2020-11-18');
for (const d of days) forged['01'][d].kwh = +(share*med(peers.map(p=>fleet[p][d].kwh))).toFixed(3);
for (const d of ['2020-10-12','2020-10-26','2020-11-18']) console.log(d,'real',judge(fleet,'01',d).status,'forged',judge(forged,'01',d).status);
// Cross-check: a day that claims output but whose logger shows a DC peak under half the inverter's usual producing peak.
const usualPeak = (id: string) => med(Object.entries(fleet[id]).filter(([d,r]: any)=>r.kwh>=5 && logger[id]?.[d]?.[2]!=null).map(([d]: any)=>logger[id][d][2]));
const flag = (f: any, id: string) => Object.entries(f[id]).filter(([d,r]: any)=>r.kwh>=5 && logger[id]?.[d]?.[2]!=null && logger[id][d][2] < usualPeak(id)/2).map(([d])=>d);
const caught = flag(forged,'01').filter(d=>days.includes(d));
console.log('forged days',days.length,'caught by DC check',caught.length);
for (const id of MAUI_INVERTERS) console.log('real data false alarms inv'+id, flag(fleet,id).length, 'of', Object.keys(fleet[id]).length);
