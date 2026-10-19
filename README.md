# Homey Toolkit: API, Email, iCal and Timers in one app

Homey Toolkit combines the functionality of the **API**, **Email**, **iCal**, and **Timer** apps in one Homey application. Instead of installing and configuring separate apps, you can receive HTTP requests, send Gmail messages, synchronize calendar events, and run countdown-based automations from Homey Flows.

The iCal dashboard widget requires Homey 12.3.0 or later; this release therefore requires Homey 12.3.0 or later.

## Four tools in one app

- **HTTP API:** Receive local HTTP requests and use them to trigger Homey Flows. Flows can return an empty `200` response or a custom JSON response. Optional token authentication helps protect endpoints.
- **Gmail email:** Configure a Gmail account and send plain-text emails from a Flow. Email actions can be combined with API requests, timer events, and other Homey automation.
- **iCal calendars:** Subscribe to iCalendar (`.ics`) URLs, synchronize upcoming and recurring events automatically or from a Flow, and trigger automations when events start, end, change, or synchronization fails. Flows can check whether an event is ongoing, create Homey-only local events, and remove local events by title.
- **Countdown timers:** Create named timers and control them from Flows. Start fixed or random countdowns, repeat them for multiple rounds, adjust, pause, resume, or stop them, and use timer events and state as Flow triggers and conditions.

## Settings and app updates

The app keeps its configuration in Homey's persistent app settings, separate from the installed app files. Updating the app in place preserves saved API settings and tokens, Gmail credentials, calendar URLs, timer configuration, and active timer state. Do not uninstall the app as part of an update; uninstalling may remove its stored settings. The Gmail app password is never displayed in the settings page: leaving its field blank keeps the saved password, and it is removed only when you explicitly select **Clear the saved app password**.

## Supported HTTP methods

The trigger card supports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`. Routes may be entered as either `status` or `/status`; query parameters do not change the route match.

Request bodies for `POST`, `PUT`, and `PATCH` must contain valid JSON. `HEAD` responses contain the same headers as a normal response but no response body. `OPTIONS` requests include the supported methods in the `Allow` header.

### Select one response value

Add `field` (or the Dutch alias `veld`) to a `GET` request to return one property from the JSON returned by a flow. The app looks for the property both at the top level and inside a `data` object. For example, when `/alles` returns a `Zonsopkomst` property, request:

```text
http://HOMEY_IP:3000/alles?veld=Zonsopkomst
```

If API token authentication is enabled, include the token as well:

```text
http://HOMEY_IP:3000/alles?veld=Zonsopkomst&token=YOUR_TOKEN
```

The response contains only that value in its `data` property. A requested field that does not exist returns `404`.

## iCal calendars

Open the **iCal** settings tab, add a name and an iCalendar (`.ics`) URL for each calendar, and choose the automatic synchronization interval and how many days ahead to load events. Synchronization runs automatically (every 15 minutes by default) and can also be started from the settings page or the **Synchronize iCal calendars** Flow action. Recurring events are expanded into individual events for the selected timeframe. Calendar URLs may contain private access tokens; treat them as credentials.

For Google Calendar, copy **Secret address in iCal format** from the calendar's settings. For Outlook, publish the calendar and copy the ICS link. For iCloud, enable **Public Calendar** and copy the original URL; Apple's default Home and Work calendars do not provide public links. Calendar providers that only specify `X-WR-TIMEZONE` without timezone information on events may have their event times interpreted as UTC.

The iCal Flow cards trigger when an event starts or ends, when a synchronized event changes or is added, and when a calendar synchronization fails. After the first successful synchronization, the settings page lists only newly added or changed events; the corresponding Flow triggers send those event details to connected Homey Flows. A failed calendar keeps its previous snapshot and does not create false change notifications. Conditions check whether any event or a title/calendar match is ongoing, or whether an event starts within a given number of minutes. Flows can create local events, which exist only in Homey and do not modify the external calendar, and delete local events whose title contains specified text. Trigger cards provide the event title, description, location, calendar, start/end time, duration, URL, status, and UID.

Pair the **iCal Calendar** device to expose whether any synchronized event is upcoming. The **Upcoming calendar events** dashboard widget displays events over the selected number of days, with optional calendar names and locations, and provides a manual refresh button.

## Countdown timers

Create named timers in the **Timers** tab in app settings. The list can be imported from or exported to a JSON file. Timers keep running across app restarts; the app stores the deadline and resumes a paused timer with its remaining value.

The countdown flow cards provide:

- Triggers for reaching zero, reaching a selected value, starting, stopping before zero, changing value, and starting or updating.
- Actions to start a fixed or inclusive random duration, optionally repeat it for a chosen number of rounds (up to 1,000), adjust a running or paused timer, stop one or all timers, and pause or resume a timer. Random durations are selected once and reused for every round.
- Conditions for running state, paused state, exact value (or not), and less-than or greater-than comparisons.

Values are measured in whole seconds. The zero trigger includes the completed round number and the number of rounds remaining. A stopped timer is reset to `-1`; a timer that completes its final round remains at `0` until it is started or stopped.

## Gmail email

Configure a Gmail address and a Google app password in the **Email** settings tab. A Google app password requires 2-Step Verification; do not enter your regular Google account password. The password is stored in the app's Homey settings.

Use the **Send an email with Gmail** Flow action to send a plain-text message. It can be connected after the HTTP API trigger to send email when a matching request is received. Keep API token authentication enabled for routes that can send email.

## Why it matters

Some integrations do not require a complex control panel or a broad automation platform. They require a precise point of contact. An external service reports an event, Homey evaluates the current state of the environment, and a response is returned in a way that is both useful and controlled.

This creates a dependable bridge between observation and action: a sensor detects a condition, a script receives the update, and Homey responds with measured logic rather than raw mechanical behavior.

## Operational model

The solution is designed for scenarios where protocol details are not the primary concern, but reliable interaction is. It allows external systems to initiate a request without requiring deep knowledge of the underlying Homey automation structure.

## Security

Token authentication can be enabled in the app settings. Generate a long random token and send it with requests using the preferred header format:

```http
Authorization: Bearer YOUR_TOKEN
```

For simple URL-based clients, the token can also be supplied as `?token=YOUR_TOKEN`. Header authentication is recommended because URL tokens can appear in browser history and intermediary logs. Tokens are compared in constant time, responses are marked `no-store`, and authentication failures are rejected before a Homey flow is triggered. Generating a new token immediately invalidates the previous one.

The application is intended for local-network use only. Do not expose the port directly to the public internet; use a properly secured reverse proxy or VPN when remote access is required.

## Summary

This is a quiet translation layer: a request enters, a response is structured, and the home environment responds with measured precision. In a system that depends on consistency and context, that makes all the difference.
