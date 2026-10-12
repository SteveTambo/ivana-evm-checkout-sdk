/**
 * Browser entry point: find and connect the buyer's EVM wallet, check it can pay,
 * and pay an IVANA intent. Holds no secret; the intent and its status come from
 * your backend (see ./server.js).
 */

export { IvanaError } from "./http.js";
export {
  discoverWallets,
  connectWallet,
  restoreAccount,
  checkFunds,
  walletChainId,
  encodeTransfer,
  encodeBalanceOf,
} from "./wallet.js";
export { payIntent } from "./pay.js";
export { localStorageStore, memoryStore } from "./store.js";
