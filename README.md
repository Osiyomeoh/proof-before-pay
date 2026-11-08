# Proof Before Pay

[![CI](https://github.com/Osiyomeoh/proof-before-pay/actions/workflows/ci.yml/badge.svg)](https://github.com/Osiyomeoh/proof-before-pay/actions/workflows/ci.yml)

A solar buyer shouldn't pay a milestone because an installer says the system works. Here, a PayPal authorization holds each milestone payment, and money is captured only after production data passes a fixed check and a person taps Release. On a real 2020 outage, a pay-after-one-good-day rule would have paid on Oct 23; this check held until Nov 19.

**Live demo:** https://h2uvpaitmh.us-west-2.awsapprunner.com (backup: https://proof-before-pay.onrender.com)

The hosted demo runs in sample mode: real production data, with recorded PayPal and AI replies, clearly labelled. No money moves and no login is needed.

## Try it

1. Open the demo and start a hold.
2. On **Oct 12, 2020** the payment stays on hold. Try an installer's excuse, including "Ignore your rules": Release stays locked.
3. Press **Forge these days** to see what forged totals would do, and what the logger catches.
4. Move to **Oct 22**. Output returns, and the check still holds. By **Oct 26** it's back to zero.
5. Move to **Nov 19**. The check passes, and you tap Release to capture $40 of the $100 hold.

## Who decides what

| Step | Decided by |
|---|---|
| Hold, capture, void | PayPal Orders and Payments APIs, called only by the server's payment code |
| Whether a milestone is ready | A fixed rule: a 7-day average of at least 70% of the inverter's usual share of the other inverters' median, with no day under 30% |
| Release | A one-time token, issued only while the server's own verdict is ready |
| Explaining a hold, drafting a question, splitting an installer's reply into claims | Claude Sonnet 4.6 on AWS Bedrock. It has no tools and no payment data, and its module can't import payment or server code |
| Checking those claims | Fixed rules against the measured data. The AI never names a cause |
| "PayPal's own record" panel | PayPal Agent Toolkit, `get_order` only, read-only. The app refuses a toolkit that lists any other tool |

AG Grid powers the production ledger, which compares the two pay rules day by day, with filters and CSV export.

## What's measured

- **The outage:** inverter 01 on a Maui roof logged 0.0 kWh on Oct 9–21, 2020 while the other inverters kept producing. Output returned Oct 22–25, then went back to zero for 18 days.
- **Across the roof:** over 9 inverters and 13,257 judged days, days our rule paid were followed within 14 days by a day under 30% of usual 7.2% of the time, against 8.7% for the one-good-day rule. Ours held 641 days the other rule paid. Most of the gap comes from one inverter (`npm run eval:fleet`, results in `spike/eval-fleet.json`).
- **Forgery test:** rewriting inverter 01's 40 outage days to normal totals fools the engine. The logger's DC voltage caught 29 of the 40, every day the inverter really made 0 kWh, and missed 11 days with real but smaller output. It raised 0 false alarms across 6,791 real inverter-days (`node spike/forge-test.ts`).
- **PayPal sandbox:** a hold captured in two parts, a void after a partial capture, a capture above the hold refused, and a repeated request ID returning the same capture (`spike/sandbox-run-result.json`).

## Limits

- The data is a 110 kW commercial roof, not a home. The check needs 30+ days of history and comparable inverters, so it **doesn't yet work on a new home install**.
- There's no fault log for this site, so these figures aren't accuracy. The cause of the outage is unknown, and the thresholds were chosen after looking at this outage.
- The dataset's kWh figures look too high in absolute terms, so verdicts use shares, not kWh.
- Forging data gets harder, not impossible: the logger check catches a forged day only when the DC side was dead, and someone who rewrites every raw reading would pass.
- The token can't prove who tapped. In the demo, any client can move a contract forward through recorded days; it can't go back or supply a verdict. A real product would use today's date.
- Not yet run: reauthorizing a hold on the sandbox, and a real PayPal webhook event on the deployed URL. Signature checks are tested with a test certificate.

## Run it locally

Needs Node 24. No keys are needed for sample mode.

```sh
npm ci
npm run sample   # then open the URL it prints
npm test
npm run typecheck
```

For the live sandbox, copy `.env.example` to `.env` and add your own PayPal sandbox and AWS Bedrock settings, then run `npm start`.

## Data

Maui Ocean Center, NREL PVDAQ system 2105. Deline et al. (2021), Photovoltaic Data Acquisition (PVDAQ) Public Datasets, Open Energy Data Initiative, NREL, [doi:10.25984/1846021](https://doi.org/10.25984/1846021), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Daily totals, medians and shares are worked out from the raw readings.

Landing-page photos: Stephen Yang / The Solutions Project, 2016, public domain, via Wikimedia Commons ([installer carrying a panel](https://commons.wikimedia.org/wiki/File:Technicians_working_on_a_solar_panel_installation_(9235).jpg), [technician on a rooftop array](https://commons.wikimedia.org/wiki/File:Technicians_working_on_a_solar_panel_installation_(9234).jpg)). They're resized to WebP with the metadata removed. The people shown aren't connected to this project.

## Licence

[MIT](LICENSE)
