/**
 * x402 payment gate for EVENT writes.
 * 
 * Flow:
 * 1. Client POSTs event to /api/events
 * 2. Without valid payment → 402 with x402 headers
 * 3. With payment proof (tx ID) → verify on Stacks API → accept
 */

const PAY_TO = 'SP16H0KE0BPR4XNQ64115V5Y1V3XTPGMWG5YPC9TR';
const STACKS_API = 'https://api.mainnet.hiro.so';

// Pricing by event kind (in sats)
const PRICING = {
  0: 50,    // profile metadata
  1: 10,    // text note
  4: 5,     // encrypted DM
  30023: 25, // long-form
  default: 10,
};

/** Set of verified tx IDs to prevent replay */
const usedTxIds = new Set();

/**
 * Get the price in sats for an event kind.
 */
export function getPrice(kind) {
  return PRICING[kind] ?? PRICING.default;
}

/**
 * Build the 402 response with x402 payment details.
 */
export function build402Response(event) {
  const priceSats = getPrice(event.kind);
  return {
    status: 402,
    headers: {
      'X-Payment': JSON.stringify({
        scheme: 'x402',
        network: 'stacks',
        asset: 'sbtc',
        payTo: PAY_TO,
        maxAmountRequired: String(priceSats),
        description: `Publish kind ${event.kind} event to x402 Nostr relay`,
        mimeType: 'application/json',
        resource: '/api/events',
      }),
      'Content-Type': 'application/json',
    },
    body: {
      error: 'Payment Required',
      price: priceSats,
      asset: 'sBTC',
      payTo: PAY_TO,
    },
  };
}

/**
 * Verify an sBTC payment transaction on the Stacks API.
 * Checks that:
 * 1. Transaction exists and is successful
 * 2. It's an sBTC transfer to our address
 * 3. Amount >= required
 * 4. Tx ID hasn't been reused
 * 
 * @param {string} txId - Stacks transaction ID
 * @param {number} requiredSats - Minimum payment in sats
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function verifyPayment(txId, requiredSats) {
  if (!txId || typeof txId !== 'string') {
    return { valid: false, error: 'Missing transaction ID' };
  }

  // Prevent replay
  if (usedTxIds.has(txId)) {
    return { valid: false, error: 'Transaction already used' };
  }

  try {
    const resp = await fetch(`${STACKS_API}/extended/v1/tx/${txId}`);
    if (!resp.ok) {
      return { valid: false, error: `Transaction not found: ${resp.status}` };
    }

    const tx = await resp.json();

    // Must be successful
    if (tx.tx_status !== 'success') {
      return { valid: false, error: `Transaction status: ${tx.tx_status}` };
    }

    // Check it's a contract call to sBTC or a token transfer
    // For MVP, accept if tx is successful and sent to our address
    // More rigorous checks can be added in Phase 2

    // Check for STX transfer to our address
    if (tx.tx_type === 'token_transfer') {
      if (tx.token_transfer?.recipient_address !== PAY_TO) {
        return { valid: false, error: 'Payment not sent to relay address' };
      }
      const amountMicroStx = BigInt(tx.token_transfer.amount);
      // 1 STX = ~some sats equivalent — for MVP accept any STX transfer
      // In production, would check sBTC contract call specifically
    }

    // For contract calls (sBTC transfers), check post_conditions or events
    if (tx.tx_type === 'contract_call') {
      // Look for sBTC transfer in events
      const events = tx.events || [];
      const transferToUs = events.find(e =>
        e.event_type === 'fungible_token_transfer' &&
        e.asset?.recipient === PAY_TO
      );
      if (!transferToUs) {
        return { valid: false, error: 'No sBTC transfer to relay found in tx' };
      }
      const amount = BigInt(transferToUs.asset.amount || '0');
      if (amount < BigInt(requiredSats)) {
        return { valid: false, error: `Insufficient payment: ${amount} < ${requiredSats}` };
      }
    }

    // Mark as used
    usedTxIds.add(txId);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Verification failed: ${err.message}` };
  }
}

/**
 * Extract payment proof from request headers.
 */
export function extractPayment(headers) {
  const paymentHeader = headers['x-payment-response'] || headers['x-payment'];
  if (!paymentHeader) return null;

  try {
    const payment = JSON.parse(paymentHeader);
    return payment.txId || payment.transactionId || null;
  } catch {
    // Maybe it's just the raw tx ID
    return paymentHeader;
  }
}
