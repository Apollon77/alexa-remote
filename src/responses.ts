/*
 * Types of the (undocumented) Amazon responses, push messages and events.
 *
 * They were derived from recorded responses of a real account (see the response recorder of ioBroker.alexa2).
 * Amazon changes these structures without notice: fields that were only seen with `null` are typed as `unknown`,
 * fields that were not present in every response are optional. Enum like values list the values that were seen.
 */
import type { AppDevice, Notification, Sound } from './types';

// ---------- account ----------

/** Response of `/api/customer-status` (used by `checkAuthentication()`) */
export interface CustomerStatusResponse {
    countryOfResidenceSet: boolean;
    eulaAcceptance: boolean;
    ftueSkipped: boolean;
    hasActiveDopplers: boolean;
    hasPhysical1PDevice: boolean;
    preferredMarketplaceSet: boolean;
    tutorialComplete: boolean;
}

/** Response of `/auth/token` (`getAuthApiBearerToken()`) */
export interface AuthTokenResponse {
    access_token: string;
    /** "bearer" */
    token_type: string;
    /** Lifetime of the token in seconds */
    expires_in: number;
    request_id: string;
    secureSessionToken?: string;
    age_classification?: { age_classification: string };
    response?: { token: string; token_type: string; token_expires_in: string };
}

/** Communication account (`getAccount()` returns a list of them) */
export interface CommsAccount {
    commsId: string | null;
    directedId: string;
    firstName: string;
    lastName: string;
    phoneCountryCode: string | null;
    phoneNumber: string | null;
    phoneticFirstName: unknown;
    phoneticLastName: unknown;
    /** e.g. PROVISIONED, AUTO_PROVISIONED, UNKNOWN */
    commsProvisionStatus: string;
    /** e.g. STANDARD, UNKNOWN */
    commsProvisionSubStatus: string;
    isChild: boolean;
    personIdV2: string;
    mapDirectedDefaultActorId: unknown;
    phoneNumberMetadataForTheActor: unknown;
    enrolledInAlexa: boolean;
    commsProvisioned: boolean;
    speakerProvisioned: boolean;
    signedInUser: boolean;
}

/** Name of a person in the communication API */
export interface CommsName {
    firstName: string;
    lastName: string | null;
    nickName: unknown;
    sourceNickName: unknown;
    phoneticFirstName: unknown;
    phoneticLastName: unknown;
    pronunciationFirstName: unknown;
    pronunciationLastName: unknown;
}

/** Response of `getHomeGroup()` (identity of the user in the communication API) */
export interface CommsIdentity {
    commsId: string;
    pceId: string;
    homeGroupId: string;
    homeGroupPceId: unknown;
    aor: string;
    hashedCommsId: string;
    name: CommsName;
    /** e.g. PROVISIONED */
    commsProvisionStatus: string;
}

/** Phone number of a contact */
export interface ContactNumber {
    number: string;
    originalNumber: string;
    rawType: string;
    type: string;
    obfuscatedPhoneNumber: unknown;
    /** e.g. `{ linkType: 'AMAZON_ACCOUNT', linkValue: '<customer id>' }` */
    addressLinkList: { linkType: string; linkValue: string }[];
    isCOBOEnabled: boolean;
    addressId: string;
    contactAddressSourceList: unknown[];
    preferenceInfoList: unknown;
    eligibleFor: unknown[];
}

