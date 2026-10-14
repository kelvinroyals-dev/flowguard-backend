# Realtime security — local implementation

Nothing committed, pushed or deployed. Operations changes are in the sibling staging/operations checkout.

## Changes

- Missing, invalid, expired or revoked JWTs no longer connect. Handshake auth token or Bearer header only; URL-query tokens are rejected.
- Session validity is checked against the live user record (active state, token version and database role), at connect, subscription, event delivery and every 60 seconds while idle. Database failures deny access rather than fail open. Expired sessions cannot receive an event even before the idle timer disconnects them.
- Internal alerts/reports/sensors/teams topics have an explicit permission allowlist. Clients and providers cannot join them; unknown roles/room names do not gain access.
- Clients may subscribe to estate:<property_id> only with monitoring permission and organization ownership (account owner or permitted member). Ownership and staff permission changes are rechecked at delivery. Provider estate subscriptions remain denied until a dedicated scoped provider contract is implemented.
- Outgoing events contain identifiers plus refresh:true, not raw reports, contacts, notes or sensor records. Client estate messages use estate:changed with the estate ID only. Consumers must use scoped REST reads for contents.
- There is no default broadcast-to-everyone behavior. Events without a supported topic are dropped. Events without a property ID cannot produce an estate invalidation; no ownership/location is guessed.
- Subscription attempts and message size are bounded. Existing internal event names are retained. Reports UI waits for a successful subscription acknowledgement before showing connected.

## Verification

Run with installed backend dependencies (or set NODE_PATH to the existing local backend/node_modules):

    node --test scripts/test-realtime-unit.cjs
    node scripts/bootcheck.js
    node --check realtime/io.js

Transport-stub unit tests use real JWT signatures, fake users/ownership and no network/database. Cover missing/invalid/expired JWTs, unknown/deactivated/revoked accounts, database failure, forbidden topics, tenant isolation, ownership changes, permission changes and stripped event payloads. Backend bootcheck and operations redesign/review-regression suites passed.

The real Socket.IO loopback integration test is provided:

    node --test scripts/test-realtime-security.cjs

It uses real local WebSocket connections and stubbed database responses. The initial sandbox restriction was resolved and this integration test PASSes in the 14 October local-readiness run. No production connections or configured database were used. See ESTATE-OPERATIONS-RELEASE-GATES-2026-10-13.md for remaining rollout requirements.

## Compatibility and remaining gates

- Existing field-reports UI already uses handshake auth and refreshes through REST; it does not depend on raw event bodies. Any external/legacy consumers must be checked before changing the production event contract.
- Clients are not automatically subscribed or granted new UI capabilities in this batch. This establishes a scoped invalidation contract; client/provider wiring and active membership/delegated-owner semantics require separate tests.
- Routing currently requires an explicit property_id. Asset-to-estate/sensor-to-estate resolution needs canonical backend ownership mapping; missing metadata deliberately produces no client push.
- Delivery is implemented for the existing single-process in-memory adapter. Distributed workers/Redis need equivalent authorization-aware delivery and cross-process session/permission invalidation before enabling that deployment mode.
- Permission evaluation reuses the existing REST permission system and its default/override semantics; this does not redesign permission persistence or REST authentication.
- Before deployment: complete the real loopback test, signed-in role matrix, password-reset/deactivation and ownership-change tests, producer metadata audit and consumer compatibility check. Client-visible report release rules must still be enforced by REST even when an estate refresh signal arrives.

Next implementation priority remains a shared backend estate-weather service and removal of the global Lagos input from per-estate risk forecasts.
