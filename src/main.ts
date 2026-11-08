// App entry. With PayPal keys it runs against the real sandbox. Without them, or with SAMPLE_MODE=1,
// it runs in sample mode: real Maui data, recorded PayPal replies and recorded AI answers, all labelled.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createBedrockExplainer, createBedrockSplitter } from './ai/bedrock.ts';
import { createExcuseChecker, createRecordedSplitter } from './ai/excuse.ts';
import { createRecordedExplainer } from './ai/recorded.ts';
import { createPayments } from './payments/service.ts';
import type { Contract } from './payments/service.ts';
import { createPayPalClient } from './paypal/client.ts';
import { cachedRecords, createOrderReader, loadPayPalToolkit, recordedOrder } from './paypal/order-record.ts';
import { createRecordedPayPal } from './paypal/recorded.ts';
import { createWebhookVerifier } from './paypal/webhook.ts';
import { loadMauiLogger } from './proof/claims.ts';
import { judge } from './proof/engine.ts';
import type { Verdict } from './proof/engine.ts';
import { forgeryTest } from './proof/forgery.ts';
import { createLedger } from './proof/ledger.ts';
import { MAUI_INVERTERS, commonDates, loadMauiFleet } from './proof/maui.ts';
import { createApp } from './server/app.ts';
import { DEMO_UNIT } from './server/demo.ts';
import { createHandler } from './server/http.ts';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const clientId = process.env['PAYPAL_CLIENT_ID'];
const clientSecret = process.env['PAYPAL_CLIENT_SECRET'];
const sample = process.env['SAMPLE_MODE'] === '1' || !clientId || !clientSecret;

const paypal = sample || !clientId || !clientSecret ? createRecordedPayPal() : createPayPalClient({ clientId, clientSecret });
const explainer = sample ? createRecordedExplainer() : createBedrockExplainer();
const splitter = sample
  ? createRecordedSplitter(JSON.parse(readFileSync(new URL('../spike/excuse-run.json', import.meta.url), 'utf8')).results)
  : createBedrockSplitter();

const fleet = loadMauiFleet();
const lastDate = commonDates(fleet).at(-1);
if (lastDate === undefined) throw new Error('no production data found');

const proof = (unitId: string, date: string) => judge(fleet, unitId, date);
const payments = createPayments({ paypal, proof });
const port = Number(process.env['PORT'] ?? 3000);
const publicUrl = process.env['PUBLIC_URL'] ?? process.env['RENDER_EXTERNAL_URL'] ?? `http://localhost:${port}`;

// PayPal's own record, read with the Agent Toolkit's get_order tool. In sample mode it's a recorded reply built from this app's state.
const orderRecord = sample || !clientId || !clientSecret
  ? async (contract: Contract) => ({ record: recordedOrder(contract), readAt: new Date().toISOString() })
  : cachedRecords(createOrderReader(await loadPayPalToolkit(clientId, clientSecret)));

// The excuse check: the AI splits the reply into claims, then fixed rules test each one against measured data.
const logger = loadMauiLogger(MAUI_INVERTERS);
const checkExcuse = createExcuseChecker(splitter, fleet, logger);
const forgeCheck = (verdict: Verdict) => forgeryTest(verdict, fleet, logger);

const ledger = createLedger(fleet, DEMO_UNIT, lastDate);
const app = createApp({ payments, proof, fleet, lastDate, mode: sample ? 'sample' : 'sandbox', publicUrl, explain: (verdict) => explainer.explain(verdict), ledger: ledger.through, orderRecord, checkExcuse, forgeCheck });
const verifyWebhook = createWebhookVerifier({ webhookId: process.env['PAYPAL_WEBHOOK_ID'] });

// Containers must listen on 0.0.0.0, for App Runner (the primary host) and Render (the backup): https://render.com/docs/web-services
createServer(createHandler({ payments, verifyWebhook, app, log: (line) => console.log(line) })).listen(port, '0.0.0.0', () => {
  console.log(`Proof Before Pay on ${publicUrl} (${sample ? 'sample mode' : 'PayPal sandbox'})`);
  // Built once in the background, so the first visitor doesn't wait for it.
  void ledger.through(lastDate);
});
