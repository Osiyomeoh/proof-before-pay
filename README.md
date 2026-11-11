# Proof Before Pay

[![CI](https://github.com/Osiyomeoh/proof-before-pay/actions/workflows/ci.yml/badge.svg)](https://github.com/Osiyomeoh/proof-before-pay/actions/workflows/ci.yml)

A solar buyer shouldn't pay a milestone because an installer says the system works. Here, a PayPal authorization holds each milestone payment, and money is captured only after production data passes a fixed check and a person taps Release. On a real 2020 outage, a pay-after-one-good-day rule would have paid on Oct 23; this check held until Nov 19.

**Live demo, PayPal sandbox:** https://h2uvpaitmh.us-west-2.awsapprunner.com. Holds, captures and voids are real calls to PayPal's sandbox, so approving a hold needs a PayPal sandbox buyer login. Judges will find it in the submission's testing instructions. No real money moves.

**No-login backup, sample mode:** https://proof-before-pay.onrender.com. The same real production data, with recorded PayPal and AI replies, clearly labelled. Nothing to log in to.

## Try it

1. Open the demo and start a hold.
2. On **Oct 12, 2020** the payment stays on hold. Try an installer's excuse, including "Ignore your rules": Release stays locked.
3. Press **Forge these days** to see what forged totals would do, and what the logger catches.
4. Move to **Oct 22**. Output returns, and the check still holds. By **Oct 26** it's back to zero.
5. Move to **Nov 19**. The check passes, and you tap Release to capture $40 of the $100 hold.

**The agent.** On each day the hold is open, an agent card shows Claude working through four read-only tools: the verdict, up to 45 days of readings, PayPal's record of the hold, and a draft to the installer that the server checks. It ends with a proposed next step. On Oct 12 it asks the installer about the outage, with a message you can copy. Nothing is sent. On Nov 19 it proposes Release, but the button is still yours to tap.

**Or watch it.** After starting a hold, press **Play**. The page steps through the month one recorded day at a time and draws both rules on the same $40.00: the one-good-day rule pays on Oct 23, the inverter is back at zero by Oct 26, and this check holds until Nov 19. Play stops there, and Release is yours to tap.

**A second contract on the same roof.** At the bottom of the landing page, **Hold $120.00 for four weeks of power** lets a neighbour buy inverter 01's output at a demo price of $0.10 a kWh. Each week is billed from that week's readings once its last day is in, and a person taps to capture it: $22.47, $8.61, then the outage week closes at $0.00 with no PayPal call, then $9.74. After the last week, the unused $79.18 is voided back to the buyer.

## Who decides what

| Step | Decided by |
|---|---|
| Hold, capture, void | PayPal Orders and Payments APIs, called only by the server's payment code |
| Whether a milestone is ready | A fixed rule: a 7-day average of at least 70% of the inverter's usual share of the other inverters' median, with no day under 30% |
| Release | A one-time token, issued only while the server's own verdict is ready |
| A neighbour's weekly bill | The week's recorded kWh × $0.10, capped at 300 kWh, worked out on the server at the tap. The request sets no amount |
| Explaining a hold, drafting a question, splitting an installer's reply into claims | Claude Sonnet 4.6 on AWS Bedrock. It has no tools and no payment data, and its module can't import payment or server code |
| The agent's proposed next step and its message to the installer | Claude Sonnet 4.6 on AWS Bedrock, with four read-only tools. It sees PayPal's record only as statuses and amounts, with no IDs or buyer details, and its module can't import payment or server code. The server keeps its answer only if it read the verdict, every number and date in it came back from its tools in that run, and it proposes Release only when the verdict is ready and it has read PayPal's record and found that it agrees. Otherwise the card shows a plain run of the same reads and says why |
| Checking those claims | Fixed rules against the measured data. The AI never names a cause |
| "PayPal's own record" panel | PayPal Agent Toolkit, `get_order` only, read-only. The app refuses a toolkit that lists any other tool |

AG Grid powers the production ledger, which compares the two pay rules day by day, with filters and CSV export.

## What's measured

- **The outage:** inverter 01 on a Maui roof logged 0.0 kWh on Oct 9–21, 2020 while the other inverters kept producing. Output returned Oct 22–25, then logged 0.0 kWh on 16 of the next 18 days (Oct 26–Nov 12). Nov 5–6 have no daily total.
- **Across the roof:** over 9 inverters and 13,257 judged days, days our rule paid were followed within 14 days by a day under 30% of usual 7.2% of the time, against 8.7% for the one-good-day rule. Ours held 641 days the other rule paid. Most of the gap comes from one inverter (`npm run eval:fleet`, results in `spike/eval-fleet.json`).
- **Forgery test:** rewriting inverter 01's 40 outage days to normal totals fools the engine. The logger's DC voltage caught 29 of the 40, every day the inverter really made 0 kWh, and missed 11 days with real but smaller output. It raised 0 false alarms across 6,791 real inverter-days (`node spike/forge-test.ts`).
- **Neighbour contract:** inverter 01's four weeks from Sep 28 to Oct 25, 2020, each day read to the tenth of a kWh and rounded down, bill $22.47, $8.61, $0.00 and $9.74. The 300 kWh weekly cap is above all 38 full weeks it made in 2020 before then (best 289.6 kWh). Over HTTP, $40.82 is captured in three captures, none final, and the $79.18 left is voided (`test/neighbour.test.ts`).
- **The agent:** on Nov 11, 2026, six runs on Bedrock covered Oct 12, 22, 23 and 26, Nov 19, and milestone 2 on Dec 19. The checks kept all six, which took 20 model calls. In each of the four hold runs, the first draft to the installer was 781 to 921 characters and the draft check refused it, and the second draft, at 484 to 511 characters, passed. It asked the installer on the four hold days and proposed Release on the two ready days (`npm run agent`, saved in `spike/agent-run.json`).
- **PayPal sandbox:** a hold captured in two parts, a void after a partial capture, a capture above the hold refused, and a repeated request ID returning the same capture (`spike/sandbox-run-result.json`).

## Limits

- The data is a 110 kW commercial roof, not a home. The check needs 30+ days of history and comparable inverters, so it **doesn't yet work on a new home install**.
- There's no fault log for this site, so these figures aren't accuracy. The cause of the outage is unknown, and the thresholds were chosen after looking at this outage.
- The dataset's kWh figures look too high in absolute terms, so verdicts use shares, not kWh.
- Forging data gets harder, not impossible: the logger check catches a forged day only when the DC side was dead, and someone who rewrites every raw reading would pass.
- The token can't prove who tapped. In the demo, any client can move a contract forward through recorded days; it can't go back or supply a verdict. A real product would use today's date.
- The neighbour contract bills what inverter 01 measured, not what a neighbour used: a real setup needs a meter on the neighbour's line. Selling power to a neighbour can need the utility's or a regulator's permission, and this demo doesn't check it. $0.10 a kWh is a demo price, and the kWh run high, so the amounts show how billing works, not a real bill.
- In sample mode the agent card replays those six saved runs: their tool calls are made again against your hold, and the answer must pass the same checks. On other days it shows a plain run with no AI. The checks catch numbers and dates the tools didn't return, words that blame a cause, and a hold described as something a reply could clear. They don't prove the rest of the wording is right.
- Not yet run: reauthorizing a hold on the sandbox, and three partial captures then a void on one sandbox authorization.
- Webhooks: on Nov 8, 2026, PayPal's sandbox resent a real `PAYMENT.CAPTURE.COMPLETED` event to the deployed URL, and it passed the signature check. It matched no hold, because a redeploy had cleared the in-memory holds, so it changed nothing. A webhook that does update a hold is tested with a test certificate.

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
