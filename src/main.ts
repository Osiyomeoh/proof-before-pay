// App entry. With PayPal keys it runs against the real sandbox. Without them, or with SAMPLE_MODE=1,
// it runs in sample mode: real Maui data, recorded PayPal replies and recorded AI answers, all labelled.
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createBedrockExplainer } from './ai/bedrock.ts';
import { createRecordedExplainer } from './ai/recorded.ts';
import { createPayments } from './payments/service.ts';
import { createPayPalClient } from './paypal/client.ts';
import { createRecordedPayPal } from './paypal/recorded.ts';
import { createWebhookVerifier } from './paypal/webhook.ts';
import { judge } from './proof/engine.ts';
import { createLedger } from './proof/ledger.ts';
import { commonDates, loadMauiFleet } from './proof/maui.ts';
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

const fleet = loadMauiFleet();
const lastDate = commonDates(fleet).at(-1);
if (lastDate === undefined) throw new Error('no production data found');

const proof = (unitId: string, date: string) => judge(fleet, unitId, date);
const payments = createPayments({ paypal, proof });
const port = Number(process.env['PORT'] ?? 3000);
const publicUrl = process.env['PUBLIC_URL'] ?? process.env['RENDER_EXTERNAL_URL'] ?? `http://localhost:${port}`;

const ledger = createLedger(fleet, DEMO_UNIT, lastDate);
const app = createApp({ payments, proof, fleet, lastDate, mode: sample ? 'sample' : 'sandbox', publicUrl, explain: (verdict) => explainer.explain(verdict), ledger: ledger.through });
const verifyWebhook = createWebhookVerifier({ webhookId: process.env['PAYPAL_WEBHOOK_ID'] });

// Containers must listen on 0.0.0.0, for App Runner (the primary host) and Render (the backup): https://render.com/docs/web-services
createServer(createHandler({ payments, verifyWebhook, app })).listen(port, '0.0.0.0', () => {
  console.log(`Proof Before Pay on ${publicUrl} (${sample ? 'sample mode' : 'PayPal sandbox'})`);
  // Built once in the background, so the first visitor doesn't wait for it.
  void ledger.through(lastDate);
});
