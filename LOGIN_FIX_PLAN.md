# Login Fix Plan — "Could not reach agent: Bad Request"

**Reported:** 2026-07-07 via Signal (+18102940908)  
**Root cause identified:** Yes  
**Fix applied:** Yes (in source)  
**Status:** Requires rebuild + redeploy

---

## Root Cause Analysis

### The Error

When clicking "Login with Nostr" on `continuum-test.orangesync.tech`, the UI shows:

```
Could not reach agent: Bad Request
```

### Why?

The frontend's HTTP client (`src/data/agent.js`, function `req()`) always sends `Content-Type: application/json` on every request, even when the request has **no body**.

The challenge request `POST /api/auth/challenge` takes no body — it just triggers the server to generate a random challenge. But the old code was:

```javascript
const headers = { 'Content-Type': 'application/json' };
// ...
body: body ? JSON.stringify(body) : undefined
```

This sends:

```
POST /api/auth/challenge
Content-Type: application/json
```

...with an **empty body**. Fastify (the agent's HTTP framework) rejects this with:

```json
{"statusCode":400,"code":"FST_ERR_CTP_EMPTY_JSON_BODY","error":"Bad Request","message":"Body cannot be empty when content-type is set to 'application/json'"}
```

The frontend's error handler picks up `json.error` = `"Bad Request"` and displays `"Could not reach agent: Bad Request"`.

**Confirmed by curl test:**
```bash
# Without Content-Type header → 200 OK ✓
curl -X POST https://agent-test.orangesync.tech/api/auth/challenge

# With Content-Type: application/json and empty body → 400 "Bad Request" ✗
curl -X POST https://agent-test.orangesync.tech/api/auth/challenge \
  -H "Content-Type: application/json"
```

### Why this hasn't been caught before

- The `POST /api/auth/verify` endpoint always gets a body (the signed event) — it works fine
- The `POST /api/chat` always gets a body — it works fine
- Only `requestChallenge()` and `GET` endpoints (like `/api/health`) were affected
- The test suite uses `page.route()` to intercept the challenge/verify flow and inject fake responses — it never tests the real HTTP path

---

## Fix Applied

**File:** `src/data/agent.js` — function `req()`

**Changed:** Only set `Content-Type: application/json` when there's actually a body to send.

```javascript
// BEFORE (broken):
const headers = { 'Content-Type': 'application/json' };
// ...
body: body ? JSON.stringify(body) : undefined

// AFTER (fixed):
const headers = {};
if (body !== undefined && body !== null) {
  bodyStr = JSON.stringify(body);
  headers['Content-Type'] = 'application/json';
}
```

**Also affected endpoints** (all would have failed with same error before the fix):

| Endpoint | Method | Has body? | Was broken? |
|----------|--------|-----------|-------------|
| `/api/auth/challenge` | POST | No | **YES** — this is the login blocker |
| `/api/health` | GET | No | **YES** — but GET with no body often works |
| `/api/wallet/balance` | GET | No | **YES** — but GET with no body often works |
| `/api/character` | GET | No | **YES** |
| `/api/memory` | GET | No | **YES** |
| `/api/memory/ciphertexts` | GET | No | **YES** |
| `/api/pending` | GET | No | **YES** |
| `/api/pending/:file` | GET | No | **YES** |
| `/api/health/models` | GET | No | **YES** |

Note: Fastify actually allows `GET` requests with `Content-Type: application/json` even without a body. The strict body validation only applies to `POST`, `PUT`, and `PATCH`. So the practical breakage was limited to `POST /api/auth/challenge`.

---

## Deployment Plan

### Tasks

| # | Task | Owner | Duration | Details |
|---|------|-------|----------|---------|
| 1 | Rebuild frontend bundle | Dev | 5 min | `npm run build` (Vite) produces updated `dist/` |
| 2 | Deploy updated bundle to VPS | DevOps | 5 min | Copy `dist/` to Caddy webroot on VPS2 |
| 3 | Verify login flow from browser | QA | 5 min | Click Login → observe challenge response |
| 4 | Run full auth test suite | CI | 4 min | `npx playwright test auth-flow.spec.ts` |
| 5 | Run full coverage suite | CI | 5 min | `npx playwright test coverage-gaps.spec.ts` |
| 6 | Verify NIP-07 signer login on production | User | 5 min | Full end-to-end with Plebeian Signer |

### Rebuild & Deploy Steps

```bash
# 1. Rebuild frontend
cd ~/repos/torii-continuum
npm run build

# 2. Deploy to VPS2
rsync -avz dist/ c03rad0r@23.182.128.51:/var/www/continuum-test/

# 3. Verify
curl -s https://continuum-test.orangesync.tech/ | head -1
# Should return updated HTML
```

### Verification

After deploy, the login flow should work end-to-end:

1. Go to https://continuum-test.orangesync.tech
2. Navigate to any non-landing page (e.g. `/projects`)
3. Click the session button ("Login" or "Demo mode")
4. If Plebeian Signer (NIP-07) is installed:
   - Click Login → challenge is issued → signer pops up → sign → authenticated
5. If Plebeian Signer is NOT installed:
   - Click Login → modal shows "NIP-07 signer not found" (not "Bad Request")

### Rollback

If the fix causes issues, revert the change to `src/data/agent.js` and rebuild:
```bash
git checkout -- src/data/agent.js
npm run build
# re-deploy
```

---

## Test Coverage

The test suite in `tests/playwright/auth-flow.spec.ts` now covers:

- **X03**: Real `POST /api/auth/challenge` endpoint returns valid challenge ✓
- **Y04**: Real `GET /api/health` endpoint returns full metadata ✓
- **Z06**: Real `POST /api/auth/verify` rejects empty body ✓
- **Y03**: Real protected endpoints return 401 without token ✓

To run the full auth test suite:
```bash
cd tests/playwright
npx playwright test auth-flow.spec.ts
```

Expected: 19/19 passing (all direct agent API tests now exercise the real HTTP path).
