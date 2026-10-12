import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import AlexaHttp2PushModule from '../build/alexa-http2push.js';

const AlexaHttp2Push = (AlexaHttp2PushModule as any).default as typeof AlexaHttp2PushModule.default;
const findJsonEnd = (AlexaHttp2PushModule as any).findJsonEnd as typeof AlexaHttp2PushModule.findJsonEnd;

/** Fake HTTP/2 session that records the connection and lets the test push data */
class FakeSession extends EventEmitter {
    url: string;
    headers: Record<string, any> | undefined;
    stream = Object.assign(new EventEmitter(), { end: (): void => undefined, destroy: (): void => undefined });
    pings = 0;

    constructor(url: string) {
        super();
        this.url = url;
    }

    request(headers: Record<string, any>): EventEmitter {
        this.headers = headers;
        return this.stream;
    }

    ping(cb: () => void): void {
        this.pings++;
        setImmediate(cb);
    }

    close(): void {
        this.emit('close');
    }

    destroy(): void {
        // nothing to do
    }
}

/** A push message as sent by Amazon */
const pushChunk = (command: string, payload: Record<string, any>): Buffer =>
    Buffer.from(
        `Content-Type: application/json\r\n\r\n${JSON.stringify({
            directive: {
                payload: {
                    renderingUpdates: [
                        { resourceMetadata: JSON.stringify({ command, payload: JSON.stringify(payload) }) },
                    ],
                },
            },
        })}\r\n`,
    );

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('AlexaHttp2Push', () => {
    const originalConnect = http2.connect;
    let session: FakeSession;
    let push: InstanceType<typeof AlexaHttp2Push>;

    beforeEach(() => {
        (http2 as any).connect = (url: string, listener: () => void): FakeSession => {
            session = new FakeSession(url);
            setImmediate(listener);
            return session;
        };
    });

    afterEach(() => {
        push?.disconnect();
        (http2 as any).connect = originalConnect;
    });

    const connect = async (options: Record<string, any> = {}): Promise<void> => {
        push = new AlexaHttp2Push(options, cb => cb('TOKEN'));
        push.connect();
        await tick();
    };

    it('connects to the EU endpoint with the access token', async () => {
        await connect({ amazonPage: 'amazon.de' });
        assert.equal(session.url, 'https://bob-dispatch-prod-eu.amazon.com');
        assert.equal(session.headers![':path'], '/v20160207/directives');
        assert.equal(session.headers!.authorization, 'Bearer TOKEN');
    });

    it('selects the endpoint by Amazon page', async () => {
        await connect({ amazonPage: 'amazon.com' });
        assert.equal(session.url, 'https://bob-dispatch-prod-na.amazon.com');
        push.disconnect();
        await connect({ amazonPage: 'amazon.co.jp' });
        assert.equal(session.url, 'https://bob-dispatch-prod-fe.amazon.com');
        push.disconnect();
        await connect({ amazonPage: 'amazon.de', pushDispatchHost: 'push.example.com' });
        assert.equal(session.url, 'https://push.example.com');
    });

    it('emits connect after the first boundary and the answered ping', async () => {
        await connect();
        let connected = false;
        push.on('connect', () => (connected = true));
        assert.equal(push.isConnected(), false);
        session.stream.emit('data', Buffer.from('------abcdef\r\n'));
        await tick();
        assert.equal(connected, true);
        assert.equal(push.isConnected(), true);
        assert.equal(session.pings, 1);
    });

    it('emits push messages as commands', async () => {
        await connect();
        const received: [string, any][] = [];
        push.on('command', (command, payload) => received.push([command, payload]));
        session.stream.emit('data', pushChunk('PUSH_VOLUME_CHANGE', { volumeSetting: 30, isMuted: false }));
        assert.deepEqual(received, [['PUSH_VOLUME_CHANGE', { volumeSetting: 30, isMuted: false }]]);
    });

    it('reports unparsable push messages', async () => {
        await connect();
        let unexpected: string | undefined;
        push.on('unexpected-response', msg => (unexpected = msg));
        session.stream.emit('data', Buffer.from('Content-Type: application/json\r\n\r\n{invalid}'));
        assert.match(unexpected!, /Could not parse json/);
    });

    it('reassembles messages split across several chunks (#311)', async () => {
        await connect();
        const received: [string, any][] = [];
        push.on('command', (command, payload) => received.push([command, payload]));
        // payload with braces and escaped quotes inside strings and a multibyte character
        const payload = { text: 'a {b} "c" ü €', quality: { badge: { url: 'https://x/HD.png' } } };
        const chunk = Buffer.concat([
            Buffer.from('------boundary\r\n'),
            pushChunk('PUSH_AUDIO_PLAYER_STATE', payload),
            Buffer.from('------boundary\r\n'),
        ]);
        // split at every position, also inside multibyte characters
        for (const size of [1, 7, 50]) {
            for (let i = 0; i < chunk.length; i += size) {
                session.stream.emit('data', chunk.subarray(i, i + size));
            }
        }
        assert.equal(received.length, 3);
        for (const [command, data] of received) {
            assert.equal(command, 'PUSH_AUDIO_PLAYER_STATE');
            assert.deepEqual(data, payload);
        }
    });

    it('processes several messages in one chunk', async () => {
        await connect();
        const received: string[] = [];
        push.on('command', command => received.push(command));
        session.stream.emit(
            'data',
            Buffer.concat([
                Buffer.from('------boundary\r\n'),
                pushChunk('PUSH_VOLUME_CHANGE', { volumeSetting: 1 }),
                Buffer.from('------boundary\r\n'),
                pushChunk('PUSH_EQUALIZER_STATE_CHANGE', { bass: 1 }),
                Buffer.from('------boundary\r\n'),
            ]),
        );
        assert.deepEqual(received, ['PUSH_VOLUME_CHANGE', 'PUSH_EQUALIZER_STATE_CHANGE']);
    });

    it('starts only one keep alive timer for several boundaries', async () => {
        await connect();
        session.stream.emit('data', Buffer.from('------abcdef\r\n'));
        session.stream.emit('data', Buffer.from('------abcdef\r\n'));
        await tick();
        assert.equal(session.pings, 1);
    });

    it('does not lose the following messages after a broken message', async () => {
        await connect();
        const received: string[] = [];
        let unexpected: string | undefined;
        push.on('command', command => received.push(command));
        push.on('unexpected-response', msg => (unexpected = msg));
        session.stream.emit('data', Buffer.from('Content-Type: application/json\r\n\r\n{"directive":{"payload"\r\n'));
        session.stream.emit('data', Buffer.from('------boundary\r\n'));
        session.stream.emit('data', pushChunk('PUSH_VOLUME_CHANGE', { volumeSetting: 1 }));
        assert.match(unexpected!, /Could not parse json/);
        assert.deepEqual(received, ['PUSH_VOLUME_CHANGE']);
    });

    it('skips updates without resource metadata', async () => {
        await connect();
        const received: string[] = [];
        push.on('command', command => received.push(command));
        const message = {
            directive: {
                payload: {
                    renderingUpdates: [
                        {},
                        { resourceMetadata: JSON.stringify({ command: 'PUSH_VOLUME_CHANGE', payload: '{}' }) },
                    ],
                },
            },
        };
        session.stream.emit(
            'data',
            Buffer.from(`Content-Type: application/json\r\n\r\n${JSON.stringify(message)}\r\n`),
        );
        assert.deepEqual(received, ['PUSH_VOLUME_CHANGE']);
    });

    it('finds the end of JSON objects', () => {
        const find = (text: string): number => findJsonEnd(Buffer.from(text), text.indexOf('{'));
        assert.equal(find('xx{"a":{"b":1}}yy'), 15);
        assert.equal(find('{"a":"}"}'), 9);
        assert.equal(find('{"a":"\\"}"}'), 11);
        assert.equal(find('{"a":{'), -1);
        // the next boundary ends a broken message
        assert.equal(find('{"a":\r\n--b'), 5);
    });

    it('forces a new access token if Amazon refuses the token with 403', async () => {
        const requests: (boolean | undefined)[] = [];
        let token = 'OLD';
        push = new AlexaHttp2Push({}, (cb, force) => {
            requests.push(force);
            if (force) {
                token = 'NEW';
            }
            cb(token);
        });
        push.connect();
        await tick();
        assert.deepEqual(requests, [undefined]);
        assert.equal(session.headers!.authorization, 'Bearer OLD');

        session.stream.emit('response', { ':status': 403 });
        assert.deepEqual(requests, [undefined, true]);

        // the immediate reconnect uses the new token
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.equal(session.headers!.authorization, 'Bearer NEW');
    });

    it('emits disconnect with retry information when the connection is closed', async () => {
        await connect();
        let event: any[] | undefined;
        push.on('disconnect', (...args) => (event = args));
        session.emit('close');
        assert.equal(event![0], true);
        assert.match(event![1], /Retry Connection in 1s/);
        assert.equal(push.isConnected(), false);
    });

    it('does not reconnect after disconnect()', async () => {
        await connect();
        let disconnectEvents = 0;
        push.on('disconnect', () => disconnectEvents++);
        push.disconnect();
        assert.equal(disconnectEvents, 0);
    });
});
