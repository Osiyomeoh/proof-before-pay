// PayPal REST client. The host is fixed to the sandbox, and no config can point it at live.
// Bodies and response handling follow spike/SPIKE-PAYPAL.md and the v2 Orders and Payments docs.

export const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
const TIMEOUT_MS = 20_000;
const TOKEN_MARGIN_MS = 60_000;

export type Money = { currency_code: string; value: string };

export class PayPalError extends Error {
  readonly status: number | null;
  readonly debugId: string | null;
  // true: PayPal refused, or the request was never sent, so nothing happened.
  // false: the outcome is unknown, so a retry must reuse the same PayPal-Request-Id.
  readonly definite: boolean;

  constructor(message: string, status: number | null, debugId: string | null, definite: boolean) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.debugId = debugId;
    this.definite = definite;
  }
}

export type Order = { id: string; status: string; approveUrl: string | null; debugId: string | null };
export type Authorization = {
  id: string;
  status: string;
  amount: Money | null;
  expiresAt: string | null;
  debugId: string | null;
};
export type Capture = {
  id: string;
  status: string;
  amount: Money | null;
  finalCapture: boolean;
  debugId: string | null;
};

export type CreateOrderInput = {
  amount: Money;
  description: string;
  referenceId: string;
  returnUrl: string;
  cancelUrl: string;
  requestId: string;
};

export type CaptureInput = {
  authorizationId: string;
  amount: Money;
  finalCapture: boolean;
  invoiceId: string;
  requestId: string;
};

export type PayPalClient = {
  createAuthorizeOrder(input: CreateOrderInput): Promise<Order>;
  authorizeOrder(orderId: string, requestId: string): Promise<Authorization>;
  capture(input: CaptureInput): Promise<Capture>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<{ status: string; debugId: string | null }>;
  reauthorize(authorizationId: string, amount: Money, requestId: string): Promise<Authorization>;
  getAuthorization(authorizationId: string): Promise<Authorization>;
};

export type ClientOptions = {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
};

type Json = Record<string, unknown>;
type Reply = { status: number; body: Json; debugId: string | null };

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function money(value: unknown): Money | null {
  if (!isObject(value)) return null;
  const code = text(value['currency_code']);
  const amount = text(value['value']);
  return code !== null && amount !== null ? { currency_code: code, value: amount } : null;
}

function required(body: Json, field: string, what: string, debugId: string | null): string {
  const value = text(body[field]);
  // PayPal accepted the call, so the money may have moved: treat a malformed reply as unknown.
  if (value === null) throw new PayPalError(`${what} reply has no ${field}`, null, debugId, false);
  return value;
}

function toAuthorization(body: Json, debugId: string | null): Authorization {
  return {
    id: required(body, 'id', 'authorization', debugId),
    status: required(body, 'status', 'authorization', debugId),
    amount: money(body['amount']),
    expiresAt: text(body['expiration_time']),
    debugId,
  };
}

function describe(status: number, body: Json): string {
  const first = Array.isArray(body['details']) ? body['details'][0] : undefined;
  const issue = isObject(first) ? text(first['issue']) : null;
  const parts = [text(body['name']), issue, text(body['message'])].filter((part) => part !== null);
  return parts.length > 0 ? `PayPal ${status}: ${parts.join(' / ')}` : `PayPal ${status}`;
}

// A 4xx means PayPal refused, except 408, 409 and 429: there the first request may still be in flight.
const isDefiniteRefusal = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;

