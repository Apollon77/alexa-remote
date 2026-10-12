import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import type { AlexaRemoteOptions, MacDms } from './types';

export type WsMqttMessage = {
    service?: string;
    checksum?: number;
    messageType?: string;
    channel?: number;
    messageId?: number;
    moreFlag?: string | number;
    seq?: number;
    content?: any;
};

export default class AlexaWsMqtt extends EventEmitter {
    private _options: AlexaRemoteOptions;
    public stop: boolean;
    private readonly cookie: string;
    private readonly macDms: MacDms | undefined;
    private readonly accountSerial!: string;
    private websocket!: WebSocket | null;
    private pingPongInterval!: NodeJS.Timeout | null;
    private errorRetryCounter!: number;
    private reconnectTimeout!: NodeJS.Timeout | null;
    private pongTimeout!: NodeJS.Timeout | null;
    private initTimeout!: NodeJS.Timeout | null;
    private pollingTimeout: NodeJS.Timeout | null = null;
    private connectionActive!: boolean;
    private messageId!: number;
    private protocolName?: string;

    /**
     * Creates the (legacy) WebSocket/MQTT push connection handler. Call `connect()` to establish the connection.
     *
     * @param options options of the AlexaRemote instance
     * @param cookie cookie used for the connection; must contain the `ubid-*` value
     * @param macDms device registration data used to sign the connection request (newer connection type)
     */
    constructor(options: AlexaRemoteOptions, cookie: string, macDms?: MacDms) {
        super();

        this._options = options;
        this.stop = false;
        let serialArr: RegExpMatchArray | null = null;
        this.cookie = cookie;
        this.macDms = macDms;
        if (cookie) {
            serialArr = cookie.match(/ubid-[a-z]+=([^;]+);/);
        }
        if (!serialArr || !serialArr[1]) {
            this._options.logger?.(`Alexa-Remote WS-MQTT: Cookie incomplete : ${JSON.stringify(serialArr)}`);
            return;
        }
        this.accountSerial = serialArr[1];
        this.websocket = null;
        this.pingPongInterval = null;
        this.errorRetryCounter = 0;
        this.reconnectTimeout = null;
        this.pongTimeout = null;
        this.initTimeout = null;
        this.connectionActive = false;

        this.messageId = Math.floor(1e9 * Math.random());
    }

    /**
     * Returns whether the push connection is established and alive.
     *
     * @returns true if connected
     */
    isConnected(): boolean {
        return this.connectionActive;
    }

    /**
     * Opens the WebSocket using the old style connection (authentication via cookie only).
     *
     * @returns the used URL
     */
    connectType1(): string {
        const urlTime = Date.now();
        let amazonPage = `.${this._options.amazonPage}`;
        if (amazonPage === '.amazon.com') {
            amazonPage = '-js.amazon.com';
        } // Special Handling for US!
        const url = `wss://dp-gw-na${amazonPage}/?x-amz-device-type=ALEGCNGL9K0HM&x-amz-device-serial=${this.accountSerial}-${urlTime}`;

        this.websocket = new WebSocket(url, [], {
            perMessageDeflate: true,
            protocolVersion: 13,

            timeout: 5000,

            headers: {
                Connection: 'keep-alive, Upgrade',
                Upgrade: 'websocket',
                Host: `dp-gw-na.${this._options.amazonPage}`,
                Origin: `https://alexa.${this._options.amazonPage}`,
                Pragma: 'no-cache',
                'Cache-Control': 'no-cache',
                //'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                //'Accept-Language': 'de,en-US;q=0.7,en;q=0.3',
                //'Sec-WebSocket-Key': 'aV/ud2q+G4pTtOhlt/Amww==',
                //'Sec-WebSocket-Extensions': 'permessage-deflate', // 'x-webkit-deflate-frame',
                //'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 11_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15G77 PitanguiBridge/2.2.219248.0-[HARDWARE=iPhone10_4][SOFTWARE=11.4.1]',
                Cookie: this.cookie,
            },
        });
        return url;
    }

    /**
     * Creates the request signature (SHA256 with RSA) required by the newer connection type, using the
     * private key and ADP token from `macDms`.
     *
     * @param method HTTP request method (GET, POST, DELETE, ...)
     * @param path requested URL path and query
     * @param body HTTP message body
     * @returns signature in the format `<base64>:<ISO date>`
     */
    createRequestSignature(method: string, path: string, body: string | Buffer): string {
        /*
            date = datetime.utcnow().isoformat("T") + "Z"
            body = body.decode("utf-8")

            data = f"{method}\n{path}\n{date}\n{body}\n{adp_token}"

            key = rsa.PrivateKey.load_pkcs1(private_key.encode("utf-8"))
            cipher = rsa.pkcs1.sign(data.encode(), key, "SHA-256")
            signed_encoded = base64.b64encode(cipher)

            signature = f"{signed_encoded.decode()}:{date}"

            return {
                "x-adp-token": adp_token,
                "x-adp-alg": "SHA256withRSA:1.0",
                "x-adp-signature": signature
            }

            <base64>:2021-10-08T23:49:33Z
        */
        const now = new Date().toISOString();

        const sign = crypto.createSign('SHA256');
        sign.write(`${method}\n`);
        sign.write(`${path}\n`);
        sign.write(`${now}\n`);
        sign.write(`${Buffer.isBuffer(body) ? body.toString('utf-8') : body}\n`);
        sign.write(this.macDms!.adp_token);
        sign.end();

        const privateKey = `-----BEGIN PRIVATE KEY-----\n${this.macDms!.device_private_key}\n-----END PRIVATE KEY-----`;

        return `${sign.sign(privateKey, 'base64')}:${now}`;
    }

