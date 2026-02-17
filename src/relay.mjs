/**
 * WebSocket relay implementing NIP-01.
 * Handles EVENT, REQ, CLOSE messages.
 * Reading is free; writing is done via HTTP /api/events (x402 gated).
 */

import { WebSocketServer } from 'ws';
import { EventStore } from './store.mjs';
import { matchFilters } from './filters.mjs';

export class Relay {
  /**
   * @param {Object} opts
   * @param {EventStore} opts.store
   */
  constructor({ store }) {
    this.store = store;
    /** @type {Map<WebSocket, Map<string, Object[]>>} ws → (subId → filters[]) */
    this.subscriptions = new Map();
  }

  /**
   * Attach to an HTTP server (for upgrade) or create standalone WSS.
   */
  attach(server) {
    this.wss = new WebSocketServer({ server });
    this._setup();
    return this;
  }

  listen(port) {
    this.wss = new WebSocketServer({ port });
    this._setup();
    return this;
  }

  _setup() {
    this.wss.on('connection', (ws) => {
      this.subscriptions.set(ws, new Map());

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          ws.send(JSON.stringify(['NOTICE', 'invalid JSON']));
          return;
        }
        if (!Array.isArray(msg) || msg.length < 2) {
          ws.send(JSON.stringify(['NOTICE', 'invalid message format']));
          return;
        }
        this._handleMessage(ws, msg);
      });

      ws.on('close', () => {
        this.subscriptions.delete(ws);
      });
    });
  }

  _handleMessage(ws, msg) {
    const type = msg[0];

    switch (type) {
      case 'EVENT': {
        const eventId = msg[1]?.id || '';
        ws.send(JSON.stringify([
          'OK',
          eventId,
          false,
          'payment-required: publish via HTTP POST /api/events',
        ]));
        break;
      }

      case 'REQ': {
        const subId = msg[1];
        if (typeof subId !== 'string') {
          ws.send(JSON.stringify(['NOTICE', 'invalid subscription ID']));
          return;
        }
        const filters = msg.slice(2);
        if (filters.length === 0) {
          ws.send(JSON.stringify(['NOTICE', 'no filters provided']));
          return;
        }

        // Store subscription
        const subs = this.subscriptions.get(ws);
        subs.set(subId, filters);

        // Send stored events matching filters
        for (const filter of filters) {
          const events = this.store.query(filter);
          for (const event of events) {
            ws.send(JSON.stringify(['EVENT', subId, event]));
          }
        }
        // End of stored events
        ws.send(JSON.stringify(['EOSE', subId]));
        break;
      }

      case 'CLOSE': {
        const subId = msg[1];
        const subs = this.subscriptions.get(ws);
        if (subs) subs.delete(subId);
        break;
      }

      default:
        ws.send(JSON.stringify(['NOTICE', `unknown message type: ${type}`]));
    }
  }

  /**
   * Broadcast an event to all subscribers with matching filters.
   */
  _broadcast(event) {
    for (const [ws, subs] of this.subscriptions) {
      if (ws.readyState !== 1) continue; // OPEN
      for (const [subId, filters] of subs) {
        if (matchFilters(event, filters)) {
          ws.send(JSON.stringify(['EVENT', subId, event]));
        }
      }
    }
  }

  /**
   * Inject an event from the HTTP endpoint (after payment verified).
   */
  injectEvent(event) {
    const added = this.store.add(event);
    if (added) {
      this._broadcast(event);
    }
    return added;
  }

  close() {
    if (this.wss) this.wss.close();
  }
}
