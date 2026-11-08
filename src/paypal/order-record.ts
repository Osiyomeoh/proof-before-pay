// PayPal's own record of a hold, read with the get_order tool from PayPal's Agent Toolkit
// (@paypal/agent-toolkit). It checks this app's money state against PayPal's, and it can't move money.
//
// Read-only by construction. In toolkit 1.11.0 the allowed-actions setting only filters what
// getTools() lists: handleToolCall() runs any tool name it is given (checked on the sandbox with a
// disputes tool that was not enabled). So this module passes one fixed name and takes no tool name
// from a model, a browser or anywhere else. No AI is involved in this read.
import { randomUUID } from 'node:crypto';
import type { Contract, MilestoneStatus } from '../payments/service.ts';
import type { Money } from './client.ts';

export const ORDER_TOOL = 'get_order';
// The toolkit's own rule for an order ID (ORDER_ID_REGEX in 1.11.0). Checked here too, so nothing else reaches its URL.
const ORDER_ID = /^[A-Z0-9]{17,32}$/;
const TIMEOUT_MS = 10_000;

// The parts of the toolkit's Bedrock class this module uses.
export type OrderToolkit = {
  getTools(): ReadonlyArray<{ toolSpec: { name: string } }>;
  handleToolCall(call: { toolUseId: string; name: string; input: { id: string } }): Promise<{ content: ReadonlyArray<{ text: string }> }>;
  client: { getBaseUrl(): string };
};

export type RecordAuthorization = { id: string | null; status: string | null; amount: Money | null };
export type RecordCapture = { id: string | null; status: string | null; amount: Money | null; finalCapture: boolean | null };

// Only these fields leave this module. The reply also carries the buyer's name, email and
// payment source, and none of that is copied.
export type OrderRecord = {
  source: 'paypal' | 'recorded';
  tool: typeof ORDER_TOOL;
  orderId: string;
  intent: string | null;
  status: string | null;
  amount: Money | null;
  authorizations: RecordAuthorization[];
  captures: RecordCapture[];
  updatedAt: string | null;
};

export type RecordCheck = {
  agrees: boolean;
  capturedCents: { paypal: number | null; app: number };
  holdOpen: { paypal: boolean | null; app: boolean };
};

export class OrderReadError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function money(value: unknown): Money | null {
  if (!isObject(value)) return null;
  const code = text(value['currency_code']);
  const amount = text(value['value']);
  return code !== null && amount !== null ? { currency_code: code, value: amount } : null;
}

// Copies the allowed fields out of a PayPal order. Anything that isn't an order, such as the
// toolkit's error object, returns null.
export function toOrderRecord(raw: unknown, source: OrderRecord['source']): OrderRecord | null {
  if (!isObject(raw)) return null;
  const orderId = text(raw['id']);
  if (orderId === null || !ORDER_ID.test(orderId) && source === 'paypal') return null;
  const unit = list(raw['purchase_units'])[0];
  const payments = isObject(unit) && isObject(unit['payments']) ? unit['payments'] : {};
  return {
    source,
    tool: ORDER_TOOL,
    orderId,
    intent: text(raw['intent']),
    status: text(raw['status']),
    amount: isObject(unit) ? money(unit['amount']) : null,
    authorizations: list(payments['authorizations']).filter(isObject).map((a) => ({ id: text(a['id']), status: text(a['status']), amount: money(a['amount']) })),
    captures: list(payments['captures']).filter(isObject).map((c) => ({
      id: text(c['id']),
      status: text(c['status']),
      amount: money(c['amount']),
      finalCapture: typeof c['final_capture'] === 'boolean' ? c['final_capture'] : null,
    })),
    updatedAt: text(raw['update_time']),
  };
}

