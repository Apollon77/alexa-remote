# alexa-remote2

[![NPM version](http://img.shields.io/npm/v/alexa-remote2.svg)](https://www.npmjs.com/package/alexa-remote2)
[![Downloads](https://img.shields.io/npm/dm/alexa-remote2.svg)](https://www.npmjs.com/package/alexa-remote2)
![Test and Release](https://github.com/Apollon77/alexa-remote/workflows/Test%20and%20Release/badge.svg)

Library to remote control an Alexa (Amazon Echo) device via LAN/WLAN.

## Disclaimer
**All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries! This personal project is maintained in spare time and has no business goal.**
**ALEXA is a trademark of AMAZON TECHNOLOGIES, INC.**

## Troubleshooting

### Issues when getting the cookie and tokens initially
If you still use the E-Mail or SMS based 2FA flow, then this might not work. Please update the 2FA/OTP method in the amazon settings to the current process.

If you open the Proxy URL from a mobile device where also the Alexa App is installed on, it might be that it does not work because Amazon might open the Alexa App. So please use a device or PC where the Alexa App is not installed

If you see a page that tells you that "alexa.amazon.xx is deprecated" and you should use the alexa app and with a QR code on it when you enter the Proxy URL" then this means that you call the proxy URL ith a different IP/Domainname then you entered in the "proxy own IP" settings, or you adjusted the IP shown in the Adapter configuration. The "proxy own IP" setting **needs to** match the IP/Domainname you use to call the proxy URL!

### Push Connections do not connect
Sometimes it could happen that because of too many connection tries aAmazon blocks the push connection endpoint for a specific IP and "device".

If the Push connection is never established, then you can try to use the following:
* delete all cookies, formerRegistrationData and macDms from the settings
* locale the location of the alexa-cookie2 library in your npm tree
* check if there is a file like .../alexa-cookie2/lib/formerDataStore.json - if existing please delete them
* get new cookie via proxy

Then it should work again

## Example

see example folder

## Thanks:
Partly based on [Amazon Alexa Remote Control](http://blog.loetzimmer.de/2017/10/amazon-alexa-hort-auf-die-shell-echo.html) (PLAIN shell) and [alexa-remote-control](https://github.com/thorsten-gehrig/alexa-remote-control) and [OpenHab-Addon](https://github.com/openhab/openhab2-addons/blob/f54c9b85016758ff6d271b62d255bbe41a027928/addons/binding/org.openhab.binding.amazonechocontrol)
Thank you for that work.

## Known issues/Todos
* getNotification works, changeNotification not ... maybe change is DELETE +Create :-) (+ source for createNotification: https://github.com/noelportugal/alexa-reminders/blob/master/alexa-reminders.js#L75, and Delete/create: https://github.com/openhab/openhab2-addons/blob/f54c9b85016758ff6d271b62d255bbe41a027928/addons/binding/org.openhab.binding.amazonechocontrol/src/main/java/org/openhab/binding/amazonechocontrol/internal/Connection.java#L829)
* docu docu docu (sorry ... will come)

## Changelog:
### 8.0.1 (2025-07-14)
* (Apollon77) Fix List updates in some cases. Disable removing details for now

### 8.0.0 (2025-07-13)
* IMPORTANT: This version updated "list" and "Smarthome" APIs to the latest Amazon changes. SOme of these are breaking! Please see changelog below for details!
* (Apollon77) Added new methods as "V2" to represent the new Amazon API. The delivered data have a different structure and some values are not available anymore.
  * getListsV2
  * getListV2
  * getListItemsV2
  * getSmarthomeDevicesV2
* (Apollon77) The following methods got deprecated and try to deliver a comparable response as before by internally using the new APIs. This mapping is done on best effort and might not be 100%!
  * getLists
  * getList
  * getListItems
  * getSmarthomeDevices
* (Apollon77) deleteListItem got a new options parameter added because the version of the list to delete is required now. An Error is returned if the version is not provided.
* (Apollon77) The following methods were updated to use the new APIs in the background, so no V2 method was added:
  * addListItem
  * updateListItem
* (Apollon77) The following former deprecated methods were removed 
  * getHistory
  * getActivities

### 7.0.5 (2024-10-20)
* (danielbrunt57) Adds additional Amazon domains for HTTP/2 push connections
* (beothorn) Fixes Typing information for "names" property

### 7.0.4 (2024-04-16)
* (Apollon77) Adjust Activity Record query to Amazon changes
* (NebzHB) fix missing amazonPage reference instead of amazon.de

### 7.0.3 (2024-01-25)
* (Apollon77) Adjust Activity Record query to newest Amazon changes

### 7.0.2 (2023-11-25)
* (Apollon77) Adjust some texts

### 7.0.1 (2023-11-24)
* (Apollon77) Prevent some error/crash cases

### 7.0.0 (2023-11-08)
* (Apollon77) Add new option "autoQueryActivityOnTrigger" to activate the automatic activity triggering (default is off!)
* (Apollon77) Optimize Timing for activity queries

### 6.2.2 (2023-10-29)
* (Apollon77) Optimize activity detection to process all relevant entries in all cases

### 6.2.1 (2023-10-27)
* (Apollon77) Optimize activity detection to process all relevant entries and not just the last one

### 6.2.0 (2023-10-27)
* (Apollon77) Adjust Activity detection to work with recent Amazon changes

### 6.1.2 (2023-09-12)
* (Apollon77) Optimize reconnection handling for push connections

### 6.1.1 (2023-09-09)
* (Apollon77) Fix for cookie refresh check

### 6.1.0 (2023-09-09)
* (Apollon77) Introduce optional parameter "pushDispatchHost" to specify the host for the push connection
* (Apollon77) Make sure cookie refresh timeout is valid and prevent overflow
* (Apollon77) Fix support for push connections JP/AU regions

### 6.0.2 (2023-09-09)
* (Apollon77) Added experimental support push connections in BR region

### 6.0.1 (2023-09-08)
* (Apollon77) Optimize reconnection timing
* (Apollon77) Added support for NA/JP and potentially AU regions

### 6.0.0 (2023-09-08)
* IMPORTANT: Node.js 16 is now required minimum Node.js version!
* (Apollon77) Replace WS-MQTT by the new HTTP/2 push connection

### 5.10.3 (2023-08-08)
* (Apollon77) Add new parameter usePushConnectType to specify which connectType for the push connection should be used (valid values 1, 2)

### 5.10.1 (2022-11-30)
* (Apollon77) Do not overwrite Device details by potentially duplicate App Device details

### 5.10.0 (2022-10-30)
* (Apollon77) Adjust deleteConversation to the new API (additional parameter is required!)

### 5.9.0 (2022-10-30)
* (Apollon77) Add new methods for enable/disable of alarms and use in changeNotification if Alarm or MusicAlarm

### 5.8.3 (2022-10-27)
* (Apollon77) Fix retry issues for rate limited responses from amazon
* (Apollon77) Lowercase text that sent to textcommand because other cases had issues in the past

### 5.8.2 (2022-08-19)
* (Apollon77) Fix doNotDisturb sequence command when time string was used

### 5.8.1 (2022-08-18)
* (Apollon77) Fix doNotDisturb sequence command

### 5.8.0 (2022-08-09)
* (Apollon77) Allow sendSequenceCommand method to also send commands to multiple devices (when supported by the relevant command like doNotDisturb)

### 5.7.6 (2022-08-06)
* (Apollon77) Fix Timer/Alarm creation with just providing the time and make sure next day is used when time on current day is already over

### 5.7.5 (2022-08-04)
* (Apollon77) Fix rate limit retries

### 5.7.4 (2022-08-03)
* (Apollon77) Update cookie library to optimize cookie handling in other regions like australia

### 5.7.3 (2022-07-19)
* (Apollon77) Fix deviceStop sequence command

### 5.7.2 (2022-07-19)
* (Apollon77) Fix crash case reported by Sentry

### 5.7.1 (2022-07-18)
* (Apollon77) Fix doNotDisturb/doNotDisturbAll in sequenceCommands
* (Apollon77) Other sequence command optimizations

### 5.7.0 (2022-07-18)
* (Apollon77) Enhance querySmarthomeDevices to directly hand over an array of request definitions to e.g. also specify properties or such
* (Apollon77) Enhance SequenceCommands:
  * "deviceStop" can also be called with an array of devices
  * add "deviceStopAll" to stop all devices
  * add "deviceDoNotDisturb" with allowed values as follows: boolean true/false to enable/disable or a number to set a enable-duration in seconds (up to 43.200 seconds = 12h) or use "HH:MM" as string to define an hour and minute till when it is set to not disturb
  * add "deviceDoNotDisturbAll" to set Do not disturb for all devices, allowed value is the same as deviceDoNotDisturb
  * add "fireTVTurnOn" to turn FireTV on (value ignored)
  * add "fireTVTurnOff" to turn FireTV off (value ignored)
  * add "fireTVTurnOnOff" to turn a FireTV device on (value===true) or off (value===false)
  * add "fireTVPauseVideo" to pause a video on a FireTV device
  * add "fireTVResumeVideo" to resume a video on a FireTV device
  * add "fireTVNavigateHome" to navigate home on a FireTV device
* (Apollon77) Add getFireTVEntities() method to get available FireTV devices and their supported actions
* (Apollon77) Flag Fire-TV devices as controllable and having music player support
* (Apollon77) Add several new methods to query and change settings:
  * getEqualizerEnabled()
  * getEqualizerRange()
  * getEqualizerSettings()
  * setEqualizerSettings()
  * getAuxControllerState()
  * setAuxControllerPortDirection()
  * getPlayerQueue()
  * getDeviceSettings() - generic method, ideally use the methods listed next to get specific settings
  * setDeviceSettings() - generic method, ideally use the methods listed next to get specific settings
  * getConnectedSpeakerOptionSetting()
  * setConnectedSpeakerOptionSetting()
  * getAttentionSpanSetting()
  * setAttentionSpanSetting()
  * getAlexaGesturesSetting()
  * setAlexaGesturesSetting()
  * getDisplayPowerSetting()
  * setDisplayPowerSetting()
  * getAdaptiveBrightnessSetting()
  * setAdaptiveBrightnessSetting()
  * getClockTimeFormatSetting()
  * setClockTimeFormatSetting()
  * getBrightnessSetting()
  * setBrightnessSetting()
* (Apollon77) Allow to overwrite the used default App-Name for the Amazon App Registration
* (Apollon77) An App name included in formerRegistrationData will be used for some API requests, else the default is used
* (Apollon77) Allow to modify the API-User-Agent Postfix to specify application name and version
* (Apollon77) Enhance the handling for exceeded rate limit responses
* (Apollon77/bbindreiter) Update used User-Agent for some requests

### 5.6.0 (2022-07-12)
* (Apollon77) Add sequence command "wait"

### 5.5.0 (2022-07-11)
* (Apollon77) Add playAudible() to play Audible books

### 5.4.0 (2022-07-11)
* (Apollon77) Increase timeouts for getting smart home device data
* (Apollon77) support/handle "MusicAlarm" like "Alarm" on notifications
* (Apollon77) Add convertNotificationToV2() to convert a notification object from old/queried format into one that can be used to set with new/V2 API (very pragmatic for now)

### 5.3.0 (2022-07-09)
* (Apollon77) Adjust Alarm methods to use the new API from Amazon. Also createNotification() and parseValue4Notification() now returns the new format for Alarms
* (Apollon77) Enhance createNotification() to also support adding reccurence information 
* (Apollon77) Notification objects will also have a delete method now
* (Apollon77) Notifications can be cancelled now
* (Apollon77) Adjust logging when no callback is provided again, now logs also the body
* (Apollon77) Add methods:
  * getUsersMe()
  * getHousehold()
  * getNotificationSounds()
  * getDeviceNotificationState()
  * setDeviceNotificationVolume()
  * setDeviceNotificationDefaultSound()
  * getDeviceNotificationDefaultSound()
  * getAscendingAlarmState()
  * setDeviceAscendingAlarmState()
  * getRoutineSkillCatalog() to request the Skill catalog that can be used in Sequence Commands
  * cancelNotification()
  * setNotification() and setNotificationV2()

### 5.2.0 (2022-07-06)
* (Apollon77) Query API endpoints (including new method getEndpoints()) from Amazon on start and use this API endpoint for the calls
* (Apollon77) Enhance getDevicePreferences() to request preferences for one device
* (Apollon77) Add setDevicePreferences() to set the device preferences for a device
* (Apollon77) Add getDeviceWifiDetails() to get the Wifi definitions (including SSID and MAC) for a device
* (Apollon77) Load Device Preferences on startup and make accessible via device.preferences on the device objects
* (Apollon77) Add methods getDevicePreferences() and setDevicePreferences() to the alexa class and to the device objects
* (Apollon77) Add new Media Message "jump" (in sendMessage() method) with a mediaId as value (can be used to jump to another queue item)
* (Apollon77) Add getRoutineSoundList() to query available sound IDs for a routine
* (Apollon77) Add new command "sound" when creating/sending sequence nodes to play sounds
* (Apollon77) Add method getWholeHomeAudioGroups() to query information about the current Audio groups
* (Apollon77) Enhance sending "notification" sequence node to allow providing an object as value with keys title and text to specify the title for displaying the message too
* (Apollon77) Add setEnablementForSmarthomeDevice() to enable/disable a smart home device
* (Apollon77) Log Response with status code also when no callback is provided (but without body content)
* (Apollon77) Slightly adjust the calculated timeout when getting many smart home device values

### 5.1.0 (2022-07-04)
* (Apollon77) Detect Rate limit exceeded response and do one automatic request retry 10s later (plus a random part)
* (Apollon77) Calculate the timeout of querySmarthomeDevices dynamically between 10s and 60s (maximum overrideable by new optional parameter) depending on the number of devices to query

### 5.0.1 (2022-07-03)
* (Apollon77) fix type definition for sequenceCommand methods

### 5.0.0 (2022-07-02)
* BREAKING: SequenceNode methods throws an error on invalid data instead calling callback with error as before!
* (Apollon77) Enhance multi sequence Node methods to support building node structures with sub Parallel/SerialNodes
* (Apollon77) Adjust logic to get the "global" ownerCustomerId and use Authentication response from session verification call
* (Apollon77) Add getAuthenticationDetails() method to get the Authentication response from the last successful session verification call
* (Apollon77) Add method isWsMqttConnected() to query if the WS-MQTT connection is established or not
* (Apollon77/hive) Add method stopProxyServer() to stop the proxy server pot. opened from getting a new cookie
* (Apollon77) Adjust setTuneIn method to work again for stationIds (s*) and topicIds (t*)
* (Apollon77) Do an automatic request retry with a delay of 500-1000ms (random) when error 503 is returned from Amazon services
* (Apollon77/hive) Correctly end all timers on disconnect
* (Apollon77/hive) Optimize authentication check when no cookie is set
* (Apollon77) Prevent some crash cases

### 4.1.2 (2022-02-20)
* (TactfulElf) Allow csrf to be updated on cookie refresh and add 401 error handling

### 4.1.1 (2021-11-13)
* (Apollon77) Prevent crash case in edge cases when unexpected WSMQTT responses are received

### 4.1.0 (2021-11-13)
* (Apollon77) SequenceNodes created for a device are now bound to the "deviceOwnCustomer" - should help in mixed owner groups

### 4.0.4 (2021-11-06)
* (Apollon77) Fix crash case

### 4.0.3 (2021-10-12)
* (Apollon77) Fix crash case (Sentry IOBROKER-ALEXA2-AT)

### 4.0.2 (2021-10-12)
* (Apollon77) Adjust Timing on Push Connection initialization
* (Apollon77) Adjust timing when matching History entries because sometimes Amazon seems to need a bit longer for new infos become available

### 4.0.1 (2021-10-11)
* (Apollon77) Adjust call headers

### 4.0.0 (2021-10-11)
* IMPORTANT: Node.js 10 support is dropped, supports LTS versions of Node.js starting with 12.x
* (Apollon77) Change Push connection to new signed flow
* (RodolfoSilva) Add TypeScript Type definitions

### 3.9.0 (2021-07-30)
* (guilhermelirio) Add skill launch function
* (guilhermelirio) Add getSkills() function

### 3.8.1 (2021-06-04)
* (bbindreiter) Set missing Accept Header

### 3.8.0 (2021-05-11)
* (Apollon77) Always recognize "alexa" as wakeword to handle commands via the apps correctly

### 3.7.2 (2021-04-18)
* (Apollon77) Adjust automatic Cookie Refresh interval from 7 to 4 days
* (Apollon77) Add other checks for websocket connection handling (Sentry IOBROKER-ALEXA2-32)

### 3.7.1 (2021-02-03)
* (Apollon77) also capture tests from ASR_REPLACEMENT_TEXT and TTS_REPLACEMENT_TEXT into summary and alexaResponse

### 3.7.0 (2021-02-03)
* (Apollon77) Implement new method to get History/Activities
  * getActivities Method is still there and still triggers the Amazon route as till now. INo idea ng it still works for some users. I declared it as deprecated now
  * add new method "getCustomerHistoryRecords" which uses another endpoint on Amazon side and delivers different data. The return is returned relative compatible to getActivities, so should be a drop in replacement - beside the fact that some fileds can not be provided any longer and will be simply empty! (e.g. activityStatus, deviceAccountId ...) Also in the amazon data some fields are no longer existing (e.g. domainAttributes ...)
  * the event "ws-device-activity" is migrated to use the new getCustomerHistoryRecords endpoint, and so returns compatible, but not 100% the same data
* (Apollon77) Make sure to not hammer requests to Amazon in case the activity request returns an error and the received PUSH_ACTIVITY entry was not found
* (Apollon77) Detect and handle 50x error cases and handle them as if no content was returned
* (Apollon77) Enhance communication to also support gzip and deflate encoded responses because Amazon sometimes ignore requested Accept-Encoding specs. This also could improve speed

### 3.6.0 (2021-01-28)
* (Apollon77) Adjust to new automations (Routines) route
* (Apollon77) Add getAllDeviceVolumes method
* (Apollon77) Return relationships in getSmarthomeDevices call

### 3.5.2 (2021-01-17)
* (Apollon77) Fix potential crash issue (Sentry IOBROKER-ALEXA2-39)

### 3.5.0 (2020-12-24)
* (Apollon77) Fix potential crash issue (Sentry IOBROKER-ALEXA2-2V)
* (FliegenKLATSCH) add cookie as new event when a new cookie is generated
* (FliegenKLATSCH) fix error code handling

### 3.4.0 (2020-12-11)
* (Apollon77) add support for textCommand - tell an Alexa device a text as you would speak it

### 3.3.3 (2020-12-03)
* (Apollon77) fix potential crash case (Sentry IOBROKER-ALEXA2-2K)

### 3.3.2 (2020-11-23)
* (Apollon77) handle potential crash case (Sentry IOBROKER-ALEXA2-27)
* (Apollon77) also ignore PUSH_DEVICE_SETUP_STATE_CHANGE push messages
* (Apollon77) Optimize WSMQTT Reconnection handling for timeout cases

### 3.3.1 (2020-07-24)
* (Apollon77) Update cookie lib to maybe be more backward compatible if login/baseUrl was changed
* (Apollon77) Increase timeout when reading routines

### 3.3.0 (2020-07-19)
* (Apollon77) update amazon-cookie library again to optimize upgrades from earlier versions

### 3.2.6 (2020-07-16)
* (Apollon77) update amazon-cookie library: Another try to work around Amazon changes

### 3.2.5 (2020-07-15)
* (Apollon77) update amazon-cookie library: Another try to work around Amazon changes

### 3.2.4 (2020-07-15)
* (Apollon77) update amazon-cookie library: Another try to work around Amazon changes

### 3.2.3 (2020-07-13)
* (Apollon77) update amazon-cookie library to work around amazon security changes
* (Apollon77) Prevent crash on invalid data in request data (Sentry IOBROKER-ALEXA2-1A)
* (Apollon77) Make sure to handle invalid list responses correctly (Sentry IOBROKER-ALEXA2-1T)

### 3.2.2 (2020-06-17)
* (Apollon77) Optimize Request Handling to also Handle timeouts correctly
* (Apollon77) Increase timeouts for some Smart Home calls to 30s

### 3.2.1 (2020-06-17)
* (Apollon77) update amazon-cookie library: another optimization for Node.js 14

### 3.2.0 (2020-06-16)
* (Apollon77) Update Cookie Library to allow Proxy Signup again after Amazon changes
* (hive) add new commands, jokes/facts/goodnight/cleanup
* (hive) add new command curatedtts with allowed values ["goodbye", "confirmations", "goodmorning", "compliments", "birthday", "goodnight", "iamhome"] to play random curated sentences

### 3.1.0 (2019-12-30)
* (Apollon77) remove device._orig because really big objects happened and got exceptions on deep copy using JSION.stringify

### 3.0.3 (2019-12-28)
* (Apollon77) update cookie lib

### 3.0.2 (2019-12-26)
* (Apollon77) Prevent some errors

### 3.0.1 (2019-12-24)
* (Apollon77) Prevent some errors, dependency update

### 3.0.0 (2019-12-24)
* (Apollon77) dependency updates
* (Zefau) add functionality for handling of lists
* nodejs 8.x is minimum now!

### 2.5.5 (2019-08-09)
* (Apollon77) user different mqtt regex to hopefully support other countries better

### 2.5.4 (2019-08-08)
* (Apollon77) make sure amazon domains are used as configured instead of "amazon.de" sometimes

### 2.5.3 (2019-07-22)
* (Apollon77) also allow Reminders in Future >+1 day

### 2.5.0/1 (2019-07-21)
* (Apollon77) enhance announce/ssml to allow send to multiple devices using one command

### 2.4.0 (2019-07-21)
* (Apollon77) Finalize methods and logix to send and read and delete messages and what's needed for this

### 2.3.7 (2019-07-06)
* (Apollon77) fix (finally) special case on authentication check

### 2.3.6 (2019-07-05)
* (Apollon77) fix (finally) special case on authentication check

### 2.3.5 (2019-07-01)
* (Apollon77) fix special case on authentication check

### 2.3.4 (2019-06-25)
* (Apollon77) fix potential error on PUSH_MEDIA_PROGRESS_CHANGE push infos

### 2.3.3 (2019-06-23)
* (Apollon77) change authentication check to hopefully better handle DNS or other "Network unavailable" errors

### 2.3.2 (2019-06-21)
* (Apollon77) fix ssml

### 2.3.1 (2019-06-21)
* (Apollon77) optimize handling for missing csrf cases

### 2.3.0 (2019-06-20)
* (Apollon77) use alexa-cookie lib 2.1 with latest adoptions to Amazon changes (Cookie CSRF was missing)
* (Apollon77) fixed default cookie refresh interval
* (Apollon77) When Speak via SSML is done this is not send as card value
* (Apollon77) add PUSH_MEDIA_PROGRESS_CHANGE to known WS-MQTT topics
* (Apollon77) change WS reconnection logic to try once per minute

### 2.2.0 (2019-01-xx)
* (Apollon77) add new sequenceCommands "calendarNext", "calendarToday", "calendarTomorrow"
* (Apollon77) fix wake word handling and history sanitizing

### 2.1.0 (2019-01-12)
* (Apollon77) add new sequenceCommands "deviceStop", "notification", "announcement" and finally "ssml"

### 2.0.0 (2018-12-02)
* (Apollon77) upgrade amazon-cookie lib to 2.0

### 1.0.3 (2018-11-17)
* (Apollon77) upgrade amazon-cookie lib
* (Apollon77) better handle ws errors and upgrade ws version to still support nodejs 6

### 1.0.2 (2018-11-17)
* (Apollon77) upgrade amazon-cookie lib

### 1.0.1 (2018-11-09)
* (Apollon77) upgrade amazon-cookie lib
* (Apollon77) small fix for strange history summary content

### 1.0.0 (2018-09-06)
* (Apollon77) polishing and finalization and make it 1.0.0

### 0.6.1 (2018-08-28)
* (Apollon77) rework scenes and add option  to send Parallel or Sequencial commands
* (Apollon77) enhance methods for smart home device and group handling

### 0.6.0 (2018-08-24)
* (Apollon77) several fixes and optimizations
* (Apollon77) enhance methods for smart home device and group handling

### 0.5.2 (2018-08-16)
* (Apollon77) also allow new reminder on next day :-)

### 0.5.0 (2018-08-16)
* (Apollon77) fix an error when getting new cookie
* (Apollon77) Add Reminder and Alarms support.
* (Apollon77) Enhance Push Connection
* (Apollon77) Added some more deviceTypes

### 0.3.0 (2018-08-13)
* (Apollon77) Added Websocket/MQTT connection class and also initialize it when requested via alexa-remote class.
* (Apollon77) Websocet/MQTT class and also Alexa-Remote are now event emitters to be able to notify on push changes
* (Apollon77) many fixes and optimizations, changed code to be an ES6 class
* (Apollon77) reworked the "prepare" step and only initialize what's really needed and allow extra "init" methods also to update Devices, Bluetooth and such. Docs will follow
* (Apollon77) API breaking: executeAutomationRoutine is not expecting a routineId anymore, but the complete routine definition.

### 0.1.0
* (Apollon77) added automatic cookie renewal when email and password are provided
* (Apollon77) added authentication checks by bootstrap call (like [alexa-remote-control](https://github.com/thorsten-gehrig/alexa-remote-control))
* (Apollon77) several fixes
* (Apollon77) added logger option

### 0.0.x
* Versions by soef
