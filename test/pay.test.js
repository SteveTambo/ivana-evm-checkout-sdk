import test from "node:test";
import assert from "node:assert/strict";
import { payIntent, memoryStore } from "../src/checkout.js";
import { fakeWallet, intent, statusFrom, BUYER, TOKEN } from "./helpers.js";

const fast = { pollMs: 1, receiptTimeoutMs: 200, settleTimeoutMs: 50 };

test("pays every transfer, merchant first, and returns once IVANA reports it complete", async () => {
  const wallet = fakeWallet();
  const stages = [];
  const result = await payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: statusFrom(wallet), store: memoryStore(), onStage: (s) => stages.push(s), ...fast });
  assert.equal(result.status, "completed");
  assert.deepEqual(wallet.state.sent.map((s) => s.amount), [5000000n, 800000n, 80000n]);
  const tx = wallet.calls.find((c) => c.method === "eth_sendTransaction").params[0];
  assert.equal(tx.to, TOKEN, "a plain token transfer, no contract of our own");
  assert.ok(stages.includes("Confirm payment 2 of 3 in your wallet"));
});

test("sends only the transfers IVANA does not already see as paid", async () => {
  const wallet = fakeWallet();
  const base = intent();
  let first = true;
  const getStatus = async (...args) => {
    if (first) {
      first = false;
      return { status: "pending", legs: [{ paid: true }, { paid: false }, { paid: false }] };
    }
    return statusFrom(wallet)(...args).then((s) => ({ ...s, status: "completed", success: true, signature: "0xdone" }));
  };
  await payIntent({ provider: wallet, intent: base, account: BUYER, getStatus, store: memoryStore(), ...fast });
  assert.deepEqual(wallet.state.sent.map((s) => s.amount), [800000n, 80000n]);
});

test("a saved transfer that went through is waited on, never sent again", async () => {
  const wallet = fakeWallet();
  const store = memoryStore();
  const base = intent();
  // A first attempt sent leg 0 and then the page reloaded.
  wallet.receipts.set("0xold", { status: "0x1" });
  store.save(base.intentId, { sent: { 0: "0xold" } });
  await payIntent({ provider: wallet, intent: base, account: BUYER, getStatus: async () => ({ status: "pending", legs: null }), store, ...fast });
  assert.deepEqual(wallet.state.sent.map((s) => s.amount), [800000n, 80000n]);
});

test("a saved transfer that reverted moved no money, so that leg is paid again", async () => {
  const wallet = fakeWallet();
  const store = memoryStore();
  const base = intent({ transfers: [intent().transfers[0]] });
  wallet.receipts.set("0xreverted", { status: "0x0" });
  store.save(base.intentId, { sent: { 0: "0xreverted" } });
  await payIntent({ provider: wallet, intent: base, account: BUYER, getStatus: async () => ({ status: "pending", legs: null }), store, ...fast });
  assert.deepEqual(wallet.state.sent.map((s) => s.amount), [5000000n]);
});

test("not enough USDC is reported before anything reaches the wallet", async () => {
  const wallet = fakeWallet({ usdc: 8_240_000n });
  const big = intent({ transfers: [{ to: "0x2222222222222222222222222222222222222222", amountUnits: "23520000" }] });
  await assert.rejects(
    payIntent({ provider: wallet, intent: big, account: BUYER, getStatus: async () => ({ status: "pending" }), store: memoryStore(), ...fast }),
    (error) => error.code === "INSUFFICIENT_USDC" && error.notSent === true && /8\.24 USDC on Base Sepolia/.test(error.message),
  );
  assert.equal(wallet.calls.some((c) => c.method === "eth_sendTransaction"), false);
});

test("no gas is reported before anything reaches the wallet", async () => {
  const wallet = fakeWallet({ gas: 0n });
  await assert.rejects(
    payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: async () => ({ status: "pending" }), store: memoryStore(), ...fast }),
    (error) => error.code === "NO_GAS" && error.notSent,
  );
});

test("an expired quote, the wrong network or the wrong account is refused before sending", async () => {
  const run = (wallet, base, account = BUYER) =>
    payIntent({ provider: wallet, intent: base, account, getStatus: async () => ({ status: "pending" }), store: memoryStore(), ...fast });
  await assert.rejects(run(fakeWallet(), intent({ expiresAt: new Date(Date.now() - 1000).toISOString() })), (e) => e.code === "INTENT_EXPIRED" && e.notSent);
  await assert.rejects(run(fakeWallet({ chainId: 80002 }), intent()), (e) => e.code === "WRONG_NETWORK" && e.notSent);
  await assert.rejects(run(fakeWallet(), intent(), "0x9999999999999999999999999999999999999999"), (e) => e.code === "WRONG_ACCOUNT" && e.notSent);
});

test("a held (underpaid) or expired payment is never paid again", async () => {
  for (const [status, code] of [["underpaid", "PAYMENT_HELD"], ["expired", "INTENT_EXPIRED"]]) {
    const wallet = fakeWallet();
    await assert.rejects(
      payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: async () => ({ status }), store: memoryStore(), ...fast }),
      (e) => e.code === code,
    );
    assert.equal(wallet.state.sent.length, 0);
  }
});

test("an already completed payment returns at once and clears the saved record", async () => {
  const wallet = fakeWallet();
  const store = memoryStore();
  store.save(intent().intentId, { sent: { 0: "0xa" } });
  const result = await payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: async () => ({ status: "completed", success: true, signature: "0xsig" }), store, ...fast });
  assert.deepEqual(result, { status: "completed", signature: "0xsig", hashes: [] });
  assert.equal(store.load(intent().intentId), null);
});

test("a transfer that reverts as it is sent is reported, and moved no money", async () => {
  const wallet = fakeWallet();
  wallet.state.revertNext = true;
  await assert.rejects(
    payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: async () => ({ status: "pending" }), store: memoryStore(), ...fast }),
    (e) => e.code === "TRANSFER_REVERTED",
  );
  assert.equal(wallet.state.usdc, 100_000_000n);
});

test("still waiting on IVANA after the transfers returns the current status, not an error", async () => {
  const wallet = fakeWallet();
  const result = await payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: async () => ({ status: "confirming" }), store: memoryStore(), ...fast });
  assert.equal(result.status, "confirming");
  assert.equal(result.hashes.length, 3);
});

test("getStatus is required, because only your backend may ask IVANA", async () => {
  await assert.rejects(payIntent({ provider: fakeWallet(), intent: intent(), account: BUYER }), (e) => e.code === "INVALID_CONFIG");
});
