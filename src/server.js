/**
 * Server-side client for IVANA's EVM payments (USDC on Base and Polygon).
 *
 * It holds the tenant API key, so it runs on the merchant's backend only. Unlike
 * Solana checkout, every EVM call needs that key, including the payment status, so
 * the buyer's browser asks your backend for status and your backend asks IVANA
 * (see `getPaymentStatus`).
 */

import { IvanaError, normalizeBaseUrl, request } from "./http.js";

export { IvanaError } from "./http.js";

const EVM_CHAIN = /^evm:\d+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * @param {{ apiKey: string, baseUrl?: string, fetch?: typeof fetch, timeoutMs?: number, allowBrowser?: boolean }} options
 */
export function createIvanaEvmServer({ apiKey, baseUrl, fetch: fetchImpl, timeoutMs, allowBrowser = false }) {
  if (!apiKey || typeof apiKey !== "string") {
    throw new IvanaError("createIvanaEvmServer needs your tenant apiKey.", { code: "INVALID_CONFIG" });
  }
  if (!allowBrowser && typeof window !== "undefined" && typeof document !== "undefined") {
    throw new IvanaError(
      "createIvanaEvmServer runs on your backend only. Shipping the tenant API key to a browser exposes it.",
      { code: "INVALID_CONFIG" },
    );
  }
  const client = {
    baseUrl: normalizeBaseUrl(baseUrl),
    fetch: fetchImpl || globalThis.fetch,
    headers: { "x-tenant-api-key": apiKey },
    timeoutMs,
  };
  if (typeof client.fetch !== "function") {
    throw new IvanaError("No fetch implementation found. Pass one as options.fetch.", { code: "INVALID_CONFIG" });
  }
  const intentPath = (intentId) => {
    if (!intentId || typeof intentId !== "string") {
      throw new IvanaError("intentId is required.", { code: "INVALID_INPUT" });
    }
    return `/webthree/evm/payment-intents/${encodeURIComponent(intentId)}`;
  };
  const reject = (message) => Promise.reject(new IvanaError(message, { code: "INVALID_INPUT" }));

  return {
    /**
     * The networks this merchant can be paid on: Solana plus each EVM chain, with
     * whether it is ready (the merchant saved an EVM receiving address in IVANA).
     * An EVM entry carries what the browser needs to switch the wallet to it.
     */
    listChains() {
      return request(client, "GET", "/webthree/evm/chains");
    },

    /**
     * Price an order and open an EVM payment intent. IVANA works out VAT, the
     * platform fee and any supplier share from these line items, so send prices
     * from your own catalogue, never from the buyer's browser. The intent fixes the
     * exact USDC transfers the buyer sends, in order; hand it to the browser.
     *
     * Reuse the same `idempotencyKey` to retry a lost response: IVANA returns the
     * same intent rather than a second one.
     *
     * @param {{ paymentChain: string, walletAddress: string, idempotencyKey: string, merchantReference: string, customer: Record<string, unknown>, lineItems: Array<{ title: string, unitPriceUsdc: number, quantity: number, isConsignment?: boolean, supplierWallet?: string }> }} input
     */
    createPaymentIntent(input) {
      if (!EVM_CHAIN.test(input?.paymentChain || "")) return reject('paymentChain must look like "evm:84532".');
      if (!EVM_ADDRESS.test(input?.walletAddress || "")) return reject("walletAddress must be the buyer's 0x address.");
      if (typeof input?.idempotencyKey !== "string" || input.idempotencyKey.length < 16) {
        return reject("idempotencyKey must be a string of at least 16 characters (a UUID works).");
      }
      if (!input?.merchantReference) return reject("merchantReference is required.");
      if (!input?.customer || typeof input.customer !== "object") return reject("customer is required.");
      if (!Array.isArray(input?.lineItems) || input.lineItems.length === 0) {
        return reject("lineItems must be a non-empty array.");
      }
      return request(client, "POST", "/webthree/evm/payment-intents", { paymentMethod: "USDC", ...input });
    },

    /**
     * Where a payment stands: `pending`, `confirming` (every transfer seen, waiting
     * on finality), `completed`, `expired` (nothing paid; safe to quote again) or
     * `underpaid` (part paid or paid late; refund it, never fulfil it). `legs` says
     * which transfers the chain already shows as paid. Your browser checkout should
     * reach this through your backend.
     *
     * @param {string} intentId
     */
    getPaymentStatus(intentId) {
      try {
        return request(client, "GET", intentPath(intentId));
      } catch (error) {
        return Promise.reject(error);
      }
    },

    /**
     * Same as `getPaymentStatus`, optionally pointing IVANA at a transaction the
     * browser reported. IVANA still checks the chain itself.
     *
     * @param {string} intentId
     * @param {string} [signature]
     */
    verifyPayment(intentId, signature) {
      try {
        return request(client, "POST", `${intentPath(intentId)}/verify`, signature ? { signature } : {});
      } catch (error) {
        return Promise.reject(error);
      }
    },

    /**
     * Completed EVM payments, in order, for fulfilment that does not depend on the
     * buyer's browser. Store each event before acting on it, then acknowledge it;
     * anything not acknowledged is offered again.
     *
     * @param {{ after?: string }} [options]
     */
    listSettlementEvents({ after } = {}) {
      if (after !== undefined && !/^\d+$/.test(String(after))) return reject("after must be a cursor from a previous page.");
      return request(client, "GET", `/webthree/evm/settlement-events${after ? `?after=${after}` : ""}`);
    },

    /** @param {string} eventId */
    acknowledgeSettlementEvent(eventId) {
      if (!eventId) return reject("eventId is required.");
      return request(client, "POST", `/webthree/evm/settlement-events/${encodeURIComponent(eventId)}/ack`);
    },
  };
}
