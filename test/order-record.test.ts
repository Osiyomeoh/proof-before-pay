// PayPal's own record, read with the Agent Toolkit's get_order tool. These tests use a stand-in
// toolkit, so they make no network call. The real read on the sandbox is in spike/SPIKE-TOOLKIT.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Contract, Milestone } from '../src/payments/service.ts';
import { ORDER_TOOL, OrderReadError, cachedRecords, checkRecord, createOrderReader, recordedOrder, toOrderRecord } from '../src/paypal/order-record.ts';
import type { OrderRecord, OrderToolkit } from '../src/paypal/order-record.ts';

const ORDER_ID = 'ORDER0000000000001';

// The shape get_order returned on the sandbox, with the buyer fields a real reply carries.
const PAYPAL_ORDER = {
  id: ORDER_ID,
  intent: 'AUTHORIZE',
  status: 'COMPLETED',
  payment_source: { paypal: { email_address: 'buyer@example.com', account_id: 'BUYERACCOUNT1', name: { given_name: 'Test', surname: 'Buyer' } } },
  payer: { email_address: 'buyer@example.com', payer_id: 'BUYERACCOUNT1', name: { given_name: 'Test', surname: 'Buyer' } },
  purchase_units: [{
    reference_id: 'default',
    amount: { currency_code: 'USD', value: '100.00' },
    shipping: { name: { full_name: 'Test Buyer' }, address: { address_line_1: '1 Main St', postal_code: '95131' } },
    payments: {
      authorizations: [{ id: 'AUTH0000000000001', status: 'PARTIALLY_CAPTURED', amount: { currency_code: 'USD', value: '100.00' }, links: [] }],
      captures: [{ id: 'CAPTURE00000000001', status: 'COMPLETED', amount: { currency_code: 'USD', value: '40.00' }, final_capture: false }],
    },
  }],
  update_time: '2026-11-06T10:00:00Z',
  links: [{ href: 'https://api.sandbox.paypal.com/v2/checkout/orders/ORDER0000000000001', rel: 'self', method: 'GET' }],
};

// The toolkit JSON-encodes its reply twice.
const encode = (value: unknown) => ({ content: [{ text: JSON.stringify(JSON.stringify(value)) }] });

function fakeToolkit(reply: () => Promise<{ content: { text: string }[] }>, options: { tools?: string[]; baseUrl?: string } = {}) {
  const calls: { name: string; input: { id: string } }[] = [];
  const toolkit: OrderToolkit = {
    getTools: () => (options.tools ?? [ORDER_TOOL]).map((name) => ({ toolSpec: { name } })),
    handleToolCall: (call) => {
      calls.push(call);
      return reply();
    },
    client: { getBaseUrl: () => options.baseUrl ?? 'https://api.sandbox.paypal.com' },
  };
  return { toolkit, calls };
}

function milestone(id: string, amountCents: number, status: Milestone['status'] = 'WAITING', captureId: string | null = null): Milestone {
  return { id, title: id, amountCents, unitId: '01', proofDate: '2020-11-19', status, captureRequestId: `req-${id}`, captureAttempt: 0, captureId, debugId: null, lastError: null };
}

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'c1', description: 'test', currency: 'USD', totalCents: 10000, status: 'HELD', orderId: ORDER_ID, approveUrl: null,
    authorizationId: 'AUTH0000000000001', authorizeRequestId: 'auth-req', expiresAt: null,
    milestones: [milestone('m1', 4000), milestone('m2', 6000)], timeline: [], ...overrides,
  };
}

test('the reader calls only get_order, with the order ID it was given', async () => {
  const { toolkit, calls } = fakeToolkit(async () => encode(PAYPAL_ORDER));
  const record = await createOrderReader(toolkit)(ORDER_ID);
  assert.deepEqual(calls.map((call) => [call.name, call.input]), [[ORDER_TOOL, { id: ORDER_ID }]]);
  assert.equal(record.source, 'paypal');
  assert.equal(record.status, 'COMPLETED');
  assert.deepEqual(record.authorizations, [{ id: 'AUTH0000000000001', status: 'PARTIALLY_CAPTURED', amount: { currency_code: 'USD', value: '100.00' } }]);
  assert.deepEqual(record.captures, [{ id: 'CAPTURE00000000001', status: 'COMPLETED', amount: { currency_code: 'USD', value: '40.00' }, finalCapture: false }]);
});

