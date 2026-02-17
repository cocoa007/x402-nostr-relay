/**
 * Basic tests for the x402 Nostr relay.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchFilter, matchFilters } from '../src/filters.mjs';
import { EventStore } from '../src/store.mjs';
import { Relay } from '../src/relay.mjs';
import { build402Response, getPrice, verifyPayment } from '../src/x402.mjs';

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
    assert.equal(results[0].id, 'abc123def456');
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
    for (let i = 0; i < 10; i++) {
      store.add(makeEvent({ id: `id${i}`, created_at: 1000 + i }));
    }
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
  it('returns correct pricing', () => {
    assert.equal(getPrice(0), 50);
    assert.equal(getPrice(1), 10);
    assert.equal(getPrice(4), 5);
    assert.equal(getPrice(999), 10); // default
  });

  it('builds 402 response with correct headers', () => {
    const resp = build402Response(makeEvent({ kind: 1 }));
    assert.equal(resp.status, 402);
    const payment = JSON.parse(resp.headers['X-Payment']);
    assert.equal(payment.scheme, 'x402');
    assert.equal(payment.asset, 'sbtc');
    assert.equal(payment.maxAmountRequired, '10');
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
      const result = await verifyPayment('0x-underpay-test', 50);
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
      json: async () => ({
        tx_status: 'success',
        tx_type: 'smart_contract',
      }),
    });

    try {
      const result = await verifyPayment('0x-unknown-type-test', 10);
      assert.equal(result.valid, false);
      assert.match(result.error, /Unsupported transaction type/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Relay', () => {
  it('rejects EVENT writes over websocket and preserves store state', () => {
    const store = new EventStore();
    const relay = new Relay({ store });
    const ws = {
      sent: [],
      readyState: 1,
      send(msg) {
        this.sent.push(msg);
      },
    };
    relay.subscriptions.set(ws, new Map());

    relay._handleMessage(ws, ['EVENT', makeEvent()]);

    assert.equal(store.size, 0);
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(
      JSON.parse(ws.sent[0]),
      ['OK', 'abc123def456', false, 'payment-required: publish via HTTP POST /api/events']
    );
  });
});

console.log('All tests defined. Running...');
