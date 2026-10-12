/**
 * Paying an IVANA EVM intent from the buyer's wallet. The intent lists the exact
 * USDC transfers to send (the merchant, any supplier, VAT and the platform fee).
 * Each is a plain ERC-20 transfer: no contract, no allowance. IVANA confirms them
 * from the token's own records.
 *
 * Rules that keep a buyer from paying twice:
 * - Only transfers IVANA does not already see as paid are sent.
 * - A transfer hash is saved the moment the wallet returns it, and a saved hash is
 *   waited on, not resent, unless its receipt shows it reverted (no money moved).
 * - A wallet batch (EIP-5792) is recorded before it is requested; if the answer is
 *   lost, the next attempt follows that batch and never sends another.
 * - Anything that fails before reaching the wallet is marked `notSent`.
 */

import { IvanaError } from "./http.js";
import { checkFunds, encodeTransfer, nothingSent, walletChainId } from "./wallet.js";
import { localStorageStore } from "./store.js";

const BATCH_UNSUPPORTED = [4200, -32601, 5700, 5710, 5740, 5750, 5760];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForReceipt(provider, hash, { pollMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) return receipt;
    await sleep(pollMs);
  }
  return null;
}
const reverted = (receipt) => receipt && BigInt(receipt.status ?? "0x1") === 0n;

async function followBatch(provider, id, { pollMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await provider.request({ method: "wallet_getCallsStatus", params: [id] });
    if (status?.status === 200) {
      const hashes = (status.receipts || []).map((r) => r.transactionHash).filter(Boolean);
      if (!hashes.length) throw new IvanaError("The wallet confirmed the payment without a receipt.", { code: "BATCH_NO_RECEIPT" });
      return hashes;
    }
    if (typeof status?.status === "number" && status.status >= 400) {
      throw new IvanaError("The wallet could not complete the payment. Nothing was paid.", { code: "BATCH_FAILED" });
    }
    await sleep(pollMs);
  }
  throw new IvanaError("The payment is still confirming. Do not pay again; check it again shortly.", { code: "STILL_CONFIRMING" });
}

/**
 * Pays every transfer of `intent` that IVANA does not already see as paid, then
 * waits for IVANA to report the payment complete.
 *
 * @param {{
 *   provider: any,
 *   intent: { intentId: string, chainId: number, payer: string, tokenIdentifier: string, expiresAt: string, transfers: Array<{ to: string, amountUnits: string }>, name?: string },
 *   account: string,
 *   getStatus: (intentId: string, signature?: string) => Promise<{ status: string, success?: boolean, signature?: string|null, legs?: Array<{ paid: boolean }>|null }>,
 *   store?: { load: Function, save: Function, clear: Function },
 *   onStage?: (stage: string) => void,
 *   useBatch?: boolean,
 *   pollMs?: number,
 *   receiptTimeoutMs?: number,
 *   settleTimeoutMs?: number,
 * }} options
 * @returns {Promise<{ status: string, signature: string|null, hashes: string[] }>}
 */
