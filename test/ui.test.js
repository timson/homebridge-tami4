const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const html = readFileSync(join(__dirname, '../homebridge-ui/public/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createUi({ captcha, request = async () => ({ refreshToken: 'new-token' }) } = {}) {
  const elements = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    elements.set(id, {
      value: '',
      style: {},
      disabled: false,
      addEventListener(event, handler) { this[event] = handler; },
      setAttribute() { this.disabled = true; },
      removeAttribute() { this.disabled = false; }
    });
  }

  const errors = [];
  const requests = [];
  const config = [{ platform: 'Tami4', refreshToken: 'old-token' }];
  const timers = new Map();
  const homebridge = {
    getPluginConfig: async () => config,
    updatePluginConfig: async () => {},
    addEventListener() {},
    showSchemaForm() {},
    showSpinner() { this.spinning = true; },
    hideSpinner() { this.spinning = false; },
    toast: { error: (message) => errors.push(message) },
    request: async (...args) => {
      requests.push(args);
      return request(...args);
    }
  };

  runInNewContext(script, {
    document: { getElementById: (id) => elements.get(id) },
    window: { homebridge, grecaptcha: captcha },
    homebridge,
    setTimeout: (callback) => {
      const id = timers.size + 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    console
  });

  elements.get('phoneNumberInput').value = '+972524001234';
  elements.get('otpInput').value = '123456';
  return { elements, errors, requests, config, timers, homebridge };
}

const readyCaptcha = {
  ready: (callback) => callback(),
  execute: async () => 'captcha-token'
};

test('Homebridge CSP permits the reCAPTCHA scripts and frames', () => {
  const schema = JSON.parse(readFileSync(join(__dirname, '../config.schema.json'), 'utf8'));
  for (const origin of ['https://www.google.com', 'https://www.gstatic.com', 'https://recaptcha.google.com']) {
    assert.ok(schema.customUiCspDomains.includes(origin), `Missing CSP origin: ${origin}`);
  }
});

for (const button of ['step1Submit', 'step2Submit']) {
  test(`${button}: unavailable reCAPTCHA displays guidance and allows retry`, async () => {
    const ui = createUi();
    await ui.elements.get(button).click();
    assert.match(ui.errors[0], /reCAPTCHA could not load/);
    assert.equal(ui.requests.length, 0);
    assert.equal(ui.homebridge.spinning, false);
    assert.equal(ui.elements.get(button).disabled, false);
  });

  test(`${button}: reCAPTCHA readiness timeout restores the UI`, async () => {
    const ui = createUi({ captcha: { ready() {} } });
    const pending = ui.elements.get(button).click();
    for (const callback of ui.timers.values()) callback();
    await pending;
    assert.match(ui.errors[0], /reCAPTCHA could not load/);
    assert.equal(ui.requests.length, 0);
    assert.equal(ui.homebridge.spinning, false);
    assert.equal(ui.elements.get(button).disabled, false);
    assert.equal(ui.timers.size, 0);
  });

  test(`${button}: rejected CAPTCHA and OTP requests restore the UI`, async () => {
    for (const failure of ['captcha', 'request']) {
      const ui = createUi({
        captcha: {
          ...readyCaptcha,
          execute: async () => {
            if (failure === 'captcha') throw new Error('CAPTCHA failed');
            return 'captcha-token';
          }
        },
        request: async () => { throw new Error('OTP failed'); }
      });
      await ui.elements.get(button).click();
      assert.equal(ui.errors[0], failure === 'captcha' ? 'CAPTCHA failed' : 'OTP failed');
      assert.equal(ui.homebridge.spinning, false);
      assert.equal(ui.elements.get(button).disabled, false);
      assert.equal(ui.timers.size, 0);
    }
  });
}

test('OTP request waits for reCAPTCHA readiness before advancing', async () => {
  let ready;
  const ui = createUi({ captcha: { ...readyCaptcha, ready: (callback) => { ready = callback; } } });
  const pending = ui.elements.get('step1Submit').click();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.elements.get('step1Submit').disabled, true);
  ready();
  await pending;
  assert.equal(ui.requests[0][0], '/request-otp');
  assert.equal(ui.requests[0][1].token, 'captcha-token');
  assert.equal(ui.elements.get('step2').style.display, 'block');
  assert.equal(ui.errors.length, 0);
});

test('successful OTP verification saves a token and can restart the flow', async () => {
  const ui = createUi({ captcha: readyCaptcha });
  await ui.elements.get('step1Submit').click();
  await ui.elements.get('step2Submit').click();
  assert.equal(ui.config[0].refreshToken, 'new-token');
  assert.equal(ui.requests[1][0], '/check-otp');
  assert.equal(ui.requests[1][1].code, '123456');
  assert.equal(ui.elements.get('setupComplete').style.display, 'block');
  assert.equal(ui.homebridge.spinning, false);
  assert.equal(ui.errors.length, 0);

  await ui.elements.get('startOver').click();
  assert.equal(ui.elements.get('step1').style.display, 'block');
  assert.equal(ui.elements.get('step2').style.display, 'none');
  assert.equal(ui.elements.get('otpInput').value, '');
});

test('OTP response without a refresh token reports the failure', async () => {
  const ui = createUi({ captcha: readyCaptcha, request: async () => ({}) });
  await ui.elements.get('step2Submit').click();
  assert.equal(ui.errors[0], 'No Refresh Token');
  assert.equal(ui.config[0].refreshToken, 'old-token');
  assert.equal(ui.homebridge.spinning, false);
  assert.equal(ui.elements.get('step2Submit').disabled, false);
});
