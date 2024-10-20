/*

This is a simple express js server that saves alexa cookies under home/.alexaRemote
It offers these endpoints:
/reconnect
  GET - Will try to reconect using the persisted cookies or redirect to the login page
/names
  GET - Will return a list of devices and related values, including serial number
/speak
  POST - Will say a text on a device, body is { serial: 'SERIAL_HERE', text: "Hello" }
*/
import Alexa from 'alexa-remote2';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const cookiePath = 'alexa-cookie.txt';
const macDmsPath = 'macDms.txt';
const homeDir = os.homedir();
const separator = path.sep;
const alexaRemotePath = path.join(homeDir, '.alexaRemote');

if (!fs.existsSync(alexaRemotePath)) {
    fs.mkdirSync(alexaRemotePath);
}

console.log(`Folder created at: ${alexaRemotePath}`);

const expressPort = 3000;
const alexaLoginPort = 3001;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let alexa = new Alexa();

alexa.init(
    {
        cookie: readFromFile(cookiePath),
        proxyOnly: true,
        proxyOwnIp: 'localhost',
        proxyPort: alexaLoginPort,
        proxyLogLevel: 'info',
        bluetooth: true,
        logger: console.log,
        macDms: readFromFile(macDmsPath),
    }, 
    function (err) {
        if (err) {
            console.log(err);
        } else {
            console.log('alexa connection was reinitialized');
        }
    }
);

alexa.on('cookie', (cookie, csrf, macDms) => {
    writeToFile(cookiePath, cookie);
    writeToFile(macDmsPath, macDms);
});

app.get('/', (req, res) => {
    if (!alexa) {
        res.send('use /connect to start');
    }
});

app.get('/reconnect', (req, res) => {
    alexa = new Alexa();

    alexa.init({
        cookie: readFromFile(cookiePath),
        proxyOnly: true,
        proxyOwnIp: 'localhost',
        proxyPort: alexaLoginPort,
        proxyLogLevel: 'info',
        bluetooth: true,
        logger: console.log,
        macDms: readFromFile(macDmsPath),
    }, function (err) {
        if (err) {
            console.log(err);
            const url = extractUrl(err.message);
            if (url == 'no match') {
                res.send(`Error reinitializing: ${err.message}`);
            } else {
                res.redirect(url);
                return;
            }
        } else {
            res.send('alexa connection was reinitialized');
        }
    });
    alexa.on('cookie', (cookie, csrf, macDms) => {
        writeToFile(cookiePath, cookie);
        writeToFile(macDmsPath, macDms);
    });

});

// Lots of information about devices
app.get('/names', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(alexa.names));
});

// expects a json: { deviceName: "Kitchen", text: "Something to say" }
// try from the command line: 
// curl 'http://localhost:3000/speak' -H 'Content-Type: application/json' --data-raw '{"deviceName":"Kitchen","text":"Hi"}'
app.post('/speak', (req, res) => {
    const data = req.body;
    const serial = alexa.names[data.deviceName].serialNumber;
    alexa.sendSequenceCommand(serial, 'speak', data.text);
    res.send('Data received');
});

app.listen(expressPort, () => {
    console.log(`Example app listening on port ${expressPort}`)
});

function extractUrl(errorMessage) {
    const urlPattern = /http:\/\/[^\s:\/]+:\d+\//;
    const match = errorMessage.match(urlPattern);
    return match ? match[0] : "no match";
}

function readFromFile(path) {
    try {
        const data = fs.readFileSync(`${alexaRemotePath}${separator}${path}`, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return {};
        } else {
            console.error(`Error reading file ${path}`, err);
            return {};
        }
    }
}

function writeToFile(path, data) {
    try {
        const jsonString = JSON.stringify(data, null, 2);
        fs.writeFileSync(`${alexaRemotePath}${separator}${path}`, jsonString);
        console.log(`Successfully writen ${path}`);
    } catch (err) {
        console.error(`Error writing file ${path}`, err);
    }
}