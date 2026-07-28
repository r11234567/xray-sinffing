#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function usage() {
  console.log([
    'Usage:',
    '  patch-xray-config.js --config /usr/local/etc/xray/config.json --api-server 127.0.0.1:10085 [--apply] [--test]',
    '',
    'Options:',
    '  --config PATH        Xray config path',
    '  --api-server HOST:PORT',
    '  --apply             Write patched config and create a timestamped backup',
    '  --test              Run "xray run -test -config PATH" after writing',
    '  --xray-bin PATH     Xray binary path, default: /usr/local/bin/xray'
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    config: '/usr/local/etc/xray/config.json',
    apiServer: '127.0.0.1:10085',
    apply: false,
    test: false,
    xrayBin: '/usr/local/bin/xray'
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--test') args.test = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--api-server') args.apiServer = argv[++i];
    else if (a === '--xray-bin') args.xrayBin = argv[++i];
    else throw new Error('unknown argument: ' + a);
  }
  return args;
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

function readJson(file) {
  return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
}

function dumpConfig(source, xrayBin) {
  const stat = fs.statSync(source);
  const flag = stat.isDirectory() ? '-confdir' : '-config';
  const result = spawnSync(xrayBin, ['run', '-dump', flag, source], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(((result.stderr || '') + (result.stdout || '')).trim() || 'xray config dump failed');
  return JSON.parse(result.stdout);
}

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) parent[key] = {};
  return parent[key];
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function inspectClients(cfg) {
  const seen = new Map();
  const missing = [];
  for (const inbound of asArray(cfg.inbounds)) {
    const tag = inbound && inbound.tag ? inbound.tag : '(untagged-inbound)';
    const clients = inbound && inbound.settings && Array.isArray(inbound.settings.clients) ? inbound.settings.clients : [];
    for (let i = 0; i < clients.length; i += 1) {
      const email = clients[i] && clients[i].email;
      if (!email) {
        missing.push(tag + '#' + i);
        continue;
      }
      const key = String(email).trim();
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(tag);
    }
  }
  const duplicates = [];
  for (const [email, tags] of seen.entries()) {
    if (tags.length > 1) duplicates.push(email + ' (' + tags.join(', ') + ')');
  }
  return { missing, duplicates };
}

function clientLevels(cfg) {
  const levels = new Set([0]);
  for (const inbound of asArray(cfg.inbounds)) {
    const clients = inbound && inbound.settings && Array.isArray(inbound.settings.clients) ? inbound.settings.clients : [];
    for (const client of clients) {
      const level = Number(client && client.level !== undefined ? client.level : 0);
      if (Number.isInteger(level) && level >= 0) levels.add(level);
    }
  }
  return Array.from(levels).sort((a, b) => a - b);
}

function patchConfig(cfg, apiServer) {
  const api = ensureObject(cfg, 'api');
  api.tag = api.tag || 'api';
  api.listen = apiServer;
  const services = new Set(asArray(api.services));
  services.add('StatsService');
  api.services = Array.from(services);

  ensureObject(cfg, 'stats');

  const policy = ensureObject(cfg, 'policy');
  const levels = ensureObject(policy, 'levels');
  for (const level of clientLevels(cfg)) {
    const key = String(level);
    const levelCfg = ensureObject(levels, key);
    levelCfg.statsUserUplink = true;
    levelCfg.statsUserDownlink = true;
  }

  const system = ensureObject(policy, 'system');
  system.statsInboundUplink = true;
  system.statsInboundDownlink = true;
  system.statsOutboundUplink = true;
  system.statsOutboundDownlink = true;
  return cfg;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  const cfgPath = path.resolve(args.config);
  const sourceStat = fs.statSync(cfgPath);
  const sourceIsDir = sourceStat.isDirectory();
  const cfg = patchConfig(sourceIsDir ? dumpConfig(cfgPath, args.xrayBin) : readJson(cfgPath), args.apiServer);
  const warnings = inspectClients(cfg);
  const fragmentPath = path.join(cfgPath, '99-xray-sinffing.json');
  const outputConfig = sourceIsDir ? {
    api: cfg.api,
    stats: cfg.stats,
    policy: cfg.policy
  } : cfg;
  const formatted = JSON.stringify(outputConfig, null, 2) + '\n';

  if (!args.apply) {
    process.stdout.write(formatted);
    if (warnings.missing.length) console.error('WARN missing client email: ' + warnings.missing.join(', '));
    if (warnings.duplicates.length) console.error('WARN duplicate client email; user-by-outbound attribution may be ambiguous: ' + warnings.duplicates.join('; '));
    return;
  }

  const targetPath = sourceIsDir ? fragmentPath : cfgPath;
  let backup = null;
  if (fs.existsSync(targetPath)) {
    backup = targetPath + '.bak-xray-sinffing-' + timestamp();
    fs.copyFileSync(targetPath, backup, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(targetPath, formatted, { mode: 0o644 });
  console.log('patched: ' + targetPath);
  if (backup) console.log('backup:  ' + backup);
  if (warnings.missing.length) console.warn('WARN missing client email: ' + warnings.missing.join(', '));
  if (warnings.duplicates.length) console.warn('WARN duplicate client email; user-by-outbound attribution may be ambiguous: ' + warnings.duplicates.join('; '));

  if (args.test) {
    const testArgs = sourceIsDir ? ['run', '-test', '-confdir', cfgPath] : ['run', '-test', '-config', cfgPath];
    const result = spawnSync(args.xrayBin, testArgs, { encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) process.exit(result.status || 1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('ERROR: ' + error.message);
    process.exit(1);
  }
}

module.exports = { clientLevels, inspectClients, patchConfig };
