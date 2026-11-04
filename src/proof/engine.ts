// Deterministic release check. It decides RELEASE_READY or HOLD from production data alone.
// It has no PayPal or AI dependency, and every doubtful input ends in HOLD.

export interface Reading {
  readonly kwh: number;
  readonly sun: number | null;
}
export type Series = Readonly<Record<string, Reading>>;
export type Fleet = Readonly<Record<string, Series>>;

export interface Rules {
  readonly windowDays: number;
  /** Lowest allowed mean of the unit's normalised share of peers over the window. */
  readonly minMean: number;
  /** Lowest allowed normalised share on any single day. */
  readonly dayFloor: number;
  /** Earlier days needed before a unit can be compared with its own past. */
  readonly minHistoryDays: number;
  readonly minPeers: number;
  /** A day counts as peers-down below this fraction of the peers' usual output. */
  readonly peersDownShare: number;
  /** Lowest allowed current baseline as a fraction of the earliest baseline. */
  readonly minBaselineDrift: number;
  /** Lowest allowed peer output per unit of sun, as a fraction of its past median. */
  readonly minFleetYield: number;
}

// Starting values. The 7-day mean, floor and history come from spike/SPIKE-PHYSICS.md.
// The three guards are measured by `npm run eval`.
export const DEFAULT_RULES: Rules = {
  windowDays: 7,
  minMean: 0.7,
  dayFloor: 0.3,
  minHistoryDays: 30,
  minPeers: 2,
  peersDownShare: 0.05,
  minBaselineDrift: 0.7,
  minFleetYield: 0.5,
};

export type HoldReason =
  | { readonly code: 'INVALID_DATE' }
  | { readonly code: 'UNKNOWN_UNIT' }
  | { readonly code: 'TOO_FEW_PEERS'; readonly have: number; readonly need: number }
  | { readonly code: 'MISSING_DATA'; readonly dates: readonly string[] }
  | { readonly code: 'PEERS_DOWN'; readonly dates: readonly string[] }
  | { readonly code: 'NOT_ENOUGH_HISTORY'; readonly have: number; readonly need: number }
  | { readonly code: 'NO_BASELINE' }
  | { readonly code: 'BASELINE_DEGRADED'; readonly drift: number; readonly min: number }
  | { readonly code: 'MEAN_TOO_LOW'; readonly mean: number; readonly min: number }
  | { readonly code: 'DAY_BELOW_FLOOR'; readonly dates: readonly string[]; readonly min: number }
  | { readonly code: 'FLEET_LOW_FOR_SUN'; readonly ratio: number; readonly min: number };

export interface EvidenceDay {
  readonly date: string;
  readonly kwh: number | null;
  readonly peerMedianKwh: number | null;
  readonly sun: number | null;
  /** The unit's share of peers divided by its past baseline; 1 means its usual share. */
  readonly ratio: number | null;
}

export interface Verdict {
  readonly status: 'RELEASE_READY' | 'HOLD';
  readonly unitId: string;
  readonly date: string;
  readonly reasons: readonly HoldReason[];
  readonly window: readonly EvidenceDay[];
  readonly mean: number | null;
  readonly baseline: number | null;
  readonly historyDays: number;
}

