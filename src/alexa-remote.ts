import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import * as querystring from 'node:querystring';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';
import * as fsPath from 'node:path';
import { EventEmitter } from 'node:events';
import extend from 'extend';
// import AlexaWsMqtt from './alexa-wsmqtt';
import AlexaHttp2Push from './alexa-http2push';
/* eslint-disable import/no-duplicates */
// namespace import is used to re-export all types via 'declare namespace AlexaRemote' below
import type * as Types from './types';
import type * as Responses from './responses';
import type {
    AscendingAlarmState,
    AuthTokenResponse,
    AutomationRoutine,
    BluetoothResponse,
    CommsAccount,
    CommsIdentity,
    CustomerHistoryEntry,
    Contact,
    DefaultNotificationSoundResponse,
    DeviceNotificationState,
    DevicePreferences,
    DevicePreferencesResponse,
    DeviceVolumesResponse,
    DeviceWifiDetails,
    DevicesResponse,
    DoNotDisturbStatusResponse,
    EqualizerEnabledResponse,
    EqualizerRangeResponse,
    EqualizerSettingsResponse,
    ListItemV2,
    ListV2,
    MusicProvider,
    NotificationSoundsResponse,
    NotificationsResponse,
    RoutineSkillCatalogResponse,
    WakeWordsResponse,
} from './responses';
import type {
    AlexaCookie,
    AlexaRemoteOptions,
    AuthenticationCallback,
    CallbackWithError,
    CallbackWithErrorAndBody,
    EntityType,
    Endpoints,
    GetAuthenticationDetails,
    GetContactsOptions,
    GetConversationsOptions,
    GetCustomerHistoryRecordsOptions,
    HttpsGetFlags,
    InitOptions,
    ListItemOptions,
    MacDms,
    MessageCommands,
    MultiSequenceCommand,
    Notification,
    NotificationRecurrence,
    NotificationV2,
    Serial,
    SerialOrName,
    SerialOrNameOrArray,
    SequenceCommandObject,
    SequenceNode,
    SequenceNodeCommand,
    SequenceNodeDetails,
    SequenceNodeStructure,
    SequenceType,
    SmartHomeDeviceQueryEntry,
    Sound,
    Status,
    Value,
} from './types';
/* eslint-enable import/no-duplicates */

/** User agent of the official Alexa iOS app, used for all API requests */
const officialUserAgent =
    'AppleWebKit PitanguiBridge/2.2.595606.0-[HARDWARE=iPhone14_7][SOFTWARE=17.4.1][DEVICE=iPhone]';

/**
 * Browser user agent for the notifications API (`/api/notifications*`):
 * Amazon answers requests with the app user agent there with "400 ThrottlingException".
 */
const notificationsUserAgent =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';

/**
 * Pads a number with a leading zero to two digits (e.g. for dates and times).
 *
 * @param val number to pad
 * @returns padded number as string
 */
const _00 = (val: number): string => {
    let s = val.toString();
    while (s.length < 2) {
        s = `0${s}`;
    }
    return s;
};

/** GraphQL query for all smart home endpoints including the data of the old (phoenix) API */
const SmartHomeEndpointsGraphQlQuery = `query Endpoints {
  endpoints {
    items {
      endpointId
      id
      friendlyName
      displayCategories {
        primary {
          value
        }
      }
      legacyIdentifiers {
          dmsIdentifier {
              deviceType {
                  type
                  value {
                      text
                  }
              }
              deviceSerialNumber {
                  type
                  value {
                      text
                  }
              }
          }
      }
      legacyAppliance {
        applianceId
        applianceTypes
        endpointTypeId
        friendlyName
        friendlyDescription
        manufacturerName
        connectedVia
        modelName
        entityId
        actions
        mergedApplianceIds
        capabilities
        applianceNetworkState
        version
        isEnabled
        customerDefinedDeviceType
        customerPreference
        alexaDeviceIdentifierList
        aliases
        driverIdentity
        additionalApplianceDetails
        isConsentRequired
        applianceKey
        appliancePairs
        deduplicatedPairs
        entityPairs
        deduplicatedAliasesByEntityId
        relations
      }
      serialNumber {
        value {
          text
        }
      }
      enablement
      model {
        value {
          text
        }
      }
      manufacturer {
        value {
          text
        }
      }
      features {
        name
        operations {
          name
        }
      }
    }
  }
}
`;

/** Week days in the iCalendar notation used by the Alexa API (Monday first) */
const WEEK_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/**
 * Extracts the recurrence of an (old style) notification in the format of the V2 Alexa API.
 * The recurrence rule data is preferred; if it is not available, the recurring pattern
 * (e.g. "P1D", "XXXX-WD", "XXXX-WE" or "XXXX-WXX-1") is converted.
 *
 * @param notification notification as returned by `getNotifications()`
 * @returns the recurrence or undefined if the notification is not recurring
 */
const getNotificationRecurrence = (notification: Notification): NotificationRecurrence | undefined => {
    const rule = notification.rRuleData;
    if (rule?.frequency) {
        const recurrence: NotificationRecurrence = { freq: rule.frequency, interval: rule.intervals?.[0] || 1 };
        if (rule.byWeekDays?.length) {
            recurrence.byDay = rule.byWeekDays;
        }
        if (rule.byMonths?.length) {
            recurrence.byMonth = rule.byMonths;
        }
        return recurrence;
    }

    const pattern = notification.recurringPattern;
    if (pattern === 'P1D') {
        return { freq: 'DAILY', interval: 1 };
    }
    if (pattern === 'XXXX-WD') {
        // working days
        return { freq: 'WEEKLY', byDay: WEEK_DAYS.slice(0, 5), interval: 1 };
    }
    if (pattern === 'XXXX-WE') {
        // weekend
        return { freq: 'WEEKLY', byDay: WEEK_DAYS.slice(5), interval: 1 };
    }
    // single week day: 1 = Monday ... 7 = Sunday
    const day = pattern?.match(/^XXXX-WXX-([1-7])$/);
    if (day) {
        return { freq: 'WEEKLY', byDay: [WEEK_DAYS[Number(day[1]) - 1]], interval: 1 };
    }
    return undefined;
};

/**
 * Remote control for Amazon Echo (Alexa) devices via the (unofficial) Alexa web and app APIs.
 *
 * Usage: create an instance, call `init()` with the options and use the methods afterwards.
 * Most methods follow the Node.js callback style `(error, result)`.
 *
 * Emitted events (selection):
 * - `cookie` (cookie, csrf, macDms): a new cookie was generated or refreshed and should be stored
 * - `ws-connect`, `ws-disconnect`, `ws-error`: state of the push connection
 * - `ws-device-activity`, `ws-volume-change`, `ws-media-change`, `ws-notification-change`, ...: push events
 * - `command`: every raw push command
 */
class AlexaRemote extends EventEmitter {
    /** All known devices by serial number */
    serialNumbers: Record<string, Serial>;
    /** All known devices by account name (original and lower case, also with friendly name suffix) */
    names: Record<string, Serial>;
    /** All known devices by device type friendly name */
    friendlyNames: Record<string, Serial>;
    /** Timestamp of the last successful authentication check */
    lastAuthCheck: number | null;
    /** Cookie used for the website API calls */
    cookie: string | null;
    /** CSRF token (extracted from the cookie) */
    csrf: string | null;
    /** Complete cookie/registration data as returned by alexa-cookie2 */
    cookieData: any;
    /**
     * Authentication details of the last authentication check
     *
     * @deprecated Amazon removed the API that delivered these details, so it is always null
     */
    authenticationDetails: GetAuthenticationDetails | null;
    /** Customer ID of the account owner (queried on demand) */
    ownerCustomerId: string | null;
    /** Region specific API endpoints */
    endpoints: Endpoints | null;
    /** Host of the website API (e.g. alexa.amazon.de) */
    baseUrl: string;
    /** Access token for the Alexa API (api.amazonalexa.com) */
    authApiBearerToken: string | null;
    /** Expiry timestamp of the access token */
    authApiBearerExpiry: number | null;
    /** Timestamp after which the access token is renewed (80 % of its lifetime) */
    authApiBearerRenewAt: number | null;
    /** CSRF token for the voice history API */
    activityCsrfToken: string | null;
    /** Expiry timestamp of the voice history CSRF token */
    activityCsrfTokenExpiry: number | null;
    /** Page the voice history CSRF token was read from (sent as referer) */
    activityCsrfTokenReferer: string | null;
    /** Last media (from PUSH_AUDIO_PLAYER_STATE) per device, used to find the device of NotifyNowPlayingUpdated */
    lastAudioPlayerMedia: Record<string, { mediaReferenceId: string; deviceType: string; ts: number }>;
    /** Device per playback session (taskSessionId of NotifyNowPlayingUpdated) */
    nowPlayingSessions: Record<string, { deviceSerialNumber: string; deviceType: string }>;
    /** Last volume per device from push messages, used to detect activities */
    lastVolumes: Record<string, { volumeSetting: number; isMuted: boolean; updated: number }>;
    /** Last equalizer settings per device from push messages, used to detect activities */
    lastEqualizer: Record<string, { bass: number; treble: number; midrange: number; updated: number }>;
    /** Timestamp of the last emitted activity per device */
    lastPushedActivity: Record<string, number>;
    /** Activities (from push messages) that still need to be fetched from the voice history */
    activityUpdateQueue: any[];
    /** How often the queued activities were not found in the voice history */
    activityUpdateNotFoundCounter: number;
    /** Timer for the next voice history query */
    activityUpdateTimeout: NodeJS.Timeout | null;
    /** True while the voice history is queried */
    activityUpdateRunning: boolean;
    /** Options given to `init()` */
    _options!: AlexaRemoteOptions;
    /** Device registration data (private key and ADP token) */
    macDms?: MacDms;
    /** ID of the communication account (for messages and contacts) */
    commsId?: string;
    /** Timer for the automatic cookie refresh */
    cookieRefreshTimeout?: NodeJS.Timeout | null;
    /** Push connection handler */
    alexahttp2Push?: AlexaHttp2Push | null;
    /** alexa-cookie2 module (loaded on demand) */
    alexaCookie?: AlexaCookie;

    /**
     * Creates a new, not yet initialized instance. Call `init()` afterwards to log in and load the devices.
     */
    constructor() {
        super();

        this.serialNumbers = {};
        this.names = {};
        this.friendlyNames = {};
        this.lastAuthCheck = null;
        this.cookie = null;
        this.csrf = null;
        this.cookieData = null;
        this.authenticationDetails = null;
        this.ownerCustomerId = null;
        this.endpoints = null;

        this.baseUrl = 'alexa.amazon.de';

        this.authApiBearerToken = null;
        this.authApiBearerExpiry = null;
        this.authApiBearerRenewAt = null;

        this.activityCsrfToken = null;
        this.activityCsrfTokenExpiry = null;
        this.activityCsrfTokenReferer = null;

        this.lastAudioPlayerMedia = {};
        this.nowPlayingSessions = {};
        this.lastVolumes = {};
        this.lastEqualizer = {};
        this.lastPushedActivity = {};

        this.activityUpdateQueue = [];
        this.activityUpdateNotFoundCounter = 0;
        this.activityUpdateTimeout = null;
        this.activityUpdateRunning = false;
    }

    /**
     * Stores the cookie (and the CSRF token extracted from it) that is used for all API calls.
     * Accepts either the plain cookie string or the result object of alexa-cookie2 (with `localCookie`),
     * which is then also remembered as `cookieData` / `formerRegistrationData` for later refreshes.
     * Emits the `cookie` event when a valid cookie with CSRF token was set.
     *
     * @param _cookie cookie string or cookie data object
     */
    setCookie(_cookie: any): void {
        if (!_cookie) {
            return;
        }
        if (typeof _cookie === 'string') {
            this.cookie = _cookie;
        } else if (_cookie?.cookie && typeof _cookie.cookie === 'string') {
            this.cookie = _cookie.cookie;
        } else if (_cookie?.localCookie && typeof _cookie.localCookie === 'string') {
            this.cookie = _cookie.localCookie;
            this._options.formerRegistrationData = this.cookieData = _cookie;
        } else if (_cookie?.cookie && typeof _cookie.cookie === 'object') {
            return this.setCookie(_cookie.cookie);
        }

        if (!this.cookie || typeof this.cookie !== 'string') {
            return;
        }
        const ar = this.cookie.match(/csrf=([^;]+)/);
        if (ar && ar.length >= 2) {
            this.csrf = ar[1];
        }
        if (!this.csrf) {
            this.cookie = null;
            return;
        }
        this._options.csrf = this.csrf;
        this._options.cookie = this.cookie;
        this.macDms = this._options.macDms ||= this.cookieData?.macDms;
        this.emit('cookie', this.cookie, this.csrf, this.macDms);
    }

    /**
     * Initializes the instance: determines/refreshes the cookie, checks the authentication,
     * queries the API endpoints, loads all devices (incl. wake words, bluetooth and notifications)
     * and optionally opens the push connection.
     *
     * If no valid cookie is available, alexa-cookie2 is used to generate one (e.g. via its login proxy).
     * If `cookieRefreshInterval` is set, the initialization is repeated automatically to refresh the cookie.
     *
     * @param cookie options object (preferred) or the cookie
     * @param callback called with an error or without parameters when the initialization is done
     */
    init(cookie: InitOptions | AlexaRemoteOptions['cookie'], callback?: CallbackWithError): void {
        // The options object was given: set defaults for user agent, API user agent postfix and Amazon page
        if (typeof cookie === 'object') {
            this._options = cookie;
            if (!this._options.userAgent) {
                const platform = os.platform();
                if (platform === 'win32') {
                    this._options.userAgent =
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36';
                } else {
                    /*else if (platform === 'darwin') {
                        this._options.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/57.0.2987.133 Safari/537.36';
                    }*/
                    this._options.userAgent =
                        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36';
                }
            }
            if (this._options.apiUserAgentPostfix === undefined) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                this._options.apiUserAgentPostfix = `AlexaRemote/${require(fsPath.join(__dirname, '..', 'package.json')).version}`;
            }
            this._options.amazonPage ||= 'amazon.de';
            this.baseUrl = `alexa.${this._options.amazonPage}`;

            cookie = this._options.cookie;
        }
        this._options.logger?.(`Alexa-Remote: Use as User-Agent: ${this._options.userAgent}`);
        this._options.logger?.(`Alexa-Remote: Use as API User-Agent Postfix: ${this._options.apiUserAgentPostfix}`);
        this._options.logger?.(`Alexa-Remote: Use as Login-Amazon-URL: ${this._options.amazonPage}`);
        if (this._options.alexaServiceHost) {
            this.baseUrl = this._options.alexaServiceHost;
        }
        this._options.logger?.(`Alexa-Remote: Use as Base-URL: ${this.baseUrl}`);
        this._options.alexaServiceHost = this.baseUrl;
        // Migrate the old (misspelled) option name
        if (this._options.refreshCookieInterval !== undefined && this._options.cookieRefreshInterval === undefined) {
            this._options.cookieRefreshInterval = this._options.refreshCookieInterval;
            delete this._options.refreshCookieInterval;
        }
        // 0 disables the automatic refresh, invalid values fall back to the default of 4 days
        if (this._options.cookieRefreshInterval !== 0) {
            this._options.cookieRefreshInterval ||= 4 * 24 * 60 * 60 * 1000; // Auto Refresh after 4 days
        }
        if (this._options.cookieRefreshInterval < 0 || this._options.cookieRefreshInterval > 2147483646) {
            this._options.cookieRefreshInterval = 4 * 24 * 60 * 60 * 1000; // Auto Refresh after 4 days
        }
        // Makes sure that a valid cookie exists:
        // - no cookie: generate a new one (proxy or login)
        // - cookie with registration data: refresh it, if the tokens are older than 24h or data is incomplete
        const getCookie = (callback: CallbackWithError): void => {
            if (!this.cookie) {
                this._options.logger?.('Alexa-Remote: No cookie given, generate one');
                this._options.cookieJustCreated = true;
                this.generateCookie(this._options.email, this._options.password, (err, res) => {
                    if (!err && res) {
                        this.setCookie(res); // update
                        this.alexaCookie!.stopProxyServer();
                        return callback(null);
                    }
                    callback(err);
                });
            } else {
                this._options.logger?.('Alexa-Remote: cookie was provided');
                if (this._options.formerRegistrationData) {
                    const tokensValidSince = Date.now() - this._options.formerRegistrationData.tokenDate;
                    if (
                        tokensValidSince < 24 * 60 * 60 * 1000 &&
                        this._options.macDms &&
                        this._options.formerRegistrationData.dataVersion === 2
                    ) {
                        return callback(null);
                    }
                    this._options.logger?.('Alexa-Remote: former registration data exist, try refresh');
                    this._options.logger?.(JSON.stringify(this._options.formerRegistrationData));
                    this.refreshCookie((err, res) => {
                        if (err || !res) {
                            this._options.logger?.('Alexa-Remote: Error from refreshing cookies');
                            this.cookie = null;
                            return getCookie(callback); // error on refresh
                        }
                        this.setCookie(res); // update
                        return callback(null);
                    });
                } else {
                    callback(null);
                }
            }
        };

        this.setCookie(cookie); // set initial cookie

        getCookie(err => {
            if (typeof callback === 'function') {
                callback = callback.bind(this);
            }
            if (err) {
                this._options.logger?.('Alexa-Remote: Error from retrieving cookies');
                return callback?.(err);
            }
            if (!this.csrf) {
                return callback?.(new Error('no csrf found'));
            }
            this.checkAuthentication((authenticated, err) => {
                // null means that the state could not be determined (e.g. network error)
                if (err && authenticated === null) {
                    return callback?.(new Error(`Error while checking Authentication: ${err}`));
                }
                this._options.logger?.(`Alexa-Remote: Authentication checked: ${authenticated}`);
                // Cookie is invalid or the device registration data is missing: drop the cookie and start again
                if ((!authenticated && !this._options.cookieJustCreated) || !this.macDms) {
                    !this.macDms && this._options.logger?.('Alexa-Remote: JWT missing, forcing a refresh ...');
                    this._options.logger?.('Alexa-Remote: Cookie was set, but authentication invalid');
                    delete this._options.cookie;
                    delete this._options.csrf;
                    delete this._options.localCookie;
                    delete this._options.macDms;
                    return this.init(this._options, callback);
                }
                this.lastAuthCheck = new Date().getTime();
                if (this.cookieRefreshTimeout) {
                    clearTimeout(this.cookieRefreshTimeout);
                    this.cookieRefreshTimeout = null;
                }
                // Schedule the next cookie refresh by re-running the initialization with the stored cookie data
                if (this._options.cookieRefreshInterval) {
                    this.cookieRefreshTimeout = setTimeout(() => {
                        this.cookieRefreshTimeout = null;
                        this._options.cookie = this.cookieData;
                        delete this._options.csrf;
                        this.init(this._options, callback);
                    }, this._options.cookieRefreshInterval);
                }
                // The website API host depends on the region of the account
                this.getEndpoints((err, endpoints) => {
                    if (!err && endpoints && endpoints.websiteApiUrl) {
                        this.endpoints = endpoints;
                        this.baseUrl = endpoints.websiteApiUrl.replace(/^https?:\/\//, '');
                        this._options.logger?.(`Alexa-Remote: Change Base URL for API calls to ${this.baseUrl}`);
                    } else {
                        this._options.logger?.(`Alexa-Remote: Could not query endpoints: ${err}`);
                    }
                    this.prepare(() => {
                        if (this._options.useWsMqtt || this._options.usePushConnection) {
                            this.initPushConnection();
                        }
                        callback?.();
                    });
                });
            });
        });
    }

    /**
     * Loads the account information and then all device related data (devices, wake words, bluetooth and notifications).
     *
     * @param callback called when all data is loaded
     * @returns this instance
     */
    prepare(callback?: CallbackWithError): this {
        this.getAccount((err, result) => {
            if (!err && result && Array.isArray(result)) {
                result.forEach(account => {
                    this.commsId ||= account.commsId || undefined;
                    // if (!this.directedId) this.directedId = account.directedId;
                });
            }

            this.initDeviceState(() =>
                this.initWakewords(() => this.initBluetoothState(() => this.initNotifications(callback))),
            );
        });
        return this;
    }

    /**
     * Returns the authentication details (customer id, name, e-mail, ...) of the last authentication check.
     *
     * @deprecated Amazon removed the API that delivered these details, so it always returns null. Use `getUsersMe()` instead.
     * @returns always null
     */
    getAuthenticationDetails(): GetAuthenticationDetails | null {
        return this.authenticationDetails;
    }

    /**
     * Loads all notifications (alarms, timers, reminders) and attaches them to the devices as `device.notifications`.
     * Each notification gets the helper methods `set()`, `delete()` and `cancel()`.
     * Only done when the option `notifications` is enabled.
     *
     * @param callback called when done (errors are ignored)
     */
    initNotifications(callback?: CallbackWithError): void {
        if (!this._options.notifications) {
            return callback?.();
        }
        this.getNotifications((err, res) => {
            if (err || !res?.notifications || !Array.isArray(res.notifications)) {
                return callback?.();
            }

            for (const serialNumber of Object.keys(this.serialNumbers)) {
                this.serialNumbers[serialNumber].notifications = [];
            }

            res.notifications.forEach((noti: any) => {
                const device = this.find(noti.deviceSerialNumber);
                if (!device) {
                    // TODO: new stuff
                    return;
                }
                if (
                    noti.alarmTime &&
                    !noti.originalTime &&
                    noti.originalDate &&
                    noti.type !== 'Timer' &&
                    !noti.rRuleData
                ) {
                    const now = new Date(noti.alarmTime);
                    noti.originalTime = `${_00(now.getHours())}:${_00(now.getMinutes())}:${_00(now.getSeconds())}.000`;
                }
                noti.set = this.changeNotification.bind(this, noti);
                noti.delete = this.deleteNotification.bind(this, noti);
                noti.cancel = this.cancelNotification.bind(this, noti);
                device.notifications.push(noti);
            });
            callback?.();
        });
    }