    /**
     * Opens the WebSocket using the newer connection type with a signed request (needs `macDms`).
     *
     * @returns the used URL
     */
    connectType2(): string {
        let amazonPage = `.${this._options.amazonPage}`;
        if (amazonPage === '.amazon.com') {
            amazonPage = '-js.amazon.com';
        } // Special Handling for US!
        const url = `wss://dp-gw-na${amazonPage}/tcomm/`;

        this.websocket = new WebSocket(url, [], {
            perMessageDeflate: true,
            protocolVersion: 13,

            timeout: 5000,

            headers: {
                Connection: 'keep-alive, Upgrade',
                Upgrade: 'websocket',
                Host: `dp-gw-na.${this._options.amazonPage}`,
                Origin: `https://alexa.${this._options.amazonPage}`,
                Pragma: 'no-cache',
                'Cache-Control': 'no-cache',
                //'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                //'Accept-Language': 'de,en-US;q=0.7,en;q=0.3',
                //'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 11_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15G77 PitanguiBridge/2.2.219248.0-[HARDWARE=iPhone10_4][SOFTWARE=11.4.1]',
                Cookie: this.cookie,
                'x-dp-comm-tuning': 'A:F;A:H',
                'x-dp-reason': 'ClientInitiated;1',
                'x-dp-tcomm-purpose': 'Regular',
                //'x-dp-deviceVersion': 'motorola/osprey_reteu_2gb/osprey_u2:6.0.1/MPI24.107-55/33:user/release-keys',
                //'x-dp-networkType': 'WIFI',
                //'x-dp-tcomm-versionCode': '894920010',
                //'x-dp-oui': 'dca632',
                'x-dp-obfuscatedBssid': '-2019514039',
                'x-dp-tcomm-versionName': '2.2.443692.0',
                'x-adp-signature': this.createRequestSignature('GET', '/tcomm/', ''),
                'x-adp-token': this.macDms!.adp_token,
                'x-adp-alg': 'SHA256WithRSA:1.0',
            },
        });
        return url;
    }

    /**
     * Sends data over the WebSocket.
     *
     * @param data data to send
     * @returns promise that resolves when the data was sent
     */
    sendWs(data: Buffer): Promise<void> {
        return new Promise<void>(resolve => {
            if (!this.websocket) {
                resolve();
                return;
            }
            this.websocket.send(data, () => resolve());
        });
    }

    /**
     * Waits the given time.
     *
     * @param delay time to wait in ms
     * @returns promise that resolves after the delay
     */
    wait(delay: number): Promise<void> {
        return new Promise<void>(resolve => {
            setTimeout(() => resolve(), delay);
        });
    }

