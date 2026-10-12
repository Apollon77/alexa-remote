/** Registration data of the virtual device that is registered at Amazon during the login */
export type MacDms = {
    /** Private key of the registered (virtual) device */
    device_private_key: string;
    /** ADP token of the registered device */
    adp_token: string;
};

/** Cookie and registration data as returned by alexa-cookie2; store it and pass it on the next start */
export type FormerRegistrationData = {
    /** Device registration data */
    macDms: MacDms;
    /** Cookie for the website API */
    localCookie: string;
    frc: string;
    'map-md': string;
    deviceId: string;
    deviceSerial: string;
    /** Token to refresh the cookie and to get access tokens */
    refreshToken: string;
    /** Timestamp when the tokens were created */
    tokenDate: number;
    /** Amazon page used for the login, e.g. amazon.de */
    amazonPage: string;
    /** CSRF token of the cookie */
    csrf: string;
    /** Name of the registered app device */
    deviceAppName: string;
    /** Version of the data structure */
    dataVersion: number | undefined;
    [key: string]: any;
};

/** Options for AlexaRemote.init() */
export type AlexaRemoteOptions = Partial<{
    /** Cookie string or complete cookie data from a former login (preferred) */
    cookie: string | Partial<FormerRegistrationData> | { cookie: string | Partial<FormerRegistrationData> };
    /** Amazon account e-mail (only for the deprecated login without proxy) */
    email: string;
    /** Amazon account password (only for the deprecated login without proxy) */
    password: string;
    /** Only use the login proxy to get a cookie */
    proxyOnly: boolean;
    /** IP or hostname used to reach the login proxy */
    proxyOwnIp: string;
    /** Port of the login proxy */
    proxyPort: number;
    /** Log level of the login proxy */
    proxyLogLevel: string;
    /** Load the bluetooth state of the devices on init */
    bluetooth: boolean;
    /** Load the notifications of the devices on init */
    notifications: boolean;
    /** Function used for debug logging */
    logger: (...args: any[]) => void;
    /** Host of the Alexa website API, e.g. pitangui.amazon.com (normally detected automatically) */
    alexaServiceHost: string;
    /** User agent for the login */
    userAgent: string;
    /** Postfix added to the user agent of API requests */
    apiUserAgentPostfix: string;
    /** Name of the app device that is registered at Amazon */
    deviceAppName: string;
    /** Accept-Language header used for the login */
    acceptLanguage: string;
    /** Amazon page used for the login, defaults to amazon.de */
    amazonPage: string;
    /** @deprecated */
    useWsMqtt: boolean;
    /** Open the push connection to receive events */
    usePushConnection: boolean;
    /** Connection type for the legacy WebSocket push connection (1 or 2) */
    usePushConnectType: number;
    /** Overwrites the host of the push endpoint */
    pushDispatchHost: string;
    /** Interval in ms for the automatic cookie refresh, 0 to disable (default 4 days) */
    cookieRefreshInterval: number;
    /** @deprecated use cookieRefreshInterval */
    refreshCookieInterval: number;
    /** Query the voice history for events that do not deliver an activity (use with care) */
    autoQueryActivityOnTrigger: boolean;
    /** Path where alexa-cookie2 stores some registration data */
    formerDataStorePath: string;
    /** Device registration data needed for the push connection */
    macDms: MacDms;
    /** Registration data of a former login used to refresh the cookie */
    formerRegistrationData: FormerRegistrationData;
    /** CSRF token (set internally) */
    csrf: string;
    /** Cookie (set internally) */
    localCookie: string;
    /** True if the cookie was just generated (set internally) */
    cookieJustCreated: boolean;
}> & {
    // Additional options are passed through to alexa-cookie2
    [key: string]: any;
};

/** Options or cookie for AlexaRemote.init() */
export type InitOptions = string | AlexaRemoteOptions;

/** Sub device of a device (e.g. an app running on a Fire TV) */
export type AppDevice = {
    deviceAccountId: string;
    deviceType: string;
    serialNumber: string;
};

/** Device object as returned by Amazon, extended by some helper properties and bound methods */
export type Serial = {
    /** Name of the device as shown in the Alexa app */
    accountName: string;
    appDeviceList: AppDevice[];
    /** Capabilities like AUDIO_PLAYER, VOLUME_SETTING, ... */
    capabilities: string[];
    charging: string;
    deviceAccountId: string;
    /** Device family like ECHO, KNIGHT, FIRE_TV, ... */
    deviceFamily: string;
    /** Customer ID of the device owner */
    deviceOwnerCustomerId: string;
    deviceType: string;
    deviceTypeFriendlyName: string;
    essid: string;
    language: string;
    macAddress: string;
    online: boolean;
    postalCode: string;
    registrationId: string;
    remainingBatteryLevel: string;
    /** Serial number of the device */
    serialNumber: string;
    softwareVersion: string;
    /** True if the device can play media (set by this library) */
    isControllable: boolean;
    /** True if the device has a music player (set by this library) */
    hasMusicPlayer: boolean;
    /** True if the device is a multi room group (set by this library) */
    isMultiroomDevice: boolean;
    /** True if the device is member of a multi room group (set by this library) */
    isMultiroomMember: boolean;
    /** Wake word of the device in lower case (set by this library) */
    wakeWord: string;
    // Further properties returned by Amazon and helper methods bound to the device object
    [key: string]: any;
};

