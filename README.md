# Command Center — hosted + installable

A Cloudflare Worker that holds your platform API keys, fans out to Retreaver,
Ringba and TrackDrive, and serves the Command Center dashboard as an
installable app you can put on your phone's home screen.

Everything ships as one worker: the API, the page, the service worker, the
icons. There is no separate front-end host and no build step.

---

## Why this exists separately from the Claude artifact

The artifact version reaches your data by borrowing your claude.ai connector
session. That bridge only exists inside claude.ai — the same file hosted
anywhere else renders perfectly and shows nothing. This version has its own
credentials, so it works from any browser, offline-ish, and on your phone.

**What changes when you move off the artifact:**

| | Artifact | Hosted |
|---|---|---|
| Data path | your claude.ai connectors | this worker, with its own API keys |
| Freshness | live MCP calls | Retreaver **caches its Reports API** — near-real-time, not to the second |
| Connect rate | connected calls / total | replaced by **conversion rate**; the public Reports API has no connected-calls metric |
| Long & unpaid | 7-day window | 48-hour window (computed from call records already fetched) |
| Where it runs | claude.ai only | any browser, plus the home screen |

---

## 1. Prerequisites

- Node 18+ and npm
- The Cloudflare account that already runs `ringba-mcp`
  (`99db6f26ad22f71b4f4a44d0491a3fbd`)
- Your Retreaver Core API key and Ringba API token — see step 3

```bash
cd command-center
npm install
npx wrangler login      # opens a browser, authorises this machine
```

## 2. First deploy

```bash
npx wrangler deploy
```

This prints your URL, something like
`https://command-center.timyoungson.workers.dev`.

**It has no data yet and no lock on it.** Do step 3 and step 4 before you open
that URL on anything but your own machine.

## 3. Set the secrets

Run these one at a time. Each prompts for the value, which is sent straight to
Cloudflare — it is never written to a file in this repo, never committed, and
never passes through Claude.

```bash
npx wrangler secret put RETREAVER_API_KEY      # Retreaver → Settings → My Account → API Access
npx wrangler secret put RETREAVER_COMPANY_ID   # 285270
npx wrangler secret put RINGBA_TOKEN           # Ringba → Security → API Access Tokens
npx wrangler secret put RINGBA_ACCOUNT_ID      # RAa7e916b80535402fbfb71f816dc6f85f
```

> Retreaver's Core API key grants unrestricted access to the whole account.
> Treat it like a password. If it ever leaks, reset it from
> Settings → My Account → API Access; the worker picks up the new one as soon
> as you re-run `wrangler secret put`.

Then confirm the worker sees them:

```bash
curl https://command-center.<your-subdomain>.workers.dev/api/health
# {"ok":true,"version":"1.0.0","configured":{"retreaver":true,"ringba":true,"trackdrive":false}}
```

`trackdrive:false` is expected — see step 7.

## 4. Lock it down

Your revenue is on this page, so it should never sit on an open URL.

### If you have a domain on Cloudflare (best)

Cloudflare Access can only protect a hostname on a zone you own — it cannot sit
in front of a bare `*.workers.dev` URL. So:

1. **Workers & Pages → command-center → Settings → Domains & Routes → Add custom domain.**
   Use something like `command.instar.io`.
2. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
   - Application domain: `command.instar.io`
   - Session duration: 30 days (so your phone doesn't ask constantly)
3. Add a policy: **Allow**, include **Emails** → your address, plus anyone else
   who should see it.
4. Open the domain. You'll get a one-time-code email login, then the dashboard.

Free for up to 50 users. Adding a teammate later is a policy edit, no code
change.

### If you don't have a domain on Cloudflare yet

Use the built-in passphrase gate instead — it's not as good as Access, but it
means the URL is never public:

```bash
npx wrangler secret put ACCESS_PASSPHRASE
```

The worker then serves a lock screen and sets a signed, HttpOnly, 30-day
cookie. To switch to Access later, set up the custom domain and run
`npx wrangler secret delete ACCESS_PASSPHRASE`.

**Do at least one of these two before sharing the URL.**

## 5. Put it on your phone

**iPhone / iPad (Safari — it must be Safari, not Chrome):**

1. Open the URL and sign in.
2. Tap the **Share** button, then **Add to Home Screen**.
3. Name it *Command* and tap **Add**.

It now opens full-screen with no browser chrome, its own icon, and its own
login session.

**Android (Chrome):** an *Install* banner appears at the top of the page — tap
it. Or use ⋮ → **Install app**.

## 6. Using it

- Refreshes itself every 60 seconds while open, and pauses while the tab or app
  is backgrounded so it isn't burning API calls in your pocket.
- The on-air counter is Retreaver + TrackDrive. Ringba's report API has no
  in-progress metric, so its live calls aren't counted.
- Open it with no signal and you get the last numbers the phone downloaded,
  labelled with when they were taken.

## 7. TrackDrive

TrackDrive scopes by **company**, and every company is its own subdomain — so a
second account is a second host and a second credential, not a parameter. The
worker takes up to three numbered slots and merges them into one TrackDrive
figure on the page.

Confirmed company hosts on your login:

| Company | id | Host |
|---|---|---|
| Elite-Calls.com — the **XY7** account (`anthony@xy7elite.com`) | 31797 | `elite-calls-com.trackdrive.com` |
| Instar | 76279 | `instar.trackdrive.com` |

### Adding XY7

```bash
npx wrangler secret put TRACKDRIVE_1_LABEL     # XY7
npx wrangler secret put TRACKDRIVE_1_HOST      # elite-calls-com.trackdrive.com   (no https://)
npx wrangler secret put TRACKDRIVE_1_TOKEN     # the new API key
```

If TrackDrive gave you a **pair** rather than one string, use these two instead
of `TRACKDRIVE_1_TOKEN` and the worker switches to Basic auth:

```bash
npx wrangler secret put TRACKDRIVE_1_PUBLIC_KEY
npx wrangler secret put TRACKDRIVE_1_PRIVATE_KEY
```

### Adding Instar alongside it

Same shape, slot 2 — `TRACKDRIVE_2_LABEL`, `TRACKDRIVE_2_HOST`, and its
credential. Leaderboard rows are then prefixed with the account name
(`XY7 · Actual sales`) so two companies with a source of the same name stay
tellable apart.

### Reporting

Instar's user can't read TrackDrive's aggregate report endpoints
(`tim@instar.io does not have permission to read calls by traffic_source`), so
that account is rolled up from raw call records, capped at the newest 100 per
window. You've said XY7 *does* have reporting, so for that account the worker
tries `/api/v1/calls/reports` first and only falls back to counting records if
it's refused.

**Worth verifying on first deploy:** a permitted response from that endpoint has
never been observed, so the worker reads it defensively — anything that doesn't
parse cleanly falls back to the record rollup rather than being trusted. Check
`/api/health` after deploying:

```json
"trackdrive": true, "trackdriveAccounts": ["XY7"]
```

then look at the TrackDrive row on the dashboard. If its call count looks
capped at 100 when you know there were more, the report endpoint was refused
and it fell back — tell me and I'll match the real response shape.

## 8. Updating

```bash
npx wrangler deploy
```

Same URL. Phones pick up the new version on next open — the service worker
fetches the shell in the background and swaps it in.

## 9. What it costs

Free, comfortably. Cloudflare's free Workers plan covers 100,000 requests a
day; one phone refreshing every 60 seconds for ten hours is about 600. Access
is free to 50 users. The edge cache means ten devices watching cost the
platforms the same as one.

---

## How it's put together

```
src/index.js            worker: routing, auth gate, upstream clients, edge caching
src/app.html            the dashboard (one file, no framework, no build)
src/service-worker.txt  PWA service worker — JavaScript; .txt so Wrangler
                        bundles it as text instead of running it
src/icons.js            base64 PNG icons
wrangler.toml           config; lists every secret the worker reads
test/mock-server.mjs    serves app.html with a fake API for local UI work
```

### API

| Endpoint | What it does |
|---|---|
| `GET /api/snapshot` | Everything the dashboard needs, in one round trip. Takes `start`, `end`, `prevStart`, `weekStart`, `monthStart`, `prevMonthStart` (ISO) and `tzOffset` (minutes) — the browser computes its own local day and sends it, so the worker does no timezone maths. |
| `GET /api/live` | Just the in-progress count. Cheap, 20-second cache. |
| `GET /api/health` | Which platforms are configured. Safe to hit from a monitor. |

Each platform is fetched independently with a 9-second deadline and returned
with its own `ok` flag, so one broken API degrades one section rather than the
page. Upstream error text is scrubbed of every secret before it leaves the
worker.

### Caching

Windows that can't change are cached hard; today's numbers are cached to just
under the refresh interval so a 60-second poll always executes fresh:

| Window | TTL |
|---|---|
| in-progress count | 20s |
| today's publishers, hourly, call feed | 55s |
| today's buyers, campaigns | 115s |
| yesterday, month to date | 10 min |
| 7-day baseline | 15 min |
| last month | 60 min |

### Upstream calls

- **Retreaver Reports** `GET /api/v1/reports.json` — `facet` of `affiliate`,
  `target`, `campaign`; gives calls, revenue, payout, cost, profit,
  `converted_count`, `in_progress_count` per row.
- **Retreaver Calls** `GET /api/v4/calls.json` — the live feed, the hourly
  revenue curve, no-buyer counts per campaign, and the long-&-unpaid cohort.
  Four pages max per window.
- **Ringba Insights** `POST /v2/{accountId}/insights` with
  `Authorization: Token …` — grouped by `publisherName`, `targetName`,
  `campaignName`, `datesByYearMonthDayHour`.

## Local development

```bash
# UI work against a fake API — no keys needed, no upstream calls
node test/mock-server.mjs      # http://localhost:8787

# the real worker, against real APIs
npx wrangler dev
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A red banner naming a platform | that API returned an error; the code is in the banner | 401/403 → the key is wrong or lacks permission; re-run `wrangler secret put` |
| `configured: false` on `/api/health` | a secret is missing or misspelled | `npx wrangler secret list` |
| Everything zero, no banner | the day window is right but genuinely empty | check the date in the header matches your expectation |
| Phone shows old numbers | offline; the footer says so and gives the timestamp | reconnect and pull down |
| No Install banner on iPhone | iOS only offers Add to Home Screen in Safari | open the URL in Safari |
