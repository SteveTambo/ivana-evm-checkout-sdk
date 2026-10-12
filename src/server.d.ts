import type { EvmChain, EvmPaymentIntent, EvmPaymentStatus } from "./index";

export { IvanaError } from "./index";

export interface EvmLineItem {
  title: string;
  /** Net price per unit in USDC, two decimals, before VAT and the platform fee. */
  unitPriceUsdc: number;
  quantity: number;
  isConsignment?: boolean;
  /** Your catalogue's supplier id; IVANA maps it to the supplier's 0x address set in the dashboard. */
  supplierWallet?: string;
}

export interface IvanaEvmServer {
  listChains(): Promise<{
    merchantIdentity: string;
    chains: Array<EvmChain & { chain: string; ready: boolean; enabled: boolean }>;
  }>;
  createPaymentIntent(input: {
    /** e.g. "evm:84532" (Base Sepolia) or "evm:80002" (Polygon Amoy). */
    paymentChain: string;
    walletAddress: string;
    /** At least 16 characters; reuse it to retry a lost response. */
    idempotencyKey: string;
    merchantReference: string;
    customer: Record<string, unknown>;
    lineItems: EvmLineItem[];
  }): Promise<EvmPaymentIntent>;
  getPaymentStatus(intentId: string): Promise<EvmPaymentStatus>;
  verifyPayment(intentId: string, signature?: string): Promise<EvmPaymentStatus>;
  listSettlementEvents(options?: { after?: string }): Promise<{
    events: Array<{ id: string; cursor: string; intentId: string; status: string; [key: string]: unknown }>;
    hasMore: boolean;
  }>;
  acknowledgeSettlementEvent(eventId: string): Promise<{ success: true }>;
}

export function createIvanaEvmServer(options: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  allowBrowser?: boolean;
}): IvanaEvmServer;
