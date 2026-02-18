/**
 * Paid Nostr messaging with payment forwarding.
 * 
 * Flow:
 * 1. Sender POSTs to /api/messages with {recipientNpub, content, senderPubkey}
 * 2. Relay returns 402 requiring 105 sats (5 relay fee + 100 forwarded)
 * 3. Sender pays and resubmits with x402 proof
 * 4. Relay looks up recipient's Nostr profile (kind 0) for payment address
 * 5. Creates kind 4 encrypted DM event, stores + broadcasts
 * 6. Forwards 100 sats to recipient's payment address
 * 
 * Recipient payment address resolution (Option A — profile lookup):
 *   - Fetch kind 0 (profile metadata) from known relays
 *   - Look for: stx_address, btc_address, lud16, or lud06 fields
 *   - If no payment address found, hold funds in escrow (claimable later)
 */

const RELAY_FEE = 5;        // sats kept by relay
const RECIPIENT_AMOUNT = 100; // sats forwarded to recipient
const TOTAL_PRICE = RELAY_FEE + RECIPIENT_AMOUNT; // 105 sats

const STACKS_API = 'https://api.mainnet.hiro.so';
const PAY_TO = 'SP16H0KE0BPR4XNQ64115V5Y1V3XTPGMWG5YPC9TR';

// Known Nostr relays to query for profiles
const PROFILE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
];

// Pending payouts for recipients without payment addresses
// In production, persist to DB
const pendingPayouts = new Map(); // npub → { amount, messages[] }

/**
 * Fetch a Nostr profile (kind 0) from relays to find payment address.
 * Returns { address, type } or null.
 */
export async function lookupPaymentAddress(recipientHexPubkey) {
  // Try each relay until we get a profile
  for (const relayUrl of PROFILE_RELAYS) {
    try {
      const profile = await fetchProfileFromRelay(relayUrl, recipientHexPubkey);
      if (profile) {
        // Check for payment fields in priority order
        if (profile.stx_address) {
          return { address: profile.stx_address, type: 'stx', source: 'nostr-profile' };
        }
        if (profile.btc_address) {
          return { address: profile.btc_address, type: 'btc', source: 'nostr-profile' };
        }
        // Lightning (NIP-57 style)
        if (profile.lud16) {
          return { address: profile.lud16, type: 'lightning', source: 'nostr-profile' };
        }
        if (profile.lud06) {
          return { address: profile.lud06, type: 'lnurl', source: 'nostr-profile' };
        }
      }
    } catch {
      // Try next relay
      continue;
    }
  }
  return null;
}

/**
 * Fetch kind 0 profile from a single relay via WebSocket.
 * Times out after 5 seconds.
 */
async function fetchProfileFromRelay(relayUrl, hexPubkey) {
  const { WebSocket } = await import('ws');
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve(null);
    }, 5000);

    let ws;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timeout);
      resolve(null);
      return;
    }

    ws.on('open', () => {
      // REQ for kind 0 from this pubkey, limit 1
      const subId = 'profile-' + hexPubkey.slice(0, 8);
      ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [hexPubkey], limit: 1 }]));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[2]?.kind === 0) {
          clearTimeout(timeout);
          ws.close();
          try {
            resolve(JSON.parse(msg[2].content));
          } catch {
            resolve(null);
          }
        } else if (msg[0] === 'EOSE') {
          // No profile found on this relay
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

/**
 * Decode bech32-encoded npub to hex pubkey.
 * Simplified bech32 decoder for npub only.
 */
export function npubToHex(npub) {
  if (!npub || !npub.startsWith('npub1')) {
    return null;
  }
  
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = npub.slice(5); // remove 'npub1'
  
  const values = [];
  for (const c of data) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) return null;
    values.push(idx);
  }
  
  // Remove checksum (last 6 characters)
  const payload = values.slice(0, -6);
  
  // Convert from 5-bit to 8-bit
  let acc = 0;
  let bits = 0;
  const bytes = [];
  for (const v of payload) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  
  if (bytes.length !== 32) return null;
  return Buffer.from(bytes).toString('hex');
}

/**
 * Build 402 response for messaging endpoint.
 */
export function buildMessage402Response(recipientNpub) {
  return {
    status: 402,
    headers: {
      'X-Payment': JSON.stringify({
        scheme: 'x402',
        network: 'stacks',
        asset: 'sbtc',
        payTo: PAY_TO,
        maxAmountRequired: String(TOTAL_PRICE),
        description: `Send paid Nostr message to ${recipientNpub.slice(0, 20)}... (${RECIPIENT_AMOUNT} sats to recipient + ${RELAY_FEE} sats relay fee)`,
        mimeType: 'application/json',
        resource: '/api/messages',
      }),
      'Content-Type': 'application/json',
    },
    body: {
      error: 'Payment Required',
      totalPrice: TOTAL_PRICE,
      breakdown: {
        recipientAmount: RECIPIENT_AMOUNT,
        relayFee: RELAY_FEE,
      },
      asset: 'sBTC',
      payTo: PAY_TO,
      recipientNpub,
    },
  };
}

/**
 * Record a pending payout for a recipient.
 */
export function recordPendingPayout(recipientHexPubkey, recipientNpub, paymentAddress, messageId) {
  const key = recipientHexPubkey;
  if (!pendingPayouts.has(key)) {
    pendingPayouts.set(key, { npub: recipientNpub, amount: 0, messages: [], paymentAddress });
  }
  const entry = pendingPayouts.get(key);
  entry.amount += RECIPIENT_AMOUNT;
  entry.messages.push(messageId);
  if (paymentAddress) entry.paymentAddress = paymentAddress;
  return entry;
}

/**
 * Get all pending payouts.
 */
export function getPendingPayouts() {
  const result = [];
  for (const [pubkey, entry] of pendingPayouts) {
    result.push({ pubkey, ...entry });
  }
  return result;
}

export { RELAY_FEE, RECIPIENT_AMOUNT, TOTAL_PRICE, PAY_TO };
