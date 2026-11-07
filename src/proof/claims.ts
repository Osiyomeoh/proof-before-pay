// Tests an installer's claims about a hold against measured data. Deterministic: the AI only
// sorts a reply into these claim kinds, and this module alone decides what the data shows.
// It returns findings, never a verdict. Nothing here can change a hold or move money, and it
// never names a cause: it only says whether the measured data fits the claim.
import { readFileSync } from 'node:fs';
import { addDays, median } from './engine.ts';
import type { Fleet, Verdict } from './engine.ts';

export const CLAIM_KINDS = ['WEATHER', 'SITE_WIDE', 'MONITORING', 'OTHER', 'NOT_A_CLAIM'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

// One logger day: rows logged, median AC volts, highest DC volts, highest inverter temperature.
export type LoggerDay = readonly [rows: number, acV: number | null, dcMaxV: number | null, tempMaxC: number | null];
export type Logger = Readonly<Record<string, Readonly<Record<string, LoggerDay>>>>;

export type Finding = 'SUPPORTED' | 'NOT_SUPPORTED' | 'MIXED' | 'CANT_CHECK';

export type ClaimResult = {
  kind: ClaimKind;
  quote: string;
  finding: Finding;
  sentence: string;
  dates: string[];
};

const DATA_DIR = new URL('../../data/maui-2105/', import.meta.url);

export function loadMauiLogger(ids: readonly string[]): Logger {
  const logger: Record<string, Record<string, LoggerDay>> = {};
  for (const id of ids) {
    const { days } = JSON.parse(readFileSync(new URL(`logger_inv${id}.json`, DATA_DIR), 'utf8')) as { days: Record<string, LoggerDay> };
    logger[id] = days;
  }
  return logger;
}

// Below half of usual counts as low; 70% or more (90% for logger rows) counts as normal; between is mixed.
const LOW = 0.5;
const NORMAL = 0.7;
const ROWS_NORMAL = 0.9;
const USUAL_DAYS = 30;

const one = (value: number) => (Math.round(value * 10) / 10).toFixed(1);
const two = (value: number) => value.toFixed(2);
function range(values: readonly number[], format: (value: number) => string): string {
  const low = format(Math.min(...values));
  const high = format(Math.max(...values));
  return low === high ? low : `${low} to ${high}`;
}

export type ClaimContext = {
  dates: string[];
  kwh: number[];
  sun: number[];
  peerKwh: number[];
  rows: number[];
  acV: number[];
  dcMaxV: number[];
  usual: { sun: number | null; peerKwh: number | null; rows: number | null; dcMaxV: number | null };
};

// The days in question are the window days this inverter fell below the daily floor, or every
// window day if none did. "Usual" is the median of the 30 days before the window, except the DC
// voltage peak: that uses the last 30 days before the window on which this inverter produced power,
// so an outage before the window can't make its own low readings look usual. Logger rows are compared
// with this inverter's own past, because each inverter here logs at a different rate.
export function claimContext(verdict: Verdict, fleet: Fleet, logger: Logger, dayFloor: number): ClaimContext {
  const low = verdict.window.filter((day) => day.ratio !== null && day.ratio < dayFloor);
  const days = low.length > 0 ? low : verdict.window;
  const unit = verdict.unitId;
  const peers = Object.keys(fleet).filter((id) => id !== unit);
  const start = verdict.window[0]?.date ?? verdict.date;
  const before = Array.from({ length: USUAL_DAYS }, (_, k) => addDays(start, k - USUAL_DAYS));

  const peerMedian = (date: string): number | null => {
    const values = peers.map((id) => fleet[id]?.[date]?.kwh);
    return values.every((v): v is number => typeof v === 'number') ? median(values) : null;
  };
  const present = <T>(values: ReadonlyArray<T | null | undefined>) => values.filter((v): v is T => v !== null && v !== undefined);
  const usualOf = (values: number[]) => (values.length >= USUAL_DAYS / 2 ? median(values) : null);
  const producing = Array.from({ length: 120 }, (_, k) => addDays(start, -1 - k))
    .filter((date) => (fleet[unit]?.[date]?.kwh ?? 0) > 0)
    .slice(0, USUAL_DAYS);

  return {
    dates: days.map((day) => day.date),
    kwh: present(days.map((day) => day.kwh)),
    sun: present(days.map((day) => day.sun)),
    peerKwh: present(days.map((day) => day.peerMedianKwh)),
    rows: days.map((day) => logger[unit]?.[day.date]?.[0] ?? 0),
    acV: present(days.map((day) => logger[unit]?.[day.date]?.[1])),
    dcMaxV: present(days.map((day) => logger[unit]?.[day.date]?.[2])),
    usual: {
      sun: usualOf(present(before.map((date) => fleet[unit]?.[date]?.sun))),
      peerKwh: usualOf(present(before.map(peerMedian))),
      rows: usualOf(present(before.map((date) => logger[unit]?.[date]?.[0]))),
      dcMaxV: usualOf(present(producing.map((date) => logger[unit]?.[date]?.[2]))),
    },
  };
}

function grade(share: number, normal = NORMAL): Finding {
  if (share < LOW) return 'SUPPORTED';
  if (share >= normal) return 'NOT_SUPPORTED';
  return 'MIXED';
}

const LEAD: Record<Finding, string> = {
  SUPPORTED: 'The data supports this.',
  NOT_SUPPORTED: "The data doesn't support this.",
  MIXED: 'The data partly fits this.',
  CANT_CHECK: "This can't be checked against the data the app has.",
};

// Weather can be real and still not explain the output, so its findings say what they're about.
const WEATHER_LEAD: Record<Finding, string> = {
  SUPPORTED: 'The data fits this: the sun and every inverter on the roof were low together.',
  NOT_SUPPORTED: "Weather doesn't explain this inverter's output: the other inverters on the roof kept producing.",
  MIXED: 'Weather may explain part of it.',
  CANT_CHECK: LEAD.CANT_CHECK,
};

const many = (context: ClaimContext) => (context.dates.length === 1 ? 'that day' : 'those days');

export function checkClaim(kind: ClaimKind, quote: string, context: ClaimContext): ClaimResult {
  const base = { kind, quote, dates: context.dates };
  const { usual } = context;
  switch (kind) {
    case 'WEATHER': {
      if (context.sun.length === 0 || context.peerKwh.length === 0 || context.kwh.length === 0 || usual.sun === null || usual.peerKwh === null) break;
      const sunShare = median(context.sun) / usual.sun;
      const peerShare = median(context.peerKwh) / usual.peerKwh;
      // Weather reaches every inverter on the roof, so it only explains low output if the others were low too.
      const finding: Finding = peerShare >= NORMAL ? 'NOT_SUPPORTED' : peerShare < LOW && sunShare < LOW ? 'SUPPORTED' : 'MIXED';
      return {
        ...base,
        finding,
        sentence: `${WEATHER_LEAD[finding]} On ${many(context)} this inverter made ${range(context.kwh, one)} kWh, while the other inverters on the roof made a median ${range(context.peerKwh, one)} kWh, against a usual ${one(usual.peerKwh)}. Measured sun was ${range(context.sun, two)} kWh/m², against a usual ${two(usual.sun)}.`,
      };
    }
    case 'SITE_WIDE': {
      if (context.peerKwh.length === 0 || usual.peerKwh === null) break;
      const finding = grade(median(context.peerKwh) / usual.peerKwh);
      return {
        ...base,
        finding,
        sentence: `${LEAD[finding]} On ${many(context)} the other inverters on the roof made a median ${range(context.peerKwh, one)} kWh, against a usual ${one(usual.peerKwh)}.`,
      };
    }
    case 'MONITORING': {
      if (usual.rows === null) break;
      const finding = grade(median(context.rows) / usual.rows, ROWS_NORMAL);
      const volts = context.acV.length > 0 && context.dcMaxV.length > 0 && usual.dcMaxV !== null
        ? ` It recorded AC voltage around ${range(context.acV, one)} V, and its highest DC voltage was ${range(context.dcMaxV, one)} V, against a usual daily peak of ${one(usual.dcMaxV)} V.`
        : '';
      return {
        ...base,
        finding,
        sentence: `${LEAD[finding]} The logger for this inverter kept ${range(context.rows, String)} rows a day on ${many(context)}, against a usual ${String(usual.rows)}.${volts}`,
      };
    }
    case 'NOT_A_CLAIM':
      return { ...base, finding: 'CANT_CHECK', sentence: "This isn't a claim about the system, so it changes nothing. Only new production data can change the hold." };
    case 'OTHER':
      break;
  }
  return { ...base, finding: 'CANT_CHECK', sentence: LEAD.CANT_CHECK };
}
