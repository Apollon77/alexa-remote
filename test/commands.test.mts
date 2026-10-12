import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type AlexaRemote from '../build/alexa-remote.js';
import { FakeAmazon, createAlexa, call } from './helpers.mts';

describe('player and device commands', () => {
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

    const lastCommand = (): any => JSON.parse(fake.last(/\/api\/np\/command/)!.data);

    it('sends player commands to the device', async () => {
        await call(cb => alexa.sendCommand('S1', 'play', null, cb));
        const req = fake.last(/\/api\/np\/command/)!;
        assert.equal(req.path, '/api/np/command?deviceSerialNumber=S1&deviceType=T1');
        assert.equal(req.method, 'POST');
        assert.deepEqual(lastCommand(), { contentFocusClientId: null, type: 'PlayCommand' });
    });

    it('sends volume, shuffle, repeat and jump commands', async () => {
        await call(cb => alexa.sendCommand('S1', 'volume', '55', cb));
        assert.equal(lastCommand().volumeLevel, 55);
        await call(cb => alexa.sendCommand('S1', 'shuffle', 'on', cb));
        assert.equal(lastCommand().shuffle, true);
        await call(cb => alexa.sendCommand('S1', 'repeat', false, cb));
        assert.equal(lastCommand().repeat, false);
        await call(cb => alexa.sendCommand('S1', 'jump', 'media-1', cb));
        assert.equal(lastCommand().mediaId, 'media-1');
    });

    it('rejects invalid volumes and unknown devices', async () => {
        assert.match((await call(cb => alexa.sendCommand('S1', 'volume', 150, cb))).err.message, /between 0 and 100/);
        assert.equal(
            (await call(cb => alexa.sendCommand('nope', 'play', null, cb))).err.message,
            'Unknown Device or Serial number',
        );
    });

    it('ignores unknown commands', () => {
        const count = fake.requests.length;
        alexa.sendCommand('S1', 'unknown' as any, null, () => assert.fail('callback must not be called'));
        assert.equal(fake.requests.length, count);
    });

    it('sets do not disturb, alarm volume and renames devices', async () => {
        await call(cb => alexa.setDoNotDisturb('S1', true, cb));
        assert.deepEqual(JSON.parse(fake.last(/\/api\/dnd\/status/)!.data), {
            deviceSerialNumber: 'S1',
            deviceType: 'T1',
            enabled: true,
        });

        await call(cb => alexa.setAlarmVolume('S1', 30, cb));
        assert.equal(JSON.parse(fake.last(/\/api\/device-notification-state\/T1\/100\/S1/)!.data).volumeLevel, 30);

        await call(cb => alexa.renameDevice('S1', 'Kitchen', cb));
        const rename = fake.last(/\/api\/devices-v2\/device\/S1/)!;
        assert.equal(rename.method, 'PUT');
        assert.equal(JSON.parse(rename.data).accountName, 'Kitchen');
    });

    it('plays TuneIn stations with a double base64 encoded token', async () => {
        await call(cb => alexa.setTunein('S1', 's12345', cb));
        const token = JSON.parse(fake.last(/\/api\/entertainment\/v1\/player\/queue/)!.data).contentToken;
        const decoded = Buffer.from(Buffer.from(token.replace('music:', ''), 'base64').toString(), 'base64').toString();
        assert.equal(decoded, '["music/tuneIn/stationId","s12345"]|{"previousPageId":"TuneIn_SEARCH"}');
    });

    it('validates and plays music via search phrase', async () => {
        fake.on(/\/api\/behaviors\/operation\/validate/, {
            body: { result: 'VALID', operationPayload: '{"validated":true}' },
        });
        const { err } = await call(cb => alexa.playMusicProvider('S1', 'SPOTIFY', 'Queen', cb));
        assert.ifError(err);
        const validate = JSON.parse(fake.last(/operation\/validate/)!.data);
        assert.equal(validate.type, 'Alexa.Music.PlaySearchPhrase');
        assert.equal(JSON.parse(validate.operationPayload).searchPhrase, 'Queen');
        const sequence = JSON.parse(JSON.parse(fake.last(/\/api\/behaviors\/preview/)!.data).sequenceJson);
        assert.equal(sequence.startNode.operationPayload, '{"validated":true}');

        assert.equal(
            (await call(cb => alexa.playMusicProvider('S1', 'SPOTIFY', '', cb))).err.message,
            'Searchphrase empty',
        );
    });

    it('validates the equalizer and brightness values', async () => {
        assert.match(
            (await call(cb => alexa.setEqualizerSettings('S1', undefined, undefined, undefined, cb))).err.message,
            /At least one value/,
        );
        assert.match(
            (await call(cb => alexa.setEqualizerSettings('S1', 'x' as any, undefined, undefined, cb))).err.message,
            /Bass value/,
        );
        await call(cb => alexa.setEqualizerSettings('S1', 2, undefined, -1, cb));
        assert.deepEqual(JSON.parse(fake.last(/\/api\/equalizer\/S1\/T1/)!.data), { bass: 2, treble: -1 });

        assert.match((await call(cb => alexa.setBrightnessSetting('S1', 101, cb))).err.message, /between 0 and 100/);
    });

    it('reads and writes device settings as JSON values', async () => {
        fake.on(/\/settings\/displayPower/, { body: { value: '"ON"' } });
        const { res } = await call(cb => alexa.getDisplayPowerSetting('S1', cb));
        assert.equal(res, true);

        await call(cb => alexa.setClockTimeFormatSetting('S1', '24_HOURS', cb));
        const req = fake.last(/\/api\/v1\/devices\/A1\/settings\/timeFormat/)!;
        assert.equal(req.method, 'PUT');
        assert.deepEqual(JSON.parse(req.data), { value: '"24_HOURS"' });
    });

    it('queries smart home devices with a calculated timeout', async () => {
        await call(cb => alexa.querySmarthomeDevices(['id1', { entityId: 'id2', entityType: 'GROUP' }], cb));
        const req = fake.last(/\/api\/phoenix\/state/)!;
        assert.equal(req.method, 'POST');
        assert.equal(req.timeout, 15000);
        assert.deepEqual(JSON.parse(req.data).stateRequests, [
            { entityId: 'id1', entityType: 'APPLIANCE' },
            { entityId: 'id2', entityType: 'GROUP' },
        ]);
    });

    it('executes smart home actions', async () => {
        await call(cb => alexa.executeSmarthomeDeviceAction('id1', { action: 'turnOn' }, cb));
        const req = fake.last(/\/api\/phoenix\/state/)!;
        assert.equal(req.method, 'PUT');
        assert.deepEqual(JSON.parse(req.data).controlRequests, [
            { entityId: 'id1', entityType: 'APPLIANCE', parameters: { action: 'turnOn' } },
        ]);
    });

    it('queries the smart home devices via GraphQL', async () => {
        const lamp: any = {
            id: 'E1',
            friendlyName: 'Lamp',
            legacyAppliance: { applianceId: 'APP1', friendlyName: 'Lamp', entityId: 'ENT1' },
            legacyIdentifiers: { dmsIdentifier: { deviceType: { value: { text: 'LAMP' } } } },
        };
        const app = {
            ...lamp,
            legacyAppliance: { applianceId: 'APP2' },
            legacyIdentifiers: { dmsIdentifier: { deviceType: { value: { text: 'A2IVLV5VM2W81' } } } },
        };
        fake.on(/\/nexus\/v1\/graphql/, { body: { data: { endpoints: { items: [lamp, app, { id: 'NOID' }] } } } });

        const { res: v2 } = await call(cb => alexa.getSmarthomeDevicesV2(cb));
        assert.equal(v2.length, 3);
        const req = fake.last(/\/nexus\/v1\/graphql/)!;
        assert.equal(req.method, 'POST');
        assert.equal(req.timeout, 30000);
        assert.match(JSON.parse(req.data).query, /legacyAppliance/);

        // the old format: devices by bridge, app devices and devices without appliance id are skipped
        const { res } = await call(cb => alexa.getSmarthomeDevices(cb));
        const bridges = res.locationDetails.Default_Location.amazonBridgeDetails.amazonBridgeDetails;
        assert.deepEqual(Object.keys(bridges), ['LambdaBridge_APP1']);
        const device = bridges.LambdaBridge_APP1.applianceDetails.applianceDetails.APP1;
        assert.equal(device.entityId, 'ENT1');
        assert.equal(device.friendlyName, 'Lamp');
        assert.equal(device.legacyAppliance, undefined);

        fake.on(/\/nexus\/v1\/graphql/, { body: { errors: [] } });
        assert.equal((await call(cb => alexa.getSmarthomeDevices(cb))).err.message, 'Invalid response from server');
    });

    it('queries lists via the V2 lists API', async () => {
        fake.on(/alexashoppinglists\/api\/v2\/lists\/fetch/, {
            body: {
                listInfoList: [
                    // the count is delivered in aggregatedAttributes as JSON string
                    {
                        listId: 'L1',
                        listName: 'Shopping',
                        aggregatedAttributes: { totalActiveItemsCount: '{"count":2,"hasMore":false}' },
                        customerId: 'C1',
                    },
                ],
            },
        });
        const { res: lists } = await call(cb => alexa.getLists(cb));
        assert.equal(fake.last(/lists\/fetch/)!.host, 'www.amazon.de');
        assert.deepEqual(lists[0], {
            id: 'L1',
            listId: 'L1',
            itemId: 'L1',
            name: 'Shopping',
            createdDateTime: undefined,
            updatedDateTime: undefined,
            totalActiveItemsCount: 2,
            ownerCustomerId: 'C1',
        });

        fake.on(/lists\/L1\/items\/fetch/, {
            body: {
                itemInfoList: [{ itemId: 'I1', listId: 'L1', itemName: 'Milk', itemStatus: 'COMPLETE', version: 3 }],
            },
        });
        const { res: items } = await call(cb => alexa.getListItems('L1', cb));
        assert.equal(items[0].value, 'Milk');
        assert.equal(items[0].completed, true);
        assert.equal(items[0].version, 3);
        assert.match(fake.last(/lists\/L1\/items\/fetch/)!.path, /limit=100$/);
        assert.equal((await call(cb => alexa.getListItemsV2('', cb))).err.message, 'No listId provided');
    });

    it('manages list items via the V2 lists API', async () => {
        await call(cb => alexa.addListItem('L1', 'Milk', cb));
        const add = fake.last(/lists\/L1\/items$/)!;
        assert.equal(add.method, 'POST');
        assert.deepEqual(JSON.parse(add.data), { items: [{ itemType: 'KEYWORD', itemName: 'Milk' }] });

        const { err } = await call(cb => alexa.updateListItem('L1', 'I1', {}, cb));
        assert.equal(err.length, 2);

        await call(cb =>
            alexa.updateListItem('L1', 'I1', { version: 3, value: 'Bread', completed: true, note: 'x' }, cb),
        );
        const update = fake.last(/lists\/L1\/items\/I1/)!;
        assert.equal(update.method, 'PUT');
        assert.match(update.path, /\?version=3$/);
        assert.deepEqual(JSON.parse(update.data), {
            itemAttributesToUpdate: [
                { type: 'itemName', value: 'Bread' },
                { type: 'itemStatus', value: 'COMPLETE' },
                { type: 'note', value: 'x' },
            ],
            itemAttributesToRemove: [],
        });

        // the version is mandatory for delete, also with the old signature
        const { err: deleteErr } = await call(cb => (alexa as any).deleteListItem('L1', 'I1', cb));
        assert.equal(deleteErr.length, 1);
        await call(cb => alexa.deleteListItem('L1', 'I1', { version: 4 }, cb));
        const del = fake.last(/lists\/L1\/items\/I1/)!;
        assert.equal(del.method, 'DELETE');
        assert.match(del.path, /\?version=4$/);
    });

    it('reboots devices with cookie and access token', async () => {
        const { err } = await call(cb => alexa.rebootDevice('S1', cb));
        assert.ifError(err);
        const req = fake.last(/\/v1\/alexa\/device\/reboot/)!;
        assert.equal(req.host, 'alexa.amazon.de');
        assert.equal(req.path, '/v1/alexa/device/reboot/T1/S1');
        assert.equal(req.method, 'POST');
        assert.deepEqual(JSON.parse(req.data), { deviceSerialNumber: 'S1', deviceType: 'T1' });
        assert.equal(req.headers.authorization, 'Bearer ACCESS');
        assert.equal(req.headers.csrf, 'CSRF123');
        // also available at the device object
        assert.equal(typeof alexa.serialNumbers.S1.reboot, 'function');

        const { err: unknown } = await call(cb => alexa.rebootDevice('unknown', cb));
        assert.equal(unknown.message, 'Unknown Device or Serial number');
    });

    it('deletes conversations, also with the callback as second parameter', async () => {
        await call(cb => alexa.deleteConversation('CONV1', cb));
        const req = fake.last(/conversations\/CONV1/)!;
        assert.equal(req.method, 'DELETE');
        assert.equal(req.path, '/users/COMMS1/conversations/CONV1?lastMessageId=1');
    });

    it('sends text messages with random message ids', async () => {
        await call(cb => alexa.sendTextMessage('CONV1', 'Hi', cb));
        const [message] = JSON.parse(fake.last(/conversations\/CONV1\/messages/)!.data);
        assert.equal(message.payload.text, 'Hi');
        assert.equal(message.sender, 'COMMS1');
        assert.match(message.clientMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});

describe('voice history', () => {
    const fake = new FakeAmazon().on(/customer-history-records/, {
        body: {
            customerHistoryRecords: [
                {
                    recordKey: 'C1#1715335200000#T1#S1',
                    timestamp: 1715335200000,
                    utteranceType: 'GENERAL',
                    voiceHistoryRecordItems: [
                        { recordItemType: 'CUSTOMER_TRANSCRIPT', transcriptText: 'alexa what time is it' },
                        { recordItemType: 'ALEXA_RESPONSE', transcriptText: 'It is ten' },
                    ],
                },
                {
                    recordKey: 'C1#1715335100000#T1#S1',
                    timestamp: 1715335100000,
                    utteranceType: 'WAKE_WORD_ONLY',
                    voiceHistoryRecordItems: [],
                },
                { recordKey: 'C1#1#TX#UNKNOWN', timestamp: 1, voiceHistoryRecordItems: [] },
            ],
        },
    });
    let alexa: AlexaRemote;

    before(async () => {
        fake.install();
        alexa = await createAlexa();
    });

    after(() => {
        alexa.stop();
        fake.uninstall();
    });

    it('converts the records and strips the wake word', async () => {
        const { err, res } = await call<any[]>(cb => alexa.getCustomerHistoryRecords({ maxRecordSize: 5 }, cb));
        assert.ifError(err);
        // records of unknown devices are skipped
        assert.equal(res!.length, 2);
        assert.equal(res![0].deviceSerialNumber, 'S1');
        assert.equal(res![0].name, 'Echo');
        assert.equal(res![0].description.summary, 'what time is it');
        assert.equal(res![0].alexaResponse, 'It is ten');
    });

    it('uses the V2 API with the CSRF token of the activity page', () => {
        const req = fake.last(/customer-history-records/)!;
        assert.equal(req.method, 'POST');
        assert.match(req.path, /customer-history-records-v2\?startTime=\d+&endTime=\d+$/);
        assert.deepEqual(JSON.parse(req.data), { previousRequestToken: null });
        assert.equal(req.headers['anti-csrftoken-a2z'], 'ACTIVITY-CSRF');
        assert.match(req.headers.referer, /\/alexa-privacy\/apd\/activity/);
        assert.equal(fake.find(/\/alexa-privacy\/apd\/activity/).length, 1);
    });

    it('reuses the CSRF token and filters wake word only records', async () => {
        const { res } = await call<any[]>(cb => alexa.getCustomerHistoryRecords({ filter: true }, cb));
        assert.equal(res!.length, 1);
        assert.equal(fake.find(/\/alexa-privacy\/apd\/activity/).length, 1);
    });

    it('returns an error if the activity page has no CSRF token', async () => {
        alexa.activityCsrfToken = null;
        fake.on(/\/alexa-privacy\/apd\/activity/, { body: '<html></html>' });
        const { err } = await call(cb => alexa.getCustomerHistoryRecords(cb));
        assert.equal(err.message, 'CSRF Page has no token');
    });
});