    /**
     * Loads the configured wake words and stores them (lower case) as `device.wakeWord`.
     *
     * @param callback called when done (errors are ignored)
     */
    initWakewords(callback?: CallbackWithError): void {
        this.getWakeWords((err, wakeWords) => {
            if (err || !wakeWords || !Array.isArray(wakeWords.wakeWords)) {
                return callback?.();
            }

            wakeWords.wakeWords.forEach((o: any) => {
                const device = this.find(o.deviceSerialNumber);
                if (!device) {
                    // TODO: new stuff
                    return;
                }
                if (typeof o.wakeWord === 'string') {
                    device.wakeWord = o.wakeWord.toLowerCase();
                }
            });
            callback?.();
        });
    }

    /**
     * Loads all devices and their preferences and fills `serialNumbers`, `names` and `friendlyNames`.
     * Sub devices from `appDeviceList` are added as own devices. Known devices are updated in place,
     * so that references held by the caller stay valid. Several helper methods (e.g. `sendCommand`)
     * are bound to each device object.
     *
     * @param callback called when done (errors are ignored)
     */
    initDeviceState(callback?: CallbackWithError): void {
        this.getDevices((err, result) => {
            if (!err && result && Array.isArray(result.devices)) {
                this.getDevicePreferences((err, devicePrefs) => {
                    const devicePreferences: Record<string, any> = {};
                    if (!err && devicePrefs?.devicePreferences && Array.isArray(devicePrefs.devicePreferences)) {
                        devicePrefs.devicePreferences.forEach((pref: any) => {
                            devicePreferences[pref.deviceSerialNumber] = pref;
                        });
                    }

                    const customerIds: Record<string, number> = {};
                    const joinedDevices: any[] = [];

                    // Devices can contain sub devices (e.g. Fire TV app devices), which are handled as own devices
                    result.devices.forEach((device: any) => {
                        joinedDevices.push(device);
                        if (device.appDeviceList?.length) {
                            device.appDeviceList.forEach((subDevice: any) => {
                                const appDevice = Object.assign({}, device, subDevice);
                                appDevice.parentDeviceSerialNumber = device.serialNumber;
                                appDevice.appDeviceList = [];
                                joinedDevices.push(appDevice);
                            });
                        }
                    });

                    const processedSerialNumbers: string[] = [];
                    // Update existing device objects instead of replacing them, so that references stay valid
                    joinedDevices.forEach(device => {
                        const existingDevice = this.find(device.serialNumber);
                        if (!existingDevice) {
                            this.serialNumbers[device.serialNumber] = device;
                        } else {
                            if (
                                device.parentDeviceSerialNumber &&
                                processedSerialNumbers.includes(device.serialNumber)
                            ) {
                                return;
                            }
                            device = extend(true, existingDevice, device);
                        }
                        processedSerialNumbers.push(device.serialNumber);

                        if (devicePreferences[device.serialNumber]) {
                            device.preferences = devicePreferences[device.serialNumber];
                        }

                        let name = device.accountName;
                        this.names[name] = device;
                        this.names[name.toLowerCase()] = device;
                        if (device.deviceTypeFriendlyName) {
                            name += ` (${device.deviceTypeFriendlyName})`;
                            this.names[name] = device;
                            this.names[name.toLowerCase()] = device;
                        }
                        // device._orig = JSON.parse(JSON.stringify(device));
                        device._name = name;
                        device.sendCommand = this.sendCommand.bind(this, device);
                        device.setTunein = this.setTunein.bind(this, device);
                        device.playAudible = this.playAudible.bind(this, device);
                        device.rename = this.renameDevice.bind(this, device);
                        device.setDoNotDisturb = this.setDoNotDisturb.bind(this, device);
                        device.delete = this.deleteDevice.bind(this, device);
                        device.reboot = this.rebootDevice.bind(this, device);
                        device.getDevicePreferences = this.getDevicePreferences.bind(this, device);
                        device.setDevicePreferences = this.setDevicePreferences.bind(this, device);
                        device.getNotificationSounds = this.getNotificationSounds.bind(this, device);
                        device.setDevicePreferences = this.setDevicePreferences.bind(this, device);
                        device.getDeviceNotificationState = this.getDeviceNotificationState.bind(this, device);
                        device.setDeviceNotificationVolume = this.setDeviceNotificationVolume.bind(this, device);
                        device.setDeviceAscendingAlarmState = this.setDeviceAscendingAlarmState.bind(this, device);
                        device.getDeviceNotificationDefaultSound = this.getDeviceNotificationDefaultSound.bind(
                            this,
                            device,
                        );
                        device.setDeviceNotificationDefaultSound = this.setDeviceNotificationDefaultSound.bind(
                            this,
                            device,
                        );
                        if (device.deviceTypeFriendlyName) {
                            this.friendlyNames[device.deviceTypeFriendlyName] = device;
                        }
                        if (customerIds[device.deviceOwnerCustomerId] === undefined) {
                            customerIds[device.deviceOwnerCustomerId] = 0;
                        }
                        customerIds[device.deviceOwnerCustomerId] += 1;
                        // Calculate some helper flags from the capabilities
                        device.isControllable =
                            device.capabilities.includes('AUDIO_PLAYER') ||
                            device.capabilities.includes('AMAZON_MUSIC') ||
                            device.capabilities.includes('TUNE_IN') ||
                            device.capabilities.includes('AUDIBLE') ||
                            device.deviceFamily === 'FIRE_TV';
                        device.hasMusicPlayer =
                            device.capabilities.includes('AUDIO_PLAYER') ||
                            device.capabilities.includes('AMAZON_MUSIC') ||
                            device.deviceFamily === 'FIRE_TV';
                        device.isMultiroomDevice = device.clusterMembers.length > 0;
                        device.isMultiroomMember = device.parentClusters.length > 0;
                    });
                    // this.ownerCustomerId = Object.keys(customerIds)[0]; // this could end in the wrong one!
                    callback?.();
                });
            } else {
                callback?.();
            }
        });
    }

    /**
     * Loads the bluetooth state of all devices and stores it as `device.bluetoothState`.
     * Each paired device gets the helper methods `connect(on, cb)` and `unpaire(val, cb)`.
     * Only done when the option `bluetooth` is enabled; on errors the option is disabled.
     *
     * @param callback called when done
     */
    initBluetoothState(callback?: CallbackWithError): void {
        if (this._options.bluetooth) {
            this.getBluetooth((err, res) => {
                if (err || !res || !Array.isArray(res.bluetoothStates)) {
                    this._options.bluetooth = false;
                    return callback?.();
                }
                res.bluetoothStates.forEach((bt: any) => {
                    if (bt.pairedDeviceList && this.serialNumbers[bt.deviceSerialNumber]) {
                        this.serialNumbers[bt.deviceSerialNumber].bluetoothState = bt;
                        bt.pairedDeviceList.forEach((d: any) => {
                            bt[d.address] = d;
                            d.connect = (on: boolean, cb?: CallbackWithErrorAndBody): void => {
                                this[on ? 'connectBluetooth' : 'disconnectBluetooth'](
                                    this.serialNumbers[bt.deviceSerialNumber],
                                    d.address,
                                    cb,
                                );
                            };
                            d.unpaire = (_val: unknown, cb?: CallbackWithErrorAndBody): void => {
                                this.unpaireBluetooth(this.serialNumbers[bt.deviceSerialNumber], d.address, cb);
                            };
                        });
                    }
                });
                callback?.();
            });
        } else {
            callback?.();
        }
    }

    /**
     * Stops the login proxy server of alexa-cookie2 if it was started.
     *
     * @param callback called when the proxy is stopped
     */
    stopProxyServer(callback?: CallbackWithError): void {
        if (!this.alexaCookie) {
            return callback?.();
        }
        this.alexaCookie.stopProxyServer(callback);
    }

    /**
     * Returns whether the push connection is established.
     *
     * @deprecated
     * @returns true if connected
     */
    isWsMqttConnected(): boolean {
        return this.isPushConnected();
    }

    /**
     * Returns whether the push connection (HTTP/2) is established.
     *
     * @returns true if connected
     */
    isPushConnected(): boolean {
        return !!this.alexahttp2Push?.isConnected();
    }

    /**
     * Initializes the push connection.
     *
     * @deprecated
     */
    initWsMqttConnection(): void {
        return this.initPushConnection();
    }

    /**
     * Finds the device of a NotifyNowPlayingUpdated push message, which contains no device:
     * the media reference of the PUSH_AUDIO_PLAYER_STATE message that is sent before ends with the media id
     * (e.g. "EMP_ALEXA-<uuid>:spotify:track:<id>" and "spotify:track:<id>"). The device is remembered per playback
     * session, so later updates of the session (e.g. pause) are assigned too.
     *
     * @param taskSessionId playback session of the message
     * @param mediaId id of the played media
     * @returns the device or null if it could not be determined
     */
    findNowPlayingDevice(
        taskSessionId: string | undefined,
        mediaId: string | undefined,
    ): { deviceSerialNumber: string; deviceType: string } | null {
        if (taskSessionId && this.nowPlayingSessions[taskSessionId]) {
            return this.nowPlayingSessions[taskSessionId];
        }
        if (!mediaId) {
            return null;
        }
        let found: { deviceSerialNumber: string; deviceType: string } | null = null;
        let foundTs = 0;
        for (const [serial, media] of Object.entries(this.lastAudioPlayerMedia)) {
            if (
                (media.mediaReferenceId === mediaId || media.mediaReferenceId.endsWith(`:${mediaId}`)) &&
                media.ts > foundTs
            ) {
                found = { deviceSerialNumber: serial, deviceType: media.deviceType };
                foundTs = media.ts;
            }
        }
        if (found && taskSessionId) {
            // keep only the newest sessions
            const sessions = Object.keys(this.nowPlayingSessions);
            if (sessions.length >= 50) {
                delete this.nowPlayingSessions[sessions[0]];
            }
            this.nowPlayingSessions[taskSessionId] = found;
        }
        return found;
    }

    /**
     * Some actions (e.g. volume changes) do not create a PUSH_ACTIVITY message. If the option
     * `autoQueryActivityOnTrigger` is enabled, such events are queued and the voice history is queried
     * a few seconds later to emit a `ws-device-activity` event.
     *
     * @param deviceSerialNumber serial number of the device that triggered the event
     * @param destinationUserId customer id from the push message
     */
    simulateActivity(deviceSerialNumber: string, destinationUserId: string): void {
        if (!this._options.autoQueryActivityOnTrigger) {
            return;
        }
        if (
            this.activityUpdateTimeout &&
            this.activityUpdateQueue.some(
                entry =>
                    entry.deviceSerialNumber === deviceSerialNumber && entry.destinationUserId === destinationUserId,
            )
        ) {
            return;
        }

        this._options.logger?.(
            `Alexa-Remote: Simulate activity for ${deviceSerialNumber} with destinationUserId ${destinationUserId} ... fetch in 3s`,
        );

        if (this.activityUpdateTimeout) {
            clearTimeout(this.activityUpdateTimeout);
            this.activityUpdateTimeout = null;
        }
        this.activityUpdateQueue.push({
            deviceSerialNumber: deviceSerialNumber,
            destinationUserId: destinationUserId,
            activityTimestamp: Date.now(),
        });
        this.activityUpdateTimeout = setTimeout(() => {
            this.activityUpdateTimeout = null;
            this.getPushedActivities();
        }, 4000);
    }

    /**
     * (Re)creates the HTTP/2 push connection to Amazon. Incoming push commands are converted into
     * the `ws-*` events of this class (e.g. `ws-volume-change`, `ws-device-activity`).
     * An access token is requested before the connection is established.
     */
    initPushConnection(): void {
        if (this.alexahttp2Push) {
            this.alexahttp2Push.removeAllListeners();
            this.alexahttp2Push.disconnect();
            this.alexahttp2Push = null;
        }
        if (!this.authApiBearerToken) {
            this.updateApiBearerToken(err => {
                if (err) {
                    this._options.logger?.(
                        'Alexa-Remote: Initializing WS-MQTT Push Connection failed because no Access-Token available!',
                    );
                } else {
                    return this.initPushConnection();
                }
            });
            return;
        }
        // The push connection requests a (new) access token via this function on (re)connect,
        // with force = true if Amazon refused the current token
        this.alexahttp2Push = new AlexaHttp2Push(this._options, (callback, force) => {
            this._options.logger?.(`Alexa-Remote: Update access token${force ? ' (forced)' : ''} ...`);
            this.updateApiBearerToken(err => {
                if (err) {
                    this._options.logger?.(
                        'Alexa-Remote: Initializing WS-MQTT Push Connection failed because no Access-Token available!',
                    );
                    callback(null);
                } else {
                    callback(this.authApiBearerToken);
                }
            }, force);
        });
        if (!this.alexahttp2Push) {
            return;
        }

        this._options.logger?.('Alexa-Remote: Initialize WS-MQTT Push Connection');

        this.alexahttp2Push.on('disconnect', (retries, msg) => {
            this.emit('ws-disconnect', retries, msg);
        });
        this.alexahttp2Push.on('error', error => {
            this.emit('ws-error', error);
        });
        this.alexahttp2Push.on('connect', () => {
            this.emit('ws-connect');
        });
        this.alexahttp2Push.on('unknown', incomingMsg => {
            this.emit('ws-unknown-message', incomingMsg);
        });
        // Messages that could not be parsed: report them instead of dropping them silently
        this.alexahttp2Push.on('unexpected-response', (msg: string) => {
            this._options.logger?.(`Alexa-Remote: Unexpected push message: ${msg}`);
            this.emit('ws-unknown-message', msg);
        });
        this.alexahttp2Push.on('command', (command: string, payload: any) => {
            this.emit('command', { command: command, payload: payload });

            // Convert the push commands into own events with a flat payload
            switch (command) {
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
                        connectionState: payload.dopplerConnectionState,
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
                        bluetoothEventSuccess: payload.bluetoothEventSuccess,
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
                    // remember the media per device to find the device of NotifyNowPlayingUpdated (it has no device)
                    if (payload.mediaReferenceId && payload.dopplerId?.deviceSerialNumber) {
                        this.lastAudioPlayerMedia[payload.dopplerId.deviceSerialNumber] = {
                            mediaReferenceId: payload.mediaReferenceId,
                            deviceType: payload.dopplerId.deviceType,
                            ts: Date.now(),
                        };
                    }
                    this.emit('ws-audio-player-state-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        mediaReferenceId: payload.mediaReferenceId,
                        audioPlayerState: payload.audioPlayerState, //  'INTERRUPTED', / 'FINISHED' / 'PLAYING'
                        error: payload.error,
                        errorMessage: payload.errorMessage,
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
                        loopMode: payload.loopMode,
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
                        mediaReferenceId: payload.mediaReferenceId,
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
                        mediaLength: payload.progress ? payload.progress.mediaLength : null,
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
                    if (
                        !this.lastVolumes[payload.dopplerId.deviceSerialNumber] ||
                        (this.lastVolumes[payload.dopplerId.deviceSerialNumber].volumeSetting ===
                            payload.volumeSetting &&
                            this.lastVolumes[payload.dopplerId.deviceSerialNumber].isMuted === payload.isMuted) ||
                        // a volume change shortly after an equalizer change is also an indication for an activity
                        (this.lastEqualizer[payload.dopplerId.deviceSerialNumber] &&
                            Math.abs(Date.now() - this.lastEqualizer[payload.dopplerId.deviceSerialNumber].updated) <
                                2000)
                    ) {
                        this.simulateActivity(payload.dopplerId.deviceSerialNumber, payload.destinationUserId);
                    }
                    this.lastVolumes[payload.dopplerId.deviceSerialNumber] = {
                        volumeSetting: payload.volumeSetting,
                        isMuted: payload.isMuted,
                        updated: Date.now(),
                    };

                    this.emit('ws-volume-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        isMuted: payload.isMuted,
                        volume: payload.volumeSetting,
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
                        deviceComponent: payload.deviceComponent,
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
                    if (
                        !this.lastEqualizer[payload.dopplerId.deviceSerialNumber] ||
                        (this.lastEqualizer[payload.dopplerId.deviceSerialNumber].bass === payload.bass &&
                            this.lastEqualizer[payload.dopplerId.deviceSerialNumber].treble === payload.treble &&
                            this.lastEqualizer[payload.dopplerId.deviceSerialNumber].midrange === payload.midrange) ||
                        // an equalizer change shortly after a volume change is also an indication for an activity
                        (this.lastVolumes[payload.dopplerId.deviceSerialNumber] &&
                            Math.abs(Date.now() - this.lastVolumes[payload.dopplerId.deviceSerialNumber].updated) <
                                2000)
                    ) {
                        this.simulateActivity(payload.dopplerId.deviceSerialNumber, payload.destinationUserId);
                    }
                    this.lastEqualizer[payload.dopplerId.deviceSerialNumber] = {
                        bass: payload.bass,
                        treble: payload.treble,
                        midrange: payload.midrange,
                        updated: Date.now(),
                    };

                    this.emit('ws-equilizer-state-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId.deviceSerialNumber,
                        deviceType: payload.dopplerId.deviceType,
                        bass: payload.bass,
                        treble: payload.treble,
                        midrange: payload.midrange,
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
                        notificationVersion: payload.notificationVersion,
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
                    // Collect activity notifications and query the voice history shortly after, as the push message does not contain the details
                    this.activityUpdateQueue.push(payload);
                    if (this.activityUpdateTimeout) {
                        clearTimeout(this.activityUpdateTimeout);
                        this.activityUpdateTimeout = null;
                    }
                    this.activityUpdateTimeout = setTimeout(() => {
                        this.activityUpdateTimeout = null;
                        this.getPushedActivities();
                    }, 200);
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
                        listItemId: payload.listItemId,
                    });
                    return;

                case 'NotifyNowPlayingUpdated': {
                    /*
                    {
                        'customerId': 'xxxxxxxxxxxxxx',
                        'update': {
                            'taskSessionId': 'amzn1.echo-api.session.xxxx',
                            'update': {
                                'cause': 'PLAYBACK_STARTED',
                                'nowPlayingData': {
                                    'playerState': 'PLAYING',
                                    'mediaId': 'spotify:track:xxxx',
                                    'transport': { 'playPause': 'ENABLED', 'next': 'ENABLED', ... },
                                    'progress': { 'mediaProgress': 613, 'mediaLength': 199773, ... },
                                    'provider': { 'providerName': 'Spotify', ... },
                                    'mainArt': { 'largeUrl': 'https://...', ... },
                                    'infoText': { 'title': '[Song Title]', 'subText1': '[Song Artist]', 'subText2': '[Album Title]' },
                                    ...
                                }
                            }
                        }
                    }
                    */
                    const nowPlaying = payload?.update?.update?.nowPlayingData ?? null;
                    const nowPlayingDevice = this.findNowPlayingDevice(
                        payload?.update?.taskSessionId,
                        nowPlaying?.mediaId,
                    );

                    this.emit('ws-now-playing-updated', {
                        deviceSerialNumber: nowPlayingDevice?.deviceSerialNumber ?? null,
                        deviceType: nowPlayingDevice?.deviceType ?? null,
                        customerId: payload?.customerId ?? null,
                        taskSessionId: payload?.update?.taskSessionId ?? null,
                        cause: payload?.update?.update?.cause ?? null,
                        mediaId: nowPlaying?.mediaId ?? null,
                        playerState: nowPlaying?.playerState ?? null,
                        nowPlayingData: nowPlaying,
                    });
                    return;
                }

                case 'PUSH_DND_STATE_CHANGE':
                    /*
                    {
                        'destinationUserId': 'A3NSX4MMJVG96V',
                        'dopplerId': {
                            'deviceSerialNumber': 'G090LF09643202VS',
                            'deviceType': 'A3S5BH2HU6VAYF'
                        },
                        'enabled': true
                    }
                    */
                    this.emit('ws-dnd-state-change', {
                        destinationUserId: payload.destinationUserId,
                        deviceSerialNumber: payload.dopplerId?.deviceSerialNumber,
                        deviceType: payload.dopplerId?.deviceType,
                        enabled: payload.enabled,
                    });
                    return;

                case 'PUSH_MICROPHONE_STATE':
                case 'PUSH_DELETE_DOPPLER_ACTIVITIES':
                case 'PUSH_DEVICE_SETUP_STATE_CHANGE':
                case 'NotifyMediaSessionsUpdated':
                    return;
            }

            this.emit('ws-unknown-command', command, payload);
        });

        this.alexahttp2Push.connect();
    }

    /**
     * Queries the voice history for all queued activities (from push messages or simulated activities)
     * and emits a `ws-device-activity` event for each found entry. Entries that were not found are
     * retried a few times before the queue is reset.
     */
    getPushedActivities(): void {
        if (!this._options.autoQueryActivityOnTrigger) {
            return;
        }
        this._options.logger?.(
            `Alexa-Remote: Get pushed activities ... ${this.activityUpdateQueue.length} entries in queue (already running: ${this.activityUpdateRunning})`,
        );
        if (this.activityUpdateRunning || !this.activityUpdateQueue.length) {
            return;
        }
        this.activityUpdateRunning = true;
        // Query the voice history starting one minute before the oldest queued activity
        let earliestActionDate = Date.now();
        this.activityUpdateQueue.forEach(entry => {
            if (entry.activityTimestamp < earliestActionDate) {
                earliestActionDate = entry.activityTimestamp;
            }
        });
        this.getCustomerHistoryRecords(
            {
                maxRecordSize: this.activityUpdateQueue.length + 2,
                filter: false,
                forceRequest: true,
                startTime: earliestActionDate - 60000,
            },
            (err?: Error | null, res?: any) => {
                this.activityUpdateRunning = false;
                if (!res || err?.message.includes('no body')) {
                    err = null;
                    res = [];
                }
                if (!err) {
                    res.reverse();
                    this._options.logger?.(`Alexa-Remote: Activity data ${JSON.stringify(res)}`); // TODO REMOVE

                    let lastFoundQueueIndex = -1;
                    this.activityUpdateQueue.forEach((entry, queueIndex) => {
                        // Old style activity push message with a record key
                        if (entry.key) {
                            // deprecated
                            const found = res.findIndex(
                                (activity: any) =>
                                    activity.data.recordKey.endsWith(`#${entry.key.entryId}`) &&
                                    activity.data.customerId === entry.key.registeredUserId,
                            );

                            if (found === -1) {
                                this._options.logger?.(`Alexa-Remote: Activity for id ${entry.key.entryId} not found`);
                            } else {
                                lastFoundQueueIndex = queueIndex;
                                this.activityUpdateQueue.splice(0, lastFoundQueueIndex + 1);
                                const activity = res.splice(found, 1)[0];
                                this._options.logger?.(
                                    `Alexa-Remote: Activity found entry ${found} for Activity ID ${entry.key.entryId}`,
                                );
                                activity.destinationUserId = entry.destinationUserId;
                                this.emit('ws-device-activity', activity);
                            }
                        } else {
                            const lastPushedActivity =
                                this.lastPushedActivity[entry.deviceSerialNumber] || Date.now() - 30000;
                            const found = res.filter(
                                (activity: any) =>
                                    activity.data.recordKey.endsWith(`#${entry.deviceSerialNumber}`) &&
                                    activity.data.customerId === entry.destinationUserId &&
                                    activity.creationTimestamp >= entry.activityTimestamp - 10000 &&
                                    activity.creationTimestamp > lastPushedActivity,
                            ); // Only if current stuff is found

                            if (found.length === 0) {
                                this._options.logger?.(
                                    `Alexa-Remote: Activity for device ${entry.deviceSerialNumber} not found`,
                                );
                            } else {
                                let foundSomething = false;
                                found.forEach((activity: any, index: number) => {
                                    if (
                                        activity.data.utteranceType === 'WAKE_WORD_ONLY' &&
                                        index === 0 &&
                                        this.activityUpdateNotFoundCounter > 0 &&
                                        found.length > 1
                                    ) {
                                        return;
                                    }
                                    this._options.logger?.(
                                        `Alexa-Remote: Activity (ts=${activity.creationTimestamp}) found for device ${entry.deviceSerialNumber}`,
                                    );
                                    activity.destinationUserId = entry.destinationUserId;
                                    this.emit('ws-device-activity', activity);
                                    if (activity.data.utteranceType !== 'WAKE_WORD_ONLY') {
                                        this.lastPushedActivity[entry.deviceSerialNumber] = activity.creationTimestamp;
                                        foundSomething = true;
                                    } else {
                                        this._options.logger?.(
                                            `Alexa-Remote: Only Wakeword activity for device ${entry.deviceSerialNumber} found. try again in 2,5s`,
                                        );
                                        if (!foundSomething) {
                                            lastFoundQueueIndex = -2;
                                        }
                                    }
                                });
                                if (foundSomething) {
                                    lastFoundQueueIndex = queueIndex;
                                    this.activityUpdateQueue.splice(queueIndex, 1);
                                }
                            }
                        }
                    });

                    if (lastFoundQueueIndex < 0) {
                        this._options.logger?.(
                            `Alexa-Remote: No activities from stored ${this.activityUpdateQueue.length} entries found in queue (${this.activityUpdateNotFoundCounter})`,
                        );
                        this.activityUpdateNotFoundCounter++;
                        if (
                            (lastFoundQueueIndex === -1 && this.activityUpdateNotFoundCounter > 2) || // 2 tries without wakeword
                            (lastFoundQueueIndex === -2 && this.activityUpdateNotFoundCounter > 5) // 5 tries with wakeword
                        ) {
                            this._options.logger?.('Alexa-Remote: Reset expected activities');
                            this.activityUpdateQueue = [];
                            this.activityUpdateNotFoundCounter = 0;
                        }
                    } else {
                        this.activityUpdateNotFoundCounter = 0;
                        this._options.logger?.(
                            `Alexa-Remote: ${this.activityUpdateQueue.length} entries left in activity queue`,
                        );
                    }
                }

                if (!err && this.activityUpdateQueue.length) {
                    this.activityUpdateTimeout = setTimeout(() => {
                        this.activityUpdateTimeout = null;
                        this.getPushedActivities();
                    }, 4000);
                }
            },
        );
    }

    /**
     * Stops the automatic cookie refresh and closes the push connection.
     */
    stop(): void {
        if (this.cookieRefreshTimeout) {
            clearTimeout(this.cookieRefreshTimeout);
            this.cookieRefreshTimeout = null;
        }
        if (this.alexahttp2Push) {
            this.alexahttp2Push.disconnect();
        }
    }

    /**
     * Generates a new cookie using alexa-cookie2 (login proxy or e-mail/password).
     *
     * @param email Amazon account e-mail (optional, proxy is used otherwise)
     * @param password Amazon account password (optional)
     * @param callback called with (error, result)
     */
    generateCookie(email: string | undefined, password: string | undefined, callback: CallbackWithErrorAndBody): void {
        if (!this.alexaCookie) {
            // lazy load, as alexa-cookie2 is only needed for cookie handling
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.alexaCookie = require('alexa-cookie2');
        }
        this.alexaCookie!.generateAlexaCookie(email, password, this._options, callback);
    }

    /**
     * Refreshes the cookie using the stored registration data (refresh token) via alexa-cookie2.
     *
     * @param callback called with (error, result)
     */
    refreshCookie(callback: CallbackWithErrorAndBody): void {
        if (!this.alexaCookie) {
            // lazy load, as alexa-cookie2 is only needed for cookie handling
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.alexaCookie = require('alexa-cookie2');
        }
        this.alexaCookie!.refreshAlexaCookie(this._options, callback);
    }

    /**
     * Exchanges the refresh token for an access token for the Alexa API (api.amazonalexa.com).
     *
     * @param callback called with (error, result)
     */
    getAuthApiBearerToken(callback: CallbackWithErrorAndBody<AuthTokenResponse>): void {
        if (!this.alexaCookie) {
            // lazy load, as alexa-cookie2 is only needed for cookie handling
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.alexaCookie = require('alexa-cookie2');
        }
        const deviceAppName =
            this._options.formerRegistrationData?.deviceAppName || this.alexaCookie!.getDeviceAppName(); // Use the App Name from last cookie response or use default one
        this.httpsGet(
            true,
            `https://api.${this._options.amazonPage}/auth/token`,
            (err, res) => {
                if (err) {
                    this._options.logger?.(`Alexa-Remote: Error getting auth token: ${err.message}`);
                    callback(err);
                } else {
                    this._options.logger?.(`Alexa-Remote: Auth token: ${res.access_token}`);
                    callback(null, res);
                }
            },
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                data: `app_name=${encodeURIComponent(deviceAppName)}&app_version=2.2.556530.0&di.sdk.version=6.12.4&source_token=${encodeURIComponent(this.cookieData.refreshToken)}&package_name=com.amazon.echo&di.hw.version=iPhone&platform=iOS&requested_token_type=access_token&source_token_type=refresh_token&di.os.name=iOS&di.os.version=16.6&current_version=6.12.4&previous_version=6.12.4`,
            },
        );
    }

