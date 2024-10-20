let Alexa = require('../alexa-remote');
let alexa = new Alexa();

/***************************************************************/
// see: https://www.gehrig.info/alexa/Alexa.html
// cookie starts with x-amzn-dat and ends with =" csrf=12345780
let cookie = { ... };

alexa.on('cookie', (cookie, csrf, macDms) => {
    // This event is triggered when a cookie is generated OR refreshed.
    // Store these values for subsequent starts
    //
    // cookie to provide in options.cookie on next start
    // csrf belongs to cookie and both needed, but is normally extracted from cookie again on start
    // macDms needed for push connections. Provide in options.macDms on next start
    // Get alexa.cookieData and store too and provide the content in options.formerRegistrationData on next start to allow cookie refreshs
    //   You can also just store alexa.cookieData and provide this object as options.cookie, then options.formerRegistrationData is handled internally too
});


alexa.init({
        cookie: cookie,  // cookie if already known, else can be generated using proxy
        proxyOnly: true,
        proxyOwnIp: 'localhost', // required if proxy enabled: provide the own IP with which you later access the proxy.
                                 // Providing/Using a hostname here can lead to issues!
        proxyPort: 3001,         // optional: use this port for the proxy
        proxyLogLevel: 'info',
        bluetooth: true,
        logger: console.log, // optional

        // The following options are optional. Try without them first and just use really needed ones!!

        alexaServiceHost: 'layla.amazon.de', // optional, e.g. "pitangui.amazon.com" for amazon.com, default is "layla.amazon.de"
//        userAgent: '...', // optional, override used user-Agent for all Requests and Cookie determination
//        acceptLanguage: '...', // optional, override Accept-Language-Header for cookie determination
//        amazonPage: '...', // optional, override Amazon-Login-Page for cookie determination and referer for requests
        useWsMqtt: true, // optional, true to use the Websocket/MQTT direct push connection
//        pushDispatchHost: '...', // optional, override push endpoint host
        cookieRefreshInterval: 7*24*60*1000, // optional, cookie refresh intervall, set to 0 to disable refresh
        deviceAppName: '...', // optional: name of the device app name which will be registered with Amazon, leave empty to use a default one
        apiUserAgentPostFix: '...', // optional: postfix to add to api useragent, leave empty to use a default one
        formerDataStorePath: '...', // optional: overwrite path where some of the formerRegistrationData are persisted to optimize against Amazon security measures
        formerRegistrationData: { ... }, // optional/preferred: provide the result object from subsequent proxy usages (cookieData) here and some generated data will be reused for next proxy call too
        macDms: { ... }, // required in version 4.0 to use old Push connection! Is returned in cookieData.macDms, No longer needed since HTTP2-Push connection
        usePushConnectType: 3, // define which push connect type is used to initialize the push connection (type 1 and 2 or outdated, defaults to 3
        autoQueryActivityOnTrigger: false, // optional: if true, alexa will query the activity on each - use with care and only if needed!
    },
    function (err) {
        if (err) {
            console.log (err);
            return;
        }
        for (let deviceSerial of Object.keys(alexa.serialNumbers)) {
            console.log(deviceSerial);

            // const device = alexa.find(deviceSerial); // find device object by serial number
            // console.log(JSON.stringify(device, null, 2)); // print device object

            // device.sendCommand('volume', 50); // some methods are exposed on device object and can be called without device/deviceSerial
            // alexa.sendCommand(device, 'volume', 50); // but can also be called by providing the device object or serial on main class instance
            // alexa.sendSequenceCommand(deviceSerial, 'speak', 'Hello friends'); // send sequence command to device
        }
    }
);
