/**
 * Relay wallet — sends sBTC forwarding payments to recipients.
 * 
 * Uses sponsored transactions (fee=0) so the relay wallet
 * needs no STX for gas. The sponsor relay pays the fee.
 */

import pkg from '@stacks/transactions';
const {
  makeContractCall,
  broadcastTransaction,
  getAddressFromPrivateKey,
  uintCV,
  standardPrincipalCV,
  noneCV,
  PostConditionMode,
  AnchorMode,
  STACKS_MAINNET,
} = pkg;

const STACKS_API = process.env.STACKS_API || 'https://api.mainnet.hiro.so';
const RELAY_KEY = process.env.RELAY_PRIVATE_KEY || '';

// sBTC contract on mainnet
const SBTC_CONTRACT = {
  address: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4',
  name: 'sbtc-token',
};

let relayAddress = null;

/**
 * Get the relay's STX address.
 */
export function getRelayAddress() {
  if (!RELAY_KEY) return null;
  if (!relayAddress) {
    relayAddress = getAddressFromPrivateKey(RELAY_KEY, STACKS_MAINNET);
  }
  return relayAddress;
}

/**
 * Get the relay's sBTC balance.
 */
export async function getRelayBalance() {
  const addr = getRelayAddress();
  if (!addr) return 0;

  try {
    const resp = await fetch(`${STACKS_API}/extended/v1/address/${addr}/balances`);
    if (!resp.ok) return 0;
    const data = await resp.json();
    for (const [key, token] of Object.entries(data.fungible_tokens || {})) {
      if (key.includes('sbtc')) {
        return parseInt(token.balance || '0');
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Forward sBTC to a recipient's STX address using sponsored transaction.
 * No STX needed — the sponsor relay pays the fee.
 * Returns { success, txId, error }.
 */
export async function forwardSbtc(recipientStxAddress, amountSats) {
  if (!RELAY_KEY) {
    return { success: false, error: 'No relay private key configured' };
  }

  const senderAddress = getRelayAddress();

  try {
    // Get current nonce
    const nonceResp = await fetch(`${STACKS_API}/extended/v1/address/${senderAddress}/nonces`);
    const nonceData = await nonceResp.json();
    const nonce = nonceData.possible_next_nonce;

    // Build sBTC transfer contract call with sponsored=true, fee=0
    const txOptions = {
      contractAddress: SBTC_CONTRACT.address,
      contractName: SBTC_CONTRACT.name,
      functionName: 'transfer',
      functionArgs: [
        uintCV(amountSats),
        standardPrincipalCV(senderAddress),
        standardPrincipalCV(recipientStxAddress),
        noneCV(), // memo
      ],
      senderKey: RELAY_KEY,
      network: STACKS_MAINNET,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Allow,
      nonce,
      fee: 0,          // sponsored — no fee
      sponsored: true,  // marks tx as sponsored
    };

    const tx = await makeContractCall(txOptions);

    // Broadcast — Hiro's API handles sponsored txs
    const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });

    if (result.error) {
      return { success: false, error: result.error, reason: result.reason };
    }

    return { success: true, txId: typeof result === 'string' ? result : result.txid };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check if wallet is configured.
 */
export function isWalletConfigured() {
  return !!RELAY_KEY;
}
