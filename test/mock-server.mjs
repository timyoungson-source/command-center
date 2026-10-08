import http from 'node:http';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');

const now = new Date();
const H = now.getHours();

const row = (label, calls, revenue, opts = {}) => ({
  id: opts.id ?? label, label, calls,
  revenue, payout: revenue * 0.8, cost: calls * 0.09,
  profit: revenue * 0.2 - calls * 0.09,
  converted: opts.converted ?? Math.round(calls * 0.62),
  inProgress: opts.inProgress ?? 0,
  duration: 0, connectedDuration: 0,
});

const hours = (peak) => Array.from({ length: 24 }, (_, h) =>
  h > H || h < 7 ? 0 : Math.round((peak * (0.4 + Math.sin((h - 6) / 9) * 0.8)) * 100) / 100);

const retreaver = {
  ok: true,
  totals: { calls: 229, revenue: 1800.36, payout: 1440.29, cost: 55.45, profit: 304.62, converted: 141, inProgress: 3 },
  publishers: [
    row('ID22 - Hablyte Media', 44, 755.96, { id: 64785 }),
    row('ID21 - Evolve tech', 43, 0, { id: 63854 }),
    row('ID39 - O2G', 37, 650.28, { id: 67359 }),
    row('ID4 - The Remnant Agency - David DeFranzo', 32, 125.22, { id: 58054 }),
    row('ID40 - Leaders IT - Shoaib', 22, 0, { id: 70504 }),
  ],
  buyers: [row('Lead Nova - Home INB - [retreaver_rtb_121739_number]', 53, 965.4), row('Phantom - Auto INB', 31, 410)],
  campaigns: [row('Auto Insurance - Tier 2', 88, 820), row('Home Insurance', 61, 610), row('Pest Control 2', 28, 0, { converted: 0 })],
  yesterday: { totals: { calls: 260, revenue: 3100, payout: 2480, cost: 60, profit: 520, converted: 160, inProgress: 0 }, hourly: hours(190) },
  mtd: { calls: 5500, revenue: 41260.44, payout: 33008, cost: 1311, profit: 6940, converted: 3400, inProgress: 0 },
  lastMonth: { calls: 6800, revenue: 52880.1, payout: 42304, cost: 1635, profit: 8940, converted: 4200, inProgress: 0 },
  baseline7d: [
    row('ID22 - Hablyte Media', 280, 5200, { id: 64785 }),
    row('ID21 - Evolve tech', 301, 0, { id: 63854 }),
    row('ID39 - O2G', 70, 1400, { id: 67359 }),
    row('ID4 - The Remnant Agency - David DeFranzo', 210, 2400, { id: 58054 }),
  ],
  hourly: hours(150),
  feed: Array.from({ length: 24 }, (_, i) => ({
    id: 'u' + i, at: new Date(Date.now() - i * 260000).toISOString(),
    status: i % 7 === 0 ? 'no-target' : 'finished', friendly: 'Completed',
    duration: i % 5 === 0 ? 412 : 60 + i * 3, revenue: i % 3 === 0 ? 21 + i : 0,
    publisher: ['ID30 - RRM', 'ID22 - Hablyte Media', 'ID21 - Evolve tech'][i % 3],
    campaign: ['Auto Insurance - Tier 2', 'Home Insurance', 'Pest Control 2'][i % 3],
    buyer: ['Phantom - Auto INB - [trackdrive_140367_number]', 'Lead Nova - Home INB', '—'][i % 3],
  })),
  live: 3,
  cpa: {
    book: { calls: 126, revenue: 0, payout: 0, cost: 51.98, profit: -51.98 },
    byPublisher: [{ id: 63854, label: 'ID21 - Evolve tech', calls: 126 }],
    longToday: 8, pendingLong: 8, perLongCall: 150, sampleCalls: 8,
    estRevenue: 1200, estProfit: 160,
  },
  routing: { noTarget: 34, connected: 196, sampled: 229,
    byCampaign: [{ label: 'Pest Control 2', calls: 28, noTarget: 28 }, { label: 'Home Insurance', calls: 61, noTarget: 22 }] },
  quality: { window: '48h', long: 120, longZero: 26,
    rows: [{ label: 'ID21 - Evolve tech', long: 60, longZero: 18 }, { label: 'ID22 - Hablyte Media', long: 60, longZero: 8 }] },
};

