import https from 'node:https';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import AlexaRemote from '../build/alexa-remote.js';

/** Request as seen by the fake Amazon server */
export type RecordedRequest = {
    host: string;
    path: string;
    method: string;
    headers: Record<string, any>;
    data: string;
    timeout: number;
};

/** Response definition of a route */
export type FakeResponse = {
    status?: number;
    /** string bodies are sent as they are, everything else as JSON */
    body?: unknown;
    encoding?: 'gzip' | 'deflate';
    /** simulate a request timeout */
    timeout?: boolean;
    /** simulate a network error */
    error?: Error;
};

type Route = [RegExp, FakeResponse | ((req: RecordedRequest) => FakeResponse)];

/** Serial number and data of the test devices */
export const ECHO = {
    serialNumber: 'S1',
    accountName: 'Echo',
    deviceType: 'T1',
    deviceTypeFriendlyName: 'Echo Dot',
    deviceOwnerCustomerId: 'C1',
    capabilities: ['AUDIO_PLAYER', 'VOLUME_SETTING'],
    clusterMembers: [],
    parentClusters: [],
    deviceFamily: 'ECHO',
    softwareVersion: '100',
    deviceAccountId: 'A1',
    appDeviceList: [
        {
            serialNumber: 'S1-APP',
            accountName: 'Echo App',
            deviceType: 'T1-APP',
            deviceTypeFriendlyName: 'App',
            deviceAccountId: 'A1-APP',
        },
    ],
};

export const FIRE_TV = {
    serialNumber: 'S2',
    accountName: 'Living room TV',
    deviceType: 'T2',
    deviceOwnerCustomerId: 'C1',
    capabilities: [],
    clusterMembers: [],
    parentClusters: ['G1'],
    deviceFamily: 'FIRE_TV',
    softwareVersion: '200',
    deviceAccountId: 'A2',
    appDeviceList: [],
};

/** Responses needed for a complete init() */
const initRoutes = (): Route[] => [
    [/\/api\/customer-status/, { body: { status: 'ACTIVE' } }],
    [/\/api\/users\/me/, { body: { id: 'C1', fullName: 'Tester' } }],
    // page with the CSRF token for the voice history
    [/\/alexa-privacy\/apd\/activity/, { body: '<html><meta name="csrf-token" content="ACTIVITY-CSRF"></html>' }],
    [
        /\/api\/endpoints/,
        { body: { websiteApiUrl: 'https://alexa.amazon.de', alexaApiUrl: 'https://api.amazonalexa.com' } },
    ],
    [/alexa-comms-mobile-service\.amazon\.de\/accounts/, { body: [{ commsId: 'COMMS1' }] }],
    [/\/api\/devices-v2\/device\?/, { body: { devices: [structuredClone(ECHO), structuredClone(FIRE_TV)] } }],
    [
        /\/api\/device-preferences/,
        { body: { devicePreferences: [{ deviceSerialNumber: 'S1', timeZoneId: 'Europe/Vienna' }] } },
    ],
    [/\/api\/wake-word/, { body: { wakeWords: [{ deviceSerialNumber: 'S1', wakeWord: 'ALEXA' }] } }],
    [
        /\/api\/bluetooth\?/,
        { body: { bluetoothStates: [{ deviceSerialNumber: 'S1', pairedDeviceList: [{ address: 'AA:BB' }] }] } },
    ],
    [/\/api\/notifications\?/, { body: { notifications: [] } }],
    [/\/auth\/token/, { body: { access_token: 'ACCESS', token_type: 'bearer', expires_in: 3600 } }],
];

/**
 * Replaces https.request with a fake that answers requests from a route table and records all requests.
 */
export class FakeAmazon {
    requests: RecordedRequest[] = [];
    private routes: Route[] = [];
    private original = https.request;

    constructor() {
        this.routes = initRoutes();
    }

    /** Adds a route; routes added later have priority */
    on(path: RegExp, response: FakeResponse | ((req: RecordedRequest) => FakeResponse)): this {
        this.routes.unshift([path, response]);
        return this;
    }

    /** Returns all recorded requests whose URL matches */
    find(path: RegExp): RecordedRequest[] {
        return this.requests.filter(r => path.test(`${r.host}${r.path}`));
    }

    /** Returns the last recorded request whose URL matches */
    last(path: RegExp): RecordedRequest | undefined {
        const found = this.find(path);
        return found[found.length - 1];
    }

    install(): void {
        (https as any).request = (options: any, cb: (res: any) => void): any => this.request(options, cb);
    }

    uninstall(): void {
        (https as any).request = this.original;
    }

    private request(options: any, cb: (res: any) => void): any {
        const req: any = new EventEmitter();
        let data = '';
        req.write = (chunk: string): void => {
            data += chunk;
        };
        req.end = (): void => {
            const recorded: RecordedRequest = {
                host: options.host,
                path: options.path,
                method: options.method,
                headers: { ...options.headers },
                data,
                timeout: options.timeout,
            };
            this.requests.push(recorded);
            const url = `${recorded.host}${recorded.path}`;
            const route = this.routes.find(([re]) => re.test(url));
            let response: FakeResponse = { body: { ok: true } };
            if (route) {
                response = typeof route[1] === 'function' ? route[1](recorded) : route[1];
            }
            setImmediate(() => {
                if (response.timeout) {
                    req.emit('timeout');
                    return;
                }
                if (response.error) {
                    req.emit('error', response.error);
                    return;
                }
                const res: any = new EventEmitter();
                res.statusCode = response.status ?? 200;
                res.headers = response.encoding ? { 'content-encoding': response.encoding } : {};
                let body = Buffer.from(
                    response.body === undefined
                        ? ''
                        : typeof response.body === 'string'
                          ? response.body
                          : JSON.stringify(response.body),
                );
                if (response.encoding === 'gzip') {
                    body = zlib.gzipSync(body);
                } else if (response.encoding === 'deflate') {
                    body = zlib.deflateSync(body);
                }
                cb(res);
                if (body.length) {
                    res.emit('data', body);
                }
                res.emit('end');
            });
        };
        return req;
    }
}

/** Options for a complete init() without login */
export const initOptions = (extra: Record<string, any> = {}): Record<string, any> => ({
    cookie: 'session-id=1; csrf=CSRF123; ubid-acbde=UBID;',
    macDms: { device_private_key: 'KEY', adp_token: 'ADP' },
    formerRegistrationData: {
        tokenDate: Date.now(),
        dataVersion: 2,
        deviceAppName: 'TestApp',
        refreshToken: 'REFRESH',
    },
    cookieRefreshInterval: 0,
    bluetooth: true,
    notifications: true,
    ...extra,
});

/**
 * Creates an AlexaRemote instance and initializes it against the fake server.
 *
 * @param extra additional init options
 */
export const createAlexa = async (extra: Record<string, any> = {}): Promise<AlexaRemote> => {
    const alexa = new AlexaRemote();
    await new Promise<void>((resolve, reject) =>
        alexa.init(initOptions(extra), err => (err ? reject(err) : resolve())),
    );
    // getAuthApiBearerToken() needs the refresh token from the cookie data
    alexa.cookieData = { refreshToken: 'REFRESH' };
    return alexa;
};

/**
 * Calls a callback style method and returns its result as promise.
 *
 * @param fn function that gets the callback
 */
export const call = <T extends unknown = any>(
    fn: (cb: (err?: Error | null, res?: T | null) => void) => void,
): Promise<{ err?: any; res?: T | null }> => new Promise(resolve => fn((err, res) => resolve({ err, res })));