/** Contact (`getContacts()` returns a list of them) */
export interface Contact {
    id: string;
    name: CommsName;
    numbers: ContactNumber[];
    number: string | null;
    emails: unknown;
    addresses: unknown;
    events: unknown[];
    relationship: unknown;
    deviceContactId: unknown;
    serverContactId: string;
    alexaEnabled: boolean;
    isHomeGroup: boolean;
    vipContactInfo: { isVIPContact: unknown; deviceContactDisplayInfoList: unknown[] };
    isBulkImport: boolean;
    isBlocked: unknown;
    isChild: boolean;
    isLinked: boolean;
    shouldMerge: boolean;
    shouldHideInQuickAccessList: boolean;
    isMerged: boolean;
    mergedContactIdentifiers: unknown;
    referenceCommsId: unknown;
    referenceContactId: unknown;
    sourceDeviceId: unknown;
    sourceDeviceName: unknown;
    commsId: string[];
    commsIds: { aor: string; id: string; addressId: unknown }[];
    homeGroupId: { aor?: unknown; id?: string; addressId?: unknown } | null;
    /** Preferences (e.g. `drop_in`) by comms id */
    commsIdsPreferences: Record<
        string,
        {
            preferenceGrantedToContactByUser: Record<string, string>;
            preferenceGrantedToUserByContact: Record<string, string>;
        }
    >;
    company: unknown;
    companyPhoneticName: unknown;
    ownerCommsId: string;
    contactSourceType: string;
    shouldDisplay: boolean;
    contactPreferenceInfoList: unknown;
    recommendationInfoList: unknown[];
    mediaMap: Record<string, unknown>;
}

// ---------- devices ----------

/** Device as returned by `/api/devices-v2/device` (before the helper properties are added) */
export interface DeviceInfo {
    accountName: string;
    appDeviceList: AppDevice[];
    associatedUnitIds: unknown;
    capabilities: string[];
    charging: unknown;
    clusterMembers: string[];
    deviceAccountId: string;
    /** e.g. ECHO, VOX, KNIGHT, TABLET, WHA */
    deviceFamily: string;
    deviceOwnerCustomerId: string;
    deviceType: string;
    deviceTypeFriendlyName: string | null;
    essid: unknown;
    language: unknown;
    macAddress: unknown;
    online: boolean;
    parentClusters: string[];
    postalCode: unknown;
    registrationId: unknown;
    remainingBatteryLevel: unknown;
    serialNumber: string;
    softwareVersion: string;
}

/** Response of `getDevices()` */
export interface DevicesResponse {
    devices: DeviceInfo[];
}

/** Address of a device */
export interface DeviceAddress {
    address1: string;
    address2: string;
    address3: unknown;
    city: string;
    countryCode: string;
    county: unknown;
    district: unknown;
    houseNumber: unknown;
    label: unknown;
    postalCode: string;
    state: unknown;
    street: string;
}

/** Preferences of a device */
export interface DevicePreferences {
    appDeviceList: AppDevice[];
    deviceAccountId: string;
    deviceAddress: string;
    deviceAddressModel: DeviceAddress;
    deviceAddressSettingsVersion: number;
    deviceSerialNumber: string;
    deviceType: string;
    dialingPrefix: unknown;
    /** e.g. METRIC */
    distanceUnits: string;
    firstRunCompleted: boolean;
    goldfishEnabled: boolean;
    locale: string;
    notificationEarconEnabled: boolean;
    overrideDeviceAddressValidation: boolean;
    peonyEnabled: boolean;
    postalCode: string;
    /** e.g. BELL */
    providerPreference: string;
    /** e.g. CONCISE */
    responseStyle: string;
    searchCustomerId: string;
    supportedLocales: string[];
    /** e.g. CELSIUS */
    temperatureScale: string;
    timeZoneId: string;
    /** e.g. EUROPE */
    timeZoneRegion: string;
}

/** Response of `getDevicePreferences()` without device */
export interface DevicePreferencesResponse {
    devicePreferences: DevicePreferences[];
}

/** Wake word of a device */
export interface WakeWord {
    active: boolean;
    deviceSerialNumber: string;
    deviceType: string;
    midFieldState: unknown;
    /** e.g. ALEXA */
    wakeWord: string;
}

/** Response of `getWakeWords()` */
export interface WakeWordsResponse {
    wakeWords: WakeWord[];
}

/** Device paired via bluetooth */
export interface BluetoothPairedDevice {
    address: string;
    friendlyName?: string;
    [key: string]: unknown;
}