    /**
     * Establishes the WebSocket connection and performs the protocol handshake. Depending on the server
     * response either the "A:H" (text based) or the "A:F" (binary) protocol is used.
     * Received push messages are emitted as `command` events. The connection is kept alive with pings
     * every 3 minutes and re-established automatically on errors.
     */
    connect(): void {
        let url: string;
        try {
            if (this._options.usePushConnectType !== undefined) {
                this._options.logger?.(
                    `Alexa-Remote WS-MQTT: Try to initialize push connection with type ${this._options.usePushConnectType}`,
                );
                if (this._options.usePushConnectType === 1) {
                    url = this.connectType1();
                } else if (this._options.usePushConnectType === 2) {
                    url = this.connectType2();
                } else {
                    throw new Error(`Invalid push connect type ${this._options.usePushConnectType} specified`);
                }
            } else if (!this.macDms || !this.macDms.adp_token || !this.macDms.device_private_key) {
                this._options.logger?.(
                    'Alexa-Remote WS-MQTT: Try to initialize old style push connection because macDms data missing',
                );
                url = this.connectType1();
            } else {
                url = this.connectType2();
            }
        } catch (err: any) {
            this._options.logger?.(`Alexa-Remote WS-MQTT: Error on Init ${err.message}`);
            this._options.logger?.(err.stack);
            this.emit('error', err);
            return;
        }
        let msgCounter = 0;
        this.initTimeout && clearTimeout(this.initTimeout);

        const onWebsocketClose = (code?: number, reasonData?: string | Buffer): void => {
            let reason: string | undefined;
            if (reasonData) {
                reason = reasonData.toString();
            }
            this.websocket = null;
            this.connectionActive = false;
            this._options.logger?.(`Alexa-Remote WS-MQTT: Close: ${code}: ${reason}`);
            if (this.initTimeout) {
                clearTimeout(this.initTimeout);
                this.initTimeout = null;
            }
            if (this.pingPongInterval) {
                clearInterval(this.pingPongInterval);
                this.pingPongInterval = null;
            }
            if (this.pongTimeout) {
                clearTimeout(this.pongTimeout);
                this.pongTimeout = null;
            }
            if (code === 4001 && reason?.startsWith('before - Could not find any')) {
                // code = 40001, reason = "before - Could not find any vali"
                this._options.logger?.('Alexa-Remote WS-MQTT: Cookie invalid!');
                this.emit('disconnect', false, 'Cookie invalid');
                return;
            }
            if (this.stop) {
                return;
            }
            if (this.errorRetryCounter > 100) {
                this.emit('disconnect', false, 'Too many failed retries. Check cookie and data');
                return;
            }
            this.errorRetryCounter++;

            const retryDelay = Math.min(60, this.errorRetryCounter * 5 + 5);
            this._options.logger?.(`Alexa-Remote WS-MQTT: Retry Connection in ${retryDelay}s`);
            this.emit('disconnect', true, `Retry Connection in ${retryDelay}s`);
            this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = setTimeout(() => {
                this.reconnectTimeout = null;
                this.connect();
            }, retryDelay * 1000);
        };

        this.initTimeout = setTimeout(() => {
            this._options.logger?.('Alexa-Remote WS-MQTT: Initialization not done within 30s');
            try {
                this.websocket?.close();
            } catch {
                // just make sure
            }
            if (this.websocket || !this.reconnectTimeout) {
                // seems no close was emitted so far?!
                onWebsocketClose();
            }
        }, 30000);

        const websocket = this.websocket!;

        websocket.on('open', () => {
            if (!this.websocket) {
                return;
            }
            if (this.stop) {
                this.websocket.close();
                return;
            }
            this._options.logger?.(`Alexa-Remote WS-MQTT: Open: ${url}`);
            this.connectionActive = false;

            if (!this.macDms) {
                // tell Tuning Service that we support "A:H" protocol = AlphaPrococol
                const msg = Buffer.from('0x99d4f71a 0x0000001d A:HTUNE');
                //console.log('SEND: ' + msg.toString('ascii'));
                this._options.logger?.('Alexa-Remote WS-MQTT: A:H Initialization Msg 1 sent');
                if (this.websocket.readyState !== 1 /* OPEN */) {
                    return;
                }
                this.websocket.send(msg);
            }
        });

        websocket.on('close', onWebsocketClose);

        websocket.on('error', (error: Error) => {
            this._options.logger?.(`Alexa-Remote WS-MQTT: Error: ${error}`);
            this.emit('error', error);
            this.websocket?.terminate();
        });

        websocket.on('unexpected-response', () => {
            this._options.logger?.('Alexa-Remote WS-MQTT: Unexpected Response');
        });

        websocket.on('message', async (data: Buffer) => {
            if (!this.websocket || this.websocket.readyState !== 1 /* OPEN */) {
                return;
            }
            this._options.logger?.(`Alexa-Remote WS-MQTT: Incoming RAW message: ${data.toString('hex')}`);
            const message = this.parseIncomingMessage(data);
            this._options.logger?.(`Alexa-Remote WS-MQTT: Incoming message: ${JSON.stringify(message)}`);

            if (msgCounter === 0) {
                // initialization
                if (message.content.protocolName) {
                    this.protocolName = message.content.protocolName;
                    if (this.protocolName !== 'A:H' && this.protocolName !== 'A:F') {
                        this._options.logger?.(
                            `Alexa-Remote WS-MQTT: Server requests unknown protocol: ${this.protocolName}`,
                        );
                    }
                } else {
                    this._options.logger?.(`Alexa-Remote WS-MQTT: Unexpected Response: ${JSON.stringify(message)}`);
                    this.protocolName = this.macDms ? 'A:F' : 'A:H';
                }
                this._options.logger?.(`Alexa-Remote WS-MQTT: Detected protocol ${this.protocolName}`);

                let msg: Buffer;
                if (this.protocolName === 'A:F') {
                    // A:F
                    msg = Buffer.from(
                        '0xfe88bc52 0x0000009c {"protocolName":"A:F","parameters":{"AlphaProtocolHandler.receiveWindowSize":"16","AlphaProtocolHandler.maxFragmentSize":"16000"}}TUNE',
                    );
                    await this.sendWs(msg);
                    this._options.logger?.(
                        `Alexa-Remote WS-MQTT: A:F Initialization Msg 2 sent: ${msg.toString('hex')}`,
                    );

                    await this.wait(50);
                    msg = this.encodeGWRegisterAF();
                    this._options.logger?.(
                        `Alexa-Remote WS-MQTT: A:F Initialization Msg 3 (Register Connection) sent: ${msg.toString(
                            'hex',
                        )}`,
                    );
                    //console.log('SEND: ' + msg.toString('ascii'));
                    await this.sendWs(msg);
                    msgCounter++;
                } else {
                    // A:H
                    msg = Buffer.from(
                        '0xa6f6a951 0x0000009c {"protocolName":"A:H","parameters":{"AlphaProtocolHandler.receiveWindowSize":"16","AlphaProtocolHandler.maxFragmentSize":"16000"}}TUNE',
                    );
                    //console.log('SEND: ' + msg.toString('ascii'));
                    await this.sendWs(msg);

                    await this.wait(50);
                    //msg = new Buffer('MSG 0x00000361 0x0e414e45 f 0x00000001 0xd7c62f29 0x0000009b INI 0x00000003 1.0 0x00000024 ff1c4525-c036-4942-bf6c-a098755ac82f 0x00000164d106ce6b END FABE');
                    msg = this.encodeGWHandshake();
                    //console.log('SEND: ' + msg.toString('ascii'));
                    await this.sendWs(msg);
                    this._options.logger?.('Alexa-Remote WS-MQTT: A-H Initialization Msg 2+3 sent');
                }
            }
            if (msgCounter === 1) {
                if (this.protocolName === 'A:H') {
                    //let msg = new Buffer('MSG 0x00000362 0x0e414e46 f 0x00000001 0xf904b9f5 0x00000109 GWM MSG 0x0000b479 0x0000003b urn:tcomm-endpoint:device:deviceType:0:deviceSerialNumber:0 0x00000041 urn:tcomm-endpoint:service:serviceName:DeeWebsiteMessagingService {"command":"REGISTER_CONNECTION"}FABE');
                    const msg = this.encodeGWRegisterAH();
                    this._options.logger?.('Alexa-Remote WS-MQTT: Initialization Msg 4 (Register Connection) sent');
                    //console.log('SEND: ' + msg.toString('ascii'));
                    await this.sendWs(msg);
                }

                setTimeout(() => {
                    if (!this.websocket || this.websocket.readyState !== 1 /* OPEN */) {
                        return;
                    }
                    const websocket = this.websocket;

                    //msg = new Buffer('4D53472030783030303030303635203078306534313465343720662030783030303030303031203078626332666262356620307830303030303036322050494E00000000D1098D8CD1098D8C000000070052006500670075006C0061007246414245', 'hex'); // "MSG 0x00000065 0x0e414e47 f 0x00000001 0xbc2fbb5f 0x00000062 PIN" + 30 + "FABE"
                    const msg = this.encodePing();
                    this._options.logger?.('Alexa-Remote WS-MQTT: Send First Ping');
                    //console.log('SEND: ' + msg.toString('hex'));
                    websocket.send(msg);

                    this.pingPongInterval = setInterval(() => {
                        if (!this.websocket) {
                            return;
                        }
                        //let msg = new Buffer('4D53472030783030303030303635203078306534313465343720662030783030303030303031203078626332666262356620307830303030303036322050494E00000000D1098D8CD1098D8C000000070052006500670075006C0061007246414245', 'hex'); // "MSG 0x00000065 0x0e414e47 f 0x00000001 0xbc2fbb5f 0x00000062 PIN" + 30 + "FABE"
                        const msg = this.encodePing();
                        this._options.logger?.('Alexa-Remote WS-MQTT: Send Ping');
                        //console.log('SEND: ' + msg.toString('hex'));
                        this.websocket.send(msg);

                        this.pongTimeout = setTimeout(() => {
                            this.pongTimeout = null;
                            this._options.logger?.('Alexa-Remote WS-MQTT: No Pong received after 30s');
                            this.websocket?.close();
                        }, 30000);
                    }, 180000);
                }, 100);
            }
            msgCounter++;
            if (msgCounter < 3 || !this.pingPongInterval) {
                return;
            }

            const incomingMsg = data.toString('ascii');
            //if (incomingMsg.includes('PON') && incomingMsg.includes('\u0000R\u0000e\u0000g\u0000u\u0000l\u0000a\u0000r')) {
            if (
                message.service === 'FABE' &&
                message.content?.messageType === 'PON' &&
                message.content.payloadData?.includes('\u0000R\u0000e\u0000g\u0000u\u0000l\u0000a\u0000r')
            ) {
                this._options.logger?.('Alexa-Remote WS-MQTT: Received Pong');
                if (this.initTimeout) {
                    clearTimeout(this.initTimeout);
                    this.initTimeout = null;
                    this._options.logger?.('Alexa-Remote WS-MQTT: Initialization completed');
                    this.emit('connect');
                }
                if (this.pongTimeout) {
                    clearTimeout(this.pongTimeout);
                    this.pongTimeout = null;
                }
                this.connectionActive = true;
                return;
            } else if (message.content?.payload) {
                const command = message.content.payload.command;
                const payload = message.content.payload.payload;

                this._options.logger?.(`Alexa-Remote WS-MQTT: Command ${command}: ${JSON.stringify(payload, null, 4)}`);
                this.emit('command', command, payload);
                return;
            }
            this._options.logger?.(`Alexa-Remote WS-MQTT: Unknown Data (${msgCounter}): ${incomingMsg}`);
            this.emit('unknown', incomingMsg);
        });
    }

