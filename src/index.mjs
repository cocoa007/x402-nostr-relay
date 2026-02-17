/**
 * x402 Nostr Relay — Entry point.
 * 
 * - WebSocket relay on port 7777 (NIP-01, free reads)
 * - HTTP server on port 7778 (x402 gated EVENT publishing)
 */

import http from 'node:http';
import { Relay } from './relay.mjs';
import { EventStore } from './store.mjs';
import { build402Response, extractPayment, verifyPayment, getPrice } from './x402.mjs';

const WS_PORT = parseInt(process.env.WS_PORT || '7777');
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '7778');

const store = new EventStore();
const relay = new Relay({ store });

// --- WebSocket relay ---
relay.listen(WS_PORT);
console.log(`⚡ WebSocket relay listening on ws://localhost:${WS_PORT}`);

// --- HTTP server for x402-gated event publishing ---
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

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'x402-nostr-relay',
      version: '0.1.0',
      description: 'Nostr relay with x402 sBTC payment gate',
      supported_nips: [1],
      events_stored: store.size,
      ws_endpoint: `ws://localhost:${WS_PORT}`,
      http_endpoint: `http://localhost:${HTTP_PORT}/api/events`,
    }));
    return;
  }

  // POST /api/events — x402 gated event publishing
  if (req.method === 'POST' && req.url === '/api/events') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let event;
    try {
      event = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!event.id || !event.pubkey || event.kind == null || !event.sig) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid event: missing required fields' }));
      return;
    }

    // Check for payment proof
    const txId = extractPayment(req.headers);

    if (!txId) {
      // No payment — return 402
      const resp = build402Response(event);
      res.writeHead(402, resp.headers);
      res.end(JSON.stringify(resp.body));
      return;
    }

    // Verify payment
    const priceSats = getPrice(event.kind);
    const verification = await verifyPayment(txId, priceSats);

    if (!verification.valid) {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Payment verification failed',
        detail: verification.error,
      }));
      return;
    }

    // Payment verified — inject event
    const added = relay.injectEvent(event);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      event_id: event.id,
      added,
      message: added ? 'Event published and broadcast' : 'Duplicate event',
    }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`💰 HTTP server (x402 gate) listening on http://localhost:${HTTP_PORT}`);
  console.log(`   POST /api/events — publish events (x402 sBTC payment required)`);
  console.log(`   GET  /           — relay info`);
});

export { relay, httpServer, store };
