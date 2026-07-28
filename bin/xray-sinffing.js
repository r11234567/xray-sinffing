#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const DEFAULT_CONFIG_PATH = '/etc/xray-sinffing/config.json';

const DEFAULT_CONFIG = {
  xray: {
    binary: '/usr/local/bin/xray',
    apiServer: '127.0.0.1:10085',
    configPath: '/usr/local/etc/xray/config.json'
  },
  runtime: {
    statePath: '/var/lib/xray-sinffing/traffic-state.json',
    timezone: 'Asia/Shanghai',
    sampleIntervalSeconds: 300,
    initialSnapshotOnly: true,
    retentionDays: 120
  },
  telegram: {
    botToken: '',
    chatId: '',
    topicId: null
  },
  komari: {
    probeUrl: '',
    brandName: 'Xray Traffic Reporter',
    nodeName: ''
  },
  track: {
    outbounds: [],
    userAliases: {},
    emailOutbounds: {},
    includeUntrackedOutbounds: false,
    forceShowOutboundNames: false,
    excludeOutbounds: ['api', 'block']
  },
  reports: {
    daily: { enabled: true, time: '00:05', reportPreviousPeriod: true },
    weekly: { enabled: true, weekday: 1, time: '00:10', reportPreviousPeriod: true },
    monthly: { enabled: true, day: 1, time: '00:15', reportPreviousPeriod: true }
  }
};

function usage() {
  console.log([
    'Usage:',
    '  xray-sinffing.js --config /etc/xray-sinffing/config.json',
    '  xray-sinffing.js --config /etc/xray-sinffing/config.json --once',
    '  xray-sinffing.js --config /etc/xray-sinffing/config.json --once --report daily --dry-run',
    '  xray-sinffing.js --config /etc/xray-sinffing/config.json --test-telegram',
    '',
    'Options:',
    '  --config PATH',
    '  --once                 Run one sample and exit',
    '  --report TYPE          Force report: daily, weekly, monthly, all',
    '  --dry-run              Print reports instead of sending Telegram messages',
    '  --test-telegram        Send a test Telegram message with the integrated template'
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG_PATH,
    once: false,
    report: null,
    dryRun: false,
    testTelegram: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--once') args.once = true;
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--test-telegram') args.testTelegram = true;
    else throw new Error('unknown argument: ' + a);
  }
  return args;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function mergeDeep(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeDeep(out[key], value);
    else out[key] = value;
  }
  return out;
}

function stripJsonComments(input) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    const n = input[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadConfig(file) {
  const userConfig = readJson(file);
  const cfg = mergeDeep(DEFAULT_CONFIG, userConfig);
  process.env.TZ = cfg.runtime.timezone || 'Asia/Shanghai';
  return cfg;
}

function initialState() {
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    lastSampleAt: null,
    lastStats: null,
    buckets: { daily: {}, weekly: {}, monthly: {} },
    sentReports: { daily: {}, weekly: {}, monthly: {} },
    notes: []
  };
}

function loadState(cfg) {
  const state = readJson(cfg.runtime.statePath, initialState());
  if (Number(state.version || 1) < 2) {
    for (const type of ['daily', 'weekly', 'monthly']) {
      for (const bucket of Object.values(state.buckets && state.buckets[type] || {})) bucket.warnings = [];
    }
    state.version = 2;
  }
  state.buckets = state.buckets || { daily: {}, weekly: {}, monthly: {} };
  state.buckets.daily = state.buckets.daily || {};
  state.buckets.weekly = state.buckets.weekly || {};
  state.buckets.monthly = state.buckets.monthly || {};
  state.sentReports = state.sentReports || { daily: {}, weekly: {}, monthly: {} };
  state.sentReports.daily = state.sentReports.daily || {};
  state.sentReports.weekly = state.sentReports.weekly || {};
  state.sentReports.monthly = state.sentReports.monthly || {};
  return state;
}

function commandExists(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function queryStats(cfg) {
  const bin = cfg.xray.binary || 'xray';
  const args = ['api', 'statsquery', '--server=' + cfg.xray.apiServer];
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  const output = (result.stdout || '') + (result.stderr || '');
  if (result.status !== 0) {
    throw new Error('xray api statsquery failed: ' + output.trim());
  }
  return parseStatsOutput(output);
}

function collectStatsFromObject(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectStatsFromObject(item, out);
    return;
  }
  if (typeof obj.name === 'string' && (typeof obj.value === 'number' || typeof obj.value === 'string')) {
    const value = Number(obj.value);
    if (Number.isFinite(value)) out[obj.name] = value;
  }
  for (const v of Object.values(obj)) collectStatsFromObject(v, out);
}

function parseStatsOutput(output) {
  const stats = {};
  const trimmed = output.trim();
  if (!trimmed) return stats;
  try {
    collectStatsFromObject(JSON.parse(trimmed), stats);
    if (Object.keys(stats).length) return stats;
  } catch (_) {
    // Xray CLI may print protobuf text instead of JSON on some builds.
  }
  let match;
  const protoRe = /name:\s*"([^"]+)"[\s\S]*?value:\s*"?([0-9]+)"?/g;
  while ((match = protoRe.exec(output)) !== null) stats[match[1]] = Number(match[2]);
  const lineRe = /^([^\\s].*?>>>traffic>>>(?:uplink|downlink))\\s+([0-9]+)$/gm;
  while ((match = lineRe.exec(output)) !== null) stats[match[1].trim()] = Number(match[2]);
  return stats;
}

