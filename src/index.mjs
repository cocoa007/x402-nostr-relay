/**
 * x402 Nostr Relay — Entry point.
 * 
 * Single-port: HTTP + WebSocket on the same port.
 * - WebSocket: NIP-01 relay (free reads, writes rejected → use HTTP)
 * - HTTP POST /api/events: x402 gated EVENT publishing
 *     → events with 'p' tags cost extra; surplus forwarded to recipient
 * - HTTP GET /api/payouts: pending recipient payouts
 * - HTTP GET /: relay info
 */

import http from 'node:http';
import { Relay } from './relay.mjs';
import { EventStore } from './store.mjs';
import {
  build402Response, extractPayment, verifyPayment,
  getPrice, getRecipient, RELAY_FEE, RECIPIENT_AMOUNT,
} from './x402.mjs';
import { lookupPaymentAddress, recordPendingPayout, getPendingPayouts } from './messages.mjs';

const PORT = parseInt(process.env.PORT || '8080');
const store = new EventStore();
const relay = new Relay({ store });

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const httpServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment, X-Payment-Response');
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET / — relay info
  if (req.method === 'GET' && req.url === '/') {
    json(res, 200, {
      name: 'x402-nostr-relay',
      version: '0.3.0',
      description: 'Nostr relay with x402 sBTC payment gate. Events targeting a recipient (p tag) include a forwarding fee — recipient gets paid.',
      supported_nips: [1],
      events_stored: store.size,
      endpoints: {
        ws: 'wss://x402-nostr-relay.fly.dev',
        events: 'https://x402-nostr-relay.fly.dev/api/events',
        payouts: 'https://x402-nostr-relay.fly.dev/api/payouts',
      },
      pricing: {
        description: 'Base relay fee by event kind. Events with a p tag add 100 sats forwarded to recipient.',
        relayFee: 'varies by kind (5-50 sats)',
        recipientForward: RECIPIENT_AMOUNT,
        examples: {
          'kind 1 (text note)': '10 sats',
          'kind 1 with p tag': `${10 + RECIPIENT_AMOUNT} sats (10 relay + ${RECIPIENT_AMOUNT} to recipient)`,
          'kind 4 (DM)': `${5 + RECIPIENT_AMOUNT} sats (5 relay + ${RECIPIENT_AMOUNT} to recipient)`,
        },
      },
    });
    return;
  }

  // GET /api/payouts — pending recipient payouts
  if (req.method === 'GET' && req.url === '/api/payouts') {
    json(res, 200, { payouts: getPendingPayouts() });
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

    // Verify payment — price depends on whether event has a recipient
    const totalPrice = getPrice(event);
    const verification = await verifyPayment(txId, totalPrice);

    if (!verification.valid) {
      json(res, 402, { error: 'Payment verification failed', detail: verification.error });
      return;
    }

    // Store and broadcast
    const added = relay.injectEvent(event);

    // If event targets a recipient, look up their payment address and record payout
    const recipientHex = getRecipient(event);
    let forwarding = null;

    if (recipientHex) {
      let paymentAddress = null;
      try {
        paymentAddress = await lookupPaymentAddress(recipientHex);
      } catch {}

      const payout = recordPendingPayout(recipientHex, paymentAddress, RECIPIENT_AMOUNT, event.id);

      forwarding = paymentAddress
        ? { status: 'pending', address: paymentAddress.address, type: paymentAddress.type, amount: RECIPIENT_AMOUNT }
        : { status: 'held', reason: 'No payment address in Nostr profile', claimable: true, pendingTotal: payout.amount };
    }

    json(res, 200, {
      ok: true,
      event_id: event.id,
      added,
      message: added ? 'Event published and broadcast' : 'Duplicate event',
      ...(forwarding ? { forwarding } : {}),
    });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

relay.attach(httpServer);

httpServer.listen(PORT, () => {
  console.log(`⚡ x402 Nostr Relay v0.3.0 on port ${PORT}`);
  console.log(`   WS:      ws://localhost:${PORT} (free reads)`);
  console.log(`   Events:  http://localhost:${PORT}/api/events (x402 gated)`);
  console.log(`   Payouts: http://localhost:${PORT}/api/payouts`);
});

export { relay, httpServer, store };
