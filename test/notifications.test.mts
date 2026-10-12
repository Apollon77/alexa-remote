import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import type AlexaRemote from '../build/alexa-remote.js';
import { FakeAmazon, createAlexa, call } from './helpers.mts';

// 2024-05-10 10:00:00 local time
const NOW = new Date(2024, 4, 10, 10, 0, 0).getTime();

const ALARM = {
    id: 'T1-S1-idx1',
    notificationIndex: 'idx1',
    type: 'Alarm',
    deviceSerialNumber: 'S1',
    deviceType: 'T1',
    alarmTime: new Date(2024, 4, 10, 12, 0, 0).getTime(),
    originalDate: '2024-05-10',
    originalTime: '12:00:00.000',
    status: 'ON',
    sound: { id: 'system_alerts_melodic_01' },
};

describe('notifications', () => {
    const fake = new FakeAmazon().on(/\/api\/notifications\?/, { body: { notifications: [ALARM] } });
    let alexa: AlexaRemote;

    before(async () => {
        fake.install();
        alexa = await createAlexa();
        mock.timers.enable({ apis: ['Date'], now: NOW });
    });

    after(() => {
        mock.timers.reset();
        alexa.stop();
        fake.uninstall();
    });

    it('attaches the notifications with helper methods to the devices on init', () => {
        const notifications = alexa.serialNumbers.S1.notifications;
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].id, 'T1-S1-idx1');
        assert.equal(typeof notifications[0].set, 'function');
        assert.equal(typeof notifications[0].delete, 'function');
        assert.equal(typeof notifications[0].cancel, 'function');
        assert.deepEqual(alexa.serialNumbers.S2.notifications, []);
    });

    it('creates timers', () => {
        const timer: any = alexa.createNotificationObject('S1', 'Timer', 'Pizza', 60000);
        assert.equal(timer.type, 'Timer');
        assert.equal(timer.timerLabel, 'Pizza');
        assert.equal(timer.reminderLabel, null);
        assert.equal(timer.deviceSerialNumber, 'S1');
        assert.equal(timer.status, 'OFF');
    });

    it('creates reminders for a timestamp', () => {
        const reminder: any = alexa.createNotificationObject(
            'S1',
            'Reminder',
            'Call mom',
            new Date(2024, 4, 11, 18, 30, 0).getTime(),
            true,
        );
        assert.equal(reminder.type, 'Reminder');
        assert.equal(reminder.reminderLabel, 'Call mom');
        assert.equal(reminder.originalDate, '2024-05-11');
        assert.equal(reminder.originalTime, '18:30:00.000');
        assert.equal(reminder.status, 'ON');
    });

    it('creates alarms in the V2 format and moves past times to the next day', () => {
        const alarm: any = alexa.createNotificationObject('S1', 'Alarm', null, '08:30', true);
        // 08:30 is already over at 10:00, so the alarm is set for tomorrow
        assert.deepEqual(alarm.trigger, { scheduledTime: '2024-05-11T08:30:00' });
        assert.deepEqual(alarm.extensions, []);
        assert.equal(alarm.endpointId, 'S1@T1');
    });

    it('creates alarms with recurrence and sound', () => {
        const recurrence = { freq: 'WEEKLY' as const, byDay: ['MO', 'FR'], interval: 1 };
        const alarm: any = alexa.createNotificationObject(
            'S1',
            'Alarm',
            null,
            '11:15',
            true,
            { id: 'snd' } as any,
            recurrence,
        );
        assert.deepEqual(alarm.trigger, { scheduledTime: '2024-05-10T11:15:00', recurrence });
        assert.deepEqual(alarm.assets, [{ type: 'TONE', assetId: 'snd' }]);
    });

    it('returns null for unknown devices', () => {
        assert.equal(alexa.createNotificationObject('unknown', 'Timer', null, 1000), null);
    });

    it('converts alarms to V2', () => {
        const v2: any = alexa.convertNotificationToV2({ ...ALARM, status: 'ON' } as any);
        assert.deepEqual(v2, {
            trigger: { scheduledTime: '2024-05-10T12:00:00' },
            extensions: [],
            assets: [{ type: 'TONE', assetId: 'system_alerts_melodic_01' }],
        });
    });

    it('parses date strings for reminders', () => {
        const reminder: any = alexa.parseValue4Notification(
            { type: 'Reminder', alarmTime: NOW, originalDate: '2024-05-10', originalTime: '12:00:00.000' },
            '2024-06-01',
        );
        assert.equal(reminder.originalDate, '2024-06-01');
    });

    it('switches alarms off via the Alexa API', async () => {
        const { err } = await call(cb => alexa.changeNotification({ ...ALARM } as any, false, cb));
        assert.ifError(err);
        const req = fake.last(/\/v1\/alerts\/alarms\/idx1\/cancel/)!;
        assert.equal(req.host, 'api.amazonalexa.com');
        assert.equal(req.method, 'PUT');
    });

    it('switches alarms on via the Alexa API', async () => {
        await call(cb => alexa.changeNotification({ ...ALARM } as any, true, cb));
        const req = fake.last(/\/v1\/alerts\/alarms\/idx1\/activate/)!;
        assert.deepEqual(JSON.parse(req.data).trigger, { scheduledTime: '2024-05-10T12:00:00' });
    });

    it('changes the alarm time via the Alexa API', async () => {
        await call(cb => alexa.changeNotification({ ...ALARM } as any, '13:45', cb));
        const req = fake.last(/\/v1\/alerts\/alarms\/idx1$/)!;
        assert.equal(JSON.parse(req.data).trigger.scheduledTime, '2024-05-10T13:45:00');
    });

    it('keeps the recurrence of the rule data when changing the alarm time (#1006)', async () => {
        const alarm = {
            ...ALARM,
            recurringPattern: 'XXXX-WD',
            rRuleData: { frequency: 'WEEKLY', byWeekDays: ['MO', 'TU', 'WE', 'TH', 'FR'], intervals: [2] },
        };
        await call(cb => alexa.changeNotification(alarm as any, '06:15', cb));
        const trigger = JSON.parse(fake.last(/\/v1\/alerts\/alarms\/idx1$/)!.data).trigger;
        assert.deepEqual(trigger, {
            scheduledTime: '2024-05-11T06:15:00',
            recurrence: { freq: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], interval: 2 },
        });
    });

    it('keeps the recurrence of the recurring pattern when switching alarms on', async () => {
        await call(cb => alexa.changeNotification({ ...ALARM, recurringPattern: 'XXXX-WE' } as any, true, cb));
        const trigger = JSON.parse(fake.last(/\/v1\/alerts\/alarms\/idx1\/activate/)!.data).trigger;
        assert.deepEqual(trigger.recurrence, { freq: 'WEEKLY', byDay: ['SA', 'SU'], interval: 1 });
    });

    it('converts all recurring patterns', () => {
        const convert = (recurringPattern: string | null): any =>
            (alexa.convertNotificationToV2({ ...ALARM, recurringPattern } as any) as any).trigger.recurrence;
        assert.deepEqual(convert('P1D'), { freq: 'DAILY', interval: 1 });
        assert.deepEqual(convert('XXXX-WD'), { freq: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], interval: 1 });
        assert.deepEqual(convert('XXXX-WXX-3'), { freq: 'WEEKLY', byDay: ['WE'], interval: 1 });
        assert.deepEqual(convert('XXXX-WXX-7'), { freq: 'WEEKLY', byDay: ['SU'], interval: 1 });
        assert.equal(convert(null), undefined);
        assert.equal(convert('unknown'), undefined);
    });

    it('updates reminders via the website API', async () => {
        const reminder = {
            id: 'R1',
            type: 'Reminder',
            alarmTime: NOW,
            originalDate: '2024-05-10',
            originalTime: '12:00:00.000',
            rRuleData: { recurrenceRules: ['x'], notificationTimes: ['12:00'] },
        };
        await call(cb => alexa.changeNotification(reminder as any, 'ignored', cb));
        const body = JSON.parse(fake.last(/\/api\/notifications\/R1/)!.data);
        // reminders are sent without times, the recurrence rules are recalculated by Amazon
        assert.equal(body.alarmTime, undefined);
        assert.equal(body.originalTime, undefined);
        assert.equal(body.rRuleData.recurrenceRules, undefined);
        assert.equal(body.rRuleData.frequency, 'DAILY');
    });

    it('cancels the next occurrence of alarms and the instance of reminders', async () => {
        await call(cb => alexa.cancelNotification({ ...ALARM } as any, cb));
        assert.ok(fake.last(/\/v1\/alerts\/alarms\/idx1\/nextOccurrence\/cancel/));

        await call(cb => alexa.cancelNotification({ id: 'R2', type: 'Reminder' }, cb));
        const req = fake.last(/\/api\/notifications\/R2/)!;
        assert.equal(req.method, 'PUT');
        assert.equal(JSON.parse(req.data).status, 'INSTANCE_CANCELED');
    });

    it('deletes notifications', async () => {
        await call(cb => alexa.deleteNotification({ id: 'N9' }, cb));
        assert.equal(fake.last(/\/api\/notifications\/N9/)!.method, 'DELETE');
    });

    it('creates reminders with setReminder()', async () => {
        await call(cb => alexa.setReminder('S1', new Date(2024, 4, 10, 20, 0, 0).getTime(), 'Trash', cb));
        const req = fake.last(/\/api\/notifications\/null/)!;
        assert.equal(req.method, 'PUT');
        assert.equal(JSON.parse(req.data).reminderLabel, 'Trash');
    });

    it('returns an error from setReminder() for unknown devices', async () => {
        const { err } = await call(cb => alexa.setReminder('unknown', NOW, 'x', cb));
        assert.equal(err.message, 'Unknown Device or Serial number');
    });
});
