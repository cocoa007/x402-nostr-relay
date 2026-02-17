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

function normalizeTxId(txId) {
  if (typeof txId !== 'string') return '';
  return txId.trim().toLowerCase();
}

function parseAmount(value) {
  try {
    const amount = BigInt(value);
    return amount >= 0n ? amount : null;
  } catch {
    return null;
  }
}

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
  const normalizedTxId = normalizeTxId(txId);
  if (!normalizedTxId) {
    return { valid: false, error: 'Missing transaction ID' };
  }

  // Prevent replay
  if (usedTxIds.has(normalizedTxId)) {
    return { valid: false, error: 'Transaction already used' };
  }

  try {
    const resp = await fetch(`${STACKS_API}/extended/v1/tx/${normalizedTxId}`);
    if (!resp.ok) {
      return { valid: false, error: `Transaction not found: ${resp.status}` };
    }

    const tx = await resp.json();

    // Must be successful
    if (tx.tx_status !== 'success') {
      return { valid: false, error: `Transaction status: ${tx.tx_status}` };
    }

    const minimumAmount = BigInt(Math.max(0, Math.trunc(Number(requiredSats) || 0)));
    let paidAmount = null;

    if (tx.tx_type === 'token_transfer') {
      if (tx.token_transfer?.recipient_address !== PAY_TO) {
        return { valid: false, error: 'Payment not sent to relay address' };
      }
      paidAmount = parseAmount(tx.token_transfer?.amount);
      if (paidAmount == null) {
        return { valid: false, error: 'Invalid transfer amount' };
      }
    } else if (tx.tx_type === 'contract_call') {
      const events = tx.events || [];
      const transferToUs = events.find((event) =>
        event.event_type === 'fungible_token_transfer' &&
        event.asset?.recipient === PAY_TO
      );
      if (!transferToUs) {
        return { valid: false, error: 'No sBTC transfer to relay found in tx' };
      }
      paidAmount = parseAmount(transferToUs.asset?.amount);
      if (paidAmount == null) {
        return { valid: false, error: 'Invalid transfer amount' };
      }
    } else {
      return { valid: false, error: `Unsupported transaction type: ${tx.tx_type}` };
    }

    if (paidAmount < minimumAmount) {
      return { valid: false, error: `Insufficient payment: ${paidAmount} < ${minimumAmount}` };
    }

    // Mark as used
    usedTxIds.add(normalizedTxId);
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