/** Bluetooth state of a device */
export interface BluetoothState {
    deviceSerialNumber: string;
    deviceType: string;
    friendlyName: string | null;
    gadgetPaired: boolean;
    online: boolean;
    pairedDeviceList: BluetoothPairedDevice[] | null;
    sconeBattery: unknown;
    sconePaired: boolean;
    softwareVersion: string;
    streamingState: unknown;
}

/** Response of `getBluetooth()` */
export interface BluetoothResponse {
    bluetoothStates: BluetoothState[];
}

/** Volume of a device */
export interface DeviceVolume {
    alertVolume: number | null;
    deviceType: string;
    dsn: string;
    error: unknown;
    speakerMuted: boolean;
    speakerVolume: number;
}

/** Response of `getAllDeviceVolumes()` */
export interface DeviceVolumesResponse {
    volumes: DeviceVolume[];
}

/** "Do not disturb" state of a device */
export interface DoNotDisturbStatus {
    deviceSerialNumber: string;
    deviceType: string;
    enabled: boolean;
}

/** Response of `getDeviceStatusList()` / `getDoNotDisturb()` */
export interface DoNotDisturbStatusResponse {
    doNotDisturbDeviceStatusList: DoNotDisturbStatus[];
}

/** Response of `getDeviceWifiDetails()` */
export interface DeviceWifiDetails {
    deviceSerialNumber: string;
    deviceType: string;
    essid: unknown;
    macAddress: string;
}

/** Response of `getEqualizerEnabled()` */
export interface EqualizerEnabledResponse {
    enabled: boolean;
}

/** Response of `getEqualizerRange()` */
export interface EqualizerRangeResponse {
    min: number;
    max: number;
}

/** Response of `getEqualizerSettings()` */
export interface EqualizerSettingsResponse {
    bass: number;
    mid: number;
    treble: number;
}

// ---------- notifications ----------

/** Response of `getNotifications()` */
export interface NotificationsResponse {
    actorMetadataList: unknown;
    notifications: Notification[];
}

/** Response of `getNotificationSounds()` */
export interface NotificationSoundsResponse {
    notificationSounds: Sound[];
}

/** Response of `getDeviceNotificationDefaultSound()` */
export interface DefaultNotificationSoundResponse {
    defaultNotificationSound: Sound;
}

/** Response of `getDeviceNotificationState()` */
export interface DeviceNotificationState {
    deviceSerialNumber: string;
    deviceType: string;
    softwareVersion: string;
    volumeLevel: number;
}

/** "Ascending alarm" setting of a device */
export interface AscendingAlarmState {
    ascendingAlarmEnabled: boolean;
    deviceSerialNumber: string;
    deviceType: string;
}

/** Response of `getAscendingAlarmState()` without device */
export interface AscendingAlarmResponse {
    ascendingAlarmModelList: AscendingAlarmState[];
}

// ---------- routines, music, skills ----------

/** Music provider (`getMusicProviders()` returns a list of them) */
export interface MusicProvider {
    id: string;
    displayName: string;
    description: string | null;
    /** e.g. Alexa.Music.PlaySearchPhrase */
    supportedProperties: string[];
    supportedTriggers: unknown[];
    supportedOperations: string[];
    supportedConditions: unknown[];
    /** e.g. AVAILABLE */
    availability: string;
    icon: unknown;
    providerData: {
        isDefaultMusicProvider?: boolean;
        isDefaultStationProvider?: boolean;
        categoryType?: string;
        categoryDisplayName?: string;
    };
}

/** Trigger of a routine (e.g. an utterance) */
export interface AutomationTrigger {
    id: string;
    /** e.g. Alexa.Trigger.Utterance */
    type: string;
    payload: {
        customerId?: string;
        utterance?: string;
        locale?: string;
        marketplaceId?: string;
        [key: string]: unknown;
    };
    skillId: unknown;
    timeLapse: unknown;
    presentationDataList: unknown;
    imageUrl: unknown;
    clientData: unknown;
    context: unknown;
    primitiveId: string;
}

