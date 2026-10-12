# Developer documentation

This document describes how to use `alexa-remote2` in your own project and how to work on the library itself.

- [Using the library](#using-the-library)
    - [Installation](#installation)
    - [Quick start](#quick-start)
    - [Cookie handling](#cookie-handling)
    - [Options](#options)
    - [Devices](#devices)
    - [Callbacks](#callbacks)
    - [Common tasks](#common-tasks)
    - [Push connection and events](#push-connection-and-events)
    - [Shutdown](#shutdown)
- [Working on the library](#working-on-the-library)
    - [Requirements](#requirements)
    - [Project structure](#project-structure)
    - [npm scripts](#npm-scripts)
    - [Tests](#tests)
    - [Code style](#code-style)
    - [Continuous integration](#continuous-integration)
    - [Releasing](#releasing)

## Using the library

### Installation

```bash
npm install alexa-remote2
```

Node.js 22.19 or newer is required. The package ships compiled CommonJS code and TypeScript type definitions.

### Quick start

JavaScript (CommonJS):

```js
const AlexaRemote = require('alexa-remote2');

const alexa = new AlexaRemote();

alexa.init(
    {
        cookie: storedCookieData, // see "Cookie handling"
        proxyOnly: true,
        proxyOwnIp: '192.168.1.10',
        proxyPort: 3001,
        bluetooth: true,
        notifications: true,
        usePushConnection: true,
        logger: console.log,
    },
    err => {
        if (err) {
            console.error(err);
            return;
        }
        console.log('Devices:', Object.keys(alexa.serialNumbers));
        alexa.sendSequenceCommand('Kitchen', 'speak', 'Hello world');
    },
);
```

TypeScript:

```ts
import AlexaRemote = require('alexa-remote2');
// or with "esModuleInterop": import AlexaRemote from 'alexa-remote2';

const alexa = new AlexaRemote();
const options: AlexaRemote.AlexaRemoteOptions = { cookie: storedCookieData, proxyOnly: true };
alexa.init(options, err => {
    /* ... */
});
```

All public types (`AlexaRemoteOptions`, `Serial`, `Notification`, `SequenceNodeCommand`, ...) are available in the `AlexaRemote` namespace.

A complete example with all options is in [`example/example.js`](example/example.js).

### Cookie handling

Amazon requires a valid cookie for all API calls. The cookie is created with [alexa-cookie2](https://github.com/Apollon77/alexa-cookie):

1. **First start:** call `init()` without `cookie` and with `proxyOnly: true`. alexa-cookie2 starts a login proxy and
   `init()` reports an error containing the proxy URL (`http://<proxyOwnIp>:<proxyPort>/`).
   Open it in a browser and log in to Amazon. `proxyOwnIp` **must** match the IP or host name you use in the browser.
   Do not use a device with the Alexa app installed for this.
2. When the login succeeds, the `cookie` event is emitted and the initialization continues.
3. **Store the data:** persist `alexa.cookieData` (the complete registration data, including `macDms` and the refresh token).
4. **Next starts:** pass the stored object as `cookie` option. No proxy login is needed anymore.

```js
alexa.on('cookie', (cookie, csrf, macDms) => {
    // cookie and csrf belong together; macDms is needed for the push connection
    saveToDisk(alexa.cookieData);
});
```

The cookie is refreshed automatically every `cookieRefreshInterval` milliseconds (default: 4 days, `0` disables it).
Every refresh emits the `cookie` event again, so always store the latest `alexa.cookieData`.

### Options

| Option                         | Type                | Description                                                                                              |
|--------------------------------|---------------------|----------------------------------------------------------------------------------------------------------|
| `cookie`                       | `string \| object`  | Cookie string or (preferred) the complete `cookieData` of a former login                                 |
| `proxyOnly`                    | `boolean`           | Only use the login proxy to get a cookie (the e-mail/password login is deprecated)                       |
| `proxyOwnIp`                   | `string`            | IP or host name used to reach the login proxy (required when the proxy is used)                          |
| `proxyPort`                    | `number`            | Port of the login proxy                                                                                  |
| `proxyLogLevel`                | `string`            | Log level of the login proxy                                                                             |
| `amazonPage`                   | `string`            | Amazon page for the login, e.g. `amazon.com`, `amazon.co.uk` (default `amazon.de`)                       |
| `alexaServiceHost`             | `string`            | Host of the website API, e.g. `pitangui.amazon.com`. Normally detected automatically                     |
| `acceptLanguage`               | `string`            | `Accept-Language` header for the login                                                                   |
| `userAgent`                    | `string`            | User agent for the login                                                                                 |
| `apiUserAgentPostfix`          | `string`            | Postfix appended to the user agent of API requests                                                       |
| `deviceAppName`                | `string`            | Name of the app device registered at Amazon                                                              |
| `formerRegistrationData`       | `object`            | Registration data of a former login, used to refresh the cookie (not needed if `cookie` is `cookieData`) |
| `formerDataStorePath`          | `string`            | Path where alexa-cookie2 persists some registration data                                                 |
| `macDms`                       | `object`            | Device registration data for the push connection (contained in `cookieData`)                             |
| `bluetooth`                    | `boolean`           | Load the bluetooth state of the devices on init                                                          |
| `notifications`                | `boolean`           | Load the notifications (alarms, reminders, timers) of the devices on init                                |
| `usePushConnection`            | `boolean`           | Open the push connection to receive events (`useWsMqtt` is the deprecated alias)                         |
| `pushDispatchHost`             | `string`            | Overrides the host of the push endpoint                                                                  |
| `cookieRefreshInterval`        | `number`            | Interval in ms for the automatic cookie refresh, `0` disables it (default 4 days)                        |
| `autoQueryActivityOnTrigger`   | `boolean`           | Query the voice history for triggers without activity data. Use with care!                               |
| `logger`                       | `function`          | Function used for debug logging, e.g. `console.log`                                                      |

Additional options are passed through to alexa-cookie2.

### Devices

After `init()` the devices are available in several lookup tables:

- `alexa.serialNumbers` – by serial number
- `alexa.names` – by account name (also lower case and `"name (friendly name)"`)
- `alexa.friendlyNames` – by device type friendly name

The easiest way to get a device is `alexa.find()`. It accepts a serial number, a name (case-insensitive) or a device
object, and returns `undefined`/`null` if nothing is found:

```js
const echo = alexa.find('Kitchen');
console.log(echo.serialNumber, echo.deviceFamily, echo.capabilities);
```

Every method that takes `serialOrName` accepts all of these variants. Commands that work on several devices
(`sendSequenceCommand`, `sendMultiSequenceCommand`) also accept an array.

Device objects also have bound helper methods, so the device parameter can be omitted:

```js
echo.sendCommand('volume', 30);
echo.setDoNotDisturb(true);
echo.rename('Kitchen Echo');
```

Additional device data loaded on init: `preferences`, `wakeWord`, `bluetoothState` (with `connect(on)` and `unpaire()`
helpers if `bluetooth` is enabled) and `notifications` (with `set()`, `delete()`, `cancel()` helpers if
`notifications` is enabled).

### Callbacks

The API is callback based. Callbacks have the signature `(err, body)`; `body` contains the parsed JSON answer from Amazon.
The callback is optional everywhere. To use promises, wrap the calls:

```js
const call = (method, ...args) =>
    new Promise((resolve, reject) =>
        alexa[method](...args, (err, body) => (err ? reject(err) : resolve(body))),
    );

const devices = await call('getDevices');
```

### Common tasks

#### Player control

```js
alexa.sendCommand('Kitchen', 'play', null);
alexa.sendCommand('Kitchen', 'volume', 40);
alexa.sendCommand('Kitchen', 'shuffle', true);
alexa.getPlayerInfo('Kitchen', (err, info) => console.log(info));
alexa.getPlayerQueue('Kitchen', (err, queue) => console.log(queue));
```

Supported commands: `play`, `pause`, `next`, `previous`, `forward`, `rewind`, `volume`, `shuffle`, `repeat`, `jump`.

#### Speak, announcements and routines (sequence commands)

```js
alexa.sendSequenceCommand('Kitchen', 'speak', 'Dinner is ready');
alexa.sendSequenceCommand(['Kitchen', 'Office'], 'announcement', 'Dinner is ready');
alexa.sendSequenceCommand('Kitchen', 'ssml', '<speak>Hello <break time="1s"/> world</speak>');
alexa.sendSequenceCommand('Kitchen', 'volume', 30);
alexa.sendSequenceCommand('Kitchen', 'textCommand', 'turn on the light'); // as if spoken to Alexa
alexa.sendSequenceCommand('Kitchen', 'weather');
alexa.sendSequenceCommand('Kitchen', 'notification', { title: 'Door', text: 'The door is open' }); // app push
alexa.sendSequenceCommand('Kitchen', 'deviceDoNotDisturb', '22:30'); // until 22:30, or seconds, or true/false
```

Available commands: `weather`, `traffic`, `flashbriefing`, `goodmorning`, `funfact`, `joke`, `cleanup`, `singasong`,
`tellstory`, `calendarToday`, `calendarTomorrow`, `calendarNext`, `wait`, `textCommand`, `sound`, `curatedtts`,
`volume`, `deviceStop`, `deviceStopAll`, `deviceDoNotDisturb`, `deviceDoNotDisturbAll`, `speak`, `skill`,
`notification`, `announcement`, `ssml`, `fireTVTurnOn`, `fireTVTurnOff`, `fireTVTurnOnOff`, `fireTVPauseVideo`,
`fireTVResumeVideo`, `fireTVNavigateHome`.

Texts for `speak` and `announcement` are limited to 250 characters.

Several commands can be combined into one routine. Nodes run one after another (`SerialNode`, default) or at once
(`ParallelNode`), and they can be nested:

```js
alexa.sendMultiSequenceCommand(
    'Kitchen',
    [
        { command: 'volume', value: 50 },
        { command: 'speak', value: 'Good morning' },
        {
            sequenceType: 'ParallelNode',
            nodes: [
                { command: 'weather', value: null },
                { command: 'volume', value: 20, device: 'Office' },
            ],
        },
    ],
    'SerialNode',
    (err, body) => {},
);
```

Routines created in the Alexa app:

```js
alexa.getAutomationRoutines((err, routines) => {
    const routine = routines.find(r => r.name === 'Good night');
    alexa.executeAutomationRoutine('Kitchen', routine);
});
```

#### Alarms, reminders and timers

```js
// reminder in one hour
alexa.setReminder('Kitchen', Date.now() + 3600000, 'Take out the trash');

// alarm at 07:30 on weekdays
const alarm = alexa.createNotificationObject('Kitchen', 'Alarm', null, '07:30', true, null, {
    freq: 'WEEKLY',
    byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
    interval: 1,
});
alexa.createNotification(alarm);

// list, change, cancel and delete
alexa.getNotifications((err, res) => {
    const n = res.notifications[0];
    alexa.changeNotification(n, '08:00'); // new time, or true/false to switch it on/off
    alexa.cancelNotification(n); // cancel the next occurrence
    alexa.deleteNotification(n);
});
```

#### Smart home

```js
// all smart home endpoints (GraphQL API)
alexa.getSmarthomeDevicesV2((err, endpoints) => {});
// deprecated: the same data mapped into the old format ({ locationDetails: { Default_Location: ... } })
alexa.getSmarthomeDevices((err, res) => {});
alexa.getSmarthomeEntities((err, entities) => {});

// query the state
alexa.querySmarthomeDevices(['entity-id-1', 'entity-id-2'], 'APPLIANCE', (err, res) => {});

// execute an action
alexa.executeSmarthomeDeviceAction('entity-id-1', { action: 'turnOn' }, 'APPLIANCE', (err, res) => {});
alexa.executeSmarthomeDeviceAction('entity-id-1', { action: 'setBrightness', brightness: 50 });
```

#### Music

```js
alexa.getMusicProviders((err, providers) => {});
alexa.playMusicProvider('Kitchen', 'SPOTIFY', 'Daft Punk');
alexa.setTunein('Kitchen', 's24896'); // TuneIn guide id
alexa.playAudible('Kitchen', 'book title');
```

#### Lists

The lists (shopping list, to-do list, custom lists) use the V2 lists API. The `getLists()`, `getList()` and
`getListItems()` methods still deliver the old format (best effort); the `...V2()` methods deliver the data as
Amazon sends it. Updating and deleting items requires the current `version` of the item.

```js
alexa.getListsV2((err, lists) => {
    const listId = lists[0].listId;
    alexa.addListItem(listId, 'Milk');
    alexa.getListItemsV2(listId, { limit: 50 }, (err, items) => {
        const item = items[0];
        // mark as completed
        alexa.updateListItem(listId, item.itemId, { version: item.version, value: item.itemName, completed: true });
        // or delete it
        // alexa.deleteListItem(listId, item.itemId, { version: item.version });
    });
});
```

#### More

Further methods cover the voice history (`getCustomerHistoryRecords`),
messaging (`getConversations`, `sendTextMessage`), bluetooth (`connectBluetooth`, `disconnectBluetooth`),
device settings (`getDeviceSettings`, `setEqualizerSettings`, `setBrightnessSetting`, ...) and more.
All public methods are documented with JSDoc in [`src/alexa-remote.ts`](src/alexa-remote.ts); the IDE shows the
documentation and parameter types.

If a method you need does not exist, `httpsGet(path, callback, flags)` and `httpsGetAuthApi(path, callback, flags)`
send arbitrary authenticated requests to the website API and the Alexa API.

### Push connection and events

With `usePushConnection: true` an HTTP/2 push connection to Amazon is opened after `init()`. Changes are emitted as
events on the `AlexaRemote` instance:

| Event                              | Description                                                          |
|------------------------------------|----------------------------------------------------------------------|
| `cookie`                           | A cookie was created or refreshed: `(cookie, csrf, macDms)`          |
| `ws-connect`                       | Push connection established                                          |
| `ws-disconnect`                    | Push connection closed: `(retries, reason)`                          |
| `ws-error`                         | Error of the push connection                                         |
| `ws-device-activity`               | A voice command was processed (contains the spoken text)             |
| `ws-volume-change`                 | Volume or mute state changed                                         |
| `ws-audio-player-state-change`     | Player started/paused/stopped                                        |
| `ws-media-change`                  | Media (track) changed                                                |
| `ws-media-progress-change`         | Playback progress changed                                            |
| `ws-media-queue-change`            | Player queue changed                                                 |
| `ws-content-focus-change`          | Content focus changed                                                |
| `ws-equilizer-state-change`        | Equalizer settings changed                                           |
| `ws-bluetooth-state-change`        | Bluetooth state changed                                              |
| `ws-device-connection-change`      | A device went online or offline                                      |
| `ws-notification-change`           | An alarm, reminder or timer changed                                  |
| `ws-todo-change`                   | A list item changed                                                  |
| `ws-now-playing-updated`           | Now playing data changed (title, artist, progress, provider, ...)    |
| `ws-dnd-state-change`              | "Do not disturb" was switched on or off                              |
| `ws-unknown-command`               | Unknown push command (useful for debugging)                          |
| `ws-unknown-message`               | Unknown or unparsable push message (useful for debugging)            |

```js
alexa.on('ws-device-activity', activity => {
    console.log(`${activity.deviceSerialNumber}: ${activity.description.summary}`);
});
alexa.on('ws-volume-change', ({ deviceSerialNumber, volume, isMuted }) => {});
```

`isPushConnected()` reports the connection state. The connection reconnects automatically.

### Shutdown

```js
alexa.stop();
```

`stop()` clears the cookie refresh timer, closes the push connection and stops the login proxy so the process can exit.

## Working on the library

### Requirements

- Node.js 22.19 or newer (the CI uses Node.js 24)
- npm

```bash
git clone https://github.com/Apollon77/alexa-remote.git
cd alexa-remote
npm install
npm test
```

### Project structure

```
src/
  alexa-remote.ts      main class (exported with `export =`, so `require('alexa-remote2')` returns the class)
  alexa-http2push.ts   HTTP/2 push connection
  alexa-wsmqtt.ts      legacy WebSocket/MQTT push connection
  types.ts             public types, re-exported in the AlexaRemote namespace
test/
  helpers.mts          FakeAmazon, fixtures and helpers for the tests
  *.test.mts           tests (node:test)
  tsconfig.json        type check configuration for the tests
example/
  example.js           usage example
build/                 compiled output (generated, not committed)
```

The package publishes only `build/` and `LICENSE` (see `files` in `package.json`).

### npm scripts

| Script               | Description                                                       |
|----------------------|-------------------------------------------------------------------|
| `npm run build`      | Compiles `src/` to `build/` (JS, `.d.ts`, source maps)            |
| `npm run lint`       | Lints `src/` with ESLint and Prettier                             |
| `npm test`           | Builds and runs the unit tests                                    |
| `npm run test:unit`  | Type checks and runs the unit tests (needs an existing build)     |
| `npm run release`    | Creates a release (see [Releasing](#releasing))                   |

### Tests

The tests use the built-in Node.js test runner and run against the **compiled** code in `build/`, so run
`npm run build` first (or just `npm test`). Node.js executes the `.mts` test files directly via type stripping;
`tsc -p test/tsconfig.json` type checks them before.

Run a single file or test:

```bash
node --test test/sequence.test.mts
node --test --test-name-pattern="creates stop nodes" test/sequence.test.mts
```

No network access is needed. `FakeAmazon` from `test/helpers.mts` replaces `https.request`, answers requests from a
route table and records every request:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type AlexaRemote from '../build/alexa-remote.js';
import { FakeAmazon, createAlexa, call } from './helpers.mts';

describe('getPlayerInfo()', () => {
    // default routes answer everything init() needs; add routes for the calls under test
    const fake = new FakeAmazon().on(/\/api\/np\/player/, { body: { playerInfo: { state: 'PLAYING' } } });
    let alexa: AlexaRemote;

    before(async () => {
        fake.install();
        alexa = await createAlexa(); // initialized instance with the devices ECHO (S1) and FIRE_TV (S2)
    });

    after(() => {
        alexa.stop();
        fake.uninstall();
    });

    it('queries the player of the device', async () => {
        const { err, res } = await call(cb => alexa.getPlayerInfo('S1', cb));
        assert.ifError(err);
        assert.equal(res.playerInfo.state, 'PLAYING');
        assert.match(fake.last(/\/api\/np\/player/)!.path, /deviceSerialNumber=S1/);
    });
});
```

Helpers:

- `FakeAmazon#on(regexp, response)` – adds a route (later routes win). The response can be an object
  (`status`, `body`, `encoding`, `timeout`, `error`) or a function receiving the recorded request.
- `FakeAmazon#find(regexp)` / `FakeAmazon#last(regexp)` – recorded requests matching `host + path`.
- `createAlexa(options?)` – returns an initialized `AlexaRemote` instance.
- `initOptions(options?)` – the options used by `createAlexa()`, e.g. for testing `init()` itself.
- `call(cb => ...)` – turns a callback API call into a promise of `{ err, res }`.

Use `mock.timers` from `node:test` for date-dependent code (see `test/notifications.test.mts`).

### Code style

- TypeScript in strict mode, compiled to CommonJS (`@tsconfig/node22`).
- ESLint with `@iobroker/eslint-config` and Prettier (`eslint.config.mjs`, `prettier.config.mjs`). Run `npm run lint`
  before committing.
- Use `node:` imports, arrow functions, optional chaining (`callback?.()`, `this._options.logger?.()`) and
  `includes()` instead of `indexOf()`.
- Document public methods and types with JSDoc in English.
- Keep the callback signatures backwards compatible; many methods accept the callback in an earlier parameter position.
- Add a changelog entry under `### __WORK IN PROGRESS__` in `README.md` for every user-visible change.

### Continuous integration

`.github/workflows/test-and-release.yml` runs on every push and pull request:

1. **check-and-lint** – installs the dependencies and runs `npm run lint`.
2. **adapter-tests** – builds the package and runs `npm run test:unit`.
3. **deploy** – only for tags `v*`: builds, publishes to npm and creates a GitHub release.

Add `[skip ci]` to the commit message to skip the workflow.

### Releasing

Releases are created with [`@alcalzone/release-script`](https://github.com/AlCalzone/release-script):

```bash
npm run release patch   # or minor, major
```

The script moves the `__WORK IN PROGRESS__` changelog entries to the new version, updates the version in
`package.json`, updates the copyright year in `LICENSE`, commits, tags and pushes. The pushed tag triggers the
`deploy` job.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no `NPM_TOKEN` secret
is needed. The package `alexa-remote2` must have this repository and the workflow `test-and-release.yml` configured as
trusted publisher on npmjs.com.
