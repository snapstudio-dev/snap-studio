# Privacy: the anonymous usage count

Snap Studio sends **one anonymous signal each time it starts**, to count how
many people use it (daily and monthly, by version, system and language).
Nothing else. You can turn it off at any time.

## What is sent

One event, named `app_started`, once per launch, with no data of Snap
Studio's own. The [Aptabase plugin](https://github.com/aptabase/tauri-plugin-aptabase)
(`tauri-plugin-aptabase` 1.3, read in its source) adds these fields to it,
and only these:

| Field | Example | What it is |
|---|---|---|
| `eventName` | `app_started` | The event: the only one Snap Studio sends. |
| `timestamp` | `2026-11-04T21:05:12Z` | When the app started (UTC). |
| `sessionId` | `177829951212345678` | A random number made at launch (the time in seconds, then 8 random digits). Kept in memory only, never on disk: a new one at each launch. |
| `appVersion` | `0.19.0` | Snap Studio's version. |
| `osName`, `osVersion` | `macOS`, `15.5` | Your system and its version. |
| `locale` | `fr-FR` | Your system's language. |
| `engineName`, `engineVersion` | `WebKit`, `621.1.15` | The system's web view and its version (WebKit, WebView2 or WebKitGTK). |
| `isDebug` | `false` | Whether it is a development build (always `false`: those send nothing). |
| `sdkVersion` | `tauri-plugin-aptabase@1.3.0` | The plugin's version. |
| `props` | `null` | Custom properties: none. |

The request also carries the Aptabase **app key** of Snap Studio (the same
for everyone) and a User-Agent made of the same system, web view and
language fields. Like any connection, it reaches Aptabase from your
**IP address**: Aptabase says it only processes the IP address and the
User-Agent in memory and never stores them.

Nothing goes out before the first event: the plugin only sends what is
queued, and Snap Studio queues `app_started` only after you have answered
the notice (see below), with the count on. Crash and error reporting,
which the plugin also offers, is not turned on.

## What is never sent

Your files, models and their names, folders and paths, your printers (model,
address, serial number), your AI conversations, your account or email, your
settings, and any identifier that stays from one launch to the next.

## Where it goes

To [Aptabase](https://aptabase.com), an open-source analytics service made
for privacy (no cookies, no device identifier), on its hosted service, in
its European Union region. Aptabase's own terms: its
[privacy policy](https://aptabase.com/legal/privacy) says that the data of
EU-region apps is processed and stored only in the European Union, and kept
for up to 5 years.

## Turning it off

- **At first launch**: a step of the welcome assistant explains the count,
  with a switch to turn it off; for a user who had the app before it, a
  sheet does, at the first launch of a version that has it (after a step
  introducing Snappy, if that is new too). Nothing is sent before you close it; switched off there, nothing is
  ever sent.
- **At any time**: Settings › Application › Anonymous usage count. It takes
  effect at once: nothing new is sent. One exception: if this launch's
  signal could not be delivered (no network, an Aptabase server error), the
  plugin keeps it and tries again, until the app quits, even after the count
  is switched off. It is the signal of a launch made while the count was
  on; the next launches send nothing.

## Builds that send nothing

The count only works in the releases published on GitHub, built with the
Aptabase app key (a secret of the release workflow). A development build, a
build of your own or of a fork, has no key: the plugin is not even loaded,
the sheet never opens, and Settings says "Not available in this build".

## The code

- [`src-tauri/src/analytics.rs`](../src-tauri/src/analytics.rs): when the
  event is sent, and the only event.
- [`ui/analytics.js`](../ui/analytics.js): the count's step (shown by the welcome
  assistant or the first-launch sheet, [`ui/intros.js`](../ui/intros.js)) and the
  Settings switch.
- [`.github/workflows/build.yml`](../.github/workflows/build.yml): the app
  key, given to the release build only.

Any new event or field needs a plan first, and this page, the sheet and the
READMEs updated before it ships (see [CONTRIBUTING](../CONTRIBUTING.md)).
