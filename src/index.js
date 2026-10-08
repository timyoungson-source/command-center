/**
 * Command Center — hosted call dashboard for Instar.
 *
 * One Cloudflare Worker that:
 *   - holds the platform API keys as secrets (they never reach the browser)
 *   - fans out to Retreaver / Ringba / TrackDrive and returns one JSON snapshot
 *   - serves the dashboard, its service worker, manifest and icons
 *
 * Access control is Cloudflare Access, configured in the Cloudflare dashboard
 * rather than in code. This worker deliberately does no auth of its own — put
 * Access in front of it before pointing anyone at the URL.
 */

import APP_HTML from './app.html';
// service-worker.txt is JavaScript. It carries a .txt extension so Wrangler
// bundles it as a text module instead of trying to run it inside the Worker.
import SW_JS from './service-worker.txt';
import { ICONS } from './icons.js';

const VERSION = '1.1.0';

/* ------------------------------------------------------------------ *
 * Deferred-attribution (CPA) campaigns
 *
 * SSDI runs on CPA: the call happens today, the buyer reports the conversion
 * tomorrow. So $0 revenue on those calls today is expected, not a fault.
 * Blending them into margin drags it toward zero every morning and overstates
 * it every afternoon, so they are reported as a separate book.
 *
 * Keyed on the CAMPAIGN, not the publisher — a publisher sending both SSDI and
 * auto traffic is still judged normally on the auto half. The name test picks
 * up a new CPA campaign without a redeploy.
 *
 * Duration does NOT trigger payment; the conversion does. Calls past
 * LONG_CALL_SECONDS are merely far likelier to convert, so anything derived
 * from them is an estimate and is labelled as one.
 * ------------------------------------------------------------------ */

const CPA_CAMPAIGN_IDS = [48980]; // faa2127b - SSDI - CPA
const CPA_NAME_RE = /\bCPA\b/i;
const LONG_CALL_SECONDS = 45 * 60;

const isCpaCampaign = (id, label) =>
  CPA_CAMPAIGN_IDS.includes(Number(id)) || CPA_NAME_RE.test(label ?? '');

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
};

