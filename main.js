'use strict';
// Node.js 22+. No third-party packages. Never put tokens in this file.
const {createHmac, randomUUID} = require('node:crypto');
const {setTimeout: sleep} = require('node:timers/promises');

class BotError extends Error {
  constructor(code, retrySeconds = 0, fatal = false) { super(code); Object.assign(this, {code, retrySeconds, fatal}); }
}
function settings(env = process.env) {
  const token = String(env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '').trim();
  const secret = String(env.BRIDGE_SECRET || '').trim();
  const url = String(env.GAS_WEB_APP_URL || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new BotError('BOT_TOKEN_MISSING_OR_INVALID', 0, true);
  if (secret.length < 32) throw new BotError('BRIDGE_SECRET_MISSING_OR_SHORT', 0, true);
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) {
    throw new BotError('GAS_WEB_APP_URL_MUST_END_WITH_EXEC', 0, true);
  }
  return {token, secret, url, botId: token.split(':')[0]};
}
function signedRequest(config, action, fields = {}, now = Date.now()) {
  const payload = JSON.stringify({...fields, action, bot_id: config.botId, ts: now, nonce: randomUUID()});
  return {payload, signature: createHmac('sha256', config.secret).update(payload, 'utf8').digest('hex')};
}
function createClient(config, fetchFn = fetch) {
  async function telegram(method, body = {}, signal) {
    let response;
    try {
      response = await fetchFn('https://api.telegram.org/bot' + config.token + '/' + method, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000)
      });
    } catch (_) { throw new BotError('TELEGRAM_NETWORK_ERROR'); }
    let result;
    try { result = await response.json(); } catch (_) { throw new BotError('TELEGRAM_INVALID_RESPONSE'); }
    if (!response.ok || !result.ok) {
      const code = Number(result.error_code || response.status);
      throw new BotError('TELEGRAM_' + code, Number(result.parameters?.retry_after || 0), [401, 404, 409].includes(code));
    }
    return result.result;
  }
  async function bridge(action, fields = {}, signal) {
    let response;
    try {
      response = await fetchFn(config.url, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify(signedRequest(config, action, fields)), redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000)
      });
    } catch (_) { throw new BotError('GOOGLE_NETWORK_ERROR'); }
    if (!response.ok) throw new BotError('GOOGLE_HTTP_' + response.status);
    let result;
    try { result = await response.json(); }
    catch (_) { throw new BotError('GOOGLE_NOT_JSON_CHECK_PUBLIC_DEPLOYMENT', 0, true); }
    if (!result.ok) {
      const fatal = ['AUTH', 'BOT_MISMATCH', 'SERVER_MODE_REQUIRED', 'BAD_REQUEST'].includes(result.code);
      // Do not log arbitrary remote text: it could contain credentials or personal data.
      const code = ['AUTH', 'BOT_MISMATCH', 'SERVER_MODE_REQUIRED', 'BAD_REQUEST', 'BUSY', 'PROCESSING_ERROR'].includes(result.code)
        ? result.code : 'UNKNOWN';
      throw new BotError('BRIDGE_' + code, code === 'BUSY' ? 2 : 0, fatal);
    }
    if (!Number.isSafeInteger(result.offset) || result.offset < 0) throw new BotError('GOOGLE_INVALID_OFFSET', 0, true);
    return result;
  }
  return {telegram, bridge};
}

async function run(config, options = {}) {
  const client = options.client || createClient(config);
  const wait = options.wait || sleep, log = options.log || console.log;
  const signal = options.signal;
  let offset = null, failures = 0, ready = false;
  while (!signal?.aborted) {
    try {
      if (!ready) {
        const me = await client.telegram('getMe', {}, signal);
        if (String(me.id) !== config.botId) throw new BotError('TELEGRAM_BOT_ID_MISMATCH', 0, true);
        const hook = await client.telegram('getWebhookInfo', {}, signal);
        if (hook.url) throw new BotError('WEBHOOK_ALREADY_SET_REMOVE_OTHER_CONNECTION', 0, true);
        offset = (await client.bridge('state', {}, signal)).offset;
        ready = true;
        log('READY: Telegram connected; Google bridge connected. Long polling started.');
      }
      // Telegram responds as soon as a message arrives; timeout is only the idle connection duration.
      const updates = await client.telegram('getUpdates', {offset, limit: 10, timeout: 25, allowed_updates: ['message']}, signal);
      if (!Array.isArray(updates)) throw new BotError('TELEGRAM_INVALID_UPDATES');
      if (updates.length) {
        const response = await client.bridge('updates', {updates}, signal);
        const highest = Math.max(...updates.map(u => u.update_id)) + 1;
        if (response.offset < offset || response.offset > highest) throw new BotError('OFFSET_CONFLICT_ONLY_ONE_SERVER_ALLOWED', 0, true);
        // Acknowledge only messages committed by Apps Script. On a network failure keep the old offset.
        offset = response.offset;
        log('Processed messages: ' + response.processed);
      }
      failures = 0;
    } catch (error) {
      if (signal?.aborted) break;
      if (!(error instanceof BotError)) throw new BotError('UNEXPECTED_ERROR', 0, true);
      if (error.fatal) throw error;
      failures++;
      const delay = Math.max(error.retrySeconds || 0, Math.min(30, 2 ** Math.min(failures, 5)));
      log(error.code + '; retry in ' + delay + ' seconds.');
      try { await wait(delay * 1000, undefined, signal ? {signal} : undefined); }
      catch (_) { if (signal?.aborted) break; throw new BotError('RETRY_INTERRUPTED'); }
    }
  }
  log('Stopped.');
}

if (require.main === module) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  Promise.resolve().then(() => run(settings(), {signal: controller.signal})).catch(error => {
    console.error('STOP: ' + (error instanceof BotError ? error.code : 'UNEXPECTED_ERROR'));
    process.exitCode = 1;
  });
}
module.exports = {BotError, settings, signedRequest, createClient, run};
