// Plain-language wording for engine results, shared by the UI and the AI template.
// It only formats text, and imports nothing that can change a verdict or move money.
import type { HoldReason } from './engine.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const percent = (ratio: number | null) => (ratio === null || !Number.isFinite(ratio) ? null : Math.round(ratio * 100));

export function niceDate(iso: string): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const month = match?.[2] === undefined ? undefined : MONTHS[Number(match[2]) - 1];
  return match?.[1] === undefined || match[3] === undefined || month === undefined ? iso : `${month} ${Number(match[3])}, ${match[1]}`;
}

function dateList(dates: readonly string[]): string {
  const first = dates[0];
  const last = dates.at(-1);
  if (first === undefined || last === undefined) return 'some days';
  return first === last ? niceDate(first) : `${dates.length} days from ${niceDate(first)} to ${niceDate(last)}`;
}

export function reasonSentence(reason: HoldReason): string {
  switch (reason.code) {
    case 'INVALID_DATE':
      return 'The date to check is not valid.';
    case 'UNKNOWN_UNIT':
      return 'This inverter is not in the production data.';
    case 'TOO_FEW_PEERS':
      return `Only ${reason.have} other inverters are available to compare with, and the check needs ${reason.need}.`;
    case 'MISSING_DATA':
      return `Readings are missing for ${dateList(reason.dates)}, and missing data never counts as a pass.`;
    case 'PEERS_DOWN':
      return `The other inverters on the roof were at or near zero on ${dateList(reason.dates)}, so they can't be used as a comparison.`;
    case 'NOT_ENOUGH_HISTORY':
      return `This inverter has ${reason.have} days of history, and the check needs ${reason.need}.`;
    case 'NO_BASELINE':
      return 'There is not enough past data to work out this inverter\'s usual share of output.';
    case 'BASELINE_DEGRADED':
      return `This inverter's usual share has fallen to ${percent(reason.drift)}% of its earliest level, below the ${percent(reason.min)}% limit.`;
    case 'MEAN_TOO_LOW':
      return `Over the window it averaged ${percent(reason.mean)}% of its usual share, below the ${percent(reason.min)}% limit.`;
    case 'DAY_BELOW_FLOOR':
      return `It fell below ${percent(reason.min)}% of its usual share on ${dateList(reason.dates)}.`;
    case 'FLEET_LOW_FOR_SUN':
      return `The whole roof made ${percent(reason.ratio)}% of its usual output for the measured sun, below the ${percent(reason.min)}% limit.`;
  }
}

// A few words for a table cell. reasonSentence gives the full wording.
export function reasonLabel(reason: HoldReason): string {
  switch (reason.code) {
    case 'INVALID_DATE':
      return 'Invalid date';
    case 'UNKNOWN_UNIT':
      return 'Unknown inverter';
    case 'TOO_FEW_PEERS':
      return 'Too few other inverters';
    case 'MISSING_DATA':
      return 'Missing readings';
    case 'PEERS_DOWN':
      return 'Other inverters down';
    case 'NOT_ENOUGH_HISTORY':
      return 'Not enough history';
    case 'NO_BASELINE':
      return 'No usual share yet';
    case 'BASELINE_DEGRADED':
      return 'Usual share has fallen';
    case 'MEAN_TOO_LOW':
      return '7-day average too low';
    case 'DAY_BELOW_FLOOR':
      return 'A day under the floor';
    case 'FLEET_LOW_FOR_SUN':
      return 'Whole roof low for the sun';
  }
}