/** Validate an ISO timestamp supplied by the client. */
function isoParam(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  const d = new Date(raw);
  if (isNaN(d)) throw new HttpError(400, `${name} is not a valid timestamp`);
  const year = d.getUTCFullYear();
  if (year < 2015 || year > 2100) throw new HttpError(400, `${name} is out of range`);
  return d.toISOString();
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Fetch with a hard deadline so one slow upstream can't hang the snapshot. */
async function fetchWithTimeout(url, init = {}, ms = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cache a computed value at the edge. Keyed on a synthetic URL so the same
 * window is only ever fetched from the platform once per TTL, however many
 * phones are watching.
 */
/**
 * Attach the cache timestamp WITHOUT destroying the value's type.
 *
 * This is the whole bug that made every platform report success with zero
 * rows: most producers here return an array, and `{ ...array }` yields an
 * object with numeric keys, which is no longer an array. Downstream
 * Array.isArray checks then fail silently and the rows vanish. Arrays keep
 * their identity and carry the stamp as a non-enumerable property so it
 * survives without appearing in JSON or in any spread.
 */
function withStamp(value, at) {
  if (!Array.isArray(value)) return { ...value, cachedAt: at };
  const arr = value.slice();
  Object.defineProperty(arr, 'cachedAt', { value: at, enumerable: false });
  return arr;
}

async function cached(ctx, key, ttlSeconds, produce) {
  // Cloudflare charges a subrequest for every cache read AND write, against
  // the same ceiling as outbound fetches — 50 on the free plan, 1000 on paid.
  // With ~26 cached windows the cache alone can spend the entire free budget
  // and starve the actual API calls, which surfaces as platforms mysteriously
  // reporting zero. Off by default; set EDGE_CACHE=on once on a paid plan,
  // where it genuinely helps if several devices are watching at once.
  if (!cached.enabled) return withStamp(await produce(), new Date().toISOString());

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.command-center.internal/${encodeURIComponent(key)}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const body = await hit.json();
    return withStamp(body, hit.headers.get('x-produced-at'));
  }
  const value = await produce();
  const producedAt = new Date().toISOString();
  const res = new Response(JSON.stringify(value), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `max-age=${ttlSeconds}`,
      'x-produced-at': producedAt,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return withStamp(value, producedAt);
}

/* ------------------------------------------------------------------ *
 * Retreaver
 *
 * Reports API  GET /api/v1/reports.json  — server-side rollups. Facets:
 *   number | campaign | affiliate (alias publisher) | target (alias buyer)
 *   | date | tag_value | state
 * Each row carries total_calls, revenue, payout, cost, profit,
 * converted_count, in_progress_count, total_duration, connected_duration.
 *
 * Calls API    GET /api/v4/calls.json   — individual records, used for the
 * live feed and for bucketing revenue by hour (the Reports API's `date` facet
 * does not go finer than a day).
 *
 * NOTE: Retreaver caches Reports API responses and says so in their docs —
 * these numbers are near-real-time, not to the second.
 * ------------------------------------------------------------------ */

function retreaverConfigured(env) {
  return Boolean(env.RETREAVER_API_KEY && env.RETREAVER_COMPANY_ID);
}

/**
 * A platform snapshot fans out to eight or eleven separate windows. One of
 * them failing should cost that one panel, not the whole platform — a single
 * 502 on Ringba's campaignName grouping blanked every Ringba number on the
 * board, including the month, because they all shared a Promise.all.
 *
 * `soft` downgrades a failure to a warning plus an empty result. Only the
 * load-bearing call — today's publisher rollup, which every headline number is
 * built from — is left to throw, because a platform that cannot answer that
 * really is unavailable and should say so.
 */
function collector(env) {
  const warnings = [];
  const soft = (label, p, fallback) =>
    p.then(
      (v) => v,
      (e) => {
        warnings.push(`${label}: ${scrub(String(e?.message ?? e), env)}`);
        return fallback;
      }
    );
  return { warnings, soft };
}

/* ---- Retreaver rate gate -------------------------------------------- *
 * A snapshot asks Retreaver for eleven things at once (seven report facets
 * plus three call pulls, several of which page). Fired together that trips
 * their limiter, which answers HTTP 400 with the body "FAILED too many
 * requests" rather than a 429 — so it has to be detected on the body too.
 *
 * The gate holds concurrency to three with a short stagger, and retries a
 * throttled call twice with backoff. Retries cost subrequests, so the whole
 * run shares a small budget; it resets once the gate drains.
 * -------------------------------------------------------------------- */
const RET_MAX_CONCURRENT = 3;
const RET_MIN_GAP_MS = 120;
const RET_MAX_RETRIES = 2;
const RET_RETRY_BUDGET = 6;

const retGate = { active: 0, waiting: [], nextSlot: 0, retriesLeft: RET_RETRY_BUDGET };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retAcquire() {
  return new Promise((resolve) => {
    const start = () => {
      retGate.active++;
      const now = Date.now();
      const at = Math.max(now, retGate.nextSlot);
      retGate.nextSlot = at + RET_MIN_GAP_MS;
      const wait = at - now;
      if (wait > 0) setTimeout(resolve, wait);
      else resolve();
    };
    if (retGate.active < RET_MAX_CONCURRENT) start();
    else retGate.waiting.push(start);
  });
}

function retRelease() {
  retGate.active--;
  const next = retGate.waiting.shift();
  if (next) next();
  else if (retGate.active === 0) retGate.retriesLeft = RET_RETRY_BUDGET;
}

function retThrottled(status, text) {
  if (status === 429 || status === 503) return true;
  return status === 400 && /too many requests|rate limit/i.test(text || '');
}

/** Retreaver fetch, gated and retried. Resolves to an unread ok Response. */
async function retFetch(url) {
  for (let attempt = 0; ; attempt++) {
    await retAcquire();
    let res;
    let text = null;
    let netErr = null;
    try {
      res = await fetchWithTimeout(url);
      if (res.ok) return res;
      text = (await res.text()).slice(0, 300);
    } catch (e) {
      // Aborted or refused. Under load Retreaver stalls as often as it 400s,
      // so a timeout gets the same one-more-try treatment off the same budget.
      netErr = e;
    } finally {
      retRelease();
    }
    if (netErr) {
      if (attempt < RET_MAX_RETRIES && retGate.retriesLeft > 0) {
        retGate.retriesLeft--;
        await sleep(500 * (attempt + 1) + Math.floor(Math.random() * 250));
        continue;
      }
      throw new Error(`request failed: ${String(netErr?.message ?? netErr)}`);
    }
    if (retThrottled(res.status, text) && attempt < RET_MAX_RETRIES && retGate.retriesLeft > 0) {
      retGate.retriesLeft--;
      await sleep(500 * (attempt + 1) + Math.floor(Math.random() * 250));
      continue;
    }
    const err = new Error(`${res.status}: ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
}

/**
 * The Reports API takes DATES, not timestamps, and its end date is EXCLUSIVE.
 * Retreaver's own docs are explicit about both: every example passes bare
 * `2024-10-25`, and the in-progress recipe says to "set created_at_start to
 * today and created_at_end to tomorrow".
 *
 * Handing it an ISO instant therefore does not fail — it silently truncates to
 * the UTC date, which is how a window of "the last 24 hours" came back as
 * yesterday's calendar close: start 2026-09-15T19:22Z → 2026-09-15, end
 * 2026-09-16T19:22Z → 2026-09-16 exclusive, so the whole of today fell out.
 *
 * Our windows are half-open [start, end), so the last day we actually want is
 * the local date of the instant just before `end`, and the exclusive bound is
 * the day after that.
 */
function reportDate(iso, tzOffsetMinutes, shiftDays = 0) {
  const t = new Date(iso).getTime();
  const local = t - tzOffsetMinutes * 60000 + shiftDays * 86400000;
  return new Date(local).toISOString().slice(0, 10);
}

function reportRange(start, end, tz) {
  return {
    from: reportDate(start, tz, 0),
    // one millisecond back off the half-open end, then one day forward to
    // clear Retreaver's exclusive bound.
    to: reportDate(new Date(new Date(end).getTime() - 1).toISOString(), tz, 1),
  };
}

async function retReport(env, facet, start, end, tz = 0) {
  const rows = [];
  const range = reportRange(start, end, tz);
  for (let page = 1; page <= 10; page++) {
    const u = new URL('https://api.retreaver.com/api/v1/reports.json');
    u.searchParams.set('api_key', env.RETREAVER_API_KEY);
    u.searchParams.set('company_id', env.RETREAVER_COMPANY_ID);
    u.searchParams.set('domain', 'calls');
    u.searchParams.set('facet', facet);
    u.searchParams.set('created_at_start', range.from);
    u.searchParams.set('created_at_end', range.to);
    u.searchParams.set('per_page', '100');
    u.searchParams.set('page', String(page));

    let res;
    try {
      res = await retFetch(u.toString());
    } catch (err) {
      throw new Error(`Retreaver reports ${facet} returned ${err.message}`);
    }
    const body = await res.json();
    const data = Array.isArray(body.data) ? body.data : [];
    rows.push(...data);
    if (data.length < 100) break;
  }

  return rows.map((r) => ({
    id: r.id,
    label: String(r.facet_name ?? '—'),
    calls: num(r.total_calls),
    revenue: num(r.revenue),
    payout: num(r.payout),
    cost: num(r.cost),
    profit: num(r.profit),
    converted: num(r.converted_count),
    inProgress: num(r.in_progress_count),
    duration: num(r.total_duration),
    connectedDuration: num(r.connected_duration),
  }));
}

function totalsOf(rows) {
  return rows.reduce(
    (a, r) => ({
      calls: a.calls + r.calls,
      revenue: a.revenue + r.revenue,
      payout: a.payout + r.payout,
      cost: a.cost + r.cost,
      profit: a.profit + r.profit,
      converted: a.converted + r.converted,
      inProgress: a.inProgress + r.inProgress,
    }),
    { calls: 0, revenue: 0, payout: 0, cost: 0, profit: 0, converted: 0, inProgress: 0 }
  );
}

/**
 * Flatten one v4 call record into the shape the rest of this file uses.
 *
 * Two traps here, both of which returned data that looked fine and was empty:
 *
 * 1. v4 wraps every record: the response is `[{ "call": {…} }, …]`, not a bare
 *    list of calls. Reading fields off the wrapper yields undefined for all of
 *    them, so the feed rendered 74 rows of nulls and every hourly bucket was
 *    zero while the call COUNT looked correct.
 *
 * 2. There is no nested `affiliate` or `target` object in v4 — those are
 *    `affiliate_name` / `target_name` with ids alongside. Only `campaign` and
 *    `number` are nested. (Retreaver's MCP server normalises this for you; the
 *    REST API does not, and this worker talks to REST.)
 *
 * The `??` fallbacks keep older shapes working if the version is ever changed.
 */
/**
 * Last-ditch publisher hint from the call's tags. Retreaver carries both a
 * hash ("b34472a1") and the readable code ("ID22") under affiliate_id, and in
 * v4 `tags` is an object while other versions send an array — accept both and
 * keep only the ID-shaped value.
 */
function affiliateTag(tags) {
  if (!tags) return null;
  const values = Array.isArray(tags)
    ? tags.filter((t) => typeof t === 'string' && t.startsWith('affiliate_id:')).map((t) => t.slice(13))
    : String(tags.affiliate_id ?? '').split(',');
  for (const v of values) {
    const s = String(v).trim();
    if (/^ID\d+$/i.test(s)) return s;
  }
  return null;
}

function flattenCall(row) {
  const c = row && typeof row === 'object' && row.call ? row.call : row || {};
  return {
    id: c.uuid ?? c.uuid_short ?? c.id ?? null,
    at: c.created_at ?? c.start_time ?? null,
    status: c.status ?? null,
    friendly: c.friendly_status ?? null,
    duration: num(c.total_duration),
    revenue: num(c.revenue),
    payout: num(c.payout),
    cost: num(c.total_cost ?? c.charge_total),
    converted: c.converted === true,
    // Prefer the API's own verdict. Falling back to "had any duration" counts
    // a no-target call that rang for three seconds as connected, which is
    // exactly the call the routing alert exists to catch — so only use the
    // duration heuristic when the field is genuinely absent.
    connected:
      typeof c.connected === 'boolean'
        ? c.connected
        : Boolean(c.forwarded_time) || num(c.dialed_call_duration) > 0,
    publisherId: c.system_affiliate_id ?? c.affiliate?.id ?? null,
    // `affiliate_name` is NOT the account label — it is the contact person on
    // the affiliate record, which is set for a couple of publishers and null
    // for the rest. That is why the feed showed "Mark Webster" and "Naomi" and
    // "Unnamed" for everyone else. The real label ("ID22 - Hablyte Media")
    // comes from joining publisherId against the publisher report; this is
    // only the fallback when that join finds nothing.
    publisher: c.affiliate_name ?? c.affiliate?.name ?? null,
    publisherTag: affiliateTag(c.tags),
    campaignId: c.campaign?.id ?? c.system_campaign_id ?? c.campaign_id ?? null,
    campaign: c.campaign?.name ?? c.campaign_name ?? null,
    buyerId: c.target_id ?? c.system_target_id ?? c.target?.id ?? null,
    buyer: c.target_name ?? c.target?.name ?? null,
  };
}

/** Pull call records across a window, capped so one huge day can't run away. */
async function retCalls(env, start, end, maxPages = 4) {
  const calls = [];
  for (let page = 1; page <= maxPages; page++) {
    const u = new URL('https://api.retreaver.com/api/v4/calls.json');
    u.searchParams.set('api_key', env.RETREAVER_API_KEY);
    u.searchParams.set('company_id', env.RETREAVER_COMPANY_ID);
    u.searchParams.set('created_at_start', start);
    u.searchParams.set('created_at_end', end);
    u.searchParams.set('sort_by', 'created_at');
    u.searchParams.set('order', 'desc');
    u.searchParams.set('per_page', '100');
    u.searchParams.set('page', String(page));

    let res;
    try {
      res = await retFetch(u.toString());
    } catch (err) {
      throw new Error(`Retreaver calls returned ${err.message}`);
    }
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.calls || body.data || [];
    calls.push(...list.map(flattenCall));
    if (list.length < 100) break;
  }
  return calls;
}

/**
 * Long calls over the trailing settled days (today excluded), by campaign.
 * Gives the revenue-per-long-call rate the forecast is built on.
 */
async function retLongTrailing(env, start, end, maxPages = 2) {
  const calls = await retCalls(env, start, end, maxPages);
  const byCampaign = new Map();
  for (const c of calls) {
    if (c.duration < LONG_CALL_SECONDS) continue;
    const id = c.campaignId ?? 'none';
    const row = byCampaign.get(id) ?? {
      id, label: c.campaign ?? 'Unattributed',
      calls: 0, revenue: 0, payout: 0, cost: 0, profit: 0, converted: 0, inProgress: 0,
    };
    row.calls++;
    row.revenue += c.revenue;
    row.payout += c.payout;
    byCampaign.set(id, row);
  }
  return [...byCampaign.values()].filter((r) => isCpaCampaign(r.id, r.label));
}

/** Revenue per local hour, derived from call records. */
function bucketByHour(calls, tzOffsetMinutes) {
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const c of calls) {
    if (!c.at) continue;
    const t = new Date(c.at);
    if (isNaN(t)) continue;
    const local = new Date(t.getTime() - tzOffsetMinutes * 60000);
    buckets[local.getUTCHours()] += c.revenue;
  }
  return buckets;
}

/**
 * Two things the Reports API can't answer, computed from call records we are
 * already fetching for the hourly curve — so they cost nothing extra.
 *
 *  routing  — calls that reached no buyer, overall and per campaign
 *  quality  — the transfer-failure proxy: calls over five minutes that booked
 *             $0, per publisher, as a share of that publisher's long calls
 */
function deriveFromCalls(todayCalls, prevCalls) {
  const DEAD = new Set(['no-target', 'failed', 'blocked', 'not-open']);
  const byCampaign = new Map();
  let noTarget = 0;
  let connected = 0;

  for (const c of todayCalls) {
    const name = c.campaign ?? 'Unattributed';
    const row = byCampaign.get(name) ?? { label: name, calls: 0, noTarget: 0 };
    row.calls++;
    if (DEAD.has(c.status)) {
      row.noTarget++;
      noTarget++;
    }
    if (c.connected) connected++;
    byCampaign.set(name, row);
  }

  const longBy = new Map();
  for (const c of [...todayCalls, ...prevCalls]) {
    if (c.duration < 300) continue;
    const name = c.publisher ?? 'Unattributed';
    const row = longBy.get(name) ?? { label: name, long: 0, longZero: 0 };
    row.long++;
    if (c.revenue === 0) row.longZero++;
    longBy.set(name, row);
  }
  const quality = [...longBy.values()].sort((a, b) => b.longZero - a.longZero);
  const longTotal = quality.reduce((a, r) => a + r.long, 0);
  const longZeroTotal = quality.reduce((a, r) => a + r.longZero, 0);

  return {
    routing: {
      noTarget,
      connected,
      sampled: todayCalls.length,
      byCampaign: [...byCampaign.values()].sort((a, b) => b.noTarget - a.noTarget),
    },
    quality: { window: '48h', rows: quality, long: longTotal, longZero: longZeroTotal },
  };
}

/**
 * The CPA book, split out of today's figures.
 *
 * `pendingLong` is the count of long calls in a CPA campaign with nothing
 * booked yet — the forecast input. `perLongCall` comes from the trailing week
 * EXCLUDING today, because today's calls are all still $0 and would drag the
 * rate to nothing.
 */
function cpaSplit(campaignRows, todayCalls, trailingLongRows) {
  const cpaRows = campaignRows.filter((r) => isCpaCampaign(r.id, r.label));
  const book = cpaRows.reduce(
    (a, r) => ({
      calls: a.calls + r.calls, revenue: a.revenue + r.revenue,
      payout: a.payout + r.payout, cost: a.cost + r.cost, profit: a.profit + r.profit,
    }),
    { calls: 0, revenue: 0, payout: 0, cost: 0, profit: 0 }
  );

  const cpaCampaignIds = new Set(cpaRows.map((r) => String(r.id)));
  const inCpa = (c) =>
    cpaCampaignIds.has(String(c.campaignId)) || isCpaCampaign(c.campaignId, c.campaign);

  let pendingLong = 0;
  let longToday = 0;
  // Which publishers are sending this traffic, so the alerts can tell a
  // pending publisher apart from a broken one.
  const byPublisher = new Map();
  for (const c of todayCalls) {
    if (inCpa(c)) {
      const id = c.publisherId ?? c.publisher ?? 'none';
      const row = byPublisher.get(id) ?? { id, label: c.publisher ?? 'Unattributed', calls: 0 };
      row.calls++;
      byPublisher.set(id, row);
    }
    if (c.duration < LONG_CALL_SECONDS) continue;
    longToday++;
    if (inCpa(c) && c.revenue === 0) pendingLong++;
  }

  const settled = (trailingLongRows || []).reduce(
    (a, r) => ({ calls: a.calls + r.calls, revenue: a.revenue + r.revenue, payout: a.payout + r.payout }),
    { calls: 0, revenue: 0, payout: 0 }
  );
  const perLongCall = settled.calls > 0 ? settled.revenue / settled.calls : null;
  const keepRate = settled.revenue > 0 ? 1 - settled.payout / settled.revenue : null;

  return {
    book,
    byPublisher: [...byPublisher.values()],
    longToday,
    pendingLong,
    perLongCall,
    sampleCalls: settled.calls,
    // Estimates, never receivables — the buyer's conversion is the trigger.
    estRevenue: perLongCall != null ? pendingLong * perLongCall : null,
    estProfit: perLongCall != null && keepRate != null ? pendingLong * perLongCall * keepRate : null,
  };
}

/** id -> label, from any report facet's rows. */
function labelIndex(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (r && r.id != null && r.label && r.label !== '—') m.set(String(r.id), r.label);
  }
  return m;
}

/**
 * Resolve each call's publisher to the account label, in place.
 * Order matters: the report label is authoritative, the contact name is a
 * poor second, and the ID tag at least identifies who sent the call.
 */
function namePublishers(calls, index) {
  for (const c of calls) {
    const joined = c.publisherId != null ? index.get(String(c.publisherId)) : null;
    c.publisher = joined ?? c.publisher ?? c.publisherTag ?? null;
  }
  return calls;
}

/** Records are already flattened by retCalls; this only trims the feed. */
function normaliseFeed(calls, limit = 40) {
  return calls.slice(0, limit).map((c) => ({
    id: c.id,
    at: c.at,
    status: c.status,
    friendly: c.friendly,
    duration: c.duration,
    revenue: c.revenue,
    publisher: c.publisher,
    campaign: c.campaign,
    buyer: c.buyer,
  }));
}

async function retreaverSnapshot(env, w, ctx) {
  // Only today's publisher report is load-bearing — every headline number is
  // built from it, so if it fails the platform is genuinely down and should
  // say so. The other ten feed panels that can each stand to be empty for one
  // refresh, so a throttled or slow facet degrades to a warning instead of
  // blanking the whole dashboard.
  const { warnings, soft } = collector(env);

  const [today, buyers, campaigns, yesterday, mtd, lastMonth, baseline, todayCalls, prevCalls, longBase] =
    await Promise.all([
      cached(ctx, `ret:pub:${w.start}`, 55, () => retReport(env, 'affiliate', w.start, w.end, w.tzOffsetMinutes)),
      soft('buyers', cached(ctx, `ret:buy:${w.start}`, 115, () => retReport(env, 'target', w.start, w.end, w.tzOffsetMinutes)), []),
      soft('campaigns', cached(ctx, `ret:camp:${w.start}`, 115, () => retReport(env, 'campaign', w.start, w.end, w.tzOffsetMinutes)), []),
      soft('yesterday', cached(ctx, `ret:prev:${w.prevStart}`, 600, () => retReport(env, 'affiliate', w.prevStart, w.start, w.tzOffsetMinutes)), []),
      soft('mtd', cached(ctx, `ret:mtd:${w.monthStart}:${w.end}`, 600, () => retReport(env, 'affiliate', w.monthStart, w.end, w.tzOffsetMinutes)), []),
      soft('lastMonth', cached(ctx, `ret:lm:${w.prevMonthStart}`, 3600, () => retReport(env, 'affiliate', w.prevMonthStart, w.monthStart, w.tzOffsetMinutes)), []),
      soft('baseline', cached(ctx, `ret:base:${w.weekStart}`, 900, () => retReport(env, 'affiliate', w.weekStart, w.end, w.tzOffsetMinutes)), []),
      // Page budgets matter more than they look: Cloudflare counts every
      // fetch AND every cache read/write against one subrequest ceiling — 50
      // on the free plan. Yesterday's feed only supplies an hourly curve, and
      // the long-call baseline only needs enough sample to price a CPA call,
      // so neither earns four or eight pages of paging.
      soft('feed', cached(ctx, `ret:calls:${w.start}`, 55, () => retCalls(env, w.start, w.end, 3)), []),
      soft('prevFeed', cached(ctx, `ret:pcalls:${w.prevStart}`, 900, () => retCalls(env, w.prevStart, w.start, 1)), []),
      soft('longBase', cached(ctx, `ret:longbase:${w.weekStart}`, 900, () => retLongTrailing(env, w.weekStart, w.start, 2)), []),
    ]);

  const unwrap = (v) => (Array.isArray(v) ? v : Object.values(v).find(Array.isArray) ?? []);

  const pubRows = unwrap(today);
  const todayCallList = unwrap(todayCalls);
  const prevCallList = unwrap(prevCalls);

  // Give every call record the same publisher label the rest of the board
  // uses. The report facets are keyed by the same internal ids the call
  // records carry, so this is a join, not a guess — and it costs no extra
  // request because these reports are already in hand. Widened with
  // yesterday's and the trailing week's rows so the previous-day feed
  // resolves too.
  const pubIndex = labelIndex([...pubRows, ...unwrap(yesterday), ...unwrap(baseline)]);
  namePublishers(todayCallList, pubIndex);
  namePublishers(prevCallList, pubIndex);

  const hourly = bucketByHour(todayCallList, w.tzOffsetMinutes);
  const prevHourly = bucketByHour(prevCallList, w.tzOffsetMinutes);
  const derived = deriveFromCalls(todayCallList, prevCallList);

  return {
    ok: true,
    partial: warnings.length > 0,
    warnings,
    totals: totalsOf(pubRows),
    publishers: pubRows,
    buyers: unwrap(buyers),
    campaigns: unwrap(campaigns),
    yesterday: { totals: totalsOf(unwrap(yesterday)), hourly: prevHourly },
    mtd: totalsOf(unwrap(mtd)),
    lastMonth: totalsOf(unwrap(lastMonth)),
    baseline7d: unwrap(baseline),
    hourly,
    feed: normaliseFeed(todayCallList),
    live: totalsOf(pubRows).inProgress,
    routing: derived.routing,
    quality: derived.quality,
    cpa: cpaSplit(unwrap(campaigns), todayCallList, unwrap(longBase)),
  };
}

/* ------------------------------------------------------------------ *
 * Ringba
 *
 * POST https://api.ringba.com/v2/{accountId}/insights
 * Header: Authorization: Token {key}
 * Verified against the live account 28 Aug 2026.
 * ------------------------------------------------------------------ */

function ringbaConfigured(env) {
  return Boolean(env.RINGBA_TOKEN && env.RINGBA_ACCOUNT_ID);
}

const RINGBA_VALUES = [
  { column: 'callCount' },
  { column: 'convertedCalls' },   // Ringba's conversion count — verified live
  { column: 'conversionAmount' },
  { column: 'payoutAmount' },
  { column: 'profitGross' },
];

const RINGBA_MAX_RETRIES = 2;

async function ringbaInsights(env, groupBy, start, end) {
  let res;
  let text = null;
  for (let attempt = 0; ; attempt++) {
    res = await fetchWithTimeout(
      `https://api.ringba.com/v2/${env.RINGBA_ACCOUNT_ID}/insights`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${env.RINGBA_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          reportStart: start,
          reportEnd: end,
          groupByColumns: [{ column: groupBy }],
          valueColumns: RINGBA_VALUES,
          maxResultsPerGroup: 1000,
          formatTimespans: true,
          formatPercentages: true,
        }),
      }
    );
    if (res.ok) break;
    text = (await res.text()).slice(0, 300);
    // 502/503/504 from Ringba's insights service are transient and common on
    // the heavier groupings; a bad token or a bad column is not, and retrying
    // those just burns subrequests.
    const transient = res.status === 429 || (res.status >= 500 && res.status <= 504);
    if (!transient || attempt >= RINGBA_MAX_RETRIES) {
      throw new Error(`Ringba insights ${groupBy} returned ${res.status}: ${text}`);
    }
    await sleep(400 * (attempt + 1) + Math.floor(Math.random() * 200));
  }
  const body = await res.json();
  if (body.isSuccessful === false) {
    throw new Error(`Ringba reported failure on ${groupBy}`);
  }
  const records = body?.report?.records ?? [];
  return records.map((r) => ({
    id: null,
    label: r[groupBy] == null ? '—' : String(r[groupBy]),
    calls: num(r.callCount),
    revenue: num(r.conversionAmount),
    payout: num(r.payoutAmount),
    cost: 0,
    profit: num(r.profitGross),
    converted: num(r.convertedCalls),
    inProgress: null, // Ringba's report API exposes no in-progress metric
    bucket: groupBy.startsWith('dates') ? r[groupBy] : undefined,
  }));
}

