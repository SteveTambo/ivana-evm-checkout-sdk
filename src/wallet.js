/**
 * Talking to the buyer's EVM wallet through its EIP-1193 provider: finding it,
 * connecting it to the right network, and reading balances. No library is needed:
 * an ERC-20 transfer is one encoded call.
 */

import { IvanaError } from "./http.js";

const PHANTOM_RDNS = "app.phantom";

/** A failure before anything reached the wallet: no money can have moved. */
export function nothingSent(message, code) {
  const error = new IvanaError(message, { code });
  error.notSent = true;
  return error;
}

const hexOf = (value) => `0x${BigInt(value).toString(16)}`;
const word = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** Calldata for ERC-20 `transfer(to, amount)`. */
export function encodeTransfer(to, amountUnits) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new IvanaError(`Not an address: ${to}`, { code: "INVALID_INPUT" });
  return `0xa9059cbb${word(to)}${word(BigInt(amountUnits).toString(16))}`;
}

/** Calldata for ERC-20 `balanceOf(owner)`. */
export function encodeBalanceOf(owner) {
  return `0x70a08231${word(owner)}`;
}

/**
 * Wallets in the page, Phantom first. Uses EIP-6963 announcements, then falls back
 * to `window.phantom.ethereum` and `window.ethereum` for wallets that predate it.
 *
 * @param {{ waitMs?: number, window?: any }} [options]
 * @returns {Promise<Array<{ id: string, name: string, icon?: string, provider: any, phantom: boolean }>>}
 */
export function discoverWallets({ waitMs = 300, window: win = globalThis.window } = {}) {
  return new Promise((resolve) => {
    if (!win) return resolve([]);
    const found = new Map();
    const onAnnounce = (event) => {
      const { info, provider } = event.detail || {};
      if (info?.uuid && typeof provider?.request === "function") {
        found.set(info.uuid, { id: info.uuid, name: info.name, icon: info.icon, provider, phantom: info.rdns === PHANTOM_RDNS });
      }
    };
    win.addEventListener?.("eip6963:announceProvider", onAnnounce);
    win.dispatchEvent?.(new (win.Event || Event)("eip6963:requestProvider"));
    setTimeout(() => {
      win.removeEventListener?.("eip6963:announceProvider", onAnnounce);
      const known = (provider) => [...found.values()].some((wallet) => wallet.provider === provider);
      const phantom = win.phantom?.ethereum;
      if (phantom?.request && !known(phantom)) found.set("phantom", { id: "phantom", name: "Phantom", provider: phantom, phantom: true });
      const legacy = win.ethereum;
      if (legacy?.request && !known(legacy)) found.set("window.ethereum", { id: "window.ethereum", name: "Browser wallet", provider: legacy, phantom: false });
      resolve([...found.values()].sort((a, b) => Number(b.phantom) - Number(a.phantom)));
    }, waitMs);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The chain the wallet is on, as a number (wallets spell the id differently). */
export async function walletChainId(provider) {
  return Number(await provider.request({ method: "eth_chainId" }));
}

/**
 * Connects the wallet and switches it to `chain`, then returns the buyer's address.
 * It connects first: some wallets (Phantom among them) ignore a network switch from
 * a site they have not approved yet.
 *
 * @param {any} provider EIP-1193 provider
 * @param {{ chainId: number, name?: string, rpcUrl?: string, explorerUrl?: string|null, nativeCurrency?: { name: string, symbol: string, decimals: number } }} chain
 * @param {{ pollMs?: number, attempts?: number }} [options]
 */
export async function connectWallet(provider, chain, { pollMs = 250, attempts = 10 } = {}) {
  if (!provider?.request) throw new IvanaError("No EVM wallet was found.", { code: "NO_WALLET" });
  if (!Number.isSafeInteger(chain?.chainId)) throw new IvanaError("chain.chainId is required.", { code: "INVALID_INPUT" });
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0] || "")) {
    throw new IvanaError("The wallet returned no account.", { code: "NO_ACCOUNT" });
  }
  if ((await walletChainId(provider)) === chain.chainId) return accounts[0];
  const chainIdHex = hexOf(chain.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    if (!chain.rpcUrl) throw new IvanaError(`The wallet does not know ${chain.name || "this network"}.`, { code: "UNKNOWN_CHAIN" });
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: chainIdHex,
        chainName: chain.name || `Chain ${chain.chainId}`,
        nativeCurrency: chain.nativeCurrency || { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [chain.rpcUrl],
        ...(chain.explorerUrl ? { blockExplorerUrls: [chain.explorerUrl] } : {}),
      }],
    });
  }
  // The wallet reports its new network a moment after the switch is approved.
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await walletChainId(provider)) === chain.chainId) return accounts[0];
    await sleep(pollMs);
  }
  const reported = await provider.request({ method: "eth_chainId" });
  throw new IvanaError(
    `The wallet is on network ${String(reported)}, not ${chain.name || chain.chainId}. Switch it in the wallet and try again.`,
    { code: "WRONG_NETWORK" },
  );
}

/** The account the wallet already approved for this site, without opening a popup. */
export async function restoreAccount(provider) {
  const accounts = await provider.request({ method: "eth_accounts" });
  return Array.isArray(accounts) && /^0x[0-9a-fA-F]{40}$/.test(accounts[0] || "") ? accounts[0] : null;
}

const formatUsdc = (units) => {
  const whole = units / 1000000n, cents = (units % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return cents ? `${whole}.${cents}` : `${whole}`;
};

/**
 * Throws, with a plain message, unless `account` holds `neededUnits` of the token
 * (six-decimal USDC base units) and some gas. Run it before asking for a quote and
 * before sending: a failed gas estimate in the wallet is much harder to read.
 *
 * @param {any} provider
 * @param {{ tokenIdentifier: string, name?: string }} chain the network, or an intent
 * @param {string} account
 * @param {bigint|string|number} neededUnits
 */
export async function checkFunds(provider, chain, account, neededUnits) {
  const [usdcHex, gasHex] = await Promise.all([
    provider.request({ method: "eth_call", params: [{ to: chain.tokenIdentifier, data: encodeBalanceOf(account) }, "latest"] }),
    provider.request({ method: "eth_getBalance", params: [account, "latest"] }),
  ]);
  const usdc = BigInt(usdcHex === "0x" ? 0 : usdcHex), needed = BigInt(neededUnits);
  const place = chain.name || "this network";
  if (usdc < needed) {
    throw nothingSent(`The wallet has ${formatUsdc(usdc)} USDC on ${place} but this payment needs ${formatUsdc(needed)}.`, "INSUFFICIENT_USDC");
  }
  if (BigInt(gasHex) === 0n) throw nothingSent(`The wallet has no gas on ${place}.`, "NO_GAS");
  return { usdcUnits: usdc, gasWei: BigInt(gasHex) };
}