    /**
     * Returns whether the access token for the Alexa API can still be used.
     * The token is renewed when 80 % of its lifetime have passed, so it never expires while it is in use
     * (e.g. a push connection that is opened shortly before the expiry would be refused by Amazon).
     *
     * @returns true if the token exists and does not need to be renewed yet
     */
    isApiBearerTokenValid(): boolean {
        const renewAt = this.authApiBearerRenewAt ?? this.authApiBearerExpiry ?? 0;
        return !!this.authApiBearerToken && Date.now() < Math.min(renewAt, this.authApiBearerExpiry ?? 0);
    }

    /**
     * Makes sure that a valid access token for the Alexa API is available; requests a new one if it is missing,
     * expired or 80 % of its lifetime have passed.
     *
     * @param callback called with an error if no token could be retrieved
     * @param force true to request a new token even if the current one is still valid (e.g. after Amazon refused it)
     */
    updateApiBearerToken(callback?: CallbackWithError, force?: boolean): void {
        if (!force && this.isApiBearerTokenValid()) {
            return callback?.(null);
        }
        this.getAuthApiBearerToken((err, res) => {
            if (err || !res || !res.access_token || res.token_type !== 'bearer') {
                this._options.logger?.(
                    `Alexa-Remote: Error getting auth token: ${err ? err.message : JSON.stringify(res)}`,
                );
                return callback?.(err);
            }
            this.authApiBearerToken = res.access_token;
            this.authApiBearerExpiry = Date.now() + res.expires_in * 1000;
            this.authApiBearerRenewAt = Date.now() + res.expires_in * 800;
            callback?.(err);
        });
    }

