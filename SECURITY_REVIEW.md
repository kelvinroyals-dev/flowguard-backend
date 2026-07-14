# FlowGuard Backend — Security Review

Date: 2026-07-14
Scope: full read-through of `routes/`, `middleware/`, `utils/`, `server.js`, `config/`. No dynamic testing performed (static code review only) — treat findings as "confirmed by reading the code," not "confirmed by exploiting a running instance."

**Update 2026-07-14: all findings below have been patched** (see git log). `node scripts/bootcheck.js` passes after the changes. This document is kept as-is for the record of what was wrong and why; each section still describes the *original* vulnerable behavior. Two additional instances of the same missing-authorization pattern were found and fixed during the patch pass, not in the original list below: `routes/reports.js` (`GET /`, `POST /generate` — company-wide analytics reports had no ops-only guard) and `routes/fieldReports.js` (`GET /:id`, `PUT /:id`, `POST /:id/send-to-client` — missing ownership/ops checks on inspection reports).

## How the app is supposed to work

`middleware/auth.js` issues/verifies a JWT and attaches `req.user = {id, email, role, user_type}`. `requireRole(...roles)` exists to gate ops-only routes. `utils/scope.js` exists to restrict `role === 'client'` users to their own data via `isClient(req)` / `clientIdsForUser()` / `propertyIdsForUser()`. Both mechanisms are well-designed. The core problem in this codebase is **inconsistent application** of them — most routes stop at "is this token valid" and never ask "is this user allowed to touch this resource."

## Critical

**1. Any authenticated user can create a super-admin account.**
`POST /users/invite` (`routes/users.js`) has no role check. The caller controls `role`/`role_id` directly, and the endpoint returns the generated temp password in plaintext in the response body. A client-portal account (the least trusted role in the system) can call this endpoint and mint itself an internal `super_admin` login with a password it already knows.

**2. Any authenticated user can change any user's role or delete any account.**
`PUT /users/:id` and `DELETE /users/:id` (`routes/users.js`) only check `authenticateToken`. `PUT` accepts `role`/`is_active` from the body with no guard, so a low-privilege account can PATCH its own row to `role: 'super_admin'`, or delete any other user's account outright, internal or client.

**3. Any authenticated user can delete or edit any customer account.**
`PUT /clients/:id` and `DELETE /clients/:id` (`routes/clients.js`) have no role check. Deleting a client cascades to their properties per the code's own comment — one compromised low-privilege session can wipe another customer's entire account.

**4. Any authenticated user can mark any invoice as paid.**
`POST /billing/invoices/:id/mark-paid` (`routes/billing.js`) has no role or ownership check. Any logged-in client can zero out any invoice's balance without paying.

**5. Cross-tenant property/billing/ticket data is readable and writable by ID guessing.**
Property IDs are generated as `PROP-<timestamp>-<3 digit>` — sequential and guessable. None of these check that the caller owns the property:
- `GET /properties/:propertyId` (base) — returns another customer's property + contact PII.
- `PUT /properties/:propertyId` — **the first of two identically-routed handlers in this file wins** (Express only ever calls the first match); it has no ownership check and silently shadows a second, correctly-scoped `PUT /:propertyId` handler ~200 lines later that never runs. That second handler is dead code giving a false impression the route is protected.
- `GET /:propertyId/invoices`, `/services`, `/tickets`, `/alerts`, `/inspection`
- `POST /:propertyId/select-services`, `/schedule-inspection`, `/generate-invoice` (the last of these creates a real invoice for an arbitrary amount on someone else's property)

**6. Cross-tenant billing data leak.**
`GET /billing/invoices/:id` and `GET /billing/:propertyId` have no ownership/role check (the sibling `GET /billing/invoices` list endpoint does this correctly — the single-record getters were missed).

**7. Cross-tenant support ticket access.**
`GET /tickets/:ticketId`, `POST /:ticketId/reply`, `POST /:ticketId/complete` have no ownership check. Any client can read another customer's support thread, post into it, or falsely mark a field work order complete (this should be field-crew/ops only per the code's own comment).

**8. Full sensor fleet exposed to client accounts.**
`GET /monitoring/sensors/all` is commented `// ops only` but — unlike every other ops-only route in the same file — is missing the `if (isClient(req)) return res.status(403)` guard. Any client account gets every other customer's live sensor readings, GPS coordinates, and hardware status.

**9. Password reset is likely broken (and if it "worked," would be a token-integrity bug).**
`hashToken()` in `routes/auth.js` calls `crypto.createHash(...)`, but `crypto` is never `require()`'d at module scope in this file — only locally inside the `forgot-password` handler. Because of normal JS closure rules, `hashToken`'s own lexical scope doesn't see that local variable, so calling it (from `reset-password`, and arguably from `forgot-password` itself) will throw at runtime. This needs to be tested against the live server — if it's silently failing, password reset is currently non-functional in a way that's masked by the route's try/catch.