interface DayStat {
  readonly date: string;
  readonly kwh: number;
  readonly peerMedianKwh: number;
  readonly sun: number;
}

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(date: string): boolean {
  if (!DATE_FORMAT.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function isEnergy(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A day counts only if the unit, every peer and the sun sensor all gave a valid reading. */
function dayStat(fleet: Fleet, unitId: string, peerIds: readonly string[], date: string): DayStat | null {
  const own = fleet[unitId]?.[date];
  if (!own || !isEnergy(own.kwh)) return null;
  if (typeof own.sun !== 'number' || !Number.isFinite(own.sun) || own.sun <= 0) return null;
  const peers: number[] = [];
  for (const peerId of peerIds) {
    const kwh = fleet[peerId]?.[date]?.kwh;
    if (!isEnergy(kwh)) return null;
    peers.push(kwh);
  }
  return { date, kwh: own.kwh, peerMedianKwh: median(peers), sun: own.sun };
}

// Fleets are immutable, so a new reading means a new Fleet object and a fresh cache entry.
const usableDaysCache = new WeakMap<Fleet, Map<string, readonly DayStat[]>>();

function usableDays(fleet: Fleet, unitId: string, peerIds: readonly string[]): readonly DayStat[] {
  let perUnit = usableDaysCache.get(fleet);
  if (!perUnit) {
    perUnit = new Map();
    usableDaysCache.set(fleet, perUnit);
  }
  let days = perUnit.get(unitId);
  if (!days) {
    days = Object.keys(fleet[unitId] ?? {})
      .sort()
      .map((d) => dayStat(fleet, unitId, peerIds, d))
      .filter((s): s is DayStat => s !== null && s.peerMedianKwh > 0);
    perUnit.set(unitId, days);
  }
  return days;
}

function held(unitId: string, date: string, reasons: readonly HoldReason[]): Verdict {
  return { status: 'HOLD', unitId, date, reasons, window: [], mean: null, baseline: null, historyDays: 0 };
}

export function judge(fleet: Fleet, unitId: string, date: string, rules: Rules = DEFAULT_RULES): Verdict {
  if (!isValidDate(date)) return held(unitId, date, [{ code: 'INVALID_DATE' }]);
  const series = fleet[unitId];
  if (!series) return held(unitId, date, [{ code: 'UNKNOWN_UNIT' }]);

  const peerIds = Object.keys(fleet).filter((id) => id !== unitId);
  const reasons: HoldReason[] = [];
  if (peerIds.length < rules.minPeers) {
    reasons.push({ code: 'TOO_FEW_PEERS', have: peerIds.length, need: rules.minPeers });
  }

  const windowDates = Array.from({ length: rules.windowDays }, (_, k) =>
    addDays(date, k - rules.windowDays + 1),
  );
  const windowStart = windowDates[0] as string;
  const stats = windowDates.map((d) => dayStat(fleet, unitId, peerIds, d));

  // Only days before the window can shape the baseline, so later data can't affect the verdict.
  const history = usableDays(fleet, unitId, peerIds).filter((s) => s.date < windowStart);
  const shares = history.map((s) => s.kwh / s.peerMedianKwh);
  const baseline = shares.length > 0 ? median(shares) : null;
  const usualPeerKwh = median(history.map((s) => s.peerMedianKwh));

  const missing = windowDates.filter((_, k) => stats[k] === null);
  if (missing.length > 0) reasons.push({ code: 'MISSING_DATA', dates: missing });

  const peersDown = stats
    .filter((s): s is DayStat => s !== null)
    .filter((s) => s.peerMedianKwh <= 0 || s.peerMedianKwh < rules.peersDownShare * usualPeerKwh)
    .map((s) => s.date);
  if (peersDown.length > 0) reasons.push({ code: 'PEERS_DOWN', dates: peersDown });

  if (history.length < rules.minHistoryDays) {
    reasons.push({ code: 'NOT_ENOUGH_HISTORY', have: history.length, need: rules.minHistoryDays });
  } else if (baseline === null || !(baseline > 0)) {
    reasons.push({ code: 'NO_BASELINE' });
  }

  const usableBaseline = baseline !== null && baseline > 0 ? baseline : null;
  const ratios = stats.map((s) =>
    s !== null && s.peerMedianKwh > 0 && usableBaseline !== null
      ? s.kwh / s.peerMedianKwh / usableBaseline
      : null,
  );
  const window: EvidenceDay[] = windowDates.map((d, k) => {
    const s = stats[k] ?? null;
    return {
      date: d,
      kwh: s?.kwh ?? fleet[unitId]?.[d]?.kwh ?? null,
      peerMedianKwh: s?.peerMedianKwh ?? null,
      sun: s?.sun ?? null,
      ratio: ratios[k] ?? null,
    };
  });

  const complete = ratios.filter((r): r is number => r !== null);
  const mean = complete.length === rules.windowDays
    ? complete.reduce((sum, r) => sum + r, 0) / rules.windowDays
    : null;

  if (mean !== null) {
    if (!(mean >= rules.minMean)) reasons.push({ code: 'MEAN_TOO_LOW', mean, min: rules.minMean });
  }
  const belowFloor = window.filter((d) => d.ratio !== null && !(d.ratio >= rules.dayFloor)).map((d) => d.date);
  if (belowFloor.length > 0) {
    reasons.push({ code: 'DAY_BELOW_FLOOR', dates: belowFloor, min: rules.dayFloor });
  }

  if (usableBaseline !== null && history.length >= rules.minHistoryDays) {
    // A long stretch of low output drags the median down until low output looks normal.
    const earliest = median(shares.slice(0, rules.minHistoryDays));
    const drift = usableBaseline / earliest;
    if (!(drift >= rules.minBaselineDrift)) {
      reasons.push({ code: 'BASELINE_DEGRADED', drift, min: rules.minBaselineDrift });
    }

    // If the whole site is down together, share of peers looks normal. Sunlight exposes it.
    const usualYield = median(history.map((s) => s.peerMedianKwh / s.sun));
    const present = stats.filter((s): s is DayStat => s !== null);
    if (present.length === rules.windowDays) {
      const ratio = present.reduce((sum, s) => sum + s.peerMedianKwh / s.sun / usualYield, 0) / rules.windowDays;
      if (!(ratio >= rules.minFleetYield)) {
        reasons.push({ code: 'FLEET_LOW_FOR_SUN', ratio, min: rules.minFleetYield });
      }
    }
  }

  // The only route to RELEASE_READY: a complete window, a mean, and no reason to hold.
  const ready = reasons.length === 0 && mean !== null && usableBaseline !== null;
  return {
    status: ready ? 'RELEASE_READY' : 'HOLD',
    unitId,
    date,
    reasons,
    window,
    mean,
    baseline,
    historyDays: history.length,
  };
}
