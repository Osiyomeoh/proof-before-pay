// Loads daily totals for Maui Ocean Center, NREL PVDAQ system 2105: a real 110 kW commercial roof.
// Totals are produced from the public data by spike/fetch-data.sh and spike/analyze.py.
import { readFileSync } from 'node:fs';
import type { Fleet, Reading } from './engine.ts';

export const MAUI_INVERTERS = ['01', '02', '03', '07'] as const;

const DATA_DIR = new URL('../../data/maui-2105/', import.meta.url);

export function loadMauiFleet(): Fleet {
  const fleet: Record<string, Record<string, Reading>> = {};
  for (const id of MAUI_INVERTERS) {
    const file = new URL(`daily_inv${id}.json`, DATA_DIR);
    const { days } = JSON.parse(readFileSync(file, 'utf8')) as { days: Record<string, [number, number]> };
    const series: Record<string, Reading> = {};
    for (const [date, [kwh, sun]] of Object.entries(days)) series[date] = { kwh, sun };
    fleet[id] = series;
  }
  return fleet;
}

/** Days every inverter reported, in date order. */
export function commonDates(fleet: Fleet): string[] {
  const serieses = Object.values(fleet);
  const first = serieses[0];
  if (!first) return [];
  return Object.keys(first)
    .filter((date) => serieses.every((series) => series[date] !== undefined))
    .sort();
}