test("the buyer's name, email, address and payment source never leave the module", async () => {
  const { toolkit } = fakeToolkit(async () => encode(PAYPAL_ORDER));
  const record = await createOrderReader(toolkit)(ORDER_ID);
  assert.deepEqual(Object.keys(record).sort(), ['amount', 'authorizations', 'captures', 'intent', 'orderId', 'source', 'status', 'tool', 'updatedAt']);
  const sent = JSON.stringify(record);
  for (const word of ['payer', 'payment_source', 'buyer@example.com', 'BUYERACCOUNT1', 'Buyer', 'Main St', 'shipping', 'links']) {
    assert.ok(!sent.includes(word), word);
  }
});

test('a toolkit that offers any other tool, or points outside the sandbox, is refused', () => {
  const reply = async () => encode(PAYPAL_ORDER);
  assert.throws(() => createOrderReader(fakeToolkit(reply, { tools: [ORDER_TOOL, 'pay_order'] }).toolkit), /only get_order/);
  assert.throws(() => createOrderReader(fakeToolkit(reply, { tools: [] }).toolkit), /only get_order/);
  assert.throws(() => createOrderReader(fakeToolkit(reply, { baseUrl: 'https://api-m.paypal.com' }).toolkit), /sandbox/);
  assert.throws(() => createOrderReader(fakeToolkit(reply, { baseUrl: 'https://sandbox.paypal.com.example.com' }).toolkit), /sandbox/);
});

test('an ID that is not a PayPal order ID is refused before any call', async () => {
  const { toolkit, calls } = fakeToolkit(async () => encode(PAYPAL_ORDER));
  const read = createOrderReader(toolkit);
  for (const id of ['', 'RECORDED-ORDER-1', '../v1/oauth2/token', 'order0000000000001', `${ORDER_ID}/capture`, 'A'.repeat(33)]) {
    await assert.rejects(read(id), OrderReadError, id);
  }
  assert.equal(calls.length, 0);
});

