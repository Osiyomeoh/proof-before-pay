// The money rules. This is the only module that captures, and every capture goes through
// release(), which recomputes the verdict on the server and needs a one-time tap token.
// The client never supplies a verdict, an amount or an authorization ID.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Verdict } from '../proof/engine.ts';
import { PayPalError } from '../paypal/client.ts';
import type { Capture, Money, PayPalClient } from '../paypal/client.ts';

export type MilestoneStatus =
  | 'WAITING'
  | 'CAPTURING'
  | 'CAPTURE_UNKNOWN'
  | 'PENDING'
  | 'CAPTURED'
  | 'DECLINED'
  | 'REFUNDED'
  | 'REVERSED';

export type Milestone = {
  id: string;
  title: string;
  amountCents: number;
  unitId: string;
  proofDate: string;
  status: MilestoneStatus;
  captureRequestId: string;
  captureAttempt: number;
  captureId: string | null;
  debugId: string | null;
  lastError: string | null;
};

export type ContractStatus = 'AWAITING_APPROVAL' | 'HELD' | 'VOIDED' | 'CLOSED';

export type TimelineEntry = {
  at: string;
  source: 'app' | 'paypal' | 'webhook';
  type: string;
  milestoneId: string | null;
  debugId: string | null;
};

export type Contract = {
  id: string;
  description: string;
  currency: string;
  totalCents: number;
  status: ContractStatus;
  orderId: string;
  approveUrl: string | null;
  authorizationId: string | null;
  authorizeRequestId: string;
  expiresAt: string | null;
  milestones: Milestone[];
  timeline: TimelineEntry[];
};

export type NewMilestone = Pick<Milestone, 'title' | 'amountCents' | 'unitId' | 'proofDate'>;
export type NewContract = {
  description: string;
  currency: string;
  milestones: NewMilestone[];
  returnUrl: string;
  cancelUrl: string;
};

export type Proof = (unitId: string, date: string) => Verdict;

export type ReleaseResult =
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'NOT_HELD'; contractStatus: ContractStatus }
  | { outcome: 'ALREADY_RELEASED'; milestone: Milestone }
  | { outcome: 'IN_PROGRESS' }
  | { outcome: 'LOCKED'; verdict: Verdict }
  | { outcome: 'TAP_REQUIRED' }
  | { outcome: 'CAPTURED' | 'PENDING' | 'DECLINED'; milestone: Milestone }
  | { outcome: 'REJECTED'; error: string; debugId: string | null }
  | { outcome: 'UNKNOWN'; error: string };

export type TapResult =
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'LOCKED'; verdict: Verdict }
  | { outcome: 'READY'; token: string; verdict: Verdict };

export type VoidResult =
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'NOT_HELD'; contractStatus: ContractStatus }
  | { outcome: 'TAP_REQUIRED' }
  | { outcome: 'VOIDED' }
  | { outcome: 'REJECTED' | 'UNKNOWN'; error: string };

export type WebhookResult = { applied: boolean; reason: 'APPLIED' | 'DUPLICATE' | 'IGNORED_TYPE' | 'UNMATCHED' | 'NO_CHANGE' };

const TAP_TTL_MS = 5 * 60 * 1000;

