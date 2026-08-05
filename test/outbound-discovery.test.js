'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverEffectiveOutbounds,
  effectiveInboundTag,
  normalizeOutbounds,
  rebuildBucketAttribution,
  routeForInbound,
  renderTrafficReport,
  sendReport,
  aggregateDailyBuckets,
  completedReportPeriod,
  currentReportPeriod,
  migrateDailySentReports
} = require('../bin/xray-sinffing.js');

const baseTrack = {
  outbounds: [],
  userAliases: {},
  emailOutbounds: {},
  includeUntrackedOutbounds: false,
  forceShowOutboundNames: false,
  excludeOutbounds: ['api', 'block']
};

test('automatic discovery keeps effective routes and drops internal or unused outbounds', () => {
  const xray = {
    outbounds: [
      { tag: 'to-b', protocol: 'vless' },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
      { tag: 'unused', protocol: 'freedom' },
      { tag: 'api', protocol: 'freedom' }
    ],
    routing: {
      rules: [
        { domain: ['example.invalid'], outboundTag: 'direct' },
        { ip: ['geoip:private'], outboundTag: 'block' }
      ]
    }
  };

  assert.deepEqual(discoverEffectiveOutbounds({ track: baseTrack }, xray), [
    { tag: 'to-b', name: 'to-b' }
  ]);
});

test('untagged inbounds still receive an internal identity for user discovery', () => {
  assert.equal(effectiveInboundTag({ protocol: 'vless' }, 0), '__untagged_inbound_0');
  assert.equal(effectiveInboundTag({ tag: 'client-in' }, 4), 'client-in');
});

test('balancer selectors add matching configured outbounds only', () => {
  const xray = {
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'pool-a', protocol: 'vless' },
      { tag: 'pool-b', protocol: 'vless' },
      { tag: 'other', protocol: 'vless' }
    ],
    routing: {
      rules: [{ inboundTag: ['xhttp-in'], network: 'tcp', balancerTag: 'main-pool' }],
      balancers: [{ tag: 'main-pool', selector: ['pool-'] }]
    }
  };

  assert.deepEqual(discoverEffectiveOutbounds({ track: baseTrack }, xray).map((x) => x.tag), [
    'direct',
    'pool-a',
    'pool-b'
  ]);
});

test('explicit list controls names and can append smart-discovered outbounds', () => {
  const discovered = [{ tag: 'direct', name: 'direct' }, { tag: 'proxy-b', name: 'proxy-b' }];
  const explicit = Object.assign({}, baseTrack, {
    outbounds: [{ tag: 'direct', name: 'Main' }]
  });
  assert.deepEqual(normalizeOutbounds({ track: explicit }, discovered), [{ tag: 'direct', name: 'Main' }]);

  explicit.includeUntrackedOutbounds = true;
  assert.deepEqual(normalizeOutbounds({ track: explicit }, discovered), [
    { tag: 'direct', name: 'Main' },
    { tag: 'proxy-b', name: 'proxy-b' }
  ]);

  explicit.outbounds.push({ tag: 'unused', name: 'Unused' });
  assert.equal(normalizeOutbounds({ track: explicit }, discovered).some((item) => item.tag === 'unused'), false);
});

test('single-outbound report omits redundant outbound sections', () => {
  const cfg = {
    telegram: {},
    komari: { probeUrl: '', brandName: 'Traffic', nodeName: 'node' },
    track: baseTrack
  };
  const model = {
    trackedOutbounds: [{ tag: 'direct', name: 'Primary' }],
    showOutboundBreakdown: false,
    knownUsers: ['user-a'],
    warnings: []
  };
  const bucket = {
    samples: 1,
    byOutbound: { direct: { uplink: 10, downlink: 20, total: 30 } },
    byUser: { 'user-a': { uplink: 10, downlink: 20, total: 30 } },
    byUserOutbound: { 'user-a': { direct: { uplink: 10, downlink: 20, total: 30 } } },
    unattributedByUser: {},
    warnings: []
  };
  const report = renderTrafficReport('daily', '2026-07-26', bucket, cfg, model).msg;

  assert.match(report, /用户合计/);
  assert.doesNotMatch(report, /本机出口合计/);
  assert.doesNotMatch(report, /Primary/);
});

test('a period without samples is reported as missing data instead of zero traffic', () => {
  const cfg = {
    telegram: {},
    komari: { probeUrl: '', brandName: 'Traffic', nodeName: 'node' },
    track: baseTrack
  };
  const model = {
    trackedOutbounds: [{ tag: 'direct', name: 'Primary' }],
    showOutboundBreakdown: false,
    knownUsers: ['user-a'],
    warnings: []
  };
  const bucket = {
    samples: 0,
    byOutbound: {},
    byUser: {},
    byUserOutbound: {},
    unattributedByUser: {},
    warnings: []
  };
  const report = renderTrafficReport('weekly', '2026-W30', bucket, cfg, model).msg;
  assert.match(report, /无可用采样数据/);
  assert.doesNotMatch(report, /出口合计|用户合计|总: <code>0 B/);
});