    /**
     * Encodes a number as zero padded hex string with `0x` prefix.
     *
     * @param val number to encode
     * @param byteLen number of hex digits (defaults to 8)
     * @returns encoded number
     */
    encodeNumber(val: number, byteLen?: number): string {
        if (!byteLen) {
            byteLen = 8;
        }
        let str = val.toString(16);
        while (str.length < byteLen) {
            str = `0${str}`;
        }
        return `0x${str}`;
    }

    /**
     * Generates a random UUID (version 4 format).
     *
     * @returns UUID
     */
    generateUUID(): string {
        const a: string[] = [];
        for (let b = 0; 36 > b; b++) {
            const c = 'rrrrrrrr-rrrr-4rrr-srrr-rrrrrrrrrrrr'.charAt(b);
            if ('r' === c || 's' === c) {
                let d = Math.floor(16 * Math.random());
                's' === c && (d = (d & 3) | 8);
                a.push(d.toString(16));
            } else {
                a.push(c);
            }
        }
        return a.join('');
    }

    /**
     * Creates the gateway handshake message ("A:H" protocol).
     *
     * @returns message
     */
    encodeGWHandshake(): Buffer {
        //pubrelBuf = new Buffer('MSG 0x00000361 0x0e414e45 f 0x00000001 0xd7c62f29 0x0000009b INI 0x00000003 1.0 0x00000024 ff1c4525-c036-4942-bf6c-a098755ac82f 0x00000164d106ce6b END FABE');
        this.messageId++;
        let msg = 'MSG 0x00000361 '; // Message-type and Channel = GW_HANDSHAKE_CHANNEL;
        msg += `${this.encodeNumber(this.messageId)} f 0x00000001 `;
        const idx1 = msg.length;
        msg += '0x00000000 '; // Checksum!
        const idx2 = msg.length;
        msg += '0x0000009b '; // length content
        msg += 'INI 0x00000003 1.0 0x00000024 '; // content part 1
        msg += this.generateUUID();
        msg += ' ';
        msg += this.encodeNumber(Date.now(), 16);
        msg += ' END FABE';
        const completeBuffer = Buffer.from(msg, 'ascii');

        const checksum = this.computeChecksum(completeBuffer, idx1, idx2);
        const checksumBuf = Buffer.from(this.encodeNumber(checksum));
        checksumBuf.copy(completeBuffer, 39);
        return completeBuffer;
    }