/** Routine (`getAutomationRoutines()` returns a list of them) */
export interface AutomationRoutine {
    '@type': string;
    automationId: string;
    name: string | null;
    nlDescription: unknown;
    triggers: AutomationTrigger[];
    /** Sequence with nested serial/parallel nodes, see `SequenceNode` */
    sequence: {
        '@type': string;
        sequenceId: string;
        startNode: Record<string, any>;
    };
    owner: { '@type': string; ownerType: string; id: string };
    person: unknown;
    clientAlias: string;
    condition: unknown;
    /** e.g. ENABLED */
    status: string;
    tags: unknown;
    presentationDataList: unknown;
    creationTimeEpochMillis: number;
    lastUpdatedTimeEpochMillis: number;
    experience: unknown;
    groupId: unknown;
    identifiers: unknown;
    /** e.g. ROUTINE */
    type: string;
}

/** Skill in the routine catalog */
export interface RoutineCatalogItem {
    itemType: string;
    catalogId: string;
    catalogType: string;
    skillId: string;
    title: string;
    description: string;
    imageUrl: string;
    iconData: { '@iconType': string; badgeText: string; badgeColor: string };
    disabled: boolean;
    disabledMessage: { body: string };
    /** e.g. NOT_ENTITLED */
    benefitStatus: string;
}

/** Response of `getRoutineSkillCatalog()` */
export interface RoutineSkillCatalogResponse {
    catalog: {
        catalogId: string;
        catalogType: string;
        catalogItems: RoutineCatalogItem[];
    };
}

// ---------- voice history ----------

/** Part of a voice history record (what was said or answered) */
export interface VoiceHistoryRecordItem {
    recordItemKey: string;
    /** e.g. CUSTOMER_TRANSCRIPT, ASR_REPLACEMENT_TEXT, ALEXA_RESPONSE, TTS_REPLACEMENT_TEXT */
    recordItemType: string;
    utteranceId: string;
    timestamp: number;
    transcriptText: string;
    agentVisualName: string;
    personsInfo: unknown[];
}

/** Voice history record as delivered by Amazon (`data` of `CustomerHistoryEntry`) */
export interface CustomerHistoryRecord {
    /** "<customer id>#<timestamp>#<device type>#<serial number>" */
    recordKey: string;
    /** e.g. VOICE_HISTORY */
    recordType: string;
    timestamp: number;
    customerId: string;
    device: { deviceName: string; deviceEntityId: unknown };
    isBinaryFeedbackProvided: boolean;
    isFeedbackPositive: boolean;
    /** e.g. GENERAL, WAKE_WORD_ONLY */
    utteranceType: string;
    /** e.g. Global */
    domain: string;
    /** e.g. NextIntent */
    intent: string;
    skillName: string;
    voiceHistoryRecordItems: VoiceHistoryRecordItem[];
    personsInfo: unknown[];
    cardResponse: unknown;
}

/** Response of the voice history API (customer-history-records-v2) */
export interface CustomerHistoryRecordsResponse {
    customerHistoryRecords: CustomerHistoryRecord[];
    encodedRequestToken: unknown;
    noDataFoundWithinTimeLimit: boolean;
    lastRecordTimestamp: unknown;
    voiceProfileAssociatedWithPerson: boolean;
}

/** Entry of the voice history as converted by `getCustomerHistoryRecords()` */
export interface CustomerHistoryEntry {
    /** The original record */
    data: CustomerHistoryRecord;
    /** Record items by type (e.g. CUSTOMER_TRANSCRIPT) */
    conversionDetails?: Record<string, VoiceHistoryRecordItem[]>;
    deviceSerialNumber: string;
    deviceType: string | null;
    /** Name of the device */
    name: string;
    creationTimestamp: number | null;
    /** What was said (without wake word) */
    description: { summary: string };
    /** What Alexa answered */
    alexaResponse: string;
}

/** Data of the `ws-device-activity` event */
export interface DeviceActivityEvent extends CustomerHistoryEntry {
    destinationUserId?: string;
}

// ---------- lists (V2 API) ----------

