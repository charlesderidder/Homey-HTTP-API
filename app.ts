import Homey from 'homey';
import http, { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { timingSafeEqual } from 'crypto';
import { SMTPClient } from 'emailjs';
import * as ical from 'node-ical';
import LocalApiRequestArgs from './helpers/types/LocalApiRequestArgs';
import LocalApiRequestState from './helpers/types/LocalApiRequestState';

// Methods that the HTTP API server will ever handle
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const ALLOWED_METHODS_HEADER = ALLOWED_METHODS.join(', ');
// Reject request bodies larger than this to avoid memory exhaustion (DoS protection)
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
// Maximum time to wait for a flow to respond before failing the request
const RESPONSE_TIMEOUT_MS = 30000;

interface JsonValidationResult {
  valid: boolean;
  data?: unknown;
  error?: string;
  normalized?: string;
}

interface CountdownTimer {
  name: string;
  value: number;
  expiresAt: number | null;
  paused: boolean;
  round: number;
  roundsRemaining: number;
  repeatDuration: number | null;
}

interface CountdownFlowArgs {
  timer?: unknown;
  seconds?: unknown;
  min?: unknown;
  max?: unknown;
  value?: unknown;
  expected?: unknown;
  comparison?: unknown;
  rounds?: unknown;
}

interface GmailEmailFlowArgs {
  to: unknown;
  subject: unknown;
  body: unknown;
}

interface ICalCalendar {
  name: string;
  url: string;
}

interface ICalEvent {
  id: string;
  uid: string;
  calendar: string;
  title: string;
  description: string;
  location: string;
  url: string;
  status: string;
  created: number | null;
  start: number;
  end: number;
  source: 'remote' | 'local';
}

interface ICalFlowArgs {
  calendar?: unknown;
  title?: unknown;
  minutes?: unknown;
  start?: unknown;
  end?: unknown;
  description?: unknown;
  location?: unknown;
}

const COUNTDOWN_TIMER_NAMES_SETTING = 'countdownTimerNames';
const COUNTDOWN_TIMER_STATES_SETTING = 'countdownTimerStates';
const COUNTDOWN_TIMER_DURATIONS_SETTING = 'countdownTimerDurations';
const ICAL_CALENDARS_SETTING = 'icalCalendars';
const ICAL_EVENTS_SETTING = 'icalEvents';
const ICAL_SYNC_INTERVAL_SETTING = 'icalSyncInterval';
const ICAL_SYNC_DAYS_SETTING = 'icalSyncDays';
const COUNTDOWN_INTERVAL_MS = 1000;
const ICAL_SYNC_INTERVAL_MINUTES = 15;
const ICAL_SYNC_DAYS = 30;
const ICAL_SYNC_TIMEOUT_MS = 15000;
const ICAL_MAX_BYTES = 2 * 1024 * 1024;
const ICAL_MAX_EVENTS_PER_CALENDAR = 5000;
const DEFAULT_COUNTDOWN_SECONDS = 600;
const MAX_COUNTDOWN_SECONDS = Math.floor((8.64e15 - Date.now()) / 1000);
const MAX_COUNTDOWN_ROUNDS = 1000;
const COUNTDOWN_TRIGGER_IDS = [
  'countdown-reaches-zero',
  'countdown-reaches-value',
  'countdown-started',
  'countdown-stopped',
  'countdown-value-changed',
  'countdown-started-or-updated',
] as const;
const ICAL_TRIGGER_IDS = [
  'ical-event-started',
  'ical-event-ended',
  'ical-event-changed',
  'ical-event-added',
  'ical-sync-error',
] as const;

class LocalApi extends Homey.App {

  localApiEvent: EventEmitter = new EventEmitter();
  requestReceivedArgs: Array<LocalApiRequestArgs> = [];
  server?: http.Server;
  requestCounter = 0;
  countdownTimers = new Map<string, CountdownTimer>();
  countdownTimerDurations = new Map<string, number>();
  countdownTriggers = new Map<string, Homey.FlowCardTrigger>();
  countdownInterval?: ReturnType<typeof setInterval>;
  icalEvents: ICalEvent[] = [];
  icalInterval?: ReturnType<typeof setInterval>;
  icalEventTickInterval?: ReturnType<typeof setInterval>;
  icalConfigTimeout?: ReturnType<typeof setTimeout>;
  icalSyncPromise?: Promise<{ events: number; failedCalendars: string[] }>;
  icalFlowTokens = new Map<string, Homey.FlowToken>();
  lastICalTick = Date.now();
  icalTriggers = new Map<string, Homey.FlowCardTrigger>();

  getCountdownName(value: unknown): string {
    let selectedName = value;
    if (typeof value === 'object' && value !== null) {
      if ('id' in value && typeof value.id === 'string') {
        selectedName = value.id;
      } else if ('name' in value && typeof value.name === 'string') {
        selectedName = value.name;
      }
    }
    if (typeof selectedName !== 'string' || selectedName.trim() === '') {
      throw new Error('A countdown timer must be selected.');
    }
    return selectedName.trim();
  }

  getCountdownTimer(name: unknown): CountdownTimer {
    const timerName = this.getCountdownName(name);
    const timer = this.countdownTimers.get(timerName);
    if (!timer) {
      throw new Error(`Countdown timer "${timerName}" does not exist. Add it in the app settings first.`);
    }
    return timer;
  }

  getCountdownValue(timer: CountdownTimer, now = Date.now()): number {
    if (timer.expiresAt === null || timer.paused) {
      return timer.value;
    }
    return Math.max(0, Math.ceil((timer.expiresAt - now) / 1000));
  }

  async readHomeySetting(key: string): Promise<unknown> {
    return this.homey.settings.get(key);
  }

  async sendGmailEmail(to: string, subject: string, body: string): Promise<void> {
    const gmailAddress = this.homey.settings.get('gmailAddress');
    const gmailAppPassword = this.homey.settings.get('gmailAppPassword');
    if (typeof gmailAddress !== 'string' || gmailAddress.trim() === '') {
      throw new Error('Configure your Gmail address in the Email settings tab before sending email.');
    }
    if (typeof gmailAppPassword !== 'string' || gmailAppPassword.trim() === '') {
      throw new Error('Configure a Gmail app password in the Email settings tab before sending email.');
    }
    const recipient = to.trim();
    if (recipient.length > 254 || !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(recipient)) {
      throw new Error('Enter one valid recipient email address.');
    }

    const client = new SMTPClient({
      host: 'smtp.gmail.com',
      port: 587,
      ssl: false,
      tls: true,
      user: gmailAddress.trim(),
      password: gmailAppPassword.replace(/\s/g, ''),
    });
    try {
      await client.sendAsync({
        from: gmailAddress.trim(),
        to: recipient,
        subject,
        text: body,
      });
    } finally {
      client.smtp.close();
    }
  }

  async sendTestEmail(): Promise<void> {
    const gmailAddress = this.homey.settings.get('gmailAddress');
    if (typeof gmailAddress !== 'string' || gmailAddress.trim() === '') {
      throw new Error('Configure your Gmail address in the Email settings tab before sending a test email.');
    }
    await this.sendGmailEmail(
      gmailAddress,
      'Homey Toolkit - Test email',
      'This is a test email from Homey Toolkit. Gmail email sending is working.',
    );
  }

  getICalCalendars(): ICalCalendar[] {
    const calendars: unknown = this.homey.settings.get(ICAL_CALENDARS_SETTING);
    if (calendars === undefined || calendars === null) {
      return [];
    }
    if (!Array.isArray(calendars)) {
      throw new Error('iCal calendar settings must be a list.');
    }
    const normalized = calendars.map((entry: unknown) => {
      if (
        typeof entry !== 'object'
          || entry === null
          || !('name' in entry)
          || !('url' in entry)
          || typeof entry.name !== 'string'
          || typeof entry.url !== 'string'
      ) {
        throw new Error('Each iCal calendar must have a name and URL.');
      }
      const name = entry.name.trim();
      const url = entry.url.trim();
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch (error) {
        throw new Error(`The URL for iCal calendar "${name}" is invalid.`);
      }
      if (!name || name.length > 80 || !['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error(`The name or URL for iCal calendar "${name}" is invalid.`);
      }
      return { name, url };
    });
    if (new Set(normalized.map((calendar: ICalCalendar) => calendar.name.toLowerCase())).size !== normalized.length) {
      throw new Error('iCal calendar names must be unique.');
    }
    return normalized;
  }

  async persistICalEvents(): Promise<void> {
    this.homey.settings.set(ICAL_EVENTS_SETTING, this.icalEvents);
    await this.updateICalFlowTokens();
  }

  async registerICalFlowTokens(): Promise<void> {
    const tokenDefinitions = [
      {
        id: 'icalNextEventTitle', type: 'string', title: 'Next iCal event title', value: '',
      },
      {
        id: 'icalNextEventCalendar', type: 'string', title: 'Next iCal event calendar', value: '',
      },
      {
        id: 'icalNextEventStart', type: 'string', title: 'Next iCal event start', value: '',
      },
      {
        id: 'icalNextEventEnd', type: 'string', title: 'Next iCal event end', value: '',
      },
      {
        id: 'icalNextEventDescription', type: 'string', title: 'Next iCal event description', value: '',
      },
      {
        id: 'icalTodayEvents', type: 'string', title: "Today's iCal events", value: '',
      },
      {
        id: 'icalTodayEventCount', type: 'number', title: "Today's iCal event count", value: 0,
      },
      {
        id: 'icalTomorrowEvents', type: 'string', title: "Tomorrow's iCal events", value: '',
      },
      {
        id: 'icalTomorrowEventCount', type: 'number', title: "Tomorrow's iCal event count", value: 0,
      },
    ];
    await Promise.all(tokenDefinitions.map(async (definition) => {
      const token = await this.homey.flow.createToken(definition.id, {
        type: definition.type,
        title: definition.title,
        value: definition.value,
      });
      this.icalFlowTokens.set(definition.id, token);
    }));
    await this.updateICalFlowTokens();
  }

  async updateICalFlowTokens(): Promise<void> {
    if (this.icalFlowTokens.size === 0) {
      return;
    }
    const now = Date.now();
    const upcoming = this.icalEvents
      .filter((event) => event.end > now)
      .sort((left, right) => left.start - right.start);
    const next = upcoming[0];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const nextDayStart = new Date(tomorrowStart.getTime() + 24 * 60 * 60 * 1000);
    const today = this.icalEvents.filter((event) => (
      event.start >= todayStart.getTime() && event.start < tomorrowStart.getTime()
    ));
    const tomorrow = this.icalEvents.filter((event) => (
      event.start >= tomorrowStart.getTime() && event.start < nextDayStart.getTime()
    ));
    const summaries = (events: ICalEvent[]) => events
      .sort((left, right) => left.start - right.start)
      .map((event) => `${new Date(event.start).toISOString()} ${event.title}`)
      .join('\n');
    const values: Record<string, string | number> = {
      icalNextEventTitle: next?.title || '',
      icalNextEventCalendar: next?.calendar || '',
      icalNextEventStart: next ? new Date(next.start).toISOString() : '',
      icalNextEventEnd: next ? new Date(next.end).toISOString() : '',
      icalNextEventDescription: next?.description || '',
      icalTodayEvents: summaries(today),
      icalTodayEventCount: today.length,
      icalTomorrowEvents: summaries(tomorrow),
      icalTomorrowEventCount: tomorrow.length,
    };
    await Promise.all(Array.from(this.icalFlowTokens.entries()).map(([id, token]) => (
      token.setValue(values[id])
    )));
  }

  iCalEventTokens(event: ICalEvent): Record<string, string | number> {
    return {
      title: event.title,
      description: event.description,
      location: event.location,
      calendar: event.calendar,
      start: new Date(event.start).toISOString(),
      end: new Date(event.end).toISOString(),
      duration: Math.max(0, Math.round((event.end - event.start) / 60000)),
      url: event.url,
      status: event.status,
      uid: event.uid,
    };
  }

  fireICalTrigger(id: string, tokens: Record<string, string | number>): void {
    const trigger = this.icalTriggers.get(id);
    if (!trigger) {
      this.error(`iCal trigger "${id}" is not registered.`);
      return;
    }
    trigger.trigger(tokens, tokens).catch((error: unknown) => this.error(`iCal trigger "${id}" failed`, error));
  }

  parseICalEvents(calendar: ICalCalendar, parsed: ical.CalendarResponse, from: number, to: number): ICalEvent[] {
    const results: ICalEvent[] = [];
    Object.values(parsed).forEach((component) => {
      if (component.type !== 'VEVENT') {
        return;
      }
      const event = component as ical.VEvent;
      if (!(event.start instanceof Date) || !(event.end instanceof Date)) {
        return;
      }
      if (event.status === 'CANCELLED') {
        return;
      }
      const duration = event.end.getTime() - event.start.getTime();
      if (duration < 0) {
        return;
      }
      const dates = event.rrule
        ? event.rrule.between(new Date(from - duration), new Date(to), true)
        : [event.start];
      const exceptionDates = event.exdate && typeof event.exdate === 'object'
        ? Object.values(event.exdate as Record<string, unknown>)
        : [];
      dates.forEach((start) => {
        const startTime = start.getTime();
        if (exceptionDates.some((date) => date instanceof Date && date.getTime() === startTime)) {
          return;
        }
        const endTime = startTime + duration;
        if (endTime <= from || startTime > to) {
          return;
        }
        const uid = event.uid || `${event.summary || 'event'}-${startTime}`;
        results.push({
          id: `${calendar.name}|${uid}|${startTime}`,
          uid,
          calendar: calendar.name,
          title: event.summary || '',
          description: event.description || '',
          location: event.location || '',
          url: event.url || '',
          status: event.status || '',
          created: event.created instanceof Date ? event.created.getTime() : null,
          start: startTime,
          end: endTime,
          source: 'remote',
        });
        if (results.length > ICAL_MAX_EVENTS_PER_CALENDAR) {
          throw new Error(`iCal calendar "${calendar.name}" contains more than ${ICAL_MAX_EVENTS_PER_CALENDAR} events in the selected timeframe.`);
        }
      });
    });
    return results;
  }

  getICalErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/https?:\/\/[^\s"'<>]+/gi, '[calendar URL]');
  }

  syncICalCalendars(): Promise<{ events: number; failedCalendars: string[] }> {
    if (this.icalSyncPromise) {
      return this.icalSyncPromise;
    }
    this.icalSyncPromise = this.performICalCalendarSync().finally(() => {
      this.icalSyncPromise = undefined;
    });
    return this.icalSyncPromise;
  }

  async performICalCalendarSync(): Promise<{ events: number; failedCalendars: string[] }> {
    const calendars = this.getICalCalendars();
    const now = Date.now();
    const days = Number(this.homey.settings.get(ICAL_SYNC_DAYS_SETTING) || ICAL_SYNC_DAYS);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
      throw new Error('The iCal synchronization timeframe must be between 1 and 365 days.');
    }
    const from = now - 24 * 60 * 60 * 1000;
    const to = now + days * 24 * 60 * 60 * 1000;
    const syncResults = await Promise.all(calendars.map(async (calendar) => {
      try {
        const parsed = await new Promise<ical.CalendarResponse>((resolve, reject) => {
          ical.async.fromURL(calendar.url, {
            timeout: ICAL_SYNC_TIMEOUT_MS,
            maxContentLength: ICAL_MAX_BYTES,
            maxBodyLength: ICAL_MAX_BYTES,
          }, (error: unknown, data: ical.CalendarResponse) => {
            if (error) {
              reject(error);
            } else {
              resolve(data);
            }
          });
        });
        if (!Object.values(parsed).some((component) => component.type === 'VCALENDAR')) {
          throw new Error('The response is not a valid iCalendar feed.');
        }
        return { calendar, events: this.parseICalEvents(calendar, parsed, from, to) };
      } catch (error) {
        const safeMessage = this.getICalErrorMessage(error);
        this.fireICalTrigger('ical-sync-error', {
          calendar: calendar.name,
          error: safeMessage,
        });
        this.error(`iCal synchronization failed for calendar "${calendar.name}": ${safeMessage}`);
        return { calendar, error: safeMessage };
      }
    }));
    const oldRemote = this.icalEvents.filter((event) => event.source === 'remote');
    const localEvents = this.icalEvents.filter((event) => event.source === 'local' && event.end > now);
    const successfulResults = syncResults.filter(
      (result): result is { calendar: ICalCalendar; events: ICalEvent[] } => 'events' in result,
    );
    const successfulNames = new Set(successfulResults.map((result) => result.calendar.name));
    const configuredNames = new Set(calendars.map((calendar) => calendar.name));
    const preservedEvents = oldRemote.filter((event) => (
      configuredNames.has(event.calendar) && !successfulNames.has(event.calendar) && event.end > now
    ));
    const freshEvents = successfulResults.flatMap((result) => result.events);
    const previousById = new Map(oldRemote.map((event) => [event.id, event]));
    freshEvents.forEach((event) => {
      const previous = previousById.get(event.id);
      if (previous && (
        previous.title !== event.title
          || previous.description !== event.description
          || previous.location !== event.location
          || previous.start !== event.start
          || previous.end !== event.end
      )) {
        this.fireICalTrigger('ical-event-changed', this.iCalEventTokens(event));
      } else if (!previous && event.created !== null && event.created >= now - 24 * 60 * 60 * 1000) {
        this.fireICalTrigger('ical-event-added', this.iCalEventTokens(event));
      }
    });
    this.icalEvents = [...freshEvents, ...preservedEvents, ...localEvents];
    await this.persistICalEvents();
    this.log(`iCal synchronization complete: ${this.icalEvents.length} event(s) available`);
    return {
      events: this.icalEvents.length,
      failedCalendars: syncResults.filter((result) => 'error' in result).map((result) => result.calendar.name),
    };
  }

  async createLocalICalEvent(args: ICalFlowArgs): Promise<void> {
    if (
      typeof args.calendar !== 'string'
        || typeof args.title !== 'string'
        || typeof args.start !== 'string'
        || typeof args.end !== 'string'
    ) {
      throw new Error('Calendar, title, start, and end are required to create a local iCal event.');
    }
    const start = Date.parse(args.start);
    const end = Date.parse(args.end);
    if (
      !args.calendar.trim()
      || !args.title.trim()
      || args.calendar.length > 80
      || args.title.length > 500
    ) {
      throw new Error('Local iCal event calendar and title must be non-empty and within the length limits.');
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error('Local iCal event start and end must be valid dates, with end after start.');
    }
    const uid = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.icalEvents.push({
      id: uid,
      uid,
      calendar: args.calendar.trim(),
      title: args.title.trim(),
      description: typeof args.description === 'string' ? args.description : '',
      location: typeof args.location === 'string' ? args.location : '',
      url: '',
      status: 'CONFIRMED',
      created: Date.now(),
      start,
      end,
      source: 'local',
    });
    await this.persistICalEvents();
  }

  async initializeICal(): Promise<void> {
    this.getICalCalendars();
    const rawEvents: unknown = this.homey.settings.get(ICAL_EVENTS_SETTING);
    if (rawEvents !== undefined && rawEvents !== null) {
      if (!Array.isArray(rawEvents) || !rawEvents.every((event) => (
        event
          && typeof event.id === 'string'
          && typeof event.uid === 'string'
          && typeof event.calendar === 'string'
          && typeof event.title === 'string'
          && typeof event.description === 'string'
          && typeof event.location === 'string'
          && typeof event.url === 'string'
          && typeof event.status === 'string'
          && typeof event.start === 'number'
          && Number.isFinite(event.start)
          && typeof event.end === 'number'
          && Number.isFinite(event.end)
          && event.end > event.start
          && (event.created === null || typeof event.created === 'number')
          && (event.source === 'remote' || event.source === 'local')
      ))) {
        throw new Error('Saved iCal events are invalid. Repair the calendar settings before restarting the app.');
      }
      const eventIds = (rawEvents as ICalEvent[]).map((event) => event.id);
      if (new Set(eventIds).size !== eventIds.length) {
        throw new Error('Saved iCal event IDs must be unique.');
      }
      this.icalEvents = rawEvents as ICalEvent[];
    }
    await this.registerICalFlowTokens();
    const interval = Number(this.homey.settings.get(ICAL_SYNC_INTERVAL_SETTING) || ICAL_SYNC_INTERVAL_MINUTES);
    if (!Number.isSafeInteger(interval) || interval < 5 || interval > 1440) {
      throw new Error('The iCal synchronization interval must be between 5 and 1,440 minutes.');
    }
    this.icalInterval = setInterval(() => {
      this.syncICalCalendars().catch((error: unknown) => this.error('iCal synchronization failed', error));
    }, interval * 60 * 1000);
    this.lastICalTick = Date.now();
    this.homey.settings.on('set', (key: string) => {
      if ([ICAL_CALENDARS_SETTING, ICAL_SYNC_DAYS_SETTING].includes(key)) {
        if (this.icalConfigTimeout) {
          clearTimeout(this.icalConfigTimeout);
        }
        this.icalConfigTimeout = setTimeout(() => {
          this.syncICalCalendars().catch((error: unknown) => this.error('iCal settings update failed', error));
        }, 250);
      }
      if (key === ICAL_SYNC_INTERVAL_SETTING) {
        const nextInterval = Number(this.homey.settings.get(ICAL_SYNC_INTERVAL_SETTING));
        if (!Number.isSafeInteger(nextInterval) || nextInterval < 5 || nextInterval > 1440) {
          this.error('iCal synchronization interval must be between 5 and 1,440 minutes.');
          return;
        }
        if (this.icalInterval) {
          clearInterval(this.icalInterval);
        }
        this.icalInterval = setInterval(() => {
          this.syncICalCalendars().catch((error: unknown) => this.error('iCal synchronization failed', error));
        }, nextInterval * 60 * 1000);
      }
    });
    this.syncICalCalendars().catch((error: unknown) => this.error('Initial iCal synchronization failed', error));
    this.icalEventTickInterval = setInterval(() => this.tickICalEvents(), COUNTDOWN_INTERVAL_MS);
  }

  async syncCalendars(): Promise<{ events: number; failedCalendars: string[] }> {
    return this.syncICalCalendars();
  }

  getUpcomingICalEvents(daysAhead: number): Array<{
    title: string;
    calendar: string;
    description: string;
    location: string;
    start: string;
    end: string;
  }> {
    if (!Number.isSafeInteger(daysAhead) || daysAhead < 1 || daysAhead > 60) {
      throw new Error('The upcoming event timeframe must be between 1 and 60 days.');
    }
    const now = Date.now();
    const cutoff = now + daysAhead * 24 * 60 * 60 * 1000;
    return this.icalEvents
      .filter((event) => event.end > now && event.start <= cutoff)
      .sort((left, right) => left.start - right.start)
      .map((event) => ({
        title: event.title,
        calendar: event.calendar,
        description: event.description,
        location: event.location,
        start: new Date(event.start).toISOString(),
        end: new Date(event.end).toISOString(),
      }));
  }

  tickICalEvents(now = Date.now()): void {
    const previousTick = this.lastICalTick;
    this.lastICalTick = now;
    this.icalEvents.forEach((event) => {
      if (event.start > previousTick && event.start <= now) {
        this.fireICalTrigger('ical-event-started', this.iCalEventTokens(event));
      }
      if (event.end > previousTick && event.end <= now) {
        this.fireICalTrigger('ical-event-ended', this.iCalEventTokens(event));
      }
    });
    const activeEvents = this.icalEvents.filter((event) => event.end > now);
    if (activeEvents.length !== this.icalEvents.length) {
      this.icalEvents = activeEvents;
      this.persistICalEvents().catch((error: unknown) => this.error('Could not remove expired iCal events', error));
    }
  }

  registerICalCards(): void {
    ICAL_TRIGGER_IDS.forEach((id) => {
      const trigger = this.homey.flow.getTriggerCard(id);
      this.icalTriggers.set(id, trigger);
      trigger.registerRunListener(() => true);
    });
    this.homey.flow.getActionCard('ical-sync-calendars').registerRunListener(async () => {
      const result = await this.syncICalCalendars();
      if (result.failedCalendars.length > 0) {
        throw new Error(`iCal synchronization failed for: ${result.failedCalendars.join(', ')}.`);
      }
      return true;
    });
    this.homey.flow.getActionCard('ical-create-local-event').registerRunListener(async (args: ICalFlowArgs) => {
      await this.createLocalICalEvent(args);
      return true;
    });
    this.homey.flow.getActionCard('ical-delete-local-event-by-title').registerRunListener(async (args: ICalFlowArgs) => {
      if (typeof args.title !== 'string' || !args.title.trim()) {
        throw new Error('Enter part of the local event title to delete.');
      }
      const search = args.title.trim().toLowerCase();
      const originalLength = this.icalEvents.length;
      this.icalEvents = this.icalEvents.filter((event) => (
        event.source !== 'local' || !event.title.toLowerCase().includes(search)
      ));
      if (this.icalEvents.length === originalLength) {
        return false;
      }
      await this.persistICalEvents();
      return true;
    });
    this.homey.flow.getConditionCard('ical-any-event-is-ongoing').registerRunListener(async () => (
      this.icalEvents.some((event) => event.start <= Date.now() && event.end > Date.now())
    ));
    this.homey.flow.getConditionCard('ical-event-is-ongoing').registerRunListener(async (args: ICalFlowArgs) => {
      const title = typeof args.title === 'string' ? args.title.trim().toLowerCase() : '';
      const calendar = typeof args.calendar === 'string' ? args.calendar.trim().toLowerCase() : '';
      return this.icalEvents.some((event) => (
        event.start <= Date.now()
          && event.end > Date.now()
          && (!title || event.title.toLowerCase().includes(title))
          && (!calendar || event.calendar.toLowerCase() === calendar)
      ));
    });
    this.homey.flow.getConditionCard('ical-event-starts-within').registerRunListener(async (args: ICalFlowArgs) => {
      const minutes = Number(args.minutes);
      if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 525600) {
        throw new Error('iCal start timeframe must be a whole number of minutes from 0 to 525,600.');
      }
      const calendar = typeof args.calendar === 'string' ? args.calendar.trim().toLowerCase() : '';
      const now = Date.now();
      return this.icalEvents.some((event) => (
        event.start >= now
          && event.start <= now + minutes * 60000
          && (!calendar || event.calendar.toLowerCase() === calendar)
      ));
    });
  }

  async saveCountdownStates(): Promise<void> {
    const timers = Array.from(this.countdownTimers.values());
    this.homey.settings.set(COUNTDOWN_TIMER_STATES_SETTING, timers);
  }

  async resetCountdown(name: unknown): Promise<void> {
    const timer = this.getCountdownTimer(name);
    const seconds = this.countdownTimerDurations.get(timer.name);
    if (seconds === undefined) {
      throw new Error(`Countdown duration for timer "${timer.name}" is not configured.`);
    }
    await this.startCountdown(timer.name, seconds);
  }

  async resetCountdownIfRunning(name: unknown): Promise<void> {
    const timer = this.getCountdownTimer(name);
    await this.tickCountdowns();
    if (timer.expiresAt === null || timer.paused) {
      return;
    }
    await this.resetCountdown(timer.name);
  }

  registerCountdownTimerAutocomplete(card: Homey.FlowCard): void {
    card.registerArgumentAutocompleteListener('timer', async (query) => {
      const names = Array.from(this.countdownTimers.keys());
      return names
        .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
        .map((name) => ({ name, id: name }));
    });
  }

  fireCountdownTrigger(
    id: string,
    timer: CountdownTimer,
    value: number,
    roundInfo?: { round: number; rounds_remaining: number },
  ): void {
    const trigger = this.countdownTriggers.get(id);
    if (!trigger) {
      this.error(`Countdown trigger "${id}" is not registered.`);
      return;
    }
    const tokens = { timer: timer.name, value, ...roundInfo };
    trigger.trigger(tokens, tokens).catch((error: unknown) => this.error(`Countdown trigger "${id}" failed`, error));
  }

  fireCountdownValueChanged(timer: CountdownTimer, previousValue: number, nextValue: number): void {
    if (previousValue !== nextValue) {
      this.fireCountdownTrigger('countdown-value-changed', timer, nextValue);
      if (nextValue >= 0) {
        this.fireCountdownTrigger('countdown-reaches-value', timer, nextValue);
      }
    }
  }

  validateCountdownSeconds(value: unknown, label: string): number {
    const seconds = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_COUNTDOWN_SECONDS) {
      throw new Error(`${label} must be a whole number between 0 and ${MAX_COUNTDOWN_SECONDS}.`);
    }
    return seconds;
  }

  validateCountdownRounds(value: unknown): number {
    const rounds = value === undefined || value === null || value === '' ? 1 : Number(value);
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > MAX_COUNTDOWN_ROUNDS) {
      throw new Error(`Countdown rounds must be a whole number between 1 and ${MAX_COUNTDOWN_ROUNDS}.`);
    }
    return rounds;
  }

  finishCountdownRound(timer: CountdownTimer, now = Date.now()): { round: number; rounds_remaining: number } {
    const roundInfo = {
      round: timer.round,
      rounds_remaining: timer.roundsRemaining,
    };
    if (timer.roundsRemaining > 0 && timer.repeatDuration !== null) {
      timer.roundsRemaining -= 1;
      timer.round += 1;
      timer.value = timer.repeatDuration;
      timer.expiresAt = now + timer.repeatDuration * 1000;
    } else {
      timer.roundsRemaining = 0;
      timer.repeatDuration = null;
      timer.expiresAt = null;
    }
    return roundInfo;
  }

  async startCountdown(name: unknown, rawSeconds: unknown, rawRounds?: unknown): Promise<void> {
    const timer = this.getCountdownTimer(name);
    const seconds = this.validateCountdownSeconds(rawSeconds, 'Countdown duration');
    const rounds = this.validateCountdownRounds(rawRounds);
    if (seconds === 0 && rounds > 1) {
      throw new Error('Countdown duration must be greater than zero when using multiple rounds.');
    }
    await this.tickCountdowns();
    const previousValue = this.getCountdownValue(timer);
    const wasRunning = timer.expiresAt !== null && !timer.paused;
    timer.value = seconds;
    timer.expiresAt = seconds > 0 ? Date.now() + seconds * 1000 : null;
    timer.paused = false;
    timer.round = 1;
    timer.roundsRemaining = rounds - 1;
    timer.repeatDuration = rounds > 1 ? seconds : null;
    await this.saveCountdownStates();
    this.fireCountdownValueChanged(timer, previousValue, seconds);
    if (!wasRunning) {
      this.fireCountdownTrigger('countdown-started', timer, seconds);
    }
    this.fireCountdownTrigger('countdown-started-or-updated', timer, seconds);
    if (seconds === 0) {
      this.fireCountdownTrigger('countdown-reaches-zero', timer, 0, this.finishCountdownRound(timer));
    }
  }

  async adjustCountdown(name: unknown, rawSeconds: unknown): Promise<void> {
    const timer = this.getCountdownTimer(name);
    const adjustment = typeof rawSeconds === 'number' ? rawSeconds : Number(rawSeconds);
    if (!Number.isSafeInteger(adjustment)) {
      throw new Error('Countdown adjustment must be a whole number of seconds.');
    }
    await this.tickCountdowns();
    if (timer.expiresAt === null && !timer.paused) {
      throw new Error(`Countdown timer "${timer.name}" is not running.`);
    }
    const previousValue = this.getCountdownValue(timer);
    const nextValue = Math.max(0, previousValue + adjustment);
    if (nextValue > MAX_COUNTDOWN_SECONDS) {
      throw new Error(`Countdown value cannot exceed ${MAX_COUNTDOWN_SECONDS} seconds.`);
    }
    timer.value = nextValue;
    if (timer.paused) {
      timer.expiresAt = null;
    } else {
      timer.expiresAt = nextValue > 0 ? Date.now() + nextValue * 1000 : null;
    }
    if (nextValue === 0) {
      timer.paused = false;
    }
    await this.saveCountdownStates();
    this.fireCountdownValueChanged(timer, previousValue, nextValue);
    if (nextValue === 0) {
      const roundInfo = this.finishCountdownRound(timer);
      await this.saveCountdownStates();
      this.fireCountdownTrigger('countdown-reaches-zero', timer, 0, roundInfo);
    } else {
      this.fireCountdownTrigger('countdown-started-or-updated', timer, nextValue);
    }
  }

  async stopCountdown(timer: CountdownTimer): Promise<void> {
    await this.tickCountdowns();
    const previousValue = this.getCountdownValue(timer);
    const stoppedBeforeZero = previousValue > 0 && (timer.expiresAt !== null || timer.paused);
    timer.value = -1;
    timer.expiresAt = null;
    timer.paused = false;
    timer.round = 1;
    timer.roundsRemaining = 0;
    timer.repeatDuration = null;
    await this.saveCountdownStates();
    this.fireCountdownValueChanged(timer, previousValue, -1);
    if (stoppedBeforeZero) {
      this.fireCountdownTrigger('countdown-stopped', timer, -1);
    }
  }

  async pauseCountdown(name: unknown): Promise<void> {
    const timer = this.getCountdownTimer(name);
    await this.tickCountdowns();
    if (timer.expiresAt === null || timer.paused) {
      throw new Error(`Countdown timer "${timer.name}" is not running.`);
    }
    timer.value = this.getCountdownValue(timer);
    timer.expiresAt = null;
    timer.paused = true;
    await this.saveCountdownStates();
  }

  async resumeCountdown(name: unknown): Promise<void> {
    const timer = this.getCountdownTimer(name);
    if (!timer.paused) {
      throw new Error(`Countdown timer "${timer.name}" is not paused.`);
    }
    timer.paused = false;
    timer.expiresAt = timer.value > 0 ? Date.now() + timer.value * 1000 : null;
    await this.saveCountdownStates();
    this.fireCountdownTrigger('countdown-started-or-updated', timer, timer.value);
    if (timer.value === 0) {
      this.fireCountdownTrigger('countdown-reaches-zero', timer, 0);
    }
  }

  async syncCountdownTimerNames(rawNames: unknown): Promise<void> {
    if (!Array.isArray(rawNames) || !rawNames.every((name) => typeof name === 'string')) {
      throw new Error('Countdown timer names must be a list of text values.');
    }
    const names = rawNames.map((name) => name.trim());
    if (names.some((name) => name.length === 0 || name.length > 80)) {
      throw new Error('Countdown timer names must contain between 1 and 80 characters.');
    }
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      throw new Error('Countdown timer names must be unique.');
    }
    const configuredNames = new Set(names);
    for (const name of this.countdownTimers.keys()) {
      if (!configuredNames.has(name)) {
        this.countdownTimers.delete(name);
      }
    }
    for (const name of names) {
      if (!this.countdownTimers.has(name)) {
        this.countdownTimers.set(name, {
          name,
          value: -1,
          expiresAt: null,
          paused: false,
          round: 1,
          roundsRemaining: 0,
          repeatDuration: null,
        });
      }
      if (!this.countdownTimerDurations.has(name)) {
        this.countdownTimerDurations.set(name, DEFAULT_COUNTDOWN_SECONDS);
      }
    }
    for (const name of this.countdownTimerDurations.keys()) {
      if (!configuredNames.has(name)) {
        this.countdownTimerDurations.delete(name);
      }
    }
    await this.saveCountdownStates();
  }

  async syncCountdownTimerDurations(rawDurations: unknown): Promise<void> {
    if (typeof rawDurations !== 'object' || rawDurations === null || Array.isArray(rawDurations)) {
      throw new Error('Countdown timer durations must be a timer-to-seconds map.');
    }
    const durations = new Map<string, number>();
    Object.entries(rawDurations).forEach(([name, value]) => {
      const seconds = this.validateCountdownSeconds(value, `Countdown duration for "${name}"`);
      if (seconds === 0) {
        throw new Error(`Countdown duration for "${name}" must be greater than zero.`);
      }
      durations.set(name, seconds);
    });
    this.countdownTimers.forEach((timer) => {
      this.countdownTimerDurations.set(
        timer.name,
        durations.get(timer.name) ?? this.countdownTimerDurations.get(timer.name) ?? DEFAULT_COUNTDOWN_SECONDS,
      );
    });
    for (const name of this.countdownTimerDurations.keys()) {
      if (!this.countdownTimers.has(name)) {
        this.countdownTimerDurations.delete(name);
      }
    }
  }

  async initializeCountdowns(): Promise<void> {
    const [rawNames, rawStates, rawDurations] = await Promise.all([
      this.readHomeySetting(COUNTDOWN_TIMER_NAMES_SETTING),
      this.readHomeySetting(COUNTDOWN_TIMER_STATES_SETTING),
      this.readHomeySetting(COUNTDOWN_TIMER_DURATIONS_SETTING),
    ]);
    const configuredNames = rawNames === undefined || rawNames === null ? [] : rawNames;
    const savedStates = new Map<string, CountdownTimer>();
    if (rawStates !== undefined && rawStates !== null && !Array.isArray(rawStates)) {
      throw new Error('Saved countdown timer states are invalid. Restart the app after repairing timer settings.');
    }
    (Array.isArray(rawStates) ? rawStates : []).forEach((state: unknown) => {
      const timer = state as Partial<CountdownTimer> | null;
      if (
        !timer
        || typeof timer.name !== 'string'
        || timer.name.trim() === ''
        || !Number.isSafeInteger(timer.value)
        || (timer.value as number) < -1
        || (timer.value as number) > MAX_COUNTDOWN_SECONDS
        || (timer.expiresAt !== null && (typeof timer.expiresAt !== 'number' || !Number.isFinite(timer.expiresAt)))
        || typeof timer.paused !== 'boolean'
        || (timer.paused && timer.expiresAt !== null)
        || (timer.value === -1 && (timer.expiresAt !== null || timer.paused))
        || (timer.round !== undefined && (
          !Number.isSafeInteger(timer.round)
          || (timer.round as number) < 1
          || (timer.round as number) > MAX_COUNTDOWN_ROUNDS
        ))
        || (timer.roundsRemaining !== undefined && (
          !Number.isSafeInteger(timer.roundsRemaining)
          || (timer.roundsRemaining as number) < 0
          || (timer.roundsRemaining as number) >= MAX_COUNTDOWN_ROUNDS
        ))
        || (timer.repeatDuration !== undefined && timer.repeatDuration !== null && (
          !Number.isSafeInteger(timer.repeatDuration)
          || (timer.repeatDuration as number) < 1
          || (timer.repeatDuration as number) > MAX_COUNTDOWN_SECONDS
        ))
        || ((timer.repeatDuration === undefined || timer.repeatDuration === null) && timer.roundsRemaining !== undefined && timer.roundsRemaining !== 0)
        || (timer.repeatDuration !== undefined && timer.repeatDuration !== null && (
          !Number.isSafeInteger(timer.roundsRemaining)
          || (timer.roundsRemaining as number) < 1
        ))
        || (timer.value === -1 && timer.repeatDuration !== undefined && timer.repeatDuration !== null)
      ) {
        throw new Error('Saved countdown timer states are invalid. Restart the app after repairing timer settings.');
      }
      savedStates.set(timer.name, {
        name: timer.name,
        value: timer.value as number,
        expiresAt: timer.expiresAt as number | null,
        paused: timer.paused,
        round: timer.round ?? 1,
        roundsRemaining: timer.roundsRemaining ?? 0,
        repeatDuration: timer.repeatDuration ?? null,
      });
    });
    if (savedStates.size !== (Array.isArray(rawStates) ? rawStates.length : 0)) {
      throw new Error('Saved countdown timer names must be unique.');
    }
    if (!Array.isArray(configuredNames) || !configuredNames.every((name) => typeof name === 'string')) {
      throw new Error('Countdown timer names are invalid. Open app settings and repair the timer list.');
    }
    const normalizedNames = configuredNames.map((name: string) => name.trim());
    if (
      normalizedNames.some((name: string) => name.length === 0 || name.length > 80)
      || new Set(normalizedNames.map((name: string) => name.toLowerCase())).size !== normalizedNames.length
    ) {
      throw new Error('Countdown timer names must be non-empty, unique, and no longer than 80 characters.');
    }
    for (const name of normalizedNames) {
      const savedTimer = savedStates.get(name);
      this.countdownTimers.set(
        name,
        savedTimer || {
          name,
          value: -1,
          expiresAt: null,
          paused: false,
          round: 1,
          roundsRemaining: 0,
          repeatDuration: null,
        },
      );
    }
    if (rawDurations !== undefined && rawDurations !== null) {
      await this.syncCountdownTimerDurations(rawDurations);
    } else {
      normalizedNames.forEach((name: string) => {
        this.countdownTimerDurations.set(name, DEFAULT_COUNTDOWN_SECONDS);
      });
    }
    const now = Date.now();
    const expiredTimers: Array<{ timer: CountdownTimer; previousValue: number; roundInfo: { round: number; rounds_remaining: number } }> = [];
    for (const timer of this.countdownTimers.values()) {
      if (timer.expiresAt !== null && timer.expiresAt <= now) {
        const previousValue = timer.value;
        timer.value = 0;
        timer.paused = false;
        if (previousValue !== 0) {
          expiredTimers.push({ timer, previousValue, roundInfo: this.finishCountdownRound(timer, now) });
        }
      }
    }
    await this.saveCountdownStates();
    expiredTimers.forEach(({ timer, previousValue, roundInfo }) => {
      this.fireCountdownValueChanged(timer, previousValue, 0);
      this.fireCountdownTrigger('countdown-reaches-zero', timer, 0, roundInfo);
    });
    this.countdownInterval = setInterval(() => {
      this.tickCountdowns().catch((error: unknown) => this.error('Countdown timer update failed', error));
    }, COUNTDOWN_INTERVAL_MS);
    this.homey.settings.on('set', (key: string) => {
      if (key === COUNTDOWN_TIMER_NAMES_SETTING) {
        this.readHomeySetting(COUNTDOWN_TIMER_NAMES_SETTING)
          .then((names) => this.syncCountdownTimerNames(names))
          .catch((error: unknown) => this.error('Countdown timer configuration update failed', error));
      } else if (key === COUNTDOWN_TIMER_DURATIONS_SETTING) {
        this.readHomeySetting(COUNTDOWN_TIMER_DURATIONS_SETTING)
          .then((durations) => this.syncCountdownTimerDurations(durations))
          .catch((error: unknown) => this.error('Countdown duration configuration update failed', error));
      }
    });
  }

  async tickCountdowns(): Promise<void> {
    const now = Date.now();
    const changedValues: Array<{ timer: CountdownTimer; previousValue: number; nextValue: number }> = [];
    const expiredTimers: Array<{ timer: CountdownTimer; roundInfo: { round: number; rounds_remaining: number } }> = [];
    this.countdownTimers.forEach((timer) => {
      if (timer.expiresAt === null || timer.paused) {
        return;
      }
      const previousValue = timer.value;
      const nextValue = this.getCountdownValue(timer, now);
      if (previousValue !== nextValue) {
        timer.value = nextValue;
        changedValues.push({ timer, previousValue, nextValue });
        if (nextValue === 0) {
          expiredTimers.push({ timer, roundInfo: this.finishCountdownRound(timer, now) });
        }
      }
    });
    if (expiredTimers.length > 0) {
      await this.saveCountdownStates();
    }
    changedValues.forEach(({ timer, previousValue, nextValue }) => {
      this.fireCountdownValueChanged(timer, previousValue, nextValue);
    });
    expiredTimers.forEach(({ timer, roundInfo }) => this.fireCountdownTrigger('countdown-reaches-zero', timer, 0, roundInfo));
  }

  registerCountdownCards(): void {
    COUNTDOWN_TRIGGER_IDS.forEach((id) => {
      const trigger = this.homey.flow.getTriggerCard(id);
      this.countdownTriggers.set(id, trigger);
      this.registerCountdownTimerAutocomplete(trigger);
      trigger.registerRunListener((args: CountdownFlowArgs, state: CountdownFlowArgs) => (
        args.timer === state.timer
        && (id !== 'countdown-reaches-value'
          || Number(args.value) === Number(state.value))
      ));
    });
    const startCard = this.homey.flow.getActionCard('countdown-start');
    this.registerCountdownTimerAutocomplete(startCard);
    startCard.registerRunListener(async (args: CountdownFlowArgs) => {
      await this.startCountdown(args.timer, args.seconds, args.rounds);
      return true;
    });
    const resetCard = this.homey.flow.getActionCard('countdown-reset');
    this.registerCountdownTimerAutocomplete(resetCard);
    resetCard.registerRunListener(async (args: CountdownFlowArgs) => {
      await this.resetCountdown(args.timer);
      return true;
    });
    const resetIfRunningCard = this.homey.flow.getActionCard('countdown-reset-if-running');
    this.registerCountdownTimerAutocomplete(resetIfRunningCard);
    resetIfRunningCard.registerRunListener(async (args: CountdownFlowArgs) => {
      await this.resetCountdownIfRunning(args.timer);
      return true;
    });
    const randomCard = this.homey.flow.getActionCard('countdown-start-random');
    this.registerCountdownTimerAutocomplete(randomCard);
    randomCard.registerRunListener(async (args: CountdownFlowArgs) => {
      const min = this.validateCountdownSeconds(args.min, 'Minimum countdown duration');
      const max = this.validateCountdownSeconds(args.max, 'Maximum countdown duration');
      if (min > max) {
        throw new Error('Minimum countdown duration cannot be greater than the maximum.');
      }
      await this.startCountdown(args.timer, min + Math.floor(Math.random() * (max - min + 1)), args.rounds);
      return true;
    });
    const adjustCard = this.homey.flow.getActionCard('countdown-adjust');
    this.registerCountdownTimerAutocomplete(adjustCard);
    adjustCard.registerRunListener(async (args: CountdownFlowArgs) => {
      await this.adjustCountdown(args.timer, args.seconds);
      return true;
    });
    const stopCard = this.homey.flow.getActionCard('countdown-stop');
    this.registerCountdownTimerAutocomplete(stopCard);
    stopCard.registerRunListener(async (args: CountdownFlowArgs) => {
      await this.stopCountdown(this.getCountdownTimer(args.timer));
      return true;
    });
    this.homey.flow.getActionCard('countdown-stop-all').registerRunListener(async () => {
      for (const timer of this.countdownTimers.values()) {
        await this.stopCountdown(timer);
      }
      return true;
    });
    const pauseCard = this.homey.flow.getActionCard('countdown-pause');
    this.registerCountdownTimerAutocomplete(pauseCard);
    pauseCard.registerRunListener(async (args: CountdownFlowArgs) => {
      await this.pauseCountdown(args.timer);
      return true;
    });
    const resumeCard = this.homey.flow.getActionCard('countdown-resume');
    this.registerCountdownTimerAutocomplete(resumeCard);
    resumeCard.registerRunListener(async (args: CountdownFlowArgs) => {
      await this.resumeCountdown(args.timer);
      return true;
    });

    const runningCondition = this.homey.flow.getConditionCard('countdown-is-running');
    this.registerCountdownTimerAutocomplete(runningCondition);
    runningCondition.registerRunListener((args: CountdownFlowArgs) => (
      (this.getCountdownTimer(args.timer).expiresAt !== null) === (args.expected === 'yes')
    ));
    const valueCondition = this.homey.flow.getConditionCard('countdown-has-value');
    this.registerCountdownTimerAutocomplete(valueCondition);
    valueCondition.registerRunListener((args: CountdownFlowArgs) => {
      const timerValue = this.getCountdownValue(this.getCountdownTimer(args.timer));
      const equals = timerValue === Number(args.value);
      if (args.comparison === 'is_not') {
        return !equals;
      }
      if (args.comparison === 'is') {
        return equals;
      }
      throw new Error('Countdown value comparison must be "is" or "is not".');
    });
    const comparisonCondition = this.homey.flow.getConditionCard('countdown-value-comparison');
    this.registerCountdownTimerAutocomplete(comparisonCondition);
    comparisonCondition.registerRunListener((args: CountdownFlowArgs) => {
      const timerValue = this.getCountdownValue(this.getCountdownTimer(args.timer));
      if (args.comparison === 'less') {
        return timerValue < Number(args.value);
      }
      if (args.comparison === 'greater') {
        return timerValue > Number(args.value);
      }
      throw new Error('Countdown comparison must be "less than" or "greater than".');
    });
    const pausedCondition = this.homey.flow.getConditionCard('countdown-is-paused');
    this.registerCountdownTimerAutocomplete(pausedCondition);
    pausedCondition.registerRunListener((args: CountdownFlowArgs) => (
      this.getCountdownTimer(args.timer).paused === (args.expected === 'yes')
    ));
  }

  /**
   * Retrieve the CORS config from the settings
   */
  retrieveCorsConfig(): string {
    const corsAcao = this.homey.settings.get('corsAcao') || '*';
    if (corsAcao === '') {
      return '*';
    }
    return corsAcao;
  }

  /**
   * Retrieve CORS active status from the settings
   */
  isCorsActive(): boolean {
    const corsStatus = this.homey.settings.get('corsStatus') || 'true';
    return corsStatus === 'true';
  }

  isAuthenticationEnabled(): boolean {
    return this.homey.settings.get('authEnabled') === 'true';
  }

  getApiToken(): string {
    return this.homey.settings.get('apiToken') || '';
  }

  /**
   * Normalize a route value so users can define routes both with and without a leading slash.
   */
  normalizeRoute(route?: string): string {
    if (!route) {
      return '/';
    }
    const trimmed = route.trim().split('?')[0];
    if (!trimmed) {
      return '/';
    }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  getRequestRoute(req: IncomingMessage): string {
    return this.normalizeRoute(req.url);
  }

  getRequestUrlWithoutToken(req: IncomingMessage): string {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    requestUrl.searchParams.delete('token');
    return `${requestUrl.pathname}${requestUrl.search}`;
  }

  getRequestedField(req: IncomingMessage): string | undefined {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    return requestUrl.searchParams.get('field') || requestUrl.searchParams.get('veld') || undefined;
  }

  getResponseField(responseData: unknown, field: string): unknown {
    if (!responseData || typeof responseData !== 'object' || Array.isArray(responseData)) {
      return undefined;
    }

    const responseObject = responseData as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(responseObject, field)) {
      return responseObject[field];
    }

    const nestedData = responseObject.data;
    if (nestedData && typeof nestedData === 'object' && !Array.isArray(nestedData)) {
      const dataObject = nestedData as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(dataObject, field)) {
        return dataObject[field];
      }
    }

    return undefined;
  }

  hasValidApiToken(req: IncomingMessage): boolean {
    if (!this.isAuthenticationEnabled()) {
      return true;
    }

    const configuredToken = this.getApiToken();
    if (!configuredToken) {
      return false;
    }

    const { authorization } = req.headers;
    const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const queryToken = new URL(req.url || '/', 'http://localhost').searchParams.get('token');
    const suppliedToken = bearerToken || queryToken || '';
    const expected = Buffer.from(configuredToken, 'utf8');
    const supplied = Buffer.from(suppliedToken, 'utf8');

    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  /**
   * Check if the requested url is registered by at least one flow (regardless of method)
   * @param req The node http request object
   */
  isRouteAuthorized(req: IncomingMessage): boolean {
    const normalizedRequestUrl = this.normalizeRoute(req.url);
    return this.requestReceivedArgs.find((arg: LocalApiRequestArgs) => this.normalizeRoute(arg.url) === normalizedRequestUrl) !== undefined;
  }

  /**
   * Check if the request url + method combination is registered by a flow
   * @param req The node http request object
   */
  isRouteAndMethodAuthorized(req: IncomingMessage): boolean {
    const normalizedRequestUrl = this.normalizeRoute(req.url);
    return this.requestReceivedArgs.find(
      (arg: LocalApiRequestArgs) => this.normalizeRoute(arg.url) === normalizedRequestUrl && arg.method === req.method?.toLowerCase(),
    ) !== undefined;
  }

  getAllowedMethods(req: IncomingMessage): string[] {
    const normalizedRequestUrl = this.normalizeRoute(req.url);
    const routeMethods = this.requestReceivedArgs
      .filter((arg: LocalApiRequestArgs) => this.normalizeRoute(arg.url) === normalizedRequestUrl)
      .map((arg: LocalApiRequestArgs) => arg.method.toUpperCase());
    const allowedMethods = new Set([...routeMethods, 'OPTIONS']);

    return ALLOWED_METHODS.filter((allowedMethod) => allowedMethods.has(allowedMethod));
  }

  /**
   * Buffer the request body while enforcing a maximum size, to protect against oversized payloads.
   * @param req The node http request object
   */
  readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          reject(new Error('PAYLOAD_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', (e) => reject(e));
    });
  }

  /**
   * Return conservative corrections for common hand-written JSON mistakes.
   * @param raw The raw JSON string
   */
  correctJson(raw: string): string {
    let corrected = raw.trim();
    corrected = corrected.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    corrected = corrected.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    return corrected.replace(/,\s*([}\]])/g, '$1');
  }

  /**
   * Validate that a (possibly empty) string is syntactically valid JSON.
   * An empty body is considered valid (no data to validate).
   * @param raw The raw string to validate as JSON
   */
  validateJsonBody(raw: string): JsonValidationResult {
    if (!raw || raw.trim() === '') {
      return { valid: true, data: undefined };
    }
    try {
      return { valid: true, data: JSON.parse(raw) };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
    }
  }

  /**
   * Run listener for the response with 200 action Flow Card
   * @param args The arguments passed to the action card
   * @param state The state of the action card
   */
  responseWithOkRunListener = async (args: LocalApiRequestArgs, state: LocalApiRequestState) => {
    try {
      this.localApiEvent.emit('responseAction', { status: 'ok' });
    } catch (e) {
      this.error('HTTP API: error while running "Respond with 200" action', e);
    }
    return true;
  };

  /**
   * Run listener for the response with action Flow Card
   * @param args The arguments passed to the action card
   * @param state The state of the action card
   */
  responseWithActionRunListener = async (args: LocalApiRequestArgs, state: LocalApiRequestState) => {
    let parsedBody: unknown;

    if (typeof args.body === 'object' && args.body !== null) {
      parsedBody = args.body;
    } else if (typeof args.body === 'string') {
      const validation = this.validateJsonBody(args.body);
      if (validation.valid) {
        parsedBody = validation.data ?? {};
      } else {
        this.error(`HTTP API: "Respond with..." action received invalid JSON: ${validation.error}. Body was: ${args.body}`);
        parsedBody = { status: 'error', message: `Invalid JSON: ${validation.error}` };
      }
    } else if (args.body === undefined || args.body === null || args.body === '') {
      parsedBody = {};
    } else {
      parsedBody = args.body;
    }

    try {
      this.localApiEvent.emit('responseAction', parsedBody);
    } catch (e) {
      this.error('HTTP API: error while running "Respond with..." action', e);
    }
    return true;
  };

  /**
   * Run listener for the request received Trigger Flow Card
   * @param args The arguments passed to the trigger card
   * @param state The state of the trigger card
   */
  requestReceivedTriggerRunListener = async (args: LocalApiRequestArgs, state: LocalApiRequestState) => (
    this.normalizeRoute(args.url) === this.normalizeRoute(state.request.url)
    && args.method === state.request.method?.toLowerCase()
  );

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.registerCountdownCards();
    await this.initializeCountdowns();
    this.registerICalCards();
    await this.initializeICal();

    this.homey.flow.getActionCard('gmail-send-email').registerRunListener(async (args: GmailEmailFlowArgs) => {
      if (typeof args.to !== 'string') {
        throw new Error('A recipient email address is required.');
      }
      if (typeof args.subject !== 'string' || typeof args.body !== 'string') {
        throw new Error('The email subject and message must be text.');
      }
      await this.sendGmailEmail(args.to, args.subject, args.body);
      return true;
    });

    // Define Trigger Requests
    const requestReceivedTrigger = this.homey.flow.getTriggerCard('local-api-request-received');
    // Define Actions Responses
    const responseWithAction = this.homey.flow.getActionCard('local-api-response-with');
    const responseWithOk = this.homey.flow.getActionCard('local-api-respond-with-200');
    // Retrieve settings and initialize the HTTP API app
    const serverPort = this.homey.settings.get('serverPort') || 3000;
    this.requestReceivedArgs = await requestReceivedTrigger.getArgumentValues() || [];
    this.localApiEvent.on('warning', (e) => this.error('HTTP API: warning', e.stack));
    this.localApiEvent.on('uncaughtException', (e) => this.error('HTTP API: uncaughtException', e.stack));
    requestReceivedTrigger.registerRunListener(this.requestReceivedTriggerRunListener);
    responseWithAction.registerRunListener(this.responseWithActionRunListener);
    responseWithOk.registerRunListener(this.responseWithOkRunListener);
    requestReceivedTrigger.on('update', async () => {
      this.log('HTTP API: found updated trigger, updating registered routes...');
      this.requestReceivedArgs = await requestReceivedTrigger.getArgumentValues();
      this.log(`HTTP API: routes updated, ${this.requestReceivedArgs.length} route(s) registered`);
    });
    this.log(`HTTP API has been initialized with ${this.requestReceivedArgs.length} route(s) registered`);

    // Create a http server instance that can be used to listening on user defined port (or 3000, default).
    this.server = http.createServer((req, res) => this.handleRequest(requestReceivedTrigger, req, res));
    this.server.listen(serverPort, () => {
      this.log(`HTTP API server started at port ${serverPort}`);
    }).on('error', (e: unknown) => {
      // Handle server error
      if (e instanceof Error) {
        if (e.message.includes('EADDRINUSE') || e.message.includes('EACCES')) {
          this.error(`HTTP API server error: port ${serverPort} already in use`);
        } else {
          this.error(`HTTP API server error: ${e.message}`);
        }
      } else {
        this.error('HTTP API server error: unknown error');
      }
    });
  }

  /**
   * Handles a single incoming HTTP request: CORS, authorization, JSON validation, flow triggering and response.
   * @param requestReceivedTrigger The trigger card used to notify flows of an incoming request
   * @param req The node http request object
   * @param res The node http response object
   */
  async handleRequest(requestReceivedTrigger: Homey.FlowCardTrigger, req: IncomingMessage, res: ServerResponse) {
    this.requestCounter += 1;
    const reqId = this.requestCounter;
    const method = (req.method || 'GET').toUpperCase();
    this.log(`HTTP API [#${reqId}]: incoming ${method} ${this.getRequestRoute(req)}`);

    const corsAcao = this.retrieveCorsConfig();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', corsAcao);
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS_HEADER);
    res.setHeader('Access-Control-Allow-Headers', 'Origin, Accept, Content-Type, Authorization, Content-Length, X-Requested-With, XMLHttpRequest');

    try {
      if (!ALLOWED_METHODS.includes(method)) {
        this.log(`HTTP API [#${reqId}]: method ${method} is not supported`);
        this.sendJson(res, 405, { status: 'error', message: `Method ${method} not allowed` }, method);
        return;
      }

      if (method === 'OPTIONS' && this.isRouteAuthorized(req)) {
        const allowedMethods = this.getAllowedMethods(req);
        res.setHeader('Allow', allowedMethods.join(', '));
        res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
        this.log(`HTTP API [#${reqId}]: answering OPTIONS request for ${req.url}`);
        res.writeHead(204);
        res.end();
        return;
      }

      if (!this.hasValidApiToken(req)) {
        this.log(`HTTP API [#${reqId}]: rejected unauthorized ${method} request`);
        this.sendJson(res, 401, { status: 'unauthorized', message: 'Missing or invalid API token' }, method);
        return;
      }

      if (!this.isRouteAndMethodAuthorized(req)) {
        this.log(`HTTP API [#${reqId}]: no flow registered for ${method} ${req.url}, responding 404`);
        this.sendJson(res, 404, { status: 'not-found' }, method);
        return;
      }

      // Read and validate the request body (only relevant for methods that can carry one)
      let rawBody = '';
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        try {
          rawBody = await this.readRequestBody(req);
        } catch (e) {
          if (e instanceof Error && e.message === 'PAYLOAD_TOO_LARGE') {
            this.error(`HTTP API [#${reqId}]: request body exceeded the ${MAX_BODY_BYTES} bytes limit`);
            this.sendJson(res, 413, { status: 'error', message: 'Request body too large' }, method);
            return;
          }
          throw e;
        }

        const validation = this.validateJsonBody(rawBody);
        if (!validation.valid) {
          this.error(`HTTP API [#${reqId}]: invalid JSON body received: ${validation.error}`);
          this.sendJson(res, 400, { status: 'error', message: `Invalid JSON body: ${validation.error}` }, method);
          return;
        }
      }

      this.log(`HTTP API [#${reqId}]: triggering flow(s) for ${method} ${this.getRequestRoute(req)}`);
      requestReceivedTrigger.trigger(
        { url: this.getRequestUrlWithoutToken(req), method, body: rawBody },
        { request: req, response: res },
      );

      const responseData = await this.waitForFlowResponse();
      const requestedField = this.getRequestedField(req);
      if (requestedField) {
        const fieldValue = this.getResponseField(responseData, requestedField);
        if (fieldValue === undefined) {
          this.sendJson(res, 404, { status: 'not-found', message: `Field '${requestedField}' was not found` }, method);
          return;
        }

        this.log(`HTTP API [#${reqId}]: returning field ${requestedField}`);
        this.sendJson(res, 200, {
          status: 'success', url: this.getRequestUrlWithoutToken(req), method: req.method, data: fieldValue,
        }, method);
        return;
      }
      this.log(`HTTP API [#${reqId}]: flow responded, sending 200`);
      this.sendJson(res, 200, {
        status: 'success', url: this.getRequestUrlWithoutToken(req), method: req.method, data: responseData,
      }, method);
    } catch (e) {
      if (e instanceof Error && e.message === 'RESPONSE_TIMEOUT') {
        this.error(`HTTP API [#${reqId}]: no response received from any flow within ${RESPONSE_TIMEOUT_MS}ms`);
        this.sendJson(res, 504, { status: 'error', message: 'Flow did not respond in time' }, method);
      } else {
        this.error(`HTTP API [#${reqId}]: unexpected error while handling request`, e);
        this.sendJson(res, 500, { status: 'error', message: 'Internal server error' }, method);
      }
    } finally {
      this.localApiEvent.removeAllListeners('responseAction');
    }
  }

  /**
   * Wait for a flow's "Respond with..." action, or time out after RESPONSE_TIMEOUT_MS.
   */
  waitForFlowResponse(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.localApiEvent.removeAllListeners('responseAction');
        reject(new Error('RESPONSE_TIMEOUT'));
      }, RESPONSE_TIMEOUT_MS);
      this.localApiEvent.once('responseAction', (body: unknown) => {
        clearTimeout(timeout);
        resolve(body);
      });
    });
  }

  /**
   * Write a JSON response body and end the response.
   */
  sendJson(res: ServerResponse, statusCode: number, payload: unknown, method?: string) {
    if (!res.writableEnded) {
      const body = JSON.stringify(payload);
      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(method === 'HEAD' ? undefined : body);
    }
  }

  /**
   * onUninit is called when the app is destroyed, closing the HTTP server frees the port.
   */
  async onUninit() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    if (this.icalInterval) {
      clearInterval(this.icalInterval);
    }
    if (this.icalEventTickInterval) {
      clearInterval(this.icalEventTickInterval);
    }
    if (this.icalConfigTimeout) {
      clearTimeout(this.icalConfigTimeout);
    }
    if (this.server) {
      this.log('HTTP API: closing HTTP server');
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
    }
  }

}

module.exports = LocalApi;
