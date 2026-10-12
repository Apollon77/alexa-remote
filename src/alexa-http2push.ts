import * as http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import type { AlexaRemoteOptions } from './types';

/**
 * Delivers an access token for the push connection.
 * With `force` a new token must be requested, because Amazon refused the current one.
 */
export type UpdateAccessTokenFunction = (callback: (token: string | null) => void, force?: boolean) => void;

/** Incomplete messages bigger than this are discarded (protection against endless buffering) */
const MAX_MESSAGE_SIZE = 1024 * 1024;

/**
 * Finds the end of the JSON object that starts at `start` in the buffer. Braces inside strings
 * (incl. escaped quotes) are ignored. The bytes can be checked directly, because the bytes of
 * multibyte UTF-8 characters never match ASCII characters.
 * If the next multipart boundary ("\r\n--") is reached first, the message is broken and its end is returned
 * (raw line breaks are not allowed in JSON strings), so the following messages are not lost.
 *
 * @param buffer received data
 * @param start index of the opening brace
 * @returns index after the closing brace (or of the boundary), -1 if the message is not yet complete
 */
export const findJsonEnd = (buffer: Buffer, start: number): number => {
    let depth = 0;
    let inString = false;
    for (let i = start; i < buffer.length; i++) {
        const byte = buffer[i];
        if (byte === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x2d && buffer[i + 3] === 0x2d) {
            return i;
        }
        if (inString) {
            if (byte === 0x5c) {
                // backslash: skip the escaped character
                i++;
            } else if (byte === 0x22) {
                inString = false;
            }
        } else if (byte === 0x22) {
            inString = true;
        } else if (byte === 0x7b) {
            depth++;
        } else if (byte === 0x7d) {
            depth--;
            if (depth === 0) {
                return i + 1;
            }
        }
    }
    return -1;
};

export default class AlexaHttp2Push extends EventEmitter {
    /** Options of the AlexaRemote instance */
    private _options: AlexaRemoteOptions;
    /** True after disconnect() was called: no reconnects anymore */
    public stop: boolean;
    /** HTTP/2 session to the push endpoint */
    public client: http2.ClientHttp2Session | null;
    /** Long living request stream that delivers the push messages */
    public stream: http2.ClientHttp2Stream | null;
    /** Timer that sends the keep alive pings */
    private pingPongInterval: NodeJS.Timeout | null;
    /** Number of failed connection attempts in a row */
    private errorRetryCounter: number;
    /** Timer for the next reconnect */
    private reconnectTimeout: NodeJS.Timeout | null;
    /** Timer that closes the connection if no pong is received */
    private pongTimeout: NodeJS.Timeout | null;
    /** Timer that closes the connection if the initialization is not done in time */
    private initTimeout: NodeJS.Timeout | null;
    private pollingTimeout: NodeJS.Timeout | null = null;
    /** True if the connection is established and the last ping was answered */
    private connectionActive: boolean;
    /** Access token used for the connection */
    private access_token: string | null;
    /** Function to get a (new) access token */
    private readonly update_access_token: UpdateAccessTokenFunction;
    /** True while the connection is closed, to handle the close only once */
    private inClosing: boolean;