    /**
     * Sends a request to the Alexa API (api.amazonalexa.com) using the bearer access token instead of the cookie.
     *
     * @param path request path
     * @param callback called with (error, result)
     * @param flags request options (method, data, headers, ...)
     */
    httpsGetAuthApi(path: string, callback?: CallbackWithErrorAndBody, flags: HttpsGetFlags = {}): void {
        if (!this.endpoints || !this.endpoints.alexaApiUrl) {
            this._options.logger?.(`Alexa-Remote: No endpoint set for alexaApiUrl: ${JSON.stringify(this.endpoints)}`);
            return callback?.(new Error(`No endpoint set for alexaApiUrl: ${JSON.stringify(this.endpoints)}`));
        }
        flags ||= {};
        flags.host = this.endpoints.alexaApiUrl.replace(/^https?:\/\//, '');
        flags.cleanHeader = true;
        flags.headers ||= {};
        flags.headers.authorization = this.authApiBearerToken;
        flags.headers.authority = flags.host;
        flags.headers['user-agent'] = `${officialUserAgent} ${this._options.apiUserAgentPostfix}`.trim();
        if (!this.isApiBearerTokenValid()) {
            this.updateApiBearerToken(err => {
                if (err) {
                    return callback?.(err);
                }
                flags.headers!.authorization = this.authApiBearerToken;
                this.httpsGet(true, path, callback, flags);
            });
        } else {
            flags ||= {};
            this.httpsGet(true, path, callback, flags);
        }
    }

    /**
     * Sends a request to the Alexa API host (api.amazonalexa.com) with the cookie, but without the bearer access token.
     *
     * @param path request path
     * @param callback called with (error, result)
     * @param flags request options (method, data, headers, ...)
     */
    httpsApiGet(path: string, callback?: CallbackWithErrorAndBody, flags: HttpsGetFlags = {}): void {
        if (!this.endpoints || !this.endpoints.alexaApiUrl) {
            this._options.logger?.(`Alexa-Remote: No endpoint set for alexaApiUrl: ${JSON.stringify(this.endpoints)}`);
            return callback?.(new Error(`No endpoint set for alexaApiUrl: ${JSON.stringify(this.endpoints)}`));
        }
        flags ||= {};
        flags.host ||= this.endpoints.alexaApiUrl.replace(/^https?:\/\//, '');
        return this.httpsGetCall(path, callback, flags);
    }

    /**
     * Sends a request to the Alexa website API. If the last authentication check is older than
     * 30 minutes, the authentication is checked first and the instance is re-initialized if needed.
     * The path may contain `%t` which is replaced by the current timestamp. If the path does not start
     * with `/`, it is interpreted as full URL with own host.
     *
     * @param noCheck true to skip the authentication check (or the path when called with 3 parameters)
     * @param path request path or URL (or the callback when called with 3 parameters)
     * @param callback called with (error, result) (or the flags when called with 3 parameters)
     * @param flags request options (method, data, headers, timeout, ...)
     */
    httpsGet(path: string, callback?: CallbackWithErrorAndBody | null, flags?: HttpsGetFlags): void;
    httpsGet(noCheck: boolean, path: string, callback?: CallbackWithErrorAndBody | null, flags?: HttpsGetFlags): void;
    httpsGet(
        noCheck: boolean | string,
        path: string | CallbackWithErrorAndBody | null | undefined,
        callback?: CallbackWithErrorAndBody | HttpsGetFlags | null,
        flags: HttpsGetFlags = {},
    ): void {
        // Called as httpsGet(path, callback, flags): shift the parameters
        if (typeof noCheck !== 'boolean') {
            flags = callback as HttpsGetFlags;
            callback = path as CallbackWithErrorAndBody;
            path = noCheck;
            noCheck = false;
        }
        const _path = path as string;
        const _callback = callback as CallbackWithErrorAndBody | null | undefined;
        // Bypass the check if requested or if the last check was done less than 30 minutes ago
        if (noCheck || new Date().getTime() - (this.lastAuthCheck || 0) < 1800000) {
            this._options.logger?.(
                `Alexa-Remote: No authentication check needed (time elapsed ${new Date().getTime() - (this.lastAuthCheck || 0)})`,
            );
            return this.httpsGetCall(_path, _callback, flags);
        }
        this.checkAuthentication((authenticated, err) => {
            if (authenticated) {
                this._options.logger?.('Alexa-Remote: Authentication check successfull');
                this.lastAuthCheck = new Date().getTime();
                return this.httpsGetCall(_path, _callback, flags);
                // null means that the state could not be determined (e.g. network error)
            } else if (err && authenticated === null) {
                this._options.logger?.(`Alexa-Remote: Authentication check returned error: ${err}. Still try request`);
                return this.httpsGetCall(_path, _callback, flags);
            }
            this._options.logger?.('Alexa-Remote: Authentication check Error, try re-init');
            delete this._options.csrf;
            delete this._options.cookie;
            this.init(this._options, err => {
                if (err) {
                    this._options.logger?.('Alexa-Remote: Authentication check Error and renew unsuccessful. STOP');
                    return _callback?.(new Error('Cookie invalid, Renew unsuccessful'));
                }
                return this.httpsGet(_path, _callback, flags);
            });
        });
    }

    /**
     * Executes the HTTPS request without authentication check. Handles gzip/deflate encoded responses,
     * parses the JSON body and retries once on HTTP 503 and on rate limiting responses.
     *
     * @param path request path or URL
     * @param callback called with (error, result)
     * @param flags request options (method, data, headers, timeout, ...)
     */
    httpsGetCall(path: string, callback?: CallbackWithErrorAndBody | null, flags: HttpsGetFlags = {}): void {
        // Evaluates the (decompressed) response and calls the callback exactly once (or retries the request)
        const handleResponse = (err: Error | null | undefined, res: IncomingMessage, body?: string): any => {
            if (!err && typeof res.statusCode === 'number' && res.statusCode === 401) {
                this._options.logger?.('Alexa-Remote: Response: 401 Unauthorized');
                return callback!(new Error('401 Unauthorized'), null);
            }

            // Service temporarily unavailable: retry once after a random delay
            if (!err && typeof res.statusCode === 'number' && res.statusCode === 503 && !flags.isRetry) {
                this._options.logger?.('Alexa-Remote: Response: 503 ... Retrying once');
                flags.isRetry = true;
                return setTimeout(
                    () => this.httpsGetCall(path, callback, flags),
                    Math.floor(Math.random() * 500) + 500,
                );
            }

            if (err || !body) {
                // Method 'DELETE' may return HTTP STATUS 200 without body
                this._options.logger?.(`Alexa-Remote: Response: No body (code=${res?.statusCode})`);
                return typeof res.statusCode === 'number' && res.statusCode >= 200 && res.statusCode < 300
                    ? callback!(null, { success: true })
                    : callback!(new Error('no body'), null);
            }

            // The caller wants the raw body (e.g. an HTML page)
            if (flags?.handleAsText) {
                return callback!(null, body);
            }

            // Parse the JSON body; on rate limiting responses the request is retried once after a longer delay
            let ret;
            try {
                ret = JSON.parse(body);
            } catch {
                if (typeof res.statusCode === 'number' && res.statusCode >= 500 && res.statusCode < 510) {
                    this._options.logger?.(`Alexa-Remote: Response: Status: ${res.statusCode}`);
                    callback!(new Error('no body'), null);
                    callback = null;
                    return;
                }

                this._options.logger?.(`Alexa-Remote: Response: No/Invalid JSON : ${body}`);
                if (
                    (body.includes('ThrottlingException') ||
                        body.includes('Rate exceeded') ||
                        body.includes('Too many requests')) &&
                    !flags.isRetry
                ) {
                    let delay = Math.floor(Math.random() * 3000) + 10000;
                    if (body.includes('Too many requests')) {
                        delay += 20000 + Math.floor(Math.random() * 30000);
                    }
                    this._options.logger?.(`Alexa-Remote: rate exceeded response ... Retrying once in ${delay}ms`);
                    flags.isRetry = true;
                    return setTimeout(() => this.httpsGetCall(path, callback, flags), delay);
                }
                callback?.(new Error('no JSON'), body);
                callback = null;
                return;
            }

            // TODO maybe handle the case of "non HTTP 200 responses" better and return accordingly?
            // maybe set err AND body?
            // add x-amzn-ErrorType header to err? (e.g. 400 on /player: ExpiredPlayQueueException:http://internal.amazon.com/coral/com.amazon.dee.web.coral.model/)
            this._options.logger?.(`Alexa-Remote: Response: ${JSON.stringify(ret)}`);
            if (
                (body.includes('ThrottlingException') ||
                    body.includes('Rate exceeded') ||
                    body.includes('Too many requests')) &&
                !flags.isRetry
            ) {
                let delay = Math.floor(Math.random() * 3000) + 10000;
                if (body.includes('Too many requests')) {
                    delay += 20000 + Math.floor(Math.random() * 30000);
                }
                this._options.logger?.(`Alexa-Remote: rate exceeded response ... Retrying once in ${delay}ms`);
                flags.isRetry = true;
                return setTimeout(() => this.httpsGetCall(path, callback, flags), delay);
            }
            callback!(null, ret);
            callback = null;
        };

        flags ||= {};

        const options: Omit<https.RequestOptions, 'headers'> & { headers: Record<string, any> } = {
            host: flags.host || this.baseUrl,
            path: '',
            method: 'GET',
            timeout: flags.timeout || 10000,
            headers: {
                'User-Agent': `${officialUserAgent} ${this._options.apiUserAgentPostfix}`.trim(),
                'Content-Type': 'application/json; charset=utf-8',
                Accept: 'application/json; charset=utf-8',
                'Accept-Language': this._options.acceptLanguage || 'de-DE',
                Referer: `https://alexa.${this._options.amazonPage}/spa/index.html`,
                Origin: `https://alexa.${this._options.amazonPage}`,
                csrf: this.csrf,
                Cookie: this.cookie,
                'Accept-Encoding': 'gzip, deflate',
            },
        };

        // Requests to the Alexa API must not contain the cookie headers
        if (flags.cleanHeader) {
            delete options.headers.Referer;
            delete options.headers.Origin;
            delete options.headers.Cookie;
            delete options.headers.csrf;
            delete options.headers['User-Agent'];
        }
        path = path.replace(/[\n ]/g, '');
        // A full URL was given: extract the host and the path
        if (!path.startsWith('/')) {
            path = path.replace(/^https:\/\//, '');
            // let ar = path.match(/^([^\/]+)(\/.*$)/);
            const ar = path.match(/^([^/]+)(\/*.*$)/)!;
            options.host = ar[1];
            path = ar[2];
        }
        const time = new Date().getTime();
        path = path.replace(/%t/g, String(time));

        options.path = path;
        options.method = flags.method ? flags.method : flags.data ? 'POST' : 'GET';

        // Requests without body must not announce a content type
        if ((options.method === 'GET' || options.method === 'DELETE') && !flags.data) {
            delete options.headers['Content-Type'];
        }

        // Amazon rejects the app user agent for the notifications API with "400 ThrottlingException"
        if (!flags.cleanHeader && path.startsWith('/api/notifications')) {
            options.headers['User-Agent'] = notificationsUserAgent;
        }

        if (flags.headers) {
            Object.keys(flags.headers).forEach(n => {
                options.headers[n] = flags.headers![n];
            });
        }

        // Do not log sensitive or noisy headers
        const logOptions = JSON.parse(JSON.stringify(options));
        delete logOptions.headers.Cookie;
        delete logOptions.headers.csrf;
        delete logOptions.headers['Accept-Encoding'];
        delete logOptions.headers['User-Agent'];
        delete logOptions.headers['Content-Type'];
        delete logOptions.headers.Accept;
        delete logOptions.headers.Referer;
        delete logOptions.headers.Origin;
        delete logOptions.headers.authorization;
        delete logOptions.headers.authority;
        delete logOptions.headers['user-agent'];
        this._options.logger?.(
            `Alexa-Remote: Sending Request with ${JSON.stringify(logOptions)} ${options.headers.authorization ? '+AccessToken' : ''}${options.method === 'POST' || options.method === 'PUT' || options.method === 'DELETE' ? ` and data=${flags.data}` : ''}`,
        );

        let req: ClientRequest;
        let responseReceived = false;
        try {
            req = https.request(options, res => {
                const chunks: Buffer[] = [];

                res.on('data', chunk => {
                    chunks.push(chunk);
                });

                res.on('end', () => {
                    responseReceived = true;
                    if (typeof callback === 'function') {
                        const resBuffer = Buffer.concat(chunks);
                        // Decompress the response if needed
                        const encoding = res.headers['content-encoding'];
                        if (encoding === 'gzip') {
                            zlib.gunzip(resBuffer, (err, decoded) => {
                                if (typeof callback === 'function') {
                                    handleResponse(err, res, decoded?.toString());
                                } else {
                                    this._options.logger?.(
                                        `Alexa-Remote: Response Status ${res.statusCode}: ${decoded?.toString()}`,
                                    );
                                }
                            });
                        } else if (encoding === 'deflate') {
                            zlib.inflate(resBuffer, (err, decoded) => {
                                if (typeof callback === 'function') {
                                    handleResponse(err, res, decoded?.toString());
                                } else {
                                    this._options.logger?.(
                                        `Alexa-Remote: Response Status ${res.statusCode}: ${decoded?.toString()}`,
                                    );
                                }
                            });
                        } else {
                            if (typeof callback === 'function') {
                                handleResponse(null, res, resBuffer.toString());
                            } else {
                                this._options.logger?.(
                                    `Alexa-Remote: Response Status ${res.statusCode}: ${resBuffer.toString()}`,
                                );
                            }
                        }
                    }
                });
            });
        } catch (err: any) {
            this._options.logger?.(`Alexa-Remote: Response: Exception: ${err}`);
            if (typeof callback === 'function' /* && callback.length >= 2*/) {
                callback(err, null);
                callback = null;
            }
            return;
        }

        req.on('error', e => {
            this._options.logger?.(`Alexa-Remote: Response: Error: ${e}`);
            if (!responseReceived && typeof callback === 'function' /* && callback.length >= 2*/) {
                callback(e, null);
                callback = null;
            }
        });

        req.on('timeout', () => {
            if (!responseReceived && typeof callback === 'function' /* && callback.length >= 2*/) {
                this._options.logger?.('Alexa-Remote: Response: Timeout');
                callback(new Error('Timeout'), null);
                callback = null;
            }
        });

        req.on('close', () => {
            if (!responseReceived && typeof callback === 'function' /* && callback.length >= 2*/) {
                this._options.logger?.('Alexa-Remote: Response: Closed');
                callback(new Error('Connection Closed'), null);
                callback = null;
            }
        });

        if (flags?.data) {
            req.write(flags.data);
        }

        req.end();
    }

    /// Public
    /**
     * Checks if the current cookie is still authenticated.
     * Amazon removed `/api/bootstrap`, so `/api/customer-status` is used: every successful answer means authenticated.
     *
     * @param callback called with (authenticated, error); authenticated is null if the state could not be determined
     */
    checkAuthentication(callback: AuthenticationCallback): void {
        // If we don't have a cookie assigned, we can't be authenticated
        if (this.cookie && this.csrf) {
            this.httpsGetCall('/api/customer-status', (err, res) => {
                if (!err && res) {
                    return callback(true, null);
                }
                if (err && !err.message.includes('401')) {
                    return callback(null, err);
                }
                callback(false, err);
            });
        } else {
            callback(false, null);
        }
    }

    /**
     * Queries the region specific API endpoints (website API and Alexa API URL).
     *
     * @param callback called with (error, result)
     */
    getEndpoints(callback: CallbackWithErrorAndBody<Endpoints>): void {
        this.httpsGetCall('/api/endpoints', callback);
    }

    /**
     * Queries all devices of the account.
     *
     * @param callback called with (error, result)
     */
    getDevices(callback?: CallbackWithErrorAndBody<DevicesResponse>): void {
        this.httpsGet('/api/devices-v2/device?cached=true&_=%t', callback);
    }

    /**
     * Queries the cards (history entries) shown in the Alexa app.
     *
     * @param limit maximum number of cards (or the callback, defaults to 10)
     * @param beforeCreationTime only return cards created before this time (defaults to now)
     * @param callback called with (error, result)
     */
    getCards(
        limit: number | CallbackWithErrorAndBody,
        beforeCreationTime?: string | number | CallbackWithErrorAndBody,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof limit === 'function') {
            callback = limit;
            limit = 10;
        }
        if (typeof beforeCreationTime === 'function') {
            callback = beforeCreationTime;
            beforeCreationTime = '%t';
        }
        if (beforeCreationTime === undefined) {
            beforeCreationTime = '%t';
        }
        this.httpsGet(`/api/cards?limit=${limit}&beforeCreationTime=${beforeCreationTime}000&_=%t`, callback);
    }

    /**
     * Queries information about the current user.
     *
     * @param callback called with (error, result)
     */
    getUsersMe(callback?: CallbackWithErrorAndBody): void {
        this.httpsGetCall('/api/users/me?platform=ios&version=2.2.651540.0', callback);
    }

    /**
     * Queries the household (members) of the account.
     *
     * @param callback called with (error, result)
     */
    getHousehold(callback?: CallbackWithErrorAndBody): void {
        this.httpsGet('/api/household', callback);
    }

    /**
     * Queries the media state (volume, playing item, ...) of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getMedia(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(
            `/api/media/state?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}&screenWidth=1392&_=%t`,
            callback,
        );
    }

    /**
     * Queries the player information (current track, progress, ...) of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getPlayerInfo(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(
            `/api/np/player?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}&screenWidth=1392&_=%t`,
            callback,
        );
    }

    /**
     * Converts a list of the V2 API into the format of the old API (best effort).
     *
     * @param list list as returned by the V2 API
     * @returns list in the old format
     */
    private mapListV2(list: Partial<ListV2> & { totalActiveItemsCount?: string }): Record<string, any> {
        let count = null;
        try {
            // the requested aggregation is delivered as JSON string in aggregatedAttributes: '{"count":3,"hasMore":false}'
            count = JSON.parse(
                list.aggregatedAttributes?.totalActiveItemsCount ?? list.totalActiveItemsCount ?? '',
            ).count;
        } catch {
            // Ignore
        }
        return {
            id: Array.isArray(list.id) && list.id.length > 0 ? list.id[0] : list.listId,
            listId: list.listId,
            itemId: list.listId,
            name: list.listName || list.listType,
            createdDateTime: list.createAt,
            updatedDateTime: list.updateAt,
            totalActiveItemsCount: count,
            ownerCustomerId: list.customerId,
        };
    }

    /**
     * Queries all lists (shopping list, to-do list and custom lists) in the format of the old API.
     *
     * @deprecated Use getListsV2 instead
     * @param callback called with (error, result)
     */
    getLists(callback?: CallbackWithErrorAndBody): void {
        this.getListsV2((err, lists) => {
            if (err) {
                this._options.logger?.(`Alexa-Remote: Error getting lists: ${err.message}`);
                return callback?.(err);
            }
            callback?.(
                null,
                (lists || []).map((list: any) => this.mapListV2(list)),
            );
        });
    }

    /**
     * Queries all lists (shopping list, to-do list and custom lists) using the V2 lists API.
     *
     * @param callback called with (error, lists)
     */
    getListsV2(callback?: CallbackWithErrorAndBody<ListV2[]>): void {
        const request = {
            method: 'POST',
            data: JSON.stringify({
                listAttributesToAggregate: [{ type: 'totalActiveItemsCount' }],
                listOwnershipType: null,
            }),
        };

        this.httpsGet(
            `https://www.${this._options.amazonPage}/alexashoppinglists/api/v2/lists/fetch`,
            (err, res) => callback?.(err, res?.listInfoList),
            request,
        );
    }

    /**
     * Queries a single list in the format of the old API.
     *
     * @deprecated Use getListV2 instead
     * @param listId ID of the list
     * @param callback called with (error, result)
     */
    getList(listId: string, callback?: CallbackWithErrorAndBody): void {
        this.getListV2(listId, (err, list) => {
            if (err) {
                this._options.logger?.(`Alexa-Remote: Error getting lists: ${err.message}`);
                return callback?.(err);
            }
            callback?.(null, this.mapListV2(list || {}));
        });
    }

    /**
     * Queries a single list using the V2 lists API.
     *
     * @param listId ID of the list
     * @param callback called with (error, list)
     * @param limit maximum number of items to fetch (defaults to 100)
     */
    getListV2(listId: string, callback?: CallbackWithErrorAndBody<ListV2>, limit?: number): void {
        const request = {
            method: 'POST',
            data: JSON.stringify({
                listAttributesToAggregate: [{ type: 'totalActiveItemsCount' }],
            }),
        };

        this.httpsGet(
            `https://www.${this._options.amazonPage}/alexashoppinglists/api/v2/lists/${listId}/items/fetch?limit=${limit || 100}`,
            (err, res) => callback?.(err, res?.listInfo),
            request,
        );
    }

    /**
     * Get items from a list in the format of the old API.
     *
     * @deprecated Use getListItemsV2 instead
     * @param listId List ID to retrieve items from
     * @param [options] options of the request
     * @param [options.limit] maximum number of items to retrieve (defaults to 100)
     * @param callback callback with error and list items
     */
    getListItems(
        listId: string,
        options?: ListItemOptions | CallbackWithErrorAndBody,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        this.getListItemsV2(listId, options, (err, items) => {
            if (err) {
                this._options.logger?.(`Alexa-Remote: Error getting list: ${err.message}`);
                return callback?.(err);
            }
            const mappedItems = (items || []).map((item: any) => ({
                id: item.itemId,
                listId: item.listId,
                value: item.itemName,
                customerId: item.customerId,
                completed: item.itemStatus === 'COMPLETE',
                createdDateTime: item.createAt,
                updatedDateTime: item.updateAt,
                version: item.version,
                note: item.note,
            }));
            callback?.(null, mappedItems);
        });
    }

    /**
     * Get items from a list using the V2 lists API.
     *
     * @param listId List ID to retrieve items from
     * @param [options] options of the request
     * @param [options.limit] maximum number of items to retrieve (defaults to 100)
     * @param callback callback with error and list items
     */
    getListItemsV2(
        listId: string,
        options?: ListItemOptions | CallbackWithErrorAndBody<ListItemV2[]>,
        callback?: CallbackWithErrorAndBody<ListItemV2[]>,
    ): void {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        options ||= {};

        if (!listId) {
            this._options.logger?.('Alexa-Remote: Error getting list items: No listId provided');
            return callback?.(new Error('No listId provided'));
        }

        const request = {
            method: 'POST',
            data: JSON.stringify({
                itemAttributesToProject: ['quantity', 'note'],
            }),
        };

        this.httpsGet(
            `https://www.${this._options.amazonPage}/alexashoppinglists/api/v2/lists/${listId}/items/fetch?limit=${options.limit || 100}`,
            (err, res) => callback?.(err, res?.itemInfoList),
            request,
        );
    }

    /**
     * Adds an item to a list.
     *
     * @param listId ID of the list
     * @param options text of the new item or an object with the text as `value`
     * @param callback called with (error, created items)
     */
    addListItem(
        listId: string,
        options: ListItemOptions | string,
        callback?: CallbackWithErrorAndBody<ListItemV2[]>,
    ): void {
        if (typeof options === 'string') {
            options = { value: options };
        }

        const request = {
            method: 'POST',
            data: JSON.stringify({
                items: [
                    {
                        itemType: 'KEYWORD',
                        itemName: options.value,
                    },
                ],
            }),
        };

        this.httpsGet(
            `https://www.${this._options.amazonPage}/alexashoppinglists/api/v2/lists/${listId}/items`,
            (err, res) => callback?.(err, res?.itemInfoList),
            request,
        );
    }

    /**
     * Updates an item of a list. The current `version` and the new `value` must be provided in the options.
     * Optionally `completed` (or `itemStatus`), `note` and `quantity` can be changed.
     *
     * @param listId ID of the list
     * @param listItemId ID of the item
     * @param options item properties, at least `version` and `value`
     * @param callback called with (error, result); the error is an array of strings if mandatory options are missing
     * @returns false if mandatory options are missing
     */
    updateListItem(
        listId: string,
        listItemId: string,
        options: ListItemOptions,
        callback?: CallbackWithErrorAndBody,
    ): false | void {
        // providing a version is mandatory
        if (typeof options !== 'object' || !options.version || !options.value) {
            const errors: string[] = [];

            if (!options?.version && callback) {
                errors.push('Providing the current version via options is mandatory!');
            }

            if (!options?.value && callback) {
                errors.push('Providing a new value (description) via options is mandatory!');
            }

            callback?.(errors as any); // legacy: errors are reported as string array
            return false;
        }

        // Convert the options into the attributes of the V2 API
        const itemAttributesToUpdate: { type: string; value: any }[] = [];
        const itemAttributesToRemove: { type: string }[] = [];
        for (const key of Object.keys(options)) {
            switch (key) {
                case 'value':
                    itemAttributesToUpdate.push({ type: 'itemName', value: options.value });
                    break;
                case 'note':
                    // removing is not supported for now
                    if (options.note !== null && options.note !== undefined) {
                        itemAttributesToUpdate.push({ type: 'note', value: options.note });
                    }
                    break;
                case 'completed':
                    itemAttributesToUpdate.push({
                        type: 'itemStatus',
                        value: options.completed ? 'COMPLETE' : 'ACTIVE',
                    });
                    break;
                case 'itemStatus':
                    // itemStatus is ignored if completed is given
                    if (options.completed === undefined) {
                        itemAttributesToUpdate.push({ type: 'itemStatus', value: options.itemStatus });
                    }
                    break;
                case 'quantity':
                    // removing is not supported for now
                    if (options.quantity !== null && options.quantity !== undefined) {
                        itemAttributesToUpdate.push({ type: 'quantity', value: options.quantity });
                    }
                    break;
            }
        }

        const request = {
            method: 'PUT',
            data: JSON.stringify({
                itemAttributesToUpdate,
                itemAttributesToRemove,
            }),
        };

        this.httpsGet(
            `https://www.${this._options.amazonPage}/alexashoppinglists/api/v2/lists/${listId}/items/${listItemId}?version=${options.version}`,
            (err, res) => callback?.(err, res?.itemInfoList),
            request,
        );
    }

    /**
     * Deletes an item from a list. The current `version` of the item must be provided in the options.
     *
     * @param listId ID of the list
     * @param listItemId ID of the item
     * @param options options with the current `version` of the item
     * @param callback called with (error, result); the error is an array of strings if the version is missing
     * @returns false if the version is missing
     */
    deleteListItem(
        listId: string,
        listItemId: string,
        options: ListItemOptions,
        callback?: CallbackWithErrorAndBody,
    ): false | void {
        // providing a version is mandatory
        if (typeof options !== 'object' || !options?.version) {
            // the callback may be given as third parameter (old signature)
            const cb = typeof options === 'function' ? (options as CallbackWithErrorAndBody) : callback;
            // legacy: errors are reported as string array
            cb?.(['Providing the current version via options is mandatory!'] as any);
            return false;
        }

        this.httpsGet(
            `https://www.${this._options.amazonPage}/alexashoppinglists/api/v2/lists/${listId}/items/${listItemId}?version=${options.version}`,
            callback,
            { method: 'DELETE' },
        );
    }

    /**
     * Queries the wake words of all devices.
     *
     * @param callback called with (error, result)
     */
    getWakeWords(callback?: CallbackWithErrorAndBody<WakeWordsResponse>): void {
        this.httpsGet(`/api/wake-word?_=%t`, callback);
    }

    /**
     * Alias of `getNotifications()`.
     *
     * @param cached true to allow cached data (or the callback)
     * @param callback called with (error, result)
     */
    getReminders(cached?: boolean | CallbackWithErrorAndBody, callback?: CallbackWithErrorAndBody): void {
        return this.getNotifications(cached, callback);
    }
    /**
     * Queries all notifications (alarms, timers and reminders).
     *
     * @param cached true to allow cached data (or the callback, defaults to true)
     * @param callback called with (error, result)
     */
    getNotifications(
        cached?: boolean | CallbackWithErrorAndBody<NotificationsResponse>,
        callback?: CallbackWithErrorAndBody<NotificationsResponse>,
    ): void {
        if (typeof cached === 'function') {
            callback = cached;
            cached = true;
        }
        if (cached === undefined) {
            cached = true;
        }
        this.httpsGet(`/api/notifications?cached=${cached}&_=%t`, callback);
    }

    /**
     * Queries the available notification sounds of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param alertType optional alert type (e.g. "Alarm" or "Timer") or the callback
     * @param callback called with (error, result)
     */
    getNotificationSounds(
        serialOrName: SerialOrName,
        alertType?: string | CallbackWithErrorAndBody<NotificationSoundsResponse>,
        callback?: CallbackWithErrorAndBody<NotificationSoundsResponse>,
    ): void {
        if (typeof alertType === 'function') {
            callback = alertType;
            alertType = '';
        }
        const device = this.find(serialOrName);
        if (!device) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(
            `/api/notification/sounds?deviceType=${device.deviceType}&deviceSerialNumber=${device.serialNumber}&softwareVersion=${device.softwareVersion}${alertType ? `&alertType=${alertType}` : ''}`,
            callback,
        );
    }

    // alarm volume
    /**
     * Queries the notification state (alarm volume) of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getDeviceNotificationState(
        serialOrName: SerialOrName,
        callback?: CallbackWithErrorAndBody<DeviceNotificationState>,
    ): void {
        const device = this.find(serialOrName);
        if (!device) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(
            `/api/device-notification-state/${device.deviceType}/${device.softwareVersion}/${device.serialNumber}`,
            callback,
        );
    }

    /**
     * Sets the alarm/notification volume of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param volumeLevel volume between 0 and 100
     * @param callback called with (error, result)
     */
    setDeviceNotificationVolume(
        serialOrName: SerialOrName,
        volumeLevel: number,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const device = this.find(serialOrName);
        if (!device) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(
            `/api/device-notification-state/${device.deviceType}/${device.softwareVersion}/${device.serialNumber}`,
            callback,
            {
                method: 'PUT',
                data: JSON.stringify({
                    volumeLevel,
                }),
            },
        );
    }

    /**
     * Sets the default sound for a notification type of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param notificationType notification type, e.g. "Alarm"
     * @param soundId ID of the sound (see `getNotificationSounds()`)
     * @param callback called with (error, result)
     */
    setDeviceNotificationDefaultSound(
        serialOrName: SerialOrName,
        notificationType: string,
        soundId: string,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const device = this.find(serialOrName);
        if (!device) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(`/api/notification/default-sound`, callback, {
            method: 'PUT',
            data: JSON.stringify({
                deviceType: device.deviceType,
                deviceSerialNumber: device.serialNumber,
                notificationType,
                soundId,
            }),
        });
    }

    /**
     * Queries the default sound for a notification type of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param notificationType notification type, e.g. "Alarm" or "Timer"
     * @param callback called with (error, result)
     */
    getDeviceNotificationDefaultSound(
        serialOrName: SerialOrName,
        notificationType: string,
        callback?: CallbackWithErrorAndBody<DefaultNotificationSoundResponse>,
    ): void {
        const device = this.find(serialOrName);
        if (!device) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(
            `/api/notification/default-sound?deviceType=${device.deviceType}&deviceSerialNumber=${device.serialNumber}&notificationType=${notificationType}`,
            callback,
        );
    }

    /**
     * Queries the "ascending alarm" state of all devices or of a single device.
     *
     * @param serialOrName device to return the state for (or the callback to get the states of all devices)
     * @param callback called with (error, result)
     */
    getAscendingAlarmState(callback?: CallbackWithErrorAndBody<AscendingAlarmState[]>): void;
    getAscendingAlarmState(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody<AscendingAlarmState>): void;
    getAscendingAlarmState(
        serialOrName?: SerialOrName | CallbackWithErrorAndBody,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof serialOrName === 'function') {
            callback = serialOrName;
            serialOrName = undefined;
        }
        const _serialOrName = serialOrName;

        this.httpsGet(`/api/ascending-alarm`, (err, res) => {
            if (_serialOrName) {
                const device = this.find(_serialOrName);
                if (!device) {
                    return callback?.(new Error('Unknown Device or Serial number'), null);
                }
                callback?.(
                    err,
                    res?.ascendingAlarmModelList?.find((d: any) => d.deviceSerialNumber === device.serialNumber),
                );
            } else {
                callback?.(err, res ? res.ascendingAlarmModelList : res);
            }
        });
    }

    /**
     * Enables or disables the "ascending alarm" (alarm volume increases slowly) of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param ascendingAlarmEnabled true to enable
     * @param callback called with (error, result)
     */
    setDeviceAscendingAlarmState(
        serialOrName: SerialOrName,
        ascendingAlarmEnabled: boolean,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const device = this.find(serialOrName);
        if (!device) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(`/api/ascending-alarm/${device.serialNumber}`, callback, {
            method: 'PUT',
            data: JSON.stringify({
                deviceSerialNumber: device.serialNumber,
                deviceType: device.deviceType,
                ascendingAlarmEnabled,
            }),
        });
    }

    /**
     * Queries the enabled skills of the account and returns a list of `{ id, name, type }` objects.
     *
     * @param callback called with (error, result)
     */
    getSkills(callback?: CallbackWithErrorAndBody): void {
        // request options
        const request = {
            method: 'GET',
            headers: {
                Accept: 'application/vnd+amazon.uitoolkit+json;ns=1;fl=0',
            },
        };

        // send request
        this.httpsGet(
            `https://skills-store.${this._options.amazonPage}/app/secure/your-skills-page?deviceType=app&ref-suffix=ysa_gw&pfm=A1PA6795UKMFR9&cor=DE&lang=en-us&_=%t`,
            (err, res) => {
                const data = res
                    .find((o: any) => o.block === 'data' && Array.isArray(o.contents))
                    .contents.find((o: any) => o.id === 'skillsPageData')
                    .contents.products.map((o: any) => ({
                        id: o.productMetadata.skillId,
                        name: o.title,
                        type: o.productDetails.skillTypes[0],
                    }));

                callback?.(err, data);
            },
            request,
        );
    }

    /**
     * Queries the multi room music groups.
     *
     * @param callback called with (error, result)
     */
    getWholeHomeAudioGroups(callback?: CallbackWithErrorAndBody): void {
        this.httpsGet('/api/wholeHomeAudio/v1/groups', (err, res) => callback?.(err, res?.groups));
    }

    /**
     * Creates a new notification object (alarm, timer or reminder) that can be passed to `createNotification()`.
     * For alarms the new V2 format is returned.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param type notification type: "Alarm", "Timer", "Reminder" or "MusicAlarm"
     * @param label label of the reminder or timer
     * @param value time of the notification: timestamp, Date, "HH:MM[:SS]" or "YYYY-MM-DD"; defaults to now + 5s
     * @param status truthy to create an active notification; can also be the sound object
     * @param sound sound object to use
     * @param recurring optional recurrence definition
     * @returns the notification object or null if the device is unknown
     */
    createNotificationObject(
        serialOrName: SerialOrName,
        type: string,
        label?: string | null,
        value?: Value | Date | Record<string, any> | null,
        status?: Status | boolean | Sound | null,
        sound?: Sound | string | null,
        recurring?: NotificationRecurrence | null,
    ): Notification | NotificationV2 | null {
        // type = Reminder, Alarm
        if (status && typeof status === 'object') {
            sound = status;
            status = 'ON';
        }
        if (value === null || value === undefined) {
            value = new Date().getTime() + 5000;
        }

        const dev = this.find(serialOrName);
        if (!dev) {
            return null;
        }

        const now = new Date();
        let notification: any = {
            alarmTime: now.getTime(), // will be overwritten
            createdDate: now.getTime(),
            type: type, // Alarm ...
            deviceSerialNumber: dev.serialNumber,
            deviceType: dev.deviceType,
            reminderLabel: type !== 'Timer' ? label || null : null,
            timerLabel: type === 'Timer' ? label || null : null,
            sound: sound && typeof sound === 'object' ? sound : null,
            /*{
                'displayName': 'Countertop',
                'folder': null,
                'id': 'system_alerts_repetitive_04',
                'providerId': 'ECHO',
                'sampleUrl': 'https://s3.amazonaws.com/deeappservice.prod.notificationtones/system_alerts_repetitive_04.mp3'
            }*/
            originalDate: `${now.getFullYear()}-${_00(now.getMonth() + 1)}-${_00(now.getDate())}`,
            originalTime: `${_00(now.getHours())}:${_00(now.getMinutes())}:${_00(now.getSeconds())}.000`,
            id: null,

            isRecurring: !!recurring,
            recurringPattern: null,

            timeZoneId: null,
            reminderIndex: null,

            isSaveInFlight: true,

            status: status ? 'ON' : 'OFF',
        };
        if (recurring) {
            notification.rRuleData = {
                byWeekDays: recurring.byDay,
                intervals: [recurring.interval],
                frequency: recurring.freq,
                flexibleRecurringPatternType: 'EVERY_X_WEEKS',
                notificationTimes: [notification.originalTime],
                recurStartDate: notification.originalDate,
                recurStartTime: '00:00:00.000',
            };
        }

        notification = this.parseValue4Notification(notification, value);

        // New style we need to add device!
        if (notification.trigger && notification.extensions) {
            notification.endpointId = `${dev.serialNumber}@${dev.deviceType}`;
            if (recurring) {
                notification.trigger.recurrence = recurring;
            }
        }

        return notification;
    }

    // TODO: Hack for now, make better and clean
    /**
     * Converts a (old style) notification into the V2 format that is used by the Alexa API for alarms.
     *
     * @param notification notification to convert
     * @returns notification in V2 format (or the unchanged notification if it is not an alarm)
     */
    convertNotificationToV2(notification: Notification): NotificationV2 {
        return this.parseValue4Notification(notification, null);
    }

    /**
     * Applies a new value to a notification and calculates the next trigger date/time.
     * If the resulting time is in the past, the next day is used.
     * For alarms (and on/off switching) an object in the V2 format is returned.
     *
     * @param notification notification to modify
     * @param value boolean (on/off), timestamp, Date, "HH:MM[:SS]", "YYYY-MM-DD" or an object with properties to merge
     * @returns the modified notification or the V2 alarm object
     */
    parseValue4Notification(
        notification: Notification,
        value: Value | Date | Record<string, any> | null | undefined,
    ): Notification | NotificationV2 {
        let dateOrTimeAdjusted = false;
        switch (typeof value) {
            case 'object':
                if (value instanceof Date) {
                    if (notification.type !== 'Timer') {
                        notification.alarmTime = value.getTime();
                        notification.originalDate = `${value.getFullYear()}-${_00(value.getMonth() + 1)}-${_00(value.getDate())}`;
                        notification.originalTime = `${_00(value.getHours())}:${_00(value.getMinutes())}:${_00(value.getSeconds())}.000`;
                        dateOrTimeAdjusted = true;
                    }
                } else {
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
                }
                break;
            case 'number':
                if (notification.type !== 'Timer') {
                    value = new Date(value);
                    notification.alarmTime = value.getTime();
                    notification.originalDate = `${value.getFullYear()}-${_00(value.getMonth() + 1)}-${_00(value.getDate())}`;
                    notification.originalTime = `${_00(value.getHours())}:${_00(value.getMinutes())}:${_00(value.getSeconds())}.000`;
                    dateOrTimeAdjusted = true;
                }
                break;
            case 'boolean':
                notification.status = value ? 'ON' : 'OFF';
                break;
            case 'string': {
                if (notification.type !== 'Timer') {
                    const date = new Date(notification.alarmTime as number);
                    if (value.match(/^\d{4}-\d{1,2}-\d{1,2}$/)) {
                        // Does not work that way!!
                        const ar = value.split('-');
                        date.setFullYear(Number(ar[0]));
                        date.setMonth(Number(ar[1]) - 1);
                        date.setDate(Number(ar[2]));
                        notification.originalDate = `${date.getFullYear()}-${_00(date.getMonth() + 1)}-${_00(date.getDate())}`;
                        dateOrTimeAdjusted = true;
                    } else if (value.match(/^\d{1,2}:\d{1,2}:?\d{0,2}$/)) {
                        const ar = value.split(':');
                        date.setHours(
                            parseInt(ar[0], 10),
                            ar.length > 1 ? parseInt(ar[1], 10) : 0,
                            ar.length > 2 ? parseInt(ar[2], 10) : 0,
                        );
                        notification.originalTime = `${_00(date.getHours())}:${_00(date.getMinutes())}:${_00(date.getSeconds())}.000`;
                        dateOrTimeAdjusted = true;
                    }
                }
                break;
            }
        }

        // If the resulting time is in the past, move it to the next day
        const originalDateTime = `${notification.originalDate} ${notification.originalTime}`;
        const bits = originalDateTime.split(/\D/);
        const date = new Date(
            Number(bits[0]),
            Number(bits[1]) - 1,
            Number(bits[2]),
            Number(bits[3]),
            Number(bits[4]),
            Number(bits[5]),
        );
        if (date.getTime() < Date.now()) {
            date.setDate(date.getDate() + 1);
            notification.originalDate = `${date.getFullYear()}-${_00(date.getMonth() + 1)}-${_00(date.getDate())}`;
            notification.originalTime = `${_00(date.getHours())}:${_00(date.getMinutes())}:${_00(date.getSeconds())}.000`;
        }

        if (
            (typeof value === 'boolean' || value === null || dateOrTimeAdjusted) &&
            (notification.type === 'Alarm' || notification.type === 'MusicAlarm')
        ) {
            // Alarms are managed via the new Alexa API: convert to the V2 format
            const trigger: NonNullable<NotificationV2['trigger']> = {
                scheduledTime: `${notification.originalDate}T${notification.originalTime!.substring(0, notification.originalTime!.length - 4)}`,
            };
            // The V2 API replaces the whole alarm, so the recurrence must be sent too, otherwise it is lost
            const recurrence = getNotificationRecurrence(notification);
            if (recurrence) {
                trigger.recurrence = recurrence;
            }
            const newPutNotification: NotificationV2 = {
                trigger,
                extensions: [],
            };
            if (notification.sound?.id && !notification.musicAlarmId) {
                newPutNotification.assets = [
                    {
                        type: 'TONE',
                        assetId: notification.sound.id,
                    },
                ];
            } else if (notification.musicAlarmId) {
                newPutNotification.assets = [
                    {
                        type: 'TONE',
                        assetId: `MUSIC-${notification.musicAlarmId}`,
                    },
                ];
            }
            return newPutNotification;
        }

        return notification;
    }

    /**
     * Creates a notification on Amazon (see `createNotificationObject()`).
     *
     * @param notification notification object (old style or V2 alarm)
     * @param callback called with (error, result)
     */
    createNotification(notification: Notification | NotificationV2, callback?: CallbackWithErrorAndBody): void {
        // Alarm new style
        if (notification.trigger && notification.extensions) {
            const flags = {
                method: 'POST',
                data: JSON.stringify(notification),
            };
            return this.httpsGetAuthApi(`/v1/alerts/alarms`, callback, flags);
        }

        const flags = {
            data: JSON.stringify(notification),
            method: 'PUT',
        };
        this.httpsGet(`/api/notifications/null`, callback, flags);
    }

    /**
     * Changes an existing notification, e.g. switches it on/off or changes the time.
     *
     * @param notification existing notification (as returned by `getNotifications()`)
     * @param value new value (see `parseValue4Notification()`)
     * @param callback called with (error, result)
     */
    changeNotification(
        notification: Notification,
        value: Value | Date | Record<string, any> | null,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const finalNotification = this.parseValue4Notification(notification, value);

        if (finalNotification.trigger && finalNotification.assets && finalNotification.extensions) {
            if (typeof value === 'boolean') {
                // Switch on/off
                if (value) {
                    return this.activateNotificationV2(
                        notification.notificationIndex as string,
                        finalNotification,
                        callback,
                    );
                }
                return this.deactivateNotificationV2(notification.notificationIndex as string, callback);
            }

            return this.setNotificationV2(notification.notificationIndex as string, finalNotification, callback);
        }

        return this.setNotification(finalNotification, callback);
    }

    /**
     * Updates a notification (old API).
     *
     * @param notification notification to store
     * @param callback called with (error, result)
     */
    setNotification(notification: Notification, callback?: CallbackWithErrorAndBody): void {
        if (notification.type === 'Reminder') {
            delete notification.alarmTime;
            delete notification.originalTime;
            delete notification.originalDate;
        }
        if (notification.rRuleData) {
            delete notification.rRuleData.recurrenceRules;
            if (notification.rRuleData.notificationTimes?.length || notification.recurringPattern === 'P1D') {
                notification.rRuleData.frequency = 'DAILY';
            } else {
                notification.rRuleData.frequency = 'WEEKLY';
            }
        }

        const flags = {
            method: 'PUT',
            data: JSON.stringify(notification),
        };
        this.httpsGet(
            `/api/notifications/${notification.id}`,
            (err, res) => {
                //  {'Message':null}
                callback?.(err, res);
            },
            flags,
        );
    }

    /**
     * Updates an alarm using the V2 Alexa API.
     *
     * @param notificationIndex index of the alarm
     * @param notification alarm in V2 format
     * @param callback called with (error, result)
     */
    setNotificationV2(
        notificationIndex: string,
        notification: NotificationV2,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const flags = {
            method: 'PUT',
            data: JSON.stringify(notification),
        };
        this.httpsGetAuthApi(`/v1/alerts/alarms/${notificationIndex}`, callback, flags);
    }

    /**
     * Activates an alarm using the V2 Alexa API.
     *
     * @param notificationIndex index of the alarm
     * @param notification alarm in V2 format
     * @param callback called with (error, result)
     */
    activateNotificationV2(
        notificationIndex: string,
        notification: NotificationV2,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const flags = {
            method: 'PUT',
            data: JSON.stringify(notification),
        };
        this.httpsGetAuthApi(`/v1/alerts/alarms/${notificationIndex}/activate`, callback, flags);
    }

    /**
     * Deactivates an alarm using the V2 Alexa API.
     *
     * @param notificationIndex index of the alarm
     * @param callback called with (error, result)
     */
    deactivateNotificationV2(notificationIndex: string, callback?: CallbackWithErrorAndBody): void {
        const flags = {
            method: 'PUT',
            data: '',
        };
        this.httpsGetAuthApi(`/v1/alerts/alarms/${notificationIndex}/cancel`, callback, flags);
    }

    /**
     * Deletes a notification.
     *
     * @param notification notification to delete
     * @param callback called with (error, result)
     */
    deleteNotification(notification: Notification, callback?: CallbackWithErrorAndBody): void {
        const flags = {
            data: JSON.stringify(notification),
            method: 'DELETE',
        };
        this.httpsGet(
            `/api/notifications/${notification.id}`,
            (err, res) => {
                //  {'Message':null}
                callback?.(err, res);
            },
            flags,
        );
    }

    /**
     * Cancels the next occurrence of an alarm or the current instance of a reminder.
     *
     * @param notification notification to cancel
     * @param callback called with (error, result)
     */
    cancelNotification(notification: Notification | NotificationV2, callback?: CallbackWithErrorAndBody): void {
        if (notification.type === 'Alarm' || notification.type === 'MusicAlarm') {
            const flags = {
                method: 'PUT',
            };

            this.httpsGetAuthApi(
                `/v1/alerts/alarms/${notification.notificationIndex}/nextOccurrence/cancel`,
                callback,
                flags,
            );
        } else if (notification.type === 'Reminder') {
            notification.status = 'INSTANCE_CANCELED';

            const flags = {
                data: JSON.stringify(notification),
                method: 'PUT',
            };
            this.httpsGet(`/api/notifications/${notification.id}`, callback, flags);
        }
    }

    /**
     * Alias of `getDeviceStatusList()`.
     *
     * @param callback called with (error, result)
     */
    getDoNotDisturb(callback?: CallbackWithErrorAndBody<DoNotDisturbStatusResponse>): void {
        return this.getDeviceStatusList(callback);
    }
    /**
     * Queries the "do not disturb" state of all devices.
     *
     * @param callback called with (error, result)
     */
    getDeviceStatusList(callback?: CallbackWithErrorAndBody<DoNotDisturbStatusResponse>): void {
        this.httpsGet(`/api/dnd/device-status-list?_=%t`, callback);
    }

    /**
     * Queries the bluetooth state (paired devices) of all devices.
     *
     * @param cached true to allow cached data (or the callback, defaults to true)
     * @param callback called with (error, result)
     */
    getBluetooth(
        cached?: boolean | CallbackWithErrorAndBody<BluetoothResponse>,
        callback?: CallbackWithErrorAndBody<BluetoothResponse>,
    ): void {
        if (typeof cached === 'function') {
            callback = cached;
            cached = true;
        }
        if (cached === undefined) {
            cached = true;
        }
        this.httpsGet(`/api/bluetooth?cached=${cached}`, callback);
    }

    /**
     * Searches for TuneIn stations; the query must already be URL encoded.
     *
     * @param query encoded search text
     * @param callback called with (error, result)
     */
    tuneinSearchRaw(query: string, callback?: CallbackWithErrorAndBody): void {
        // The customer ID of the owner is needed: query it once
        if (!this.ownerCustomerId) {
            this.getUsersMe((err, res) => {
                if (err || !res?.id) {
                    return callback?.(err, null);
                }
                this.ownerCustomerId = res.id;
                this.tuneinSearchRaw(query, callback);
            });
            return;
        }
        this.httpsGet(`/api/tunein/search?query=${query}&mediaOwnerCustomerId=${this.ownerCustomerId}&_=%t`, callback);
    }

    /**
     * Searches for TuneIn stations.
     *
     * @param query search text
     * @param callback called with (error, result)
     */
    tuneinSearch(query: string, callback?: CallbackWithErrorAndBody): void {
        query = querystring.escape(query);
        this.tuneinSearchRaw(query, callback);
    }

    /**
     * Plays a TuneIn station on a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param guideId ID of the station (see `tuneinSearch()`)
     * @param contentType content type (or the callback, defaults to "station")
     * @param callback called with (error, result)
     */
    setTunein(
        serialOrName: SerialOrName,
        guideId: string,
        contentType?: string | CallbackWithErrorAndBody,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof contentType === 'function') {
            callback = contentType;
            contentType = 'station';
        }
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        // The station is passed as double base64 encoded content token
        const encodedStationId = `["music/tuneIn/${contentType}Id","${guideId}"]|{"previousPageId":"TuneIn_SEARCH"}`;
        const encoding1 = Buffer.from(encodedStationId).toString('base64');
        const encoding2 = Buffer.from(encoding1).toString('base64');
        const tuneInJson = {
            contentToken: `music:${encoding2}`,
        };
        const flags = {
            data: JSON.stringify(tuneInJson),
            method: 'PUT',
        };
        this.httpsGet(
            `/api/entertainment/v1/player/queue?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}`,
            callback,
            flags,
        );

        /*
        this.httpsGet (`/api/tunein/queue-and-play
           ?deviceSerialNumber=${dev.serialNumber}
           &deviceType=${dev.deviceType}
           &guideId=${guideId}
           &contentType=${contentType}
           &callSign=
           &mediaOwnerCustomerId=${dev.deviceOwnerCustomerId}`, callback, { method: 'POST' });
         */
    }

    /**
     * Queries the voice history (V2 API, needs a valid CSRF token) and converts the entries into an activity
     * like format (with `description.summary` = what was said and `alexaResponse` = what Alexa answered).
     *
     * @param options query options (time range, record type, filter)
     * @param callback called with (error, result)
     */
    private _getCustomerHistoryRecords(
        options: GetCustomerHistoryRecordsOptions,
        callback?: CallbackWithErrorAndBody<CustomerHistoryEntry[]>,
    ): void {
        let url =
            `https://www.${this._options.amazonPage}/alexa-privacy/apd/rvh/customer-history-records-v2` +
            `?startTime=${options.startTime || Date.now() - 24 * 60 * 60 * 1000}` +
            `&endTime=${options.endTime || Date.now() + 24 * 60 * 60 * 1000}`;
        if (options.recordType && options.recordType !== 'VOICE_HISTORY') {
            url += `&pageType=${options.recordType}`;
        }
        // maxRecordSize is ignored by Amazon, always the last 10 records are returned
        this.httpsGet(
            url,
            (err, result) => {
                if (err || !result) {
                    return callback /*.length >= 2*/ && callback(err, result);
                }

                const ret = [];
                if (result.customerHistoryRecords) {
                    for (let r = 0; r < result.customerHistoryRecords.length; r++) {
                        const res = result.customerHistoryRecords[r];
                        const o: any = {
                            data: res,
                        };
                        const convParts: Record<string, any[]> = {};
                        if (res.voiceHistoryRecordItems && Array.isArray(res.voiceHistoryRecordItems)) {
                            res.voiceHistoryRecordItems.forEach((item: any) => {
                                convParts[item.recordItemType] ||= [];
                                convParts[item.recordItemType].push(item);
                            });
                            o.conversionDetails = convParts;
                        }

                        const recordKey = res.recordKey.split('#'); // A3NSX4MMJVG96V#1612297041815#A1RABVCI4QCIKC#G0911W0793360TLG

                        o.deviceType = recordKey[2] || null;
                        // o.deviceAccountId = res.sourceDeviceIds[i].deviceAccountId || null;
                        o.creationTimestamp = res.timestamp || null;
                        // o.activityStatus = res.activityStatus || null; // DISCARDED_NON_DEVICE_DIRECTED_INTENT, SUCCESS, FAIL, SYSTEM_ABANDONED

                        o.deviceSerialNumber = recordKey[3];
                        if (!this.serialNumbers[o.deviceSerialNumber]) {
                            continue;
                        }
                        o.name = this.serialNumbers[o.deviceSerialNumber].accountName;
                        const dev = this.find(o.deviceSerialNumber);
                        const wakeWord = dev?.wakeWord ? dev.wakeWord : null;

                        o.description = { summary: '' };
                        if (convParts.CUSTOMER_TRANSCRIPT || convParts.ASR_REPLACEMENT_TEXT) {
                            if (convParts.CUSTOMER_TRANSCRIPT) {
                                convParts.CUSTOMER_TRANSCRIPT.forEach(trans => {
                                    let text = trans.transcriptText;
                                    if (wakeWord && text.startsWith(wakeWord)) {
                                        text = text.substring(wakeWord.length).trim();
                                    } else if (text.startsWith('alexa')) {
                                        text = text.substring(5).trim();
                                    }
                                    o.description.summary += `${text}, `;
                                });
                            }
                            if (convParts.ASR_REPLACEMENT_TEXT) {
                                convParts.ASR_REPLACEMENT_TEXT.forEach(trans => {
                                    let text = trans.transcriptText;
                                    if (wakeWord && text.startsWith(wakeWord)) {
                                        text = text.substring(wakeWord.length).trim();
                                    } else if (text.startsWith('alexa')) {
                                        text = text.substring(5).trim();
                                    }
                                    o.description.summary += `${text}, `;
                                });
                            }
                            o.description.summary = o.description.summary
                                .substring(0, o.description.summary.length - 2)
                                .trim();
                        }
                        o.alexaResponse = '';
                        if (convParts.ALEXA_RESPONSE || convParts.TTS_REPLACEMENT_TEXT) {
                            if (convParts.ALEXA_RESPONSE) {
                                convParts.ALEXA_RESPONSE.forEach(
                                    trans => (o.alexaResponse += `${trans.transcriptText}, `),
                                );
                            }
                            if (convParts.TTS_REPLACEMENT_TEXT) {
                                convParts.TTS_REPLACEMENT_TEXT.forEach(
                                    trans => (o.alexaResponse += `${trans.transcriptText}, `),
                                );
                            }
                            o.alexaResponse = o.alexaResponse.substring(0, o.alexaResponse.length - 2).trim();
                        }
                        if (options.filter) {
                            if (!o.description || !o.description.summary.length) {
                                continue;
                            }

                            if (res.utteranceType === 'WAKE_WORD_ONLY') {
                                continue;
                            }

                            switch (o.description.summary) {
                                case 'stopp':
                                case 'alexa':
                                case 'echo':
                                case 'computer':
                                case 'amazon':
                                case 'ziggy':
                                case ',':
                                case '':
                                    continue;
                            }
                        }

                        if (o.description.summary || !options.filter) {
                            ret.push(o);
                        }
                    }
                }
                if (typeof callback === 'function') {
                    return callback(err, ret);
                }
            },
            {
                headers: {
                    authority: `www.${this._options.amazonPage}`,
                    'anti-csrftoken-a2z': this.activityCsrfToken,
                    referer: this.activityCsrfTokenReferer,
                },
                method: 'POST',
                data: '{"previousRequestToken": null}',
            },
        );
    }

    /**
     * Queries the voice history and converts the entries into an activity like format
     * (with `description.summary` = what was said and `alexaResponse` = what Alexa answered).
     * While the activity queue for push events is processed, only requests with `forceRequest` are allowed.
     * The CSRF token needed for the voice history is read from the activity page and cached for 2 hours.
     *
     * @param _options query options (time range, record type, filter, ...) or the callback
     * @param callback called with (error, result)
     */
    getCustomerHistoryRecords(
        _options?: GetCustomerHistoryRecordsOptions | CallbackWithErrorAndBody<CustomerHistoryEntry[]>,
        callback?: CallbackWithErrorAndBody<CustomerHistoryEntry[]>,
    ): void {
        let options: GetCustomerHistoryRecordsOptions;
        if (typeof _options === 'function') {
            callback = _options;
            options = {};
        } else {
            options = _options || {};
        }
        if (!options.forceRequest && this.activityUpdateQueue && this.activityUpdateQueue.length) {
            return callback?.(new Error('Activity update is running, please try again later.'));
        }

        if (this.activityCsrfToken && (this.activityCsrfTokenExpiry || 0) > Date.now()) {
            return this._getCustomerHistoryRecords(options, callback);
        }

        const csrfPageUrl = `https://www.${this._options.amazonPage}/alexa-privacy/apd/activity?disableGlobalNav=true&ref=activityHistory`;
        this.httpsGet(
            csrfPageUrl,
            (err, result) => {
                if (err || !result) {
                    return callback?.(err, result);
                }

                const csrfTokenRes = /meta name="csrf-token" content="([^"]+)"/.exec(result);
                if (csrfTokenRes?.[1]) {
                    this.activityCsrfToken = csrfTokenRes[1];
                    this.activityCsrfTokenExpiry = Date.now() + 2 * 60 * 60 * 1000;
                    this.activityCsrfTokenReferer = csrfPageUrl;

                    this._getCustomerHistoryRecords(options, callback);
                } else {
                    callback?.(new Error('CSRF Page has no token'), result);
                }
            },
            {
                handleAsText: true,
            },
        );
    }

    /**
     * Queries the communication accounts.
     *
     * @param includeActors true to include the actors (or the callback)
     * @param callback called with (error, result)
     */
    getAccount(
        includeActors?: boolean | CallbackWithErrorAndBody<CommsAccount[]>,
        callback?: CallbackWithErrorAndBody<CommsAccount[]>,
    ): void {
        if (typeof includeActors === 'function') {
            callback = includeActors;
            includeActors = false;
        }
        this.httpsGet(
            `https://alexa-comms-mobile-service.${this._options.amazonPage}/accounts${includeActors ? '?includeActors=true' : ''}`,
            callback,
        );
    }

    /**
     * Queries the contacts of the communication account.
     *
     * @param options query options (or the callback)
     * @param callback called with (error, result)
     */
    getContacts(
        options?: GetContactsOptions | CallbackWithErrorAndBody<Contact[]>,
        callback?: CallbackWithErrorAndBody<Contact[]>,
    ): void {
        if (typeof options === 'function') {
            callback = options;
            options = undefined;
        }
        if (options === undefined) {
            options = {};
        }
        if (options.includePreferencesByLevel === undefined) {
            options.includePreferencesByLevel = 'HomeGroup';
        }
        if (options.includeNonAlexaContacts === undefined) {
            options.includeNonAlexaContacts = true;
        }
        if (options.includeHomeGroupMembers === undefined) {
            options.includeHomeGroupMembers = true;
        }
        if (options.bulkImportOnly === undefined) {
            options.bulkImportOnly = false;
        }
        if (options.includeBlockStatus === undefined) {
            options.includeBlockStatus = false;
        }
        if (options.dedupeMode === undefined) {
            options.dedupeMode = 'RemoveCloudOnlyContactDuplicates';
        }
        if (options.homeGroupId === undefined) {
            options.homeGroupId = '';
        }

        this.httpsGet(
            `https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/contacts
            ?includePreferencesByLevel=${options.includePreferencesByLevel}
            &includeNonAlexaContacts=${options.includeNonAlexaContacts}
            &includeHomeGroupMembers=${options.includeHomeGroupMembers}
            &bulkImportOnly=${options.bulkImportOnly}
            &includeBlockStatus=${options.includeBlockStatus}
            &dedupeMode=${options.dedupeMode}
            &homeGroupId=${options.homeGroupId}`,
            (err, result) => {
                callback?.(err, result);
            },
        );
    }

    /**
     * Queries the conversations (messages) of the communication account.
     *
     * @param options query options (or the callback)
     * @param callback called with (error, result)
     */
    getConversations(
        options?: GetConversationsOptions | CallbackWithErrorAndBody,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof options === 'function') {
            callback = options;
            options = undefined;
        }
        options ??= {};
        options.latest ??= true;
        options.includeHomegroup ??= true;
        options.unread ??= false;
        options.modifiedSinceDate ??= '1970-01-01T00:00:00.000Z';
        options.includeUserName ??= true;

        this.httpsGet(
            `https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/conversations
            ?latest=${options.latest}
            &includeHomegroup=${options.includeHomegroup}
            &unread=${options.unread}
            &modifiedSinceDate=${options.modifiedSinceDate}
            &includeUserName=${options.includeUserName}`,
            (err, result) => callback?.(err, result),
        );
    }

    /**
     * Connects a device with a paired bluetooth device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param btAddress address of the bluetooth device
     * @param callback called with (error, result)
     */
    connectBluetooth(serialOrName: SerialOrName, btAddress: string, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const flags = {
            data: JSON.stringify({ bluetoothDeviceAddress: btAddress }),
            method: 'POST',
        };
        this.httpsGet(`/api/bluetooth/pair-sink/${dev.deviceType}/${dev.serialNumber}`, callback, flags);
    }

    /**
     * Disconnects the bluetooth connection of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param _btAddress address of the bluetooth device (not needed by the API)
     * @param callback called with (error, result)
     */
    disconnectBluetooth(serialOrName: SerialOrName, _btAddress: string, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const flags = {
            // data: JSON.stringify({ bluetoothDeviceAddress: btAddress}),
            method: 'POST',
        };
        this.httpsGet(`/api/bluetooth/disconnect-sink/${dev.deviceType}/${dev.serialNumber}`, callback, flags);
    }

    /**
     * Enables or disables "do not disturb" for a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param enabled true to enable
     * @param callback called with (error, result)
     */
    setDoNotDisturb(serialOrName: SerialOrName, enabled: boolean, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const flags = {
            data: JSON.stringify({
                deviceSerialNumber: dev.serialNumber,
                deviceType: dev.deviceType,
                enabled: enabled,
            }),
            method: 'PUT',
        };
        this.httpsGet(`/api/dnd/status`, callback, flags);
    }

    /**
     * Finds a device by serial number, account name (case insensitive) or friendly name.
     *
     * @param serialOrName serial number, name or the device object itself
     * @returns the device object or null/undefined if not found
     */
    find(serialOrName: SerialOrName | null | undefined): Serial | null | undefined {
        if (typeof serialOrName === 'object') {
            return serialOrName;
        }
        if (!serialOrName) {
            return null;
        }
        let dev = this.serialNumbers[serialOrName];
        if (dev !== undefined) {
            return dev;
        }
        dev = this.names[serialOrName];
        if (!dev && typeof serialOrName === 'string') {
            dev = this.names[serialOrName.toLowerCase()];
        }
        if (!dev) {
            dev = this.friendlyNames[serialOrName];
        }
        return dev;
    }

    /**
     * Sets the alarm volume of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param volume volume between 0 and 100
     * @param callback called with (error, result)
     */
    setAlarmVolume(serialOrName: SerialOrName, volume: number, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const flags = {
            data: JSON.stringify({
                deviceSerialNumber: dev.serialNumber,
                deviceType: dev.deviceType,
                softwareVersion: dev.softwareVersion,
                volumeLevel: volume,
            }),
            method: 'PUT',
        };
        this.httpsGet(
            `/api/device-notification-state/${dev.deviceType}/${dev.softwareVersion}/${dev.serialNumber}`,
            callback,
            flags,
        );
    }

    /**
     * Alias of `sendMessage()`.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param command player command
     * @param value value for the command
     * @param callback called with (error, result)
     */
    sendCommand(
        serialOrName: SerialOrName,
        command: MessageCommands,
        value: Value | null | undefined,
        callback?: CallbackWithErrorAndBody,
    ): void {
        return this.sendMessage(serialOrName, command, value, callback);
    }
    /**
     * Sends a player command (play, pause, next, volume, shuffle, ...) to a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param command player command
     * @param value value for the command (e.g. volume level, "on"/true for shuffle/repeat, media id for jump)
     * @param callback called with (error, result)
     */
    sendMessage(
        serialOrName: SerialOrName,
        command: MessageCommands,
        value: Value | null | undefined,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const commandObj: Record<string, any> = { contentFocusClientId: null };
        switch (command) {
            case 'play':
            case 'pause':
            case 'next':
            case 'previous':
            case 'forward':
            case 'rewind':
                commandObj.type = `${command.substring(0, 1).toUpperCase() + command.substring(1)}Command`;
                break;
            case 'volume':
                commandObj.type = 'VolumeLevelCommand';
                commandObj.volumeLevel = ~~(value as number);
                if (commandObj.volumeLevel < 0 || commandObj.volumeLevel > 100) {
                    return callback?.(new Error('Volume needs to be between 0 and 100'));
                }
                break;
            case 'shuffle':
                commandObj.type = 'ShuffleCommand';
                commandObj.shuffle = value === 'on' || value === true;
                break;
            case 'repeat':
                commandObj.type = 'RepeatCommand';
                commandObj.repeat = value === 'on' || value === true;
                break;
            case 'jump':
                commandObj.type = 'JumpCommand';
                commandObj.mediaId = value;
                break;
            default:
                return;
        }

        this.httpsGet(`/api/np/command?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}`, callback, {
            method: 'POST',
            data: JSON.stringify(commandObj),
        });
    }

    /**
     * Creates a single node of a routine sequence for the given command.
     *
     * @param command sequence command (e.g. "speak", "volume", "weather")
     * @param value value of the command (e.g. text to speak or volume level)
     * @param serialOrName device(s) to execute the command on
     * @param overrideCustomerId optional customer id to use instead of the one of the device
     * @returns the sequence node, or null/undefined for unsupported commands or values
     */
    createSequenceNode(
        command: SequenceNodeCommand,
        value: any,
        serialOrName?: SerialOrNameOrArray | null,
        overrideCustomerId?: string | null,
    ): SequenceNode | null | undefined {
        // Placeholders are replaced by the values of the device in sendSequenceCommand()
        let deviceSerialNumber = 'ALEXA_CURRENT_DSN';
        let deviceType = 'ALEXA_CURRENT_DEVICE_TYPE';
        let deviceOwnerCustomerId = 'ALEXA_CUSTOMER_ID';
        let deviceAccountId: string | undefined;
        let deviceFamily: string | undefined;
        let deviceTimezoneId: string | undefined;
        if (serialOrName && !Array.isArray(serialOrName)) {
            const currDevice = this.find(serialOrName);
            if (currDevice) {
                deviceSerialNumber = currDevice.serialNumber;
                deviceType = currDevice.deviceType;
                deviceOwnerCustomerId = currDevice.deviceOwnerCustomerId;
                deviceAccountId = currDevice.deviceAccountId;
                deviceFamily = currDevice.deviceFamily;
                if (currDevice.preferences?.timeZoneId !== undefined) {
                    deviceTimezoneId = currDevice.preferences.timeZoneId;
                }
            }
        } else {
            const currDevice = this.find(Array.isArray(serialOrName) ? serialOrName[0] : null);
            if (currDevice) {
                if (currDevice.preferences?.timeZoneId !== undefined) {
                    deviceTimezoneId = currDevice.preferences.timeZoneId;
                }
            }
        }
        if (overrideCustomerId) {
            deviceOwnerCustomerId = overrideCustomerId;
        }
        const seqNode: SequenceNode = {
            '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
            operationPayload: {
                deviceType: deviceType,
                deviceSerialNumber: deviceSerialNumber,
                locale: 'ALEXA_CURRENT_LOCALE',
                customerId: deviceOwnerCustomerId,
            },
        };
        // Each command maps to a routine operation type with its specific payload
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
            case 'funfact':
                seqNode.type = 'Alexa.FunFact.Play';
                break;
            case 'joke':
                seqNode.type = 'Alexa.Joke.Play';
                break;
            case 'cleanup':
                seqNode.type = 'Alexa.CleanUp.Play';
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
            case 'wait':
                seqNode.type = 'Alexa.System.Wait';
                seqNode.operationPayload.waitTimeInSeconds = parseInt(value, 10);
                break;
            case 'textCommand':
                seqNode.type = 'Alexa.TextCommand';
                seqNode.skillId = 'amzn1.ask.1p.tellalexa';
                seqNode.operationPayload.text = value.toString().toLowerCase();
                break;
            case 'sound':
                seqNode.type = 'Alexa.Sound';
                seqNode.skillId = 'amzn1.ask.1p.sound';
                seqNode.operationPayload.soundStringId = value.toString();
                break;
            case 'curatedtts': {
                const supportedValues = [
                    'goodbye',
                    'confirmations',
                    'goodmorning',
                    'compliments',
                    'birthday',
                    'goodnight',
                    'iamhome',
                ];
                if (!supportedValues.includes(value)) {
                    return null;
                }
                seqNode.type = 'Alexa.CannedTts.Speak';
                seqNode.operationPayload.cannedTtsStringId = `alexa.cannedtts.speak.curatedtts-category-${value}/alexa.cannedtts.speak.curatedtts-random`;
                break;
            }
            case 'fireTVTurnOn':
            case 'fireTVTurnOff':
            case 'fireTVTurnOnOff':
            case 'fireTVPauseVideo':
            case 'fireTVResumeVideo':
            case 'fireTVNavigateHome':
                if (!deviceAccountId) {
                    throw new Error('No deviceAccountId found');
                }
                if (!deviceFamily || deviceFamily !== 'FIRE_TV') {
                    throw new Error('Device is not a Fire TV');
                }
                if (command === 'fireTVTurnOnOff') {
                    command = value ? 'fireTVTurnOn' : 'fireTVTurnOff';
                }
                if (command === 'fireTVTurnOn') {
                    seqNode.type = 'Alexa.Operation.FireTV.TurnOn';
                } else if (command === 'fireTVTurnOff') {
                    seqNode.type = 'Alexa.Operation.FireTV.TurnOff';
                } else if (command === 'fireTVPauseVideo') {
                    seqNode.type = 'Alexa.Operation.FireTV.PauseVideo';
                } else if (command === 'fireTVResumeVideo') {
                    seqNode.type = 'Alexa.Operation.FireTV.ResumeVideo';
                } else if (command === 'fireTVNavigateHome') {
                    seqNode.type = 'Alexa.Operation.FireTV.NavigateHome';
                }
                seqNode.skillId = 'amzn1.ask.1p.routines.firetv';
                seqNode.operationPayload.deviceAccountId = deviceAccountId;
                delete seqNode.operationPayload.deviceType;
                delete seqNode.operationPayload.deviceSerialNumber;
                delete seqNode.operationPayload.locale;
                break;
            case 'volume':
                seqNode.type = 'Alexa.DeviceControls.Volume';
                value = ~~value;
                if (value < 0 || value > 100) {
                    throw new Error('Volume needs to be between 0 and 100');
                }
                seqNode.operationPayload.value = value;
                seqNode.skillId = 'amzn1.ask.1p.alexadevicecontrols';
                break;
            case 'deviceStop':
            case 'deviceStopAll':
                seqNode.type = 'Alexa.DeviceControls.Stop';
                if (command === 'deviceStopAll') {
                    seqNode.operationPayload.devices = [
                        {
                            deviceSerialNumber: 'ALEXA_ALL_DSN',
                            deviceType: 'ALEXA_ALL_DEVICE_TYPE',
                        },
                    ];
                } else {
                    seqNode.operationPayload.devices = [
                        {
                            deviceSerialNumber: deviceSerialNumber,
                            deviceType: deviceType,
                        },
                    ];

                    if (serialOrName && Array.isArray(serialOrName)) {
                        seqNode.operationPayload.devices = [];
                        serialOrName.forEach(deviceId => {
                            const currDevice = this.find(deviceId);
                            if (!currDevice) {
                                return;
                            }
                            seqNode.operationPayload.devices.push({
                                deviceSerialNumber: currDevice.serialNumber,
                                deviceType: currDevice.deviceType,
                            });
                        });
                    }
                }
                seqNode.skillId = 'amzn1.ask.1p.alexadevicecontrols';
                seqNode.operationPayload.isAssociatedDevice = false;
                delete seqNode.operationPayload.deviceType;
                delete seqNode.operationPayload.deviceSerialNumber;
                delete seqNode.operationPayload.locale;
                break;
            case 'deviceDoNotDisturb':
            case 'deviceDoNotDisturbAll': {
                seqNode.type = 'Alexa.DeviceControls.DoNotDisturb';
                if (command === 'deviceDoNotDisturbAll') {
                    seqNode.operationPayload.devices = [
                        {
                            deviceSerialNumber: 'ALEXA_ALL_DSN',
                            deviceTypeId: 'ALEXA_ALL_DEVICE_TYPE',
                        },
                    ];
                } else {
                    seqNode.operationPayload.devices = [
                        {
                            deviceSerialNumber: deviceSerialNumber,
                            deviceTypeId: deviceType,
                            deviceAccountId: deviceAccountId,
                        },
                    ];

                    if (serialOrName && Array.isArray(serialOrName)) {
                        seqNode.operationPayload.devices = [];
                        serialOrName.forEach(deviceId => {
                            const currDevice = this.find(deviceId);
                            if (!currDevice) {
                                return;
                            }
                            seqNode.operationPayload.devices.push({
                                deviceSerialNumber: currDevice.serialNumber,
                                deviceTypeId: currDevice.deviceType,
                                deviceAccountId: currDevice.deviceAccountId,
                            });
                        });
                    }
                }
                seqNode.operationPayload.isAssociatedDevice = false;
                seqNode.skillId = 'amzn1.ask.1p.alexadevicecontrols';
                seqNode.operationPayload.action = value ? 'Enable' : 'Disable';
                const valueType = typeof value;
                if (valueType === 'number' && value <= 12 * 60 * 60) {
                    const hours = Math.floor(value / 3600);
                    const minutes = Math.floor((value - hours * 3600) / 60);
                    const seconds = value - hours * 3600 - minutes * 60;
                    let durationString = 'DURATION#PT';
                    if (hours > 0) {
                        durationString += `${hours}H`;
                    }
                    durationString += `${minutes}M`;
                    durationString += `${seconds}S`;
                    seqNode.operationPayload.duration = durationString;
                    // seqNode.operationPayload.timeZoneId = 'Europe/Berlin';
                } else if (valueType === 'string') {
                    if (!/^\d{2}:\d{2}$/.test(value)) {
                        throw new Error('Invalid timepoint value provided');
                    }
                    seqNode.operationPayload.until = `TIME#T${value}`;
                    seqNode.operationPayload.timeZoneId = deviceTimezoneId || 'Europe/Berlin';
                } else if (valueType !== 'boolean') {
                    throw new Error('Invalid timepoint provided');
                }
                seqNode.operationPayload.isAssociatedDevice = false;
                delete seqNode.operationPayload.deviceType;
                delete seqNode.operationPayload.deviceSerialNumber;
                delete seqNode.operationPayload.locale;
                break;
            }
            case 'speak':
                seqNode.type = 'Alexa.Speak';
                if (typeof value !== 'string') {
                    value = String(value);
                }
                if (!this._options.amazonPage || !this._options.amazonPage.endsWith('.com')) {
                    // Use the decimal comma for non-English pages, otherwise numbers are spoken wrong
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
                value = value.replace(/ +/g, ' ');
                if (value.length === 0) {
                    throw new Error('Can not speak empty string');
                }
                if (value.length > 250) {
                    throw new Error('text too long, limit are 250 characters');
                }
                seqNode.skillId = 'amzn1.ask.1p.saysomething';
                seqNode.operationPayload.textToSpeak = value;
                break;
            case 'skill':
                seqNode.type = 'Alexa.Operation.SkillConnections.Launch';
                if (typeof value !== 'string') {
                    value = String(value);
                }
                if (value.length === 0) {
                    throw new Error('Can not launch empty skill');
                }
                seqNode.skillId = value;
                seqNode.operationPayload.targetDevice = {
                    deviceType: seqNode.operationPayload.deviceType,
                    deviceSerialNumber: seqNode.operationPayload.deviceSerialNumber,
                };
                seqNode.operationPayload.connectionRequest = {
                    uri: `connection://AMAZON.Launch/${value}`,
                    input: {},
                };
                seqNode.name = null;
                delete seqNode.operationPayload.deviceType;
                delete seqNode.operationPayload.deviceSerialNumber;
                break;
            case 'notification': {
                seqNode.type = 'Alexa.Notifications.SendMobilePush';
                let title = 'ioBroker';
                if (value && typeof value === 'object') {
                    title = value.title || title;
                    value = value.text || value.value;
                }
                if (typeof value !== 'string') {
                    value = String(value);
                }
                if (value.length === 0) {
                    throw new Error('Can not notify empty string');
                }
                seqNode.operationPayload.notificationMessage = value;
                seqNode.operationPayload.alexaUrl = '#v2/behaviors';
                seqNode.operationPayload.title = title;
                delete seqNode.operationPayload.deviceType;
                delete seqNode.operationPayload.deviceSerialNumber;
                delete seqNode.operationPayload.locale;
                seqNode.skillId = 'amzn1.ask.1p.routines.messaging';
                break;
            }
            case 'announcement':
            case 'ssml':
                seqNode.type = 'AlexaAnnouncement';
                if (typeof value !== 'string') {
                    value = String(value);
                }
                if (command === 'announcement') {
                    if (!this._options.amazonPage || !this._options.amazonPage.endsWith('.com')) {
                        // Use the decimal comma for non-English pages, otherwise numbers are spoken wrong
                        value = value.replace(/([^0-9]?[0-9]+)\.([0-9]+[^0-9])?/g, '$1,$2');
                    }
                    value = value.replace(/ +/g, ' ');
                    if (value.length === 0) {
                        throw new Error('Can not speak empty string');
                    }
                } else if (command === 'ssml') {
                    if (!value.startsWith('<speak>')) {
                        throw new Error('Value needs to be a valid SSML XML string');
                    }
                }
                seqNode.skillId = 'amzn1.ask.1p.routines.messaging';
                seqNode.operationPayload.expireAfter = 'PT5S';
                seqNode.operationPayload.content = [
                    {
                        locale: 'de-DE',
                        display: {
                            title: 'ioBroker',
                            body: value.replace(/<[^>]+>/g, ''),
                        },
                        speak: {
                            type: command === 'ssml' ? 'ssml' : 'text',
                            value: value,
                        },
                    },
                ];
                seqNode.operationPayload.target = {
                    customerId: deviceOwnerCustomerId,
                    devices: [
                        {
                            deviceSerialNumber: deviceSerialNumber,
                            deviceTypeId: deviceType,
                        },
                    ],
                };
                if (serialOrName && Array.isArray(serialOrName)) {
                    seqNode.operationPayload.target.devices = [];
                    serialOrName.forEach(deviceId => {
                        const currDevice = this.find(deviceId);
                        if (!currDevice) {
                            return;
                        }
                        seqNode.operationPayload.target.devices.push({
                            deviceSerialNumber: currDevice.serialNumber,
                            deviceTypeId: currDevice.deviceType,
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

    /**
     * Builds a (nested) serial or parallel node structure from a list of commands.
     *
     * @param serialOrName device(s) to execute the commands on (if not defined per command)
     * @param commands list of commands or nested node lists
     * @param sequenceType "SerialNode" (default) or "ParallelNode"
     * @param overrideCustomerId optional customer id to use instead of the one of the device
     * @returns node structure
     */
    buildSequenceNodeStructure(
        serialOrName: SerialOrNameOrArray,
        commands: MultiSequenceCommand[],
        sequenceType?: SequenceType | null,
        overrideCustomerId?: string | null,
    ): SequenceNodeStructure {
        if (!sequenceType) {
            sequenceType = 'SerialNode';
        } // or ParallelNode

        const nodes: (SequenceNode | SequenceNodeStructure)[] = [];
        for (const command of commands) {
            if ('nodes' in command && command.nodes) {
                const subSequence = this.buildSequenceNodeStructure(
                    serialOrName,
                    command.nodes,
                    command.sequenceType || sequenceType,
                    overrideCustomerId,
                );
                if (subSequence) {
                    nodes.push(subSequence);
                }
            } else {
                const nodeCommand = command as SequenceNodeDetails;
                const commandNode = this.createSequenceNode(
                    nodeCommand.command,
                    nodeCommand.value,
                    nodeCommand.device || serialOrName,
                    overrideCustomerId,
                );
                if (commandNode) {
                    nodes.push(commandNode);
                }
            }
        }

        return {
            '@type': `com.amazon.alexa.behaviors.model.${sequenceType}`,
            name: null,
            nodesToExecute: nodes,
        };
    }

    /**
     * Executes several commands as one routine sequence.
     *
     * @param serialOrName device(s) to execute the commands on
     * @param commands list of commands or nested node lists
     * @param sequenceType "SerialNode" (default) or "ParallelNode" (or the callback)
     * @param overrideCustomerId optional customer id (or the callback)
     * @param callback called with (error, result)
     */
    sendMultiSequenceCommand(
        serialOrName: SerialOrNameOrArray,
        commands: MultiSequenceCommand[],
        sequenceType?: SequenceType | CallbackWithErrorAndBody | null,
        overrideCustomerId?: string | CallbackWithErrorAndBody | null,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof sequenceType === 'function') {
            callback = sequenceType;
            sequenceType = undefined;
        }
        if (typeof overrideCustomerId === 'function') {
            callback = overrideCustomerId;
            overrideCustomerId = undefined;
        }
        try {
            const sequenceObj = {
                sequence: {
                    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
                    startNode: this.buildSequenceNodeStructure(
                        serialOrName,
                        commands,
                        sequenceType,
                        overrideCustomerId,
                    ),
                },
            };

            this.sendSequenceCommand(serialOrName, sequenceObj, callback);
        } catch (err: any) {
            callback?.(err, null);
        }
    }

    /**
     * Executes a single command (or a complete sequence object) as routine on the device(s).
     *
     * @param serialOrName device(s) to execute the command on
     * @param command sequence command or a complete sequence/routine object
     * @param value value of the command (or the callback)
     * @param overrideCustomerId optional customer id (or the callback)
     * @param callback called with (error, result)
     */
    sendSequenceCommand(
        serialOrName: SerialOrNameOrArray,
        command: SequenceNodeCommand | SequenceCommandObject,
        value?: any,
        overrideCustomerId?: string | CallbackWithErrorAndBody | null,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof overrideCustomerId === 'function') {
            callback = overrideCustomerId;
            overrideCustomerId = null;
        }

        const dev = this.find(Array.isArray(serialOrName) ? serialOrName[0] : serialOrName);
        if (!dev && !(typeof command === 'string' && command.endsWith('All'))) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        if (typeof value === 'function') {
            callback = value;
            value = null;
        }

        let seqCommandObj: SequenceCommandObject;
        if (typeof command === 'object') {
            seqCommandObj = command.sequence || command;
        } else {
            try {
                seqCommandObj = {
                    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
                    startNode: this.createSequenceNode(command, value, serialOrName, overrideCustomerId),
                };
            } catch (err: any) {
                return callback?.(err, null);
            }
        }

        // Routines with a sequence ID are executed by their automation ID, everything else as preview
        const reqObj = {
            behaviorId: seqCommandObj.sequenceId ? (command as SequenceCommandObject).automationId : 'PREVIEW',
            sequenceJson: JSON.stringify(seqCommandObj),
            status: 'ENABLED',
        };
        if (dev) {
            reqObj.sequenceJson = reqObj.sequenceJson.replace(
                /"deviceType":"ALEXA_CURRENT_DEVICE_TYPE"/g,
                `"deviceType":"${dev.deviceType}"`,
            );
            reqObj.sequenceJson = reqObj.sequenceJson.replace(
                /"deviceTypeId":"ALEXA_CURRENT_DEVICE_TYPE"/g,
                `"deviceTypeId":"${dev.deviceType}"`,
            );
            reqObj.sequenceJson = reqObj.sequenceJson.replace(
                /"deviceSerialNumber":"ALEXA_CURRENT_DSN"/g,
                `"deviceSerialNumber":"${dev.serialNumber}"`,
            );
            reqObj.sequenceJson = reqObj.sequenceJson.replace(
                /"customerId":"ALEXA_CUSTOMER_ID"/g,
                `"customerId":"${dev.deviceOwnerCustomerId}"`,
            );
        }
        // Replace the remaining placeholders
        reqObj.sequenceJson = reqObj.sequenceJson.replace(/"locale":"ALEXA_CURRENT_LOCALE"/g, `"locale":"de-DE"`);

        this.httpsGet(`/api/behaviors/preview`, callback, {
            method: 'POST',
            data: JSON.stringify(reqObj),
        });
    }

    /**
     * Queries the routines of the account.
     *
     * @param limit maximum number of routines (or the callback, defaults to 2000)
     * @param callback called with (error, result)
     */
    getAutomationRoutines(
        limit?: number | CallbackWithErrorAndBody<AutomationRoutine[]>,
        callback?: CallbackWithErrorAndBody<AutomationRoutine[]>,
    ): void {
        if (typeof limit === 'function') {
            callback = limit;
            limit = 0;
        }
        limit ||= 2000;
        this.httpsGet(`/api/behaviors/v2/automations?limit=${limit}`, callback, {
            timeout: 30000,
        });
    }

    /**
     * Executes a routine (as returned by `getAutomationRoutines()`).
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param routine routine object
     * @param callback called with (error, result)
     */
    executeAutomationRoutine(
        serialOrName: SerialOrName,
        routine: SequenceCommandObject | SequenceNodeCommand,
        callback?: CallbackWithErrorAndBody,
    ): void {
        return this.sendSequenceCommand(serialOrName, routine, callback);
    }

    /**
     * Get  the Skill catalog that can be used for routines
     *
     * @param catalogId string defaults to "Root"
     * @param limit number defaults to 100
     * @param callback response callback
     */
    getRoutineSkillCatalog(
        catalogId?: string | CallbackWithErrorAndBody<RoutineSkillCatalogResponse>,
        limit?: number | CallbackWithErrorAndBody<RoutineSkillCatalogResponse>,
        callback?: CallbackWithErrorAndBody<RoutineSkillCatalogResponse>,
    ): void {
        if (typeof limit === 'function') {
            callback = limit;
            limit = 100;
        }
        if (typeof catalogId === 'function') {
            callback = catalogId;
            catalogId = 'Root';
        }

        // request options
        const request = {
            method: 'POST',
            data: JSON.stringify({
                actions: [],
                triggers: [
                    {
                        skill: 'amzn1.ask.1p.customutterance',
                        type: 'CustomUtterance',
                    },
                ],
                limit,
            }),
        };

        // send request
        this.httpsGet(`/api/routines/catalog/action/${catalogId}`, callback, request);
    }

    /**
     * Queries the available music providers.
     *
     * @param callback called with (error, result)
     */
    getMusicProviders(callback?: CallbackWithErrorAndBody<MusicProvider[]>): void {
        this.httpsGet('/api/behaviors/entities?skillId=amzn1.ask.1p.music', callback, {
            headers: {
                'Routines-Version': '3.0.264101',
            },
        });
    }

    /**
     * Plays music from a music provider via a search phrase (like "Alexa, play ... on Spotify").
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param providerId ID of the music provider (see `getMusicProviders()`)
     * @param searchPhrase what to play
     * @param callback called with (error, result)
     */
    playMusicProvider(
        serialOrName: SerialOrName,
        providerId: string,
        searchPhrase: string,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }
        if (searchPhrase === '') {
            return callback?.(new Error('Searchphrase empty'), null);
        }

        const operationPayload = {
            deviceType: dev.deviceType,
            deviceSerialNumber: dev.serialNumber,
            locale: 'de-DE', // TODO!!
            customerId: dev.deviceOwnerCustomerId,
            musicProviderId: providerId,
            searchPhrase: searchPhrase,
        };

        const validateObj: Record<string, any> = {
            type: 'Alexa.Music.PlaySearchPhrase',
            operationPayload: JSON.stringify(operationPayload),
        };

        this.httpsGet(
            `/api/behaviors/operation/validate`,
            (err, res) => {
                if (err) {
                    return callback?.(err, res);
                }
                if (res.result !== 'VALID') {
                    return callback?.(new Error('Request invalid'), res);
                }
                validateObj.operationPayload = res.operationPayload;

                const seqCommandObj: SequenceCommandObject = {
                    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
                    startNode: validateObj,
                };
                seqCommandObj.startNode['@type'] = 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode';

                return this.sendSequenceCommand(serialOrName, seqCommandObj, callback);
            },
            {
                method: 'POST',
                data: JSON.stringify(validateObj),
            },
        );
    }

    /**
     * Plays an audible book via a search phrase.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param searchPhrase what to play
     * @param callback called with (error, result)
     */
    playAudible(serialOrName: SerialOrName, searchPhrase: string, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }
        if (searchPhrase === '') {
            return callback?.(new Error('Searchphrase empty'), null);
        }

        const operationPayload = {
            deviceType: dev.deviceType,
            deviceSerialNumber: dev.serialNumber,
            locale: 'de', // TODO!!
            customerId: dev.deviceOwnerCustomerId,
            searchPhrase: searchPhrase,
        };

        const validateObj: Record<string, any> = {
            type: 'Alexa.Audible.Read',
            operationPayload: JSON.stringify(operationPayload),
        };

        this.httpsGet(
            `/api/behaviors/operation/validate`,
            (err, res) => {
                if (err) {
                    return callback?.(err, res);
                }
                if (res.result !== 'VALID') {
                    return callback?.(new Error('Request invalid'), res);
                }
                validateObj.operationPayload = res.operationPayload;

                const seqCommandObj: SequenceCommandObject = {
                    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
                    startNode: validateObj,
                };
                seqCommandObj.startNode['@type'] = 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode';
                seqCommandObj.startNode.skillId = 'amzn1.ask.skill.3b150b52-cedb-4792-a4b2-f656523a06f5';

                return this.sendSequenceCommand(serialOrName, seqCommandObj, callback);
            },
            {
                method: 'POST',
                data: JSON.stringify(validateObj),
            },
        );
    }

    /*playFireTV(serialOrName, searchPhrase, callback) {
        const dev = this.find(serialOrName);
        if (!dev) return callback?.(new Error('Unknown Device or Serial number'), null);
        if (searchPhrase === '') return callback?.(new Error('Searchphrase empty'), null);

        if (dev.deviceFamily !== 'FIRE_TV') {
            return callback?.(new Error('Device is not a FireTV'), null);
        }

        const operationPayload = {
            //'deviceType': dev.deviceType,
            //'deviceSerialNumber': dev.serialNumber,
            'locale': 'de', // TODO!!
            'customerId': dev.deviceOwnerCustomerId,
            'deviceAccountId': dev.deviceAccountId,
            'searchPhrase': searchPhrase,
            'speakerId': 'ALEXA_CURRENT_SPEAKER_ID'
        };

        const validateObj: Record<string, any> = {
            'type': 'Alexa.Operation.Video.PlaySearchPhrase',
            'operationPayload': JSON.stringify(operationPayload)
        };

        this.httpsGet (`/api/behaviors/operation/validate`,
            (err, res) => {
                if (err) {
                    return callback?.(err, res);
                }
                if (res.result !== 'VALID') {
                    return callback?.(new Error('Request invalid'), res);
                }
                validateObj.operationPayload = res.operationPayload;

                const seqCommandObj: SequenceCommandObject = {
                    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
                    'startNode': validateObj
                };
                seqCommandObj.startNode['@type'] = 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode';
                seqCommandObj.startNode.skillId = 'amzn1.ask.skill.3b150b52-cedb-4792-a4b2-f656523a06f5';

                return this.sendSequenceCommand(serialOrName, seqCommandObj, callback);
            },
            {
                method: 'POST',
                data: JSON.stringify(validateObj)
            }
        );
    }*/

    /**
     * Sends a text message to a conversation of the communication account.
     *
     * @param conversationId ID of the conversation
     * @param text message text
     * @param callback called with (error, result)
     */
    sendTextMessage(conversationId: string, text: string, callback?: CallbackWithErrorAndBody): void {
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

        const message = [
            {
                conversationId: `amzn1.comms.messaging.id.conversationV2~${randomUUID()}`,
                clientMessageId: randomUUID(),
                messageId: 0.001,
                time: new Date().toISOString(),
                sender: this.commsId,
                type: 'message/text',
                payload: {
                    text: text,
                },
                status: 1,
            },
        ];

        this.httpsGet(
            `https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/conversations/${conversationId}/messages`,
            callback,
            {
                method: 'POST',
                data: JSON.stringify(message),
            },
        );
    }

    /**
     * Deletes a conversation of the communication account.
     *
     * @param conversationId ID of the conversation
     * @param lastMessageId ID of the last message (or the callback, defaults to 1)
     * @param callback called with (error, result)
     */
    deleteConversation(
        conversationId: string,
        lastMessageId?: number | CallbackWithErrorAndBody,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof lastMessageId === 'function') {
            callback = lastMessageId;
            lastMessageId = undefined;
        }
        if (lastMessageId === undefined) {
            lastMessageId = 1;
        }
        const flags = {
            method: 'DELETE',
        };
        this.httpsGet(
            `https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/conversations/${conversationId}?lastMessageId=${lastMessageId}`,
            callback,
            flags,
        );
    }

    /**
     * Creates a reminder on a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param timestamp time of the reminder
     * @param label text of the reminder
     * @param callback called with (error, result)
     */
    setReminder(
        serialOrName: SerialOrName,
        timestamp: number,
        label: string,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const notification = this.createNotificationObject(serialOrName, 'Reminder', label, new Date(timestamp));
        if (!notification) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }
        this.createNotification(notification, callback);
    }

    /**
     * Queries the home group (identities) of the communication account.
     *
     * @param callback called with (error, result)
     */
    getHomeGroup(callback?: CallbackWithErrorAndBody<CommsIdentity>): void {
        this.httpsGet(
            `https://alexa-comms-mobile-service.${this._options.amazonPage}/users/${this.commsId}/identities?includeUserName=true`,
            callback,
        );
    }

    /**
     * Queries the preferences (time zone, address, ...) of all devices or of a single device.
     *
     * @param serialOrName device to return the preferences for (or the callback to get the preferences of all devices)
     * @param callback called with (error, result)
     */
    getDevicePreferences(callback?: CallbackWithErrorAndBody<DevicePreferencesResponse>): void;
    getDevicePreferences(
        serialOrName: SerialOrName | null | undefined,
        callback?: CallbackWithErrorAndBody<DevicePreferences | DevicePreferencesResponse>,
    ): void;
    getDevicePreferences(
        serialOrName?: SerialOrName | CallbackWithErrorAndBody | null,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof serialOrName === 'function') {
            callback = serialOrName;
            serialOrName = null;
        }
        const _serialOrName = serialOrName;
        this.httpsGet('/api/device-preferences?cached=true', (err, res) => {
            if (_serialOrName) {
                const device = this.find(_serialOrName);
                if (!device) {
                    return callback?.(new Error('Unknown Device or Serial number'), null);
                }

                if (!err && res && res.devicePreferences && Array.isArray(res.devicePreferences)) {
                    const devicePreferences = res.devicePreferences.filter(
                        (pref: any) => pref.deviceSerialNumber === device.serialNumber,
                    );
                    if (devicePreferences.length > 0) {
                        return callback?.(null, devicePreferences[0]);
                    }
                    return callback?.(new Error(`No Device Preferences found for ${device.serialNumber}`), null);
                }
            }
            callback?.(err, res);
        });
    }

    /**
     * Sets the preferences of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param preferences preferences to store
     * @param callback called with (error, result)
     */
    setDevicePreferences(
        serialOrName: SerialOrName,
        preferences: Record<string, unknown>,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const device = this.find(serialOrName);
        if (!device) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(`/api/device-preferences/${device.serialNumber}`, callback, {
            method: 'PUT',
            data: JSON.stringify(preferences),
        });
    }

    /**
     * Queries the Wi-Fi details of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getDeviceWifiDetails(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody<DeviceWifiDetails>): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }
        this.httpsGet(
            `/api/device-wifi-details?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}`,
            callback,
        );
    }

    /**
     * Queries the volumes of all devices.
     *
     * @param callback called with (error, result)
     */
    getAllDeviceVolumes(callback?: CallbackWithErrorAndBody<DeviceVolumesResponse>): void {
        this.httpsGet('/api/devices/deviceType/dsn/audio/v1/allDeviceVolumes', callback);
    }

    /**
     * Queries all smart home devices in the format of the old API (best effort mapping of `getSmarthomeDevicesV2()`):
     * `{ locationDetails: { Default_Location: { amazonBridgeDetails: { amazonBridgeDetails: { LambdaBridge_<id>: ... } } } } }`
     *
     * @deprecated Use getSmarthomeDevicesV2 instead
     * @param callback called with (error, result)
     */
    getSmarthomeDevices(callback?: CallbackWithErrorAndBody): void {
        this.getSmarthomeDevicesV2((err, devices) => {
            if (err) {
                return callback?.(err);
            }
            // Flatten the legacy data into the device object
            const mappedResults = (devices || []).map((device: any) => ({
                ...device,
                ...device.legacyAppliance,
                ...device.legacyIdentifiers,
                legacyAppliance: undefined,
                legacyIdentifiers: undefined,
            }));
            const amazonBridgeDetails: Record<string, any> = {};
            mappedResults.forEach((device: any) => {
                const id = device.applianceId;
                if (!id) {
                    this._options.logger?.(`Ignoring device without applianceId: ${JSON.stringify(device)}`);
                    return;
                }
                // Ignore the Alexa App devices
                const deviceType = device.dmsIdentifier?.deviceType?.value?.text;
                if (deviceType === 'A2IVLV5VM2W81' || deviceType === 'A2TF17PFR55MTB') {
                    return;
                }

                amazonBridgeDetails[`LambdaBridge_${id}`] ||= {
                    applianceDetails: {
                        applianceDetails: {},
                    },
                };
                amazonBridgeDetails[`LambdaBridge_${id}`].applianceDetails.applianceDetails[id] = device;
            });
            callback?.(null, {
                locationDetails: {
                    Default_Location: {
                        locationId: 'Default_Location',
                        amazonBridgeDetails: {
                            amazonBridgeDetails,
                        },
                    },
                },
            });
        });
    }

    /**
     * Queries all smart home devices (endpoints) via the GraphQL API.
     *
     * @param callback called with (error, list of endpoints)
     */
    getSmarthomeDevicesV2(callback?: CallbackWithErrorAndBody): void {
        const request = {
            method: 'POST',
            data: JSON.stringify({ query: SmartHomeEndpointsGraphQlQuery }),
            timeout: 30000,
        };

        this.httpsGet(
            '/nexus/v1/graphql',
            (err, res) => {
                if (!err && !Array.isArray(res?.data?.endpoints?.items)) {
                    err = new Error('Invalid response from server');
                }
                if (err) {
                    return callback?.(err, res);
                }
                callback?.(null, res.data.endpoints.items);
            },
            request,
        );
    }

    /**
     * Queries the smart home groups.
     *
     * @param callback called with (error, result)
     */
    getSmarthomeGroups(callback?: CallbackWithErrorAndBody): void {
        this.httpsGet('/api/phoenix/group?_=%t', callback);
    }

    /**
     * Queries the smart home entities that can be used in routines.
     *
     * @param callback called with (error, result)
     */
    getSmarthomeEntities(callback?: CallbackWithErrorAndBody): void {
        this.httpsGet('/api/behaviors/entities?skillId=amzn1.ask.1p.smarthome', callback, {
            headers: {
                'Routines-Version': '3.0.264101',
            },
            timeout: 30000,
        });
    }

    /**
     * Queries the Fire TV entities that can be used in routines.
     *
     * @param callback called with (error, result)
     */
    getFireTVEntities(callback?: CallbackWithErrorAndBody): void {
        this.httpsGet('/api/behaviors/entities?skillId=amzn1.ask.1p.routines.firetv', callback, {
            headers: {
                'Routines-Version': '3.0.264101',
            },
            timeout: 30000,
        });
    }

    /**
     * Queries the smart home action definitions that can be used in routines.
     *
     * @param callback called with (error, result)
     */
    getSmarthomeBehaviourActionDefinitions(callback?: CallbackWithErrorAndBody): void {
        this.httpsGet('/api/behaviors/actionDefinitions?skillId=amzn1.ask.1p.smarthome', callback, {
            headers: {
                'Routines-Version': '3.0.264101',
            },
            timeout: 30000,
        });
    }

    /**
     * Queries the sounds that can be used in routines.
     *
     * @param callback called with (error, result)
     */
    getRoutineSoundList(callback?: CallbackWithErrorAndBody): void {
        this.httpsGet('/api/behaviors/entities?skillId=amzn1.ask.1p.sound', callback, {
            headers: {
                'Routines-Version': '3.0.264101',
            },
            timeout: 30000,
        });
    }

    /**
     * Renames a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param newName new name of the device
     * @param callback called with (error, result)
     */
    renameDevice(serialOrName: SerialOrName, newName: string, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const o = {
            accountName: newName,
            serialNumber: dev.serialNumber,
            deviceAccountId: dev.deviceAccountId,
            deviceType: dev.deviceType,
            // deviceOwnerCustomerId: oo.deviceOwnerCustomerId
        };
        this.httpsGet(`/api/devices-v2/device/${dev.serialNumber}`, callback, {
            method: 'PUT',
            data: JSON.stringify(o),
        });
    }

    /**
     * Deletes a smart home device.
     *
     * @param smarthomeDevice ID of the smart home device
     * @param callback called with (error, result)
     */
    deleteSmarthomeDevice(smarthomeDevice: string, callback?: CallbackWithErrorAndBody): void {
        const flags = {
            method: 'DELETE',
            // data: JSON.stringify (o),
        };
        this.httpsGet(`/api/phoenix/appliance/${smarthomeDevice}`, callback, flags);
    }

    /**
     * Enables or disables a smart home device.
     *
     * @param smarthomeDevice ID of the smart home device
     * @param enabled true to enable
     * @param callback called with (error, result)
     */
    setEnablementForSmarthomeDevice(
        smarthomeDevice: string,
        enabled: boolean,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const flags = {
            method: 'PUT',
            data: JSON.stringify({
                applianceId: smarthomeDevice,
                enabled: !!enabled,
            }),
        };
        this.httpsGet(`/api/phoenix/v2/appliance/${smarthomeDevice}/enablement`, callback, flags);
    }

    /**
     * Deletes a smart home group.
     *
     * @param smarthomeGroup ID of the group
     * @param callback called with (error, result)
     */
    deleteSmarthomeGroup(smarthomeGroup: string, callback?: CallbackWithErrorAndBody): void {
        const flags = {
            method: 'DELETE',
            // data: JSON.stringify (o),
        };
        this.httpsGet(`/api/phoenix/group/${smarthomeGroup}`, callback, flags);
    }

    /**
     * Deletes all smart home devices.
     *
     * @param callback called with (error, result)
     */
    deleteAllSmarthomeDevices(callback?: CallbackWithErrorAndBody): void {
        const flags = {
            method: 'DELETE',
            // data: JSON.stringify (o),
        };
        this.httpsGet(`/api/phoenix`, callback, flags);
    }

    /**
     * Starts the discovery of new smart home devices.
     *
     * @param callback called with (error, result)
     */
    discoverSmarthomeDevice(callback?: CallbackWithErrorAndBody): void {
        const flags = {
            method: 'POST',
            // data: JSON.stringify (o),
        };
        this.httpsGet('/api/phoenix/discovery', callback, flags);
    }

    /**
     * Queries the current state of smart home devices.
     *
     * @param toQuery entity ID(s) or query entries
     * @param entityType entity type for plain IDs (or the callback, defaults to "APPLIANCE")
     * @param maxTimeout maximum request timeout in ms (or the callback)
     * @param callback called with (error, result)
     */
    querySmarthomeDevices(
        toQuery: string | SmartHomeDeviceQueryEntry | (string | SmartHomeDeviceQueryEntry)[],
        entityType?: EntityType | CallbackWithErrorAndBody,
        maxTimeout?: number | CallbackWithErrorAndBody | null,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof maxTimeout === 'function') {
            callback = maxTimeout;
            maxTimeout = null;
        }
        if (typeof entityType === 'function') {
            callback = entityType;
            entityType = 'APPLIANCE'; // other value 'GROUP', 'ENTITY'
        }

        const reqArr: any[] = [];
        if (!Array.isArray(toQuery)) {
            toQuery = [toQuery];
        }
        for (const id of toQuery) {
            if (!id) {
                continue;
            }
            if (typeof id === 'object') {
                reqArr.push(id);
            } else {
                reqArr.push({
                    entityId: id,
                    entityType: entityType,
                });
            }
        }

        const flags = {
            method: 'POST',
            data: JSON.stringify({
                stateRequests: reqArr,
            }),
            timeout: Math.min(maxTimeout || 60000, Math.max(15000, toQuery.length * 200)),
        };

        this.httpsGet(`/api/phoenix/state`, callback, flags);
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

    /**
     * Executes an action (e.g. `{ action: "turnOn" }`) on smart home devices.
     *
     * @param entityIds entity ID(s)
     * @param parameters action parameters
     * @param entityType entity type (or the callback, defaults to "APPLIANCE")
     * @param callback called with (error, result)
     */
    executeSmarthomeDeviceAction(
        entityIds: string | string[],
        parameters: Record<string, any>,
        entityType?: EntityType | CallbackWithErrorAndBody,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof entityType === 'function') {
            callback = entityType;
            entityType = 'APPLIANCE'; // other value 'GROUP'
        }

        const reqArr: any[] = [];
        if (!Array.isArray(entityIds)) {
            entityIds = [entityIds];
        }
        for (const id of entityIds) {
            reqArr.push({
                entityId: id,
                entityType: entityType,
                parameters: parameters,
            });
        }

        const flags = {
            method: 'PUT',
            data: JSON.stringify({
                controlRequests: reqArr,
            }),
        };
        this.httpsGet(`/api/phoenix/state`, callback, flags);
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

    /**
     * Removes the pairing of a bluetooth device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param btAddress address of the bluetooth device
     * @param callback called with (error, result)
     */
    unpaireBluetooth(serialOrName: SerialOrName, btAddress: string, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const flags = {
            method: 'POST',
            data: JSON.stringify({
                bluetoothDeviceAddress: btAddress,
                bluetoothDeviceClass: 'OTHER',
            }),
        };
        this.httpsGet(`/api/bluetooth/unpair-sink/${dev.deviceType}/${dev.serialNumber}`, callback, flags);
    }

    /**
     * Restarts a device (like "Restart device" in the Alexa app).
     * The request is sent to the website API with the cookie and additionally the access token (as Home Assistant does).
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    rebootDevice(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }
        this.updateApiBearerToken(err => {
            if (err) {
                return callback?.(err, null);
            }
            this.httpsGet(`/v1/alexa/device/reboot/${dev.deviceType}/${dev.serialNumber}`, callback, {
                method: 'POST',
                data: JSON.stringify({ deviceSerialNumber: dev.serialNumber, deviceType: dev.deviceType }),
                headers: { authorization: `Bearer ${this.authApiBearerToken}` },
            });
        });
    }

    /**
     * Deletes (de-registers) a device from the account.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    deleteDevice(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const flags = {
            method: 'DELETE',
            data: JSON.stringify({
                deviceType: dev.deviceType,
            }),
        };
        this.httpsGet(`/api/devices/device/${dev.serialNumber}?deviceType=${dev.deviceType}`, callback, flags);
    }

    /**
     * Queries a device setting; the JSON encoded value is parsed.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param settingName name of the setting
     * @param callback called with (error, result)
     */
    getDeviceSettings(serialOrName: SerialOrName, settingName: string, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(`/api/v1/devices/${dev.deviceAccountId}/settings/${settingName}`, (err, res) => {
            if (!err && res && typeof res.value === 'string') {
                try {
                    res.value = JSON.parse(res.value);
                } catch {
                    // ignore
                    return callback?.(new Error(`Invalid value for setting ${settingName}: ${res}`));
                }
            }
            callback?.(err, res?.value);
        });
    }

    /**
     * Sets a device setting; the value is JSON encoded.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param settingName name of the setting
     * @param value new value
     * @param callback called with (error, result)
     */
    setDeviceSettings(
        serialOrName: SerialOrName,
        settingName: string,
        value: any,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const flags = {
            method: 'PUT',
            data: JSON.stringify({
                value: JSON.stringify(value),
            }),
        };
        this.httpsGet(`/api/v1/devices/${dev.deviceAccountId}/settings/${settingName}`, callback, flags);
    }

    /**
     * Queries which speaker (internal, bluetooth, aux) is used by a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getConnectedSpeakerOptionSetting(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        this.getDeviceSettings(serialOrName, 'connectedSpeakerOption', callback);
    }

    /**
     * Sets which speaker is used by a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param speakerType "Bluetooth", "InternalSpeaker" or "Aux" (not supported by all devices)
     * @param callback called with (error, result)
     */
    setConnectedSpeakerOptionSetting(
        serialOrName: SerialOrName,
        speakerType: 'Bluetooth' | 'InternalSpeaker' | 'Aux',
        callback?: CallbackWithErrorAndBody,
    ): void {
        this.setDeviceSettings(serialOrName, 'connectedSpeakerOption', speakerType, callback);
    }

    /**
     * Queries the "follow-up mode" setting of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getAttentionSpanSetting(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        this.getDeviceSettings(serialOrName, 'attentionSpan', callback);
    }

    /**
     * Enables or disables the "follow-up mode" of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param enabled true to enable
     * @param callback called with (error, result)
     */
    setAttentionSpanSetting(serialOrName: SerialOrName, enabled: boolean, callback?: CallbackWithErrorAndBody): void {
        this.setDeviceSettings(serialOrName, 'attentionSpan', !!enabled, callback);
    }

    /**
     * Queries the "Alexa gestures" setting of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getAlexaGesturesSetting(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        this.getDeviceSettings(serialOrName, 'alexaGestures', callback);
    }

    /**
     * Enables or disables the "Alexa gestures" of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param enabled true to enable
     * @param callback called with (error, result)
     */
    setAlexaGesturesSetting(serialOrName: SerialOrName, enabled: boolean, callback?: CallbackWithErrorAndBody): void {
        this.setDeviceSettings(serialOrName, 'alexaGestures', !!enabled, callback);
    }

    /**
     * Queries whether the display of a device is switched on (result is a boolean).
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getDisplayPowerSetting(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        this.getDeviceSettings(serialOrName, 'displayPower', (err, res) => {
            if (!err && res !== undefined) {
                res = res === 'ON';
            }
            callback?.(err, res);
        });
    }

    /**
     * Switches the display of a device on or off.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param enabled true to switch on
     * @param callback called with (error, result)
     */
    setDisplayPowerSetting(serialOrName: SerialOrName, enabled: boolean, callback?: CallbackWithErrorAndBody): void {
        this.setDeviceSettings(serialOrName, 'displayPower', enabled ? 'ON' : 'OFF', callback);
    }

    /**
     * Queries whether the adaptive brightness of a device is enabled (result is a boolean).
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getAdaptiveBrightnessSetting(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        this.getDeviceSettings(serialOrName, 'adaptiveBrightness', (err, res) => {
            if (!err && res !== undefined) {
                res = res === 'ON';
            }
            callback?.(err, res);
        });
    }

    /**
     * Enables or disables the adaptive brightness of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param enabled true to enable
     * @param callback called with (error, result)
     */
    setAdaptiveBrightnessSetting(
        serialOrName: SerialOrName,
        enabled: boolean,
        callback?: CallbackWithErrorAndBody,
    ): void {
        this.setDeviceSettings(serialOrName, 'adaptiveBrightness', enabled ? 'ON' : 'OFF', callback);
    }

    /**
     * Queries the clock time format of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getClockTimeFormatSetting(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        this.getDeviceSettings(serialOrName, 'timeFormat', callback);
    }

    /**
     * Sets the clock time format of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param format "12_HOURS" or "24_HOURS"
     * @param callback called with (error, result)
     */
    setClockTimeFormatSetting(
        serialOrName: SerialOrName,
        format: '12_HOURS' | '24_HOURS',
        callback?: CallbackWithErrorAndBody,
    ): void {
        this.setDeviceSettings(serialOrName, 'timeFormat', format, callback);
    }

    /**
     * Queries the display brightness of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getBrightnessSetting(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        this.getDeviceSettings(serialOrName, 'brightness', callback);
    }

    /**
     * Sets the display brightness of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param brightness brightness between 0 and 100
     * @param callback called with (error, result)
     */
    setBrightnessSetting(serialOrName: SerialOrName, brightness: number, callback?: CallbackWithErrorAndBody): void {
        if (typeof brightness !== 'number') {
            return callback?.(new Error('Brightness must be a number'), null);
        }
        if (brightness < 0 || brightness > 100) {
            return callback?.(new Error('Brightness must be between 0 and 100'), null);
        }
        this.setDeviceSettings(serialOrName, 'brightness', brightness, callback);
    }

    /**
     * Queries whether the equalizer of a device is enabled.
     *
     * Response:
     * {
     * 	"enabled": true
     * }
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getEqualizerEnabled(
        serialOrName: SerialOrName,
        callback?: CallbackWithErrorAndBody<EqualizerEnabledResponse>,
    ): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(`/api/equalizer/enabled/${dev.serialNumber}/${dev.deviceType}`, callback);
    }

    /**
     * Queries the allowed value range of the equalizer of a device.
     *
     * Response:
     * {
     * 	"max": 6,
     * 	"min": -6
     * }
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getEqualizerRange(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody<EqualizerRangeResponse>): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(`/api/devices/${dev.serialNumber}/${dev.deviceType}/audio/v1/getEQRange`, callback);
    }

    /**
     * Queries the equalizer settings (bass, mid, treble) of a device.
     *
     * Response:
     * {
     * 	"bass": 0,
     * 	"mid": 0,
     * 	"treble": 0
     * }
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getEqualizerSettings(
        serialOrName: SerialOrName,
        callback?: CallbackWithErrorAndBody<EqualizerSettingsResponse>,
    ): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(`/api/equalizer/${dev.serialNumber}/${dev.deviceType}`, callback);
    }

    /**
     * Sets the equalizer of a device. At least one value must be provided.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param bass bass value (see `getEqualizerRange()`)
     * @param midrange midrange value
     * @param treble treble value
     * @param callback called with (error, result)
     */
    setEqualizerSettings(
        serialOrName: SerialOrName,
        bass?: number,
        midrange?: number,
        treble?: number,
        callback?: CallbackWithErrorAndBody,
    ): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        if (bass !== undefined && typeof bass !== 'number') {
            return callback?.(new Error('Bass value must be a number'), null);
        }
        if (midrange !== undefined && typeof midrange !== 'number') {
            return callback?.(new Error('Midrange value must be a number'), null);
        }
        if (treble !== undefined && typeof treble !== 'number') {
            return callback?.(new Error('Treble value must be a number'), null);
        }
        if (bass === undefined && midrange === undefined && treble === undefined) {
            return callback?.(new Error('At least one value must be provided'), null);
        }

        const flags = {
            method: 'POST',
            data: JSON.stringify({
                bass,
                mid: midrange,
                treble,
            }),
        };
        this.httpsGet(`/api/equalizer/${dev.serialNumber}/${dev.deviceType}`, callback, flags);
    }

    /**
     * Queries the state of the AUX ports of a device.
     *
     * Response:
     * {
     * 	"ports": [{
     * 		"direction": "OUTPUT",
     * 		"id": "aux0",
     * 		"inputActivity": null,
     * 		"isEnabled": false,
     * 		"isPlugged": false
     * 	}]
     * }
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param callback called with (error, result)
     */
    getAuxControllerState(serialOrName: SerialOrName, callback?: CallbackWithErrorAndBody): void {
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(`/api/auxcontroller/${dev.deviceType}/${dev.serialNumber}/state`, callback);
    }

    /**
     * Sets the direction (input or output) of an AUX port of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param direction "INPUT" or "OUTPUT"
     * @param port ID of the port (or the callback, defaults to "aux0")
     * @param callback called with (error, result)
     */
    setAuxControllerPortDirection(
        serialOrName: SerialOrName,
        direction: 'INPUT' | 'OUTPUT',
        port?: string | CallbackWithErrorAndBody,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof port === 'function') {
            callback = port;
            port = 'aux0';
        }
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        const flags = {
            method: 'POST',
            data: JSON.stringify({
                direction,
                deviceId: dev.serialNumber,
            }),
        };
        this.httpsGet(
            `/api/auxcontroller/${dev.deviceType}/${dev.serialNumber}/ports/${port}/setDirection`,
            callback,
            flags,
        );
    }

    /**
     * Queries the play queue of a device.
     *
     * @param serialOrName serial number, name, friendly name or device object of the Echo device
     * @param size maximum number of entries (or the callback, defaults to 50)
     * @param callback called with (error, result)
     */
    getPlayerQueue(
        serialOrName: SerialOrName,
        size?: number | CallbackWithErrorAndBody,
        callback?: CallbackWithErrorAndBody,
    ): void {
        if (typeof size === 'function') {
            callback = size;
            size = 50;
        }
        const dev = this.find(serialOrName);
        if (!dev) {
            return callback?.(new Error('Unknown Device or Serial number'), null);
        }

        this.httpsGet(
            `/api/np/queue?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}&size=${size}&_=%t`,
            callback,
        );
    }
}

