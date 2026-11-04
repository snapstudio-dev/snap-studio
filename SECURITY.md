# Security policy

## Supported versions

Snap Studio updates itself: only the [latest release](https://github.com/kameka22/snap-studio/releases/latest)
receives fixes. Please check that a problem still occurs with it.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it
privately instead, through GitHub:
[**Report a vulnerability**](https://github.com/kameka22/snap-studio/security/advisories/new)
(the repository's Security tab).

Say what is affected, how to reproduce it, and what an attacker could do.
You will get an answer within a week; once a fix is released, the
advisory is published with credit to you, unless you prefer otherwise.

## Scope

Snap Studio talks to your printers on the local network, to the model
sites you open in Explore, to GitHub (updates, slicing engine) and, if
you use the AI, runs Claude Code on your computer, in Claude Code's own
sandbox or in a container. Of particular interest:

- the update and engine downloads (signature and checksum checks);
- what a model file, a printer or a web page could make the app do;
- the AI sandbox, both backends: Claude Code's built-in sandbox (its
  settings, the reduced environment Claude starts with, the writes outside
  the conversation's folder Snap Studio denies) and the yolobox container
  (what Claude can reach outside the conversation's folder);
- how the Claude sandbox token is stored (macOS Keychain).

Problems in Snapmaker Orca, Claude Code (its sandbox: Seatbelt,
bubblewrap), yolobox or Tauri themselves are best reported to those
projects.
