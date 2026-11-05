# Snappy — in-app workshop assistant

Status: UX decided (2026-11-05). Technical implementation to be added later.

## What it is

Snappy is a single, persistent workshop assistant inside Snap Studio: one shared conversation with durable memory. It uses the LLM already configured in the app, and will later drive MCP-style actions over app features (local files, printer files, slice settings, etc.).

It is distinct from the existing object-specific AI chats in Create (`data-view="ia"`).

## Placement

- A small, nameless icon at the bottom-right of the left sidebar: it sits on the main content, just to the right of the sidebar, at the bottom.
- The icon appears when the user hovers the content.
- No dark plate or circular chrome behind it: only the white rounded-square avatar with its rainbow outline, transparent around it ([asset](snappy/snappy-squircle-clear.png)).
- No name ("Snappy" or other) is written next to the icon.
- Click: the icon fades out and disappears, and a conversation drawer opens over the current view (e.g. Prepare), so the user stays on that page.
- Closing the drawer brings the icon back (when the content is hovered).

| Idle (content hovered) | Drawer open |
| --- | --- |
| ![Icon on hover](snappy/mockup-float-hover.png) | ![Drawer open](snappy/mockup-float-open.png) |

## Avatar

Rounded square with a pronounced corner radius, white fill, two tilted oval eyes, and a linear rainbow outline using the What's new colors (`#FFCC00`, `#FF3B30`, `#AF52DE`, `#0A84FF`, `#30D158`). No toolhead strokes.

![Avatar](snappy/snappy-squircle-clear.png)

## Copy

French UI copy uses formal « vous » (not « tu »).

## Privacy and safety

- Never send printer serials, filesystem paths, IPs, hostnames, or similar identifiers to the LLM.
- Irreversible actions require user confirmation.

## Out of scope for this revision (TBD)

Technical implementation — wiring, MCP actions, memory storage, files to touch — is not covered here and will be added to this plan later by the owner.