test('scheduled periods use configured send boundaries', () => {
  const cfg = {
    reports: {
      weekly: { weekday: 7, time: '07:10' },
      monthly: { day: 5, time: '07:15' }
    }
  };
  const sunday = new Date(2026, 7, 2, 8, 0, 0);
  const august = new Date(2026, 7, 5, 8, 0, 0);
  assert.deepEqual(
    Object.fromEntries(Object.entries(completedReportPeriod('weekly', cfg, sunday)).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])),
    { start: '2026-07-26', end: '2026-08-02', key: '2026-08-02' }
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(completedReportPeriod('monthly', cfg, august)).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])),
    { start: '2026-07-05', end: '2026-08-05', key: '2026-08-05' }
  );
  assert.equal(currentReportPeriod('monthly', cfg, august).key, '2026-08-06');
});

test('monthly and weekly totals are rebuilt from daily buckets inside send boundaries', () => {
  const daily = (total) => ({
    samples: 1,
    firstSampleAt: '2026-08-04T00:00:00.000Z',
    lastSampleAt: '2026-08-04T23:59:00.000Z',
    byEmail: { 'user@example.invalid': { uplink: total, downlink: 0, total } },
    byUser: { user: { uplink: total, downlink: 0, total } },
    byOutbound: { direct: { uplink: total, downlink: 0, total } },
    byUserOutbound: { user: { direct: { uplink: total, downlink: 0, total } } },
    unattributedByUser: {},
    warnings: []
  });
  const state = {
    buckets: {
      daily: {
        '2026-07-04': daily(10),
        '2026-07-05': daily(20),
        '2026-08-04': daily(200),
        '2026-08-05': daily(1000)
      }
    }
  };
  const period = { start: new Date(2026, 6, 5), end: new Date(2026, 7, 5), key: '2026-08-05' };
  const bucket = aggregateDailyBuckets(state, period);
  assert.equal(bucket.samples, 2);
  assert.equal(bucket.byEmail['user@example.invalid'].total, 220);
  assert.equal(bucket.byOutbound.direct.total, 220);
});

test('legacy daily sent markers migrate to the new ending boundary', () => {
  assert.deepEqual(migrateDailySentReports({
    '2026-07-31': 'sent-a',
    '2026-12-31': 'sent-b',
    invalid: 'ignored'
  }), {
    '2026-08-01': 'sent-a',
    '2027-01-01': 'sent-b'
  });
});

test('only successful scheduled delivery consumes the report marker', async () => {
  const cfg = {
    telegram: { botToken: 'test-token', chatId: 'test-chat' },
    komari: { probeUrl: '', brandName: 'Traffic', nodeName: 'node' },
    track: baseTrack
  };
  const model = {
    trackedOutbounds: [{ tag: 'direct', name: 'Primary' }],
    showOutboundBreakdown: false,
    knownUsers: [],
    warnings: []
  };
  const bucket = {
    samples: 0,
    byOutbound: {},
    byUser: {},
    byUserOutbound: {},
    unattributedByUser: {},
    warnings: []
  };
  const state = {
    buckets: { daily: { '2026-07-28': bucket } },
    sentReports: { daily: {} }
  };
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalFetch = global.fetch;
  console.log = () => {};
  console.warn = () => {};
  global.fetch = async () => ({ ok: true });
  try {
    const period = { start: new Date(2026, 6, 28), end: new Date(2026, 6, 29), key: '2026-07-29' };
    assert.equal(await sendReport('daily', period, state, cfg, model, false, false), true);
    assert.equal(state.sentReports.daily['2026-07-29'], undefined);

    assert.equal(await sendReport('daily', period, state, cfg, model, true, true), true);
    assert.equal(state.sentReports.daily['2026-07-29'], undefined);

    assert.equal(await sendReport('daily', period, state, cfg, model, false, true), true);
    assert.ok(state.sentReports.daily['2026-07-29']);

    delete state.sentReports.daily['2026-07-29'];
    cfg.telegram = {};
    assert.equal(await sendReport('daily', period, state, cfg, model, false, true), false);
    assert.equal(state.sentReports.daily['2026-07-29'], undefined);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    global.fetch = originalFetch;
  }
});

test('user attribution uses default for global rules and rejects conditional inbound rules', () => {
  const warnings = [];
  const conditional = {
    outbounds: [{ tag: 'direct' }, { tag: 'proxy-a' }],
    routing: {
      rules: [{ inboundTag: ['in-a'], domain: ['example.invalid'], outboundTag: 'proxy-a' }]
    }
  };
  assert.equal(routeForInbound('in-a', conditional, warnings), null);
  assert.ok(warnings.length > 0);

  const globalWarnings = [];
  const globalRule = {
    outbounds: [{ tag: 'direct' }, { tag: 'proxy-a' }],
    routing: {
      rules: [{ ip: ['geoip:private'], outboundTag: 'proxy-a' }]
    }
  };
  assert.equal(routeForInbound('in-a', globalRule, globalWarnings), 'direct');
  assert.deepEqual(globalWarnings, []);

  const deterministicWarnings = [];
  const deterministic = {
    outbounds: [{ tag: 'direct' }, { tag: 'proxy-a' }],
    routing: {
      rules: [{ type: 'field', inboundTag: ['in-a'], outboundTag: 'proxy-a' }]
    }
  };
  assert.equal(routeForInbound('in-a', deterministic, deterministicWarnings), 'proxy-a');
  assert.deepEqual(deterministicWarnings, []);
});