    /**
     * Creates the message to register the connection ("A:H" protocol).
     *
     * @returns message
     */
    encodeGWRegisterAH(): Buffer {
        //pubrelBuf = new Buffer('MSG 0x00000362 0x0e414e46 f 0x00000001 0xf904b9f5 0x00000109 GWM MSG 0x0000b479 0x0000003b urn:tcomm-endpoint:device:deviceType:0:deviceSerialNumber:0 0x00000041 urn:tcomm-endpoint:service:serviceName:DeeWebsiteMessagingService {"command":"REGISTER_CONNECTION"}FABE');
        this.messageId++;
        let msg = 'MSG 0x00000362 '; // Message-type and Channel = GW_CHANNEL;
        msg += `${this.encodeNumber(this.messageId)} f 0x00000001 `;
        const idx1 = msg.length;
        msg += '0x00000000 '; // Checksum!
        const idx2 = msg.length;
        msg += '0x00000109 '; // length content
        msg +=
            'GWM MSG 0x0000b479 0x0000003b urn:tcomm-endpoint:device:deviceType:0:deviceSerialNumber:0 0x00000041 urn:tcomm-endpoint:service:serviceName:DeeWebsiteMessagingService {"command":"REGISTER_CONNECTION"}FABE';
        const completeBuffer = Buffer.from(msg, 'ascii');

        const checksum = this.computeChecksum(completeBuffer, idx1, idx2);
        const checksumBuf = Buffer.from(this.encodeNumber(checksum));
        checksumBuf.copy(completeBuffer, 39);
        return completeBuffer;
    }

    /**
     * Creates the message to register the connection ("A:F" protocol).
     *
     * @returns message
     */
    encodeGWRegisterAF(): Buffer {
        this.messageId++;
        const completeBuffer = Buffer.alloc(0xe4);
        completeBuffer.write('MSG', 0, 'ascii');
        completeBuffer.writeUInt32BE(0x00000362, 3); // Message-type and Channel = GW_CHANNEL;
        completeBuffer.writeUInt32BE(this.messageId, 7);
        completeBuffer.write('f', 11, 'ascii');
        completeBuffer.writeUInt32BE(0x00000001, 12);
        completeBuffer.writeUInt32BE(0x00000000, 16); // Checksum!
        completeBuffer.writeUInt32BE(0x000000e4, 20); // length content
        completeBuffer.write(
            'GWM MSG 0x0000b479 0x0000003b urn:tcomm-endpoint:device:deviceType:0:deviceSerialNumber:0 0x00000041 urn:tcomm-endpoint:service:serviceName:DeeWebsiteMessagingService {"command":"REGISTER_CONNECTION"}FABE',
            24,
            'ascii',
        );

        const checksum = this.computeChecksum(completeBuffer, 16, 20);
        completeBuffer.writeUInt32BE(checksum, 16); // Checksum!
        return completeBuffer;
    }

    /**
     * Creates a ping message for the detected protocol.
     *
     * @returns message
     */
    encodePing(): Buffer {
        if (this.protocolName === 'A:H') {
            return this.encodePingAH();
        }
        return this.encodePingAF();
    }