function statParts(name) {
  const parts = String(name).split('>>>');
  if (parts.length !== 4 || parts[2] !== 'traffic') return null;
  if (parts[3] !== 'uplink' && parts[3] !== 'downlink') return null;
  return { type: parts[0], id: parts[1], direction: parts[3] };
}

function diffStats(current, previous) {
  const out = {};
  const names = new Set(Object.keys(current || {}));
  for (const name of names) {
    const now = Number(current[name] || 0);
    const before = Number(previous && previous[name] ? previous[name] : 0);
    out[name] = now >= before ? now - before : now;
  }
  return out;
}

function zeroTraffic() {
  return { uplink: 0, downlink: 0, total: 0 };
}

function addTraffic(target, uplink, downlink) {
  target.uplink = Number(target.uplink || 0) + Number(uplink || 0);
  target.downlink = Number(target.downlink || 0) + Number(downlink || 0);
  target.total = target.uplink + target.downlink;
}

function ensureTraffic(map, key) {
  if (!map[key]) map[key] = zeroTraffic();
  return map[key];
}

function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function monthKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + '-' + p(d.getMonth() + 1);
}

function isoWeekKey(d) {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return String(tmp.getUTCFullYear()) + '-W' + String(weekNo).padStart(2, '0');
}

function yesterday(d) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() - 1);
  return x;
}

function previousMonth(d) {
  const x = new Date(d.getTime());
  x.setDate(1);
  x.setMonth(x.getMonth() - 1);
  return x;
}

function previousWeek(d) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() - 7);
  return x;
}

function bucketKey(type, d) {
  if (type === 'daily') return dateKey(d);
  if (type === 'weekly') return isoWeekKey(d);
  if (type === 'monthly') return monthKey(d);
  throw new Error('unknown bucket type: ' + type);
}

function makeBucket(key) {
  return {
    key,
    firstSampleAt: null,
    lastSampleAt: null,
    samples: 0,
    byEmail: {},
    byUser: {},
    byOutbound: {},
    byUserOutbound: {},
    unattributedByUser: {},
    warnings: []
  };
}

function ensureBucket(state, type, key) {
  if (!state.buckets[type][key]) state.buckets[type][key] = makeBucket(key);
  return state.buckets[type][key];
}

function normalizeOutboundEntries(raw) {
  const seen = new Set();
  const out = [];
  for (const item of raw || []) {
    let entry = null;
    if (typeof item === 'string') entry = { tag: item, name: item };
    else if (item && item.tag) entry = { tag: String(item.tag), name: String(item.name || item.tag) };
    if (!entry || !entry.tag || seen.has(entry.tag)) continue;
    seen.add(entry.tag);
    out.push(entry);
  }
  return out;
}