/** Callback that only receives an error */
export type CallbackWithError = (err?: Error | null) => void;

/** Node.js style callback with error and result */
export type CallbackWithErrorAndBody<T = any> = (err?: Error | null, body?: T | null) => void;

/** Callback of the authentication check */
export type AuthenticationCallback = (authenticated: boolean | null, err?: Error | null) => void;

/** Device object, serial number or name of a device */
export type SerialOrName = Serial | string;

/** One or more devices */
export type SerialOrNameOrArray = SerialOrName | SerialOrName[];

/** Value for commands */
export type Value = string | number | boolean;

/** Value for sequence (routine) commands */
export type SequenceValue =
    | Value
    | null
    | undefined
    | {
          title?: string;
          text?: string;
          value?: string;
      };

/** Notification sound */
export type Sound = {
    displayName: string;
    /** e.g. FOLDER_CELEBRITY */
    folder: string | null;
    id: string;
    /** e.g. ECHO */
    providerId: string;
    sampleUrl: string;
    dynamicTone?: boolean | null;
    isChildDirected?: boolean;
    numAssets?: number;
    pricing?: unknown;
    sampleVideoUrl?: string | null;
    skillUrl?: string | null;
};

/** Status of a notification */
export type Status = 'ON' | 'OFF';

/** Notification (alarm, timer or reminder) in the format of the old API */
export type Notification = Partial<{
    alarmTime: number;
    createdDate: number;
    deferredAtTime: number | null;
    deviceSerialNumber: string;
    deviceType: string;
    geoLocationTriggerData: string | null;
    id: string | null;
    musicAlarmId: string | null;
    musicEntity: string | null;
    notificationIndex: string;
    originalDate: string;
    originalTime: string;
    provider: string | null;
    recurringPattern: string | null;
    remainingTime: number;
    reminderLabel: string | null;
    sound: Sound | null;
    status: Status | 'INSTANCE_CANCELED';
    timeZoneId: string | null;
    timerLabel: string | null;
    triggerTime: number;
    type: string;
    version: string;
    rRuleData: Partial<{
        byMonthDays: string[];
        byMonths: string[];
        byWeekDays: string[];
        flexibleRecurringPatternType:
            | 'EVERY_X_WEEKS'
            | 'EVERY_X_MONTHS'
            | 'EVERY_X_DAYS'
            | 'EVERY_X_YEARS'
            | 'X_TIMES_A_WEEK'
            | 'X_TIMES_A_MONTH'
            | 'X_TIMES_A_DAY'
            | 'X_TIMES_A_YEAR';
        frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | null;
        intervals: number[];
        nextTriggerTimes: string[];
        notificationTimes: string[];
        offset: number[];
        recurEndDate: string | null;
        recurEndTime: string | null;
        recurStartDate: string | null;
        recurStartTime: string | null;
        recurrenceRules: string[];
    }>;
}> & {
    [key: string]: any;
};

/** Recurrence definition of an alarm */
export type NotificationRecurrence = {
    freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
    /** Week days, e.g. ["MO", "FR"] (not needed for daily alarms) */
    byDay?: string[];
    byMonth?: string[];
    interval: number;
};

/** Alarm in the format of the new Alexa API */
export type NotificationV2 = Partial<{
    trigger: {
        scheduledTime: string;
        recurrence?: NotificationRecurrence;
    };
    endpointId: string;
    assets: {
        type: string;
        assetId: string;
    }[];
    extensions: any[];
}> & {
    [key: string]: any;
};

/** Options for getContacts() */
export type GetContactsOptions = Partial<{
    includePreferencesByLevel: string;
    includeNonAlexaContacts: boolean;
    includeHomeGroupMembers: boolean;
    bulkImportOnly: boolean;
    includeBlockStatus: boolean;
    dedupeMode: string;
    homeGroupId: string;
}>;

/** Options to query, create or update list items */
export type ListItemOptions = Partial<{
    /** Text of the item */
    value: string;
    /** Current version of the item (required to update or delete it) */
    version: number | string;
    /** Mark the item as completed */
    completed: string | boolean;
    /** Status of the item: ACTIVE or COMPLETE (ignored if completed is set) */
    itemStatus: 'ACTIVE' | 'COMPLETE';
    /** Note of the item */
    note: string | null;
    /** Quantity of the item */
    quantity: string | number | null;
    /** Maximum number of items to fetch (defaults to 100) */
    limit: number;
}> & {
    [key: string]: any;
};

/** Options for getCustomerHistoryRecords() */
export type GetCustomerHistoryRecordsOptions = Partial<{
    startTime: number;
    endTime: number;
    recordType: string;
    maxRecordSize: number;
    filter: boolean;
    forceRequest: boolean;
}>;