function ringbaHourly(rows, tzOffsetMinutes) {
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const r of rows) {
    const t = new Date(r.bucket);
    if (isNaN(t)) continue;
    const local = new Date(t.getTime() - tzOffsetMinutes * 60000);
    buckets[local.getUTCHours()] += r.revenue;
  }
  return buckets;
}

async function ringbaSnapshot(env, w, ctx) {
  // Same rule as Retreaver: only today's publisher grouping is load-bearing.
  // A 502 on campaignName used to blank every Ringba figure on the board.
  const { warnings, soft } = collector(env);

  const [pub, buyers, campaigns, hourRows, prevHourRows, prevDay, mtd, lastMonth] = await Promise.all([
    cached(ctx, `rb:pub:${w.start}`, 55, () => ringbaInsights(env, 'publisherName', w.start, w.end)),
    soft('buyers', cached(ctx, `rb:buy:${w.start}`, 115, () => ringbaInsights(env, 'targetName', w.start, w.end)), []),
    soft('campaigns', cached(ctx, `rb:camp:${w.start}`, 115, () => ringbaInsights(env, 'campaignName', w.start, w.end)), []),
    soft('hourly', cached(ctx, `rb:hour:${w.start}`, 55, () => ringbaInsights(env, 'datesByYearMonthDayHour', w.start, w.end)), []),
    soft('prevHourly', cached(ctx, `rb:phour:${w.prevStart}`, 900, () => ringbaInsights(env, 'datesByYearMonthDayHour', w.prevStart, w.start)), []),
    soft('yesterday', cached(ctx, `rb:prev:${w.prevStart}`, 600, () => ringbaInsights(env, 'publisherName', w.prevStart, w.start)), []),
    soft('mtd', cached(ctx, `rb:mtd:${w.monthStart}:${w.end}`, 600, () => ringbaInsights(env, 'publisherName', w.monthStart, w.end)), []),
    soft('lastMonth', cached(ctx, `rb:lm:${w.prevMonthStart}`, 3600, () => ringbaInsights(env, 'publisherName', w.prevMonthStart, w.monthStart)), []),
  ]);

  const unwrap = (v) => (Array.isArray(v) ? v : Object.values(v).find(Array.isArray) ?? []);

  return {
    ok: true,
    partial: warnings.length > 0,
    warnings,
    totals: totalsOf(unwrap(pub).map((r) => ({ ...r, inProgress: 0 }))),
    publishers: unwrap(pub),
    buyers: unwrap(buyers),
    campaigns: unwrap(campaigns),
    yesterday: {
      totals: totalsOf(unwrap(prevDay).map((r) => ({ ...r, inProgress: 0 }))),
      hourly: ringbaHourly(unwrap(prevHourRows), w.tzOffsetMinutes),
    },
    mtd: totalsOf(unwrap(mtd).map((r) => ({ ...r, inProgress: 0 }))),
    lastMonth: totalsOf(unwrap(lastMonth).map((r) => ({ ...r, inProgress: 0 }))),
    hourly: ringbaHourly(unwrap(hourRows), w.tzOffsetMinutes),
    live: null,
  };
}