/** List as returned by the V2 lists API */
export interface ListV2 {
    /** IDs of the list in the old API */
    id: string[];
    listId: string;
    /** Name of custom lists (not set for the shopping and to-do list) */
    listName?: string;
    customerId: string;
    encryptedListName: unknown;
    version: number;
    createAt: number;
    updateAt: number;
    lastItemUpdateAt: unknown;
    /** e.g. ACTIVE */
    listStatus: string;
    /** e.g. SHOP, TODO */
    listType: string;
    /** e.g. OWNED */
    ownershipType: string | null;
    bundleItemCount: unknown;
    source: unknown;
    /** Requested aggregations, e.g. `totalActiveItemsCount` = '{"count":3,"hasMore":false}' */
    aggregatedAttributes: { totalActiveItemsCount?: string } | null;
    aggregationError: Record<string, unknown> | null;
    servings: unknown;
    sourceRecipeId: unknown;
    bundleDefinitionId: unknown;
    householdInformation: { customerIds: string[]; oldestCID: string };
}

/** Item of a list in the V2 lists API */
export interface ListItemV2 {
    itemId: string;
    listId: string;
    customerId: string;
    itemName: string;
    encryptedItemName: string;
    /** Version of the item, needed to update or delete it */
    version: number;
    createAt: number;
    updateAt: number;
    /** ACTIVE or COMPLETE */
    itemStatus: string;
    speakerId: unknown;
    note: string | null;
    quantity: unknown;
    dealInfo: unknown;
    asinInfo: unknown;
    source: unknown;
    bundleId: unknown;
    structuredIngredient: unknown;
    /** e.g. ITEM */
    entityType: string;
    /** e.g. KEYWORD */
    itemType: string;
    favoritesForInternProject: unknown;
    aggregatedAttributes: unknown;
    itemOrigin: unknown;
    universalPrivacyCode: unknown;
}

// ---------- push messages (raw payloads of the `command` event) ----------

/** Device a push message belongs to */
export interface DopplerId {
    deviceSerialNumber: string;
    deviceType: string;
}

/** Payload of PUSH_VOLUME_CHANGE */
export interface VolumeChangePush {
    destinationUserId: string;
    dopplerId: DopplerId;
    isMuted: boolean;
    volumeSetting: number;
}

/** Payload of PUSH_EQUALIZER_STATE_CHANGE */
export interface EqualizerStateChangePush {
    destinationUserId: string;
    dopplerId: DopplerId;
    bass: number;
    midrange: number;
    treble: number;
}

/** Payload of PUSH_AUDIO_PLAYER_STATE */
export interface AudioPlayerStatePush {
    destinationUserId: string;
    dopplerId: DopplerId;
    /** e.g. PLAYING, INTERRUPTED, FINISHED */
    audioPlayerState: string;
    mediaReferenceId: string;
    quality: unknown;
    error: boolean;
    errorMessage: string | null;
}

/** Payload of PUSH_NOTIFICATION_CHANGE */
export interface NotificationChangePush {
    destinationUserId: string;
    dopplerId: DopplerId;
    notificationId: string;
    notificationVersion: number;
    /** e.g. CREATE, UPDATE, DELETE */
    eventType: string;
}

/** Link to an image or logo */
export interface MediaImage {
    altText: string | null;
    url: string;
    contentType: string | null;
}