function discoverEffectiveOutbounds(cfg, xrayCfg) {
  const configured = asArray(xrayCfg && xrayCfg.outbounds).filter((out) => out && out.tag);
  const byTag = new Map(configured.map((out) => [String(out.tag), out]));
  const excluded = new Set(['api', 'block'].concat(asArray(cfg.track && cfg.track.excludeOutbounds)).map(String));
  const candidates = [];
  const add = (tag) => {
    const value = tag === undefined || tag === null ? '' : String(tag);
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  add(firstDefaultOutbound(xrayCfg));
  const referencedBalancers = new Set();
  for (const rule of asArray(xrayCfg && xrayCfg.routing && xrayCfg.routing.rules)) {
    // A global rule can be a DNS/LAN/block exception, not a user primary exit.
    // Only inbound-scoped rules describe a client entry point here.
    if (ruleInboundTags(rule) && rule.outboundTag) add(rule.outboundTag);
    if (ruleInboundTags(rule) && rule.balancerTag) referencedBalancers.add(String(rule.balancerTag));
  }

  for (const balancer of asArray(xrayCfg && xrayCfg.routing && xrayCfg.routing.balancers)) {
    if (!balancer || !referencedBalancers.has(String(balancer.tag))) continue;
    const selectors = asArray(balancer.selector).map(String);
    for (const tag of byTag.keys()) {
      if (selectors.some((selector) => tag.startsWith(selector))) add(tag);
    }
  }

  return candidates.filter((tag) => {
    const outbound = byTag.get(tag);
    if (!outbound || excluded.has(tag)) return false;
    return String(outbound.protocol || '').toLowerCase() !== 'blackhole';
  }).map((tag) => ({ tag, name: tag }));
}

function normalizeOutbounds(cfg, discoveredOutbounds) {
  const raw = cfg.track && Array.isArray(cfg.track.outbounds) ? cfg.track.outbounds : [];
  const explicit = normalizeOutboundEntries(raw);
  const discovered = normalizeOutboundEntries(discoveredOutbounds);
  if (!explicit.length) return discovered;
  if (!discovered.length) return explicit;
  const explicitByTag = new Map(explicit.map((item) => [item.tag, item]));
  const selected = [];
  for (const item of discovered) {
    if (explicitByTag.has(item.tag)) selected.push(explicitByTag.get(item.tag));
    else if (cfg.track.includeUntrackedOutbounds) selected.push(item);
  }
  return selected;
}

function usernameFromEmail(email, cfg) {
  const local = String(email || '').split('@')[0] || String(email || '');
  const aliases = cfg.track && cfg.track.userAliases ? cfg.track.userAliases : {};
  return aliases[email] || aliases[local] || local;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function readXrayConfig(cfg) {
  if (!cfg.xray.configPath) return null;
  try {
    const source = cfg.xray.configPath;
    const sourceStat = fs.statSync(source);
    const sourceFlag = sourceStat.isDirectory() ? '-confdir' : '-config';
    const result = spawnSync(cfg.xray.binary || 'xray', ['run', '-dump', sourceFlag, source], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(((result.stderr || '') + (result.stdout || '')).trim() || 'xray config dump failed');
    }
    return JSON.parse(result.stdout);
  } catch (error) {
    return { _readError: error.message };
  }
}

function inboundClientEmails(inbound) {
  const emails = [];
  const clients = inbound && inbound.settings && Array.isArray(inbound.settings.clients) ? inbound.settings.clients : [];
  for (let i = 0; i < clients.length; i += 1) {
    if (clients[i] && clients[i].email) emails.push(String(clients[i].email).trim());
  }
  return emails;
}

function inboundClientRecords(inbound) {
  const records = [];
  const clients = inbound && inbound.settings && Array.isArray(inbound.settings.clients) ? inbound.settings.clients : [];
  for (const client of clients) {
    if (!client || !client.email) continue;
    const level = Number(client.level === undefined ? 0 : client.level);
    records.push({
      email: String(client.email).trim(),
      level: Number.isInteger(level) && level >= 0 ? level : 0
    });
  }
  return records;
}

function levelHasUserStats(xrayCfg, level) {
  const levels = xrayCfg && xrayCfg.policy && xrayCfg.policy.levels;
  const policy = levels && levels[String(level)];
  return Boolean(policy && policy.statsUserUplink === true && policy.statsUserDownlink === true);
}

function ruleInboundTags(rule) {
  if (!rule || rule.inboundTag === undefined || rule.inboundTag === null) return null;
  return asArray(rule.inboundTag).map(String);
}

function effectiveInboundTag(inbound, index) {
  if (inbound && inbound.tag) return String(inbound.tag);
  return '__untagged_inbound_' + String(index);
}

function firstDefaultOutbound(xrayCfg) {
  const outbounds = asArray(xrayCfg.outbounds);
  for (const out of outbounds) {
    if (out && out.tag && out.tag !== 'api') return String(out.tag);
  }
  return null;
}

function routeForInbound(tag, xrayCfg, warnings) {
  const rules = xrayCfg && xrayCfg.routing ? asArray(xrayCfg.routing.rules) : [];
  const routingKeys = new Set(['type', 'ruleTag', 'inboundTag', 'outboundTag']);
  for (const rule of rules) {
    const tags = ruleInboundTags(rule);
    if (!tags) continue;
    if (!tags.includes(tag)) continue;
    if (rule.balancerTag) {
      warnings.push('inbound ' + tag + ' 使用 balancerTag=' + rule.balancerTag + '，无法从 Stats 精确归因到单个 outbound');
      return null;
    }
    const hasAdditionalMatchers = Object.keys(rule).some((key) => !routingKeys.has(key));
    if (hasAdditionalMatchers || !rule.outboundTag) {
      warnings.push('inbound ' + tag + ' 受动态或有条件的 routing 规则影响，无法从 Stats 精确归因到单个 outbound；请按需配置 track.emailOutbounds');
      return null;
    }
    return String(rule.outboundTag);
  }
  // Xray uses the first outbound when no routing rule matches.
  return firstDefaultOutbound(xrayCfg);
}

function buildXrayModel(cfg) {
  const xrayCfg = readXrayConfig(cfg);
  const warnings = [];
  const emailRecords = [];
  const knownUsers = new Set();
  const knownEmails = new Set();
  const xrayOutbounds = [];
  const attribution = {};
  const disabledStatsByUser = {};

  if (!xrayCfg) {
    warnings.push('未配置 xray.configPath，无法自动发现用户和路由');
    const trackedOutbounds = normalizeOutbounds(cfg, []);
    return { warnings, configError: warnings[0], emailRecords, knownUsers: [], knownEmails: [], trackedOutbounds, attribution, xrayOutbounds, disabledStatsByUser: {}, showOutboundBreakdown: Boolean(cfg.track.forceShowOutboundNames) || trackedOutbounds.length > 1 };
  }
  if (xrayCfg._readError) {
    warnings.push('读取 Xray 配置失败: ' + xrayCfg._readError);
    const trackedOutbounds = normalizeOutbounds(cfg, []);
    return { warnings, configError: warnings[0], emailRecords, knownUsers: [], knownEmails: [], trackedOutbounds, attribution, xrayOutbounds, disabledStatsByUser: {}, showOutboundBreakdown: Boolean(cfg.track.forceShowOutboundNames) || trackedOutbounds.length > 1 };
  }

  for (const out of asArray(xrayCfg.outbounds)) {
    if (out && out.tag && out.tag !== 'api') xrayOutbounds.push(String(out.tag));
  }

  const inboundRoutes = {};
  for (let index = 0; index < asArray(xrayCfg.inbounds).length; index += 1) {
    const inbound = asArray(xrayCfg.inbounds)[index];
    if (!inbound) continue;
    const tag = effectiveInboundTag(inbound, index);
    if (tag === 'api') continue;
    inboundRoutes[tag] = routeForInbound(tag, xrayCfg, warnings);
    const clients = inboundClientRecords(inbound);
    for (const client of clients) {
      const email = client.email;
      knownEmails.add(email);
      const user = usernameFromEmail(email, cfg);
      knownUsers.add(user);
      if (!levelHasUserStats(xrayCfg, client.level)) {
        if (!disabledStatsByUser[user]) disabledStatsByUser[user] = new Set();
        disabledStatsByUser[user].add(client.level);
      }
      emailRecords.push({ email, level: client.level, inboundTag: tag, outboundTag: inboundRoutes[tag] });
    }
  }

  const manual = cfg.track && cfg.track.emailOutbounds ? cfg.track.emailOutbounds : {};
  const byEmail = new Map();
  for (const rec of emailRecords) {
    if (!byEmail.has(rec.email)) byEmail.set(rec.email, []);
    byEmail.get(rec.email).push(rec);
  }

  for (const [email, records] of byEmail.entries()) {
    const local = email.split('@')[0];
    const manualOutbound = manual[email] || manual[local];
    if (manualOutbound) {
      attribution[email] = String(manualOutbound);
      continue;
    }
    const candidates = new Set(records.map((r) => r.outboundTag).filter(Boolean));
    if (records.length > 1 && candidates.size !== 1) warnings.push('重复 email ' + email + ' 出现在多个 inbound 且出口归属不同；Xray 用户统计会按 email 合并');
    if (candidates.size === 1) attribution[email] = Array.from(candidates)[0];
    else {
      attribution[email] = null;
      warnings.push('email ' + email + ' 可能对应多个出口或无法确定出口；请在 track.emailOutbounds 里手动指定');
    }
  }

  const discoveredOutbounds = discoverEffectiveOutbounds(cfg, xrayCfg);
  const trackedOutbounds = normalizeOutbounds(cfg, discoveredOutbounds);
  for (const [user, levels] of Object.entries(disabledStatsByUser)) {
    warnings.push('用户 ' + user + ' 的 Xray policy level ' + Array.from(levels).sort((a, b) => a - b).join(', ') + ' 未启用双向 user Stats；该用户不能显示为 0 B');
  }
  return {
    warnings,
    configError: null,
    emailRecords,
    knownUsers: Array.from(knownUsers).sort(),
    knownEmails: Array.from(knownEmails).sort(),
    trackedOutbounds,
    showOutboundBreakdown: Boolean(cfg.track.forceShowOutboundNames) || trackedOutbounds.length > 1,
    disabledStatsByUser: Object.fromEntries(Object.entries(disabledStatsByUser).map(([user, levels]) => [user, Array.from(levels).sort((a, b) => a - b)])),
    attribution,
    xrayOutbounds
  };
}

function trafficFromDeltas(deltas) {
  const grouped = {};
  for (const [name, value] of Object.entries(deltas)) {
    const parts = statParts(name);
    if (!parts) continue;
    const key = parts.type + ':' + parts.id;
    if (!grouped[key]) grouped[key] = { type: parts.type, id: parts.id, uplink: 0, downlink: 0 };
    grouped[key][parts.direction] += Number(value || 0);
  }
  for (const item of Object.values(grouped)) item.total = item.uplink + item.downlink;
  return Object.values(grouped);
}

function applyTrafficToBucket(bucket, items, cfg, model, sampledAt) {
  bucket.firstSampleAt = bucket.firstSampleAt || sampledAt;
  bucket.lastSampleAt = sampledAt;
  bucket.samples += 1;

  const trackedTags = new Set(model.trackedOutbounds.map((o) => o.tag));
  for (const item of items) {
    if (item.type === 'user') {
      const email = item.id;
      const user = usernameFromEmail(email, cfg);
      addTraffic(ensureTraffic(bucket.byEmail, email), item.uplink, item.downlink);
      addTraffic(ensureTraffic(bucket.byUser, user), item.uplink, item.downlink);
      const outbound = model.attribution[email];
      if (outbound && trackedTags.has(outbound)) {
        if (!bucket.byUserOutbound[user]) bucket.byUserOutbound[user] = {};
        addTraffic(ensureTraffic(bucket.byUserOutbound[user], outbound), item.uplink, item.downlink);
      } else {
        addTraffic(ensureTraffic(bucket.unattributedByUser, user), item.uplink, item.downlink);
      }
    } else if (item.type === 'outbound') {
      if (trackedTags.has(item.id)) {
        addTraffic(ensureTraffic(bucket.byOutbound, item.id), item.uplink, item.downlink);
      }
    }
  }
  for (const warning of model.warnings) {
    if (!bucket.warnings.includes(warning)) bucket.warnings.push(warning);
  }
}

function applyDeltas(state, deltas, cfg, model) {
  const now = new Date();
  const sampledAt = now.toISOString();
  const items = trafficFromDeltas(deltas);
  const keys = {
    daily: bucketKey('daily', now),
    weekly: bucketKey('weekly', now),
    monthly: bucketKey('monthly', now)
  };
  for (const type of Object.keys(keys)) {
    const bucket = ensureBucket(state, type, keys[type]);
    applyTrafficToBucket(bucket, items, cfg, model, sampledAt);
  }
  state.lastSampleAt = sampledAt;
}

function rebuildBucketAttribution(bucket, cfg, model) {
  if (!bucket || !bucket.byEmail || typeof bucket.byEmail !== 'object') return;
  bucket.byUser = {};
  bucket.byUserOutbound = {};
  bucket.unattributedByUser = {};
  const trackedTags = new Set(model.trackedOutbounds.map((o) => o.tag));
  for (const [email, traffic] of Object.entries(bucket.byEmail)) {
    const user = usernameFromEmail(email, cfg);
    addTraffic(ensureTraffic(bucket.byUser, user), traffic.uplink, traffic.downlink);
    const outbound = model.attribution[email];
    if (outbound && trackedTags.has(outbound)) {
      if (!bucket.byUserOutbound[user]) bucket.byUserOutbound[user] = {};
      addTraffic(ensureTraffic(bucket.byUserOutbound[user], outbound), traffic.uplink, traffic.downlink);
    } else {
      addTraffic(ensureTraffic(bucket.unattributedByUser, user), traffic.uplink, traffic.downlink);
    }
  }
}

function rebuildStateAttribution(state, cfg, model) {
  for (const type of ['daily', 'weekly', 'monthly']) {
    for (const bucket of Object.values(state.buckets[type] || {})) rebuildBucketAttribution(bucket, cfg, model);
  }
}

function parseHHMM(value) {
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(value || '00:00'));
  if (!m) return { hour: 0, minute: 0 };
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function afterTime(now, hhmm) {
  const t = parseHHMM(hhmm);
  return now.getHours() > t.hour || (now.getHours() === t.hour && now.getMinutes() >= t.minute);
}

function targetReportKey(type, cfg, now, forceCurrent) {
  const reportCfg = cfg.reports[type] || {};
  if (type === 'daily') {
    const d = reportCfg.reportPreviousPeriod && !forceCurrent ? yesterday(now) : now;
    return bucketKey(type, d);
  }
  if (type === 'weekly') {
    const d = reportCfg.reportPreviousPeriod && !forceCurrent ? previousWeek(now) : now;
    return bucketKey(type, d);
  }
  if (type === 'monthly') {
    const d = reportCfg.reportPreviousPeriod && !forceCurrent ? previousMonth(now) : now;
    return bucketKey(type, d);
  }
  throw new Error('unknown report type: ' + type);
}

function dueReportTypes(cfg, state, now) {
  const out = [];
  const daily = cfg.reports.daily || {};
  if (daily.enabled && afterTime(now, daily.time)) {
    const key = targetReportKey('daily', cfg, now, false);
    if (!state.sentReports.daily[key]) out.push({ type: 'daily', key });
  }
  const weekly = cfg.reports.weekly || {};
  const weekday = now.getDay() || 7;
  if (weekly.enabled && weekday === Number(weekly.weekday || 1) && afterTime(now, weekly.time)) {
    const key = targetReportKey('weekly', cfg, now, false);
    if (!state.sentReports.weekly[key]) out.push({ type: 'weekly', key });
  }
  const monthly = cfg.reports.monthly || {};
  if (monthly.enabled && now.getDate() === Number(monthly.day || 1) && afterTime(now, monthly.time)) {
    const key = targetReportKey('monthly', cfg, now, false);
    if (!state.sentReports.monthly[key]) out.push({ type: 'monthly', key });
  }
  return out;
}

const maskIP = (ip) => {
  if (!ip) return '';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length === 4 ? parts[0] + '.' + parts[1] + '.*.*' : '***';
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.length > 3 ? parts[0] + ':' + parts[1] + ':' + parts[2] + ':*:*:*' : '***';
  }
  return '';
};

const escapeHtml = (unsafe) => {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const formatBytes = (bytes, decimals = 1) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals < 0 ? 0 : decimals)) + ' ' + sizes[i];
};