// The toolkit JSON-encodes its reply twice: once in run(), once in handleToolCall().
function unwrap(reply: { content: ReadonlyArray<{ text: string }> }): unknown {
  let value: unknown = reply.content[0]?.text ?? null;
  for (let i = 0; i < 2 && typeof value === 'string'; i += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

// Refuses a toolkit that offers anything but get_order, or that points anywhere but the sandbox.
export function createOrderReader(toolkit: OrderToolkit, timeoutMs = TIMEOUT_MS) {
  const names = toolkit.getTools().map((tool) => tool.toolSpec.name);
  if (names.length !== 1 || names[0] !== ORDER_TOOL) throw new Error(`the toolkit must offer only ${ORDER_TOOL}, not ${names.join(', ')}`);
  const host = new URL(toolkit.client.getBaseUrl()).hostname;
  if (!host.endsWith('.sandbox.paypal.com')) throw new Error(`the toolkit must use the PayPal sandbox, not ${host}`);

  return async function readOrder(orderId: string): Promise<OrderRecord> {
    if (!ORDER_ID.test(orderId)) throw new OrderReadError('not a PayPal order ID');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OrderReadError('PayPal did not answer in time')), timeoutMs);
    });
    try {
      const reply = await Promise.race([toolkit.handleToolCall({ toolUseId: randomUUID(), name: ORDER_TOOL, input: { id: orderId } }), timeout]);
      const record = toOrderRecord(unwrap(reply), 'paypal');
      // A PayPal error comes back as a normal tool result, so a reply that isn't this order is a failure.
      if (record === null || record.orderId !== orderId) throw new OrderReadError('PayPal did not return this order');
      return record;
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function loadPayPalToolkit(clientId: string, clientSecret: string): Promise<OrderToolkit> {
  const { PayPalAgentToolkit } = await import('@paypal/agent-toolkit/bedrock');
  return new PayPalAgentToolkit({
    clientId,
    clientSecret,
    configuration: { actions: { orders: { get: true } }, context: { sandbox: true } },
  });
}

// Sample mode: a reply in get_order's shape, built from this app's own state and labelled recorded.
// Statuses are the ones the real sandbox returned (spike/sandbox-run-result.json,
// and a toolkit read on 2026-11-06): order COMPLETED once authorized; authorization CREATED,
// PARTIALLY_CAPTURED, CAPTURED or VOIDED; capture COMPLETED.
const CAPTURE_STATUS: Partial<Record<MilestoneStatus, string>> = { CAPTURED: 'COMPLETED', PENDING: 'PENDING', REFUNDED: 'REFUNDED', REVERSED: 'REVERSED' };

export function recordedOrder(contract: Contract): OrderRecord {
  const value = (cents: number) => ({ currency_code: contract.currency, value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` });
  const captured = contract.milestones.filter((m) => m.captureId !== null && CAPTURE_STATUS[m.status] !== undefined);
  const authStatus = contract.status === 'VOIDED' ? 'VOIDED' : contract.status === 'CLOSED' ? 'CAPTURED' : captured.length > 0 ? 'PARTIALLY_CAPTURED' : 'CREATED';
  const raw = {
    id: contract.orderId,
    intent: 'AUTHORIZE',
    status: contract.authorizationId === null ? 'PAYER_ACTION_REQUIRED' : 'COMPLETED',
    purchase_units: [{
      amount: value(contract.totalCents),
      payments: {
        authorizations: contract.authorizationId === null ? [] : [{ id: contract.authorizationId, status: authStatus, amount: value(contract.totalCents) }],
        // A metered week never captures as final (src/payments/service.ts, isFinalCapture).
        captures: captured.map((m) => ({ id: m.captureId, status: CAPTURE_STATUS[m.status], amount: value(m.amountCents), final_capture: contract.status === 'CLOSED' && m.metering === null && m === captured.at(-1) })),
      },
    }],
  };
  return toOrderRecord(raw, 'recorded') as OrderRecord;
}

// Each page asks again whenever its money state changes. PayPal is asked at most once per state
// every 30 s, a second request for the same state shares the one in flight, and the whole demo makes
// at most 30 PayPal reads a minute.
export type TimedRecord = { record: OrderRecord; readAt: string };

export function cachedRecords(read: (orderId: string) => Promise<OrderRecord>, options: { now?: () => number; ttlMs?: number; maxPerMinute?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  const maxPerMinute = options.maxPerMinute ?? 30;
  const cache = new Map<string, { key: string; at: number; record: Promise<TimedRecord> }>();
  let window = { minute: 0, count: 0 };

  return function recordFor(contract: Contract): Promise<TimedRecord> {
    const key = JSON.stringify([contract.status, contract.authorizationId, contract.milestones.map((m) => [m.status, m.captureId])]);
    const hit = cache.get(contract.id);
    if (hit !== undefined && hit.key === key && now() - hit.at < ttlMs) return hit.record;
    const minute = Math.floor(now() / 60_000);
    if (window.minute !== minute) window = { minute, count: 0 };
    if (window.count >= maxPerMinute) return Promise.reject(new OrderReadError('too many PayPal reads this minute'));
    window.count += 1;
    const record = read(contract.orderId).then((found) => ({ record: found, readAt: new Date(now()).toISOString() }));
    cache.set(contract.id, { key, at: now(), record });
    // A failed read isn't kept, so the next request tries again.
    record.catch(() => {
      if (cache.get(contract.id)?.record === record) cache.delete(contract.id);
    });
    return record;
  };
}

const toCents = (amount: Money | null): number | null => {
  const match = amount?.value.match(/^(\d+)\.(\d{2})$/);
  return match ? Number(match[1]) * 100 + Number(match[2]) : null;
};

const APP_CAPTURED: readonly MilestoneStatus[] = ['CAPTURED', 'PENDING'];
const PAYPAL_CAPTURED = ['COMPLETED', 'PENDING'];
const PAYPAL_OPEN = ['CREATED', 'PARTIALLY_CAPTURED', 'PENDING'];

// Compares PayPal's record with this app's: money captured so far, and whether the hold is still open.
export function checkRecord(record: OrderRecord, contract: Contract): RecordCheck {
  const app = contract.milestones.filter((m) => APP_CAPTURED.includes(m.status)).reduce((sum, m) => sum + m.amountCents, 0);
  const amounts = record.captures.filter((c) => c.status !== null && PAYPAL_CAPTURED.includes(c.status)).map((c) => toCents(c.amount));
  const paypal = amounts.some((cents) => cents === null) ? null : amounts.reduce<number>((sum, cents) => sum + (cents ?? 0), 0);
  // After a reauthorization the order lists more than one, and the one in use is ours.
  const auth = record.authorizations.find((a) => a.id === contract.authorizationId) ?? null;
  const paypalOpen = auth === null || auth.status === null ? null : PAYPAL_OPEN.includes(auth.status);
  const appOpen = contract.status === 'HELD';
  const holdKnown = contract.authorizationId === null ? record.authorizations.length === 0 : paypalOpen === appOpen;
  return { agrees: paypal === app && holdKnown, capturedCents: { paypal, app }, holdOpen: { paypal: paypalOpen, app: appOpen } };
}
