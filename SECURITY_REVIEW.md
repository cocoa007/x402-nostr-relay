# Security Review: x402 Nostr Relay

Repository: `cocoa007/x402-nostr-relay`  
Scope reviewed: x402 payment verification, NIP-01 handling, event store logic, and general security posture.

## Executive Summary

I found **2 high-impact issues** and **3 medium/low-risk issues**.

- **High 1:** Contract-call payment verification accepts any fungible transfer event to relay address without enforcing the asset is sBTC.
- **High 2:** Replay protection in `x402.mjs` uses in-memory `Set` and is lost on process restart, enabling tx reuse after restart.

## Findings

### 1) Missing asset identifier validation for contract-call transfers (High)

**Location:** `src/x402.mjs` (`verifyPayment` contract_call branch)

The code accepts a transfer event if:
- event type looks like fungible transfer
- `asset_event_type === transfer`
- recipient is relay `PAY_TO`

But it does **not** validate the token contract/asset identifier is actually **sBTC**. A transfer of another fungible token to the relay address can satisfy the current check and be treated as valid payment.

**Impact:** Payment bypass using non-sBTC asset.

**Recommendation:** Require an allowlist match on asset identifier (e.g., exact sBTC asset ID) before accepting amount.

---

### 2) Replay protection is process-local and reset on restart (High)

**Location:** `src/x402.mjs` (`usedTxIds` Set)

Replay tracking is held in memory only. Restarting the service clears this set, allowing previously-used tx IDs to be re-submitted.

`src/store.mjs` already defines a `used_tx_ids` SQLite table and helper methods, but `verifyPayment` does not use persistent tracking.

**Impact:** Replay vulnerability after restart/failover.

**Recommendation:** Check/mark tx IDs via persistent store (SQLite table) in an atomic flow.

---

### 3) No confirmation depth / finality threshold check (Medium)

**Location:** `src/x402.mjs` (`verifyPayment`)

A tx is accepted when `tx_status === success` without explicit confirmation/finality policy.

**Impact:** Potential acceptance risk around short-lived reorg/finality edge cases depending on chain/API semantics.

**Recommendation:** Enforce minimum confirmation depth or finalized-state criteria before accepting payment.

---

### 4) HTTP anti-abuse/rate limits not evident on paid endpoint (Medium)

**Location:** `/api/events` flow (reviewed via relay/payment code)

No explicit rate limit/throttling guard is visible for repeated invalid proof submissions.

**Impact:** Resource pressure and verification endpoint abuse.

**Recommendation:** Add IP/key-based rate limiting and request-size limits for payment verification path.

---

### 5) Input trust assumptions around tx payload fields (Low)

The parser handles amount with `BigInt` safely, but additional schema validation for expected fields/types would harden behavior against malformed API responses.

**Recommendation:** Strict schema check for tx structure before business logic.

## NIP-01 / Event Store Notes

- Relay websocket behavior (`REQ`, `CLOSE`, `EOSE`) is broadly aligned with basic NIP-01 relay semantics.
- Event store replaceable / parameterized replaceable handling is directionally correct.
- Ephemeral kinds are correctly not persisted.

## Suggested Next Patch Order

1. Enforce sBTC asset identifier checks in `verifyPayment`.
2. Move replay protection to persistent DB (`used_tx_ids`) and remove process-local-only trust.
3. Add confirmation/finality threshold.
4. Add rate limiting on payment verification endpoint.

---

Prepared for bounty issue: https://github.com/cocoa007/x402-nostr-relay/issues/1