// Re-export all public types, so that they are available as `import { InitOptions } from 'alexa-remote2'`
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace AlexaRemote {
    export type MacDms = Types.MacDms;
    export type FormerRegistrationData = Types.FormerRegistrationData;
    export type AlexaRemoteOptions = Types.AlexaRemoteOptions;
    export type InitOptions = Types.InitOptions;
    export type AppDevice = Types.AppDevice;
    export type Serial = Types.Serial;
    export type CallbackWithError = Types.CallbackWithError;
    export type CallbackWithErrorAndBody<T = any> = Types.CallbackWithErrorAndBody<T>;
    export type AuthenticationCallback = Types.AuthenticationCallback;
    export type SerialOrName = Types.SerialOrName;
    export type SerialOrNameOrArray = Types.SerialOrNameOrArray;
    export type Value = Types.Value;
    export type SequenceValue = Types.SequenceValue;
    export type Sound = Types.Sound;
    export type Status = Types.Status;
    export type Notification = Types.Notification;
    export type NotificationRecurrence = Types.NotificationRecurrence;
    export type NotificationV2 = Types.NotificationV2;
    export type GetContactsOptions = Types.GetContactsOptions;
    export type ListItemOptions = Types.ListItemOptions;
    export type GetCustomerHistoryRecordsOptions = Types.GetCustomerHistoryRecordsOptions;
    export type GetActivitiesOptions = Types.GetActivitiesOptions;
    export type GetConversationsOptions = Types.GetConversationsOptions;
    export type GetAuthenticationDetails = Types.GetAuthenticationDetails;
    export type SmartHomeDeviceQueryEntry = Types.SmartHomeDeviceQueryEntry;
    export type MessageCommands = Types.MessageCommands;
    export type SequenceNodeCommand = Types.SequenceNodeCommand;
    export type SequenceType = Types.SequenceType;
    export type EntityType = Types.EntityType;
    export type SequenceNodeDetails = Types.SequenceNodeDetails;
    export type MultiSequenceCommand = Types.MultiSequenceCommand;
    export type SequenceNode = Types.SequenceNode;
    export type SequenceNodeStructure = Types.SequenceNodeStructure;
    export type SequenceCommandObject = Types.SequenceCommandObject;
    export type HttpsGetFlags = Types.HttpsGetFlags;
    export type Endpoints = Types.Endpoints;
    // responses, push messages and events
    export type VoiceHistoryRecordItem = Responses.VoiceHistoryRecordItem;
    export type CustomerHistoryRecord = Responses.CustomerHistoryRecord;
    export type CustomerHistoryRecordsResponse = Responses.CustomerHistoryRecordsResponse;
    export type CustomerHistoryEntry = Responses.CustomerHistoryEntry;
    export type DeviceActivityEvent = Responses.DeviceActivityEvent;
    export type MediaImage = Responses.MediaImage;
    export type NowPlayingData = Responses.NowPlayingData;
    export type NowPlayingUpdatedPush = Responses.NowPlayingUpdatedPush;
    export type ListItemChangePush = Responses.ListItemChangePush;
    export type TodoChangeEvent = Responses.TodoChangeEvent;
    export type CustomerStatusResponse = Responses.CustomerStatusResponse;
    export type AuthTokenResponse = Responses.AuthTokenResponse;
    export type CommsAccount = Responses.CommsAccount;
    export type CommsName = Responses.CommsName;
    export type CommsIdentity = Responses.CommsIdentity;
    export type ContactNumber = Responses.ContactNumber;
    export type Contact = Responses.Contact;
    export type DeviceInfo = Responses.DeviceInfo;
    export type DevicesResponse = Responses.DevicesResponse;
    export type DeviceAddress = Responses.DeviceAddress;
    export type DevicePreferences = Responses.DevicePreferences;
    export type DevicePreferencesResponse = Responses.DevicePreferencesResponse;
    export type WakeWord = Responses.WakeWord;
    export type WakeWordsResponse = Responses.WakeWordsResponse;
    export type BluetoothPairedDevice = Responses.BluetoothPairedDevice;
    export type BluetoothState = Responses.BluetoothState;
    export type BluetoothResponse = Responses.BluetoothResponse;
    export type DeviceVolume = Responses.DeviceVolume;
    export type DeviceVolumesResponse = Responses.DeviceVolumesResponse;
    export type DoNotDisturbStatus = Responses.DoNotDisturbStatus;
    export type DoNotDisturbStatusResponse = Responses.DoNotDisturbStatusResponse;
    export type DeviceWifiDetails = Responses.DeviceWifiDetails;
    export type EqualizerEnabledResponse = Responses.EqualizerEnabledResponse;
    export type EqualizerRangeResponse = Responses.EqualizerRangeResponse;
    export type EqualizerSettingsResponse = Responses.EqualizerSettingsResponse;
    export type NotificationsResponse = Responses.NotificationsResponse;
    export type NotificationSoundsResponse = Responses.NotificationSoundsResponse;
    export type DefaultNotificationSoundResponse = Responses.DefaultNotificationSoundResponse;
    export type DeviceNotificationState = Responses.DeviceNotificationState;
    export type AscendingAlarmState = Responses.AscendingAlarmState;
    export type AscendingAlarmResponse = Responses.AscendingAlarmResponse;
    export type MusicProvider = Responses.MusicProvider;
    export type AutomationTrigger = Responses.AutomationTrigger;
    export type AutomationRoutine = Responses.AutomationRoutine;
    export type RoutineCatalogItem = Responses.RoutineCatalogItem;
    export type RoutineSkillCatalogResponse = Responses.RoutineSkillCatalogResponse;
    export type ListV2 = Responses.ListV2;
    export type ListItemV2 = Responses.ListItemV2;
    export type DopplerId = Responses.DopplerId;
    export type VolumeChangePush = Responses.VolumeChangePush;
    export type EqualizerStateChangePush = Responses.EqualizerStateChangePush;
    export type AudioPlayerStatePush = Responses.AudioPlayerStatePush;
    export type NotificationChangePush = Responses.NotificationChangePush;
    export type MediaSessionsUpdatedPush = Responses.MediaSessionsUpdatedPush;
    export type VolumeChangeEvent = Responses.VolumeChangeEvent;
    export type EqualizerStateChangeEvent = Responses.EqualizerStateChangeEvent;
    export type AudioPlayerStateChangeEvent = Responses.AudioPlayerStateChangeEvent;
    export type NotificationChangeEvent = Responses.NotificationChangeEvent;
    export type DndStateChangeEvent = Responses.DndStateChangeEvent;
    export type NowPlayingUpdatedEvent = Responses.NowPlayingUpdatedEvent;
}

export = AlexaRemote;