/* ------------------------------------------------------------------ *
 * TrackDrive
 *
 * Off unless TRACKDRIVE_HOST + TRACKDRIVE_PUBLIC_KEY + TRACKDRIVE_PRIVATE_KEY
 * are set. The account's aggregate endpoints (/calls/stats, /calls/reports)
 * are permission-blocked for this token, so totals are rolled up from call
 * records — fine at TrackDrive's current volume (tens of calls a month).
 * ------------------------------------------------------------------ */

/**
 * TrackDrive scopes by company, and every company is its own subdomain, so a
 * second account means a second host + credential rather than a parameter.
 * Up to three numbered slots:
 *
 *   TRACKDRIVE_1_LABEL        "XY7"
 *   TRACKDRIVE_1_HOST         elite-calls-com.trackdrive.com   (no scheme)
 *   TRACKDRIVE_1_TOKEN        — or —
 *   TRACKDRIVE_1_PUBLIC_KEY + TRACKDRIVE_1_PRIVATE_KEY
 *
 * Un-numbered TRACKDRIVE_* names still work and are read as slot 1.
 */
/**
 * Two settings matter beyond the credential.
 *
 * ROLE — TrackDrive was originally reconciliation only: those companies are
 * buyers Retreaver already routes to, so summing them double-counts. That
 * stopped being true on 16 Sep 2026 for SSDI, which now runs publisher →
 * XY7 direct and never touches Retreaver. Revenue that reaches no other
 * platform has to count, so an account can declare itself `primary`.
 * Don't mix roles in one deployment — the page treats TrackDrive as a single
 * source, so one primary account makes the whole of TrackDrive count.
 *
 *   TRACKDRIVE_1_ROLE   primary | reconciliation   (default reconciliation)
 *
 * DIDS — going direct means the publisher split no longer comes from
 * traffic_source (which is us, from the buyer's side) but from which number
 * was dialled. One DID per publisher, so the number IS the attribution:
 *
 *   TRACKDRIVE_1_DIDS   12092556402=Evolve tech,12092556407=Leaders IT,12097064001=Webster
 */
