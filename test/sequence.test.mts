import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type AlexaRemote from '../build/alexa-remote.js';
import { FakeAmazon, createAlexa, call } from './helpers.mts';

describe('createSequenceNode()', () => {
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

    it('creates simple play nodes with the device placeholders replaced by the device data', () => {
        const node = alexa.createSequenceNode('weather', null, 'S1')!;
        assert.equal(node['@type'], 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode');
        assert.equal(node.type, 'Alexa.Weather.Play');
        assert.deepEqual(node.operationPayload, {
            deviceType: 'T1',
            deviceSerialNumber: 'S1',
            locale: 'ALEXA_CURRENT_LOCALE',
            customerId: 'C1',
        });
    });

    it('uses the override customer id', () => {
        const node = alexa.createSequenceNode('joke', null, 'S1', 'OTHER')!;
        assert.equal(node.operationPayload.customerId, 'OTHER');
    });

    it('converts decimal points to commas for non .com pages when speaking', () => {
        const node = alexa.createSequenceNode('speak', 'It is 21.5   degrees', 'S1')!;
        assert.equal(node.type, 'Alexa.Speak');
        assert.equal(node.skillId, 'amzn1.ask.1p.saysomething');
        assert.equal(node.operationPayload.textToSpeak, 'It is 21,5 degrees');
    });

    it('rejects empty and too long texts', () => {
        assert.throws(() => alexa.createSequenceNode('speak', '', 'S1'), /empty string/);
        assert.throws(() => alexa.createSequenceNode('speak', 'x'.repeat(251), 'S1'), /250 characters/);
    });

    it('validates the volume', () => {
        assert.equal(alexa.createSequenceNode('volume', '42', 'S1')!.operationPayload.value, 42);
        assert.throws(() => alexa.createSequenceNode('volume', 101, 'S1'), /between 0 and 100/);
    });

    it('creates wait and text command nodes', () => {
        assert.equal(alexa.createSequenceNode('wait', '5', 'S1')!.operationPayload.waitTimeInSeconds, 5);
        const text = alexa.createSequenceNode('textCommand', 'Turn ON the Light', 'S1')!;
        assert.equal(text.operationPayload.text, 'turn on the light');
    });

    it('returns null for unsupported curated tts values and undefined for unknown commands', () => {
        assert.equal(alexa.createSequenceNode('curatedtts', 'unknown', 'S1'), null);
        assert.equal(alexa.createSequenceNode('curatedtts', 'goodbye', 'S1')!.type, 'Alexa.CannedTts.Speak');
        assert.equal(alexa.createSequenceNode('unknown' as any, null, 'S1'), undefined);
    });

    it('creates stop nodes for one, several or all devices', () => {
        const one = alexa.createSequenceNode('deviceStop', null, 'S1')!;
        assert.deepEqual(one.operationPayload.devices, [{ deviceSerialNumber: 'S1', deviceType: 'T1' }]);
        const several = alexa.createSequenceNode('deviceStop', null, ['S1', 'unknown', 'S2'])!;
        assert.deepEqual(several.operationPayload.devices, [
            { deviceSerialNumber: 'S1', deviceType: 'T1' },
            { deviceSerialNumber: 'S2', deviceType: 'T2' },
        ]);
        const all = alexa.createSequenceNode('deviceStopAll', null, 'S1')!;
        assert.deepEqual(all.operationPayload.devices, [
            { deviceSerialNumber: 'ALEXA_ALL_DSN', deviceType: 'ALEXA_ALL_DEVICE_TYPE' },
        ]);
    });

    it('creates do not disturb nodes with duration or end time', () => {
        const duration = alexa.createSequenceNode('deviceDoNotDisturb', 3725, 'S1')!;
        assert.equal(duration.operationPayload.action, 'Enable');
        assert.equal(duration.operationPayload.duration, 'DURATION#PT1H2M5S');

        const until = alexa.createSequenceNode('deviceDoNotDisturb', '22:30', 'S1')!;
        assert.equal(until.operationPayload.until, 'TIME#T22:30');
        // time zone from the device preferences
        assert.equal(until.operationPayload.timeZoneId, 'Europe/Vienna');

        const off = alexa.createSequenceNode('deviceDoNotDisturbAll', false, 'S1')!;
        assert.equal(off.operationPayload.action, 'Disable');

        assert.throws(
            () => alexa.createSequenceNode('deviceDoNotDisturb', '22:30:00', 'S1'),
            /Invalid timepoint value/,
        );
    });

    it('creates announcement and ssml nodes for several devices', () => {
        const node = alexa.createSequenceNode('announcement', 'Dinner is ready', ['S1', 'S2'])!;
        assert.equal(node.type, 'AlexaAnnouncement');
        assert.equal(node.operationPayload.content[0].speak.type, 'text');
        assert.deepEqual(node.operationPayload.target.devices, [
            { deviceSerialNumber: 'S1', deviceTypeId: 'T1' },
            { deviceSerialNumber: 'S2', deviceTypeId: 'T2' },
        ]);
        const ssml = alexa.createSequenceNode('ssml', '<speak>Hi</speak>', 'S1')!;
        assert.equal(ssml.operationPayload.content[0].speak.type, 'ssml');
        assert.equal(ssml.operationPayload.content[0].display.body, 'Hi');
        assert.throws(() => alexa.createSequenceNode('ssml', 'Hi', 'S1'), /valid SSML/);
    });

    it('creates mobile push notifications with title', () => {
        const node = alexa.createSequenceNode('notification', { title: 'Title', text: 'Body' }, 'S1')!;
        assert.equal(node.operationPayload.title, 'Title');
        assert.equal(node.operationPayload.notificationMessage, 'Body');
        assert.equal(alexa.createSequenceNode('notification', 'Body', 'S1')!.operationPayload.title, 'ioBroker');
    });

    it('creates skill launch nodes', () => {
        const node = alexa.createSequenceNode('skill', 'amzn1.ask.skill.123', 'S1')!;
        assert.equal(node.skillId, 'amzn1.ask.skill.123');
        assert.deepEqual(node.operationPayload.targetDevice, { deviceType: 'T1', deviceSerialNumber: 'S1' });
    });

    it('supports Fire TV commands only for Fire TV devices', () => {
        const node = alexa.createSequenceNode('fireTVTurnOnOff', true, 'S2')!;
        assert.equal(node.type, 'Alexa.Operation.FireTV.TurnOn');
        assert.equal(node.operationPayload.deviceAccountId, 'A2');
        assert.equal(alexa.createSequenceNode('fireTVTurnOnOff', false, 'S2')!.type, 'Alexa.Operation.FireTV.TurnOff');
        assert.throws(() => alexa.createSequenceNode('fireTVPauseVideo', null, 'S1'), /not a Fire TV/);
    });
});

describe('buildSequenceNodeStructure()', () => {
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

    it('builds nested serial and parallel nodes', () => {
        const structure = alexa.buildSequenceNodeStructure('S1', [
            { command: 'speak', value: 'Hello' },
            {
                sequenceType: 'ParallelNode',
                nodes: [
                    { command: 'weather', value: null },
                    { command: 'volume', value: 10, device: 'S2' },
                ],
            },
            { command: 'curatedtts', value: 'invalid' },
        ]);
        assert.equal(structure['@type'], 'com.amazon.alexa.behaviors.model.SerialNode');
        // the invalid curated tts node is skipped
        assert.equal(structure.nodesToExecute.length, 2);
        const parallel = structure.nodesToExecute[1] as any;
        assert.equal(parallel['@type'], 'com.amazon.alexa.behaviors.model.ParallelNode');
        assert.equal(parallel.nodesToExecute[1].operationPayload.deviceSerialNumber, 'S2');
    });
});

describe('sendSequenceCommand()', () => {
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

    const lastSequence = (): { body: any; sequence: any } => {
        const body = JSON.parse(fake.last(/\/api\/behaviors\/preview/)!.data);
        return { body, sequence: JSON.parse(body.sequenceJson) };
    };

    it('sends the command as preview routine', async () => {
        const { err } = await call(cb => alexa.sendSequenceCommand('S1', 'speak', 'Hello', cb));
        assert.ifError(err);
        const { body, sequence } = lastSequence();
        assert.equal(body.behaviorId, 'PREVIEW');
        assert.equal(body.status, 'ENABLED');
        assert.equal(sequence['@type'], 'com.amazon.alexa.behaviors.model.Sequence');
        assert.equal(sequence.startNode.operationPayload.textToSpeak, 'Hello');
        // the locale placeholder is replaced
        assert.equal(sequence.startNode.operationPayload.locale, 'de-DE');
    });

    it('returns an error for unknown devices', async () => {
        const { err } = await call(cb => alexa.sendSequenceCommand('unknown', 'speak', 'Hello', cb));
        assert.equal(err.message, 'Unknown Device or Serial number');
    });

    it('allows "...All" commands without device', async () => {
        const { err } = await call(cb => alexa.sendSequenceCommand([], 'deviceStopAll', null, cb));
        assert.ifError(err);
        assert.equal(lastSequence().sequence.startNode.type, 'Alexa.DeviceControls.Stop');
    });

    it('returns errors thrown while creating the node', async () => {
        const { err } = await call(cb => alexa.sendSequenceCommand('S1', 'volume', 200, cb));
        assert.match(err.message, /between 0 and 100/);
    });

    it('executes routines by their automation id', async () => {
        const routine = {
            automationId: 'amzn1.alexa.automation.1',
            sequence: {
                '@type': 'com.amazon.alexa.behaviors.model.Sequence',
                sequenceId: 'seq1',
                startNode: {
                    deviceType: 'ALEXA_CURRENT_DEVICE_TYPE',
                    deviceSerialNumber: 'ALEXA_CURRENT_DSN',
                    customerId: 'ALEXA_CUSTOMER_ID',
                },
            },
        };
        await call(cb => alexa.executeAutomationRoutine('S1', routine, cb));
        const { body, sequence } = lastSequence();
        assert.equal(body.behaviorId, 'amzn1.alexa.automation.1');
        // the device placeholders are replaced with the data of the device
        assert.deepEqual(sequence.startNode, { deviceType: 'T1', deviceSerialNumber: 'S1', customerId: 'C1' });
    });

    it('sends multi sequence commands, also with the callback as third parameter', async () => {
        const { err } = await call(cb =>
            alexa.sendMultiSequenceCommand(
                'S1',
                [
                    { command: 'joke', value: null },
                    { command: 'weather', value: null },
                ],
                cb,
            ),
        );
        assert.ifError(err);
        const start = lastSequence().sequence.startNode;
        assert.equal(start['@type'], 'com.amazon.alexa.behaviors.model.SerialNode');
        assert.deepEqual(
            start.nodesToExecute.map((n: any) => n.type),
            ['Alexa.Joke.Play', 'Alexa.Weather.Play'],
        );
    });

    it('returns errors of multi sequence commands', async () => {
        const { err } = await call(cb =>
            alexa.sendMultiSequenceCommand('S1', [{ command: 'speak', value: '' }], 'ParallelNode', null, cb),
        );
        assert.match(err.message, /empty string/);
    });
});
