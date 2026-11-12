'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = path.resolve(__dirname, '../bin/xray-sinffing.js');
const installer = fs.readFileSync(path.resolve(__dirname, '../install.sh'), 'utf8');
const accessFunctions = installer.slice(installer.indexOf('grant_xray_config_access() {'), installer.indexOf('\ngrant_xray_config_access\n'));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-access-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'xray');
  const source = path.join(dir, 'config.json');
  const state = path.join(dir, 'state.json');
  const config = path.join(dir, 'reporter.json');
  fs.writeFileSync(source, JSON.stringify({ outbounds: [{ tag: 'direct', protocol: 'freedom' }] }));
  fs.writeFileSync(binary, '#!' + process.execPath + '\n' + `
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] !== 'run' || args[1] !== '-dump') process.exit(42);
if (process.env.XRAY_TEST_DUMP_FAIL) { console.error('EACCES: unreadable confdir fragment'); process.exit(1); }
process.stdout.write(fs.readFileSync(args[3], 'utf8'));
`, { mode: 0o755 });
  fs.writeFileSync(config, JSON.stringify({ xray: { binary, configPath: source }, runtime: { statePath: state } }));
  return { dir, binary, source, state, config };
}

test('--check-config parses Xray config without querying stats, changing state or sending messages', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.state, '{"preserve":"historical traffic"}');
  const result = spawnSync(process.execPath, [cli, '--config', f.config, '--check-config'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Xray config OK/);
  assert.equal(fs.readFileSync(f.state, 'utf8'), '{"preserve":"historical traffic"}');
  fs.unlinkSync(f.state);
  const again = spawnSync(process.execPath, [cli, '--config', f.config, '--check-config'], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.existsSync(f.state), false);
});

test('--check-config fails on a missing config or unreadable merged fragment', (t) => {
  const f = fixture(t);
  const failedDump = spawnSync(process.execPath, [cli, '--config', f.config, '--check-config'], {
    encoding: 'utf8', env: { ...process.env, XRAY_TEST_DUMP_FAIL: '1' }
  });
  assert.equal(failedDump.status, 1);
  assert.match(failedDump.stderr, /EACCES: unreadable confdir fragment/);
  fs.unlinkSync(f.source);
  const missing = spawnSync(process.execPath, [cli, '--config', f.config, '--check-config'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/);
  assert.equal(fs.existsSync(f.state), false);
});

test('--check-config rejects options that would sample or send a report', (t) => {
  const f = fixture(t);
  for (const args of [['--once'], ['--report', 'daily'], ['--completed'], ['--test-telegram'], ['--dry-run']]) {
    const result = spawnSync(process.execPath, [cli, '--config', f.config, '--check-config', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be combined/);
  }
  assert.equal(fs.existsSync(f.state), false);
});

function grantAccess(f, source, extra = '') {
  // Stub privileged account operations; use real chmod on temporary files so
  // the regression covers the actual permission bits without requiring root.
  return spawnSync('bash', ['-c', `
set -euo pipefail
RUN_USER=xraystat
RUN_GROUP=xraystat
XRAY_CONFIG_PATH="$TEST_SOURCE"
APP_DIR=/opt/xray-sinffing
CONFIG_FILE=/etc/xray-sinffing/config.json
systemctl() { printf '%s' "\${TEST_SERVICE_USER-xray}"; }
id() {
  if [ "\${1-}" = -gn ]; then printf '%s' xray;
  elif [ "\${1-}" = -nG ]; then printf '%s' xraystat; cat "$TEST_DIR/groups" 2>/dev/null || true;
  fi
}
stat() { printf '%s' "\${TEST_CONFIG_GROUP-xray}"; }
usermod() { printf ' %s' "$3" >> "$TEST_DIR/groups"; }
chgrp() { printf '%s\\n' "$*" >> "$TEST_DIR/chgrp"; }
runuser() { printf '%s\\n' "$*" >> "$TEST_DIR/preflight"; return "\${TEST_PREFLIGHT_STATUS-0}"; }
${extra}
${accessFunctions}
grant_xray_config_access
`], { encoding: 'utf8', env: { ...process.env, TEST_DIR: f.dir, TEST_SOURCE: source } });
}

test('installer keeps 0750/0640 and adds the reporter to the config group even when Xray runs as root', (t) => {
  const f = fixture(t);
  const confdir = path.join(f.dir, 'protected');
  fs.mkdirSync(confdir, { mode: 0o750 });
  const source = path.join(confdir, 'config.json');
  fs.writeFileSync(source, '{}', { mode: 0o640 });
  const result = grantAccess(f, source, 'TEST_SERVICE_USER=root');
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(f.dir, 'groups'), 'utf8'), /xray/);
  assert.equal(fs.existsSync(path.join(f.dir, 'chgrp')), false, 'existing non-root group must be kept');
  assert.equal(fs.statSync(confdir).mode & 0o777, 0o750);
  assert.equal(fs.statSync(source).mode & 0o777, 0o640);
  assert.match(fs.readFileSync(path.join(f.dir, 'preflight'), 'utf8'), /--check-config/);
});

test('installer grants confdir fragments and symlink targets group read access', (t) => {
  const f = fixture(t);
  const confdir = path.join(f.dir, 'conf.d');
  fs.mkdirSync(confdir, { mode: 0o700 });
  const fragment = path.join(confdir, '01-base.json');
  const target = path.join(f.dir, 'external.json');
  const untouched = path.join(confdir, 'secret.key');
  for (const file of [fragment, target, untouched]) fs.writeFileSync(file, '{}', { mode: 0o600 });
  fs.symlinkSync(target, path.join(confdir, '02-linked.json'));
  const result = grantAccess(f, confdir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(confdir).mode & 0o777, 0o750);
  for (const file of [fragment, target]) assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(fs.statSync(untouched).mode & 0o777, 0o600);
});

test('installer refuses success when the service account cannot parse the config', (t) => {
  const f = fixture(t);
  const result = grantAccess(f, f.source, 'TEST_PREFLIGHT_STATUS=1');
  assert.equal(result.status, 1);
});

test('installer uses the reporter group for root-group configs when Xray runs as root', (t) => {
  const f = fixture(t);
  const result = grantAccess(f, f.source, 'TEST_SERVICE_USER=root; TEST_CONFIG_GROUP=root');
  assert.equal(result.status, 0, result.stderr);
  const changes = fs.readFileSync(path.join(f.dir, 'chgrp'), 'utf8');
  assert.match(changes, /xraystat /);
  assert.equal(fs.existsSync(path.join(f.dir, 'groups')), false, 'must not join the root group');
});