function parseDids(spec) {
  const map = new Map();
  if (!spec) return map;
  for (const pair of String(spec).split(',')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const digits = pair.slice(0, i).replace(/\D/g, '');
    const label = pair.slice(i + 1).trim();
    if (digits && label) map.set(digits, label);
  }
  return map;
}

/** Match on the last ten digits so +1 / 1 / bare all resolve the same. */
function didLabel(map, numberCalled) {
  if (!map || !map.size) return null;
  const d = String(numberCalled || '').replace(/\D/g, '');
  if (!d) return null;
  if (map.has(d)) return map.get(d);
  const tail = d.slice(-10);
  for (const [k, v] of map) if (k.slice(-10) === tail) return v;
  return null;
}

function trackdriveAccounts(env) {
  const out = [];
  for (const slot of ['', '1_', '2_', '3_']) {
    const host = env[`TRACKDRIVE_${slot}HOST`];
    if (!host) continue;
    const token = env[`TRACKDRIVE_${slot}TOKEN`];
    const pub = env[`TRACKDRIVE_${slot}PUBLIC_KEY`];
    const priv = env[`TRACKDRIVE_${slot}PRIVATE_KEY`];
    // Tolerate the whole header being pasted in — "Basic xxxx" or just "xxxx".
    const basic = String(env[`TRACKDRIVE_${slot}BASIC`] || '').trim().replace(/^Basic\s+/i, '');
    const payoutPerConversion = Number(env[`TRACKDRIVE_${slot}PAYOUT_PER_CONVERSION`]) || 0;
    if (!basic && !token && !(pub && priv)) continue;
    if (out.some((a) => a.host === host)) continue; // un-numbered duplicating slot 1
    out.push({
      label: env[`TRACKDRIVE_${slot}LABEL`] || host.split('.')[0],
      host, token, pub, priv, basic, payoutPerConversion,
      role: String(env[`TRACKDRIVE_${slot}ROLE`] || '').toLowerCase() === 'primary'
        ? 'primary' : 'reconciliation',
      dids: parseDids(env[`TRACKDRIVE_${slot}DIDS`]),
    });
  }
  return out;
}

function tdConfigured(env) {
  return trackdriveAccounts(env).length > 0;
}

/** Primary if any configured account claims it — see the ROLE note above. */
function tdRole(env) {
  return trackdriveAccounts(env).some((a) => a.role === 'primary')
    ? 'primary' : 'reconciliation';
}

/**
 * TrackDrive documents exactly ONE auth scheme, on every endpoint page:
 *
 *   curl 'https://[your-subdomain].trackdrive.com/api/v1/calls/?per_page=2' \
 *     -H 'Authorization: Basic BASE64_ENCODED_PUBLIC_KEY_AND_PRIVATE_KEY'
 *
 * There is no bearer-token scheme. Sending `Authorization: Bearer <key>`
 * leaves TrackDrive unable to resolve which company the caller belongs to,
 * and it answers 422 with
 *   {"404-not-found":["Company not found or you do not have permission
 *    to access it."]}
 * — a message that reads like a permissions problem at the far end and is
 * actually our own request being unauthenticated. That cost a fortnight, so:
 * the key PAIR wins whenever it is configured, and a lone key is still sent
 * as Basic rather than Bearer.
 */
/**
 * Does this single string look like an ALREADY-encoded Basic credential
 * rather than a raw key? Base64 alphabet, correct padding, and it decodes to
 * printable text containing a colon — which is what "public:private" looks
 * like once encoded. Worth checking because TrackDrive accounts hand the
 * credential out in both forms, and sending an encoded blob through btoa()
 * a second time fails in exactly the same silent way a bearer token did.
 */
function looksPreEncoded(v) {
  const s = String(v || '').trim();
  if (!s || s.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(s)) return false;
  try {
    const decoded = atob(s);
    return decoded.includes(':') && /^[\x20-\x7e]*$/.test(decoded);
  } catch (_) {
    return false;
  }
}

