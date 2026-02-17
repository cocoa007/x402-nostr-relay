/**
 * In-memory event store with NIP-01 filter querying.
 */

import { matchFilter } from './filters.mjs';

export class EventStore {
  constructor() {
    /** @type {Map<string, Object>} id → event */
    this.events = new Map();
  }

  /**
   * Add an event. Returns true if new, false if duplicate.
   * Handles NIP-01 replaceable events (kinds 0, 3, 10000-19999):
   * keep only the latest per (pubkey, kind).
   * Also handles parameterized replaceable (30000-39999) by (pubkey, kind, d-tag).
   */
  add(event) {
    if (this.events.has(event.id)) return false;

    // Replaceable events
    if (event.kind === 0 || event.kind === 3 ||
        (event.kind >= 10000 && event.kind < 20000)) {
      for (const [id, existing] of this.events) {
        if (existing.pubkey === event.pubkey && existing.kind === event.kind) {
          if (existing.created_at >= event.created_at) return false; // older, reject
          this.events.delete(id);
        }
      }
    }

    // Parameterized replaceable
    if (event.kind >= 30000 && event.kind < 40000) {
      const dTag = (event.tags || []).find(t => t[0] === 'd')?.[1] || '';
      for (const [id, existing] of this.events) {
        if (existing.pubkey === event.pubkey && existing.kind === event.kind) {
          const existingD = (existing.tags || []).find(t => t[0] === 'd')?.[1] || '';
          if (existingD === dTag) {
            if (existing.created_at >= event.created_at) return false;
            this.events.delete(id);
          }
        }
      }
    }

    // Ephemeral events (20000-29999) — deliver but don't store
    if (event.kind >= 20000 && event.kind < 30000) {
      return true; // signal "accepted" but don't persist
    }

    this.events.set(event.id, event);
    return true;
  }

  /**
   * Query events matching a NIP-01 filter.
   * Returns array sorted by created_at descending, respecting limit.
   */
  query(filter) {
    const results = [];
    for (const event of this.events.values()) {
      if (matchFilter(event, filter)) {
        results.push(event);
      }
    }
    results.sort((a, b) => b.created_at - a.created_at);
    if (filter.limit != null && filter.limit > 0) {
      return results.slice(0, filter.limit);
    }
    return results;
  }

  get size() {
    return this.events.size;
  }
}