    /**
     * Creates a ping message ("A:H" protocol).
     *
     * @returns message
     */
    encodePingAH(): Buffer {
        const encode = (buffer: ArrayBuffer, b: number, offset: number, h: number): void => {
            const a = new Uint8Array(buffer, offset, h);
            for (let c = 0; c < h; c++) {
                a[c] = (b >> (8 * (h - 1 - c))) & 255;
            }
        };

        this.messageId++;
        let msg = 'MSG 0x00000065 '; // Message-type and Channel = CHANNEL_FOR_HEARTBEAT;
        msg += `${this.encodeNumber(this.messageId)} f 0x00000001 `;
        const idx1 = msg.length;
        msg += '0x00000000 '; // Checksum!
        const idx2 = msg.length;
        msg += '0x00000062 '; // length content

        const completeBuffer = Buffer.alloc(0x62, 0);
        const startBuffer = Buffer.from(msg, 'ascii');
        startBuffer.copy(completeBuffer);

        const header = 'PIN';
        const payload = 'Regular'; // g = h.length
        const n = new ArrayBuffer(header.length + 4 + 8 + 4 + 2 * payload.length);
        let idx = 0;
        let u = new Uint8Array(n, idx, header.length);
        const l = 0;
        const e = Date.now();

        for (let q = 0; q < header.length; q++) {
            u[q] = header.charCodeAt(q);
        }
        idx += header.length;
        encode(n, l, idx, 4);
        idx += 4;
        encode(n, e, idx, 8);
        idx += 8;
        encode(n, payload.length, idx, 4);
        idx += 4;
        u = new Uint8Array(n, idx, payload.length * 2);
        let q;
        for (q = 0; q < payload.length; q++) {
            u[q * 2] = 0;
            u[q * 2 + 1] = payload.charCodeAt(q);
        }
        const buf = Buffer.from(n);
        buf.copy(completeBuffer, msg.length);

        const buf2End = Buffer.from('FABE', 'ascii');
        buf2End.copy(completeBuffer, msg.length + buf.length);

        const checksum = this.computeChecksum(completeBuffer, idx1, idx2);
        const checksumBuf = Buffer.from(this.encodeNumber(checksum));
        checksumBuf.copy(completeBuffer, 39);
        return completeBuffer;
    }

    /**
     * Creates a ping message ("A:F" protocol).
     *
     * @returns message
     */
    encodePingAF(): Buffer {
        const encode = (buffer: ArrayBuffer, b: number, offset: number, h: number): void => {
            const a = new Uint8Array(buffer, offset, h);
            for (let c = 0; c < h; c++) {
                a[c] = (b >> (8 * (h - 1 - c))) & 255;
            }
        };

        this.messageId++;
        const completeBuffer = Buffer.alloc(0x3d);
        completeBuffer.write('MSG', 0, 'ascii');
        completeBuffer.writeUInt32BE(0x00000065, 3); // Message-type and Channel = CHANNEL_FOR_HEARTBEAT;
        completeBuffer.writeUInt32BE(this.messageId, 7);
        completeBuffer.write('f', 11, 'ascii');
        completeBuffer.writeUInt32BE(0x00000001, 12);
        completeBuffer.writeUInt32BE(0x00000000, 16); // Checksum!
        completeBuffer.writeUInt32BE(0x0000003d, 20); // length content

        const header = 'PIN';
        const payload = 'Regular'; // g = h.length
        const n = new ArrayBuffer(header.length + 4 + 8 + 4 + 2 * payload.length);
        let idx = 0;
        let u = new Uint8Array(n, idx, header.length);
        const l = 0;
        const e = Date.now();

        for (let q = 0; q < header.length; q++) {
            u[q] = header.charCodeAt(q);
        }
        idx += header.length;
        encode(n, l, idx, 4);
        idx += 4;
        encode(n, e, idx, 8);
        idx += 8;
        encode(n, payload.length, idx, 4);
        idx += 4;
        u = new Uint8Array(n, idx, payload.length * 2);
        let q;
        for (q = 0; q < payload.length; q++) {
            u[q * 2] = 0;
            u[q * 2 + 1] = payload.charCodeAt(q);
        }
        const buf = Buffer.from(n);
        buf.copy(completeBuffer, 24);

        completeBuffer.write('FABE', buf.length + 24, 'ascii');

        const checksum = this.computeChecksum(completeBuffer, 16, 20);
        completeBuffer.writeUInt32BE(checksum, 16); // Checksum!
        return completeBuffer;
    }

    /**
     * Computes the checksum of a message as used by the Amazon push protocol.
     *
     * @param buffer complete message
     * @param f start index of the checksum field (excluded from the calculation)
     * @param k end index of the checksum field
     * @returns checksum as unsigned 32-bit number
     */
    computeChecksum(buffer: Buffer, f: number, k: number): number {
        // Converts a signed 32-bit integer (result of bit operations) into its unsigned representation
        const toUnsigned32 = (a: number): number => {
            if (0 > a) {
                a = 4294967295 + a + 1;
            }
            return a;
        };

        // Shifts the (unsigned) value right by the given number of bits without 32-bit overflow
        const shiftRight = (a: number, bits: number): number => {
            for (a = toUnsigned32(a); 0 != bits && 0 != a;) {
                ((a = Math.floor(a / 2)), bits--);
            }
            return a;
        };

        if (k < f) {
            throw new Error('Invalid checksum exclusion window!');
        }
        const a = new Uint8Array(buffer);
        // h collects the carry (overflow above 32 bits), l the 32-bit sum
        let h = 0,
            l = 0;
        for (let e = 0; e < a.length; e++) {
            // Sum up all bytes as big-endian 32-bit words, but skip the checksum field itself (bytes f..k-1)
            e != f
                ? ((l += toUnsigned32(a[e] << (((e & 3) ^ 3) << 3))),
                  (h += shiftRight(l, 32)),
                  (l = toUnsigned32(l & 4294967295)))
                : (e = k - 1);
        }
        // Fold the carry back into the sum until no overflow is left (one's complement style)
        for (; h;) {
            ((l += h), (h = shiftRight(l, 32)), (l &= 4294967295));
        }
        return toUnsigned32(l);
    }

