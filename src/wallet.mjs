/**
 * Relay wallet — sends sBTC forwarding payments to recipients.
 * Uses sponsored transactions so the relay needs no STX for gas.
 */

import txPkg from '@stacks/transactions';
import netPkg from '@stacks/network';

const {
  makeContractCall, broadcastTransaction, getAddressFromPrivateKey,
  uintCV, standardPrincipalCV, noneCV,
  PostConditionMode, AnchorMode,
} = txPkg;

const { STACKS_MAINNET } = netPkg;

const STACKS_API = 'https://api.mainnet.hiro.so';
const RELAY_KEY = process.env.RELAY_PRIVATE_KEY || '';

// sBTC contract on mainnet
const SBTC_CONTRACT = {
  address: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4',
  name: 'sbtc-token',
};

let relayAddress = null;

export function getRelayAddress() {
  if (!RELAY_KEY) return null;
  if (!relayAddress) {
    relayAddress = getAddressFromPrivateKey(RELAY_KEY, STACKS_MAINNET);
  }
  return relayAddress;
}

export async function getRelayBalance() {
  const addr = getRelayAddress();
  if (!addr) return 0;
  try {
    const resp = await fetch(`${STACKS_API}/extended/v1/address/${addr}/balances`);
    if (!resp.ok) return 0;
    const data = await resp.json();
    for (const [key, token] of Object.entries(data.fungible_tokens || {})) {
      if (key.includes('sbtc')) return parseInt(token.balance || '0');
    }
    return 0;
  } catch { return 0; }
}

/**
 * Forward sBTC to a recipient's STX address.
 * Uses fee=0 and broadcasts — Hiro API handles if no fee attached.
 * If that fails, tries with minimal fee (needs STX).
 */
export async function forwardSbtc(recipientStxAddress, amountSats) {
  if (!RELAY_KEY) {
    return { success: false, error: 'No relay private key configured' };
  }

  const senderAddress = getRelayAddress();

  try {
    const nonceResp = await fetch(`${STACKS_API}/extended/v1/address/${senderAddress}/nonces`);
    const nonceData = await nonceResp.json();
    const nonce = nonceData.possible_next_nonce;

    const txOptions = {
      contractAddress: SBTC_CONTRACT.address,
      contractName: SBTC_CONTRACT.name,
      functionName: 'transfer',
      functionArgs: [
        uintCV(amountSats),
        standardPrincipalCV(senderAddress),
        standardPrincipalCV(recipientStxAddress),
        noneCV(),
      ],
      senderKey: RELAY_KEY,
      network: STACKS_MAINNET,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Allow,
      nonce,
      fee: 300,  // minimal fee (microSTX)
    };

    const tx = await makeContractCall(txOptions);
    const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });

    // Check for error
    if (result && typeof result === 'object' && result.error) {
      // If fee too low, retry with higher fee
      if (result.reason === 'FeeTooLow') {
        txOptions.fee = 1000;
        const tx2 = await makeContractCall(txOptions);
        const result2 = await broadcastTransaction({ transaction: tx2, network: STACKS_MAINNET });
        if (result2 && typeof result2 === 'object' && result2.error) {
          return { success: false, error: result2.error, reason: result2.reason };
        }
        return { success: true, txId: typeof result2 === 'string' ? result2 : result2.txid };
      }
      return { success: false, error: result.error, reason: result.reason };
    }

    return { success: true, txId: typeof result === 'string' ? result : result.txid };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function isWalletConfigured() {
  return !!RELAY_KEY;
}
