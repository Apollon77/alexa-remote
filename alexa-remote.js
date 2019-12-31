/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

const https = require('https');
const querystring = require('querystring');
const os = require('os');
const extend = require('extend');
const AlexaWsMqtt = require('./alexa-wsmqtt.js');
const uuidv1 = require('uuid/v1');

const EventEmitter = require('events');

function _00(val) {
    let s = val.toString();
    while (s.length < 2) s = '0' + s;
    return s;
}


class AlexaRemote extends EventEmitter {

    constructor() {
        super();

        this.serialNumbers = {};
        this.names = {};
        this.friendlyNames = {};
        this.lastAuthCheck = null;
        this.cookie = null;
        this.csrf = null;
        this.cookieData = null;

        this.baseUrl = 'alexa.amazon.de';
    }

    setCookie(_cookie) {
        if (!_cookie) return;
        if (typeof _cookie === 'string') {
            this.cookie = _cookie;
        }
        else if (_cookie && _cookie.cookie && typeof _cookie.cookie === 'string') {
            this.cookie = _cookie.cookie;
        }
        else if (_cookie && _cookie.localCookie && typeof _cookie.localCookie === 'string') {
            this.cookie = _cookie.localCookie;
            this._options.formerRegistrationData = this.cookieData = _cookie;
        }
        else if (_cookie && _cookie.cookie && typeof _cookie.cookie === 'object') {
            return this.setCookie(_cookie.cookie);
        }

        if (!this.cookie || typeof this.cookie !== 'string') return;
        let ar = this.cookie.match(/csrf=([^;]+)/);
        if (!ar || ar.length < 2) ar = this.cookie.match(/csrf=([^;]+)/);
        if (!this.csrf && ar && ar.length >= 2) {
            this.csrf = ar[1];
        }
        if (!this.csrf) {
            this.cookie = null;
            return;
        }
        this._options.csrf = this.csrf;
        this._options.cookie = this.cookie;
    }

    init(cookie, callback) {
        if (typeof cookie === 'object') {
            this._options = cookie;
            if (!this._options.userAgent) {
                let platform = os.platform();
                if (platform === 'win32') {
                    this._options.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:99.0) Gecko/20100101 Firefox/99.0';
                }
                /*else if (platform === 'darwin') {
                    this._options.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/57.0.2987.133 Safari/537.36';
                }*/
                else {
                    this._options.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/51.0.2704.103 Safari/537.36';
                }
            }
            this._options.amazonPage = this._options.amazonPage || 'amazon.de';
            this.baseUrl = 'alexa.' + this._options.amazonPage;

            cookie = this._options.cookie;
        }
        this._options.logger && this._options.logger('Alexa-Remote: Use as User-Agent: ' + this._options.userAgent);
        this._options.logger && this._options.logger('Alexa-Remote: Use as Login-Amazon-URL: ' + this._options.amazonPage);
        if (this._options.alexaServiceHost) this.baseUrl = this._options.alexaServiceHost;
        this._options.logger && this._options.logger('Alexa-Remote: Use as Base-URL: ' + this.baseUrl);
        this._options.alexaServiceHost = this.baseUrl;
        if (this._options.refreshCookieInterval !== 0) {
            this._options.refreshCookieInterval = this._options.refreshCookieInterval || 7*24*60*60*1000; // Auto Refresh after 7 days
        }

        const self = this;
        function getCookie(callback) {
            if (!self.cookie) {
                self._options.logger && self._options.logger('Alexa-Remote: No cookie given, generate one');
                self._options.cookieJustCreated = true;
                self.generateCookie(self._options.email, self._options.password, function(err, res) {
                    if (!err && res) {
                        self.setCookie(res); // update
                        self.alexaCookie.stopProxyServer();
                        return callback (null);
                    }
                    callback(err);
                });
            }
            else {
                self._options.logger && self._options.logger('Alexa-Remote: cookie was provided');
                if (self._options.formerRegistrationData) {
                    const tokensValidSince = Date.now() - self._options.formerRegistrationData.tokenDate;
                    if (tokensValidSince < 24 * 60 * 60 * 1000) {
                        return callback(null);
                    }
                    self._options.logger && self._options.logger('Alexa-Remote: former registration data exist, try refresh');
                    self._options.logger && self._options.logger(JSON.stringify(self._options.formerRegistrationData));
                    self.refreshCookie(function(err, res) {
                        if (err || !res) {
                            self._options.logger && self._options.logger('Alexa-Remote: Error from refreshing cookies');
                            self.cookie = null;
                            return getCookie(callback); // error on refresh
                        }
                        self.setCookie(res); // update
                        return callback(null);
                    });
                }
                else {
                    callback(null);
                }
            }
        }