const formatTime = (timeStr) => {
  try {
    let date = new Date(timeStr);
    if (isNaN(date.getTime()) || date.getFullYear() < 2000) date = new Date();
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return y + '/' + m + '/' + d + ' ' + h + ':' + min + ':' + s + ' CST';
  } catch (e) {
    return String(timeStr || '');
  }
};

function templateConfig(cfg) {
  return {
    TOKEN: cfg.telegram.botToken || '',
    CHAT_ID: cfg.telegram.chatId || '',
    BASE_URL: cfg.komari.probeUrl || '',
    BRAND_NAME: cfg.komari.brandName || 'Xray Traffic Reporter',
    TOPIC_ID: cfg.telegram.topicId === undefined ? null : cfg.telegram.topicId
  };
}

async function sendMessage(cfg, htmlMessage, buttons = null, dryRun = false) {
  const CONFIG = templateConfig(cfg);
  if (dryRun) {
    console.log(htmlMessage);
    return true;
  }
  if (!CONFIG.TOKEN || CONFIG.TOKEN.includes('REPLACE') || !CONFIG.CHAT_ID) {
    console.warn('Telegram TOKEN or CHAT_ID is empty; skip sendMessage');
    return false;
  }
  if (typeof fetch !== 'function') throw new Error('Node.js fetch is unavailable; please use Node.js >= 18');
  const url = 'https://api.telegram.org/bot' + CONFIG.TOKEN + '/sendMessage';
  const payload = {
    chat_id: CONFIG.CHAT_ID,
    text: htmlMessage,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (CONFIG.TOPIC_ID !== null && CONFIG.TOPIC_ID !== undefined && CONFIG.TOPIC_ID !== '') payload.message_thread_id = CONFIG.TOPIC_ID;
  if (buttons && buttons.length > 0) payload.reply_markup = { inline_keyboard: buttons };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Telegram sendMessage failed: HTTP ' + res.status + ' ' + body);
  }
  return true;
}

