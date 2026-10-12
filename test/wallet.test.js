import test from "node:test";
import assert from "node:assert/strict";
import { connectWallet, restoreAccount, discoverWallets, encodeTransfer, checkFunds } from "../src/checkout.js";
import { fakeWallet, BUYER, TOKEN } from "./helpers.js";

test("encodes an ERC-20 transfer exactly as a wallet expects", () => {
  // Calldata from a real Base Sepolia payment attempt: 5 USDC to 0x0900…ebb2.
  assert.equal(
    encodeTransfer("0x09009cb779aeb989bd30e1fa5863f14a0fefebb2", 5000000n),
    "0xa9059cbb00000000000000000000000009009cb779aeb989bd30e1fa5863f14a0fefebb200000000000000000000000000000000000000000000000000000000004c4b40",
  );
  assert.throws(() => encodeTransfer("not-an-address", 1), /Not an address/);
});

test("connects first, then switches network, and accepts any spelling of the chain id", async () => {
  const wallet = fakeWallet({ chainId: 1 });
  const account = await connectWallet(wallet, { chainId: 84532, name: "Base Sepolia" }, { pollMs: 1 });
  assert.equal(account, BUYER);
  const order = wallet.calls.map((c) => c.method);
  assert.ok(order.indexOf("eth_requestAccounts") < order.indexOf("wallet_switchEthereumChain"));
});

test("does not ask to switch when the wallet is already on the network", async () => {
  const wallet = fakeWallet({ chainId: 84532 });
  await connectWallet(wallet, { chainId: 84532 });
  assert.equal(wallet.calls.some((c) => c.method === "wallet_switchEthereumChain"), false);
});

test("names the network the wallet is on when it will not switch", async () => {
  const wallet = fakeWallet({ chainId: 1, switchable: false });
  await assert.rejects(connectWallet(wallet, { chainId: 84532, name: "Base Sepolia" }, { pollMs: 1, attempts: 3 }),
    (e) => e.code === "WRONG_NETWORK" && /network 0x1, not Base Sepolia/.test(e.message));
});

test("adds the network when the wallet does not know it", async () => {
  const added = [];
  const provider = {
    chain: 1,
    async request({ method, params }) {
      if (method === "eth_requestAccounts") return [BUYER];
      if (method === "eth_chainId") return `0x${this.chain.toString(16)}`;
      if (method === "wallet_switchEthereumChain") throw Object.assign(new Error("unknown"), { code: 4902 });
      if (method === "wallet_addEthereumChain") { added.push(params[0]); this.chain = 80002; return null; }
      throw new Error(method);
    },
  };
  await connectWallet(provider, { chainId: 80002, name: "Polygon Amoy", rpcUrl: "https://rpc.example", nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 } }, { pollMs: 1 });
  assert.equal(added[0].chainId, "0x13882");
  assert.deepEqual(added[0].rpcUrls, ["https://rpc.example"]);
});

test("restores an approved account without a popup", async () => {
  const wallet = fakeWallet();
  assert.equal(await restoreAccount(wallet), BUYER);
  assert.equal(wallet.calls.some((c) => c.method === "eth_requestAccounts"), false);
});

test("checkFunds returns the balances when they cover the payment", async () => {
  const wallet = fakeWallet({ usdc: 9_000_000n });
  const { usdcUnits } = await checkFunds(wallet, { tokenIdentifier: TOKEN, name: "Base Sepolia" }, BUYER, 5_880_000n);
  assert.equal(usdcUnits, 9_000_000n);
});

test("finds wallets, Phantom first, including ones that predate EIP-6963", async () => {
  const listeners = {};
  const phantom = { request: async () => null };
  const legacy = { request: async () => null };
  const win = {
    phantom: { ethereum: phantom },
    ethereum: legacy,
    Event: class { constructor(type) { this.type = type; } },
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: () => {},
    dispatchEvent: () => {
      listeners["eip6963:announceProvider"]?.({ detail: { info: { uuid: "mm", name: "MetaMask", rdns: "io.metamask" }, provider: { request: async () => null } } });
    },
  };
  const wallets = await discoverWallets({ waitMs: 1, window: win });
  assert.deepEqual(wallets.map((w) => w.name), ["Phantom", "MetaMask", "Browser wallet"]);
  assert.equal(wallets[0].provider, phantom);
  assert.deepEqual(await discoverWallets({ waitMs: 1, window: null }), []);
});
