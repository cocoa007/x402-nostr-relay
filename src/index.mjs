/**
 * x402 Nostr Relay — Entry point.
 * 
 * Single-port deployment: HTTP + WebSocket on the same port.
 * - WebSocket: NIP-01 relay (free reads, writes rejected → use HTTP)
 * - HTTP POST /api/events: x402 gated EVENT publishing
 * - HTTP POST /api/messages: paid messaging with payment forwarding
 * - HTTP GET /api/payouts: pending payouts list
 * - HTTP GET /: relay info
 */

import http from 'node:http';
import { Relay } from './relay.mjs';
import { EventStore } from './store.mjs';
import { build402Response, extractPayment, verifyPayment, getPrice } from './x402.mjs';
import {
  buildMessage402Response,
  lookupPaymentAddress,
  npubToHex,
  recordPendingPayout,
  getPendingPayouts,
  TOTAL_PRICE,
  RELAY_FEE,
  RECIPIENT_AMOUNT,
} from './messages.mjs';

const PORT = parseInt(process.env.PORT || process.env.HTTP_PORT || '8080');

const store = new EventStore();
const relay = new Relay({ store });

/** Read full request body as string. */
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

/** Send JSON response. */
function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

// --- Single HTTP server ---
const httpServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment, X-Payment-Response');
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- GET / — relay info ---
  if (req.method === 'GET' && req.url === '/') {
    json(res, 200, {
      name: 'x402-nostr-relay',
      version: '0.2.0',
      description: 'Nostr relay with x402 sBTC payment gate + paid messaging',
      supported_nips: [1],
      events_stored: store.size,
      endpoints: {
        ws: 'wss://x402-nostr-relay.fly.dev',
        events: 'https://x402-nostr-relay.fly.dev/api/events',
        messages: 'https://x402-nostr-relay.fly.dev/api/messages',
        payouts: 'https://x402-nostr-relay.fly.dev/api/payouts',
      },
      messaging: {
        totalPrice: TOTAL_PRICE,
        relayFee: RELAY_FEE,
        recipientAmount: RECIPIENT_AMOUNT,
        asset: 'sBTC',
        description: 'Send a paid Nostr message. Recipient gets 100 sats, relay keeps 5 sats.',
      },
    });
    return;
  }

  // --- GET /api/payouts — list pending payouts ---
  if (req.method === 'GET' && req.url === '/api/payouts') {
    json(res, 200, { payouts: getPendingPayouts() });
    return;
  }

  // --- POST /api/messages — paid messaging with forwarding ---
  if (req.method === 'POST' && req.url === '/api/messages') {
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { recipientNpub, content, senderPubkey, event } = payload;

    // Validate required fields
    if (!recipientNpub) {
      json(res, 400, { error: 'Missing recipientNpub' });
      return;
    }
    if (!content && !event) {
      json(res, 400, { error: 'Missing content or event' });
      return;
    }

    // Decode npub to hex
    const recipientHex = npubToHex(recipientNpub);
    if (!recipientHex) {
      json(res, 400, { error: 'Invalid npub format' });
      return;
    }

    // Check for payment proof
    const txId = extractPayment(req.headers);

    if (!txId) {
      // No payment — return 402
      const resp = buildMessage402Response(recipientNpub);
      res.writeHead(402, resp.headers);
      res.end(JSON.stringify(resp.body));
      return;
    }

    // Verify payment (105 sats total)
    const verification = await verifyPayment(txId, TOTAL_PRICE);
    if (!verification.valid) {
      json(res, 402, {
        error: 'Payment verification failed',
        detail: verification.error,
      });
      return;
    }

    // Payment verified! Look up recipient's payment address
    let paymentAddress = null;
    let lookupError = null;
    try {
      paymentAddress = await lookupPaymentAddress(recipientHex);
    } catch (err) {
      lookupError = err.message;
    }

    // Build event if not provided
    let nostrEvent = event;
    if (!nostrEvent) {
      // Create a kind 1 text note (kind 4 would need encryption)
      nostrEvent = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        pubkey: senderPubkey || 'relay-generated',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['p', recipientHex]],
        content: content,
        sig: 'relay-generated',
      };
    }

    // Store and broadcast the event
    const added = relay.injectEvent(nostrEvent);

    // Record payout
    const payout = recordPendingPayout(
      recipientHex,
      recipientNpub,
      paymentAddress,
      nostrEvent.id
    );

    // Build response
    const response = {
      ok: true,
      message: 'Message sent and payment recorded',
      event_id: nostrEvent.id,
      event_added: added,
      payment: {
        txId,
        totalPaid: TOTAL_PRICE,
        relayFee: RELAY_FEE,
        recipientAmount: RECIPIENT_AMOUNT,
      },
      recipient: {
        npub: recipientNpub,
        pubkey: recipientHex,
      },
      forwarding: paymentAddress
        ? {
            status: 'pending',
            address: paymentAddress.address,
            type: paymentAddress.type,
            source: paymentAddress.source,
            amount: RECIPIENT_AMOUNT,
          }
        : {
            status: 'held',
            reason: lookupError || 'No payment address found in Nostr profile',
            claimable: true,
            pendingTotal: payout.amount,
          },
    };

    json(res, 200, response);
    return;
  }

  // --- POST /api/events — x402 gated event publishing ---
  if (req.method === 'POST' && req.url === '/api/events') {
    const body = await readBody(req);
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return;
    }

    if (!event.id || !event.pubkey || event.kind == null || !event.sig) {
      json(res, 400, { error: 'Invalid event: missing required fields' });
      return;
    }

    const txId = extractPayment(req.headers);

    if (!txId) {
      const resp = build402Response(event);
      res.writeHead(402, resp.headers);
      res.end(JSON.stringify(resp.body));
      return;
    }

    const priceSats = getPrice(event.kind);
    const verification = await verifyPayment(txId, priceSats);

    if (!verification.valid) {
      json(res, 402, {
        error: 'Payment verification failed',
        detail: verification.error,
      });
      return;
    }

    const added = relay.injectEvent(event);
    json(res, 200, {
      ok: true,
      event_id: event.id,
      added,
      message: added ? 'Event published and broadcast' : 'Duplicate event',
    });
    return;
  }

  // 404
  json(res, 404, { error: 'Not found' });
});

// Attach WebSocket relay to the same HTTP server
relay.attach(httpServer);

httpServer.listen(PORT, () => {
  console.log(`⚡ x402 Nostr Relay v0.2.0 running on port ${PORT}`);
  console.log(`   WS:       ws://localhost:${PORT} (NIP-01, free reads)`);
  console.log(`   Events:   http://localhost:${PORT}/api/events (x402 gated writes)`);
  console.log(`   Messages: http://localhost:${PORT}/api/messages (paid DMs, 105 sats)`);
  console.log(`   Payouts:  http://localhost:${PORT}/api/payouts`);
  console.log(`   Info:     http://localhost:${PORT}/`);
});

export { relay, httpServer, store };
