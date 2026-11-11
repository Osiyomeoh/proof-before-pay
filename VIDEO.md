# Video script: Proof Before Pay (target 2:45, hard limit under 3:00)

Every spoken number is in CLAIMS.md with its source or the run behind it. If what's on screen differs from a line here, say what's on screen.

## Before you record

- **Host:** App Runner, https://h2uvpaitmh.us-west-2.awsapprunner.com (live PayPal sandbox, live Claude). This shows PayPal and the AI really working.
- **Approve the hold off camera.** Press Start, approve with the sandbox buyer, and only start recording once you're back on the contract page at Oct 12. The PayPal login page shows the buyer's login details and PayPal's branding. [FILL: check whether the rules or PayPal's brand guidance allow PayPal's own pages and logo on screen. Until that's checked, keep them out.]
- **Check "PayPal's own record" on App Runner first.** It's proven in sample mode (36 record checks agree), but the live Agent Toolkit read on App Runner hasn't been seen yet. If it doesn't say "Agrees with this page" after Release, cut that sentence (marked ✂︎A).
- **Check the agent card on App Runner first.** Its label should start "claude-sonnet-4-6 on AWS Bedrock" on Oct 12 and Nov 19. Live runs haven't been seen on App Runner yet (the six saved runs were made locally against Bedrock). If it says "Plain run", cut the agent lines (marked ✂︎B) or record that segment on Render, where the card is labelled "Recorded run".
- **Wake the Render backup** (https://proof-before-pay.onrender.com) just before you record. After a night with no traffic, its first page took 33 s.
- **Browser:** Chrome, window 1280 px wide, zoom 100%, light theme, bookmarks bar and extensions hidden, notifications off.
- **Audio:** your voice only. No music, not even royalty-free, so nothing third-party is in the video.
- **Play speed:** Play took 24.8 s on Render (38 days, median 632 ms per day). App Runner answers each request in about 0.82 s against Render's 0.33 s, so expect roughly a minute there. That figure is estimated, not timed. Speed the clip up in editing to fit about 40 s, and put "2× speed" (or whatever you use) on screen while it plays.
- Record each segment as its own take and cut between them. Upload this voiceover as YouTube captions.

## Script

| Time | On screen | Voiceover |
|---|---|---|
| **0:00–0:10** | Landing page, hero. Caption: *Paulding County, Georgia, 2016: $10,000 paid up front, no panels. Fox 5 Atlanta.* Then: *FTC solar-panel complaints: 630 in 2018, 5,331 from Jan 1 to Sep 19, 2023. TIME, Aug 2024.* | "In 2016, a Georgia woman paid her solar installer ten thousand dollars up front and never got any panels. Solar-panel complaints to the FTC have climbed since." |
| **0:10–0:22** | Slow pan over the four steps: PayPal holds the money, The data decides, The AI explains, A person releases. Cut to the contract page at Oct 12, Release locked. | "Proof Before Pay puts each solar milestone on a PayPal hold. Nothing is captured until the roof's own readings pass a fixed check, and a person taps Release." |
| **0:22–0:48** | The chart at Oct 12. **Why** tab: the AI explanation. Then **Installer's reply** → **It was cloudy** → "Data doesn't support it". Then **Ignore your rules** → "changes nothing". Release still locked. | "This is real 2020 data from a commercial roof in Maui. Inverter 01 has been at zero since October 9. Claude, on AWS Bedrock, explains the hold, but it has no tools and can't touch money. When the installer says it was cloudy, Claude turns that into a claim, and fixed rules check it: the other inverters on the roof kept producing. 'Ignore your rules' changes nothing." |
| **0:48–1:00** | ✂︎B Scroll to the **agent** card under the verdict. Hold on the tool steps, then the proposal and the draft with its **Copy** button. | "Under it is an agent: Claude with four read-only tools. It reads the verdict, the last forty-five days and PayPal's record, and drafts a message to the installer. The server checks every number and date it writes against what its tools returned. It proposes asking the installer. Nothing is sent." |
| **1:00–1:38** | Press **Play**. The "Same $40.00, two rules" band fills in day by day. Speed label on screen. | "Now I press Play, and the month runs one recorded day at a time." *(Oct 22)* "October 22: output comes back." *(Oct 23, headline changes)* "A rule that pays after one good day pays the forty dollars here." *(Oct 26 on, pink cells)* "Three days later, the inverter is back at zero for sixteen more recorded days. That money has already gone." *(the This check lane stays on hold)* "Our check wants a seven-day average of at least seventy percent of this inverter's usual share of the roof, and no day under thirty. So it keeps holding." *(Nov 19, green)* "November 19. The last seven days pass, and Release unlocks." |
| **1:38–2:00** | ✂︎B On the agent card, one second on "Proposed next step: Release this milestone". Then tap **Release $40.00**. Hold on the **PayPal hold** card as it updates to $40.00 captured. Scroll to **PayPal's own record**. | ✂︎B "The agent proposes Release, because the check passed and PayPal's record agrees. It can't press it." "Release is still a person's tap. PayPal captures forty of the hundred dollars, and the rest stays held for the next milestone." ✂︎A "Underneath, PayPal's Agent Toolkit reads the order back from PayPal, with one read-only tool, get_order, and PayPal agrees with the page." |
| **2:00–2:12** | Scroll to the ledger. Tap **Rules disagree**, then the CSV download. | "The ledger, built on AG Grid, puts both rules side by side for every recorded day. Through November 19 they disagree on 25 days, and you can download exactly what's on screen." |
| **2:12–2:27** | Landing page, bottom: the neighbour contract card with the four weekly bills. | "The same readings can bill power too. A neighbour's hundred-and-twenty-dollar hold pays only for what the roof made each week: $22.47, $8.61, nothing for the outage week, then $9.74. The unused $79.18 goes back." |
| **2:27–2:42** | End card: *Proof Before Pay* · PayPal Orders, Payments, Webhooks and Agent Toolkit · Claude Sonnet 4.6 on AWS Bedrock, explaining and as a read-only agent · AG Grid · both demo URLs. | "It's a commercial roof, not a home, and the check needs thirty days of history, so it doesn't yet work on a brand-new install. Proof Before Pay: your installer gets paid when the system proves it's producing." |

## If it runs long, cut in this order

1. The neighbour contract (0:15).
2. The ledger's CSV half-sentence (0:04).
3. "Solar-panel complaints to the FTC have climbed since." The on-screen caption still carries it.

Never cut: the hold, Play reaching Oct 23 and then Nov 19, the person tapping Release, or the limit line. Cut the agent (✂︎B) only if the App Runner check above fails.

## Sources behind each spoken number

| Spoken | Source |
|---|---|
| Georgia woman, 2016, $10,000 up front, no panels | Fox 5 Atlanta, June 23, 2016 (CLAIMS.md) |
| 630 → 5,331 FTC complaints | TIME, Aug 7, 2024 (CLAIMS.md) |
| Zero since Oct 9; back Oct 22; one-good-day pays Oct 23; zero again from Oct 26 for 16 recorded days; ready Nov 19 | `test/ledger.test.ts`, `test/app.test.ts` on the real Maui data |
| 7-day average of at least 70%, no day under 30% | `DEFAULT_RULES`, checked against the page by `test/ledger.test.ts` |
| Cloudy → not supported; "Ignore your rules" changes nothing | excuse check, run 2026-11-11 on a local sample server (recorded Claude split, live fixed rules); `test/excuse.test.ts`. Live Claude may word the claim differently; the finding comes from the fixed rules |
| $40 of $100 captured, rest held | `test/app.test.ts`; sandbox spike `spike/SPIKE-PAYPAL.md` |
| `get_order`, read-only | `spike/SPIKE-TOOLKIT.md`; live App Runner read still to confirm (✂︎A) |
| Agent: four read-only tools, 45 days, numbers and dates checked, asks on Oct 12, proposes Release on Nov 19, can't press it | `src/ai/agent.ts`, `test/agent.test.ts`; six saved Bedrock runs in `spike/agent-run.json` (Nov 11, 2026); the route leaves the hold and captures unchanged in `test/app.test.ts` |
| 25 days where the rules disagree, through Nov 19 | `node scripts/check-ui.mjs` ledger readout, Render, 2026-11-09 |
| $22.47, $8.61, $0.00, $9.74; $79.18 back | `test/neighbour.test.ts` |
| Commercial roof, 30+ days of history, not a new install | README Limits |
