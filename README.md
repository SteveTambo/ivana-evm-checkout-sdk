# @habix/ivana-evm-checkout

Non-custodial USDC checkout on **Base** and **Polygon** through the IVANA payments engine. It is the EVM counterpart of [`@habix/ivana-checkout`](https://github.com/SteveTambo/ivana-checkout-sdk) (Solana).

- The buyer pays from their own wallet (Phantom recommended). IVANA never holds the money.
- Each share is a plain ERC-20 USDC transfer: the merchant, any consignment supplier, the VAT and the platform fee. There is no custom contract and no allowance to approve.
- IVANA confirms every transfer from the token's own records and counts each one once, for one order only.
- No dependencies: it talks to the wallet's standard EIP-1193 interface.

Today IVANA runs EVM payments on test networks: **Base Sepolia** (`evm:84532`) and **Polygon Amoy** (`evm:80002`). Mainnets (Base `evm:8453`, Polygon `evm:137`) are switched off on the IVANA side until it is ready for real funds.

## How it differs from Solana checkout

| | Solana (`@habix/ivana-checkout`) | EVM (this package) |
| --- | --- | --- |
| Approvals | One transaction, one signature | One transfer per share, unless the wallet supports atomic batches (EIP-5792) |
| Currency | USDC, USDT or $HBX | USDC only |
| Browser credential | The intent id | None: every call needs the tenant key, so the browser asks **your backend** for status |

Because separate transfers are not atomic, a buyer can stop part-way. IVANA reports exactly which transfers are paid, this SDK resumes by sending only the rest, and a payment that is only partly made by its deadline is held for a refund and never fulfilled.

## Install

```bash
npm install @habix/ivana-evm-checkout
```

Node 20.19 or later on the server; any modern browser with an EVM wallet.

## 1. On your server

```js
import { createIvanaEvmServer } from "@habix/ivana-evm-checkout/server";

const ivana = createIvanaEvmServer({ apiKey: process.env.IVANA_TENANT_API_KEY });

// The networks you can be paid on, and whether each is ready.
const { chains } = await ivana.listChains();

// Price the order from YOUR catalogue, never from the browser.
const intent = await ivana.createPaymentIntent({
  paymentChain: "evm:84532",
  walletAddress: buyerAddress, // the buyer's 0x address, from the browser
  idempotencyKey: crypto.randomUUID(), // reuse it to retry a lost response
  merchantReference: `order:${orderId}`,
  customer: { name, email },
  lineItems: [{ title: "Tee", unitPriceUsdc: 12.5, quantity: 2 }],
});
// Send `intent` to the browser.

// The browser's status requests come through you:
app.get("/payments/:intentId/status", async (req, res) => {
  res.json(await ivana.getPaymentStatus(req.params.intentId));
});
```

To fulfil orders even when the buyer closes the page, read the settlement feed: store each event, act on it, then acknowledge it.

```js
let after = await loadCursor();
const { events } = await ivana.listSettlementEvents({ after });
for (const event of events) {
  await fulfil(event.intentId);
  await ivana.acknowledgeSettlementEvent(event.id);
  after = event.cursor;
}
```

## 2. In the browser

```js
import { discoverWallets, connectWallet, checkFunds, payIntent } from "@habix/ivana-evm-checkout";

const [wallet] = await discoverWallets(); // Phantom first
const account = await connectWallet(wallet.provider, chain); // a chain from listChains()

// Check before asking for a quote: a clear message beats a failed gas estimate.
await checkFunds(wallet.provider, chain, account, BigInt(Math.round(total * 1e6)));

const intent = await fetch("/payments/intents", { method: "POST", body: JSON.stringify({ account, cart }) }).then((r) => r.json());

const result = await payIntent({
  provider: wallet.provider,
  intent,
  account,
  getStatus: (intentId) => fetch(`/payments/${encodeURIComponent(intentId)}/status`).then((r) => r.json()),
  onStage: (stage) => showProgress(stage), // e.g. "Confirm payment 2 of 3 in your wallet"
});
if (result.status === "completed") showReceipt(result.signature);
```

`connectWallet` connects first and then switches the network (some wallets ignore a switch from a site they have not approved), adds the network if the wallet does not know it, and compares chain ids as numbers.

## Never paying twice

`payIntent` keeps a record per intent in `localStorage` (or a store you pass):

- Only transfers IVANA does not already see as paid are sent.
- Each transfer hash is saved the moment the wallet returns it. On a retry, a saved transfer is waited on, never resent, unless its receipt shows it reverted (which moves no money).
- A wallet batch is recorded **before** it is requested. If the wallet's answer is lost, the next attempt follows that batch or stops with `BATCH_PENDING`; it never sends a second one.
- An expired, held or already completed payment is never paid again.

## Errors

Every failure is an `IvanaError` with a `code`. Those with `notSent: true` happened before anything reached the wallet, so no money moved and the buyer can simply fix the cause and retry.

| Code | Meaning |
| --- | --- |
| `INSUFFICIENT_USDC` / `NO_GAS` | The wallet cannot cover the payment on this network (`notSent`) |
| `WRONG_NETWORK` / `WRONG_ACCOUNT` | The wallet is on another network or account than the intent (`notSent`) |
| `INTENT_EXPIRED` | The quote ran out of time with nothing paid; ask for a new one (`notSent`) |
| `PAYMENT_HELD` | Part paid or paid late; held for a refund, never fulfilled |
| `TRANSFER_REVERTED` | A transfer failed on chain and moved no money; retrying resends it |
| `BATCH_PENDING` / `STILL_CONFIRMING` | Something may still be in flight; check again, do not pay again |
| `PAYMENT_IN_PROGRESS` | IVANA: an identical quote is already open for this wallet |

## Test networks

Buyers need test USDC from [Circle's faucet](https://faucet.circle.com) (choose Base Sepolia or Polygon Amoy) and a little test ETH or POL for gas. In Phantom, turn on Testnet Mode (Settings, Developer Settings).

## Licence

Apache-2.0. The IVANA engine itself is private; this SDK is the public client for it.
