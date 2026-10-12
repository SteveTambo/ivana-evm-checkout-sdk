export class IvanaError extends Error {
  name: "IvanaError";
  /** HTTP status, when the error came from the API. */
  status?: number;
  /** Machine-readable code, e.g. INSUFFICIENT_USDC, WRONG_NETWORK, BATCH_PENDING. */
  code?: string;
  details?: unknown;
  /** True when the failure happened before anything reached the wallet: no money moved. */
  notSent?: boolean;
}

/** An EIP-1193 provider, e.g. Phantom's `window.phantom.ethereum`. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
}

export interface EvmWallet {
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193Provider;
  /** Phantom is listed first. */
  phantom: boolean;
}

export interface EvmChain {
  chain?: string;
  chainId: number;
  name?: string;
  rpcUrl?: string;
  explorerUrl?: string | null;
  tokenIdentifier?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  testnet?: boolean;
}

export interface EvmTransfer {
  to: string;
  amountUnits: string;
}

/** The intent your backend got from IVANA (createPaymentIntent) and passed to the page. */
export interface EvmPaymentIntent {
  intentId: string;
  chain: string;
  chainId: number;
  name?: string;
  payer: string;
  tokenIdentifier: string;
  amountUnits: string;
  expiresAt: string;
  transfers: EvmTransfer[];
  breakdown: {
    netAmount: number;
    vatAmount: number;
    transactionFee: number;
    total: number;
    currency: "USDC";
    supplierAmounts?: Array<{ supplierWallet: string; amount: number }>;
  };
  [key: string]: unknown;
}

export interface EvmPaymentStatus {
  intentId?: string;
  status: "pending" | "confirming" | "completed" | "expired" | "superseded" | "underpaid" | string;
  success?: boolean;
  signature?: string | null;
  legs?: Array<{ paid: boolean; [key: string]: unknown }> | null;
  [key: string]: unknown;
}

export interface PaymentStore {
  load(intentId: string): { sent?: Record<string, string>; batch?: { id?: string } } | null;
  save(intentId: string, record: { sent: Record<string, string>; batch?: { id?: string } }): void;
  clear(intentId: string): void;
}

export function discoverWallets(options?: { waitMs?: number; window?: any }): Promise<EvmWallet[]>;
export function connectWallet(
  provider: Eip1193Provider,
  chain: EvmChain,
  options?: { pollMs?: number; attempts?: number },
): Promise<string>;
export function restoreAccount(provider: Eip1193Provider): Promise<string | null>;
export function walletChainId(provider: Eip1193Provider): Promise<number>;
export function checkFunds(
  provider: Eip1193Provider,
  chain: { tokenIdentifier: string; name?: string },
  account: string,
  neededUnits: bigint | string | number,
): Promise<{ usdcUnits: bigint; gasWei: bigint }>;
export function encodeTransfer(to: string, amountUnits: bigint | string | number): string;
export function encodeBalanceOf(owner: string): string;

export function payIntent(options: {
  provider: Eip1193Provider;
  intent: EvmPaymentIntent;
  account: string;
  /** Ask your backend, which calls IVANA's getPaymentStatus with your tenant key. */
  getStatus: (intentId: string, signature?: string) => Promise<EvmPaymentStatus>;
  store?: PaymentStore;
  onStage?: (stage: string) => void;
  /** Try one atomic wallet batch (EIP-5792) when the wallet supports it. Default true. */
  useBatch?: boolean;
  pollMs?: number;
  receiptTimeoutMs?: number;
  settleTimeoutMs?: number;
}): Promise<{ status: string; signature: string | null; hashes: string[] }>;

export function localStorageStore(storage?: Storage): PaymentStore;
export function memoryStore(): PaymentStore;
