const http2 = require('http2');
const EventEmitter = require('events');

class AlexaHttp2Push extends EventEmitter {

    constructor(options, update_access_token) {
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

    isConnected() {
        return this.connectionActive;
    }

    connect() {
        this.inClosing = false;
        this.update_access_token(token => {
            this.access_token = token;

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
            this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Use host ${host}`);


            const http2Options = {
                ':method': 'GET',
                ':path': '/v20160207/directives',
                ':authority': host,
                ':scheme': 'https',
                'authorization': `Bearer ${this.access_token}`,
                'accept-encoding': 'gzip',
                'user-agent': 'okhttp/4.3.2-SNAPSHOT',
            };

            const onHttp2Close = (code, reason, immediateReconnect) => {
                if (this.inClosing) return;
                this.inClosing = true;
                if (reason) {
                    reason = reason.toString();
                }
                try {
                    this.stream && this.stream.destroy();
                } catch (err) {
                    // ignore
                }
                try {
                    this.client && this.client.destroy();
                } catch (err) {
                    // ignore
                }
                this.client = null;
                this.stream = null;
                this.connectionActive = false;
                this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Close: ${code}: ${reason}`);
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
                if (this.errorRetryCounter > 100) {
                    this.emit('disconnect', false, 'Too many failed retries. Check cookie and data');
                    return;
                }

                this.errorRetryCounter++;

                const retryDelay = (immediateReconnect || this.errorRetryCounter === 1) ? 1 : Math.min(60, this.errorRetryCounter * 5);
                this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Retry Connection in ${retryDelay}s`);
                if (code !== undefined || reason !== undefined) {
                    this.emit('disconnect', true, `Retry Connection in ${retryDelay}s (${code}: ${reason})`);
                } else {
                    this.emit('disconnect', true, `Retry Connection in ${retryDelay}s`);
                }
                this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = setTimeout(() => {
                    this.reconnectTimeout = null;
                    this.connect();
                }, retryDelay * 1000);
            };

            const onPingResponse = (resetErrorCount) => {
                if (this.initTimeout) {
                    clearTimeout(this.initTimeout);
                    this.initTimeout = null;
                    this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Initialization completed');
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
                this.client = http2.connect(`https://${http2Options[':authority']}`,  () => {
                    if (!this.client) {
                        return;
                    }
                    try {
                        this.stream = this.client.request(http2Options);
                    } catch (error) {
                        this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Error on Request ${error.message}`);
                        this.emit('error', error);
                        return;
                    }

                    this.stream.on('response', async (headers) => {
                        if (headers[':status'] === 403) {
                            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Error 403 .... refresh token');
                            this.update_access_token(token => {
                                if (token) {
                                    this.access_token = token;
                                }
                                onHttp2Close(headers[':status'], undefined, this.errorRetryCounter < 3);
                            });
                        } else if (headers[':status'] !== 200) {
                            onHttp2Close(headers[':status']);
                        }
                    });

                    this.stream.on('data', (chunk) => {
                        if (this.stop) {
                            this.stream && this.stream.end();
                            this.client && this.client.close();
                            return;
                        }
                        chunk = chunk.toString();
                        if (chunk.startsWith('------')) {
                            this.client.ping(() => onPingResponse(false));

                            this.pingPongInterval = setInterval(() => {
                                if (!this.stream || !this.client) {
                                    return;
                                }
                                this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Send Ping');
                                // console.log('SEND: ' + msg.toString('hex'));
                                try {
                                    this.client.ping(() => onPingResponse(true));
                                } catch (error) {
                                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Error on Ping ${error.message}`);
                                }

                                this.pongTimeout = setTimeout(() => {
                                    this.pongTimeout = null;
                                    this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: No Pong received after 30s');
                                    this.stream && this.stream.end();
                                    this.client && this.client.close();
                                    this.connectionActive = false;
                                }, 30000);
                            }, 180000);

                            return;
                        }
                        if (chunk.startsWith('Content-Type: application/json')) {
                            const json_start = chunk.indexOf('{');
                            const json_end = chunk.lastIndexOf('}');
                            if (json_start === -1 || json_end === -1) {
                                this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Unexpected ResponseCould not find json in chunk: ${chunk}`);
                                return;
                            }
                            const message = chunk.substring(json_start, json_end + 1);
                            try {
                                const data = JSON.parse(message);
                                if (!data || !data.directive || !data.directive.payload || !Array.isArray(data.directive.payload.renderingUpdates)) {
                                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Unexpected ResponseCould not find renderingUpdates in json: ${message}`);
                                    return;
                                }
                                data.directive.payload.renderingUpdates.forEach(update => {
                                    if (!update || !update.resourceMetadata) {
                                        this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Unexpected ResponseCould not find resourceMetadata in renderingUpdates: ${message}`);
                                    }
                                    const dataContent = JSON.parse(update.resourceMetadata);

                                    const command = dataContent.command;
                                    const payload = JSON.parse(dataContent.payload);

                                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Command ${command}: ${JSON.stringify(payload, null, 4)}`);
                                    this.emit('command', command, payload);
                                });
                            } catch (err) {
                                this.emit('unexpected-response', `Could not parse json: ${message}: ${err.message}`);
                            }
                        }
                    });

                    this.stream.on('close', onHttp2Close);

                    this.stream.on('error', (error) => {
                        this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Stream-Error: ${error}`);
                        this.emit('error', error);
                        this.stream && this.stream.end();
                        this.client && this.client.close();
                    });
                });

                this.client.on('close', onHttp2Close);

                this.client.on('error', (error) => {
                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Client-Error: ${error}`);
                    this.emit('error', error);
                    this.stream && this.stream.end();
                    this.client && this.client.close();
                });
            }
            catch (err) {
                this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Error on Init ${err.message}`);
                this._options.logger && this._options.logger(err.stack);
                this.emit('error', err);
                return;
            }
            this.initTimeout && clearTimeout(this.initTimeout);

            this.initTimeout = setTimeout(() => {
                this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Initialization not done within 30s');
                try {
                    this.stream && this.stream.end();
                    this.client && this.client.close();
                } catch (err) {
                    // just make sure
                }
                if (this.stream || !this.reconnectTimeout) { // it seems no close was emitted so far?!
                    onHttp2Close();
                }
            }, 30000);
        });
    }

    disconnect() {
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
            this.stream && this.stream.end();
            this.client && this.client.close();
        } catch (e) {
            this.connectionActive && this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Disconnect error: ${e.message}`);
        }
    }
}

module.exports = AlexaHttp2Push;
