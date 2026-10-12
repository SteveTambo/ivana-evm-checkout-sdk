// A stand-in EIP-1193 wallet on one chain. It keeps a USDC ledger, mines every
// transfer at once (or reverts it on request), and records what it was asked.
export const BUYER = "0x1111111111111111111111111111111111111111";
export const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export function fakeWallet({ chainId = 84532, usdc = 100_000_000n, gas = 10n ** 16n, batch = "unsupported", switchable = true } = {}) {
  const calls = [];
  const receipts = new Map();
  const state = { chainId, usdc, revertNext: false, loseBatchAnswer: false, sent: [] };
  let counter = 0;
  const hash = () => `0x${(++counter).toString(16).padStart(64, "0")}`;
  const decodeTransfer = (data) => ({ to: `0x${data.slice(34, 74)}`, amount: BigInt(`0x${data.slice(74)}`) });
  const provider = {
    calls,
    state,
    receipts,
    async request({ method, params = [] }) {
      calls.push({ method, params });
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [BUYER];
        case "eth_chainId":
          return `0x${state.chainId.toString(16).toUpperCase()}`; // upper-case, as some wallets do
        case "wallet_switchEthereumChain":
          if (switchable) state.chainId = Number(params[0].chainId);
          return null;
        case "eth_call":
          return `0x${state.usdc.toString(16)}`;
        case "eth_getBalance":
          return `0x${gas.toString(16)}`;
        case "eth_sendTransaction": {
          const h = hash();
          const { to, amount } = decodeTransfer(params[0].data);
          if (state.revertNext) {
            state.revertNext = false;
            receipts.set(h, { status: "0x0", transactionHash: h });
          } else {
            state.usdc -= amount;
            state.sent.push({ to, amount, hash: h });
            receipts.set(h, { status: "0x1", transactionHash: h });
          }
          return h;
        }
        case "eth_getTransactionReceipt":
          return receipts.get(params[0]) ?? null;
        case "wallet_getCapabilities":
          if (batch === "throws") throw Object.assign(new Error("no"), { code: 4200 });
          return { [`0x${state.chainId.toString(16)}`]: { atomic: { status: batch } } };
        case "wallet_sendCalls": {
          if (state.loseBatchAnswer) throw new Error("connection lost");
          const h = hash();
          for (const call of params[0].calls) {
            const { to, amount } = decodeTransfer(call.data);
            state.usdc -= amount;
            state.sent.push({ to, amount, hash: h });
          }
          return { id: "batch-1", hash: h };
        }
        case "wallet_getCallsStatus":
          return { status: 200, receipts: [{ transactionHash: state.sent.at(-1)?.hash || "0xbatch" }] };
        default:
          throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      }
    },
  };
  return provider;
}

export const intent = (extra = {}) => ({
  intentId: "evm:84532:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  chain: "evm:84532",
  chainId: 84532,
  name: "Base Sepolia",
  payer: BUYER,
  tokenIdentifier: TOKEN,
  amountUnits: "5880000",
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  transfers: [
    { to: "0x2222222222222222222222222222222222222222", amountUnits: "5000000" },
    { to: "0x3333333333333333333333333333333333333333", amountUnits: "800000" },
    { to: "0x4444444444444444444444444444444444444444", amountUnits: "80000" },
  ],
  breakdown: { netAmount: 5, vatAmount: 0.8, transactionFee: 0.08, total: 5.88, currency: "USDC" },
  ...extra,
});

/** A backend status that reports which legs the wallet has actually paid. */
export function statusFrom(wallet, base = intent()) {
  return async () => {
    const paid = base.transfers.map((leg) =>
      wallet.state.sent.some((s) => s.to.toLowerCase() === leg.to.toLowerCase() && s.amount === BigInt(leg.amountUnits)));
    const all = paid.every(Boolean);
    return { status: all ? "completed" : "pending", success: all, signature: all ? wallet.state.sent[0].hash : null, legs: paid.map((p) => ({ paid: p })) };
  };
}