test('a PayPal error returned as a normal tool result is treated as a failure', async () => {
  const replies: unknown[] = [
    { error: { message: 'Request failed with status code 404', type: 'paypal_error' } },
    { code: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.', status: 404 },
    { ...PAYPAL_ORDER, id: 'ORDER0000000000002' },
    null,
  ];
  for (const reply of replies) {
    await assert.rejects(createOrderReader(fakeToolkit(async () => encode(reply)).toolkit)(ORDER_ID), OrderReadError, JSON.stringify(reply));
  }
  const notJson = fakeToolkit(async () => ({ content: [{ text: 'Failed to fetch order' }] })).toolkit;
  await assert.rejects(createOrderReader(notJson)(ORDER_ID), OrderReadError);
  const empty = fakeToolkit(async () => ({ content: [] })).toolkit;
  await assert.rejects(createOrderReader(empty)(ORDER_ID), OrderReadError);
});

test('a read that PayPal never answers fails after the time limit', async () => {
  const { toolkit } = fakeToolkit(() => new Promise(() => {}));
  await assert.rejects(createOrderReader(toolkit, 20)(ORDER_ID), /did not answer in time/);
});

test('no source file names any toolkit tool but get_order, and only this module loads the toolkit', () => {
  const bundle = readFileSync(fileURLToPath(new URL('../node_modules/@paypal/agent-toolkit/bedrock/index.js', import.meta.url)), 'utf8');
  const tools = new Set([...bundle.matchAll(/method: ?["']([a-z_]+)["']/g)].map((m) => m[1] ?? ''));
  assert.ok(tools.size >= 40 && tools.has('pay_order') && tools.has('create_refund'), 'the scan should find the toolkit tools, or it proves nothing');
  tools.delete(ORDER_TOOL);

  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'));
  const loaders: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const tool of tools) assert.ok(!source.includes(tool), `${file} names ${tool}`);
    if (source.includes('@paypal/agent-toolkit/')) loaders.push(relative(root, join(root, file)));
  }
  assert.deepEqual(loaders, ['paypal/order-record.ts']);
});

test('the check agrees when PayPal and this app match, and says so when they differ', () => {
  const app = contract({ milestones: [milestone('m1', 4000, 'CAPTURED', 'CAPTURE00000000001'), milestone('m2', 6000)] });
  const record = toOrderRecord(PAYPAL_ORDER, 'paypal') as OrderRecord;
  assert.deepEqual(checkRecord(record, app), { agrees: true, capturedCents: { paypal: 4000, app: 4000 }, holdOpen: { paypal: true, app: true } });

  // This app thinks nothing was captured.
  assert.equal(checkRecord(record, contract()).agrees, false);
  // PayPal shows the hold voided while this app still holds it.
  const voided = { ...record, authorizations: [{ ...record.authorizations[0], id: 'AUTH0000000000001', status: 'VOIDED' }] } as OrderRecord;
  assert.deepEqual(checkRecord(voided, app).holdOpen, { paypal: false, app: true });
  assert.equal(checkRecord(voided, app).agrees, false);
  // A different authorization from the one this app holds.
  assert.equal(checkRecord(record, { ...app, authorizationId: 'AUTH0000000000009' }).agrees, false);
  // An amount PayPal wrote in a form this check doesn't read is not assumed to match.
  const odd = { ...record, captures: [{ ...record.captures[0], amount: { currency_code: 'USD', value: '40' } }] } as OrderRecord;
  assert.equal(checkRecord(odd, app).capturedCents.paypal, null);
  assert.equal(checkRecord(odd, app).agrees, false);
});

test('a declined capture on PayPal does not count as money captured', () => {
  const declined = { ...PAYPAL_ORDER, purchase_units: [{ ...PAYPAL_ORDER.purchase_units[0], payments: { ...PAYPAL_ORDER.purchase_units[0]?.payments, captures: [{ id: 'CAPTURE00000000001', status: 'DECLINED', amount: { currency_code: 'USD', value: '40.00' } }] } }] };
  const record = toOrderRecord(declined, 'paypal') as OrderRecord;
  const app = contract({ milestones: [milestone('m1', 4000, 'DECLINED', 'CAPTURE00000000001'), milestone('m2', 6000)] });
  assert.deepEqual(checkRecord(record, app).capturedCents, { paypal: 0, app: 0 });
});

test('the recorded reply agrees with the app at every step, and is labelled recorded', () => {
  const held = contract();
  const steps: Contract[] = [
    held,
    { ...held, milestones: [milestone('m1', 4000, 'CAPTURED', 'CAP-1'), milestone('m2', 6000)] },
    { ...held, status: 'CLOSED', milestones: [milestone('m1', 4000, 'CAPTURED', 'CAP-1'), milestone('m2', 6000, 'CAPTURED', 'CAP-2')] },
    { ...held, status: 'VOIDED', milestones: [milestone('m1', 4000, 'CAPTURED', 'CAP-1'), milestone('m2', 6000)] },
  ];
  const auth = ['CREATED', 'PARTIALLY_CAPTURED', 'CAPTURED', 'VOIDED'];
  steps.forEach((step, i) => {
    const record = recordedOrder(step);
    assert.equal(record.source, 'recorded');
    assert.equal(record.authorizations[0]?.status, auth[i]);
    assert.equal(checkRecord(record, step).agrees, true, auth[i]);
  });
  assert.equal(recordedOrder(steps[2] as Contract).captures.at(-1)?.finalCapture, true);
});

test('the cache asks PayPal once per money state, shares a read in flight, and stops at the limit', async () => {
  let clock = 0;
  const reads: string[] = [];
  let answer: (() => void) | undefined;
  const records = cachedRecords(async (id) => {
    reads.push(id);
    await new Promise<void>((resolve) => { answer = resolve; });
    return toOrderRecord(PAYPAL_ORDER, 'paypal') as OrderRecord;
  }, { now: () => clock, maxPerMinute: 3 });

  const held = contract();
  const first = records(held);
  const second = records(held);
  answer?.();
  assert.equal(await first, await second);
  assert.equal(reads.length, 1);

  // A new money state reads again at once.
  const captured = { ...held, milestones: [milestone('m1', 4000, 'CAPTURED', 'CAP-1'), milestone('m2', 6000)] };
  const third = records(captured);
  answer?.();
  await third;
  assert.equal(reads.length, 2);

  // The same state reads again after 30 s, then the per-minute limit applies.
  clock = 31_000;
  const fourth = records(captured);
  answer?.();
  await fourth;
  assert.equal(reads.length, 3);
  clock = 59_000;
  await assert.rejects(records(held), /too many PayPal reads/);
  assert.equal(reads.length, 3);
});

test('a failed read is not kept, so the next request asks again', async () => {
  let fail = true;
  let reads = 0;
  const records = cachedRecords(async () => {
    reads += 1;
    if (fail) throw new OrderReadError('PayPal did not answer in time');
    return toOrderRecord(PAYPAL_ORDER, 'paypal') as OrderRecord;
  });
  await assert.rejects(records(contract()));
  fail = false;
  assert.equal((await records(contract())).record.orderId, ORDER_ID);
  assert.equal(reads, 2);
});
