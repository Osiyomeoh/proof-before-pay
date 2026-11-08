// Measured output over a billing week, for the neighbour contract. Each day is read down to the
// tenth of a kWh, the way a meter register is, and a day with no reading counts as zero, so a gap
// in the data can never add to a bill. All the money arithmetic is whole numbers.
import { addDays } from './engine.ts';
import type { Fleet } from './engine.ts';

export type MeterDay = { date: string; tenths: number | null };
export type MeterReading = { from: string; through: string; days: MeterDay[]; tenths: number; missingDays: number };

// The small allowance stops 22.0 stored as 21.999999… from reading as 21.9.
const toTenths = (kwh: number) => Math.floor(kwh * 10 + 1e-6);

export function readMeter(fleet: Fleet, unitId: string, from: string, through: string): MeterReading {
  const days: MeterDay[] = [];
  for (let date = from; date <= through; date = addDays(date, 1)) {
    const kwh = fleet[unitId]?.[date]?.kwh;
    days.push({ date, tenths: typeof kwh === 'number' && Number.isFinite(kwh) && kwh >= 0 ? toTenths(kwh) : null });
  }
  return {
    from,
    through,
    days,
    tenths: days.reduce((sum, day) => sum + (day.tenths ?? 0), 0),
    missingDays: days.filter((day) => day.tenths === null).length,
  };
}

// Rounded down to the cent, and never more than the week's share of the hold.
export function billCents(tenths: number, priceCentsPerKwh: number, capCents: number): number {
  return Math.min(capCents, Math.floor((tenths * priceCentsPerKwh) / 10));
}
