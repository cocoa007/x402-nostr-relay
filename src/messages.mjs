/**
 * Recipient payment resolution and payout tracking.
 * 
 * When an event with a 'p' tag is published (and paid for),
 * the relay looks up the recipient's Nostr profile (kind 0)
 * for a payment address and queues a forwarding payout.
 */

// Known Nostr relays to query for profiles
const PROFILE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
];

// Pending payouts: recipientHex → { amount, messages[], paymentAddress }
const pendingPayouts = new Map();

/**
 * Fetch a Nostr profile (kind 0) from relays to find payment address.
 * Returns { address, type, source } or null.
 */
export async function lookupPaymentAddress(recipientHexPubkey) {
  for (const relayUrl of PROFILE_RELAYS) {
    try {
      const profile = await fetchProfileFromRelay(relayUrl, recipientHexPubkey);
      if (profile) {
        if (profile.stx_address) {
          return { address: profile.stx_address, type: 'stx', source: 'nostr-profile' };
        }
        if (profile.btc_address) {
          return { address: profile.btc_address, type: 'btc', source: 'nostr-profile' };
        }
        if (profile.lud16) {
          return { address: profile.lud16, type: 'lightning', source: 'nostr-profile' };
        }
        if (profile.lud06) {
          return { address: profile.lud06, type: 'lnurl', source: 'nostr-profile' };
        }
      }
    } catch {
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

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
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
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        }
      } catch {}
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

/**
 * Record a pending payout for a recipient.
 */
export function recordPendingPayout(recipientHexPubkey, paymentAddress, amount, eventId) {
  if (!pendingPayouts.has(recipientHexPubkey)) {
    pendingPayouts.set(recipientHexPubkey, { amount: 0, messages: [], paymentAddress });
  }
  const entry = pendingPayouts.get(recipientHexPubkey);
  entry.amount += amount;
  entry.messages.push(eventId);
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
