/**
 * Tests for the x402 Nostr relay.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchFilter, matchFilters } from '../src/filters.mjs';
import { EventStore } from '../src/store.mjs';
import { Relay } from '../src/relay.mjs';
import {
  build402Response, getPrice, getBasePrice, getRecipient,
  verifyPayment, RELAY_FEE, RECIPIENT_AMOUNT,
} from '../src/x402.mjs';
import { recordPendingPayout, getPendingPayouts } from '../src/messages.mjs';

const makeEvent = (overrides = {}) => ({
  id: 'abc123def456',
  pubkey: 'deadbeef01234567',
  kind: 1,
  created_at: 1700000000,
  content: 'hello world',
  tags: [],
  sig: 'sig123',
  ...overrides,
});

describe('filters', () => {
  it('matches empty filter (matches all)', () => {
    assert.ok(matchFilter(makeEvent(), {}));
  });

  it('matches by ids prefix', () => {
    assert.ok(matchFilter(makeEvent(), { ids: ['abc'] }));
    assert.ok(!matchFilter(makeEvent(), { ids: ['xyz'] }));
  });

  it('matches by authors prefix', () => {
    assert.ok(matchFilter(makeEvent(), { authors: ['dead'] }));
    assert.ok(!matchFilter(makeEvent(), { authors: ['cafe'] }));
  });

  it('matches by kinds', () => {
    assert.ok(matchFilter(makeEvent(), { kinds: [1, 4] }));
    assert.ok(!matchFilter(makeEvent(), { kinds: [0] }));
  });

  it('matches by since/until', () => {
    assert.ok(matchFilter(makeEvent(), { since: 1699999999 }));
    assert.ok(!matchFilter(makeEvent(), { since: 1700000001 }));
    assert.ok(matchFilter(makeEvent(), { until: 1700000001 }));
    assert.ok(!matchFilter(makeEvent(), { until: 1699999999 }));
  });

  it('matches tag filters (#e, #p)', () => {
    const event = makeEvent({ tags: [['e', 'event1'], ['p', 'pubkey1']] });
    assert.ok(matchFilter(event, { '#e': ['event1'] }));
    assert.ok(!matchFilter(event, { '#e': ['event2'] }));
    assert.ok(matchFilter(event, { '#p': ['pubkey1'] }));
  });

  it('combines filters with AND', () => {
    assert.ok(matchFilter(makeEvent(), { ids: ['abc'], kinds: [1] }));
    assert.ok(!matchFilter(makeEvent(), { ids: ['abc'], kinds: [0] }));
  });

  it('matchFilters OR across filters', () => {
    assert.ok(matchFilters(makeEvent(), [{ kinds: [0] }, { kinds: [1] }]));
    assert.ok(!matchFilters(makeEvent(), [{ kinds: [0] }, { kinds: [2] }]));
  });
});

describe('EventStore', () => {
  it('adds and queries events', () => {
    const store = new EventStore();
    const e = makeEvent();
    assert.ok(store.add(e));
    assert.equal(store.size, 1);
    const results = store.query({ kinds: [1] });
    assert.equal(results.length, 1);
  });

  it('rejects duplicates', () => {
    const store = new EventStore();
    assert.ok(store.add(makeEvent()));
    assert.ok(!store.add(makeEvent()));
    assert.equal(store.size, 1);
  });

  it('replaces replaceable events', () => {
    const store = new EventStore();
    store.add(makeEvent({ id: 'old', kind: 0, created_at: 100, pubkey: 'aaa' }));
    store.add(makeEvent({ id: 'new', kind: 0, created_at: 200, pubkey: 'aaa' }));
    assert.equal(store.size, 1);
    assert.equal(store.query({})[0].id, 'new');
  });

  it('respects limit', () => {
    const store = new EventStore();
    for (let i = 0; i < 10; i++) store.add(makeEvent({ id: `id${i}`, created_at: 1000 + i }));
    assert.equal(store.query({ limit: 3 }).length, 3);
  });

  it('returns results sorted desc by created_at', () => {
    const store = new EventStore();
    store.add(makeEvent({ id: 'a', created_at: 100 }));
    store.add(makeEvent({ id: 'b', created_at: 300 }));
    store.add(makeEvent({ id: 'c', created_at: 200 }));
    const r = store.query({});
    assert.deepEqual(r.map(e => e.id), ['b', 'c', 'a']);
  });
});

describe('x402', () => {
  it('returns correct base pricing', () => {
    assert.equal(getBasePrice(0), 50);
    assert.equal(getBasePrice(1), 10);
    assert.equal(getBasePrice(4), 5);
    assert.equal(getBasePrice(999), 10);
  });

  it('getPrice returns base for events without p tag', () => {
    assert.equal(getPrice(makeEvent({ kind: 1 })), 10);
    assert.equal(getPrice(makeEvent({ kind: 4 })), 5);
  });

  it('getPrice adds recipient amount for events with p tag', () => {
    const event = makeEvent({ kind: 1, tags: [['p', 'recipient_hex_pubkey']] });
    assert.equal(getPrice(event), 10 + RECIPIENT_AMOUNT);
  });

  it('getPrice adds recipient amount for DMs with p tag', () => {
    const dm = makeEvent({ kind: 4, tags: [['p', 'recipient_hex_pubkey']] });
    assert.equal(getPrice(dm), 5 + RECIPIENT_AMOUNT);
  });

  it('getRecipient extracts p tag', () => {
    assert.equal(getRecipient(makeEvent({ tags: [['p', 'abc123']] })), 'abc123');
    assert.equal(getRecipient(makeEvent({ tags: [] })), null);
    assert.equal(getRecipient(makeEvent({ tags: [['e', 'xyz']] })), null);
  });

  it('builds 402 response with recipient breakdown when p tag present', () => {
    const event = makeEvent({ kind: 1, tags: [['p', 'deadbeef']] });
    const resp = build402Response(event);
    assert.equal(resp.status, 402);
    assert.equal(resp.body.price, 10 + RECIPIENT_AMOUNT);
    assert.equal(resp.body.breakdown.relayFee, 10);
    assert.equal(resp.body.breakdown.recipientForward, RECIPIENT_AMOUNT);
    assert.equal(resp.body.breakdown.recipientPubkey, 'deadbeef');
  });

  it('builds 402 response without breakdown when no p tag', () => {
    const resp = build402Response(makeEvent({ kind: 1 }));
    assert.equal(resp.body.price, 10);
    assert.equal(resp.body.breakdown, undefined);
  });

  it('rejects underpaid token_transfer transactions', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        tx_status: 'success',
        tx_type: 'token_transfer',
        token_transfer: {
          recipient_address: 'SP16H0KE0BPR4XNQ64115V5Y1V3XTPGMWG5YPC9TR',
          amount: '1',
        },
      }),
    });
    try {
      const result = await verifyPayment('0x-underpay-test-v3', 50);
      assert.equal(result.valid, false);
      assert.match(result.error, /Insufficient payment/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects unknown successful transaction types', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ tx_status: 'success', tx_type: 'smart_contract' }),
    });
    try {
      const result = await verifyPayment('0x-unknown-type-v3', 10);
      assert.equal(result.valid, false);
      assert.match(result.error, /Unsupported transaction type/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Relay', () => {
  it('rejects EVENT writes over websocket', () => {
    const store = new EventStore();
    const relay = new Relay({ store });
    const ws = { sent: [], readyState: 1, send(msg) { this.sent.push(msg); } };
    relay.subscriptions.set(ws, new Map());
    relay._handleMessage(ws, ['EVENT', makeEvent()]);
    assert.equal(store.size, 0);
    assert.deepEqual(
      JSON.parse(ws.sent[0]),
      ['OK', 'abc123def456', false, 'payment-required: publish via HTTP POST /api/events']
    );
  });
});

describe('payouts', () => {
  it('records and retrieves pending payouts', () => {
    recordPendingPayout('aabbccdd', null, 100, 'evt-001');
    recordPendingPayout('aabbccdd', { address: 'SP1...', type: 'stx' }, 100, 'evt-002');
    const payouts = getPendingPayouts();
    const entry = payouts.find(p => p.pubkey === 'aabbccdd');
    assert.ok(entry);
    assert.equal(entry.amount, 200);
    assert.deepEqual(entry.messages, ['evt-001', 'evt-002']);
    assert.equal(entry.paymentAddress.type, 'stx');
  });
});

console.log('All tests defined. Running...');
