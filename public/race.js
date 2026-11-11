// The pay-rule race cut off after its first `count` recorded days, so the landing page can play the month without a hold.
// It works the totals out exactly as rulesRace in src/proof/ledger.ts does. test/ledger.test.ts checks every cut against it.
export function raceUpTo(race, count) {
  const days = race.days.slice(0, Math.max(1, count));
  const simplePaidOn = days.find((day) => day.simple === 'PAID')?.date ?? null;
  // The day it paid isn't counted, only the days after it.
  const after = simplePaidOn === null ? [] : days.filter((day) => day.date > simplePaidOn);
  return {
    ...race,
    through: days.at(-1).date,
    days,
    simplePaidOn,
    oursReadyOn: days.find((day) => day.ours === 'RELEASE_READY')?.date ?? null,
    underFloorSincePaid: after.filter((day) => day.belowFloor).length,
    noReadingSincePaid: after.filter((day) => day.noReading).length,
  };
}
