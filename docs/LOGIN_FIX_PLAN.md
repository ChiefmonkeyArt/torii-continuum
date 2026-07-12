# Login Fix — Investigation & Resolution Plan

## Problem

Clicking "Login with Nostr" on the Continuum app shows:

```
Could not reach agent: Bad Request
```

## Root Cause

The agent HTTP client (`src/data/agent.js`) sends `Content-Type: application/json` on **every** request, even when there is no request body. The Fastify server receives a POST to `/api/auth/challenge` with `Content-Type: application/json` but an empty body. Fastify tries to parse the empty body as JSON, fails, and returns **HTTP 400 Bad Request**.

### The Data Flow

```
User clicks "Login"
  → startLogin() [src/auth.js:38]
    → requestChallenge() [src/data/agent.js:99]
      → req('POST', '/api/auth/challenge') [src/data/agent.js:59]
        → Sets headers: { 'Content-Type': 'application/json' }
        → No body (undefined)
        → fetch(POST /api/auth/challenge, { headers, body: undefined })
          → Fastify sees Content-Type: application/json but empty body
          → Fastify returns 400 "Bad Request"
        → Returns { ok: false, reason: "Bad Request", status: 400 }
      → !chal.ok → shows "Could not reach agent: Bad Request"
```

### Affected Endpoints

The bug affects **every GET request and every POST without body** that goes through the `req()` function:

| Endpoint | Method | Has body? | Affected? |
|----------|--------|-----------|-----------|
| `/api/health` | GET | No | ✅ Yes (broken) |
| `/api/auth/challenge` | POST | No | ✅ Yes (broken) |
| `/api/wallet/balance` | GET | No | ✅ Yes |
| `/api/pending` | GET | No | ✅ Yes |
| `/api/memory` | GET | No | ✅ Yes |
| `/api/memory/ciphertexts` | GET | No | ✅ Yes |
| `/api/character` | GET | No | ✅ Yes |
| `/api/auth/verify` | POST | Yes { event } | ❌ No |
| `/api/wallet/receive` | POST | Yes { token } | ❌ No |
| `/api/chat` | POST | Yes { message, context } | ❌ No |

### Why the auth tests pass

Our Playwright auth tests use `request.post()` in Playwright's native API context, which does NOT send `Content-Type: application/json` for empty-body POSTs. The browser-based `req()` function does. This is why the issue only appears in the real browser UI, not in our automated tests.

### Why the health endpoint still works via curl

`curl -s https://agent-test.orangesync.tech/api/health` works because curl doesn't add `Content-Type: application/json` by default. The bug only manifests when the request comes from the browser's `fetch()` with the explicit header.

## The Fix (Already Applied in Source)

**Commit:** `bc105d2` on branch `feat/ansible-one-click-deploy`

**Change in** `src/data/agent.js`:

```js
// BEFORE (broken):
const headers = { 'Content-Type': 'application/json' };

// AFTER (fixed):
const headers = {};
// ... later, only set Content-Type when body exists:
if (body !== undefined && body !== null) {
    bodyStr = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
}
```

This ensures `Content-Type: application/json` is only sent when there's actually a JSON body to parse.

## What Needs to Happen

### Step 1: Rebuild and Redeploy the Frontend (on VPS2)

The fix is in the source but the deployed frontend was built from an older version.

```bash
# 1. Pull the latest fix
cd ~/continuum-tests-full/torii-continuum
git pull origin feat/ansible-one-click-deploy

# 2. Rebuild the frontend with the fix
export VITE_AGENT_URL="https://agent-test.orangesync.tech"
npm run build

# 3. Copy to web root
sudo cp -r dist/* /var/www/continuum-test/

# 4. Verify
curl -s https://continuum-test.orangesync.tech/ | grep "Continuum"
```

### Step 2: Verify Login Works

1. Open https://continuum-test.orangesync.tech in Firefox
2. Click "Login with Nostr"
3. The challenge request should now succeed (HTTP 200 instead of 400)
4. nos2x-fox should prompt to sign the challenge
5. After signing, the UI should show "Sign out" (logged in state)

### Step 3: Also Fix Upstream

The upstream `main` branch at `ChiefmonkeyArt/torii-continuum` still has the bug. The fix commit `bc105d2` needs to be upstreamed (it's currently only on our `feat/ansible-one-click-deploy` branch).

## nos2x-fox Compatibility

**nos2x-fox** (https://github.com/diegogurpegui/nos2x-fox) is a Firefox port of the nos2x Nostr Signer Extension. It implements the NIP-07 interface (`window.nostr.signEvent`, `window.nostr.getPublicKey`).

**Compatibility check** with Continuum's auth flow:

| Requirement | Continuum | nos2x-fox | Compatible? |
|-------------|-----------|-----------|-------------|
| `window.nostr.signEvent(event)` | [src/auth.js:112](https://github.com/ChiefmonkeyArt/torii-continuum/blob/main/src/auth.js#L112) | ✅ Yes | ✅ |
| `window.nostr.getPublicKey()` | Used if available | ✅ Yes | ✅ |
| Kind 22242 event | Challenge uses NIP-42 (client auth) | ✅ Yes (NIP-42 is standard) | ✅ |
| Challenge in content field | `content: challenge` | ✅ Yes | ✅ |
| Challenge in tags | `[challenge, challengeString]` | ✅ Yes | ✅ |
| Relay in tags | `[relay, window.location.origin]` | ✅ Yes | ✅ |

nos2x-fox should work **without any changes** to Continuum's code. The NIP-07 interface is standard and both Plebeian Signer and nos2x-fox expose the same `window.nostr` API.

### What to expect with nos2x-fox:

1. Click "Login" → browser calls `POST /api/auth/challenge` → gets challenge
2. Browser calls `window.nostr.signEvent({ kind: 22242, content: challenge, tags: [...] })`
3. nos2x-fox shows a popup asking to sign
4. User approves
5. Browser calls `POST /api/auth/verify` with signed event
6. Agent returns session token
7. UI switches to logged-in state

**Note:** nos2x-fox is Firefox-only. For Chrome/Chromium, the user would need a different NIP-07 extension (Plebeian Signer, nos2x, Alby, etc.).

## Verification Checklist

- [ ] Frontend rebuilt with fix bc105d2
- [ ] Deployed to VPS2
- [ ] Login returns challenge (not 400)
- [ ] nos2x-fox prompts to sign
- [ ] Verify returns session token
- [ ] UI shows "Sign out" after login
- [ ] Wallet balance accessible
- [ ] Chat works (if wallet is funded)
