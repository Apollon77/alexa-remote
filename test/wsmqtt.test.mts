import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import AlexaWsMqttModule from '../build/alexa-wsmqtt.js';

const AlexaWsMqtt = (AlexaWsMqttModule as any).default as typeof AlexaWsMqttModule.default;

// Messages captured from a real connection (see comments in alexa-wsmqtt.ts), they contain valid checksums
const HANDSHAKE =
    'MSG 0x00000361 0x0e414e45 f 0x00000001 0xd7c62f29 0x0000009b INI 0x00000003 1.0 0x00000024 ff1c4525-c036-4942-bf6c-a098755ac82f 0x00000164d106ce6b END FABE';
const REGISTER =
    'MSG 0x00000362 0x0e414e46 f 0x00000001 0xf904b9f5 0x00000109 GWM MSG 0x0000b479 0x0000003b urn:tcomm-endpoint:device:deviceType:0:deviceSerialNumber:0 0x00000041 urn:tcomm-endpoint:service:serviceName:DeeWebsiteMessagingService {"command":"REGISTER_CONNECTION"}FABE';

const create = (protocolName?: 'A:H' | 'A:F'): any => {
    const ws: any = new AlexaWsMqtt({ amazonPage: 'amazon.de' }, 'session=1; ubid-acbde=123-4567890-1234567;');
    ws.protocolName = protocolName;
    return ws;
};

describe('AlexaWsMqtt', () => {
    it('extracts the account serial from the cookie', () => {
        assert.equal(create().accountSerial, '123-4567890-1234567');
    });

    it('is not connected initially', () => {
        assert.equal(create().isConnected(), false);
    });

    it('encodes numbers as padded hex', () => {
        const ws = create();
        assert.equal(ws.encodeNumber(255), '0x000000ff');
        assert.equal(ws.encodeNumber(255, 4), '0x00ff');
    });

    it('generates version 4 UUIDs', () => {
        assert.match(create().generateUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('computes the checksums of real messages', () => {
        const ws = create();
        // the checksum field (index 39-49) is excluded from the calculation
        assert.equal(ws.computeChecksum(Buffer.from(HANDSHAKE, 'ascii'), 39, 50), 0xd7c62f29);
        assert.equal(ws.computeChecksum(Buffer.from(REGISTER, 'ascii'), 39, 50), 0xf904b9f5);
    });

    it('rejects an invalid checksum window', () => {
        assert.throws(() => create().computeChecksum(Buffer.alloc(10), 5, 2), /Invalid checksum exclusion window/);
    });

    it('creates handshake and register messages with valid checksums (A:H)', () => {
        const ws = create('A:H');
        for (const msg of [ws.encodeGWHandshake(), ws.encodeGWRegisterAH(), ws.encodePing()]) {
            const checksum = parseInt(msg.toString('ascii', 39, 49), 16);
            assert.equal(ws.computeChecksum(msg, 39, 50), checksum);
        }
    });

    it('parses register messages (A:H)', () => {
        const message = create('A:H').parseIncomingMessage(Buffer.from(REGISTER, 'ascii'));
        assert.equal(message.service, 'FABE');
        assert.equal(message.channel, 0x362);
        assert.equal(message.checksum, 0xf904b9f5);
        assert.equal(message.content.messageType, 'GWM');
        assert.equal(message.content.channel, 0xb479);
        assert.deepEqual(message.content.payload, { command: 'REGISTER_CONNECTION' });
    });

    it('parses its own register and ping messages (A:F)', () => {
        const ws = create('A:F');
        const register = ws.parseIncomingMessage(ws.encodeGWRegisterAF());
        assert.equal(register.channel, 0x362);
        assert.equal(register.messageId, ws.messageId);
        assert.deepEqual(register.content.payload, { command: 'REGISTER_CONNECTION' });

        const ping = ws.parseIncomingMessage(ws.encodePing());
        assert.equal(ping.channel, 0x65);
        assert.equal(ping.content.messageType, 'PIN');
        // the payload contains "Regular" as UTF-16BE
        assert.ok(
            ping.content.payloadData.includes(
                Buffer.from('\u0000R\u0000e\u0000g\u0000u\u0000l\u0000a\u0000r', 'latin1'),
            ),
        );
    });

    it('parses TUNE messages with JSON content', () => {
        const msg = Buffer.from('0x00000000 0x00000030 {"protocolName":"A:H"}TUNE', 'ascii');
        const message = create('A:H').parseIncomingMessage(msg);
        assert.equal(message.service, 'TUNE');
        assert.deepEqual(message.content, { protocolName: 'A:H' });
    });

    it('signs requests with the device private key', () => {
        const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
        // macDms contains the PKCS#8 key without the PEM header and footer
        const key = privateKey
            .export({ type: 'pkcs8', format: 'pem' })
            .toString()
            .trim()
            .split('\n')
            .slice(1, -1)
            .join('');
        const ws: any = new AlexaWsMqtt({}, 'ubid-acbde=1;', { device_private_key: key, adp_token: 'ADP' });

        // the signature has the format "<base64>:<ISO date>"
        const [, signature, date] = ws
            .createRequestSignature('GET', '/tcomm/', '')
            .match(/^(.+):(\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/);
        const verify = createVerify('SHA256');
        verify.update(`GET\n/tcomm/\n${date}\n\nADP`);
        assert.ok(verify.verify(publicKey, signature, 'base64'));
    });
});
