# A controlled interface for Homey

This application is not a generic API wrapper. It is a focused integration layer between Homey and the services, scripts, and external systems that need to interact with the home environment without forcing the entire installation into a brittle protocol-driven workflow.

The principle is straightforward: a signal is received, processed, and translated into a clean, structured response. That creates a local communication channel through which devices, services, and automations can exchange information without the rest of the system needing to understand the details of the underlying transport.

## What it does

- expose an internal endpoint for a trigger
- receive an incoming request and route it to a Homey flow
- return a JSON response as a structured result
- operate locally without exposing the home environment as a public-facing internet service

## Supported HTTP methods

The trigger card supports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`. Routes may be entered as either `status` or `/status`; query parameters do not change the route match.

Request bodies for `POST`, `PUT`, and `PATCH` must contain valid JSON. `HEAD` responses contain the same headers as a normal response but no response body. `OPTIONS` requests include the supported methods in the `Allow` header.

### Select one response value

Add `field` (or the Dutch alias `veld`) to a `GET` request to return one property from the JSON returned by a flow. The app looks for the property both at the top level and inside a `data` object. For example, when `/alles` returns a `Zonsopkomst` property, request:

```text
http://HOMEY_IP:3000/alles?veld=Zonsopkomst
```

The response contains only that value in its `data` property. A requested field that does not exist returns `404`.

## Countdown timers

Create named timers in the **Timers** tab in app settings. The list can be imported from or exported to a JSON file. Timers keep running across app restarts; the app stores the deadline and resumes a paused timer with its remaining value.

The countdown flow cards provide:

- Triggers for reaching zero, reaching a selected value, starting, stopping before zero, changing value, and starting or updating.
- Actions to start a fixed or inclusive random duration, adjust a running or paused timer, stop one or all timers, and pause or resume a timer.
- Conditions for running state, paused state, exact value (or not), and less-than or greater-than comparisons.

Values are measured in whole seconds. A stopped timer is reset to `-1`; a timer that reaches zero remains at `0` until it is started or stopped.

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