const ringba = {
  ok: true,
  totals: { calls: 124, revenue: 580.31, payout: 474.57, cost: 0, profit: 105.74, converted: 0, inProgress: 0 },
  publishers: [row('Optimize To Convert', 103, 391.5), row('Reliable Partners - Marc Muller', 18, 155.51)],
  buyers: [row('RingbaX Final Expense paid-search RTT', 69, 514.7), row('-no value-', 50, 0)],
  campaigns: [row('Final Expense', 118, 514.7), row('Medicare', 3, 38.61)],
  yesterday: { totals: { calls: 150, revenue: 700, payout: 574, cost: 0, profit: 126, converted: 0, inProgress: 0 }, hourly: hours(44) },
  mtd: { calls: 2600, revenue: 12440.6, payout: 10201, cost: 0, profit: 2239, converted: 0, inProgress: 0 },
  lastMonth: { calls: 3900, revenue: 18455.9, payout: 15133, cost: 0, profit: 3322, converted: 0, inProgress: 0 },
  hourly: hours(36),
  live: null,
};

const TD = {
  role: 'reconciliation',
  ok: true,
  accounts: [{ label: 'XY7', ok: true, reporting: true }, { label: 'Instar', ok: false, message: 'TrackDrive Instar api/v1/calls returned 401: unauthorized' }],
  totals: { calls: 412, revenue: 1990.5, payout: 1592, cost: 10.3, profit: 388.2, converted: 260, inProgress: 2 },
  publishers: [row('XY7 · Elite Direct', 260, 1400), row('XY7 · Partner Net', 152, 590.5)],
  buyers: [row('XY7 · Med Buyer', 210, 1100)],
  campaigns: [],
  yesterday: { totals: { calls: 380, revenue: 2100 }, hourly: Array(24).fill(0) },
  mtd: { calls: 8200, revenue: 39100 }, lastMonth: { calls: 9400, revenue: 44800 },
  hourly: hours(60), partial: false, live: 2,
};

const MODES = {
  '/api/snapshot': () => ({ version: '1.0.0', generatedAt: new Date().toISOString(), window: {},
    sources: { retreaver: {role:'primary',...retreaver}, ringba: {role:'primary',...ringba}, trackdrive: TD } }),
  '/api/snapshot?fail': () => ({ version: '1.0.0', generatedAt: new Date().toISOString(), window: {},
    sources: { retreaver, ringba: { ok: false, reason: 'upstream_error', message: 'Ringba insights publisherName returned 401: unauthorized' },
      trackdrive: { ok: false, reason: 'not_configured' } } }),
  '/api/snapshot?empty': () => ({ version: '1.0.0', generatedAt: new Date().toISOString(), window: {},
    sources: { retreaver: { ok: true, totals: { calls: 0, revenue: 0, payout: 0, cost: 0, profit: 0, converted: 0, inProgress: 0 },
      publishers: [], buyers: [], campaigns: [], yesterday: { totals: { revenue: 0 }, hourly: Array(24).fill(0) },
      mtd: { revenue: 0 }, lastMonth: { revenue: 0 }, baseline7d: [], hourly: Array(24).fill(0), feed: [], live: 0,
      routing: { byCampaign: [] }, quality: { long: 0, longZero: 0, rows: [] } },
      ringba: { ok: false, reason: 'not_configured' }, trackdrive: { ok: false, reason: 'not_configured' } } }),
};

http.createServer((req, res) => {
  const [path, query] = req.url.split('?');
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
  }
  if (path === '/api/snapshot') {
    const mode = (query || '').includes('mode=fail') ? '/api/snapshot?fail'
               : (query || '').includes('mode=empty') ? '/api/snapshot?empty' : '/api/snapshot';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(MODES[mode]()));
  }
  res.writeHead(404); res.end('nope');
}).listen(8787, () => console.log('mock on 8787'));