/** Data about the currently played media (NotifyNowPlayingUpdated) */
export interface NowPlayingData {
    /** e.g. com.amazon.alexa.media.access.shared.model.MusicNowPlayingData */
    '@class': string;
    /** State of the controls: ENABLED, DISABLED or HIDDEN */
    transport: {
        playPause: string;
        next: string;
        previous: string;
        shuffle: string;
        repeat: string;
        seekForward: string;
        seekBackward: string;
        thumbsUp: string;
        thumbsDown: string;
    };
    progress: {
        visible: boolean;
        /** Position in ms */
        mediaProgress: number;
        /** Length in ms */
        mediaLength: number;
        allowScrubbing: boolean;
        showTiming: boolean;
    };
    /** e.g. PLAYING, PAUSED */
    playerState: string;
    queueId: string;
    mediaId: string;
    quality: { name: string; badge: MediaImage };
    provider: { providerName: string; providerLogo: MediaImage };
    mainArt: {
        altText: string | null;
        contentType: string;
        tinyUrl: string;
        smallUrl: string;
        mediumUrl: string;
        largeUrl: string;
        fullUrl: string;
    };
    /** title = title, subText1 = artist, subText2 = album */
    infoText: { title: string; subText1: string; subText2: string; multiLineMode: boolean };
    /** value is a JSON string, e.g. '{"contentId":"spotify:playlist:...","externalItemId":"spotify:track:..."}' */
    mediaReference: { namespace: string; name: string; value: string };
    sources: unknown[];
}

/** Payload of NotifyNowPlayingUpdated */
export interface NowPlayingUpdatedPush {
    messageId: string;
    /** NotifyNowPlayingUpdated */
    name: string;
    customerId: string;
    fallbackAllowed: boolean;
    update: {
        /** e.g. SessionUpdate */
        type: string;
        taskSessionId: string;
        update: {
            type: string;
            /** e.g. PLAYBACK_STARTED, PLAYBACK_STOPPED */
            cause: string;
            nowPlayingData: NowPlayingData;
            playbackError: boolean;
            errorMessage: string | null;
        };
    };
}

/** Payload of PUSH_LIST_ITEM_CHANGE */
export interface ListItemChangePush {
    destinationUserId: string;
    listId: string;
    listItemId: string;
    version: number;
    /** itemCreated, itemUpdated (also when checked) or itemDeleted */
    eventName: string;
}

/** Payload of NotifyMediaSessionsUpdated */
export interface MediaSessionsUpdatedPush {
    messageId: string;
    name: string;
    customerId: string;
    fallbackAllowed: boolean;
    update: { type: string; [key: string]: unknown };
}

// ---------- events of AlexaRemote ----------

/** Data of the `ws-volume-change` event */
export interface VolumeChangeEvent {
    destinationUserId: string;
    deviceSerialNumber: string;
    deviceType: string;
    isMuted: boolean;
    volume: number;
}

/** Data of the `ws-equilizer-state-change` event */
export interface EqualizerStateChangeEvent {
    destinationUserId: string;
    deviceSerialNumber: string;
    deviceType: string;
    bass: number;
    midrange: number;
    treble: number;
}

/** Data of the `ws-audio-player-state-change` event */
export interface AudioPlayerStateChangeEvent {
    destinationUserId: string;
    deviceSerialNumber: string;
    deviceType: string;
    mediaReferenceId: string;
    audioPlayerState: string;
    error: boolean;
    errorMessage: string | null;
}

/** Data of the `ws-notification-change` event */
export interface NotificationChangeEvent {
    destinationUserId: string;
    deviceSerialNumber: string;
    deviceType: string;
    eventType: string;
    notificationId: string;
    notificationVersion: number;
}

/** Data of the `ws-dnd-state-change` event */
export interface DndStateChangeEvent {
    destinationUserId: string;
    deviceSerialNumber: string;
    deviceType: string;
    enabled: boolean;
}

/** Data of the `ws-now-playing-updated` event */
export interface NowPlayingUpdatedEvent {
    /** Device, determined via the PUSH_AUDIO_PLAYER_STATE message before (null if unknown) */
    deviceSerialNumber: string | null;
    deviceType: string | null;
    customerId: string | null;
    taskSessionId: string | null;
    cause: string | null;
    mediaId: string | null;
    playerState: string | null;
    nowPlayingData: NowPlayingData | null;
}

/** Data of the `ws-todo-change` event (a list item changed) */
export interface TodoChangeEvent {
    destinationUserId: string;
    /** itemCreated, itemUpdated (also when checked) or itemDeleted */
    eventType: string;
    listId: string;
    listItemId: string;
    listItemVersion: number;
}
