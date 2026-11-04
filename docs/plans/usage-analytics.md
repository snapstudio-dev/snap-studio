# Anonymous usage count (Aptabase)

Plan only: nothing is implemented until the owner gives the go.

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

## Documentation

- A short `docs/privacy.md` (what is sent, where, how to turn it off, link to
  Aptabase), linked from the README and from the notice.
- CHANGELOG line under *Unreleased › Added*, e.g. "**Anonymous usage
  count**: one anonymous signal at start (version, system, language) to know
  how many people use Snap Studio, announced at first launch and easy to turn
  off in Settings."
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

## Open questions for the owner

- On by default with the notice (as asked), or off by default and the
  notice asks? (On by default gives a real count; off by default counts very
  few people.)
- Aptabase hosted (EU) or self-hosted.
- Whether the Innovation Fund rules say anything about telemetry (checked
  separately before merging).
