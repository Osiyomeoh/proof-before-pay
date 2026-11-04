// Runs the real PayPal module against the real sandbox, to prove what the fake can't:
//   1. the same PayPal-Request-Id sent twice captures once
//   2. a hold can be voided after a partial capture
//   3. what PayPal does with a capture above the held amount (recorded, never guessed)
//   4. what PayPal does with a repeated invoice ID on a new request ID (recorded, never guessed)
//
//   npm run sandbox -- start    creates a $100 authorize order and prints the buyer approval link
//   npm run sandbox -- finish   after the buyer approves, runs the checks and writes the results
//
// Sandbox only, because the client has no other host. Ledger state goes to a gitignored file.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PayPalError, createPayPalClient } from '../src/paypal/client.ts';

const STATE = new URL('../spike/sandbox-run-state.json', import.meta.url);
const USD = (value: string) => ({ currency_code: 'USD', value });

process.loadEnvFile(new URL('../.env', import.meta.url));
const clientId = process.env['PAYPAL_CLIENT_ID'];
const clientSecret = process.env['PAYPAL_CLIENT_SECRET'];
if (clientId === undefined || clientSecret === undefined) throw new Error('.env is missing the PayPal client ID or secret');
const paypal = createPayPalClient({ clientId, clientSecret });

async function start() {
  const order = await paypal.createAuthorizeOrder({
    amount: USD('100.00'),
    description: 'Proof Before Pay sandbox run',
    referenceId: randomUUID(),
    returnUrl: 'https://example.com/approved',
    cancelUrl: 'https://example.com/cancelled',
    requestId: randomUUID(),
  });
  writeFileSync(STATE, JSON.stringify({ orderId: order.id }));
  console.log(`order ${order.id}: ${order.status} (debug ${order.debugId})`);
  console.log(`approve as the sandbox buyer: ${order.approveUrl}`);
}

async function finish() {
  if (!existsSync(STATE)) throw new Error('run start first');
  const { orderId } = JSON.parse(readFileSync(STATE, 'utf8')) as { orderId: string };
  const results: Record<string, unknown> = { ranAt: new Date().toISOString() };

  const auth = await paypal.authorizeOrder(orderId, randomUUID());
  console.log(`hold ${auth.id}: ${auth.status}, expires ${auth.expiresAt}`);
  results['hold'] = { status: auth.status, expiresAt: auth.expiresAt };

  const input = { authorizationId: auth.id, amount: USD('40.00'), finalCapture: false, invoiceId: `run-${randomUUID()}`, requestId: randomUUID() };
  const first = await paypal.capture(input);
  const repeat = await paypal.capture(input);
  const afterRepeat = await paypal.getAuthorization(auth.id);
  console.log(`same request ID twice: ${first.id} ${first.status}, then ${repeat.id} ${repeat.status}`);
  console.log(`authorization after both: ${afterRepeat.status}`);
  results['repeatRequest'] = { sameCaptureId: first.id === repeat.id, firstStatus: first.status, repeatStatus: repeat.status, authorizationStatus: afterRepeat.status };

  try {
    const over = await paypal.capture({ authorizationId: auth.id, amount: USD('5000.00'), finalCapture: false, invoiceId: `run-${randomUUID()}`, requestId: randomUUID() });
    console.log(`over-capture was accepted: ${over.status}`);
    results['overCapture'] = { accepted: true, status: over.status };
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error;
    console.log(`over-capture refused: ${error.message} (debug ${error.debugId})`);
    results['overCapture'] = { accepted: false, status: error.status, message: error.message };
  }

  try {
    const again = await paypal.capture({ ...input, amount: USD('10.00'), requestId: randomUUID() });
    console.log(`same invoice ID, new request ID: accepted, ${again.id} ${again.status}`);
    results['repeatInvoice'] = { accepted: true, status: again.status };
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error;
    console.log(`same invoice ID, new request ID: refused, ${error.message} (debug ${error.debugId})`);
    results['repeatInvoice'] = { accepted: false, status: error.status, message: error.message };
  }

  try {
    const voided = await paypal.voidAuthorization(auth.id, randomUUID());
    const afterVoid = await paypal.getAuthorization(auth.id);
    console.log(`void after a partial capture: ${voided.status}; authorization now ${afterVoid.status}`);
    results['voidAfterPartial'] = { voidStatus: voided.status, authorizationStatus: afterVoid.status };
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error;
    console.log(`void after a partial capture refused: ${error.message} (debug ${error.debugId})`);
    results['voidAfterPartial'] = { refused: true, status: error.status, message: error.message };
  }

  writeFileSync(new URL('../spike/sandbox-run-result.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
}

const command = process.argv[2];
if (command === 'start') await start();
else if (command === 'finish') await finish();
else throw new Error('usage: npm run sandbox -- start|finish');