function tdAuth(acct) {
  // Handed to us ready-made: the value that goes straight after "Basic ".
  if (acct.basic) return { style: 'basic-verbatim', value: `Basic ${acct.basic}` };
  if (acct.pub && acct.priv) {
    return { style: 'basic-pair', value: `Basic ${btoa(`${acct.pub}:${acct.priv}`)}` };
  }
  // One value, no pair. If it is already encoded, pass it through untouched.
  const lone = String(acct.token || acct.pub || '').trim();
  if (looksPreEncoded(lone)) return { style: 'basic-preencoded', value: `Basic ${lone}` };
  return { style: 'basic-single-key', value: `Basic ${btoa(`${lone}:`)}` };
}

function tdHeaders(acct) {
  return {
    accept: 'application/json',
    Authorization: tdAuth(acct).value,
  };
}

async function tdGet(acct, path, params) {
  const u = new URL(`https://${acct.host}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetchWithTimeout(u.toString(), { headers: tdHeaders(acct) });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    const err = new Error(`TrackDrive ${acct.label} ${path} returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function tdCallsFor(acct, start, end) {
  return tdGet(acct, 'api/v1/calls', {
    created_at_from: start,
    created_at_to: end,
    per_page: '100',
    order: 'created_at',
    order_dir: 'desc',
  });
}

/**
 * Prefer the server-side report when the account's user has permission for it —
 * XY7 does, Instar's token does not ("tim@instar.io does not have permission to
 * read calls by traffic_source"). Falls back to counting records, which is what
 * the Instar account has always done.
 *
 * The success shape of this endpoint has never been observed on a permitted
 * account, so anything unexpected falls through to the record rollup rather
 * than being trusted.
 */
async function tdReport(acct, category, start, end) {
  try {
    const body = await tdGet(acct, 'api/v1/calls/reports', {
      category,
      created_at_from: start,
      created_at_to: end,
    });
    const rows = body?.reports ?? body?.data ?? body?.report ?? null;
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows.map((r) => ({
      label: String(r.name ?? r.title ?? r.label ?? r.id ?? '—'),
      calls: num(r.calls_count ?? r.calls ?? r.total_calls ?? r.count),
      revenue: num(r.revenue ?? r.buyer_revenue ?? r.total_revenue),
      payout: num(r.payout ?? r.traffic_source_payout ?? r.total_payout),
      cost: num(r.cost ?? r.trackdrive_cost),
      profit: num(r.profit ?? r.gross_profit),
      converted: num(r.converted ?? r.converted_count),
      inProgress: 0,
    }));
  } catch (err) {
    if (err.status && err.status < 500) return null; // permission or shape — fall back
    throw err;
  }
}

/**
 * Roll one TrackDrive account up into OUR economics.
 *
 * Crucial: this is a BUYER-SIDE ledger. We are reading XY7's TrackDrive, not
 * our own, so their field names describe their book and have to be re-pointed:
 *
 *   traffic_source_payout    what XY7 pays US              -> our REVENUE
 *   revenue / buyer_revenue  what XY7's buyer pays THEM    -> theirs, ignored
 *   (does not exist)         what we pay the publisher     -> our PAYOUT
 *
 * Reading `revenue` as ours and `traffic_source_payout` as ours was taking one
 * side of their book as both sides of ours, which rendered as the publisher
 * being paid 100% of revenue.
 *
 * Our payout is nowhere in their system — XY7 has no idea what we pay Evolve,
 * Leaders IT or Webster. It comes from TRACKDRIVE_n_PAYOUT_PER_CONVERSION and
 * is accrued only against calls XY7 has actually PAID us for. A conversion
 * they have flagged but not yet priced would otherwise book $180 of payout
 * against $0 of revenue and show the day as a loss; those are counted as
 * `pendingConversions` instead.
 */
function tdRollup(body, dids, payoutPerConversion = 0, tzOffsetMinutes = 0) {
  const calls = body?.calls ?? [];
  const meta = body?.metadata ?? {};
  const bySource = new Map();
  const hourly = Array.from({ length: 24 }, () => 0);
  let revenue = 0;
  let payout = 0;
  let connected = 0;
  let converted = 0;
  let pendingConversions = 0;

  for (const c of calls) {
    // What XY7 owes us for this call. Their `payout` is the same figure under
    // an alias; their `revenue` is deliberately NOT consulted.
    const rev = num(c.traffic_source_payout ?? c.payout);
    const paid = rev > 0;
    const pay = paid ? payoutPerConversion : 0;
    const flagged = c.traffic_source_converted === true || c.buyer_converted === true;

    revenue += rev;
    payout += pay;
    if (paid) converted++;
    else if (flagged) pendingConversions++;
    // TrackDrive records keep their own field names — not the flattened
    // Retreaver shape — so duration is read directly.
    if (num(c.total_duration ?? c.duration) > 0) connected++;

    const t = new Date(c.created_at);
    if (!isNaN(t)) {
      hourly[new Date(t.getTime() - tzOffsetMinutes * 60000).getUTCHours()] += rev;
    }

    // Prefer the dialled number: one DID per publisher is the attribution now.
    const key = didLabel(dids, c.number_called) || c.traffic_source || 'Unattributed';
    const row = bySource.get(key) ?? {
      label: key, calls: 0, revenue: 0, payout: 0, cost: 0, profit: 0, converted: 0, inProgress: 0,
    };
    row.calls++;
    row.revenue += rev;
    row.payout += pay;
    row.profit += rev - pay;
    if (paid) row.converted++;
    bySource.set(key, row);
  }

  return {
    totals: {
      calls: meta.total_count ?? calls.length,
      revenue, payout, cost: 0, profit: revenue - payout,
      connected, converted, pendingConversions,
      inProgress: meta.in_progress_count ?? 0,
    },
    publishers: [...bySource.values()],
    hourly,
    partial: (meta.total_count ?? 0) > calls.length,
    live: meta.in_progress_count ?? 0,
  };
}

const ZERO = { calls: 0, revenue: 0, payout: 0, cost: 0, profit: 0, converted: 0, inProgress: 0 };

async function trackdriveAccountSnapshot(acct, w, ctx) {
  const id = acct.host;
  const [today, prev, mtd, lastMonth, srcReport, buyerReport] = await Promise.all([
    cached(ctx, `td:${id}:today:${w.start}`, 55, () => tdCallsFor(acct, w.start, w.end)),
    cached(ctx, `td:${id}:prev:${w.prevStart}`, 900, () => tdCallsFor(acct, w.prevStart, w.start)),
    cached(ctx, `td:${id}:mtd:${w.monthStart}:${w.end}`, 600, () => tdCallsFor(acct, w.monthStart, w.end)),
    cached(ctx, `td:${id}:lm:${w.prevMonthStart}`, 3600, () => tdCallsFor(acct, w.prevMonthStart, w.monthStart)),
    cached(ctx, `td:${id}:rsrc:${w.start}`, 115, () => tdReport(acct, 'traffic_source', w.start, w.end).then((r) => r ?? { unavailable: true })),
    cached(ctx, `td:${id}:rbuy:${w.start}`, 115, () => tdReport(acct, 'buyer', w.start, w.end).then((r) => r ?? { unavailable: true })),
  ]);

  const asRows = (v) => (Array.isArray(v) ? v : Array.isArray(v?.rows) ? v.rows : null);
  const t = tdRollup(today, acct.dids, acct.payoutPerConversion, w.tzOffsetMinutes);
  const p = tdRollup(prev, acct.dids, acct.payoutPerConversion, w.tzOffsetMinutes);

  const reportedSources = asRows(srcReport);
  const reportedBuyers = asRows(buyerReport);

  // With a DID map the local split is the better one: it names our publishers,
  // where the buyer's own traffic_source report names us.
  const haveDids = acct.dids && acct.dids.size > 0;

  return {
    label: acct.label,
    role: acct.role,
    ok: true,
    reportingAvailable: Boolean(reportedSources),
    totals: t.totals,
    publishers: haveDids ? t.publishers : (reportedSources ?? t.publishers),
    buyers: reportedBuyers ?? [],
    campaigns: [],
    yesterday: { totals: p.totals },
    mtd: tdRollup(mtd, acct.dids, acct.payoutPerConversion).totals,
    lastMonth: tdRollup(lastMonth, acct.dids, acct.payoutPerConversion).totals,
    hourly: t.hourly,
    partial: t.partial,
    live: t.live,
  };
}

/** All configured TrackDrive companies, merged into one source for the page. */
async function trackdriveSnapshot(env, w, ctx) {
  const accounts = trackdriveAccounts(env);
  const settled = await Promise.allSettled(
    accounts.map((a) => trackdriveAccountSnapshot(a, w, ctx))
  );

  const good = [];
  const status = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      good.push(r.value);
      status.push({ label: accounts[i].label, ok: true, reporting: r.value.reportingAvailable });
    } else {
      status.push({ label: accounts[i].label, ok: false, message: String(r.reason?.message ?? '').slice(0, 200) });
    }
  });

  if (!good.length) {
    return { ok: false, reason: 'upstream_error', accounts: status,
             message: status.map((s) => `${s.label}: ${s.message}`).join(' · ') };
  }

  const sum = (field) =>
    good.reduce((a, g) => {
      const t = g[field]?.totals ?? g[field] ?? ZERO;
      return {
        calls: a.calls + (t.calls || 0), revenue: a.revenue + (t.revenue || 0),
        payout: a.payout + (t.payout || 0), cost: a.cost + (t.cost || 0),
        profit: a.profit + (t.profit || 0), converted: a.converted + (t.converted || 0),
        inProgress: a.inProgress + (t.inProgress || 0),
      };
    }, { ...ZERO });

  // Row labels carry their account, so two companies with a source of the same
  // name stay tellable apart in the leaderboards.
  const tag = (g, rows) =>
    (rows || []).map((r) => ({ ...r, label: good.length > 1 ? `${g.label} · ${r.label}` : r.label }));

  const hourly = Array.from({ length: 24 }, (_, h) =>
    good.reduce((a, g) => a + (g.hourly?.[h] || 0), 0));

  return {
    ok: true,
    accounts: status,
    totals: sum('totals'),
    publishers: good.flatMap((g) => tag(g, g.publishers)),
    buyers: good.flatMap((g) => tag(g, g.buyers)),
    campaigns: [],
    yesterday: { totals: sum('yesterday'), hourly: Array.from({ length: 24 }, () => 0) },
    mtd: sum('mtd'),
    lastMonth: sum('lastMonth'),
    hourly,
    partial: good.some((g) => g.partial),
    live: good.reduce((a, g) => a + (g.live || 0), 0),
  };
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

