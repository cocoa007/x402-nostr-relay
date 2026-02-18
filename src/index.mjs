/**
 * x402 Nostr Relay v0.6.0 — Entry point.
 * 
 * - SQLite persistent storage (survives restarts)
 * - Auto-forwards sBTC to recipients via p-tag
 * - Publishes events to public relays as backup
 * - WebSocket: NIP-01 free reads
 * - HTTP POST /api/events: x402 gated writes
 */

import http from 'node:http';
import { Relay } from './relay.mjs';
import { EventStore } from './store.mjs';
import {
  build402Response, extractPayment, verifyPayment,
  getPrice, getRecipient, RELAY_FEE, RECIPIENT_AMOUNT,
} from './x402.mjs';
import { resolvePaymentAddress, recordPendingPayout, getPendingPayouts } from './messages.mjs';
import { getRelayAddress, getRelayBalance, forwardSbtc, isWalletConfigured } from './wallet.mjs';

const PORT = parseInt(process.env.PORT || '8080');
const store = new EventStore();
const relay = new Relay({ store });

// Public relays to mirror events to
const BACKUP_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
];

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

/**
 * Mirror an event to public backup relays.
 * Best-effort, non-blocking.
 */
async function mirrorToPublicRelays(event) {
  const { WebSocket } = await import('ws');

  for (const relayUrl of BACKUP_RELAYS) {
    try {
      const ws = new WebSocket(relayUrl);
      const timeout = setTimeout(() => { try { ws.close(); } catch {} }, 10000);

      ws.on('open', () => {
        ws.send(JSON.stringify(['EVENT', event]));
        setTimeout(() => { clearTimeout(timeout); ws.close(); }, 2000);
      });

      ws.on('error', () => { clearTimeout(timeout); });
    } catch {}
  }
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment, X-Payment-Response');
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET / — relay info
  if (req.method === 'GET' && req.url === '/') {
    const balance = await getRelayBalance().catch(() => 0);
    json(res, 200, {
      name: 'x402-nostr-relay',
      version: '0.6.0',
      description: 'Nostr relay with x402 sBTC payment gate. Tag someone → they get paid.',
      supported_nips: [1],
      events_stored: store.size,
      wallet: {
        configured: isWalletConfigured(),
        address: getRelayAddress(),
        sbtcBalance: balance,
      },
      endpoints: {
        ws: 'wss://x402-nostr-relay.fly.dev',
        events: 'https://x402-nostr-relay.fly.dev/api/events',
        payouts: 'https://x402-nostr-relay.fly.dev/api/payouts',
      },
      pricing: {
        description: 'Base relay fee by kind. Events with p-tag add 100 sats forwarded to recipient.',
        recipientForward: RECIPIENT_AMOUNT,
        examples: {
          'kind 1 (text note)': '10 sats',
          'kind 1 with p tag': '110 sats (10 relay + 100 to recipient)',
          'kind 4 (DM)': '105 sats (5 relay + 100 to recipient)',
        },
      },
      storage: 'persistent (SQLite)',
      backupRelays: BACKUP_RELAYS,
    });
    return;
  }

  // GET /api/payouts
  if (req.method === 'GET' && req.url === '/api/payouts') {
    json(res, 200, { payouts: store.getAllPayouts?.() || getPendingPayouts() });
    return;
  }

  // GET /api/events?authors=...&kinds=...&limit=... — query stored events
  if (req.method === 'GET' && req.url.startsWith('/api/events')) {
    const url = new URL(req.url, 'http://localhost');
    const filter = {};
    if (url.searchParams.get('authors')) filter.authors = url.searchParams.get('authors').split(',');
    if (url.searchParams.get('kinds')) filter.kinds = url.searchParams.get('kinds').split(',').map(Number);
    if (url.searchParams.get('ids')) filter.ids = url.searchParams.get('ids').split(',');
    if (url.searchParams.get('limit')) filter.limit = parseInt(url.searchParams.get('limit'));
    if (url.searchParams.get('#p')) filter['#p'] = url.searchParams.get('#p').split(',');

    const events = store.query(filter);
    json(res, 200, { events, count: events.length });
    return;
  }

  // POST /api/events — x402 gated event publishing
  if (req.method === 'POST' && req.url === '/api/events') {
    const body = await readBody(req);
    let event;
    try { event = JSON.parse(body); } catch {
      json(res, 400, { error: 'Invalid JSON' }); return;
    }

    if (!event.id || !event.pubkey || event.kind == null || !event.sig) {
      json(res, 400, { error: 'Invalid event: missing required fields' }); return;
    }

    const txId = extractPayment(req.headers);

    if (!txId) {
      const resp = build402Response(event);
      res.writeHead(402, resp.headers);
      res.end(JSON.stringify(resp.body));
      return;
    }

    // Verify payment
    const totalPrice = getPrice(event);
    const verification = await verifyPayment(txId, totalPrice);

    if (!verification.valid) {
      json(res, 402, { error: 'Payment verification failed', detail: verification.error });
      return;
    }

    // Persist tx as used (SQLite)
    store.markTxUsed?.(txId);

    // Store and broadcast locally
    const added = relay.injectEvent(event);

    // Mirror to public relays (async, best-effort)
    mirrorToPublicRelays(event).catch(() => {});

    // Handle recipient forwarding
    const recipientHex = getRecipient(event);
    let forwarding = null;

    if (recipientHex) {
      let paymentAddress = null;
      try {
        paymentAddress = await resolvePaymentAddress(recipientHex);
      } catch {}

      // Record payout in SQLite
      store.recordPayout?.(recipientHex, RECIPIENT_AMOUNT, event.id, paymentAddress);

      // Auto-forward if STX address found and wallet configured
      if (paymentAddress?.type === 'stx' && isWalletConfigured()) {
        const fwd = await forwardSbtc(paymentAddress.address, RECIPIENT_AMOUNT);
        if (fwd.success) {
          store.updatePayoutTx?.(event.id, fwd.txId, 'sent');
          forwarding = { status: 'sent', txId: fwd.txId, address: paymentAddress.address, amount: RECIPIENT_AMOUNT };
        } else {
          store.updatePayoutTx?.(event.id, null, 'failed');
          forwarding = { status: 'failed', error: fwd.error, address: paymentAddress.address, amount: RECIPIENT_AMOUNT };
        }
      } else if (paymentAddress) {
        forwarding = { status: 'pending', address: paymentAddress.address, type: paymentAddress.type, amount: RECIPIENT_AMOUNT };
      } else {
        forwarding = { status: 'held', reason: 'No payment address found', claimable: true };
      }
    }

    json(res, 200, {
      ok: true,
      event_id: event.id,
      added,
      message: added ? 'Event published, broadcast, and mirrored to public relays' : 'Duplicate event',
      ...(forwarding ? { forwarding } : {}),
    });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

relay.attach(httpServer);

httpServer.listen(PORT, () => {
  console.log(`⚡ x402 Nostr Relay v0.6.0 on port ${PORT}`);
  console.log(`   Wallet:  ${getRelayAddress() || 'NOT CONFIGURED'}`);
  console.log(`   Storage: ${store.db ? 'SQLite (persistent)' : 'In-memory'}`);
  console.log(`   Backup:  ${BACKUP_RELAYS.join(', ')}`);
});

export { relay, httpServer, store };
