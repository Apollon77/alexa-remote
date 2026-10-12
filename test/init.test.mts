import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import AlexaRemote from '../build/alexa-remote.js';
import { FakeAmazon, createAlexa, call, initOptions } from './helpers.mts';

describe('init()', () => {
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

    it('checks the authentication with the customer status', () => {
        assert.equal(fake.find(/\/api\/customer-status/).length, 1);
        assert.equal(fake.find(/\/api\/bootstrap/).length, 0);
        // the authentication details are not delivered by Amazon anymore
        assert.equal(alexa.getAuthenticationDetails(), null);
        assert.ok(alexa.lastAuthCheck);
    });

    it('queries the owner customer id on demand for the TuneIn search', async () => {
        assert.equal(alexa.ownerCustomerId, null);
        await call(cb => alexa.tuneinSearch('radio 1', cb));
        assert.equal(alexa.ownerCustomerId, 'C1');
        assert.match(fake.last(/\/api\/tunein\/search/)!.path, /query=radio%201&mediaOwnerCustomerId=C1/);
        // the id is only queried once
        await call(cb => alexa.tuneinSearch('radio 2', cb));
        assert.equal(fake.find(/\/api\/users\/me/).length, 1);
    });

    it('extracts the CSRF token from the cookie', () => {
        assert.equal(alexa.csrf, 'CSRF123');
        assert.equal(alexa.cookie, 'session-id=1; csrf=CSRF123; ubid-acbde=UBID;');
    });

    it('uses the website API host from the endpoints', () => {
        assert.equal(alexa.baseUrl, 'alexa.amazon.de');
        assert.equal(alexa.endpoints?.alexaApiUrl, 'https://api.amazonalexa.com');
    });

    it('loads the communication account', () => {
        assert.equal(alexa.commsId, 'COMMS1');
    });

    it('loads all devices including app sub devices', () => {
        assert.deepEqual(Object.keys(alexa.serialNumbers).sort(), ['S1', 'S1-APP', 'S2']);
        const app = alexa.serialNumbers['S1-APP'];
        assert.equal(app.parentDeviceSerialNumber, 'S1');
        assert.equal(app.deviceType, 'T1-APP');
        assert.deepEqual(app.appDeviceList, []);
    });

    it('registers names, lower case names and friendly names', () => {
        assert.equal(alexa.names['Echo'].serialNumber, 'S1');
        assert.equal(alexa.names['echo (echo dot)'].serialNumber, 'S1');
        assert.equal(alexa.friendlyNames['Echo Dot'].serialNumber, 'S1');
    });

    it('calculates the helper flags of the devices', () => {
        const echo = alexa.serialNumbers.S1;
        assert.equal(echo.isControllable, true);
        assert.equal(echo.hasMusicPlayer, true);
        assert.equal(echo.isMultiroomDevice, false);
        assert.equal(echo.isMultiroomMember, false);
        const tv = alexa.serialNumbers.S2;
        assert.equal(tv.isControllable, true);
        assert.equal(tv.isMultiroomMember, true);
    });

    it('stores preferences, wake word and bluetooth state at the devices', () => {
        const echo = alexa.serialNumbers.S1;
        assert.equal(echo.preferences.timeZoneId, 'Europe/Vienna');
        assert.equal(echo.wakeWord, 'alexa');
        assert.equal(echo.bluetoothState['AA:BB'].address, 'AA:BB');
        assert.equal(typeof echo.bluetoothState['AA:BB'].connect, 'function');
    });

    it('binds helper methods to the device objects', async () => {
        const echo = alexa.serialNumbers.S1;
        for (const name of [
            'sendCommand',
            'setTunein',
            'playAudible',
            'rename',
            'setDoNotDisturb',
            'delete',
            'getDevicePreferences',
        ]) {
            assert.equal(typeof echo[name], 'function', name);
        }
        const { err } = await call(cb => echo.sendCommand('next', null, cb));
        assert.ifError(err);
        assert.equal(JSON.parse(fake.last(/\/api\/np\/command/)!.data).type, 'NextCommand');
    });

    it('updates existing device objects on a re-init instead of replacing them', async () => {
        const echo = alexa.serialNumbers.S1;
        await call(cb => alexa.initDeviceState(cb));
        assert.equal(alexa.serialNumbers.S1, echo);
    });

    it('emits the cookie event', async () => {
        const fake2 = new FakeAmazon();
        fake2.install();
        const alexa2 = new AlexaRemote();
        let event: any[] | undefined;
        alexa2.on('cookie', (...args) => (event = args));
        await call(cb => alexa2.init(initOptions(), cb));
        alexa2.stop();
        fake.install();
        assert.ok(event);
        assert.equal(event[1], 'CSRF123');
        assert.deepEqual(event[2], { device_private_key: 'KEY', adp_token: 'ADP' });
    });
});

describe('init() errors', () => {
    it('reports an error if the authentication check fails', async () => {
        const fake = new FakeAmazon().on(/\/api\/customer-status/, { error: new Error('ECONNRESET') });
        fake.install();
        const alexa = new AlexaRemote();
        const { err } = await call(cb => alexa.init(initOptions(), cb));
        fake.uninstall();
        alexa.stop();
        assert.match(err.message, /Error while checking Authentication/);
    });
});

describe('find()', () => {
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

    it('finds devices by serial number', () => {
        assert.equal(alexa.find('S2')?.accountName, 'Living room TV');
    });

    it('finds devices by name (case insensitive)', () => {
        assert.equal(alexa.find('ECHO')?.serialNumber, 'S1');
        assert.equal(alexa.find('living room tv')?.serialNumber, 'S2');
    });

    it('finds devices by friendly name', () => {
        assert.equal(alexa.find('Echo Dot')?.serialNumber, 'S1');
    });

    it('returns a given device object unchanged', () => {
        const device = alexa.serialNumbers.S1;
        assert.equal(alexa.find(device), device);
    });

    it('returns nothing for unknown devices', () => {
        assert.equal(alexa.find('unknown'), undefined);
        assert.equal(alexa.find(null), null);
        assert.equal(alexa.find(''), null);
    });
});