test('stored email totals are rebuilt against the current default and inbound routes', () => {
  const cfg = {
    track: Object.assign({}, baseTrack, {
      outbounds: [{ tag: 'frm' }, { tag: 'home-out' }]
    })
  };
  const model = {
    trackedOutbounds: [{ tag: 'frm', name: 'Main' }, { tag: 'home-out', name: 'Home' }],
    attribution: {
      'user@main.invalid': 'frm',
      'user@home.invalid': 'home-out'
    }
  };
  const bucket = {
    byEmail: {
      'user@main.invalid': { uplink: 10, downlink: 20, total: 30 },
      'user@home.invalid': { uplink: 1, downlink: 9, total: 10 }
    },
    byUser: {},
    byUserOutbound: {},
    unattributedByUser: {}
  };

  rebuildBucketAttribution(bucket, cfg, model);
  assert.deepEqual(bucket.byUser.user, { uplink: 11, downlink: 29, total: 40 });
  assert.equal(bucket.byUserOutbound.user.frm.total, 30);
  assert.equal(bucket.byUserOutbound.user['home-out'].total, 10);
});

test('multi-outbound report hides zero details and keeps counter dimensions separate', () => {
  const cfg = {
    telegram: {},
    komari: { probeUrl: '', brandName: 'Traffic', nodeName: 'node' },
    track: baseTrack
  };
  const model = {
    trackedOutbounds: [
      { tag: 'frm', name: 'Main' },
      { tag: 'home', name: 'Home' },
      { tag: 'direct', name: 'Direct' }
    ],
    showOutboundBreakdown: true,
    knownUsers: ['active', 'idle'],
    warnings: []
  };
  const bucket = {
    samples: 2,
    byOutbound: {
      frm: { uplink: 20, downlink: 80, total: 100 },
      home: { uplink: 100, downlink: 800, total: 900 },
      direct: { uplink: 0, downlink: 0, total: 0 }
    },
    byUser: {
      active: { uplink: 10, downlink: 70, total: 80 },
      idle: { uplink: 0, downlink: 0, total: 0 }
    },
    byUserOutbound: {
      active: { frm: { uplink: 10, downlink: 70, total: 80 } }
    },
    unattributedByUser: {},
    warnings: []
  };
  const report = renderTrafficReport('daily', '2026-07-28', bucket, cfg, model).msg;
  const idleBlock = report.slice(report.indexOf('<b>idle</b>'), report.indexOf('</blockquote>', report.indexOf('<b>idle</b>')));

  assert.doesNotMatch(report, /Direct/);
  assert.doesNotMatch(idleBlock, /Main|Home/);
  assert.match(report, /出口合计: <code>1000 B<\/code>/);
  assert.match(report, /用户合计: <code>80 B<\/code>/);
  assert.doesNotMatch(report, /未分配到用户/);
});

test('a user with disabled policy stats is never reported as zero traffic', () => {
  const cfg = {
    telegram: {},
    komari: { probeUrl: '', brandName: 'Traffic', nodeName: 'node' },
    track: baseTrack
  };
  const model = {
    trackedOutbounds: [{ tag: 'frm', name: 'Main' }],
    showOutboundBreakdown: false,
    knownUsers: ['user-a'],
    disabledStatsByUser: { 'user-a': [1] },
    warnings: ['用户 user-a 的 Xray policy level 1 未启用双向 user Stats；该用户不能显示为 0 B']
  };
  const bucket = {
    samples: 1,
    byOutbound: { frm: { uplink: 10, downlink: 20, total: 30 } },
    byUser: {},
    byUserOutbound: {},
    unattributedByUser: {},
    warnings: []
  };
  const report = renderTrafficReport('daily', '2026-07-28', bucket, cfg, model).msg;

  assert.match(report, /统计未启用 \(policy level 1\)/);
  assert.doesNotMatch(report, /<b>user-a<\/b> 总: <code>0 B<\/code>/);
});

test('unreadable Xray config produces an error report instead of false totals', () => {
  const cfg = {
    telegram: {},
    komari: { probeUrl: '', brandName: 'Traffic', nodeName: 'node' },
    track: baseTrack
  };
  const model = {
    configError: '读取 Xray 配置失败: EACCES',
    trackedOutbounds: [],
    showOutboundBreakdown: false,
    knownUsers: [],
    warnings: []
  };
  const bucket = {
    samples: 5,
    byOutbound: {},
    byUser: { root: { uplink: 10, downlink: 20, total: 30 } },
    byUserOutbound: {},
    unattributedByUser: {},
    warnings: []
  };
  const report = renderTrafficReport('daily', '2026-07-28', bucket, cfg, model).msg;

  assert.match(report, /采集配置错误/);
  assert.match(report, /EACCES/);
  assert.doesNotMatch(report, /用户合计/);
});
