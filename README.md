# dsh-session-auto-rename

Adds **Auto-rename** to the Session menu in the DeepSeek Harness sidebar, and opens that menu **on right-click**.
中文说明见 [README.zh.md](README.zh.md)。

## What you get

- **Auto-rename** — a new row in a Session's「…」menu, right under Rename. It reads the Session log, weights each user message by recency (τ = 3 days, so the newest turns dominate the topic), asks the default model for a short title, and applies it through the shipped rename RPC. While it runs, a status line at the bottom of the frame reports progress; failures show the reason.
- **Right-click menu** — right-clicking any Session row opens that row's own「…」menu at the pointer. The menu content is the shipped one (pin / rename / auto-rename / fork / archive / copy id), not a re-implementation.
- **Agent tool** — `session_auto_rename({ sessionId })`, the same operation, callable by the model.

## Requirements

- DSH `>= 0.2.1-rc.5` (the plugin registers its host entry point on the shared `/api` Fetch channel, which the Desktop shell proxies).
- A default model configured in the harness. The plugin follows the composer's current default model; it does not ship its own key.

## Install

- **Plugin market / Plugins page:** install this bundle, then reload the app once — the Desktop shell freezes the page's startup plugin list, so a new client half appears after a restart.
- **CLI (web profile):**
  ```sh
  dsh plugin --profile web add @jason25417/dsh-session-auto-rename
  ```
- **From source:** add this directory as a bundle with the harness's plugin manager (`install_bundle`).

## Title rules

- Width budget: **10 CJK characters**; ASCII characters count as half, so a pure-Latin title is at most 20 characters. The system prompt states the hard limit, and a title that still overflows gets one repair pass asking for a shorter phrasing before any truncation happens.
- Recency weighting: `w = exp(-age / 3d)`; the top messages are picked by weight inside a 6 000-character prompt budget (at most 18 messages), then shown to the model in chronological order with their age and weight, so a topic that moved on is named after where it landed.
- The request pins the model's lowest reasoning effort (`off`) and has **no timeout**: it waits as long as the model takes. Clicking Auto-rename again aborts the previous run and starts over; closing the page aborts the model call on the host side.
- The operation renames the Session directly; it does not open a confirmation dialog. The status line reports the new and the previous title.

## Known limitations

- Right-click reuses the shipped menu by synthesizing the「…」button's click and keeping the portal menu pinned at the pointer. It relies on the sidebar row attributes `data-row-key="session:<id>"` and `span[class*="rowActions"]`; if a DSH release changes that markup, right-click degrades silently while the menu row keeps working.
- The title call goes through `ctx.llm.stream` with the current default model. Switching the composer model changes the route the plugin uses.
- The menu surface re-derives its anchor every frame; the plugin keeps it at the pointer with a transform, so scrolling moves the menu with the anchor instead of leaving it at the original point.

## Development

Plain-JS bundle: `index.js` (host half: Fetch route + agent tool) and `client.js` (client half: menu row, status line, right-click), wired by `cordis.patch.yml`. No build step.

## Verification

Tested on DSH Desktop 0.2.1-rc.5 (macOS). Host: the `/api` Fetch route was exercised on a ~2 400-event Session and returned a title in 2.5–4.4 s. Client: the menu row renders between Rename and Fork with the shipped menu item's metrics, right-click opens the same menu at the pointer, and a click reaches the host (status line → renamed title in the sidebar). Right-clicking a blank Session row does nothing.
