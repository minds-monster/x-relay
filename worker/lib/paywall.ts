/**
 * x402 payment seam — deliberately inert in v1.
 *
 * When PAYMENTS_ENABLED is "true", this returns an HTTP 402 challenge that the Mind
 * side already knows how to satisfy: the `x402_Agent_Payment_Protocol` skill and
 * `Corbits_AgentPaymentBuyer` capture the challenge, sign an EIP-3009
 * `transferWithAuthorization` via `WALLET_Sign`, and retry with an `X-PAYMENT` header.
 *
 * So enabling crypto metering later is one env var plus one equipped skill, with zero
 * change to the Mind-facing contract in playbooks/x-relay-v1.md.
 *
 * IMPORTANT: what gets metered here is THIS RELAY'S SERVICE, not X API access. Metering
 * resold API access would put us inside the X Developer Agreement III.A(e) prohibition
 * on operating the API "on a service bureau, rental or managed services basis".
 * Each user's X costs are billed by X to that user's own developer account.
 *
 * Note the two distinct meanings of 402 in this codebase:
 *   relay_payment_required -> x402, this middleware
 *   x_credits_exhausted    -> the user's X prepaid credits ran out
 */
import type { Context, Next } from 'hono';
import type { AppEnv } from './auth.ts';

export interface X402Accept {
  scheme: 'exact';
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  description: string;
}

export interface X402Config {
  network: string;
  asset: string;
  payTo: string;
  priceAtomic: string;
  description: string;
}

export function paywall(config?: X402Config) {
  return async (c: Context<AppEnv>, next: Next): Promise<void | Response> => {
    if (c.env.PAYMENTS_ENABLED !== 'true') return next();

    const payment = c.req.header('x-payment');
    if (!payment) {
      const accepts: X402Accept[] = [
        {
          scheme: 'exact',
          network: config?.network ?? 'base',
          asset: config?.asset ?? '',
          maxAmountRequired: config?.priceAtomic ?? '0',
          payTo: config?.payTo ?? '',
          resource: new URL(c.req.url).pathname,
          description: config?.description ?? 'X Relay posting service fee',
        },
      ];
      return c.json(
        {
          ok: false,
          error: {
            code: 'relay_payment_required',
            message: 'Payment required for this relay service call.',
            retryable: true,
          },
          accepts,
        },
        402,
      );
    }

    // TODO(phase 2): verify and settle the EIP-3009 authorization with a facilitator
    // before allowing the request through. Failing closed until then is the safe
    // default — a paywall that trusts an unverified header is worse than no paywall.
    return c.json(
      {
        ok: false,
        error: {
          code: 'relay_payment_required',
          message:
            'X-PAYMENT verification is not implemented yet. Set PAYMENTS_ENABLED=false until phase 2 lands.',
          retryable: false,
        },
      },
      402,
    );
  };
}