    /**
     * Parses an incoming message for the detected protocol.
     *
     * @param data raw message
     * @returns parsed message
     */
    parseIncomingMessage(data: Buffer): WsMqttMessage {
        if (this.protocolName === 'A:H') {
            return this.parseIncomingMessageAH(data);
        }
        return this.parseIncomingMessageAF(data);
    }

    /**
     * Parses an incoming message of the text based "A:H" protocol.
     *
     * @param data raw message
     * @returns parsed message
     */
    parseIncomingMessageAH(data: Buffer): WsMqttMessage {
        const readHex = (index: number, length: number): number => {
            let str = data.toString('ascii', index, index + length);
            if (str.startsWith('0x')) {
                str = str.substring(2);
            }
            return parseInt(str, 16);
        };

        const readString = (index: number, length: number): string => {
            return data.toString('ascii', index, index + length);
        };

        let idx = 0;
        const message: WsMqttMessage = {};
        message.service = readString(data.length - 4, 4);

        if (message.service === 'TUNE') {
            message.checksum = readHex(idx, 10);
            idx += 11; // 10 + delimiter;
            const contentLength = readHex(idx, 10);
            idx += 11; // 10 + delimiter;
            message.content = readString(idx, contentLength - 4 - idx);
            if (message.content.startsWith('{') && message.content.endsWith('}')) {
                try {
                    message.content = JSON.parse(message.content);
                } catch {
                    // ignore
                }
            }
        } else if (message.service === 'FABE') {
            message.messageType = readString(idx, 3);
            idx += 4;
            message.channel = readHex(idx, 10);
            idx += 11; // 10 + delimiter;
            message.messageId = readHex(idx, 10);
            idx += 11; // 10 + delimiter;
            message.moreFlag = readString(idx, 1);
            idx += 2; // 1 + delimiter;
            message.seq = readHex(idx, 10);
            idx += 11; // 10 + delimiter;
            message.checksum = readHex(idx, 10);
            idx += 11; // 10 + delimiter;

            //const contentLength = readHex(idx, 10);
            idx += 11; // 10 + delimiter;

            message.content = {};
            message.content.messageType = readString(idx, 3);
            idx += 4;

            if (message.channel === 0x361) {
                // GW_HANDSHAKE_CHANNEL
                if (message.content.messageType === 'ACK') {
                    let length = readHex(idx, 10);
                    idx += 11; // 10 + delimiter;
                    message.content.protocolVersion = readString(idx, length);
                    idx += length + 1;
                    length = readHex(idx, 10);
                    idx += 11; // 10 + delimiter;
                    message.content.connectionUUID = readString(idx, length);
                    idx += length + 1;
                    message.content.established = readHex(idx, 10);
                    idx += 11; // 10 + delimiter;
                    message.content.timestampINI = readHex(idx, 18);
                    idx += 19; // 18 + delimiter;
                    message.content.timestampACK = readHex(idx, 18);
                    idx += 19; // 18 + delimiter;
                }
            } else if (message.channel === 0x362) {
                // GW_CHANNEL
                if (message.content.messageType === 'GWM') {
                    message.content.subMessageType = readString(idx, 3);
                    idx += 4;
                    message.content.channel = readHex(idx, 10);
                    idx += 11; // 10 + delimiter;

                    if (message.content.channel === 0xb479) {
                        // DEE_WEBSITE_MESSAGING
                        let length = readHex(idx, 10);
                        idx += 11; // 10 + delimiter;
                        message.content.destinationIdentityUrn = readString(idx, length);
                        idx += length + 1;

                        length = readHex(idx, 10);
                        idx += 11; // 10 + delimiter;
                        const idData = readString(idx, length).split(' ');
                        idx += length + 1;

                        message.content.deviceIdentityUrn = idData[0];
                        message.content.payload = idData[1];
                        if (!message.content.payload) {
                            message.content.payload = readString(idx, data.length - 4 - idx);
                        }
                        if (message.content.payload.startsWith('{') && message.content.payload.endsWith('}')) {
                            try {
                                message.content.payload = JSON.parse(message.content.payload);
                                if (
                                    message.content.payload?.payload &&
                                    typeof message.content.payload.payload === 'string'
                                ) {
                                    message.content.payload.payload = JSON.parse(message.content.payload.payload);
                                }
                            } catch {
                                // Ignore
                            }
                        }
                    }
                }
            } else if (message.channel === 0x65) {
                // CHANNEL_FOR_HEARTBEAT
                idx -= 1; // no delimiter!
                message.content.payloadData = data.slice(idx, data.length - 4);
            }
        }
        //console.log(JSON.stringify(message, null, 4));
        return message;
    }