**10. Email verification link is a full 7-day bearer credential.**
`POST /auth/register` emails a verification link containing `signToken({id, email})` — the same signer used for real login sessions, with the same default 7-day expiry — sent in a plain URL. Anyone who can read that email (mail server logs, forwarding, link-scanning proxies, shared inboxes, browser history) obtains a valid Bearer token good for a week against every route that only checks `authenticateToken` (profile, password change, account deletion, etc.), not just the verify-email endpoint it was meant for.

## High

**11. `requireRole()` is essentially unused.** It's defined in `middleware/auth.js`, imported in exactly one route file (`settings.js`) out of ~18, and even there it's never actually called on either route. Nearly every ops-only surface in the app (clients, teams, sla, analytics, users, tickets, alerts assign/resolve) relies solely on "is logged in," meaning the externally-facing `client` role can reach almost the entire internal operations API by hitting the right endpoint.

**12. Internal staff directory exposed.** `GET /clients`, `GET /clients/:id`, `GET /users`, `GET /users/:id` return full customer/staff directories (names, emails, phone, roles, invoices) to any authenticated caller.

**13. Company-wide financials and map data exposed.** `GET /billing/summary`, `GET /analytics/kpis`, `GET /analytics/map-data` — MRR, revenue, overdue totals, and every client's GPS location/sensor counts, with no role check.

**14. Field operations can be tampered with by client accounts.** `PUT /teams/:id/status`, `POST/DELETE /teams/:id/members` have no role check — a client account can reassign crews or overwrite a team's live location.

**15. Alert lifecycle has a bypass.** `PUT /alerts/:id/assign` and `PUT /alerts/:id/resolve` have no role/ownership check, while the newer `POST /:alertId/dispatch` and `POST /:alertId/resolve` correctly gate on `isClient`. Same business action, two routes, only one is guarded — the unguarded one is still live.

## Medium

**16. CORS allowlist is not actually enforced.** In `server.js`, the `cors()` origin callback checks `ALLOWED_ORIGINS.includes(origin)`, but falls through to `return cb(null, true)` unconditionally either way — every origin is accepted, with `credentials: true`. The allowlist array is dead code; the comment ("permissive for now; tighten after go-live") suggests this was meant to be temporary.

**17. CSP disabled.** `helmet({ contentSecurityPolicy: false })` — a deliberate tradeoff noted in a comment (map tiles / weather widgets need it off), but worth a real CSP with the needed hosts allowlisted rather than fully off.

**18. `jwt.verify()` calls don't pin `algorithms`.** Every call relies on the library default rather than explicitly passing `{ algorithms: ['HS256'] }`. Low exploitability here since only HS256 tokens are ever issued, but it's a cheap defense-in-depth fix and guards against future changes.

**19. Temp passwords use `Math.random()`, not a CSPRNG.** `routes/users.js` invite flow: `Math.random().toString(36).slice(-12)` is not cryptographically secure. Low practical severity given issue #1 makes this moot until that's fixed, but should move to `crypto.randomBytes` regardless.

## Low / hygiene

**20. Audit log has no tamper protection.** `utils/audit.js` is a plain fire-and-forget insert — fine for an activity feed, not sufficient if this is ever relied on as a compliance audit trail.

**21. No tests cover authorization boundaries.** `scripts/bootcheck.js` only catches require-time crashes; nothing exercises "does a client-role token get a 403 here." Given nearly every finding above is an authorization gap rather than a logic bug, this is the class of test most worth adding.

## Suggested fix order

1. Lock down #1–#8 first (account takeover / privilege escalation / cross-tenant data and money). These are all one-line `requireRole(...)` or ownership-check additions in each handler.
2. Delete the shadowed insecure `PUT /:propertyId` duplicate in `routes/properties.js` (or merge into the one that already has the ownership check).
3. Fix the `crypto` import in `routes/auth.js` and verify password reset actually works end-to-end against the live server.
4. Change the email-verification token to a short-lived, purpose-scoped token (e.g. sign with a `purpose: 'verify_email'` claim and check it on verify, with a much shorter expiry — not the full 7-day session token).
5. Fix the CORS callback to actually enforce `ALLOWED_ORIGINS`.
6. Sweep every remaining route for a `requireRole`/`isClient` check as a matter of policy, not case-by-case.

I haven't made any code changes — this is a read-only review. Happy to patch any/all of the above on request.
