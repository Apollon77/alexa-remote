import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type AlexaRemote from '../build/alexa-remote.js';
import { FakeAmazon, createAlexa, call } from './helpers.mts';

describe('HTTP requests', () => {
    const fake = new FakeAmazon();
    let alexa: AlexaRemote;

    before(async () => {
        fake.install();
        alexa = await createAlexa();
    });

    after(() => {
        alexa.stop();
        fake.uninstall();
    });

    it('sends requests to the website API host with cookie and CSRF headers', async () => {
        await call(cb => alexa.httpsGet('/api/test', cb));
        const req = fake.last(/\/api\/test/)!;
        assert.equal(req.host, 'alexa.amazon.de');
        assert.equal(req.method, 'GET');
        assert.equal(req.headers.csrf, 'CSRF123');
        assert.match(req.headers.Cookie, /csrf=CSRF123/);
        assert.match(req.headers['User-Agent'], /PitanguiBridge.*AlexaRemote\//);
        assert.equal(req.headers.Referer, 'https://alexa.amazon.de/spa/index.html');
    });

    it('replaces %t with the current timestamp', async () => {
        const before = Date.now();
        await call(cb => alexa.httpsGet('/api/time?_=%t', cb));
        const ts = Number(fake.last(/\/api\/time/)!.path.split('=')[1]);
        assert.ok(ts >= before && ts <= Date.now());
    });

    it('extracts the host from full URLs', async () => {
        await call(cb => alexa.httpsGet('https://other.amazon.de/some/path?x=1', cb));
        const req = fake.last(/other\.amazon\.de/)!;
        assert.equal(req.host, 'other.amazon.de');
        assert.equal(req.path, '/some/path?x=1');
    });

    it('sends POST data and custom headers', async () => {
        await call(cb => alexa.httpsGet('/api/post', cb, { data: '{"a":1}', headers: { 'X-Test': 'yes' } }));
        const req = fake.last(/\/api\/post/)!;
        assert.equal(req.method, 'POST');
        assert.equal(req.data, '{"a":1}');
        assert.equal(req.headers['X-Test'], 'yes');
    });

    it('uses the explicit method and timeout', async () => {
        await call(cb => alexa.httpsGet('/api/put', cb, { method: 'PUT', data: 'x', timeout: 1234 }));
        const req = fake.last(/\/api\/put/)!;
        assert.equal(req.method, 'PUT');
        assert.equal(req.timeout, 1234);
    });

    it('returns the parsed JSON body', async () => {
        fake.on(/\/api\/json/, { body: { hello: 'world' } });
        const { err, res } = await call(cb => alexa.httpsGet('/api/json', cb));
        assert.ifError(err);
        assert.deepEqual(res, { hello: 'world' });
    });

    it('decodes gzip and deflate responses', async () => {
        fake.on(/\/api\/gzip/, { body: { zipped: true }, encoding: 'gzip' });
        fake.on(/\/api\/deflate/, { body: { deflated: true }, encoding: 'deflate' });
        assert.deepEqual((await call(cb => alexa.httpsGet('/api/gzip', cb))).res, { zipped: true });
        assert.deepEqual((await call(cb => alexa.httpsGet('/api/deflate', cb))).res, { deflated: true });
    });

    it('returns success for empty 2xx responses', async () => {
        fake.on(/\/api\/empty/, { status: 200, body: '' });
        const { err, res } = await call(cb => alexa.httpsGet('/api/empty', cb));
        assert.ifError(err);
        assert.deepEqual(res, { success: true });
    });

    it('returns an error for empty error responses', async () => {
        fake.on(/\/api\/empty-error/, { status: 404, body: '' });
        const { err } = await call(cb => alexa.httpsGet('/api/empty-error', cb));
        assert.equal(err.message, 'no body');
    });

    it('returns an error and the body for invalid JSON', async () => {
        fake.on(/\/api\/html/, { body: '<html>nope</html>' });
        const { err, res } = await call(cb => alexa.httpsGet('/api/html', cb));
        assert.equal(err.message, 'no JSON');
        assert.equal(res, '<html>nope</html>');
    });

    it('returns an error on 401', async () => {
        fake.on(/\/api\/unauthorized/, { status: 401, body: { message: 'no' } });
        const { err } = await call(cb => alexa.httpsGet('/api/unauthorized', cb));
        assert.equal(err.message, '401 Unauthorized');
    });

    it('retries once on 503', async () => {
        let count = 0;
        fake.on(/\/api\/unavailable/, () => (++count === 1 ? { status: 503, body: 'down' } : { body: { ok: 2 } }));
        const { err, res } = await call(cb => alexa.httpsGet('/api/unavailable', cb));
        assert.ifError(err);
        assert.deepEqual(res, { ok: 2 });
        assert.equal(fake.find(/\/api\/unavailable/).length, 2);
    });

    it('returns an error on timeout', async () => {
        fake.on(/\/api\/slow/, { timeout: true });
        const { err } = await call(cb => alexa.httpsGet('/api/slow', cb));
        assert.equal(err.message, 'Timeout');
    });

    it('returns network errors', async () => {
        fake.on(/\/api\/broken/, { error: new Error('ECONNREFUSED') });
        const { err } = await call(cb => alexa.httpsGet('/api/broken', cb));
        assert.equal(err.message, 'ECONNREFUSED');
    });

    it('checks the authentication again only if the last check is older than 30 minutes', async () => {
        const checks = fake.find(/\/api\/customer-status/).length;
        alexa.lastAuthCheck = Date.now() - 20 * 60 * 1000;
        await call(cb => alexa.httpsGet('/api/before-check', cb));
        assert.equal(fake.find(/\/api\/customer-status/).length, checks);

        alexa.lastAuthCheck = Date.now() - 31 * 60 * 1000;
        await call(cb => alexa.httpsGet('/api/after-check', cb));
        assert.equal(fake.find(/\/api\/customer-status/).length, checks + 1);
        assert.ok(Date.now() - alexa.lastAuthCheck! < 1000);
    });

    it('treats 401 of the customer status as not authenticated and other errors as unknown', async () => {
        fake.on(/\/api\/customer-status/, { status: 401, body: 'Unauthorized' });
        const unauthorized = await new Promise<any[]>(resolve => alexa.checkAuthentication((...args) => resolve(args)));
        assert.equal(unauthorized[0], false);

        fake.on(/\/api\/customer-status/, { error: new Error('ECONNRESET') });
        const unknown = await new Promise<any[]>(resolve => alexa.checkAuthentication((...args) => resolve(args)));
        assert.equal(unknown[0], null);
        assert.equal(unknown[1].message, 'ECONNRESET');

        fake.on(/\/api\/customer-status/, { body: {} });
    });

    it('skips the authentication check with noCheck', async () => {
        const checks = fake.find(/\/api\/customer-status/).length;
        alexa.lastAuthCheck = Date.now() - 31 * 60 * 1000;
        await call(cb => alexa.httpsGet(true, '/api/no-check', cb));
        assert.equal(fake.find(/\/api\/customer-status/).length, checks);
        alexa.lastAuthCheck = Date.now();
    });

    it('sends the Accept-Language header and no Content-Type without body', async () => {
        await call(cb => alexa.httpsGet('/api/get', cb));
        const get = fake.last(/\/api\/get/)!;
        assert.equal(get.headers['Accept-Language'], 'de-DE');
        assert.equal(get.headers['Content-Type'], undefined);
        await call(cb => alexa.httpsGet('/api/post', cb, { data: '{}' }));
        assert.equal(fake.last(/\/api\/post/)!.headers['Content-Type'], 'application/json; charset=utf-8');
    });

    it('returns the raw body with handleAsText', async () => {
        fake.on(/\/api\/html/, { body: '<html></html>' });
        const { err, res } = await call(cb => alexa.httpsGet('/api/html', cb, { handleAsText: true }));
        assert.ifError(err);
        assert.equal(res, '<html></html>');
    });

    it('uses a browser user agent for the notifications API', async () => {
        await call(cb => alexa.getNotifications(cb));
        assert.match(fake.last(/\/api\/notifications/)!.headers['User-Agent'], /^Mozilla\/5\.0 \(iPhone/);
        await call(cb => alexa.httpsGet('/api/other', cb));
        assert.match(fake.last(/\/api\/other/)!.headers['User-Agent'], /PitanguiBridge/);
    });
});

describe('Alexa API requests (access token)', () => {
    const fake = new FakeAmazon();
    let alexa: AlexaRemote;

    before(async () => {
        fake.install();
        alexa = await createAlexa();
    });

    after(() => {
        alexa.stop();
        fake.uninstall();
    });

    it('requests an access token with the refresh token', async () => {
        await call(cb => alexa.httpsGetAuthApi('/v1/test', cb));
        const tokenReq = fake.last(/\/auth\/token/)!;
        assert.equal(tokenReq.method, 'POST');
        assert.match(tokenReq.data, /source_token=REFRESH/);
        assert.match(tokenReq.data, /app_name=TestApp/);
        assert.equal(alexa.authApiBearerToken, 'ACCESS');
    });

    it('sends the request with the bearer token and without cookie', async () => {
        await call(cb => alexa.httpsGetAuthApi('/v1/alerts/test', cb));
        const req = fake.last(/\/v1\/alerts\/test/)!;
        assert.equal(req.host, 'api.amazonalexa.com');
        assert.equal(req.headers.authorization, 'ACCESS');
        assert.equal(req.headers.Cookie, undefined);
        assert.equal(req.headers.csrf, undefined);
    });

    it('reuses a valid access token', async () => {
        const tokenCalls = fake.find(/\/auth\/token/).length;
        await call(cb => alexa.httpsGetAuthApi('/v1/again', cb));
        assert.equal(fake.find(/\/auth\/token/).length, tokenCalls);
    });

    it('renews the access token after 80 % of its lifetime', async () => {
        // the fake token is valid for one hour
        const lifetime = alexa.authApiBearerExpiry! - Date.now();
        const renewIn = alexa.authApiBearerRenewAt! - Date.now();
        assert.ok(Math.abs(renewIn - lifetime * 0.8) < 2000, `${renewIn} vs ${lifetime}`);

        const tokenCalls = fake.find(/\/auth\/token/).length;
        // still valid, but 80 % of the lifetime have passed
        alexa.authApiBearerRenewAt = Date.now() - 1;
        assert.equal(alexa.isApiBearerTokenValid(), false);
        await call(cb => alexa.httpsGetAuthApi('/v1/renew', cb));
        assert.equal(fake.find(/\/auth\/token/).length, tokenCalls + 1);
        assert.equal(alexa.isApiBearerTokenValid(), true);
    });

    it('requests a new access token when forced', async () => {
        const tokenCalls = fake.find(/\/auth\/token/).length;
        await new Promise(resolve => alexa.updateApiBearerToken(resolve));
        assert.equal(fake.find(/\/auth\/token/).length, tokenCalls);
        await new Promise(resolve => alexa.updateApiBearerToken(resolve, true));
        assert.equal(fake.find(/\/auth\/token/).length, tokenCalls + 1);
    });

    it('returns an error if no endpoints are known', async () => {
        const endpoints = alexa.endpoints;
        alexa.endpoints = null;
        const { err } = await call(cb => alexa.httpsGetAuthApi('/v1/x', cb));
        alexa.endpoints = endpoints;
        assert.match(err.message, /No endpoint set for alexaApiUrl/);
    });
});
