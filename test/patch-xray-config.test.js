'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clientLevels, patchConfig } = require('../bin/patch-xray-config.js');

test('patcher enables user stats for every configured client level', () => {
  const cfg = {
    inbounds: [{
      tag: 'in',
      settings: {
        clients: [
          { email: 'level-zero@example.invalid' },
          { email: 'level-one@example.invalid', level: 1 },
          { email: 'level-three@example.invalid', level: 3 }
        ]
      }
    }],
    policy: { levels: { 0: { handshake: 4 } } }
  };

  assert.deepEqual(clientLevels(cfg), [0, 1, 3]);
  patchConfig(cfg, '127.0.0.1:10085');
  for (const level of ['0', '1', '3']) {
    assert.equal(cfg.policy.levels[level].statsUserUplink, true);
    assert.equal(cfg.policy.levels[level].statsUserDownlink, true);
  }
  assert.equal(cfg.policy.levels['0'].handshake, 4);
});