export async function payIntent({
  provider,
  intent,
  account,
  getStatus,
  store = localStorageStore(),
  onStage = () => {},
  useBatch = true,
  pollMs = 2000,
  receiptTimeoutMs = 180000,
  settleTimeoutMs = 120000,
}) {
  if (typeof getStatus !== "function") {
    throw new IvanaError("getStatus is required: ask your backend, which asks IVANA with your tenant key.", { code: "INVALID_CONFIG" });
  }
  const timing = { pollMs, timeoutMs: receiptTimeoutMs };
  const id = intent.intentId;
  const record = store.load(id) || { sent: {} };
  record.sent ||= {};
  const save = () => store.save(id, record);

  onStage("Checking the payment");
  let status = await getStatus(id);
  if (status?.status === "completed" && status.success !== false) {
    store.clear(id);
    return { status: "completed", signature: status.signature ?? null, hashes: [] };
  }
  if (["expired", "superseded", "underpaid"].includes(status?.status)) {
    throw nothingSent(
      status.status === "underpaid"
        ? "This payment was only partly made, or arrived after it expired. It is held for a refund; do not pay again."
        : "This payment has expired. Ask for a new one.",
      status.status === "underpaid" ? "PAYMENT_HELD" : "INTENT_EXPIRED",
    );
  }
  const unpaid = intent.transfers.map((_, index) => index).filter((index) => !status?.legs?.[index]?.paid);

  // A batch already requested from this browser is followed, never sent again.
  if (record.batch && unpaid.length) {
    if (!record.batch.id) {
      throw new IvanaError("The wallet may still be processing an earlier payment request. Do not pay again; check it again shortly.", { code: "BATCH_PENDING" });
    }
    onStage("Waiting for your payment to confirm");
    const hashes = await followBatch(provider, record.batch.id, timing);
    unpaid.forEach((index) => (record.sent[index] = hashes[0]));
    save();
    return settle({ hashes });
  }

  if (unpaid.length) {
    if (Date.parse(intent.expiresAt) <= Date.now()) throw nothingSent("This payment has expired. Ask for a new one.", "INTENT_EXPIRED");
    if ((await walletChainId(provider)) !== intent.chainId) {
      throw nothingSent("The wallet is on a different network than this payment.", "WRONG_NETWORK");
    }
    if (account.toLowerCase() !== intent.payer.toLowerCase()) {
      throw nothingSent("This payment belongs to a different wallet account.", "WRONG_ACCOUNT");
    }
    // Only what still has to leave the wallet: hashes saved here may already have moved money.
    const owed = unpaid.filter((index) => !record.sent[index]).reduce((sum, index) => sum + BigInt(intent.transfers[index].amountUnits), 0n);
    if (owed > 0n) await checkFunds(provider, intent, account, owed);
  }

  const hashes = [];
  if (useBatch && unpaid.length > 1 && unpaid.every((index) => !record.sent[index])) {
    const batched = await tryBatch(unpaid);
    if (batched) return settle({ hashes: batched });
  }
  for (const [position, index] of unpaid.entries()) {
    const label = `${position + 1} of ${unpaid.length}`;
    const earlier = record.sent[index];
    if (earlier) {
      onStage(`Waiting for payment ${label} to confirm`);
      const receipt = await waitForReceipt(provider, earlier, timing);
      if (!receipt) throw new IvanaError("A payment is still confirming. Do not pay again; check it again shortly.", { code: "STILL_CONFIRMING" });
      if (!reverted(receipt)) {
        hashes.push(earlier);
        continue;
      }
      // Reverted: it moved no money, so pay this leg again below.
      delete record.sent[index];
      save();
    }
    if ((await walletChainId(provider)) !== intent.chainId) {
      throw new IvanaError("The wallet changed network during the payment.", { code: "WRONG_NETWORK" });
    }
    onStage(`Confirm payment ${label} in your wallet`);
    const { to, amountUnits } = intent.transfers[index];
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: account, to: intent.tokenIdentifier, data: encodeTransfer(to, amountUnits), value: "0x0" }],
    });
    record.sent[index] = hash;
    save();
    onStage(`Waiting for payment ${label} to confirm`);
    const receipt = await waitForReceipt(provider, hash, timing);
    if (!receipt) throw new IvanaError("A payment is still confirming. Do not pay again; check it again shortly.", { code: "STILL_CONFIRMING" });
    if (reverted(receipt)) {
      throw new IvanaError("A transfer failed on chain and moved no money. Try again to resend it.", { code: "TRANSFER_REVERTED" });
    }
    hashes.push(hash);
  }
  return settle({ hashes });

  async function tryBatch(legs) {
    const chainIdHex = `0x${intent.chainId.toString(16)}`;
    let atomic;
    try {
      const capabilities = await provider.request({ method: "wallet_getCapabilities", params: [account, [chainIdHex]] });
      atomic = capabilities?.[chainIdHex]?.atomic?.status;
    } catch {
      return null;
    }
    // "ready" would ask the buyer to upgrade their account first; plain transfers instead.
    if (atomic !== "supported") return null;
    onStage("Confirm the payment in your wallet");
    record.batch = {};
    save(); // before the request, so a lost answer is never paid twice
    let started;
    try {
      started = await provider.request({
        method: "wallet_sendCalls",
        params: [{
          version: "2.0.0", chainId: chainIdHex, from: account, atomicRequired: true,
          calls: legs.map((index) => ({ to: intent.tokenIdentifier, value: "0x0", data: encodeTransfer(intent.transfers[index].to, intent.transfers[index].amountUnits) })),
        }],
      });
    } catch (error) {
      // Refused or not supported: nothing was sent, so the record can go.
      if (BATCH_UNSUPPORTED.includes(error?.code) || error?.code === 4001) {
        delete record.batch;
        save();
      }
      if (BATCH_UNSUPPORTED.includes(error?.code)) return null;
      throw error;
    }
    const batchId = typeof started === "string" ? started : started?.id;
    if (!batchId) throw new IvanaError("The wallet did not return a payment reference.", { code: "BATCH_NO_ID" });
    record.batch = { id: batchId };
    save();
    onStage("Waiting for your payment to confirm");
    const sent = await followBatch(provider, batchId, timing);
    legs.forEach((index) => (record.sent[index] = sent[0]));
    save();
    return sent;
  }

  async function settle({ hashes: sentHashes }) {
    onStage("Checking payment and settlement");
    const deadline = Date.now() + settleTimeoutMs;
    for (;;) {
      status = await getStatus(id, sentHashes[0]);
      if (status?.status === "completed" && status.success !== false) {
        store.clear(id);
        return { status: "completed", signature: status.signature ?? sentHashes[0] ?? null, hashes: sentHashes };
      }
      if (Date.now() >= deadline) return { status: status?.status || "pending", signature: sentHashes[0] ?? null, hashes: sentHashes };
      await sleep(pollMs);
    }
  }
}
