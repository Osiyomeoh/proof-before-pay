# Prints the inverter 01 outage table and tests candidate verdict rules on four inverters.
# Each rule looks at a trailing 7-day window. The baseline uses only days before that window.
# Usage (from spike/, after fetch-data.sh and analyze.py): python3 verdict.py
import csv, json, statistics as st, datetime as dt, collections

IDS = ['01', '02', '03', '07']
WINDOW, MIN_MEAN, MIN_HISTORY = 7, 0.7, 30
D = {i: json.load(open(f'data/daily_inv{i}.json'))['days'] for i in IDS}
COMMON = sorted(set.intersection(*[set(D[i]) for i in IDS]))
IN_ALL = set(COMMON)


def share(i, day):
    return D[i][day][0] / max(1e-9, st.median(D[j][day][0] for j in IDS if j != i))


def evaluate(i, floor):
    shares = {d: share(i, d) for d in COMMON}
    out = []
    for d in COMMON:
        end = dt.date.fromisoformat(d)
        window = [str(end - dt.timedelta(k)) for k in range(WINDOW)]
        if not all(x in IN_ALL for x in window):
            continue
        history = [shares[x] for x in COMMON if x < window[-1]]
        if len(history) < MIN_HISTORY:
            continue
        base = st.median(history)
        ratios = [shares[x] / base for x in window]
        mean = sum(ratios) / WINDOW
        # A zero peer median makes the share meaningless, so that window can't pass.
        peers_up = all(st.median(D[j][x][0] for j in IDS if j != i) > 0 for x in window)
        out.append((d, mean, peers_up and mean >= MIN_MEAN and min(ratios) >= floor))
    return out


print('date        inv01  peers  sun')
for n in range(47):
    d = str(dt.date(2020, 10, 7) + dt.timedelta(n))
    if d in D['01']:
        print(d, f"{D['01'][d][0]:6.1f} {st.median(D[j][d][0] for j in IDS[1:]):6.1f} {D['01'][d][1]:5.2f}")
    else:
        print(d, 'no daily total')

channels = collections.defaultdict(list)
for row in csv.DictReader(open('data/2105_inv01_data.csv')):
    day = row['measured_on'][:10]
    if '2020-10-01' <= day <= '2020-11-20':
        channels[day].append(row)
key = 'inv_string01_%s'
print('\ndate        rows peak_kW AC_median DC_median DC_max temp_max')
zero_days = []
for day, rows in sorted(channels.items()):
    values = lambda name: [float(r[key % name]) for r in rows if r[key % name] not in ('', None)]
    peak = max(values('ac_output_(kwh)_inv_150164'))
    if peak == 0:
        zero_days.append(day)
    if day in ('2020-10-05', '2020-10-08', '2020-10-12', '2020-10-23', '2020-11-05', '2020-11-06', '2020-11-14'):
        dc = values('dc_voltage_(v)_inv_150162')
        print(day, f"{len(rows):4d} {peak:7.2f} {st.median(values('ac_voltage_(v)_inv_150163')):9.1f}"
                   f" {st.median(dc):9.1f} {max(dc):6.1f} {max(values('temperature_(c)_inv_150166')):8.1f}")
print(f'days at zero peak: {len(zero_days)} ({zero_days[0]} to {zero_days[-1]})')

for floor in (0, 0.3, 0.5):
    print(f'\nrule: 7-day mean >= {MIN_MEAN}, every day >= {floor}')
    for i in IDS:
        results = evaluate(i, floor)
        print(f'  inv{i}: n={len(results)} held {sum(not r[2] for r in results) / len(results):.1%}')
    outage = [r for r in evaluate('01', floor) if '2020-10-01' <= r[0] <= '2020-12-01']
    held = [r[0] for r in outage if not r[2]]
    trap = [r for r in outage if '2020-10-22' <= r[0] <= '2020-10-28']
    print(f'  inv01 outage: first hold {held[0]}, last hold {held[-1]},',
          f'Oct 22-28 mean {min(r[1] for r in trap):.2f}-{max(r[1] for r in trap):.2f},',
          'all held' if not any(r[2] for r in trap) else 'SOME PASSED')

print('\nraw inv01 share of peers, median over all common days:', round(st.median(share('01', d) for d in COMMON), 3))
