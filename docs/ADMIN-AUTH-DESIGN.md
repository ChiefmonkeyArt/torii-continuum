# Continuum — Admin Access Design

## Current State (upstream as of v0.2.5-alpha)

The agent implements **single-admin auth only**. The operator's npub is
set in `config.yaml` as `admin_npub`. The auth middleware
(`agent/core/auth.mjs`) rejects any login where `event.pubkey !== adminHex`.

**There is no role system.** Non-admin Nostr users cannot log in at all.
The agent returns `401: "pubkey is not admin npub"` for any key that
doesn't match `admin_npub`.

### How Auth Works Today

```
1. Browser requests login → POST /api/auth/challenge
2. Agent generates random challenge string (5-min TTL, IP-bound)
3. Browser asks Plebeian Signer to sign kind 22242 event with challenge
4. Browser POSTs signed event → POST /api/auth/verify
5. Agent verifies:
   - event.kind === 22242
   - event.pubkey === adminHex (decoded from admin_npub)
   - challenge tag matches
   - event.id is correct hash
   - event.sig verifies cryptographically
6. On success: HMAC session token issued (24h TTL)
7. All admin routes require `Authorization: Bearer <token>`
```

### Security Properties (current)

- No nsec on the VPS — all signing in browser via Plebeian Signer
- Admin locked at config time — no race condition for public instances
- HMAC session tokens — self-verifying, no server-side session store
- Challenge is single-use and IP-bound

---

## Proposed Enhancement: Multi-Role Access

The following is a **design proposal** for future implementation. It is
NOT implemented in the current codebase. It would require changes to
`agent/core/auth.mjs` and `agent/index.mjs`.

### Problem

Public Continuum instances would benefit from allowing non-admin Nostr
users to participate — claiming marketplace bounties, using personal
wallet features, viewing public projects. Currently only the single
admin can do anything.

### Proposed Roles

| Role | How | Access |
|------|-----|--------|
| Admin | npub matches `admin_npub` in config | Full control: projects, wallet, config, marketplace |
| User | Any valid Nostr login (passes challenge/verify) | View projects, claim bounties, personal wallet |
| Anonymous | No login | Read-only public marketplace/projects |

### Implementation Required

1. **auth.mjs** — Add a `verifyChallengeAnyUser()` variant that issues
   tokens with `{ role: 'user' }` when pubkey doesn't match admin
2. **index.mjs** — Split routes into admin-only (`requireAdmin`) vs
   user-accessible (`requireAuth`) middleware
3. **Session token** — Add role field to HMAC payload
4. **Frontend** — Conditionally render admin controls based on role

### Why Install-Time npub Is Still Needed

Even with multi-role support, the admin npub must be set at install time
(before the agent starts) to prevent race conditions on public instances.
The multi-role system adds user access; it doesn't change how admin is
claimed.

---

## Why Not First-Login-Wins?

Public-facing Continuum instances are vulnerable to admin takeover. The
"first person to login becomes admin" model is safe when instances are
not globally reachable (e.g. routers on LAN). But Continuum instances
are public web services — automated scanners (Shodan, Censys) fingerprint
new services within hours, and bots can create free Nostr identities
instantly.

Install-time npub locking eliminates the race window entirely.

### Alternative Approaches Considered

| Approach | Verdict |
|----------|---------|
| First-login-wins | Unsafe for public instances (bot race) |
| Install-time claim token | Works but adds friction (token to manage) |
| WordPress-style setup wizard | Unnecessary — Nostr npub IS the identity |
| Hardcoded nsec on server | Rejected — agent only needs public npub |

---

## Changing Admin

To change the admin npub after deployment:

1. SSH to the VPS
2. Edit `config.yaml` — replace `admin_npub` value
3. Restart: `sudo systemctl restart continuum-agent`

Takes effect on next login. No reinstall needed.
