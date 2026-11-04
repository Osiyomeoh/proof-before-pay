// Sample mode: answers like PayPal with no network call and no keys, so anyone can run the app.
// Reply shapes follow the real sandbox run (spike/sandbox-run-result.json), and every ID starts
// with RECORDED so it can't be mistaken for a real PayPal record. No money exists here.
import type { Authorization, Capture, PayPalClient } from './client.ts';

const HOLD_DAYS = 29; // measured in spike/SPIKE-PAYPAL.md: expiry about 29 days after creation

export function createRecordedPayPal(now: () => number = Date.now): PayPalClient {
  let next = 0;
  const id = (kind: string) => `RECORDED-${kind}-${++next}`;
  const captures = new Map<string, Capture>();
  const expiry = () => new Date(now() + HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const authorization = (authId: string): Authorization => ({ id: authId, status: 'CREATED', amount: null, expiresAt: expiry(), debugId: null });

  return {
    async createAuthorizeOrder() {
      return { id: id('ORDER'), status: 'PAYER_ACTION_REQUIRED', approveUrl: null, debugId: null };
    },
    async authorizeOrder() {
      return authorization(id('AUTH'));
    },
    // Same request ID, same capture: the behaviour measured on the real sandbox.
    async capture(input) {
      const earlier = captures.get(input.requestId);
      if (earlier !== undefined) return earlier;
      const capture: Capture = { id: id('CAPTURE'), status: 'COMPLETED', amount: input.amount, finalCapture: input.finalCapture, debugId: null };
      captures.set(input.requestId, capture);
      return capture;
    },
    async voidAuthorization() {
      return { status: 'VOIDED', debugId: null };
    },
    async reauthorize() {
      return authorization(id('AUTH'));
    },
    async getAuthorization(authorizationId) {
      return authorization(authorizationId);
    },
  };
}
