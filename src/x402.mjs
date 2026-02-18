/**
 * x402 payment gate for EVENT writes.
 * 
 * Flow:
 * 1. Client POSTs event to /api/events
 * 2. Without valid payment → 402 with x402 headers
 * 3. With payment proof (tx ID) → verify on Stacks API → accept
 * 
 * If the event has a 'p' tag (targets a recipient), an extra 100 sats
 * is added to the price and forwarded to the recipient.
 */

// PAY_TO: set via env (should match the relay wallet address)
const PAY_TO = process.env.PAY_TO || 'SP3PME5Q8G3VJ7GAFBMNCRXJ28HFTBX74XZC70WZ7';
const STACKS_API = process.env.STACKS_API || 'https://api.mainnet.hiro.so';

const RELAY_FEE = 5;          // sats — base relay fee for any event
const RECIPIENT_AMOUNT = 100;  // sats — forwarded to recipient when event has p tag

// Base pricing by event kind (in sats) — relay fee only
const BASE_PRICING = {
  0: 50,     // profile metadata
  1: 10,     // text note
  4: 5,      // encrypted DM
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
 * Extract the first 'p' tag hex pubkey from an event, if any.
 */
export function getRecipient(event) {
  if (!event?.tags) return null;
  const pTag = event.tags.find(t => Array.isArray(t) && t[0] === 'p' && t[1]);
  return pTag ? pTag[1] : null;
}

/**
 * Get the base relay price in sats for an event kind.
 */
export function getBasePrice(kind) {
  return BASE_PRICING[kind] ?? BASE_PRICING.default;
}

/**
 * Get the total price for an event.
 * If it targets a recipient (p tag), adds RECIPIENT_AMOUNT on top.
 */
export function getPrice(event) {
  const base = getBasePrice(typeof event === 'number' ? event : event.kind);
  const recipient = typeof event === 'number' ? null : getRecipient(event);
  return recipient ? base + RECIPIENT_AMOUNT : base;
}

/**
 * Build the 402 response with x402 payment details.
 */
export function build402Response(event) {
  const recipient = getRecipient(event);
  const basePrice = getBasePrice(event.kind);
  const totalPrice = recipient ? basePrice + RECIPIENT_AMOUNT : basePrice;

  const description = recipient
    ? `Publish kind ${event.kind} event to x402 Nostr relay (${basePrice} sats relay + ${RECIPIENT_AMOUNT} sats forwarded to recipient)`
    : `Publish kind ${event.kind} event to x402 Nostr relay`;

  return {
    status: 402,
    headers: {
      'X-Payment': JSON.stringify({
        scheme: 'x402',
        network: 'stacks',
        asset: 'sbtc',
        payTo: PAY_TO,
        maxAmountRequired: String(totalPrice),
        description,
        mimeType: 'application/json',
        resource: '/api/events',
      }),
      'Content-Type': 'application/json',
    },
    body: {
      error: 'Payment Required',
      price: totalPrice,
      asset: 'sBTC',
      payTo: PAY_TO,
      ...(recipient ? {
        breakdown: {
          relayFee: basePrice,
          recipientForward: RECIPIENT_AMOUNT,
          recipientPubkey: recipient,
        },
      } : {}),
    },
  };
}

/**
 * Verify an sBTC payment transaction on the Stacks API.
 */
export async function verifyPayment(txId, requiredSats) {
  const normalizedTxId = normalizeTxId(txId);
  if (!normalizedTxId) {
    return { valid: false, error: 'Missing transaction ID' };
  }

  if (usedTxIds.has(normalizedTxId)) {
    return { valid: false, error: 'Transaction already used' };
  }

  try {
    const resp = await fetch(`${STACKS_API}/extended/v1/tx/${normalizedTxId}`);
    if (!resp.ok) {
      return { valid: false, error: `Transaction not found: ${resp.status}` };
    }

    const tx = await resp.json();

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
        (event.event_type === 'fungible_token_transfer' || event.event_type === 'fungible_token_asset') &&
        event.asset?.asset_event_type === 'transfer' &&
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
    return paymentHeader;
  }
}

export { PAY_TO, RELAY_FEE, RECIPIENT_AMOUNT };
