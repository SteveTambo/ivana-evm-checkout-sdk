// Minimal backend for EVM checkout: create an intent and proxy its status.
// IVANA_TENANT_API_KEY=... node examples/server.mjs
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createIvanaEvmServer } from "../src/server.js";

const ivana = createIvanaEvmServer({ apiKey: process.env.IVANA_TENANT_API_KEY });
const CATALOGUE = { tee: { title: "Pop-up tee", unitPriceUsdc: 12.5 } };

http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === "POST" && req.url === "/payments/intents") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const { account, chain, cart } = JSON.parse(raw);
      const intent = await ivana.createPaymentIntent({
        paymentChain: chain, walletAddress: account, idempotencyKey: randomUUID(),
        merchantReference: `order:${randomUUID()}`, customer: { name: "Guest", email: "guest@example.com" },
        // Prices come from the catalogue here, never from the browser.
        lineItems: cart.map(({ id, quantity }) => ({ ...CATALOGUE[id], quantity })),
      });
      return send(200, intent);
    }
    const status = req.url?.match(/^\/payments\/([^/]+)\/status$/);
    if (req.method === "GET" && status) return send(200, await ivana.getPaymentStatus(decodeURIComponent(status[1])));
    send(404, { error: "Not found" });
  } catch (error) {
    send(error.status || 500, { error: { code: error.code, message: error.message } });
  }
}).listen(3000, () => console.log("http://localhost:3000"));