export function createPayPalClient(options: ClientOptions): PayPalClient {
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let token: { value: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (token !== null && now() < token.expiresAt) return token.value;
    const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await send(`${SANDBOX_API}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PayPalError('PayPal OAuth request failed', null, null, true);
    }
    const body: unknown = await res.json().catch(() => null);
    const value = isObject(body) ? text(body['access_token']) : null;
    if (!res.ok || value === null) {
      throw new PayPalError(`PayPal OAuth returned ${res.status}`, res.status, res.headers.get('paypal-debug-id'), true);
    }
    const expiresIn = isObject(body) && typeof body['expires_in'] === 'number' ? body['expires_in'] : 0;
    token = { value, expiresAt: now() + expiresIn * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  async function call(method: 'GET' | 'POST', path: string, payload: Json | undefined, requestId: string | null): Promise<Reply> {
    for (let attempt = 0; ; attempt += 1) {
      const bearer = await getToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      };
      if (requestId !== null) headers['PayPal-Request-Id'] = requestId;
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
      if (payload !== undefined) init.body = JSON.stringify(payload);

      let res: Response;
      try {
        res = await send(`${SANDBOX_API}${path}`, init);
      } catch {
        throw new PayPalError(`${method} ${path} got no reply`, null, null, false);
      }
      const debugId = res.headers.get('paypal-debug-id');
      const raw = await res.text().catch(() => '');
      let body: Json = {};
      try {
        const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
        if (isObject(parsed)) body = parsed;
      } catch {
        // a non-JSON reply falls through to the status handling below
      }

      if (res.status === 401 && attempt === 0) {
        token = null; // an expired token was refused before anything ran, so one retry is safe
        continue;
      }
      if (!res.ok) throw new PayPalError(describe(res.status, body), res.status, debugId, isDefiniteRefusal(res.status));
      return { status: res.status, body, debugId };
    }
  }

  return {
    async createAuthorizeOrder(input) {
      const { body, debugId } = await call(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'AUTHORIZE',
          purchase_units: [{ reference_id: input.referenceId, description: input.description, amount: input.amount }],
          payment_source: {
            paypal: {
              experience_context: { user_action: 'CONTINUE', return_url: input.returnUrl, cancel_url: input.cancelUrl },
            },
          },
        },
        input.requestId,
      );
      const links = Array.isArray(body['links']) ? body['links'] : [];
      const approve = links.find((link) => isObject(link) && (link['rel'] === 'payer-action' || link['rel'] === 'approve'));
      return {
        id: required(body, 'id', 'order', debugId),
        status: required(body, 'status', 'order', debugId),
        approveUrl: isObject(approve) ? text(approve['href']) : null,
        debugId,
      };
    },

    async authorizeOrder(orderId, requestId) {
      const { body, debugId } = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, requestId);
      const units = Array.isArray(body['purchase_units']) ? body['purchase_units'] : [];
      const payments = isObject(units[0]) ? units[0]['payments'] : undefined;
      const authorizations = isObject(payments) && Array.isArray(payments['authorizations']) ? payments['authorizations'] : [];
      const first: unknown = authorizations[0];
      if (!isObject(first)) throw new PayPalError('authorize reply has no authorization', null, debugId, false);
      return toAuthorization(first, debugId);
    },

    async capture(input) {
      const { body, debugId } = await call(
        'POST',
        `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/capture`,
        { amount: input.amount, final_capture: input.finalCapture, invoice_id: input.invoiceId },
        input.requestId,
      );
      return {
        id: required(body, 'id', 'capture', debugId),
        status: required(body, 'status', 'capture', debugId),
        amount: money(body['amount']),
        finalCapture: body['final_capture'] === true,
        debugId,
      };
    },

    async voidAuthorization(authorizationId, requestId) {
      const { body, debugId } = await call(
        'POST',
        `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
        undefined,
        requestId,
      );
      // The docs allow a 204 with no body, which still means the void succeeded.
      return { status: text(body['status']) ?? 'VOIDED', debugId };
    },

    async reauthorize(authorizationId, amount, requestId) {
      const { body, debugId } = await call(
        'POST',
        `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/reauthorize`,
        { amount },
        requestId,
      );
      return toAuthorization(body, debugId);
    },

    async getAuthorization(authorizationId) {
      const { body, debugId } = await call('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`, undefined, null);
      return toAuthorization(body, debugId);
    },
  };
}