    /**
     * Creates the HTTP/2 push connection handler. Call `connect()` to establish the connection.
     *
     * @param options options of the AlexaRemote instance (logger, amazonPage, pushDispatchHost)
     * @param update_access_token function that delivers a (new) access token for the connection
     */
    constructor(options: AlexaRemoteOptions, update_access_token: UpdateAccessTokenFunction) {
        super();

        this._options = options;
        this.stop = false;
        this.client = null;
        this.stream = null;
        this.pingPongInterval = null;
        this.errorRetryCounter = 0;
        this.reconnectTimeout = null;
        this.pongTimeout = null;
        this.initTimeout = null;
        this.connectionActive = false;
        this.access_token = null;
        this.update_access_token = update_access_token;
        this.inClosing = false;
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
     * Establishes the HTTP/2 connection to the Amazon push ("bob-dispatch") endpoint of the region.
     * Received directives are emitted as `command` events. The connection is kept alive with pings
     * every 3 minutes and re-established automatically with an increasing delay on errors.
     *
     * Emitted events: `connect`, `disconnect` (retry, message), `error`, `command` (command, payload)
     * and `unexpected-response`.
     */
    connect(): void {
        this.inClosing = false;
        this.update_access_token(token => {
            this.access_token = token;

            // Select the push endpoint of the region (EU is the default)
            let host = 'bob-dispatch-prod-eu.amazon.com';
            if (this._options.pushDispatchHost) {
                host = this._options.pushDispatchHost;
            } else if (this._options.amazonPage === 'amazon.com') {
                host = 'bob-dispatch-prod-na.amazon.com';
            } else if (this._options.amazonPage === 'amazon.ca') {
                host = 'bob-dispatch-prod-na.amazon.com';
            } else if (this._options.amazonPage === 'amazon.com.mx') {
                host = 'bob-dispatch-prod-na.amazon.com';
            } else if (this._options.amazonPage === 'amazon.com.br') {
                host = 'bob-dispatch-prod-na.amazon.com';
            } else if (this._options.amazonPage === 'amazon.co.jp') {
                host = 'bob-dispatch-prod-fe.amazon.com';
            } else if (this._options.amazonPage === 'amazon.com.au') {
                host = 'bob-dispatch-prod-fe.amazon.com';
            } else if (this._options.amazonPage === 'amazon.com.in') {
                host = 'bob-dispatch-prod-fe.amazon.com';
            } else if (this._options.amazonPage === 'amazon.co.nz') {
                host = 'bob-dispatch-prod-fe.amazon.com';
            }
            this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Use host ${host}`);

            const http2Options: http2.OutgoingHttpHeaders = {
                ':method': 'GET',
                ':path': '/v20160207/directives',
                ':authority': host,
                ':scheme': 'https',
                authorization: `Bearer ${this.access_token}`,
                'accept-encoding': 'gzip',
                'user-agent': 'okhttp/4.3.2-SNAPSHOT',
            };

            // Cleans up the connection and schedules a reconnect with increasing delay (max 60s)
            const onHttp2Close = (code?: number, reason?: string | Buffer, immediateReconnect?: boolean): void => {
                if (this.inClosing) {
                    return;
                }
                this.inClosing = true;
                if (reason) {
                    reason = reason.toString();
                }
                try {
                    this.stream?.destroy();
                } catch {
                    // ignore
                }
                try {
                    this.client?.destroy();
                } catch {
                    // ignore
                }
                this.client = null;
                this.stream = null;
                this.connectionActive = false;
                this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Close: ${code}: ${reason}`);
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
                if (this.stop) {
                    return;
                }
                // Give up after too many failed attempts
                if (this.errorRetryCounter > 100) {
                    this.emit('disconnect', false, 'Too many failed retries. Check cookie and data');
                    return;
                }

                this.errorRetryCounter++;

                const retryDelay =
                    immediateReconnect || this.errorRetryCounter === 1 ? 1 : Math.min(60, this.errorRetryCounter * 5);
                this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Retry Connection in ${retryDelay}s`);
                if (code !== undefined || reason !== undefined) {
                    this.emit('disconnect', true, `Retry Connection in ${retryDelay}s (${code}: ${reason})`);
                } else {
                    this.emit('disconnect', true, `Retry Connection in ${retryDelay}s`);
                }
                if (this.reconnectTimeout) {
                    clearTimeout(this.reconnectTimeout);
                }
                this.reconnectTimeout = setTimeout(() => {
                    this.reconnectTimeout = null;
                    this.connect();
                }, retryDelay * 1000);
            };

            // The first answered ping completes the initialization, every answer keeps the connection alive
            const onPingResponse = (resetErrorCount: boolean): void => {
                if (this.initTimeout) {
                    clearTimeout(this.initTimeout);
                    this.initTimeout = null;
                    this._options.logger?.('Alexa-Remote HTTP2-PUSH: Initialization completed');
                    this.emit('connect');
                }
                if (this.pongTimeout) {
                    clearTimeout(this.pongTimeout);
                    this.pongTimeout = null;
                }
                this.connectionActive = true;
                if (resetErrorCount) {
                    this.errorRetryCounter = 0;
                }
            };

            try {
                this.client = http2.connect(`https://${host}`, () => {
                    if (!this.client) {
                        return;
                    }
                    try {
                        this.stream = this.client.request(http2Options);
                    } catch (error: any) {
                        this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Error on Request ${error.message}`);
                        this.emit('error', error);
                        return;
                    }

                    this.stream.on(
                        'response',
                        (headers: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader) => {
                            if (headers[':status'] === 403) {
                                this._options.logger?.('Alexa-Remote HTTP2-PUSH: Error 403 .... refresh token');
                                // The token was refused: request a new one, even if it is not yet expired
                                this.update_access_token(token => {
                                    if (token) {
                                        this.access_token = token;
                                    }
                                    onHttp2Close(headers[':status'], undefined, this.errorRetryCounter < 3);
                                }, true);
                            } else if (headers[':status'] !== 200) {
                                onHttp2Close(headers[':status']);
                            }
                        },
                    );

                    // Received data that does not yet contain a complete message
                    let buffer: Buffer = Buffer.alloc(0);
                    let initialized = false;

                    this.stream.on('data', (data: Buffer) => {
                        if (this.stop) {
                            this.stream?.end();
                            this.client?.close();
                            return;
                        }
                        // The first boundary of the multipart stream means that the connection is established
                        if (!initialized && data.toString('ascii', 0, 6) === '------') {
                            initialized = true;
                            this.client?.ping(() => onPingResponse(false));

                            // Send a ping every 3 minutes and close the connection if no pong is received within 30s
                            this.pingPongInterval = setInterval(() => {
                                if (!this.stream || !this.client) {
                                    return;
                                }
                                this._options.logger?.('Alexa-Remote HTTP2-PUSH: Send Ping');
                                // console.log('SEND: ' + msg.toString('hex'));
                                try {
                                    this.client.ping(() => onPingResponse(true));
                                } catch (error: any) {
                                    this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Error on Ping ${error.message}`);
                                }

                                this.pongTimeout = setTimeout(() => {
                                    this.pongTimeout = null;
                                    this._options.logger?.('Alexa-Remote HTTP2-PUSH: No Pong received after 30s');
                                    this.stream?.end();
                                    this.client?.close();
                                    this.connectionActive = false;
                                }, 30000);
                            }, 180000);

