import test from "node:test";
import assert from "node:assert/strict";
import { payIntent, memoryStore } from "../src/checkout.js";
import { fakeWallet, intent, statusFrom, BUYER } from "./helpers.js";

const fast = { pollMs: 1, receiptTimeoutMs: 200, settleTimeoutMs: 50 };

test("a wallet that supports atomic batches pays every share with one approval", async () => {
  const wallet = fakeWallet({ batch: "supported" });
  const result = await payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: statusFrom(wallet), store: memoryStore(), ...fast });
  assert.equal(result.status, "completed");
  assert.equal(wallet.calls.filter((c) => c.method === "wallet_sendCalls").length, 1);
  assert.equal(wallet.calls.some((c) => c.method === "eth_sendTransaction"), false);
});

test("a wallet without batching gets one transfer per share", async () => {
  for (const batch of ["unsupported", "ready", "throws"]) {
    const wallet = fakeWallet({ batch });
    await payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: statusFrom(wallet), store: memoryStore(), ...fast });
    assert.equal(wallet.calls.filter((c) => c.method === "eth_sendTransaction").length, 3, batch);
  }
});

test("a lost batch answer is recorded first, so the retry never sends a second batch", async () => {
  const wallet = fakeWallet({ batch: "supported" });
  const store = memoryStore();
  wallet.state.loseBatchAnswer = true;
  const pending = async () => ({ status: "pending", legs: null });
  await assert.rejects(payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: pending, store, ...fast }), /connection lost/);
  assert.deepEqual(store.load(intent().intentId).batch, {}, "the request is remembered");
  await assert.rejects(payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: pending, store, ...fast }), (e) => e.code === "BATCH_PENDING");
  assert.equal(wallet.calls.filter((c) => c.method === "wallet_sendCalls").length, 1, "never a second batch");
});

test("a saved batch reference is followed instead of paying again", async () => {
  const wallet = fakeWallet({ batch: "supported" });
  const store = memoryStore();
  store.save(intent().intentId, { sent: {}, batch: { id: "batch-1" } });
  let calls = 0;
  const getStatus = async () => (++calls === 1 ? { status: "pending", legs: null } : { status: "completed", success: true, signature: "0xb" });
  const result = await payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus, store, ...fast });
  assert.equal(result.status, "completed");
  assert.equal(wallet.calls.some((c) => c.method === "wallet_sendCalls"), false);
});

test("declining the batch clears the record, since nothing was sent", async () => {
  const wallet = fakeWallet({ batch: "supported" });
  const store = memoryStore();
  const original = wallet.request;
  wallet.request = async (args) => {
    if (args.method === "wallet_sendCalls") throw Object.assign(new Error("User rejected"), { code: 4001 });
    return original(args);
  };
  await assert.rejects(payIntent({ provider: wallet, intent: intent(), account: BUYER, getStatus: async () => ({ status: "pending" }), store, ...fast }), /rejected/);
  assert.equal(store.load(intent().intentId).batch, undefined);
});
