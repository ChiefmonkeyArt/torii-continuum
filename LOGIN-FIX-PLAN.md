# Login Fix Plan — Root Cause Analysis

## The Problem

When clicking "Login with Nostr" on Continuum, the error appears:

> **Could not reach agent: Bad Request**

This happens before the NIP-07 signer is even invoked.

## Root Cause

**Fastify (the agent's HTTP server) rejects POST requests that set `Content-Type: application/json` but have an empty body.**

The error message from the server is:
```
FST_ERR_CTP_EMPTY_JSON_BODY: Body cannot be empty when content-type is set to 'application/json'
```

### Trace

1. User clicks Login → `startLogin()` in `src/auth.js`
2. → `requestChallenge()` in `src/data/agent.js`
3. → `req('POST', '/api/auth/challenge')` — sends POST with no body
4. The `req()` function always sets `Content-Type: application/json`:

```js
const headers = { 'Content-Type': 'application/json' };
// ...
res = await fetch(url, {
  method,
  headers,
  body: body ? JSON.stringify(body) : undefined,
  credentials: 'include',
});
```

5. Fastify sees `Content-Type: application/json` with zero bytes of body → returns 400
6. The frontend catches `!res.ok` and returns `{ ok: false, reason: "http 400" }`
7. `startLogin()` shows: "Could not reach agent: Bad Request"

### Verification

```
$ curl -X POST -H "Content-Type: application/json" https://agent-test.orangesync.tech/api/auth/challenge
→ 400 FST_ERR_CTP_EMPTY_JSON_BODY

$ curl -X POST -H "Content-Type: application/json" -d '{}' https://agent-test.orangesync.tech/api/auth/challenge
→ 200 { challenge: "4a52b419...", expires_in: 300, kind: 22242 }
```

## Fix Options

### Option A — Frontend fix (recommended)

**File:** `src/data/agent.js`

**Change:** Only set `Content-Type: application/json` when there's a body.

```diff
-  const headers = { 'Content-Type': 'application/json' };
+  const headers = {};
   const tok = getStoredToken();
   if (tok) headers.Authorization = `Bearer ${tok}`;
+  if (body) headers['Content-Type'] = 'application/json';
```

**Why this is safe:** The challenge endpoint (and any other GET endpoint) doesn't need a content-type header because there's no body. Fastify only enforces this check when the header is present. All POST endpoints that actually receive a body (chat, verify, wallet/receive, etc.) pass `body` to `req()` so they'll still get the header.

**Files affected:** 1 file, 2 lines changed.

**Test coverage affected:** None — existing tests pass because the Playwright API tests use the `request` fixture directly, not the frontend's `req()` function.

### Option B — Agent fix (alternative)

**File:** `agent/index.mjs`

**Change:** Disable Fastify's empty-body check for the challenge route:

```javascript
app.post('/api/auth/challenge', {
  config: { rawBody: true },
}, async (req, reply) => {
  const clientIp = req.ip;
  const { challenge, expires_in } = auth.issueChallenge(clientIp);
  return { challenge, expires_in, kind: 22242 };
});
```

Or use Fastify's `addContentTypeParser` to accept empty JSON bodies globally:
```javascript
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    done(null, body ? JSON.parse(body) : {});
  } catch (err) {
    done(err);
  }
});
```

**Why Option A is better:** The frontend is sending semantically incorrect headers. Fix the sender, not the receiver.

## Secondary Issues

### 1. Admin npub mismatch

Even after fixing the challenge error, login will fail because the agent's `admin_npub` doesn't match the user's nos2x-fox key.

**Current admin_npub on VPS2:**
```
npub12s9z9jl99af97v3k8dchq64ellzzsgvly3hv9y453x56ghg074cspcafva
```
This is a throwaway test key generated for automated Playwright tests.

**Fix:** Replace with Amperstrand's actual npub from their nos2x-fox extension.

**How to get the npub:** In nos2x-fox, open the extension popup — it shows the public key (npub). Or from any Nostr client, check the public key in profile settings.

### 2. nos2x-fox Compatibility

**nos2x-fox** (github.com/diegogurpegui/nos2x-fox) is a Firefox port of nos2x (NIP-07 extension). It exposes:

- `window.nostr.getPublicKey()` → returns hex pubkey
- `window.nostr.signEvent(event)` → signs a Nostr event and returns it with `id` and `sig`

**Continuum's auth flow uses:**
- `window.nostr.signEvent(event)` → ✅ Same interface
- `typeof window.nostr.signEvent === 'function'` → ✅ Same check

**Should work out of the box.** The `hasSigner()` check in `src/auth.js` is:
```js
function hasSigner() {
  return typeof window !== 'undefined' && window.nostr && typeof window.nostr.signEvent === 'function';
}
```
Both nos2x-fox and Plebeian Signer implement this same NIP-07 interface.

### 3. CORS Configuration

The agent's CORS config must include the frontend origin. Current config on VPS2:
```yaml
cors_origins:
  - "https://continuum-test.orangesync.tech"
  - "http://localhost:5180"
```

If the user is accessing from `continuum.orangesync.tech` (VPS1), the VPS1 agent config also needs to include that origin. This is already set up correctly on VPS2.

## Implementation Steps

### Step 1: Fix the frontend bug

**File:** `src/data/agent.js`
**Change:** 1 line (conditionally set Content-Type header)
**Commit message:** `fix: don't send Content-Type: application/json for bodyless requests`

**Before:**
```js
const headers = { 'Content-Type': 'application/json' };
```

**After:**
```js
const headers = {};
if (body) headers['Content-Type'] = 'application/json';
```

### Step 2: Get Amperstrand's npub

Ask Amperstrand to open their nos2x-fox extension and read the public key (npub). Format: `npub1...`

Alternatively, they can run this in the browser console:
```js
window.nostr.getPublicKey().then(hex => console.log('hex:', hex))
```

Then convert hex to npub:
```python
CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
def bech32_encode(hrp, data):
    # ... standard bech32 encoding
```

### Step 3: Update admin_npub

SSH into the VPS and update config.yaml:

```bash
sudo sed -i 's/admin_npub:.*/admin_npub: "npub1AMPERSTRANDS_NPUB"/' /home/continuum/agent/repo/agent/config.yaml
sudo systemctl restart continuum-agent
```

Or for VPS1:
```bash
sudo sed -i 's/admin_npub:.*/admin_npub: "npub1AMPERSTRANDS_NPUB"/' /path/to/config.yaml
sudo systemctl restart continuum
```

### Step 4: Verify login flow

After both fixes are deployed:

1. Visit Continuum in a browser with nos2x-fox installed
2. Click Login
3. nos2x-fox should prompt to sign the challenge
4. After signing, the session token is stored
5. UI should switch to logged-in state (button says "Sign out")

### Step 5: Run Playwright tests

Run the full test suite to verify nothing broke:

```bash
cd tests/playwright
npx playwright test --config playwright.config.ts
```

The auth tests (`auth-tests.spec.ts`) will still work because they use `nostr-tools` directly (bypassing the frontend's `req()` function), so the Content-Type change doesn't affect them.

## Rollback Plan

If the fix causes issues:
1. Revert the commit: `git revert HEAD`
2. Restore the original admin_npub from git history
3. Push to the PR branch

## Verification Checklist

- [ ] Challenge endpoint returns 200 when called with empty JSON body `{}`
- [ ] Challenge endpoint returns 400 when called with Content-Type: application/json and no body (expected — Fastify behaviour, but frontend no longer does this)
- [ ] Login with nos2x-fox prompts for signature
- [ ] After signing, session token is stored in localStorage
- [ ] UI reflects logged-in state (button shows "Sign out")
- [ ] Logout works correctly
- [ ] Wallet balance endpoint returns data when authenticated
- [ ] Chat endpoint works when authenticated
- [ ] All 180 existing Playwright tests still pass
