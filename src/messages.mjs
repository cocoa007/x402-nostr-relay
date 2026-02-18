/**
 * Recipient payment resolution and payout tracking.
 * 
 * Resolution order:
 * 1. Look up recipient's Nostr profile (kind 0) for stx_address / btc_address
 * 2. If not found, check aibtc.com agent registry by hex pubkey
 * 3. If still not found, hold funds as claimable
 */

// Known Nostr relays to query for profiles
const PROFILE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
];

const AIBTC_API = 'https://aibtc.com/api/agents';

// Pending payouts: recipientHex → { amount, messages[], paymentAddress }
const pendingPayouts = new Map();

/**
 * Resolve a recipient's payment address.
 * Tries Nostr profile first, then aibtc registry fallback.
 */
export async function resolvePaymentAddress(recipientHexPubkey) {
  // Step 1: Nostr profile lookup
  const profileAddress = await lookupNostrProfile(recipientHexPubkey);
  if (profileAddress) return profileAddress;

  // Step 2: aibtc registry fallback
  const registryAddress = await lookupAibtcRegistry(recipientHexPubkey);
  if (registryAddress) return registryAddress;

  return null;
}

/**
 * Look up Nostr profile (kind 0) for payment address.
 */
async function lookupNostrProfile(recipientHexPubkey) {
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
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Look up agent in aibtc.com registry by hex pubkey.
 * Matches against stxPublicKey or btcPublicKey fields.
 * Returns the agent's STX address if found.
 */
async function lookupAibtcRegistry(recipientHexPubkey) {
  try {
    const resp = await fetch(AIBTC_API);
    if (!resp.ok) return null;
    const data = await resp.json();
    const agents = data.agents || data || [];

    if (!Array.isArray(agents)) return null;

    for (const agent of agents) {
      // Match by public key (stx or btc, with or without 02/03 prefix)
      const stxPk = agent.stxPublicKey || '';
      const btcPk = agent.btcPublicKey || '';

      // Nostr hex pubkey is 32 bytes (64 chars) x-only
      // Stacks/BTC pubkeys are 33 bytes (66 chars) compressed (02/03 prefix)
      // Match if the x-only part matches (last 64 chars of compressed key)
      const matchesStx = stxPk.length === 66 && stxPk.slice(2) === recipientHexPubkey;
      const matchesBtc = btcPk.length === 66 && btcPk.slice(2) === recipientHexPubkey;
      const exactMatch = stxPk === recipientHexPubkey || btcPk === recipientHexPubkey;

      if (matchesStx || matchesBtc || exactMatch) {
        return {
          address: agent.stxAddress,
          type: 'stx',
          source: 'aibtc-registry',
          agentName: agent.displayName || agent.name || null,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch kind 0 profile from a single relay via WebSocket.
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
          try { resolve(JSON.parse(msg[2].content)); } catch { resolve(null); }
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
