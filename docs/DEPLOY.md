# Deploy Continuum Frontend to Production

## What This Fixes

The "Bad Request" login error. Root cause: `src/data/agent.js` unconditionally set `Content-Type: application/json` on every request. When the login flow called `POST /api/auth/challenge` with no body but that header, Fastify rejected it with:

```
Body cannot be empty when content-type is set to 'application/json'
```

## What Changed

**`src/data/agent.js`** — The `req()` function now starts with `headers = {}` and only sets `Content-Type` when there's a body:

```js
// BEFORE (broken)
const headers = { 'Content-Type': 'application/json' };

// AFTER (fixed)
const headers = {};
if (body !== undefined && body !== null) {
  bodyStr = JSON.stringify(body);
  headers['Content-Type'] = 'application/json';
}
```

**`src/auth.js`** — The signer-not-found modal now lists nos2x-fox alongside Plebeian Signer, so Firefox users see the correct extension link.

## How to Reproduce

```bash
# 1. Clone + build
git clone https://github.com/c03rad0r/torii-continuum.git
cd torii-continuum
git checkout feat/ansible-one-click-deploy
npm ci
npm run build

# 2. Deploy to VPS
rsync -avz --delete dist/ c03rad0r@<vps>:/var/www/html/continuum/

# 3. Verify
curl -X POST https://agent.orangesync.tech/api/auth/challenge
# → 200 { "challenge": "...", "expires_in": 300 }
```

## Verifying the Fix

### Automated (Playwright)

```bash
# Run the deep-coverage tests against test VPS
npx playwright test --config playwright.config.ts deep-coverage.spec.ts

# Key test: AK06 verifies challenge endpoint without Content-Type bug
# Key test: AK07 verifies challenge works even with old Content-Type header
```

### Manual

1. Open `https://continuum.orangesync.tech/#/projects`
2. Click **Login** in the sidebar
3. Before fix: see "Could not reach agent: Bad Request"
4. After fix: see NIP-07 signer modal (or signer-not-found modal if no extension)

## Test Coverage

| File | Tests | What It Covers |
|------|-------|----------------|
| `deep-coverage.spec.ts` | 80+ | Data layer, router, auth, chat, theme, marketplace, routstr, cross-cutting |
| `comprehensive.spec.ts` | 53 | Boot, routing, landing, projects, marketplace, routstr, dashboard, chat, auth |
| `edge-cases.spec.ts` | 41 | Chat keywords, validation, filters, theme, router edge cases |
| `auth-flow.spec.ts` | 21 | Login flow, post-login API, sign-out |
| `auth-tests.spec.ts` | 21 | Authenticated API + frontend |
| `coverage-gaps.spec.ts` | 71 | Sidebar, landing, new project modal, detail views |
| `full-happy-path.spec.ts` | 15 | Full end-to-end |
| `happy-path.spec.ts` | 16 | Quick sanity checks |

## Commit History

```
87b91d9 fix: login Bad Request + signer-agnostic UI — ready for VPS deploy
8118857 fix: signer-agnostic UI — add nos2x-fox + remove Plebeian Signer bias
36c4fb3 fix: Fastify rejects POST with Content-Type: application/json and no body
4ae451d docs: login fix plan with root cause analysis and nos2x-fox compatibility
```
