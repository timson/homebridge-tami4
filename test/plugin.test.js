const assert = require('node:assert/strict');
const { test } = require('node:test');
const initialize = require('../index');

test('the fork registers with Homebridge using its scoped npm name', () => {
  let registration;
  initialize({ registerPlatform: (...args) => { registration = args; } });
  assert.equal(registration[0], '@timson81/homebridge-tami4');
  assert.equal(registration[1], 'Tami4');
  assert.equal(typeof registration[2], 'function');
});