export function centsToValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`bad amount in cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// Moves a milestone only in directions that can really happen, so a late or repeated
// event can't undo a capture. A retry after a decline goes through release(), not here.
const CAN_MOVE: Record<MilestoneStatus, readonly MilestoneStatus[]> = {
  WAITING: ['PENDING', 'CAPTURED', 'DECLINED'],
  CAPTURING: ['PENDING', 'CAPTURED', 'DECLINED'],
  CAPTURE_UNKNOWN: ['PENDING', 'CAPTURED', 'DECLINED'],
  PENDING: ['CAPTURED', 'DECLINED', 'REFUNDED', 'REVERSED'],
  CAPTURED: ['REFUNDED', 'REVERSED'],
  DECLINED: [],
  REFUNDED: [],
  REVERSED: [],
};

// Only for an attempt known to have moved no money. The old request ID would just replay the
// failure, and PayPal refuses a repeated invoice ID with DUPLICATE_TRANSACTION (real sandbox run).
// A reply that never arrived keeps both IDs, so a retry of it can't capture twice.
function startNewAttempt(milestone: Milestone) {
  milestone.captureRequestId = randomUUID();
  milestone.captureAttempt += 1;
}

// A webhook can change the status during an await, which type narrowing can't see.
const current = (milestone: Milestone): MilestoneStatus => milestone.status;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const CAPTURE_EVENTS: Record<string, MilestoneStatus> = {
  'PAYMENT.CAPTURE.COMPLETED': 'CAPTURED',
  'PAYMENT.CAPTURE.PENDING': 'PENDING',
  'PAYMENT.CAPTURE.DECLINED': 'DECLINED',
  'PAYMENT.CAPTURE.DENIED': 'DECLINED',
  'PAYMENT.CAPTURE.REFUNDED': 'REFUNDED',
  'PAYMENT.CAPTURE.REVERSED': 'REVERSED',
};

const COUNTS_AGAINST_HOLD: readonly MilestoneStatus[] = ['CAPTURING', 'CAPTURE_UNKNOWN', 'PENDING', 'CAPTURED', 'REFUNDED', 'REVERSED'];
const DONE: readonly MilestoneStatus[] = ['PENDING', 'CAPTURED', 'REFUNDED', 'REVERSED'];

type Tap = { contractId: string; milestoneId: string | null; expiresAt: number };

export type PaymentsOptions = {
  paypal: PayPalClient;
  proof: Proof;
  now?: () => number;
};

export function createPayments(options: PaymentsOptions) {
  const { paypal, proof } = options;
  const now = options.now ?? Date.now;
  const contracts = new Map<string, Contract>();
  const taps = new Map<string, Tap>();
  const seenEvents = new Set<string>();

  function log(contract: Contract, source: TimelineEntry['source'], type: string, milestoneId: string | null, debugId: string | null) {
    contract.timeline.push({ at: new Date(now()).toISOString(), source, type, milestoneId, debugId });
  }

  const money = (contract: Contract, cents: number): Money => ({ currency_code: contract.currency, value: centsToValue(cents) });

  function issueTap(contractId: string, milestoneId: string | null): string {
    const token = randomBytes(32).toString('base64url');
    taps.set(token, { contractId, milestoneId, expiresAt: now() + TAP_TTL_MS });
    return token;
  }

  function takeTap(token: unknown, contractId: string, milestoneId: string | null): boolean {
    if (typeof token !== 'string') return false;
    const tap = taps.get(token);
    if (tap === undefined) return false;
    if (tap.contractId !== contractId || tap.milestoneId !== milestoneId || now() > tap.expiresAt) return false;
    taps.delete(token); // single use, so a replayed tap can't be spent twice
    return true;
  }

  function closeIfSettled(contract: Contract) {
    if (contract.status === 'HELD' && contract.milestones.every((m) => DONE.includes(m.status) && m.status !== 'PENDING')) {
      contract.status = 'CLOSED';
      log(contract, 'app', 'CONTRACT_CLOSED', null, null);
    }
  }

  function move(contract: Contract, milestone: Milestone, next: MilestoneStatus, source: TimelineEntry['source'], debugId: string | null): boolean {
    if (milestone.status === next || !CAN_MOVE[milestone.status].includes(next)) return false;
    milestone.status = next;
    if (next === 'DECLINED') startNewAttempt(milestone);
    log(contract, source, `CAPTURE_${next}`, milestone.id, debugId);
    closeIfSettled(contract);
    return true;
  }

  function fromCaptureStatus(status: string): MilestoneStatus | null {
    if (status === 'COMPLETED') return 'CAPTURED';
    if (status === 'PENDING') return 'PENDING';
    if (status === 'DECLINED' || status === 'FAILED') return 'DECLINED';
    if (status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') return 'REFUNDED';
    return null;
  }

  function isFinalCapture(contract: Contract, milestone: Milestone): boolean {
    return contract.milestones.every((m) => m.id === milestone.id || DONE.includes(m.status));
  }

  function findCaptureTarget(resource: Record<string, unknown>, next: MilestoneStatus): { contract: Contract; milestone: Milestone } | null {
    const links = Array.isArray(resource['links']) ? resource['links'] : [];
    const up = links.find((link) => isObject(link) && link['rel'] === 'up');
    const upHref = isObject(up) ? text(up['href']) : null;
    // A refund event's own id is the refund, so its capture is the `up` link.
    const parentCapture = upHref?.match(/\/captures\/([^/?]+)/)?.[1] ?? null;
    const ids = [text(resource['id']), parentCapture];
    const invoice = text(resource['invoice_id']);

    for (const contract of contracts.values()) {
      for (const milestone of contract.milestones) {
        if (milestone.captureId !== null && ids.includes(milestone.captureId)) return { contract, milestone };
        // The webhook can arrive before our capture call returns, when no capture ID is stored yet.
        // A decline can't match this way: it may belong to an earlier attempt, and marking the
        // milestone declined would allow a retry while the current capture is still running.
        const goodNews = next === 'CAPTURED' || next === 'PENDING';
        if (goodNews && invoice === invoiceFor(contract, milestone) && milestone.captureId === null) return { contract, milestone };
      }
    }
    return null;
  }

  const invoiceFor = (contract: Contract, milestone: Milestone) => `${contract.id}:${milestone.id}:${milestone.captureAttempt}`;

  return {
    async startHold(input: NewContract): Promise<Contract> {
      const totalCents = input.milestones.reduce((sum, m) => sum + m.amountCents, 0);
      if (input.milestones.length === 0 || input.milestones.some((m) => !Number.isSafeInteger(m.amountCents) || m.amountCents <= 0)) {
        throw new RangeError('a contract needs milestones with positive whole-cent amounts');
      }
      const id = randomUUID();
      const order = await paypal.createAuthorizeOrder({
        amount: { currency_code: input.currency, value: centsToValue(totalCents) },
        description: input.description,
        referenceId: id,
        returnUrl: input.returnUrl,
        cancelUrl: input.cancelUrl,
        requestId: randomUUID(),
      });
      const contract: Contract = {
        id,
        description: input.description,
        currency: input.currency,
        totalCents,
        status: 'AWAITING_APPROVAL',
        orderId: order.id,
        approveUrl: order.approveUrl,
        authorizationId: null,
        authorizeRequestId: randomUUID(),
        expiresAt: null,
        milestones: input.milestones.map((m, index) => ({
          ...m,
          id: `m${index + 1}`,
          status: 'WAITING',
          captureRequestId: randomUUID(), // stable, so a double tap can't capture twice
          captureAttempt: 1,
          captureId: null,
          debugId: null,
          lastError: null,
        })),
        timeline: [],
      };
      log(contract, 'paypal', 'ORDER_CREATED', null, order.debugId);
      contracts.set(id, contract);
      return contract;
    },

    // Runs after the buyer approves on PayPal. Nothing moves yet.
    async completeHold(contractId: string): Promise<Contract | null> {
      const contract = contracts.get(contractId);
      if (contract === undefined) return null;
      if (contract.status !== 'AWAITING_APPROVAL') return contract;
      const auth = await paypal.authorizeOrder(contract.orderId, contract.authorizeRequestId);
      contract.authorizationId = auth.id;
      contract.expiresAt = auth.expiresAt;
      contract.status = 'HELD';
      log(contract, 'paypal', 'HOLD_PLACED', null, auth.debugId);
      return contract;
    },

    get(contractId: string): Contract | null {
      return contracts.get(contractId) ?? null;
    },

    // Called when the Release button is shown. No token is issued unless the verdict is RELEASE_READY.
    prepareRelease(contractId: string, milestoneId: string): TapResult {
      const milestone = contracts.get(contractId)?.milestones.find((m) => m.id === milestoneId);
      if (milestone === undefined) return { outcome: 'NOT_FOUND' };
      const verdict = proof(milestone.unitId, milestone.proofDate);
      if (verdict.status !== 'RELEASE_READY') return { outcome: 'LOCKED', verdict };
      return { outcome: 'READY', token: issueTap(contractId, milestoneId), verdict };
    },

    prepareVoid(contractId: string): string | null {
      return contracts.has(contractId) ? issueTap(contractId, null) : null;
    },

    async release(contractId: string, milestoneId: string, tapToken: unknown): Promise<ReleaseResult> {
      const contract = contracts.get(contractId);
      const milestone = contract?.milestones.find((m) => m.id === milestoneId);
      if (contract === undefined || milestone === undefined) return { outcome: 'NOT_FOUND' };
      if (DONE.includes(milestone.status)) return { outcome: 'ALREADY_RELEASED', milestone };
      if (milestone.status === 'CAPTURING') return { outcome: 'IN_PROGRESS' };
      if (contract.status !== 'HELD' || contract.authorizationId === null) return { outcome: 'NOT_HELD', contractStatus: contract.status };

      // Recomputed on every tap, so a token issued while the verdict was good can't outlive it.
      const verdict = proof(milestone.unitId, milestone.proofDate);
      if (verdict.status !== 'RELEASE_READY') {
        log(contract, 'app', 'RELEASE_REFUSED_HOLD', milestone.id, null);
        return { outcome: 'LOCKED', verdict };
      }
      if (!takeTap(tapToken, contractId, milestoneId)) return { outcome: 'TAP_REQUIRED' };

      // No await between the checks above and this line, so a second tap sees CAPTURING.
      milestone.status = 'CAPTURING';
      milestone.captureId = null;
      milestone.lastError = null;
      log(contract, 'app', 'HUMAN_TAPPED_RELEASE', milestone.id, null);

      let capture: Capture;
      try {
        capture = await paypal.capture({
          authorizationId: contract.authorizationId,
          amount: money(contract, milestone.amountCents),
          finalCapture: isFinalCapture(contract, milestone),
          invoiceId: invoiceFor(contract, milestone),
          requestId: milestone.captureRequestId,
        });
      } catch (error) {
        const known = error instanceof PayPalError ? error : null;
        const message = known?.message ?? 'capture failed';
        milestone.lastError = message;
        milestone.debugId = known?.debugId ?? null;
        if (current(milestone) !== 'CAPTURING') {
          // A webhook already settled it while the call failed, and the webhook wins.
          return { outcome: 'UNKNOWN', error: message };
        }
        if (known?.definite === true) {
          milestone.status = 'WAITING';
          startNewAttempt(milestone);
          log(contract, 'paypal', 'CAPTURE_REJECTED', milestone.id, milestone.debugId);
          return { outcome: 'REJECTED', error: message, debugId: milestone.debugId };
        }
        // The money may have moved. Keep the request ID so a retry can't capture twice.
        milestone.status = 'CAPTURE_UNKNOWN';
        log(contract, 'paypal', 'CAPTURE_UNKNOWN', milestone.id, milestone.debugId);
        return { outcome: 'UNKNOWN', error: message };
      }

      milestone.captureId = capture.id;
      milestone.debugId = capture.debugId;
      const next = fromCaptureStatus(capture.status);
      if (next === null) {
        milestone.lastError = `unexpected capture status ${capture.status}`;
        if (current(milestone) === 'CAPTURING') milestone.status = 'CAPTURE_UNKNOWN';
        return { outcome: 'UNKNOWN', error: milestone.lastError };
      }
      move(contract, milestone, next, 'paypal', capture.debugId);
      const settled = current(milestone);
      if (settled === 'CAPTURED' || settled === 'PENDING' || settled === 'DECLINED') return { outcome: settled, milestone };
      return { outcome: 'UNKNOWN', error: `milestone is ${settled}` };
    },

    // Gives the rest of the hold back. It needs a tap but no verdict, because money only returns to the buyer.
    async voidHold(contractId: string, tapToken: unknown): Promise<VoidResult> {
      const contract = contracts.get(contractId);
      if (contract === undefined) return { outcome: 'NOT_FOUND' };
      if (contract.status !== 'HELD' || contract.authorizationId === null) return { outcome: 'NOT_HELD', contractStatus: contract.status };
      if (!takeTap(tapToken, contractId, null)) return { outcome: 'TAP_REQUIRED' };
      try {
        const result = await paypal.voidAuthorization(contract.authorizationId, randomUUID());
        contract.status = 'VOIDED';
        log(contract, 'paypal', 'HOLD_VOIDED', null, result.debugId);
        return { outcome: 'VOIDED' };
      } catch (error) {
        const known = error instanceof PayPalError ? error : null;
        return { outcome: known?.definite === true ? 'REJECTED' : 'UNKNOWN', error: known?.message ?? 'void failed' };
      }
    },

    // PayPal issues a new authorization ID here, and later captures must use that one.
    async reauthorizeHold(contractId: string): Promise<Contract | null> {
      const contract = contracts.get(contractId);
      if (contract === undefined || contract.status !== 'HELD' || contract.authorizationId === null) return null;
      const remaining = contract.milestones
        .filter((m) => !COUNTS_AGAINST_HOLD.includes(m.status))
        .reduce((sum, m) => sum + m.amountCents, 0);
      if (remaining === 0) return contract;
      const auth = await paypal.reauthorize(contract.authorizationId, money(contract, remaining), randomUUID());
      contract.authorizationId = auth.id;
      contract.expiresAt = auth.expiresAt;
      log(contract, 'paypal', 'HOLD_REAUTHORIZED', null, auth.debugId);
      return contract;
    },

    // Call only with an event whose signature has already been verified.
    applyWebhook(event: unknown): WebhookResult {
      if (!isObject(event)) return { applied: false, reason: 'UNMATCHED' };
      const eventId = text(event['id']);
      const type = text(event['event_type']);
      const resource = event['resource'];
      if (eventId !== null) {
        if (seenEvents.has(eventId)) return { applied: false, reason: 'DUPLICATE' };
        seenEvents.add(eventId);
      }
      if (type === null || !isObject(resource)) return { applied: false, reason: 'IGNORED_TYPE' };

      // PayPal has no separate expiry event: this one also covers the authorization reaching its limit.
      if (type === 'PAYMENT.AUTHORIZATION.VOIDED') {
        const authId = text(resource['id']);
        for (const contract of contracts.values()) {
          if (contract.authorizationId !== null && contract.authorizationId === authId) {
            if (contract.status !== 'HELD') return { applied: false, reason: 'NO_CHANGE' };
            contract.status = 'VOIDED';
            log(contract, 'webhook', 'HOLD_VOIDED_OR_EXPIRED', null, null);
            return { applied: true, reason: 'APPLIED' };
          }
        }
        return { applied: false, reason: 'UNMATCHED' };
      }

      const next = CAPTURE_EVENTS[type];
      if (next === undefined) return { applied: false, reason: 'IGNORED_TYPE' };
      const target = findCaptureTarget(resource, next);
      if (target === null) return { applied: false, reason: 'UNMATCHED' };
      const moved = move(target.contract, target.milestone, next, 'webhook', null);
      if (target.milestone.captureId === null && next !== 'REFUNDED' && next !== 'REVERSED') {
        target.milestone.captureId = text(resource['id']);
      }
      return moved ? { applied: true, reason: 'APPLIED' } : { applied: false, reason: 'NO_CHANGE' };
    },
  };
}

export type Payments = ReturnType<typeof createPayments>;