function splitTelegramMessage(message, maxLen) {
  if (message.length <= maxLen) return [message];
  const chunks = [];
  let current = '';
  for (const line of message.split('\n')) {
    if ((current + '\n' + line).length > maxLen && current) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendLongMessage(cfg, htmlMessage, buttons, dryRun) {
  const chunks = splitTelegramMessage(htmlMessage, 3600);
  for (let i = 0; i < chunks.length; i += 1) {
    const suffix = chunks.length > 1 ? '\n<code>part ' + (i + 1) + '/' + chunks.length + '</code>' : '';
    await sendMessage(cfg, chunks[i] + suffix, i === 0 ? buttons : null, dryRun);
  }
}

async function sendEvent(event, cfg, dryRun = false) {
  const CONFIG = templateConfig(cfg);
  try {
    const getStatusInfo = (type) => {
      const map = {
        Offline: { icon: '🔴', title: 'Server Offline' },
        Online: { icon: '🟢', title: 'Server Online' },
        Alert: { icon: '⚠️', title: 'System Alert' },
        Renew: { icon: '', title: 'Auto Renewal' },
        Expire: { icon: '', title: 'Expiry Warning' },
        Login: { icon: '', title: 'User Login' },
        Test: { icon: '', title: 'Test Message' }
      };
      return map[type] || { icon: '', title: type };
    };
    const status = getStatusInfo(event.event);
    const inlineButtons = [];
    const statusNotes = [];
    let msg = '<b>' + escapeHtml(CONFIG.BRAND_NAME) + '</b>\n';
    const titleLine = status.icon ? status.icon + ' ' + status.title : status.title;
    msg += '<b>' + escapeHtml(titleLine) + '</b>\n\n';
    if (event.clients && event.clients.length > 0) {
      event.clients.forEach((client) => {
        msg += '<blockquote>';
        const region = client.region ? escapeHtml(client.region) + ' ' : '';
        const name = escapeHtml(client.name || 'Unknown');
        msg += '<b>' + region + name + '</b>\n';
        const osVer = escapeHtml(client.os || 'Linux') + ' ' + escapeHtml(client.version || '');
        msg += 'OS: <code>' + osVer + '</code>\n';
        if (client.cpu_name) msg += 'CPU: <code>' + escapeHtml(client.cpu_name.replace(/\\s+/g, ' ').trim()) + '</code>\n';
        if (client.gpu_name) msg += 'GPU: <code>' + escapeHtml(client.gpu_name) + '</code>\n';
        const specs = [];
        if (client.cpu_cores) specs.push(client.cpu_cores + 'C');
        if (client.mem_total) specs.push(formatBytes(client.mem_total, 0));
        if (client.disk_total) specs.push(formatBytes(client.disk_total, 0));
        if (specs.length) msg += 'Specs: <code>' + specs.join(' / ') + '</code>\n';
        const ip = maskIP(client.ipv4 || client.ipv6);
        if (ip) msg += 'IP: <code>' + ip + '</code>\n';
        if (['Offline', 'Online'].includes(event.event) && client.updated_at) {
          const label = event.event === 'Offline' ? 'Last Seen' : 'Recovered';
          statusNotes.push(label + ': <code>' + formatTime(client.updated_at) + '</code>');
        }
        if (event.event === 'Alert' && client.record) {
          const r = client.record;
          msg += '\n<b>Metrics</b>\n';
          if (r.cpu !== undefined) msg += 'CPU: ' + r.cpu.toFixed(1) + '% (Load: ' + r.load + ')\n';
          if (r.ram && r.ram_total) msg += 'RAM: ' + ((r.ram / r.ram_total) * 100).toFixed(1) + '% (' + formatBytes(r.ram) + ')\n';
          if (r.temp) msg += 'Temp: ' + r.temp + '°C\n';
          if (r.net_in !== undefined && r.net_out !== undefined) msg += 'Net: ↓' + formatBytes(r.net_in) + '/s ↑' + formatBytes(r.net_out) + '/s\n';
        }
        if (['Renew', 'Expire'].includes(event.event)) {
          msg += '\n<b>Billing Info</b>\n';
          const currency = client.currency || '$';
          msg += 'Price: ' + currency + client.price + ' (Cycle: ' + client.billing_cycle + ')\n';
          if (client.expired_at) msg += 'Expires: <code>' + formatTime(client.expired_at) + '</code>\n';
          if (event.event === 'Renew') msg += 'Status: Renewed successfully\n';
        }
        msg += '</blockquote>';
        if (client.uuid) inlineButtons.push([{ text: 'View Dashboard', url: CONFIG.BASE_URL + '/' + client.uuid }]);
        msg += '\n';
      });
    }
    const hasOriginalMessage = event.message && event.message.trim();
    const hasStatusNotes = statusNotes.length > 0;
    if (hasOriginalMessage || hasStatusNotes) {
      msg += '<b>Note</b>\n';
      let finalNote = '';
      if (hasOriginalMessage) finalNote += escapeHtml(event.message);
      if (hasStatusNotes) {
        if (hasOriginalMessage) finalNote += '\n\n';
        finalNote += statusNotes.join('\n');
      }
      msg += '<blockquote expandable>' + finalNote + '</blockquote>\n';
    }
    msg += '<code>' + formatTime(event.time) + '</code>';
    return await sendMessage(cfg, msg, inlineButtons, dryRun);
  } catch (error) {
    console.error('Notification Error:', error);
    return await sendMessage(cfg, '⚠️ <b>Error</b>\n<pre>' + escapeHtml(error.message) + '</pre>', null, dryRun);
  }
}

function reportTitle(type) {
  if (type === 'daily') return 'Xray 流量日报';
  if (type === 'weekly') return 'Xray 流量周报';
  if (type === 'monthly') return 'Xray 流量月报';
  return 'Xray 流量报告';
}

function trafficTotal(map) {
  const total = zeroTraffic();
  for (const item of Object.values(map || {})) addTraffic(total, item.uplink, item.downlink);
  return total;
}

function outboundName(tag, model) {
  const found = model.trackedOutbounds.find((o) => o.tag === tag);
  return found ? found.name : tag;
}

function renderTrafficReport(type, key, bucket, cfg, model) {
  const CONFIG = templateConfig(cfg);
  const nodeName = cfg.komari.nodeName || os.hostname();
  const buttons = CONFIG.BASE_URL ? [[{ text: 'View Dashboard', url: CONFIG.BASE_URL }]] : null;
  const byOutboundTotal = trafficTotal(bucket.byOutbound);
  const byUserTotal = trafficTotal(bucket.byUser);
  let msg = '<b>' + escapeHtml(CONFIG.BRAND_NAME) + '</b>\n';
  msg += '<b>📊 ' + escapeHtml(reportTitle(type)) + '</b>\n\n';
  if (model.configError) {
    msg += '<blockquote>';
    msg += '节点: <code>' + escapeHtml(nodeName) + '</code>\n';
    msg += '周期: <code>' + escapeHtml(key) + '</code>';
    msg += '</blockquote>\n\n';
    msg += '<b>采集配置错误</b>\n';
    msg += '<blockquote>' + escapeHtml(model.configError) + '\n报告已停止生成出口和用户归属，修复 Xray 配置读取权限后会自动恢复。</blockquote>\n';
    msg += '<code>' + formatTime(new Date().toISOString()) + '</code>';
    return { msg, buttons };
  }
  msg += '<blockquote>';
  msg += '节点: <code>' + escapeHtml(nodeName) + '</code>\n';
  msg += '周期: <code>' + escapeHtml(key) + '</code>\n';
  msg += '采样: <code>' + String(bucket.samples || 0) + '</code>\n';
  msg += '出口合计: <code>' + formatBytes(byOutboundTotal.total) + '</code> ↑<code>' + formatBytes(byOutboundTotal.uplink) + '</code> ↓<code>' + formatBytes(byOutboundTotal.downlink) + '</code>\n';
  msg += '用户合计: <code>' + formatBytes(byUserTotal.total) + '</code> ↑<code>' + formatBytes(byUserTotal.uplink) + '</code> ↓<code>' + formatBytes(byUserTotal.downlink) + '</code>';
  msg += '</blockquote>\n\n';

  if (model.showOutboundBreakdown && byOutboundTotal.total > 0) {
    msg += '<b>本机出口合计</b>\n<blockquote>';
    for (const outbound of model.trackedOutbounds) {
      const t = bucket.byOutbound[outbound.tag] || zeroTraffic();
      if (t.total <= 0) continue;
      msg += escapeHtml(outbound.name) + ': <code>' + formatBytes(t.total) + '</code> ↑' + formatBytes(t.uplink) + ' ↓' + formatBytes(t.downlink) + '\n';
    }
    msg += '</blockquote>\n';
  }

  const users = new Set(model.knownUsers);
  for (const u of Object.keys(bucket.byUser || {})) users.add(u);
  for (const u of Object.keys(bucket.unattributedByUser || {})) users.add(u);
  const sortedUsers = Array.from(users).sort((a, b) => a.localeCompare(b));

  msg += '\n<b>' + (model.showOutboundBreakdown ? '用户按出口' : '用户合计') + '</b>\n';
  if (!sortedUsers.length) {
    msg += '<blockquote>暂无用户统计。请确认 Xray client 配置了 email，并启用了 statsUserUplink/statsUserDownlink。</blockquote>\n';
  } else {
    for (const user of sortedUsers) {
      const t = bucket.byUser[user] || zeroTraffic();
      msg += '<blockquote>';
      const disabledLevels = model.disabledStatsByUser && model.disabledStatsByUser[user];
      if (disabledLevels && disabledLevels.length) {
        msg += '<b>' + escapeHtml(user) + '</b>: <code>统计未启用 (policy level ' + escapeHtml(disabledLevels.join(', ')) + ')</code>\n';
        msg += '</blockquote>\n';
        continue;
      }
      msg += '<b>' + escapeHtml(user) + '</b> 总: <code>' + formatBytes(t.total) + '</code> ↑' + formatBytes(t.uplink) + ' ↓' + formatBytes(t.downlink) + '\n';
      if (model.showOutboundBreakdown && t.total > 0) {
        for (const outbound of model.trackedOutbounds) {
          const ot = bucket.byUserOutbound[user] && bucket.byUserOutbound[user][outbound.tag] ? bucket.byUserOutbound[user][outbound.tag] : zeroTraffic();
          if (ot.total <= 0) continue;
          msg += escapeHtml(outbound.name) + ': <code>' + formatBytes(ot.total) + '</code>\n';
        }
      }
      if (t.total > 0) {
        const unknown = bucket.unattributedByUser[user] || zeroTraffic();
        if (unknown.total > 0) msg += '未归属出口: <code>' + formatBytes(unknown.total) + '</code>\n';
      }
      msg += '</blockquote>\n';
    }
  }

  const warnings = Array.from(new Set([].concat(bucket.warnings || [], model.warnings || []))).filter(Boolean);
  if (warnings.length) {
    msg += '\n<b>统计说明</b>\n<blockquote expandable>';
    for (const warning of warnings.slice(0, 12)) msg += escapeHtml(warning) + '\n';
    msg += '</blockquote>\n';
  }
  msg += '<code>' + formatTime(new Date().toISOString()) + '</code>';
  return { msg, buttons };
}

async function sendReport(type, key, state, cfg, model, dryRun) {
  const bucket = state.buckets[type][key] || makeBucket(key);
  const rendered = renderTrafficReport(type, key, bucket, cfg, model);
  await sendLongMessage(cfg, rendered.msg, rendered.buttons, dryRun);
  state.sentReports[type][key] = new Date().toISOString();
}

function pruneOldBuckets(state, cfg) {
  const keepDays = Number(cfg.runtime.retentionDays || 120);
  if (!keepDays || keepDays < 1) return;
  const cutoff = Date.now() - keepDays * 86400000;
  for (const [key, bucket] of Object.entries(state.buckets.daily || {})) {
    const t = Date.parse(key + 'T00:00:00');
    if (Number.isFinite(t) && t < cutoff) delete state.buckets.daily[key];
  }
}

async function sampleOnce(configPath, options) {
  const cfg = loadConfig(configPath);
  if (options.testTelegram && !options.once && !options.report) {
    await sendEvent({
      event: 'Test',
      time: new Date().toISOString(),
      message: 'Xray Sinffing Telegram template is working.',
      clients: [{
        name: cfg.komari.nodeName || os.hostname(),
        os: os.type(),
        version: os.release(),
        cpu_name: os.cpus()[0] ? os.cpus()[0].model : '',
        cpu_cores: os.cpus().length,
        mem_total: os.totalmem(),
        disk_total: 0,
        uuid: ''
      }]
    }, cfg, options.dryRun);
    return;
  }
  const state = loadState(cfg);
  const model = buildXrayModel(cfg);
  rebuildStateAttribution(state, cfg, model);
  const current = queryStats(cfg);

  if (!state.lastStats && cfg.runtime.initialSnapshotOnly) {
    state.lastStats = current;
    state.lastSampleAt = new Date().toISOString();
    state.notes.push({ at: state.lastSampleAt, message: 'initial snapshot only; no historical Xray counters were booked into reports' });
    writeJsonAtomic(cfg.runtime.statePath, state);
    console.log('Initial Xray stats snapshot saved. Next sample will book deltas.');
  } else {
    const deltas = diffStats(current, state.lastStats || {});
    applyDeltas(state, deltas, cfg, model);
    state.lastStats = current;
    pruneOldBuckets(state, cfg);
    writeJsonAtomic(cfg.runtime.statePath, state);
    console.log('Sample saved at ' + state.lastSampleAt);
  }

  if (options.testTelegram) {
    await sendEvent({
      event: 'Test',
      time: new Date().toISOString(),
      message: 'Xray Sinffing Telegram template is working.',
      clients: [{
        name: cfg.komari.nodeName || os.hostname(),
        os: os.type(),
        version: os.release(),
        cpu_name: os.cpus()[0] ? os.cpus()[0].model : '',
        cpu_cores: os.cpus().length,
        mem_total: os.totalmem(),
        disk_total: 0,
        uuid: ''
      }]
    }, cfg, options.dryRun);
  }

  const now = new Date();
  if (options.report) {
    const types = options.report === 'all' ? ['daily', 'weekly', 'monthly'] : [options.report];
    for (const type of types) {
      const key = targetReportKey(type, cfg, now, true);
      await sendReport(type, key, state, cfg, model, options.dryRun);
    }
    writeJsonAtomic(cfg.runtime.statePath, state);
  } else {
    for (const item of dueReportTypes(cfg, state, now)) {
      await sendReport(item.type, item.key, state, cfg, model, options.dryRun);
    }
    writeJsonAtomic(cfg.runtime.statePath, state);
  }
}

async function runDaemon(configPath, options) {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await sampleOnce(configPath, options);
    } catch (error) {
      console.error('sample failed: ' + error.stack);
    } finally {
      running = false;
    }
  };
  const cfg = loadConfig(configPath);
  const intervalMs = Math.max(30, Number(cfg.runtime.sampleIntervalSeconds || 300)) * 1000;
  process.on('SIGTERM', () => { stopped = true; process.exit(0); });
  process.on('SIGINT', () => { stopped = true; process.exit(0); });
  await run();
  setInterval(run, intervalMs);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  if (!commandExists(loadConfig(args.config).xray.binary)) {
    console.warn('WARN xray binary is not executable at configured path');
  }
  if (args.once || args.report || args.testTelegram) {
    await sampleOnce(args.config, args);
  } else {
    await runDaemon(args.config, args);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('ERROR: ' + error.stack);
    process.exit(1);
  });
}

module.exports = {
  buildXrayModel,
  discoverEffectiveOutbounds,
  normalizeOutbounds,
  effectiveInboundTag,
  rebuildBucketAttribution,
  routeForInbound,
  renderTrafficReport
};