        this.setCookie(cookie); // set initial cookie
        getCookie((err) => {
            if (typeof callback === 'function') callback = callback.bind(this);
            if (err) {
                this._options.logger && this._options.logger('Alexa-Remote: Error from retrieving cookies');
                return callback && callback(err);
            }
            if (!this.csrf) return callback && callback(new Error('no csrf found'));
            this.checkAuthentication((authenticated, err) => {
                if (err && authenticated === null) {
                    return callback && callback(new Error('Error while checking Authentication: ' + err));
                }
                this._options.logger && this._options.logger('Alexa-Remote: Authentication checked: ' + authenticated);
                if (! authenticated && !this._options.cookieJustCreated) {
                    this._options.logger && this._options.logger('Alexa-Remote: Cookie was set, but authentication invalid');
                    delete this._options.cookie;
                    delete this._options.csrf;
                    delete this._options.localCookie;
                    return this.init(this._options, callback);
                }
                this.lastAuthCheck = new Date().getTime();
                if (this.cookieRefreshTimeout) {
                    clearTimeout(this.cookieRefreshTimeout);
                    this.cookieRefreshTimeout = null;
                }
                if (this._options.RefreshCookieInterval) {
                    this.cookieRefreshTimeout = setTimeout(() => {
                        this.cookieRefreshTimeout = null;
                        this._options.cookie = this.cookieData;
                        delete this._options.csrf;
                        this.init(this._options, callback);
                    }, this._options.refreshCookieInterval);
                }
                this.prepare(() => {
                    if (this._options.useWsMqtt) {
                        this.initWsMqttConnection();
                    }
                    callback && callback();
                });
            });
        });
    }

    prepare(callback) {
        this.getAccount((err, result) => {
            if (!err && result && Array.isArray(result)) {
                result.forEach ((account) => {
                    if (!this.commsId) this.commsId = account.commsId;
                    //if (!this.directedId) this.directedId = account.directedId;
                });
            }

            this.initDeviceState(() =>
                this.initWakewords(() =>
                    this.initBluetoothState(() =>
                        this.initNotifications(callback)
                    )
                )
            );
        });
        return this;
    }

    initNotifications(callback) {
        if (!this._options.notifications) return callback && callback();
        this.getNotifications((err, res) => {
            if (err || !res || !res.notifications || !Array.isArray(res.notifications)) return callback && callback();

            for (var serialNumber in this.serialNumbers) {
                if (this.serialNumbers.hasOwnProperty(serialNumber)) {
                    this.serialNumbers[serialNumber].notifications = [];
                }
            }

            res.notifications.forEach((noti) => {
                let device = this.find(noti.deviceSerialNumber);
                if (!device) {
                    //TODO: new stuff
                    return;
                }
                if (noti.alarmTime && !noti.originalTime && noti.originalDate && noti.type !== 'Timer') {
                    const now = new Date(noti.alarmTime);
                    noti.originalTime = `${_00(now.getHours())}:${_00(now.getMinutes())}:${_00(now.getSeconds())}.000`;
                }
                noti.set = this.changeNotification.bind(this, noti);
                device.notifications.push(noti);
            });
            callback && callback();
        });
    }

    initWakewords(callback) {
        this.getWakeWords((err, wakeWords) => {
            if (err || !wakeWords || !Array.isArray(wakeWords.wakeWords)) return callback && callback();

            wakeWords.wakeWords.forEach((o) => {
                let device = this.find(o.deviceSerialNumber);
                if (!device) {
                    //TODO: new stuff
                    return;
                }
                if (typeof o.wakeWord === 'string') {
                    device.wakeWord = o.wakeWord.toLowerCase();
                }
            });
            callback && callback();
        });
    }

    initDeviceState(callback) {
        this.getDevices((err, result) => {
            if (!err && result && Array.isArray(result.devices)) {
                let customerIds = {};
                result.devices.forEach((device) => {
                    const existingDevice = this.find(device.serialNumber);
                    if (!existingDevice) {
                        this.serialNumbers[device.serialNumber] = device;
                    }
                    else {
                        device = extend(true, existingDevice, device);
                    }
                    let name = device.accountName;
                    this.names [name] = device;
                    this.names [name.toLowerCase()] = device;
                    if (device.deviceTypeFriendlyName) {
                        name += ' (' + device.deviceTypeFriendlyName + ')';
                        this.names [name] = device;
                        this.names [name.toLowerCase()] = device;
                    }
                    device._orig = JSON.parse(JSON.stringify(device));
                    device._name = name;
                    device.sendCommand = this.sendCommand.bind(this, device);
                    device.setTunein = this.setTunein.bind(this, device);
                    device.rename = this.renameDevice.bind(this, device);
                    device.setDoNotDisturb = this.setDoNotDisturb.bind(this, device);
                    device.delete = this.deleteDevice.bind(this, device);
                    if (device.deviceTypeFriendlyName) this.friendlyNames[device.deviceTypeFriendlyName] = device;
                    if (customerIds[device.deviceOwnerCustomerId] === undefined) customerIds[device.deviceOwnerCustomerId] = 0;
                    customerIds[device.deviceOwnerCustomerId] += 1;
                    device.isControllable = (
                        device.capabilities.includes('AUDIO_PLAYER') ||
                        device.capabilities.includes('AMAZON_MUSIC') ||
                        device.capabilities.includes('TUNE_IN')
                    );
                    device.hasMusicPlayer = (
                        device.capabilities.includes('AUDIO_PLAYER') ||
                        device.capabilities.includes('AMAZON_MUSIC')
                    );
                    device.isMultiroomDevice = (device.clusterMembers.length > 0);
                    device.isMultiroomMember = (device.parentClusters.length > 0);
                });
                this.ownerCustomerId = Object.keys(customerIds)[0];
            }
            callback && callback();
        });
    }

    initBluetoothState(callback) {
        if (this._options.bluetooth) {
            this.getBluetooth((err, res) => {
                if (err || !res || !Array.isArray(res.bluetoothStates)) {
                    this._options.bluetooth = false;
                    return callback && callback ();
                }
                const self = this;
                res.bluetoothStates.forEach((bt) => {
                    if (bt.pairedDeviceList && this.serialNumbers[bt.deviceSerialNumber]) {
                        this.serialNumbers[bt.deviceSerialNumber].bluetoothState = bt;
                        bt.pairedDeviceList.forEach((d) => {
                            bt[d.address] = d;
                            d.connect = function (on, cb) {
                                self[on ? 'connectBluetooth' : 'disconnectBluetooth'] (self.serialNumbers[bt.deviceSerialNumber], d.address, cb);
                            };
                            d.unpaire = function (val, cb) {
                                self.unpaireBluetooth (self.serialNumbers[bt.deviceSerialNumber], d.address, cb);
                            };
                        });
                    }
                });
                callback && callback();
            });
        } else {
            callback && callback();
        }
    }

    initWsMqttConnection() {
        if (this.alexaWsMqtt) {
            this.alexaWsMqtt.removeAllListeners();
            this.alexaWsMqtt.disconnect();
            this.alexaWsMqtt = null;
        }
        this.alexaWsMqtt = new AlexaWsMqtt(this._options, this.cookie);
        if (!this.alexaWsMqtt) return;

        this.alexaWsMqtt.on('disconnect', (retries, msg) => {
            this.emit('ws-disconnect', retries, msg);
        });
        this.alexaWsMqtt.on('error', (error) => {
            this.emit('ws-error', error);
        });
        this.alexaWsMqtt.on('connect', () => {
            this.emit('ws-connect');
        });
        this.alexaWsMqtt.on('unknown', (incomingMsg) => {
            this.emit('ws-unknown-message', incomingMsg);
        });
        this.alexaWsMqtt.on('command', (command, payload) => {
			
			this.emit('command', { 'command': command, 'payload': payload });
			
            switch(command) {
                case 'PUSH_DOPPLER_CONNECTION_CHANGE':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'dopplerId': {
                            'deviceSerialNumber': 'c6c113ab49ff498185aa1ee5eb50cd73',
                            'deviceType': 'A3H674413M2EKB'
                        },
                        'dopplerConnectionState': 'OFFLINE' / 'ONLINE'
                    }
                    */
                    this.emit('ws-device-connection-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        connectionState: payload.dopplerConnectionState
                    });
                    return;
                case 'PUSH_BLUETOOTH_STATE_CHANGE':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'dopplerId': {
                            'deviceSerialNumber': 'G090LF09643202VS',
                            'deviceType': 'A3S5BH2HU6VAYF'
                        },
                        'bluetoothEvent': 'DEVICE_DISCONNECTED',
                        'bluetoothEventPayload': null,
                        'bluetoothEventSuccess': false/true
                    }
                    */
                    this.emit('ws-bluetooth-state-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        bluetoothEvent: payload.bluetoothEvent,
                        bluetoothEventPayload: payload.bluetoothEventPayload,
                        bluetoothEventSuccess: payload.bluetoothEventSuccess
                    });
                    return;
                case 'PUSH_AUDIO_PLAYER_STATE':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'mediaReferenceId': '2868373f-058d-464c-aac4-12e12aa58883:2',
                        'dopplerId': {
                            'deviceSerialNumber': 'G090LF09643202VS',
                            'deviceType': 'A3S5BH2HU6VAYF'
                        },
                        'error': false,
                        'audioPlayerState': 'INTERRUPTED', / 'FINISHED' / 'PLAYING'
                        'errorMessage': null
                    }
                    */
                    this.emit('ws-audio-player-state-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        mediaReferenceId: payload.mediaReferenceId,
                        audioPlayerState: payload.audioPlayerState, //  'INTERRUPTED', / 'FINISHED' / 'PLAYING'
                        error: payload.error,
                        errorMessage: payload.errorMessage
                    });
                    return;
                case 'PUSH_MEDIA_QUEUE_CHANGE':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'changeType': 'NEW_QUEUE',
                        'playBackOrder': null,
                        'trackOrderChanged': false,
                        'loopMode': null,
                        'dopplerId': {
                            'deviceSerialNumber': 'G090LF09643202VS',
                            'deviceType': 'A3S5BH2HU6VAYF'
                        }
                    }
                    */
                    this.emit('ws-media-queue-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        changeType: payload.changeType,
                        playBackOrder: payload.playBackOrder,
                        trackOrderChanged: payload.trackOrderChanged,
                        loopMode: payload.loopMode
                    });
                    return;
                case 'PUSH_MEDIA_CHANGE':
                    /*
                    {
                        'destinationUserId': 'A3NT1OXG4QHVPX',
                        'mediaReferenceId': '71c4d721-0e94-4b3e-b912-e1f27fcebba1:1',
                        'dopplerId': {
                            'deviceSerialNumber': 'G000JN0573370K82',
                            'deviceType': 'A1NL4BVLQ4L3N3'
                        }
                    }
                    */
                    this.emit('ws-media-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        mediaReferenceId: payload.mediaReferenceId
                    });
                    return;
                case 'PUSH_MEDIA_PROGRESS_CHANGE':
                    /*
                    {
                        "destinationUserId": "A2Z2SH760RV43M",
                        "progress": {
                            "mediaProgress": 899459,
                            "mediaLength": 0
                        },
                        "dopplerId": {
                            "deviceSerialNumber": "G2A0V7048513067J",
                            "deviceType": "A18O6U1UQFJ0XK"
                        },
                        "mediaReferenceId": "c4a72dbe-ef6b-42b7-8104-0766aa32386f:1"
                    }
                    */
                    this.emit('ws-media-progress-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        mediaReferenceId: payload.mediaReferenceId,
                        mediaProgress: payload.progress ? payload.progress.mediaProgress : null,
                        mediaLength: payload.progress ? payload.progress.mediaLength : null
                    });
                    return;
                case 'PUSH_VOLUME_CHANGE':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'dopplerId': {
                            'deviceSerialNumber': 'c6c113ab49ff498185aa1ee5eb50cd73',
                            'deviceType': 'A3H674413M2EKB'
                        },
                        'isMuted': false,
                        'volumeSetting': 50
                    }
                    */
                    this.emit('ws-volume-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        isMuted: payload.isMuted,
                        volume: payload.volumeSetting
                    });
                    return;
                case 'PUSH_CONTENT_FOCUS_CHANGE':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'clientId': '{value=Dee-Domain-Music}',
                        'dopplerId': {
                            'deviceSerialNumber': 'G090LF09643202VS',
                            'deviceType': 'A3S5BH2HU6VAYF'
                        },
                        'deviceComponent': 'com.amazon.dee.device.capability.audioplayer.AudioPlayer'
                    }
                    */
                    this.emit('ws-content-focus-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        deviceComponent: payload.deviceComponent
                    });
                    return;
                case 'PUSH_EQUALIZER_STATE_CHANGE':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'bass': 0,
                        'treble': 0,
                        'dopplerId': {
                            'deviceSerialNumber': 'G090LA09751707NU',
                            'deviceType': 'A2M35JJZWCQOMZ'
                        },
                        'midrange': 0
                    }
                    */
                    this.emit('ws-equilizer-state-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        bass: payload.bass,
                        treble: payload.treble,
                        midrange: payload.midrange
                    });
                    return;
                case 'PUSH_NOTIFICATION_CHANGE':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'dopplerId': {
                            'deviceSerialNumber': 'G090LF09643202VS',
                            'deviceType': 'A3S5BH2HU6VAYF'
                        },
                        'eventType': 'UPDATE',
                        'notificationId': 'd676d954-3c34-3559-83ac-606754ff6ec1',
                        'notificationVersion': 2
                    }
                    */
                    this.emit('ws-notification-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        eventType: payload.eventType,
                        notificationId: payload.notificationId,
                        notificationVersion: payload.notificationVersion
                    });
                    return;

                case 'PUSH_ACTIVITY':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'key': {
                            'entryId': '1533932315288#A3S5BH2HU6VAYF#G090LF09643202VS',
                            'registeredUserId': 'A3NSX4MMJVG96V'
                        },
                        'timestamp': 1533932316865
                    }

                    {
                        '_disambiguationId': null,
                        'activityStatus': 'SUCCESS', // DISCARDED_NON_DEVICE_DIRECTED_INTENT // FAULT
                        'creationTimestamp': 1533932315288,
                        'description': '{\'summary\':\'spiel Mike Oldfield von meine bibliothek\',\'firstUtteranceId\':\'TextClient:1.0/2018/08/10/20/G090LF09643202VS/18:35::TNIH_2V.cb0c133b-3f90-4f7f-a052-3d105529f423LPM\',\'firstStreamId\':\'TextClient:1.0/2018/08/10/20/G090LF09643202VS/18:35::TNIH_2V.cb0c133b-3f90-4f7f-a052-3d105529f423LPM\'}',
                        'domainAttributes': '{\'disambiguated\':false,\'nBestList\':[{\'entryType\':\'PlayMusic\',\'mediaOwnerCustomerId\':\'A3NSX4MMJVG96V\',\'playQueuePrime\':false,\'marketplace\':\'A1PA6795UKMFR9\',\'imageURL\':\'https://album-art-storage-eu.s3.amazonaws.com/93fff3ba94e25a666e300facd1ede29bf84e6e17083dc7e60c6074a77de71a1e_256x256.jpg?response-content-type=image%2Fjpeg&x-amz-security-token=FQoGZXIvYXdzEP3%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaDInhZqxchOhE%2FCQ3bSKrAWGE9OKTrShkN7rSKEYzYXH486T6c%2Bmcbru4RGEGu9Sq%2BL%2FpG5o2EWsHnRULSM4cpreC1KG%2BIfzo8nuskQk8fklDgIyrK%2B%2B%2BFUm7rxmTKWBjavbKQxEtrnQATgo7%2FghmztEmXC5r742uvyUyAjZcZ4chCezxa%2Fkbr00QTv1HX18Hj5%2FK4cgItr5Kyv2bfmFTZ2Jlvr8IbAQn0X0my1XpGJyjUuW8IGIPhqiCQyi627fbBQ%3D%3D&AWSAccessKeyId=ASIAZZLLX6KM4MGDNROA&Expires=1533935916&Signature=OozE%2FmJbIVVvK2CRhpa2VJPYudE%3D\',\'artistName\':\'Mike Oldfield\',\'serviceName\':\'CLOUD_PLAYER\',\'isAllSongs\':true,\'isPrime\':false}]}',
                        'domainType': null,
                        'feedbackAttributes': null,
                        'id': 'A3NSX4MMJVG96V#1533932315288#A3S5BH2HU6VAYF#G090LF09643202VS',
                        'intentType': null,
                        'providerInfoDescription': null,
                        'registeredCustomerId': 'A3NSX4MMJVG96V',
                        'sourceActiveUsers': null,
                        'sourceDeviceIds': [{
                            'deviceAccountId': null,
                            'deviceType': 'A3S5BH2HU6VAYF',
                            'serialNumber': 'G090LF09643202VS'
                        }],
                        'utteranceId': 'TextClient:1.0/2018/08/10/20/G090LF09643202VS/18:35::TNIH_2V.cb0c133b-3f90-4f7f-a052-3d105529f423LPM',
                        'version': 1
                    }
                    */
                    this.getActivities({size: 3, filter: false}, (err, res) => {
                        if (err || !res) return;
                        let activity = null;
                        for (let i = 0; i < res.length; i++) {
                            if (res[i].data.id.endsWith('#' + payload.key.entryId) && res[i].data.registeredCustomerId === payload.key.registeredUserId) {
                                activity = res[i];
                                break;
                            }
                        }

                        if (!activity) {
                            this._options.logger && this._options.logger('Alexa-Remote: Activity for id ' + payload.key.entryId + ' not found');
                            return;
                        }
                        //this._options.logger && this._options.logger('Alexa-Remote: Activity found for id ' + payload.key.entryId + ': ' + JSON.stringify(activity));

                        activity.destinationUserId = payload.destinationUserId;
                        this.emit('ws-device-activity', activity);
                    });
                    return;
				
                case 'PUSH_TODO_CHANGE': // does not exist?
                case 'PUSH_LIST_CHANGE': // does not exist?
                case 'PUSH_LIST_ITEM_CHANGE':
					/*
					{
						destinationUserId:'A12XXXXXWISGT',
						listId:'YW16bjEuYWNjb3VudC5BRzJGWEpGWE5DRDZNVzNRSUdFM0xLWkZCWFhRLVRBU0s=',
						eventName:'itemCreated',
						version:1,
						listItemId:'c6852978-bb79-44dc-b7e5-8f5e577432cf'
					}
					*/
					this.emit('ws-todo-change', {
						destinationUserId: payload.destinationUserId,
						eventType: payload.eventName, // itemCreated, itemUpdated (including checked ToDo), itemDeleted
						listId: payload.listId,
						listItemVersion: payload.version,
						listItemId: payload.listItemId
					});
                    return;
					
                case 'PUSH_MICROPHONE_STATE':
                case 'PUSH_DELETE_DOPPLER_ACTIVITIES':
                    return;

            }

            this.emit('ws-unknown-command', command, payload);
        });

        this.alexaWsMqtt.connect();
    }

    stop() {
        if (this.cookieRefreshTimeout) {
            clearTimeout(this.cookieRefreshTimeout);
            this.cookieRefreshTimeout = null;
        }
        if (this.alexaWsMqtt) {
            this.alexaWsMqtt.disconnect();
        }
    }

    generateCookie(email, password, callback) {
        if (!this.alexaCookie) this.alexaCookie = require('alexa-cookie2');
        this.alexaCookie.generateAlexaCookie(email, password, this._options, callback);
    }

    refreshCookie(callback) {
        if (!this.alexaCookie) this.alexaCookie = require('alexa-cookie2');
        this.alexaCookie.refreshAlexaCookie(this._options, callback);
    }

    httpsGet(noCheck, path, callback, flags = {}) {
        if (typeof noCheck !== 'boolean') {
            flags = callback;
            callback = path;
            path = noCheck;
            noCheck = false;
        }
        // bypass check because set or last check done before less then 10 mins
        if (noCheck || (new Date().getTime() - this.lastAuthCheck) < 600000) {
            this._options.logger && this._options.logger('Alexa-Remote: No authentication check needed (time elapsed ' + (new Date().getTime() - this.lastAuthCheck) + ')');
            return this.httpsGetCall(path, callback, flags);
        }
        this.checkAuthentication((authenticated, err) => {
            if (authenticated) {
                this._options.logger && this._options.logger('Alexa-Remote: Authentication check successfull');
                this.lastAuthCheck = new Date().getTime();
                return this.httpsGetCall(path, callback, flags);
            }
            else if (err && authenticated === null) {
                this._options.logger && this._options.logger('Alexa-Remote: Authentication check returned error: ' + err + '. Still try request');
                return this.httpsGetCall(path, callback, flags);
            }
            this._options.logger && this._options.logger('Alexa-Remote: Authentication check Error, try re-init');
            delete this._options.csrf;
            delete this._options.cookie;
            this.init(this._options, function(err) {
                if (err) {
                    this._options.logger && this._options.logger('Alexa-Remote: Authentication check Error and renew unsuccessfull. STOP');
                    return callback(new Error('Cookie invalid, Renew unsuccessfull'));
                }
                return this.httpsGet(path, callback, flags);
            });
        });
    }

    httpsGetCall(path, callback, flags = {}) {
		
        let options = {
            host: this.baseUrl,
            path: '',
            method: 'GET',
            timeout: 10000,
            headers: {
                'User-Agent' : this._options.userAgent,
                'Content-Type': 'application/json; charset=UTF-8',
                'Referer': `https://alexa.${this._options.amazonPage}/spa/index.html`,
                'Origin': `https://alexa.${this._options.amazonPage}`,
                //'Content-Type': 'application/json',
                //'Connection': 'keep-alive', // new
                'csrf' : this.csrf,
                'Cookie' : this.cookie
            }
        };

        path = path.replace(/[\n ]/g, '');
        if (!path.startsWith('/')) {
            path = path.replace(/^https:\/\//, '');
            //let ar = path.match(/^([^\/]+)(\/.*$)/);
            let ar = path.match(/^([^\/]+)([\/]*.*$)/);
            options.host = ar[1];
            path = ar[2];
        } else {
            options.host = this.baseUrl;
        }
        let time = new Date().getTime();
        path = path.replace(/%t/g, time);

        options.path = path;
        options.method = flags.method? flags.method : flags.data ? 'POST' : 'GET';

        if (flags.headers) Object.keys(flags.headers).forEach(n => {
            options.headers [n] = flags.headers[n];
        });

        const logOptions = JSON.parse(JSON.stringify(options));
        delete logOptions.headers.Cookie;
        delete logOptions.headers.csrf;
        delete logOptions.headers['User-Agent'];
        delete logOptions.headers['Content-Type'];
        delete logOptions.headers.Referer;
        delete logOptions.headers.Origin;
        this._options.logger && this._options.logger('Alexa-Remote: Sending Request with ' + JSON.stringify(logOptions) + ((options.method === 'POST' || options.method === 'PUT' || options.method === 'DELETE') ? ' and data=' + flags.data : ''));
        
		let req = https.request(options, (res) => {
            let body  = '';

            res.on('data', (chunk) => {
                body += chunk;
            });

            res.on('end', () => {
                let ret;
				
                if (typeof callback === 'function') {
                    if (!body) { // Method 'DELETE' may return HTTP STATUS 200 without body
                        this._options.logger && this._options.logger('Alexa-Remote: Response: No body');
                        return res.statusCode.toString().substr(0,1) == '2' ? callback(null, { 'success': true }) : callback(new Error('no body and status code '+res.statusCode.toString()+'.  Headers: '+JSON.stringify(res.headers)), null);
                    }
					
                    try {
                        ret = JSON.parse(body);
                    } catch(e) {
                        this._options.logger && this._options.logger('Alexa-Remote: Response: No/Invalid JSON');
                        return callback (new Error('no JSON'), body);
                    }
					
                    this._options.logger && this._options.logger('Alexa-Remote: Response: ' + JSON.stringify(ret));
                    return callback (null, ret);
                    callback(ret);
                }
            });
        });

        req.on('error', function(e) {
            if (typeof callback === 'function'/* && callback.length >= 2*/) {
                return callback (e, null);
            }
        });
		
        if (flags && flags.data) {
            req.write(flags.data);
        }
		
        req.end();
    }


/// Public
    checkAuthentication(callback) {
        this.httpsGetCall ('/api/bootstrap?version=0', function (err, res) {
            if (res && res.authentication && res.authentication.authenticated !== undefined) {
                return callback(res.authentication.authenticated, err);
            }
            if (err && !err.message.includes('no body')) {
                return callback(null, err);
            }
            callback(false, err);
        });
    }


    getDevices(callback) {
        this.httpsGet ('/api/devices-v2/device?cached=true&_=%t', callback);
    }

    getCards(limit, beforeCreationTime, callback) {
        if (typeof limit === 'function') {
            callback = limit;
            limit = 10;
        }
        if (typeof beforeCreationTime === 'function') {
            callback = beforeCreationTime;
            beforeCreationTime = '%t';
        }
        if (beforeCreationTime === undefined) beforeCreationTime = '%t';
        this.httpsGet (`/api/cards?limit=${limit}&beforeCreationTime=${beforeCreationTime}000&_=%t`, callback);
    }

    getMedia(serialOrName, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        this.httpsGet (`/api/media/state?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}&screenWidth=1392&_=%t`, callback);
    }

    getPlayerInfo(serialOrName, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        this.httpsGet (`/api/np/player?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}&screenWidth=1392&_=%t`, callback);
    }

    getLists(callback) {
        this.httpsGet ('/api/namedLists?_=%t', (err, res) => callback && callback(err, res && res.lists));
	}

    getList(listId, callback) {
        this.httpsGet ('/api/namedLists/' + listId + '?_=%t', callback);
	}
	
	/**
	 * Get items from a list.
	 *
	 * @param {String} listId List ID to retrieve items from
	 * @param {Object} [options] additional options to filter items
	 * @param {String} [options.startTime] filter items regarding start time
	 * @param {String} [options.endTime] filter items regarding end time
	 * @param {String} [options.completed] filter items regarding completion
	 * @param {String} [options.listIds] list IDs
	 *
	 */
    getListItems(listId, options, callback) {
		
        // get function params
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
		
		// get params by options
		let params = '';
		for (let option in options) {
			params += '&' + option + '=' + options[option];	
		}
		
		// send request
        this.httpsGet ('/api/namedLists/' + listId + '/items?_=%t' + params, (err, res) => callback && callback(err, res && res.list));
	}
	
	addListItem(listId, options, callback) {
		
        // get function params
        if (typeof options === 'string') {
            options = { 'value': options };
        }
		
		// request options
        let request = {
			'method': 'POST',
			'data': JSON.stringify({
				'listId': listId,
				'createdDateTime': new Date().getTime(),
				'completed': false,
				...options
			})
        };
		
		// send request
        this.httpsGet ('/api/namedLists/' + listId + '/item', callback, request);
	}
	
	updateListItem(listId, listItem, options, callback) {
		
		// providing a version is mandatory
		if (typeof options !== 'object' || !options.version || !options.value) {
			let errors = [];
			
			if (!options.version && callback) {
				errors.push('Providing the current version via options is mandatory!');
			}
			
			if (!options.value && callback) {
				errors.push('Providing a new value (description) via options is mandatory!');
			}
			
			callback && callback(errors);
			return false;
		}
		
		// request options
        let request = {
			'method': 'PUT',
			'data': JSON.stringify({
				'listId': listId,
				'id': listItem,
				'updatedDateTime': new Date().getTime(),
				...options
			})
        };
		
		// send request
        this.httpsGet ('/api/namedLists/' + listId + '/item/' + listItem, callback, request);
	}
	
	deleteListItem(listId, listItem, callback) {
		
		// data
		let data = JSON.stringify({
			'listId': listId,
			'id': listItem,
			'value': '' // must be provided, but value doesn't matter
		});
		
		// request options
        let request = {
			'method': 'DELETE',
			'data': data,
			'headers': {
				'Content-Type': 'application/json',
				'Content-Length': data.length
			}
        };
		
		// send request
        this.httpsGet ('/api/namedLists/' + listId + '/item/' + listItem, callback, request);
	}
	
    getWakeWords(callback) {
        this.httpsGet (`/api/wake-word?_=%t`, callback);
    }

    getReminders(cached, callback) {
        return this.getNotifications(cached, callback);
    }
    getNotifications(cached, callback) {
        if (typeof cached === 'function') {
            callback = cached;
            cached = true;
        }
        if (cached === undefined) cached = true;
        this.httpsGet (`/api/notifications?cached=${cached}&_=%t`, callback);
    }

    createNotificationObject(serialOrName, type, label, value, status, sound) { // type = Reminder, Alarm
        if (status && typeof status === 'object') {
            sound = status;
            status = 'ON';
        }
        if (value === null || value === undefined) {
            value = new Date().getTime() + 5000;
        }

        let dev = this.find(serialOrName);
        if (!dev) return null;

        const now = new Date();
        const notification = {
            'alarmTime': now.getTime(), // will be overwritten
            'createdDate': now.getTime(),
            'type': type, // Alarm ...
            'deviceSerialNumber': dev.serialNumber,
            'deviceType': dev.deviceType,
            'reminderLabel': label || null,
            'sound': sound || null,
            /*{
                'displayName': 'Countertop',
                'folder': null,
                'id': 'system_alerts_repetitive_04',
                'providerId': 'ECHO',
                'sampleUrl': 'https://s3.amazonaws.com/deeappservice.prod.notificationtones/system_alerts_repetitive_04.mp3'
            }*/
            'originalDate': `${now.getFullYear()}-${_00(now.getMonth() + 1)}-${_00(now.getDate())}`,
            'originalTime': `${_00(now.getHours())}:${_00(now.getMinutes())}:${_00(now.getSeconds())}.000`,
            'id': 'create' + type,

            'isRecurring' : false,
            'recurringPattern': null,

            'timeZoneId': null,
            'reminderIndex': null,

            'isSaveInFlight': true,

            'status': 'ON' // OFF
        };
        /*if (type === 'Timer') {
            notification.originalDate = null;
            notification.originalTime = null;
            notification.alarmTime = 0;
        }*/
        return this.parseValue4Notification(notification, value);
    }

    parseValue4Notification(notification, value) {
        switch (typeof value) {
            case 'object':
                notification = extend(notification, value); // we combine the objects
                /*
                {
                    'alarmTime': 0,
                    'createdDate': 1522585752734,
                    'deferredAtTime': null,
                    'deviceSerialNumber': 'G090LF09643202VS',
                    'deviceType': 'A3S5BH2HU6VAYF',
                    'geoLocationTriggerData': null,
                    'id': 'A3S5BH2HU6VAYF-G090LF09643202VS-17ef9b04-cb1d-31ed-ab2c-245705d904be',
                    'musicAlarmId': null,
                    'musicEntity': null,
                    'notificationIndex': '17ef9b04-cb1d-31ed-ab2c-245705d904be',
                    'originalDate': '2018-04-01',
                    'originalTime': '20:00:00.000',
                    'provider': null,
                    'recurringPattern': null,
                    'remainingTime': 0,
                    'reminderLabel': null,
                    'sound': {
                        'displayName': 'Countertop',
                        'folder': null,
                        'id': 'system_alerts_repetitive_04',
                        'providerId': 'ECHO',
                        'sampleUrl': 'https://s3.amazonaws.com/deeappservice.prod.notificationtones/system_alerts_repetitive_04.mp3'
                    },
                    'status': 'OFF',
                    'timeZoneId': null,
                    'timerLabel': null,
                    'triggerTime': 0,
                    'type': 'Alarm',
                    'version': '4'
                }
                */
                break;
            case 'number':
                if (notification.type !== 'Timer') {
                    value = new Date(value);
                    notification.alarmTime = value.getTime();
                    if (value.getTime() > new Date().getTime()) {
                        notification.originalDate = `${value.getFullYear()}-${_00(value.getMonth() + 1)}-${_00(value.getDate())}`;
                    }
                    notification.originalTime = `${_00 (value.getHours ())}:${_00 (value.getMinutes ())}:${_00 (value.getSeconds ())}.000`;
                }
                /*else {
                    //notification.remainingTime = value;
                }*/
                break;
            case 'date':
                if (notification.type !== 'Timer') {
                    notification.alarmTime = value.getTime();
                    notification.originalTime = `${_00 (value.getHours ())}:${_00 (value.getMinutes ())}:${_00 (value.getSeconds ())}.000`;
                }
                /*else {
                    let duration = value.getTime() - Date.now();
                    if (duration < 0) duration = value.getTime();
                    notification.remainingTime = duration;
                }*/
                break;
            case 'boolean':
                notification.status = value ? 'ON' : 'OFF';
                break;
            case 'string':
                let ar = value.split(':');
                if (notification.type !== 'Timer') {
                    let date = new Date(notification.alarmTime);
                    date.setHours(parseInt(ar[0], 10), ar.length>1 ? parseInt(ar[1], 10) : 0, ar.length > 2 ? parseInt(ar[2], 10) : 0);
                    notification.alarmTime = date.getTime();
                    notification.originalTime = `${_00(date.getHours())}:${_00(date.getMinutes())}:${_00(date.getSeconds())}.000`;
                }
                /*else {
                    let duration = 0;
                    let multi = 1;
                    for (let i = ar.length -1; i > 0; i--) {
                        duration += ar[i] * multi;
                        multi *= 60;
                    }
                    notification.remainingTime = duration;
                }*/
                break;
        }

        const originalDateTime = notification.originalDate + ' ' + notification.originalTime;
        const bits = originalDateTime.split(/\D/);
        let date = new Date(bits[0], --bits[1], bits[2], bits[3], bits[4], bits[5]);
        if (date.getTime() < Date.now()) {
            date = new Date(date.getTime() + 24 * 60 * 60 * 1000);
            notification.originalDate =  `${date.getFullYear()}-${_00(date.getMonth() + 1)}-${_00(date.getDate())}`;
            notification.originalTime = `${_00(date.getHours())}:${_00(date.getMinutes())}:${_00(date.getSeconds())}.000`;
        }

        return notification;
    }

    createNotification(notification, callback) {
        let flags = {
            data: JSON.stringify(notification),
            method: 'PUT'
        };
        this.httpsGet (`/api/notifications/createReminder`, function(err, res) {
                //  {'Message':null}
                callback && callback(err, res);
            },
            flags
        );
    }

    changeNotification(notification, value, callback) {
        notification = this.parseValue4Notification(notification, value);
        let flags = {
            data: JSON.stringify(notification),
            method: 'PUT'
        };
        this.httpsGet (`/api/notifications/${notification.id}`, function(err, res) {
                //  {'Message':null}
                callback && callback(err, res);
            },
            flags
        );
    }

    deleteNotification(notification, callback) {
        let flags = {
            data: JSON.stringify (notification),
            method: 'DELETE'
        };
        this.httpsGet (`/api/notifications/${notification.id}`, function(err, res) {
                //  {'Message':null}
                callback && callback(err, res);
            },
            flags
        );
    }

    getDoNotDisturb(callback) {
        return this.getDeviceStatusList(callback);
    }
    getDeviceStatusList(callback) {
        this.httpsGet (`/api/dnd/device-status-list?_=%t`, callback);
    }

    // alarm volume
    getDeviceNotificationState(serialOrName, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        this.httpsGet (`/api/device-notification-state/${dev.deviceType}/${dev.softwareVersion}/${dev.serialNumber}&_=%t`, callback);
    }

    getBluetooth(cached, callback) {
        if (typeof cached === 'function') {
            callback = cached;
            cached = true;
        }
        if (cached === undefined) cached = true;
        this.httpsGet (`/api/bluetooth?cached=${cached}&_=%t`, callback);
    }

    tuneinSearchRaw(query, callback) {
        this.httpsGet (`/api/tunein/search?query=${query}&mediaOwnerCustomerId=${this.ownerCustomerId}&_=%t`, callback);
    }

    tuneinSearch(query, callback) {
        query = querystring.escape(query);
        this.tuneinSearchRaw(query, callback);
    }

    setTunein(serialOrName, guideId, contentType, callback) {
        if (typeof contentType === 'function') {
            callback = contentType;
            contentType = 'station';
        }
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        this.httpsGet (`/api/tunein/queue-and-play
           ?deviceSerialNumber=${dev.serialNumber}
           &deviceType=${dev.deviceType}
           &guideId=${guideId}
           &contentType=${contentType}
           &callSign=
           &mediaOwnerCustomerId=${dev.deviceOwnerCustomerId}`,
            callback,
            { method: 'POST' });
    }

    getHistory(options, callback) {
        return this.getActivities(options, callback);
    }
    getActivities(options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        this.httpsGet (`/api/activities` +
            `?startTime=${options.startTime || ''}` +
            `&size=${options.size || 1}` +
            `&offset=${options.offset || 1}`,
            (err, result) => {
                if (err || !result) return callback/*.length >= 2*/ && callback(err, result);

                let ret = [];
                if (result.activities) {
                    for (let r = 0; r < result.activities.length; r++) {
                        let res = result.activities[r];
                        let o = {
                            data: res
                        };
                        try {
                            o.description = JSON.parse(res.description);
                        } catch (e) {
                            if (res.description) {
                                o.description = {'summary': res.description};
                            } else {
                                return;
                            }
                        }
                        if (!o.description) continue;
                        o.description.summary = (o.description.summary || '').trim();
                        if (options.filter) {
                            switch (o.description.summary) {
                                case 'stopp':
                                case 'alexa':
                                case 'echo':
                                case 'computer':
                                case 'amazon':
                                case ',':
                                case '':
                                    continue;
                            }
                        }
                        for (let i = 0; i < res.sourceDeviceIds.length; i++) {
                            o.deviceSerialNumber = res.sourceDeviceIds[i].serialNumber;
                            if (!this.serialNumbers[o.deviceSerialNumber]) continue;
                            o.name = this.serialNumbers[o.deviceSerialNumber].accountName;
                            const dev = this.find(o.deviceSerialNumber);
                            let wakeWord = (dev && dev.wakeWord) ? dev.wakeWord : null;
                            if (wakeWord && o.description.summary.startsWith(wakeWord)) {
                                o.description.summary = o.description.summary.substr(wakeWord.length).trim();
                            }
                            o.deviceType = res.sourceDeviceIds[i].deviceType || null;
                            o.deviceAccountId = res.sourceDeviceIds[i].deviceAccountId || null;

                            o.creationTimestamp = res.creationTimestamp || null;
                            o.activityStatus = res.activityStatus || null; // DISCARDED_NON_DEVICE_DIRECTED_INTENT, SUCCESS, FAIL, SYSTEM_ABANDONED
                            try {
                                o.domainAttributes = res.domainAttributes ? JSON.parse(res.domainAttributes) : null;
                            } catch (e) {
                                o.domainAttributes = res.domainAttributes || null;
                            }
                            if (o.description.summary || !options.filter) ret.push(o);
                        }
                    }
                }
                if (typeof callback === 'function') return callback (err, ret);
            }
        );
    }

    getAccount(callback) {
        this.httpsGet (`https://alexa-comms-mobile-service.${this._options.amazonPage}/accounts`, callback);
    }

    getContacts(options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = undefined;
        }
        if (options === undefined) options = {};
        if (options.includePreferencesByLevel === undefined) options.includePreferencesByLevel = 'HomeGroup';
        if (options.includeNonAlexaContacts === undefined) options.includeNonAlexaContacts = true;
        if (options.includeHomeGroupMembers === undefined) options.includeHomeGroupMembers = true;
        if (options.bulkImportOnly === undefined) options.bulkImportOnly = false;
        if (options.includeBlockStatus === undefined) options.includeBlockStatus = false;
        if (options.dedupeMode === undefined) options.dedupeMode = 'RemoveCloudOnlyContactDuplicates';
        if (options.homeGroupId === undefined) options.homeGroupId = '';

        this.httpsGet (
            `https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/contacts
            ?includePreferencesByLevel=${options.includePreferencesByLevel}
            &includeNonAlexaContacts=${options.includeNonAlexaContacts}
            &includeHomeGroupMembers=${options.includeHomeGroupMembers}
            &bulkImportOnly=${options.bulkImportOnly}
            &includeBlockStatus=${options.includeBlockStatus}
            &dedupeMode=${options.dedupeMode}
            &homeGroupId=${options.homeGroupId}`,
            function (err, result) {
                callback (err, result);
            });
    }

    getConversations(options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = undefined;
        }
        if (options === undefined) options = {};
        if (options.latest === undefined) options.latest = true;
        if (options.includeHomegroup === undefined) options.includeHomegroup = true;
        if (options.unread === undefined) options.unread = false;
        if (options.modifiedSinceDate === undefined) options.modifiedSinceDate = '1970-01-01T00:00:00.000Z';
        if (options.includeUserName === undefined) options.includeUserName = true;

        this.httpsGet (
            `https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/conversations
            ?latest=${options.latest}
            &includeHomegroup=${options.includeHomegroup}
            &unread=${options.unread}
            &modifiedSinceDate=${options.modifiedSinceDate}
            &includeUserName=${options.includeUserName}`,
            function (err, result) {
                callback (err, result);
            });
    }

    connectBluetooth(serialOrName, btAddress, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        let flags = {
            data: JSON.stringify({ bluetoothDeviceAddress: btAddress}),
            method: 'POST'
        };
        this.httpsGet (`/api/bluetooth/pair-sink/${dev.deviceType}/${dev.serialNumber}`, callback, flags);
    }

    disconnectBluetooth(serialOrName, btAddress, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        let flags = {
            //data: JSON.stringify({ bluetoothDeviceAddress: btAddress}),
            method: 'POST'
        };
        this.httpsGet (`/api/bluetooth/disconnect-sink/${dev.deviceType}/${dev.serialNumber}`, callback, flags);
    }

    setDoNotDisturb(serialOrName, enabled, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        let flags = {
            data: JSON.stringify({
                deviceSerialNumber: dev.serialNumber,
                deviceType: dev.deviceType,
                enabled: enabled
            }),
            method: 'PUT'
        };
        this.httpsGet (`/api/dnd/status`, callback, flags);
    }

    find(serialOrName, callback) {
        if (typeof serialOrName === 'object') return serialOrName;
        if (!serialOrName) return null;
        let dev = this.serialNumbers[serialOrName];
        if (dev !== undefined) return dev;
        dev = this.names[serialOrName];
        if (!dev && typeof serialOrName === 'string') dev = this.names [serialOrName.toLowerCase()];
        if (!dev) dev = this.friendlyNames[serialOrName];
        return dev;
    }

    setAlarmVolume(serialOrName, volume, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        let flags = {
            data: JSON.stringify ({
                deviceSerialNumber: dev.serialNumber,
                deviceType: dev.deviceType,
                softwareVersion: dev.softwareVersion,
                volumeLevel: volume
            }),
            method: 'PUT'
        };
        this.httpsGet (`/api/device-notification-state/${dev.deviceType}/${dev.softwareVersion}/${dev.serialNumber}`, callback, flags);
    }

    sendCommand(serialOrName, command, value, callback) {
        return this.sendMessage(serialOrName, command, value, callback);
    }
    sendMessage(serialOrName, command, value, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        const commandObj = { contentFocusClientId: null };
        switch (command) {
            case 'play':
            case 'pause':
            case 'next':
            case 'previous':
            case 'forward':
            case 'rewind':
                commandObj.type = command.substr(0, 1).toUpperCase() + command.substr(1) + 'Command';
                break;
            case 'volume':
                commandObj.type = 'VolumeLevelCommand';
                commandObj.volumeLevel = ~~value;
                if (commandObj.volumeLevel < 0 || commandObj.volumeLevel > 100) {
                    return callback(new Error('Volume needs to be between 0 and 100'));
                }
                break;
            case 'shuffle':
                commandObj.type = 'ShuffleCommand';
                commandObj.shuffle = (value === 'on' || value === true);
                break;
            case 'repeat':
                commandObj.type = 'RepeatCommand';
                commandObj.repeat = (value === 'on' || value === true);
                break;
            default:
                return;
        }

        this.httpsGet (`/api/np/command?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}`,
            callback,
            {
                method: 'POST',
                data: JSON.stringify(commandObj)
            }
        );
    }

    createSequenceNode(command, value, serialOrName, callback) {
        if (typeof serialOrName === 'function') {
            callback = serialOrName;
            serialOrName = undefined;
        }
        let deviceSerialNumber = 'ALEXA_CURRENT_DSN';
        let deviceType= 'ALEXA_CURRENT_DEVICE_TYPE';
        if (serialOrName && !Array.isArray(serialOrName)) {
            const currDevice = this.find(serialOrName);
            deviceSerialNumber = currDevice.serialNumber;
            deviceType = currDevice.deviceType;
        }
        const seqNode = {
            '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
            'operationPayload': {
                'deviceType': deviceType,
                'deviceSerialNumber': deviceSerialNumber,
                'locale': 'ALEXA_CURRENT_LOCALE',
                'customerId':'ALEXA_CUSTOMER_ID'
            }
        };
        switch (command) {
            case 'weather':
                seqNode.type = 'Alexa.Weather.Play';
                break;
            case 'traffic':
                seqNode.type = 'Alexa.Traffic.Play';
                break;
            case 'flashbriefing':
                seqNode.type = 'Alexa.FlashBriefing.Play';
                break;
            case 'goodmorning':
                seqNode.type = 'Alexa.GoodMorning.Play';
                break;
            case 'singasong':
                seqNode.type = 'Alexa.SingASong.Play';
                break;
            case 'tellstory':
                seqNode.type = 'Alexa.TellStory.Play';
                break;
            case 'calendarToday':
                seqNode.type = 'Alexa.Calendar.PlayToday';
                break;
            case 'calendarTomorrow':
                seqNode.type = 'Alexa.Calendar.PlayTomorrow';
                break;
            case 'calendarNext':
                seqNode.type = 'Alexa.Calendar.PlayNext';
                break;
            case 'volume':
                seqNode.type = 'Alexa.DeviceControls.Volume';
                value = ~~value;
                if (value < 0 || value > 100) {
                    return callback(new Error('Volume needs to be between 0 and 100'));
                }
                seqNode.operationPayload.value = value;
                break;
            case 'deviceStop':
                seqNode.type = 'Alexa.DeviceControls.Stop';
                seqNode.operationPayload.devices = [
                    {
                        "deviceSerialNumber": deviceSerialNumber,
                        "deviceType": deviceType
                    }
                ];
                seqNode.operationPayload.isAssociatedDevice = false;
                delete seqNode.operationPayload.deviceType;
                delete seqNode.operationPayload.deviceSerialNumber;
                delete seqNode.operationPayload.locale;
                break;
            case 'speak':
                seqNode.type = 'Alexa.Speak';
                if (typeof value !== 'string') value = String(value);
                if (!this._options.amazonPage || !this._options.amazonPage.endsWith('.com')) {
                    value = value.replace(/([^0-9]?[0-9]+)\.([0-9]+[^0-9])?/g, '$1,$2');
                }
                /*value = value
                    .replace(/Â|À|Å|Ã/g, 'A')
                    .replace(/á|â|à|å|ã/g, 'a')
                    .replace(/Ä/g, 'Ae')
                    .replace(/ä/g, 'ae')
                    .replace(/Ç/g, 'C')
                    .replace(/ç/g, 'c')
                    .replace(/É|Ê|È|Ë/g, 'E')
                    .replace(/é|ê|è|ë/g, 'e')
                    .replace(/Ó|Ô|Ò|Õ|Ø/g, 'O')
                    .replace(/ó|ô|ò|õ/g, 'o')
                    .replace(/Ö/g, 'Oe')
                    .replace(/ö/g, 'oe')
                    .replace(/Š/g, 'S')
                    .replace(/š/g, 's')
                    .replace(/ß/g, 'ss')
                    .replace(/Ú|Û|Ù/g, 'U')
                    .replace(/ú|û|ù/g, 'u')
                    .replace(/Ü/g, 'Ue')
                    .replace(/ü/g, 'ue')
                    .replace(/Ý|Ÿ/g, 'Y')
                    .replace(/ý|ÿ/g, 'y')
                    .replace(/Ž/g, 'Z')
                    .replace(/ž/, 'z')
                    .replace(/&/, 'und')
                    .replace(/[^-a-zA-Z0-9_,.?! ]/g,'')
                    .replace(/ /g,'_');*/
                value = value.replace(/[ ]+/g, ' ');
                if (value.length === 0) {
                    return callback && callback(new Error('Can not speak empty string', null));
                }
                if (value.length > 250) {
                    return callback && callback(new Error('text too long, limit are 250 characters', null));
                }
                seqNode.operationPayload.textToSpeak = value;
                break;
            case 'notification':
                seqNode.type = 'Alexa.Notifications.SendMobilePush';
                if (typeof value !== 'string') value = String(value);
                if (value.length === 0) {
                    return callback && callback(new Error('Can not notify empty string', null));
                }
                seqNode.operationPayload.notificationMessage = value;
                seqNode.operationPayload.alexaUrl = '#v2/behaviors';
                seqNode.operationPayload.title = 'ioBroker';
                delete seqNode.operationPayload.deviceType;
                delete seqNode.operationPayload.deviceSerialNumber;
                delete seqNode.operationPayload.locale;
                break;
            case 'announcement':
            case 'ssml':
                seqNode.type = 'AlexaAnnouncement';
                if (typeof value !== 'string') value = String(value);
                if (command === 'announcement') {
                    if (!this._options.amazonPage || !this._options.amazonPage.endsWith('.com')) {
                        value = value.replace(/([^0-9]?[0-9]+)\.([0-9]+[^0-9])?/g, '$1,$2');
                    }
                    value = value.replace(/[ ]+/g, ' ');
                    if (value.length === 0) {
                        return callback && callback(new Error('Can not speak empty string', null));
                    }
                }
                else if (command === 'ssml') {
                    if (!value.startsWith('<speak>')) {
                        return callback && callback(new Error('Value needs to be a valid SSML XML string', null));
                    }
                }
                seqNode.operationPayload.expireAfter = 'PT5S';
                seqNode.operationPayload.content = [
                    {
                        "locale": "de-DE",
                        "display": {
                            "title": "ioBroker",
                            "body": value.replace(/<[^>]+>/g, '')
                        },
                        "speak": {
                            "type": (command === 'ssml') ? 'ssml' : 'text',
                            "value": value
                        }
                    }
                ];
                seqNode.operationPayload.target = {
                    "customerId": "ALEXA_CUSTOMER_ID",
                    "devices": [
                        {
                            "deviceSerialNumber": deviceSerialNumber,
                            "deviceTypeId": deviceType
                        }
                    ]
                };
                if (serialOrName && Array.isArray(serialOrName)) {
                    seqNode.operationPayload.target.devices = [];
                    serialOrName.forEach((deviceId) => {
                        const currDevice = this.find(deviceId);
                        if (!currDevice) return;
                        seqNode.operationPayload.target.devices.push({
                            "deviceSerialNumber": currDevice.serialNumber,
                            "deviceTypeId": currDevice.deviceType
                        });
                    });
                }

                delete seqNode.operationPayload.deviceType;
                delete seqNode.operationPayload.deviceSerialNumber;
                delete seqNode.operationPayload.locale;
                break;
            default:
                return;
        }
        return seqNode;
    }

    sendMultiSequenceCommand(serialOrName, commands, sequenceType, callback) {
        if (typeof sequenceType === 'function') {
            callback = sequenceType;
            sequenceType = null;
        }
        if (!sequenceType) sequenceType = 'SerialNode'; // or ParallelNode

        let nodes = [];
        for (let command of commands) {
            const commandNode = this.createSequenceNode(command.command, command.value, command.device ? command.device : serialOrName, callback);
            if (commandNode) nodes.push(commandNode);
        }

        const sequenceObj = {
            'sequence': {
                '@type': 'com.amazon.alexa.behaviors.model.Sequence',
                'startNode': {
                    '@type': 'com.amazon.alexa.behaviors.model.' + sequenceType,
                    'name': null,
                    'nodesToExecute': nodes
                }
            }
        };

        this.sendSequenceCommand(serialOrName, sequenceObj, callback);
    }

    sendSequenceCommand(serialOrName, command, value, callback) {
        let dev = this.find(Array.isArray(serialOrName) ? serialOrName[0] : serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        if (typeof value === 'function') {
            callback = value;
            value = null;
        }

        let seqCommandObj;
        if (typeof command === 'object') {
            seqCommandObj = command.sequence || command;
        }
        else {
            seqCommandObj = {
                '@type': 'com.amazon.alexa.behaviors.model.Sequence',
                'startNode': this.createSequenceNode(command, value)
            };
        }

        const reqObj = {
            'behaviorId': seqCommandObj.sequenceId ? command.automationId : 'PREVIEW',
            'sequenceJson': JSON.stringify(seqCommandObj),
            'status': 'ENABLED'
        };
        reqObj.sequenceJson = reqObj.sequenceJson.replace(/"deviceType":"ALEXA_CURRENT_DEVICE_TYPE"/g, `"deviceType":"${dev.deviceType}"`);
        reqObj.sequenceJson = reqObj.sequenceJson.replace(/"deviceTypeId":"ALEXA_CURRENT_DEVICE_TYPE"/g, `"deviceTypeId":"${dev.deviceType}"`);
        reqObj.sequenceJson = reqObj.sequenceJson.replace(/"deviceSerialNumber":"ALEXA_CURRENT_DSN"/g, `"deviceSerialNumber":"${dev.serialNumber}"`);
        reqObj.sequenceJson = reqObj.sequenceJson.replace(/"customerId":"ALEXA_CUSTOMER_ID"/g, `"customerId":"${dev.deviceOwnerCustomerId}"`);
        reqObj.sequenceJson = reqObj.sequenceJson.replace(/"locale":"ALEXA_CURRENT_LOCALE"/g, `"locale":"de-DE"`);

        this.httpsGet (`/api/behaviors/preview`,
            callback,
            {
                method: 'POST',
                data: JSON.stringify(reqObj)
            }
        );
    }

    getAutomationRoutines(limit, callback) {
        if (typeof limit === 'function') {
            callback = limit;
            limit = 0;
        }
        limit = limit || 2000;
        this.httpsGet (`/api/behaviors/automations?limit=${limit}`, callback);
    }

    executeAutomationRoutine(serialOrName, routine, callback) {
        return this.sendSequenceCommand(serialOrName, routine, callback);
    }

    getMusicProviders(callback) {
        this.httpsGet ('/api/behaviors/entities?skillId=amzn1.ask.1p.music',
            callback,
            {
                headers: {
                    'Routines-Version': '1.1.210292'
                }
            }
        );
    }

    playMusicProvider(serialOrName, providerId, searchPhrase, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));
        if (searchPhrase === '') return callback && callback(new Error ('Searchphrase empty', null));

        const operationPayload = {
            'deviceType': dev.deviceType,
            'deviceSerialNumber': dev.serialNumber,
            'locale': 'de-DE', // TODO!!
            'customerId': dev.deviceOwnerCustomerId,
            'musicProviderId': providerId,
            'searchPhrase': searchPhrase
        };

        const validateObj = {
            'type': 'Alexa.Music.PlaySearchPhrase',
            'operationPayload': JSON.stringify(operationPayload)
        };

        this.httpsGet (`/api/behaviors/operation/validate`,
            (err, res) => {
                if (err) {
                    return callback && callback(err, res);
                }
                if (res.result !== 'VALID') {
                    return callback && callback(new Error('Request invalid'), res);
                }
                validateObj.operationPayload = res.operationPayload;

                const seqCommandObj = {
                    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
                    'startNode': validateObj
                };
                seqCommandObj.startNode['@type'] = 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode';

                return this.sendSequenceCommand(serialOrName, seqCommandObj, callback);
            },
            {
                method: 'POST',
                data: JSON.stringify(validateObj)
            }
        );
    }

    sendTextMessage(conversationId, text, callback) {
        // [{
        // 	"conversationId": "amzn1.comms.messaging.id.conversationV2~e48ea7a9-b358-44fa-9be4-e45ae6a37c6a",
        // 	"clientMessageId": "36772d6a-c2ba-4294-955f-afc3336a444c",
        // 	"messageId": 1.001,
        // 	"time": "2019-07-18T21:32:26.863Z",
        // 	"sender": "amzn1.comms.id.person.amzn1~amzn1.account.AEQ4CW5IVBICJ5PQNYI5RYKBSDXQ",
        // 	"type": "message/text",
        // 	"payload": {
        // 		"text": "Test atest"
        // 	},
        // 	"status": 1
        // }]

        let message = [{
            conversationId: 'amzn1.comms.messaging.id.conversationV2~' + uuidv1(),
            clientMessageId: uuidv1(),
            messageId: 0.001,
            time: new Date().toISOString(),
            sender: this.commsId,
            type: 'message/text',
            payload: {
                text: text
            },
            status: 1
        }];

        this.httpsGet(`https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/conversations/${conversationId}/messages`,
            callback,
            {
                method: 'POST',
                data: JSON.stringify (message)
            }
        );
    }

    deleteConversation(conversationId, callback) {
        let flags = {
            method: 'DELETE'
        };
        this.httpsGet (`https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/conversations/${conversationId}`, callback, flags);
    }

    setReminder(serialOrName, timestamp, label, callback) {
        const notification = this.createNotificationObject(serialOrName, 'Reminder', label, new Date(timestamp));
        this.createNotification(notification, callback);
    }

    getHomeGroup(callback) {
        this.httpsGet (`https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/identities?includeUserName=true`, callback);
    }

    getDevicePreferences(callback) {
        this.httpsGet ('/api/device-preferences?cached=true&_=%t', callback);
    }

    getSmarthomeDevices(callback) {
        this.httpsGet ('/api/phoenix?_=%t', function (err, res) {
            if (err || !res || !res.networkDetail) return callback(err, res);
            try {
                res = JSON.parse(res.networkDetail);
            } catch(e) {
                return callback('invalid JSON');
            }
            if (!res.locationDetails) return callback('locationDetails not found');
            callback (err, res.locationDetails);
        });
    }

    getSmarthomeGroups(callback) {
        this.httpsGet ('/api/phoenix/group?_=%t', callback);
    }

    getSmarthomeEntities(callback) {
        this.httpsGet ('/api/behaviors/entities?skillId=amzn1.ask.1p.smarthome',
            callback,
            {
                headers: {
                    'Routines-Version': '1.1.210292'
                }
            }
        );
    }

    getSmarthomeBehaviourActionDefinitions(callback) {
        this.httpsGet ('/api/behaviors/actionDefinitions?skillId=amzn1.ask.1p.smarthome',
            callback,
            {
                headers: {
                    'Routines-Version': '1.1.210292'
                }
            }
        );
    }


    renameDevice(serialOrName, newName, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        let o = {
            accountName: newName,
            serialNumber: dev.serialNumber,
            deviceAccountId: dev.deviceAccountId,
            deviceType: dev.deviceType,
            //deviceOwnerCustomerId: oo.deviceOwnerCustomerId
        };
        this.httpsGet (`/api/devices-v2/device/${dev.serialNumber}`,
            callback,
            {
                method: 'PUT',
                data: JSON.stringify (o),
            }
        );
    }

    deleteSmarthomeDevice(smarthomeDevice, callback) {
        let flags = {
            method: 'DELETE'
            //data: JSON.stringify (o),
        };
        this.httpsGet (`/api/phoenix/appliance/${smarthomeDevice}`, callback, flags);
    }

    deleteSmarthomeGroup(smarthomeGroup, callback) {
        let flags = {
            method: 'DELETE'
            //data: JSON.stringify (o),
        };
        this.httpsGet (`/api/phoenix/group/${smarthomeGroup}`, callback, flags);
    }

    deleteAllSmarthomeDevices(callback) {
        let flags = {
            method: 'DELETE'
            //data: JSON.stringify (o),
        };
        this.httpsGet (`/api/phoenix`, callback, flags);
    }

    discoverSmarthomeDevice(callback) {
        let flags = {
            method: 'POST'
            //data: JSON.stringify (o),
        };
        this.httpsGet ('/api/phoenix/discovery', callback, flags);
    }

    querySmarthomeDevices(applicanceIds, entityType, callback) {
        if (typeof entityType === 'function') {
            callback = entityType;
            entityType = 'APPLIANCE'; // other value 'GROUP'
        }

        let reqArr = [];
        if (!Array.isArray(applicanceIds)) applicanceIds = [applicanceIds];
        for (let id of applicanceIds) {
            reqArr.push({
                'entityId': id,
                'entityType': entityType
            });
        }

        let flags = {
            method: 'POST',
            data: JSON.stringify ({
                'stateRequests': reqArr
            })
        };
        this.httpsGet (`/api/phoenix/state`, callback, flags);
        /*
        {
            'stateRequests': [
                {
                    'entityId': 'AAA_SonarCloudService_00:17:88:01:04:1D:4C:A0',
                    'entityType': 'APPLIANCE'
                }
            ]
        }
        {
        	'deviceStates': [],
        	'errors': [{
        		'code': 'ENDPOINT_UNREACHABLE',
        		'data': null,
        		'entity': {
        			'entityId': 'AAA_SonarCloudService_00:17:88:01:04:1D:4C:A0',
        			'entityType': ''
        		},
        		'message': null
        	}]
        }
        */
    }

    executeSmarthomeDeviceAction(entityIds, parameters, entityType, callback) {
        if (typeof entityType === 'function') {
            callback = entityType;
            entityType = 'APPLIANCE'; // other value 'GROUP'
        }

        let reqArr = [];
        if (!Array.isArray(entityIds)) entityIds = [entityIds];
        for (let id of entityIds) {
            reqArr.push({
                'entityId': id,
                'entityType': entityType,
                'parameters': parameters
            });
        }

        let flags = {
            method: 'PUT',
            data: JSON.stringify ({
                'controlRequests': reqArr
            })
        };
        this.httpsGet (`/api/phoenix/state`, callback, flags);
        /*
        {
            'controlRequests': [
                {
                    'entityId': 'bbd72582-4b16-4d1f-ab1b-28a9826b6799',
                    'entityType':'APPLIANCE',
                    'parameters':{
                        'action':'turnOn'
                    }
                }
            ]
        }
        {
        	'controlResponses': [],
        	'errors': [{
        		'code': 'ENDPOINT_UNREACHABLE',
        		'data': null,
        		'entity': {
        			'entityId': 'bbd72582-4b16-4d1f-ab1b-28a9826b6799',
        			'entityType': 'APPLIANCE'
        		},
        		'message': null
        	}]
        }
        */
    }


    unpaireBluetooth(serialOrName, btAddress, callback) {
        let dev = this.find(serialOrName);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        let flags = {
            method: 'POST',
            data: JSON.stringify ({
                bluetoothDeviceAddress: btAddress,
                bluetoothDeviceClass: 'OTHER'
            })
        };
        this.httpsGet (`/api/bluetooth/unpair-sink/${dev.deviceType}/${dev.serialNumber}`, callback, flags);
    }

    deleteDevice(serialOrName, callback) {
        let dev = this.find(serialOrName, callback);
        if (!dev) return callback && callback(new Error ('Unknown Device or Serial number', null));

        let flags = {
            method: 'DELETE',
            data: JSON.stringify ({
                deviceType: dev.deviceType
            })
        };
        this.httpsGet (`/api/devices/device/${dev.serialNumber}?deviceType=${dev.deviceType}`, callback, flags);
    }
}

module.exports = AlexaRemote;
