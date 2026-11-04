// A recording stand-in for PayPal's HTTP API. It copies the documented repeat-request behaviour
// (same PayPal-Request-Id returns the earlier result) and the response shapes from the sandbox
// spike. It proves our logic only. What PayPal itself does is proven by scripts/sandbox-run.ts.
export type Recorded = { method: string; path: string; requestId: string | null; body: unknown; authorization: string | null };

export type FakeReply = { status: number; body?: unknown; headers?: Record<string, string> };

export function createFakePayPal() {
  const calls: Recorded[] = [];
  const seen = new Map<string, FakeReply>();
  const invoices = new Set<string>();
  const overrides: Array<(call: Recorded) => FakeReply | 'NETWORK_ERROR' | null> = [];
  let counter = 0;
  let tokensIssued = 0;

  const json = (reply: FakeReply) =>
    new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'paypal-debug-id': `debug-${++counter}`, ...reply.headers },
    });

  function respond(call: Recorded): FakeReply {
    const id = `ID${++counter}`;
    const end = call.path.split('/').pop();
    if (call.path === '/v2/checkout/orders') {
      return { status: 200, body: { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://sandbox.paypal.com/checkoutnow?token=${id}` }] } };
    }
    if (end === 'authorize') {
      return {
        status: 201,
        body: { id: 'ORDER', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: `AUTH${counter}`, status: 'CREATED', amount: { currency_code: 'USD', value: '100.00' }, expiration_time: '2026-12-03T00:00:00Z' }] } }] },
      };
    }
    if (end === 'capture') {
      const body = call.body as { amount: unknown; final_capture: boolean };
      return { status: 201, body: { id: `CAP${counter}`, status: 'COMPLETED', amount: body.amount, final_capture: body.final_capture } };
    }
    if (end === 'void') return { status: 200, body: { id: 'AUTH', status: 'VOIDED' } };
    if (end === 'reauthorize') return { status: 201, body: { id: `REAUTH${counter}`, status: 'CREATED', expiration_time: '2026-12-10T00:00:00Z' } };
    return { status: 200, body: { id: end, status: 'CREATED' } };
  }

  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === '/v1/oauth2/token') {
      tokensIssued += 1;
      return json({ status: 200, body: { access_token: `token-${tokensIssued}`, expires_in: 3600 } });
    }
    const call: Recorded = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      requestId: headers.get('paypal-request-id'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: headers.get('authorization'),
    };
    calls.push(call);
    // Real sandbox result: a repeated invoice ID on a new request ID gets DUPLICATE_TRANSACTION
    // (spike/sandbox-run-result.json). That run repeated a completed capture's invoice. This fake
    // applies the rule to every earlier attempt, the stricter reading, since a declined one wasn't tested.
    const invoice = call.path.endsWith('/capture') ? (call.body as { invoice_id?: string }).invoice_id : undefined;
    const repeatInvoice = invoice !== undefined && invoices.has(invoice);
    if (invoice !== undefined) invoices.add(invoice);
    for (const override of overrides) {
      const reply = override(call);
      if (reply === 'NETWORK_ERROR') throw new TypeError('fetch failed');
      if (reply !== null) return json(reply);
    }
    const key = call.requestId === null ? null : `${call.path}|${call.requestId}`;
    const earlier = key === null ? undefined : seen.get(key);
    if (earlier !== undefined) return json(earlier);
    if (repeatInvoice) return json({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'DUPLICATE_TRANSACTION' }] } });
    const reply = respond(call);
    if (key !== null) seen.set(key, reply);
    return json(reply);
  }) as typeof fetch;

  return {
    fetch: fetchFake,
    calls,
    captures: () => calls.filter((call) => call.path.endsWith('/capture')),
    tokensIssued: () => tokensIssued,
    // Runs once per call, before the default reply. Return null to pass the call through.
    override: (fn: (call: Recorded) => FakeReply | 'NETWORK_ERROR' | null) => {
      overrides.length = 0;
      overrides.push(fn);
    },
    clearOverride: () => {
      overrides.length = 0;
    },
    // Remember the reply for an ID that "went through" even though the caller never saw it.
    remember: (path: string, requestId: string, reply: FakeReply) => seen.set(`${path}|${requestId}`, reply),
  };
}
