# Anonymous usage count (Aptabase)

Merged in [#90](https://github.com/kameka22/snap-studio/pull/90)
(2026-11-04). [docs/privacy.md](../privacy.md), the README privacy FAQ and
the site footer are in place (see [Implementation](#implementation)). The
What's new entry is a small line on the 0.19 page
([v0.19.md](v0.19.md)).
[#95](https://github.com/kameka22/snap-studio/pull/95) is merged: the
introduction order on main is Snappy, then this count. The first-launch
section below is the earlier proposal and is kept as history.

Goal: know roughly how many people use Snap Studio (daily and monthly active
users, by version, system and language), nothing more. Snap Studio is open
source, so it has to be light, anonymous, said clearly, and easy to turn off.

## Why Aptabase

- Open source (AGPL server, MIT plugin), made for privacy: no cookies, no
  persistent user id, no IP stored. Hosted (EU region available) or
  self-hosted.
- An official Tauri plugin: `tauri-plugin-aptabase` 1.3.0 (crate, MIT),
  Tauri 2. Events are sent from Rust (`EventTracker::track_event`), so no
  JavaScript package and no CSP change (the web view never calls Aptabase).
- Each event carries, from the plugin itself: app version, OS name and
  version, locale, a random session id, a timestamp. To check at
  implementation, from the plugin's source: the exact payload, that nothing
  is sent before the first `track_event`, and the session id's lifetime.

Rejected: a home-made ping (a server to host and a dashboard to build),
PostHog or Sentry (far more than a count), GitHub download counts (already
there, but downloads, not users).

## What is sent

Exactly one event, **`app_started`**, once per launch, with no custom
properties beyond the plugin's own (version, OS, locale). Never: file or
model names, paths, printer data (model, address, serial), AI prompts,
account or email, settings values. Adding any other event later needs a new
plan and the same notice updated.

## On or off

- **On by default, announced at first launch** (owner's choice), with one
  switch to turn it off. Off means no event at all (the plugin is still
  registered but `track_event` is never called).
- The choice is kept in the app's settings (Rust side, so it is known before
  the first event), key `analytics.enabled`, default `true`, plus
  `analytics.noticed` once the notice has been seen.
- **No event before the notice is answered**: the first `app_started` is
  sent only after the user closes the notice with analytics left on. A user
  who turns it off from the notice never sends anything.
- **Dev builds and forks send nothing**: the app key comes from the build
  environment (`APTABASE_APP_KEY`, a CI secret for release builds). No key at
  build time → the plugin is not registered, the notice does not open and
  the switch says "Not available in this build". Dev builds (`cfg(debug_assertions)`)
  never send, even with a key.

## The notice (first launch)

A modal sheet in the app's style, opened once, at the first launch of a
version that has analytics: for a new user, after the welcome assistant
(not on top of it); for an existing user, at the first launch after the
update. Friendly tone, short, nothing hidden. Draft copy (English; French
below, other languages through the usual review):

> **A small anonymous count**
>
> To know how many people use Snap Studio and keep working on it, the app
> sends one anonymous signal each time it starts.
>
> **What is sent:** the app's version, your system (e.g. macOS 15) and its
> language. That's all.
> **Never sent:** your files, your models, your printers, your AI
> conversations, your address or any id that points to you.
>
> It goes through Aptabase, an open-source, privacy-first service. You can
> change your mind anytime in Settings › Application.
>
> [ ] Send the anonymous count  ← switch, on
>
> **[ Got it ]**   *What exactly is sent?* (link to the doc page)

French:

> **Un petit comptage anonyme**
>
> Pour savoir combien de personnes utilisent Snap Studio et continuer à le
> faire évoluer, l'app envoie un signal anonyme à chaque démarrage.
>
> **Ce qui est envoyé :** la version de l'app, votre système (par ex.
> macOS 15) et sa langue. C'est tout.
> **Jamais envoyé :** vos fichiers, vos modèles, vos imprimantes, vos
> conversations IA, votre adresse ni aucun identifiant qui vous désigne.
>
> Ça passe par Aptabase, un service open source respectueux de la vie
> privée. Vous pouvez changer d'avis à tout moment dans Réglages ›
> Application.
>
> [ ] Envoyer le comptage anonyme  ← interrupteur, activé
>
> **[ Compris ]**   *Qu'est-ce qui est envoyé exactement ?*

Behaviour: the switch acts immediately; "Got it" closes and saves
`analytics.noticed`. Closing with Escape or the close button counts as
"Got it" with the switch as it is. The sheet follows the app's theme and the
9 languages (the tone, "tu" in French, follows the app's existing copy).

## Settings

In **Settings › Application**, a row "Anonymous usage count" with the same
switch, one line of explanation, and "What is sent" (the same list as the
notice). Changing it takes effect at once (no restart).

## Documentation (owner, 2026-11-04: say it clearly everywhere)

The count is written down everywhere a user or a contributor may look, in
plain words, with the same list (sent / never sent / how to turn it off):

- **`docs/privacy.md`** (new): what is sent, exactly (the event and the
  plugin's fields, from its source), what is never sent, where it goes
  (Aptabase, hosted, EU region), how long Aptabase keeps it (from their
  docs), how to turn it off (the sheet, Settings › Application), that dev
  builds and forks send nothing, and a link to the code that sends it.
- **`README.md` and `README.fr.md`**: a short "Privacy" section (or an
  entry in the FAQ, `## FAQ`): "Snap Studio sends one anonymous signal at
  start (version, system, language) to count its users. Nothing else. Turn
  it off in Settings › Application." with a link to `docs/privacy.md`.
- **The site** (`site/`): one FAQ / footer line with the same sentence and
  the link, in the site's languages. Kept short: it is a transparency note,
  not a feature.
- **What's new** (`ui/whats-new.json` / `site/whats-new`): one entry for
  the release that brings it, worded as a notice ("Snap Studio now counts
  its users anonymously; you can turn it off"), not a big feature.
- **`CHANGELOG.md`**: the line under *Unreleased › Added* (above).
- **`CONTRIBUTING.md` / `CONTRIBUTING.fr.md`**: a note for contributors:
  no new event or property without a plan and updating `docs/privacy.md`,
  the sheet and the README first; local and fork builds send nothing.
- **`docs/technical-overview.md`**: the `analytics` module, the key at
  build time, the event.
- **The Innovation Fund submission**: one line in the next forum update
  (the owner posts it).
- `docs/plans/README.md` state.

## Work

- `src-tauri/Cargo.toml`: `tauri-plugin-aptabase = "1.3"`.
- `src-tauri/src/lib.rs`: register the plugin only if `option_env!("APTABASE_APP_KEY")`
  is set and not a dev build; a small `analytics` module with
  `enabled()`, `set_enabled()`, `noticed()`, `start()` (sends
  `app_started` if enabled and noticed) and the Tauri commands for the UI.
  Capability: none needed for the web view (events from Rust only).
- `ui/`: the notice sheet (in `index.html`, logic in a small
  `analytics.js`), opened after the welcome assistant or at start; the
  Settings row.
- Release workflow: pass the `APTABASE_APP_KEY` secret to the build.
- The owner creates the Aptabase app (EU region) and adds the key as a
  repository secret; nothing is sent until then.

## Checks at implementation

- Rust tests: no event when disabled, not noticed, dev build or no key; one
  `app_started` per launch otherwise.
- New user: welcome assistant, then the notice; existing user: the notice
  at first launch after the update; never twice.
- Switch off in the notice → nothing sent (checked with a proxy or the
  plugin's debug log); switch in Settings in sync with the notice.
- The 9 catalogs (`python3 scripts/check-i18n.py`), light and dark theme.
- The payload seen on the wire contains only version, OS, locale, session id
  and timestamp.

## Decisions (owner, 2026-11-04)

1. **On by default**, announced by the first-launch sheet, which lets the
   user turn it off right there.
2. **Aptabase hosted**, with the owner's Aptabase account (not
   self-hosted). The owner creates the app (EU region) and adds its key as
   the `APTABASE_APP_KEY` repository secret.
3. **Also off-switchable in Settings** (Settings › Application), effective at
   once.

Innovation Fund rules (checked 2026-11-04): nothing about telemetry or
analytics; disclosing it (the sheet, `docs/privacy.md`, one line in the
submission) is enough.

## Implementation

- **Rust** (`src-tauri/src/analytics.rs`): `app_key()` is
  `option_env!("APTABASE_APP_KEY")`, none in a dev build
  (`cfg!(debug_assertions)`); the plugin is registered only with a key.
  `analytics.enabled` (default on) and `analytics.noticed` live in the
  app's settings file. `start()` sends `app_started` at most once per
  launch, when available, noticed and enabled, and flushes it at once (not
  at the plugin's next 60 s flush). Known limit, kept by the owner's choice
  (review, 2026-11-04): an event the plugin could not deliver (offline, 5xx)
  stays in its queue and is retried until the app quits, even if switched
  off meanwhile (the plugin cannot empty it); said in `docs/privacy.md`. Commands: `analytics_status`, `analytics_answer` (the
  sheet), `analytics_set` (Settings). Tests: nothing when off, unanswered or
  without a key; one event per launch; switched on later, that launch once.
- **What the plugin sends** (read in `tauri-plugin-aptabase` 1.3.0's source,
  listed in [privacy.md](../privacy.md)): `eventName`, `timestamp`,
  `sessionId` (launch time in seconds and 8 random digits, in memory only,
  renewed after 4 h idle), `systemProps` (`appVersion`, `osName`,
  `osVersion`, `locale`, `engineName`, `engineVersion`, `isDebug`,
  `sdkVersion`) and `props` (null); headers `App-Key` and a User-Agent of
  the same system fields. The client only posts what is queued (the polling
  loop skips an empty queue), so nothing goes out before the first
  `track_event`; crash reporting is off (not asked for).
- **Interface** (`ui/analytics.js`): the sheet opens once when available and
  not noticed, after the welcome assistant (`welcomeClose`) or at start for
  an existing user; "Got it", Escape or closing answer with the switch as
  it is. Settings › Application: the switch, "What is sent" and a link to
  `docs/privacy.md`; greyed out and "Not available in this build" without
  a key. The copy says a little more than the drafts above: the language
  example and "a random number that changes at each launch", and "your
  account" in place of "your address" (the IP address is explained in
  `docs/privacy.md`).
- **Release workflow** (`.github/workflows/build.yml`): the secret
  `APTABASE_APP_KEY` given to the Build step only.
- **What's new**: a small entry on the 0.19 page in
  `versions.json`. The entry says the sheet comes after Snappy's introduction. The
  earlier wording, kept here:
  - en: "**Anonymous usage count** — Snap Studio now sends one anonymous
    signal at start (version, system, language) to count its users,
    nothing else. A sheet tells you at first launch; you can turn it off
    there or in Settings › Application."
  - fr: "**Comptage anonyme** — Snap Studio envoie maintenant un signal
    anonyme au démarrage (version, système, langue) pour compter ses
    utilisateurs, rien d'autre. Une fenêtre vous le dit au premier
    lancement ; vous pouvez le désactiver là ou dans Réglages ›
    Application."
