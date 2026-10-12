import test from "node:test";
import assert from "node:assert/strict";
import { createIvanaEvmServer } from "../src/server.js";

function recorder(responses = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    const path = new URL(url).pathname;
    const body = responses[path] ?? { ok: true };
    return { ok: !body.error, status: body.error ? 409 : 200, text: async () => JSON.stringify(body) };
  };
  return { calls, fetch };
}

const input = () => ({
  paymentChain: "evm:84532",
  walletAddress: "0x1111111111111111111111111111111111111111",
  idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e",
  merchantReference: "order-42",
  customer: { name: "Ada", email: "ada@example.com" },
  lineItems: [{ title: "Ticket", unitPriceUsdc: 5, quantity: 1 }],
});

test("creates an intent with the tenant key, on the EVM route, paying in USDC", async () => {
  const { calls, fetch } = recorder();
  const ivana = createIvanaEvmServer({ apiKey: "key", baseUrl: "https://ivana.example/api", fetch });
  await ivana.createPaymentIntent(input());
  assert.equal(calls[0].url, "https://ivana.example/api/webthree/evm/payment-intents");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-tenant-api-key"], "key");
  assert.equal(calls[0].body.paymentMethod, "USDC");
  assert.equal(calls[0].body.paymentChain, "evm:84532");
});

test("refuses bad input before calling IVANA", async () => {
  const { calls, fetch } = recorder();
  const ivana = createIvanaEvmServer({ apiKey: "key", fetch });
  for (const [patch, pattern] of [
    [{ paymentChain: "solana" }, /paymentChain/],
    [{ walletAddress: "So1anaAddress" }, /walletAddress/],
    [{ idempotencyKey: "short" }, /idempotencyKey/],
    [{ merchantReference: "" }, /merchantReference/],
    [{ customer: null }, /customer/],
    [{ lineItems: [] }, /lineItems/],
  ]) {
    await assert.rejects(ivana.createPaymentIntent({ ...input(), ...patch }), pattern);
  }
  assert.equal(calls.length, 0);
});

test("status, verify, chains and the settlement feed use the EVM routes", async () => {
  const { calls, fetch } = recorder();
  const ivana = createIvanaEvmServer({ apiKey: "key", baseUrl: "https://ivana.example/api", fetch });
  const id = "evm:84532:abc";
  await ivana.getPaymentStatus(id);
  await ivana.verifyPayment(id, "0xhash");
  await ivana.listChains();
  await ivana.listSettlementEvents({ after: "7" });
  await ivana.acknowledgeSettlementEvent("evm-event:x");
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`), [
    "GET /api/webthree/evm/payment-intents/evm%3A84532%3Aabc",
    "POST /api/webthree/evm/payment-intents/evm%3A84532%3Aabc/verify",
    "GET /api/webthree/evm/chains",
    "GET /api/webthree/evm/settlement-events?after=7",
    "POST /api/webthree/evm/settlement-events/evm-event%3Ax/ack",
  ]);
  assert.deepEqual(calls[1].body, { signature: "0xhash" });
  await assert.rejects(ivana.listSettlementEvents({ after: "x;y" }), /cursor/);
  await assert.rejects(ivana.getPaymentStatus(""), /intentId/);
  await assert.rejects(ivana.acknowledgeSettlementEvent(""), /eventId/);
});

test("IVANA's errors come back as IvanaError with the code", async () => {
  const { fetch } = recorder({ "/api/webthree/evm/payment-intents": { error: { code: "PAYMENT_IN_PROGRESS", message: "already open" } } });
  const ivana = createIvanaEvmServer({ apiKey: "key", fetch });
  await assert.rejects(ivana.createPaymentIntent(input()), (e) => e.name === "IvanaError" && e.code === "PAYMENT_IN_PROGRESS" && e.status === 409);
});

test("refuses to run in a browser, where the tenant key would be exposed", () => {
  globalThis.window = {};
  globalThis.document = {};
  try {
    assert.throws(() => createIvanaEvmServer({ apiKey: "key", fetch: async () => {} }), /backend only/);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
  assert.throws(() => createIvanaEvmServer({}), /apiKey/);
});
