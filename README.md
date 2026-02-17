# x402 Nostr Relay

A Nostr relay that gates EVENT writes behind **x402 sBTC micropayments**. Reading is free, writing costs sats.

## Architecture

- **WebSocket** (`ws://localhost:7777`) — Standard NIP-01 relay for subscriptions (REQ, CLOSE). Free.
- **HTTP** (`http://localhost:7778`) — x402-gated endpoint for publishing events. Pay sBTC to write.

## Quick Start

```bash
npm install
npm start
```

## Endpoints

### WebSocket (port 7777)

Standard NIP-01 protocol:
- `REQ` — Subscribe to events (free)
- `CLOSE` — Close subscription
- `EVENT` — Submit events (accepted directly over WS for dev/testing)

### HTTP (port 7778)

- `GET /` — Relay info
- `POST /api/events` — Publish a Nostr event (x402 payment required)

### Publishing via HTTP

```bash
# First request returns 402 with payment details
curl -X POST http://localhost:7778/api/events \
  -H "Content-Type: application/json" \
  -d '{"id":"...","pubkey":"...","kind":1,"content":"hello","tags":[],"sig":"..."}'

# After paying, include tx proof
curl -X POST http://localhost:7778/api/events \
  -H "Content-Type: application/json" \
  -H "X-Payment-Response: {\"txId\":\"0x...\"}" \
  -d '{"id":"...","pubkey":"...","kind":1,"content":"hello","tags":[],"sig":"..."}'
```

## Pricing

| Kind | Cost | Description |
|------|------|-------------|
| 0 | 50 sats | Profile metadata |
| 1 | 10 sats | Text note |
| 4 | 5 sats | Encrypted DM |
| 30023 | 25 sats | Long-form content |
| Other | 10 sats | Default |

## Payment

Payments are sBTC on Stacks, verified via the Hiro Stacks API.

**Pay-to address:** `SP16H0KE0BPR4XNQ64115V5Y1V3XTPGMWG5YPC9TR`

## Environment Variables

- `WS_PORT` — WebSocket port (default: 7777)
- `HTTP_PORT` — HTTP port (default: 7778)

## Testing

```bash
npm test
```

## License

MIT