                            // the chunk may already contain the first message, so it is processed below
                        }

                        // Messages can be split across several chunks and a chunk can contain several messages:
                        // collect the data and process every complete JSON object
                        buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
                        for (;;) {
                            const start = buffer.indexOf(0x7b); // '{'
                            if (start === -1) {
                                // only boundaries and part headers: nothing to keep
                                buffer = Buffer.alloc(0);
                                break;
                            }
                            const end = findJsonEnd(buffer, start);
                            if (end === -1) {
                                // incomplete message: keep it and wait for the next chunk
                                buffer = buffer.subarray(start);
                                if (buffer.length > MAX_MESSAGE_SIZE) {
                                    this.emit(
                                        'unexpected-response',
                                        `Message too big, discarded: ${buffer.toString('utf8', 0, 200)}...`,
                                    );
                                    buffer = Buffer.alloc(0);
                                }
                                break;
                            }
                            // decode only complete messages, so multibyte characters cannot be split
                            this.handleMessage(buffer.toString('utf8', start, end));
                            buffer = buffer.subarray(end);
                        }
                    });

                    this.stream.on('close', () => onHttp2Close());

                    this.stream.on('error', (error: Error) => {
                        this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Stream-Error: ${error}`);
                        this.emit('error', error);
                        this.stream?.end();
                        this.client?.close();
                    });
                });

                this.client.on('close', () => onHttp2Close());

                this.client.on('error', (error: Error) => {
                    this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Client-Error: ${error}`);
                    this.emit('error', error);
                    this.stream?.end();
                    this.client?.close();
                });
            } catch (err: any) {
                this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Error on Init ${err.message}`);
                this._options.logger?.(err.stack);
                this.emit('error', err);
                return;
            }
            if (this.initTimeout) {
                clearTimeout(this.initTimeout);
            }

            // Close the connection if it is not initialized within 30 seconds
            this.initTimeout = setTimeout(() => {
                this._options.logger?.('Alexa-Remote HTTP2-PUSH: Initialization not done within 30s');
                try {
                    this.stream?.end();
                    this.client?.close();
                } catch {
                    // just make sure
                }
                if (this.stream || !this.reconnectTimeout) {
                    // it seems no close was emitted so far?!
                    onHttp2Close();
                }
            }, 30000);
        });
    }

    /**
     * Processes a complete push message: JSON with `directive.payload.renderingUpdates[].resourceMetadata`,
     * which contains `{ command, payload }` as JSON string. Every update is emitted as `command` event.
     *
     * @param message the JSON message
     */
    private handleMessage(message: string): void {
        let data: any;
        try {
            data = JSON.parse(message);
        } catch (err: any) {
            this.emit('unexpected-response', `Could not parse json: ${message}: ${err.message}`);
            return;
        }
        if (!data?.directive?.payload || !Array.isArray(data.directive.payload.renderingUpdates)) {
            this._options.logger?.(
                `Alexa-Remote HTTP2-PUSH: Unexpected ResponseCould not find renderingUpdates in json: ${message}`,
            );
            return;
        }
        data.directive.payload.renderingUpdates.forEach((update: any) => {
            if (!update?.resourceMetadata) {
                this._options.logger?.(
                    `Alexa-Remote HTTP2-PUSH: Unexpected ResponseCould not find resourceMetadata in renderingUpdates: ${message}`,
                );
                return;
            }
            let command: string;
            let payload: any;
            try {
                const dataContent = JSON.parse(update.resourceMetadata);
                command = dataContent.command;
                payload = JSON.parse(dataContent.payload);
            } catch (err: any) {
                this.emit('unexpected-response', `Could not parse json: ${message}: ${err.message}`);
                return;
            }

            this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Command ${command}: ${JSON.stringify(payload, null, 4)}`);
            this.emit('command', command, payload);
        });
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
        if (!this.client && !this.stream) {
            return;
        }
        try {
            this.stream?.end();
            this.client?.close();
        } catch (e: any) {
            this.connectionActive && this._options.logger?.(`Alexa-Remote HTTP2-PUSH: Disconnect error: ${e.message}`);
        }
    }
}