    /**
     * Parses an incoming message of the binary "A:F" protocol.
     *
     * @param data raw message
     * @returns parsed message
     */
    parseIncomingMessageAF(data: Buffer): WsMqttMessage {
        const readHex = (index: number, length: number): number => {
            let str = data.toString('ascii', index, index + length);
            if (str.startsWith('0x')) {
                str = str.substring(2);
            }
            return parseInt(str, 16);
        };

        const readString = (index: number, length: number): string => {
            return data.toString('ascii', index, index + length);
        };

        let idx = 0;
        const message: WsMqttMessage = {};
        message.service = readString(data.length - 4, 4);

        //this._options.logger?.('Alexa-Remote WS-MQTT: Incoming message Service: ' + message.service);

        if (message.service === 'TUNE') {
            message.checksum = readHex(idx, 10);
            idx += 11; // 10 + delimiter;
            const contentLength = readHex(idx, 10);
            idx += 11; // 10 + delimiter;
            message.content = readString(idx, contentLength - 4 - idx);
            if (message.content.startsWith('{') && message.content.endsWith('}')) {
                try {
                    message.content = JSON.parse(message.content);
                } catch {
                    // Ignore
                }
            }
        } else if (message.service === 'FABE') {
            message.messageType = readString(0, 3);
            message.channel = data.readUInt32BE(3);
            message.messageId = data.readUInt32BE(7);
            message.moreFlag = data.readUInt32BE(11);
            message.seq = data.readUInt32BE(12);
            message.checksum = data.readUInt32BE(16);

            //const contentLength = data.readUInt32BE(20);

            message.content = {};
            message.content.messageType = readString(24, 3);
            idx = 28;

            //this._options.logger?.('Alexa-Remote WS-MQTT: Incoming message Service Channel: ' + message.channel);

            if (message.channel === 0x361) {
                // GW_HANDSHAKE_CHANNEL
                if (message.content.messageType === 'ACK') {
                    let length = readHex(idx, 10);
                    idx += 11; // 10 + delimiter;
                    message.content.protocolVersion = readString(idx, length);
                    idx += length + 1;
                    length = readHex(idx, 10);
                    idx += 11; // 10 + delimiter;
                    message.content.connectionUUID = readString(idx, length);
                    idx += length + 1;
                    message.content.established = readHex(idx, 10);
                    idx += 11; // 10 + delimiter;
                    message.content.timestampINI = readHex(idx, 18);
                    idx += 19; // 18 + delimiter;
                    message.content.timestampACK = readHex(idx, 18);
                    idx += 19; // 18 + delimiter;
                }
            } else if (message.channel === 0x362) {
                // GW_CHANNEL
                if (message.content.messageType === 'GWM') {
                    message.content.subMessageType = readString(idx, 3);
                    idx += 4;
                    message.content.channel = readHex(idx, 10);
                    idx += 11; // 10 + delimiter;

                    if (message.content.channel === 0xb479) {
                        // DEE_WEBSITE_MESSAGING
                        let length = readHex(idx, 10);
                        idx += 11; // 10 + delimiter;
                        message.content.destinationIdentityUrn = readString(idx, length);
                        idx += length + 1;

                        length = readHex(idx, 10);
                        idx += 11; // 10 + delimiter;
                        const idData = readString(idx, length).split(' ');
                        idx += length + 1;

                        message.content.deviceIdentityUrn = idData[0];
                        message.content.payload = idData[1];
                        if (!message.content.payload) {
                            message.content.payload = readString(idx, data.length - 4 - idx);
                        }
                        if (message.content.payload.startsWith('{') && message.content.payload.endsWith('}')) {
                            try {
                                message.content.payload = JSON.parse(message.content.payload);
                                if (
                                    message.content.payload?.payload &&
                                    typeof message.content.payload.payload === 'string'
                                ) {
                                    message.content.payload.payload = JSON.parse(message.content.payload.payload);
                                }
                            } catch {
                                // Ignore
                            }
                        }
                    }
                }
            } else if (message.channel === 0x65) {
                // CHANNEL_FOR_HEARTBEAT
                message.content.payloadData = data.slice(idx, data.length - 4);
            }
        }
        //console.log(JSON.stringify(message, null, 4));
        //this._options.logger?.('Alexa-Remote WS-MQTT: Parsed Message: ' + JSON.stringify(message));
        return message;
    }

    /**
     * Closes the push connection and stops all reconnect attempts.
     */
    disconnect(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.pollingTimeout) {
            clearTimeout(this.pollingTimeout);
            this.pollingTimeout = null;
        }
        if (this.initTimeout) {
            clearTimeout(this.initTimeout);
            this.initTimeout = null;
        }
        this.stop = true;
        if (!this.websocket) {
            return;
        }
        try {
            this.websocket.close();
        } catch (e: any) {
            if (this.connectionActive) {
                this._options.logger?.(`Alexa-Remote WS-MQTT: Disconnect error: ${e.message}`);
            }
        }
    }
}
