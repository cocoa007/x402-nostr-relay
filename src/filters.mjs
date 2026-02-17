/**
 * NIP-01 filter matching logic.
 * A filter matches an event if ALL specified fields match.
 * Within a field (e.g. ids), any match suffices (OR).
 */

/**
 * Check if an event matches a single filter.
 * @param {Object} event - Nostr event
 * @param {Object} filter - NIP-01 filter
 * @returns {boolean}
 */
export function matchFilter(event, filter) {
  // ids — match event id prefix
  if (filter.ids && filter.ids.length > 0) {
    if (!filter.ids.some(id => event.id.startsWith(id))) return false;
  }

  // authors — match pubkey prefix
  if (filter.authors && filter.authors.length > 0) {
    if (!filter.authors.some(a => event.pubkey.startsWith(a))) return false;
  }

  // kinds
  if (filter.kinds && filter.kinds.length > 0) {
    if (!filter.kinds.includes(event.kind)) return false;
  }

  // since
  if (filter.since != null && event.created_at < filter.since) return false;

  // until
  if (filter.until != null && event.created_at > filter.until) return false;

  // Generic tag filters: #e, #p, etc.
  for (const key of Object.keys(filter)) {
    if (key.startsWith('#') && key.length === 2) {
      const tagName = key[1];
      const values = filter[key];
      if (values && values.length > 0) {
        const eventTagValues = (event.tags || [])
          .filter(t => t[0] === tagName)
          .map(t => t[1]);
        if (!values.some(v => eventTagValues.includes(v))) return false;
      }
    }
  }

  return true;
}

/**
 * Check if an event matches any filter in an array.
 */
export function matchFilters(event, filters) {
  return filters.some(f => matchFilter(event, f));
}