function readWindow(url) {
  const now = new Date();
  const w = {
    start: isoParam(url, 'start', new Date(now.getTime() - 86400000).toISOString()),
    end: isoParam(url, 'end', now.toISOString()),
    prevStart: isoParam(url, 'prevStart', new Date(now.getTime() - 172800000).toISOString()),
    weekStart: isoParam(url, 'weekStart', new Date(now.getTime() - 7 * 86400000).toISOString()),
    monthStart: isoParam(url, 'monthStart', new Date(now.getTime() - 30 * 86400000).toISOString()),
    prevMonthStart: isoParam(url, 'prevMonthStart', new Date(now.getTime() - 60 * 86400000).toISOString()),
    tzOffsetMinutes: parseInt(url.searchParams.get('tzOffset') ?? '0', 10) || 0,
  };
  if (Math.abs(w.tzOffsetMinutes) > 900) throw new HttpError(400, 'tzOffset is out of range');
  return w;
}

/** Never let an upstream error message leak a key, even by accident. */
/** Redact every configured secret. No truncation — see scrub() for that. */
function scrubKeys(text, env) {
  let out = String(text ?? 'Unknown error');
  const secrets = [env.RETREAVER_API_KEY, env.RINGBA_TOKEN, env.ACCESS_PASSPHRASE];
  for (const slot of ['', '1_', '2_', '3_']) {
    secrets.push(env[`TRACKDRIVE_${slot}TOKEN`], env[`TRACKDRIVE_${slot}PUBLIC_KEY`], env[`TRACKDRIVE_${slot}PRIVATE_KEY`]);
  }
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('«redacted»');
  }
  return out;
}

function scrub(message, env) {
  return scrubKeys(message, env).slice(0, 400);
}

async function apiSnapshot(url, env, ctx) {
  const w = readWindow(url);

  /**
   * `role` decides whether a source contributes to the page's money totals.
   *
   * Retreaver and Ringba are where Instar's calls are actually tracked and
   * billed, so they are `primary` and they add up.
   *
   * The outside accounts (XY7/Elite-Calls, Phantom, Advance Grow, …) are BUYERS
   * Retreaver routes calls to — every one of their calls is already counted in
   * Retreaver's numbers. Summing them in would double-count the same call. They
   * are `reconciliation`: fetched, shown, compared, never added.
   */
  const jobs = [
    ['retreaver', 'primary', retreaverConfigured(env), () => retreaverSnapshot(env, w, ctx)],
    ['ringba', 'primary', ringbaConfigured(env), () => ringbaSnapshot(env, w, ctx)],
    ['trackdrive', tdRole(env), tdConfigured(env), () => trackdriveSnapshot(env, w, ctx)],
  ];

  const settled = await Promise.allSettled(
    jobs.map(([, , configured, run]) =>
      configured ? run() : Promise.resolve({ ok: false, reason: 'not_configured' })
    )
  );

  const sources = {};
  jobs.forEach(([name, role], i) => {
    const r = settled[i];
    sources[name] = r.status === 'fulfilled'
      ? { role, ...r.value }
      : { role, ok: false, reason: 'upstream_error', message: scrub(r.reason?.message, env) };
  });

  return json({ version: VERSION, generatedAt: new Date().toISOString(), window: w, sources });
}

async function apiLive(url, env, ctx) {
  const w = readWindow(url);
  let live = null;
  let message = null;

  if (retreaverConfigured(env)) {
    try {
      const rows = await cached(ctx, `ret:live:${w.start}`, 20, () =>
        retReport(env, 'affiliate', w.start, w.end, w.tzOffsetMinutes)
      );
      const list = Array.isArray(rows) ? rows : Object.values(rows).find(Array.isArray) ?? [];
      live = totalsOf(list).inProgress;
    } catch (err) {
      message = scrub(err.message, env);
    }
  }
  return json({ live, message, at: new Date().toISOString() });
}

/* ------------------------------------------------------------------ *
 * Passphrase gate
 *
 * Cloudflare Access is the real answer, but it can only protect a hostname on
 * a zone you own — it cannot sit in front of a bare *.workers.dev URL. So this
 * gate exists to make sure the dashboard is never briefly public: set the
 * ACCESS_PASSPHRASE secret and the worker demands it before serving anything.
 * Once the worker is behind Access on a custom domain, unset the secret and
 * this disappears.
 * ------------------------------------------------------------------ */

const COOKIE = 'cc_session';
const SESSION_DAYS = 30;

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time compare, so a wrong guess leaks nothing through timing. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sessionValid(request, secret) {
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(/(?:^|;\s*)cc_session=([^;]+)/);
  if (!match) return false;
  const [issued, mac] = decodeURIComponent(match[1]).split('.');
  if (!issued || !mac) return false;
  const age = Date.now() - Number(issued);
  if (!Number.isFinite(age) || age < 0 || age > SESSION_DAYS * 86400000) return false;
  return safeEqual(mac, await sign(issued, secret));
}