/**
 * Options for the removed getActivities()
 *
 * @deprecated getActivities() was removed, use getCustomerHistoryRecords()
 */
export type GetActivitiesOptions = Partial<{
    startTime: number | string;
    size: number;
    offset: number;
    filter: boolean;
}>;

/** Options for getConversations() */
export type GetConversationsOptions = Partial<{
    latest: boolean;
    includeHomegroup: boolean;
    unread: boolean;
    modifiedSinceDate: string;
    includeUserName: boolean;
}>;

/** Authentication details of the account */
export type GetAuthenticationDetails = {
    authenticated: boolean;
    canAccessPrimeMusicContent: boolean;
    customerEmail: string;
    customerId: string;
    customerName: string;
};

/** Entry to query the state of smart home devices */
export type SmartHomeDeviceQueryEntry = {
    entityId: string;
    entityType: 'APPLIANCE' | 'ENTITY' | 'GROUP';
    properties?: {
        namespace: string; // aka interfaceName aka "Alexa.PowerController"
        name: string; // e.g. "powerState"
        instance?: string;
    }[];
};

/** Player commands for sendCommand() */
export type MessageCommands =
    'play' | 'pause' | 'next' | 'previous' | 'forward' | 'rewind' | 'volume' | 'shuffle' | 'repeat' | 'jump';

/** Commands for sendSequenceCommand() */
export type SequenceNodeCommand =
    | 'weather'
    | 'traffic'
    | 'flashbriefing'
    | 'goodmorning'
    | 'funfact'
    | 'joke'
    | 'cleanup'
    | 'singasong'
    | 'tellstory'
    | 'calendarToday'
    | 'calendarTomorrow'
    | 'calendarNext'
    | 'wait'
    | 'textCommand'
    | 'sound'
    | 'curatedtts'
    | 'volume'
    | 'deviceStop'
    | 'deviceStopAll'
    | 'deviceDoNotDisturb'
    | 'deviceDoNotDisturbAll'
    | 'speak'
    | 'skill'
    | 'notification'
    | 'announcement'
    | 'ssml'
    | 'fireTVTurnOn'
    | 'fireTVTurnOff'
    | 'fireTVTurnOnOff'
    | 'fireTVPauseVideo'
    | 'fireTVResumeVideo'
    | 'fireTVNavigateHome';

/** Execute the nodes one after another (serial) or at once (parallel) */
export type SequenceType = 'SerialNode' | 'ParallelNode';

/** Type of smart home entity */
export type EntityType = 'APPLIANCE' | 'GROUP' | 'ENTITY';

/** Single command in a multi sequence */
export type SequenceNodeDetails = {
    command: SequenceNodeCommand;
    value: SequenceValue;
    device?: SerialOrNameOrArray;
};

/** Command or nested list of commands for sendMultiSequenceCommand() */
export type MultiSequenceCommand =
    | SequenceNodeDetails
    | {
          sequenceType?: SequenceType;
          nodes: MultiSequenceCommand[];
      };

/** Single node of a routine sequence */
export type SequenceNode = {
    '@type': string;
    type?: string;
    skillId?: string;
    name?: string | null;
    operationPayload: Record<string, any>;
    [key: string]: any;
};

/** Serial or parallel node with child nodes */
export type SequenceNodeStructure = {
    '@type': string;
    name: null;
    nodesToExecute: (SequenceNode | SequenceNodeStructure)[];
};

/** Complete sequence or routine object */
export type SequenceCommandObject = {
    '@type'?: string;
    startNode?: any;
    sequence?: any;
    sequenceId?: string;
    automationId?: string;
    [key: string]: any;
};

/** Options for the HTTPS requests */
export type HttpsGetFlags = {
    method?: string;
    data?: string;
    headers?: Record<string, any>;
    host?: string;
    timeout?: number;
    cleanHeader?: boolean;
    isRetry?: boolean;
    /** Return the raw response body instead of parsing it as JSON */
    handleAsText?: boolean;
};

/** Used functions of the alexa-cookie2 module */
export interface AlexaCookie {
    generateAlexaCookie(
        email: string | undefined,
        password: string | undefined,
        options: AlexaRemoteOptions,
        callback: CallbackWithErrorAndBody,
    ): void;
    refreshAlexaCookie(options: AlexaRemoteOptions, callback: CallbackWithErrorAndBody): void;
    getDeviceAppName(): string;
    stopProxyServer(callback?: CallbackWithError): void;
}

/** Region specific API endpoints */
export type Endpoints = {
    /** e.g. https://eu-api-alexa.amazon.de */
    websiteApiUrl?: string;
    /** e.g. https://api.eu.amazonalexa.com */
    alexaApiUrl?: string;
    /** e.g. eu-west-1 */
    awsRegion?: string;
    /** e.g. https://eu-bob-dispatch-prod-alexa.amazon.de */
    bobDispatchUrl?: string;
    /** e.g. amazon.de */
    retailDomain?: string;
    /** e.g. https://www.amazon.de */
    retailUrl?: string;
    skillsStoreUrl?: string;
    websiteUrl?: string;
    [key: string]: any;
};