const LOGIN_PAGE = (error) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Command Center</title><meta name="theme-color" content="#0c0f11">
<style>
:root{color-scheme:dark;--ground:#0c0f11;--surface:#161a1d;--ink:#eef2f2;--ink-3:#7d8b8d;
--rule:#272e31;--rule-2:#3a4347;--accent:#2fbccc;--crit:#e05f5f;
--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--ground);
color:var(--ink);font-family:var(--sans);padding:24px}
form{width:100%;max-width:330px;background:var(--surface);border:1px solid var(--rule);
border-radius:14px;padding:26px 22px;display:flex;flex-direction:column;gap:13px}
h1{font-size:19px;margin:0;letter-spacing:-.02em}
p{margin:0;font-size:13px;color:var(--ink-3);line-height:1.5}
input{font:inherit;font-size:16px;padding:12px 13px;border-radius:9px;border:1px solid var(--rule-2);
background:var(--ground);color:var(--ink)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{font-family:var(--mono);font-size:12px;letter-spacing:.07em;text-transform:uppercase;
padding:12px;border-radius:9px;border:1px solid var(--accent);background:var(--accent);
color:#04262b;font-weight:600;cursor:pointer}
.err{color:var(--crit);font-size:12.5px}
</style></head><body>
<form method="POST" action="/auth">
<h1>Command Center</h1>
<p>This dashboard shows live revenue. Enter the passphrase to continue.</p>
${error ? '<span class="err">That passphrase didn’t match. Try again.</span>' : ''}
<input type="password" name="passphrase" autocomplete="current-password"
       placeholder="Passphrase" required autofocus aria-label="Passphrase">
<button type="submit">Unlock</button>
</form></body></html>`;

async function handleAuth(request, env) {
  const form = await request.formData();
  const given = String(form.get('passphrase') ?? '');
  if (!safeEqual(given, env.ACCESS_PASSPHRASE)) {
    return new Response(LOGIN_PAGE(true), {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  const issued = String(Date.now());
  const token = `${issued}.${await sign(issued, env.ACCESS_PASSPHRASE)}`;
  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
    },
  });
}

/* ------------------------------------------------------------------ *
 * static
 * ------------------------------------------------------------------ */

function manifest() {
  return {
    name: 'Command Center',
    short_name: 'Command',
    description: 'Live call revenue across Retreaver, Ringba and TrackDrive.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#0c0f11',
    theme_color: '#0c0f11',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

function iconResponse(name) {
  const b64 = ICONS[name];
  if (!b64) return new Response('Not found', { status: 404 });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=604800',
    },
  });
}

/**
 * Why this exists: a platform returning an empty result and a platform whose
 * key is being rejected look identical on the board — both render as zero.
 * This shows the raw shape of one representative call per platform, so the
 * difference is visible without anyone pasting a key anywhere.
 *
 * Behind the same passphrase as everything else, and every response is run
 * through scrub() so a key echoed back in an upstream error cannot leak.
 */
async function apiDiag(url, env) {
  const w = readWindow(url);
  const out = { window: { start: w.start, end: w.end, tzOffsetMinutes: w.tzOffsetMinutes }, sources: {} };
  const peek = (body) => {
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  };

  // ---- Retreaver reports
  try {
    const u = new URL('https://api.retreaver.com/api/v1/reports.json');
    u.searchParams.set('api_key', env.RETREAVER_API_KEY ?? '');
    u.searchParams.set('company_id', env.RETREAVER_COMPANY_ID ?? '');
    u.searchParams.set('domain', 'calls');
    u.searchParams.set('facet', 'affiliate');
    const range = reportRange(w.start, w.end, w.tzOffsetMinutes);
    u.searchParams.set('created_at_start', range.from);
    u.searchParams.set('created_at_end', range.to);
    u.searchParams.set('per_page', '100');
    const res = await fetchWithTimeout(u.toString());
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) {}
    out.sources.retreaver = {
      status: res.status,
      dateRange: range,
      topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 12) : null,
      rowCount: Array.isArray(body?.data) ? body.data.length
              : Array.isArray(body) ? body.length : null,
      sample: peek(text),
    };
  } catch (err) {
    out.sources.retreaver = { error: String(err.message ?? err) };
  }

  // ---- Ringba insights
  try {
    const res = await fetchWithTimeout(
      `https://api.ringba.com/v2/${env.RINGBA_ACCOUNT_ID}/insights`,
      {
        method: 'POST',
        headers: { Authorization: `Token ${env.RINGBA_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          reportStart: w.start, reportEnd: w.end,
          groupByColumns: [{ column: 'publisherName' }],
          valueColumns: RINGBA_VALUES, maxResultsPerGroup: 1000,
        }),
      }
    );
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) {}
    out.sources.ringba = {
      status: res.status,
      isSuccessful: body?.isSuccessful ?? null,
      rowCount: Array.isArray(body?.report?.records) ? body.report.records.length : null,
      sample: peek(text),
    };
  } catch (err) {
    out.sources.ringba = { error: String(err.message ?? err) };
  }

  // ---- TrackDrive, each configured account
  out.sources.trackdrive = [];
  for (const acct of trackdriveAccounts(env)) {
    try {
      const u = new URL(`https://${acct.host}/api/v1/calls`);
      u.searchParams.set('created_at_from', w.start);
      u.searchParams.set('created_at_to', w.end);
      u.searchParams.set('per_page', '5');
      const res = await fetchWithTimeout(u.toString(), { headers: tdHeaders(acct) });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch (_) {}
      out.sources.trackdrive.push({
        label: acct.label, host: acct.host, role: acct.role,
        authStyle: tdAuth(acct).style,
        dids: [...acct.dids.values()],
        status: res.status,
        rowCount: Array.isArray(body?.calls) ? body.calls.length : null,
        sample: peek(text),
      });
    } catch (err) {
      out.sources.trackdrive.push({ label: acct.label, error: String(err.message ?? err) });
    }
  }

  return json(JSON.parse(scrubKeys(JSON.stringify(out), env)));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // See cached() — the edge cache costs subrequests from the same budget as
    // the upstream calls, so it stays off unless explicitly turned on.
    cached.enabled = String(env.EDGE_CACHE || '').toLowerCase() === 'on';

    try {
      // Gate everything except the manifest and icons, which the OS fetches
      // without cookies when installing to a home screen.
      if (env.ACCESS_PASSPHRASE) {
        const open = path.startsWith('/icons/') || path === '/manifest.webmanifest';
        if (path === '/auth' && request.method === 'POST') return await handleAuth(request, env);
        if (!open && !(await sessionValid(request, env.ACCESS_PASSPHRASE))) {
          if (path.startsWith('/api/')) return json({ ok: false, error: 'unauthenticated' }, 401);
          return new Response(LOGIN_PAGE(false), {
            status: 401,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
      }

      if (path === '/' || path === '/index.html') {
        return new Response(APP_HTML, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'same-origin',
          },
        });
      }

      if (path === '/manifest.webmanifest') {
        return json(manifest(), 200, { 'cache-control': 'public, max-age=3600' });
      }

      if (path === '/sw.js') {
        return new Response(SW_JS, {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-cache',
          },
        });
      }

      if (path.startsWith('/icons/')) {
        return iconResponse(path.slice('/icons/'.length));
      }

      if (path === '/api/diag') return await apiDiag(url, env);
      if (path === '/api/snapshot') return await apiSnapshot(url, env, ctx);
      if (path === '/api/live') return await apiLive(url, env, ctx);

      if (path === '/api/health') {
        return json({
          ok: true,
          version: VERSION,
          configured: {
            retreaver: retreaverConfigured(env),
            ringba: ringbaConfigured(env),
            trackdrive: tdConfigured(env),
            trackdriveAccounts: trackdriveAccounts(env).map((a) => a.label),
          },
        });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ ok: false, error: scrub(err.message, env) }, status);
    }
  },
};
