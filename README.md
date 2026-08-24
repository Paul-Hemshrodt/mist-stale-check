# Mist Stale Check

A Manifest V3 Chrome extension that warns you when the Juniper Mist switch
page you have open was modified by someone else, so you don't silently
overwrite their changes when you click Save.

## The problem

The Mist dashboard has no optimistic-locking protection. If engineer A leaves
a switch detail page open, engineer B edits that switch, and engineer A later
clicks Save, the dashboard PUTs A's stale copy and B's change is lost without
warning.

## What it does

While you're on a watched page, the extension:

1. GETs the page's API object once to establish a baseline. Watched pages
   and their endpoints (the API host is derived by replacing the leading
   `manage.` in the dashboard host with `api.`, so it works on any Mist cloud
   including GovCloud):

   | Dashboard hash route | API endpoint |
   |---|---|
   | `#!switch/detail/{device_id}/{site_id}` | `/api/v1/sites/{site_id}/devices/{device_id}` |
   | `#!switchConfig/detail/{site_id}/{site_id}` | `/api/v1/sites/{site_id}/setting` |
   | `#!org/{uuid}` (org id taken from the `?org_id=` query param, not the hash) | `/api/v1/orgs/{org_id}/setting` |
2. Re-GETs it when the tab becomes visible, on window focus, and every 60
   seconds while the tab is visible (never while hidden; overlapping triggers
   are debounced). It also fires an immediate check (debounce bypassed) when
   you click a **Save** button: in the Mist UI, Save opens a review/preview
   step before anything is submitted, so the check completes and the banner
   appears while you're still reviewing — before you can confirm.

   The 60-second cadence is the default — click the extension's toolbar icon
   to pick 30s / 1min / 2min / 5min. The choice is stored in
   `chrome.storage.sync` (synced across your Chrome profile) and takes effect
   immediately on open Mist tabs, no reload needed.
3. Compares `modified_time` (epoch seconds) against the baseline, falling back
   to a sorted-key JSON comparison with volatile/runtime fields stripped if
   `modified_time` is absent.
4. If the object changed, shows a fixed red banner listing the changed
   top-level keys, with **Refresh** and **Dismiss** buttons, and stops polling.
   Dismiss re-baselines on the version it just saw, so the banner only
   returns if the switch is modified *again*.

The extension is **read-only** — it only ever sends GET requests with your
existing dashboard session cookie. On 401/403 it stops silently; on other
errors it backs off (doubling up to 5 minutes) and keeps trying without
showing anything.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `mist-stale-check/` folder.
4. Open (or reload) a Mist dashboard tab.

## How to test

**Parser unit tests:** open `test.html` in the browser (double-click it, or
`open test.html`). It loads `content.js`, which exposes its pure functions
when not on a `manage.*` host, and runs assertions against the example URL.
All lines should say PASS.

**End to end:**

1. Open a switch detail page in the dashboard. With `DEBUG = true` (top of
   `content.js`), the console shows `[mist-stale]` lines: the parsed
   device/site IDs, the derived API host, and the baseline GET with its
   `modified_time`.
2. From a second browser (or the Mist API), change something on that switch —
   rename it, change a port profile.
3. Switch back to the first tab. Within a few seconds of the tab becoming
   visible, the red banner should appear naming the changed keys.
4. Navigate to a *different* switch via the dashboard (hash change, no page
   reload). The console should show a new baseline; no stale banner carries
   over.
5. Navigate to a non-switch page (e.g. the switch list). Console shows
   "not a supported detail page — idle" and polling stops.

Set `DEBUG = false` in `content.js` once you're happy.

## Known limitations

- **It warns, it doesn't block.** Nothing stops you from confirming the save
  anyway. The Save-click check shrinks the race window to roughly the time
  between clicking Save and confirming the preview, but a truly simultaneous
  edit in that last second can still slip through unwarned.
- The Save-click trigger matches buttons by visible text (`Save`, case-
  insensitive — `SAVE_BUTTON_RE` in `content.js`). If Mist renders the button
  with different wording (e.g. "Save Changes") or as a non-button element the
  `closest()` call doesn't cover, adjust the regex/selector. With `DEBUG` on,
  a detected click logs `Save click detected` — if you click Save and don't
  see that line, the heuristic needs tuning for your page.
- Covers **switch detail, switch config (site setting), and org settings
  pages**. AP and gateway pages use the same hash shape and endpoint pattern
  as switch; adding them is a copy of the `switch` entry in `ROUTE_TYPES` in
  `content.js` (plus verifying their volatile fields).
- The changed-keys list is top-level only ("port_config changed"), not a deep
  diff.
- The volatile-field list (`VOLATILE_KEYS` in `content.js`) is a starting
  guess; if you see false banners with no real config change (only possible
  when `modified_time` is missing), add the offending field there.
- The fetch runs from the content script with `credentials: 'include'`, which
  works because the dashboard origin already has CORS access to the API host.
  If a Mist cloud ever blocks this, the fallback is to move the fetch into a
  background service worker (the `host_permissions` are already in place for
  that); it isn't implemented because the direct path works.
- Chrome match patterns only allow a wildcard as the *leftmost* host label, so
  the manifest cannot express `manage.*.mist.com`. It matches
  `*.mist.com` / `*.mist-federal.com` instead, and `content.js` exits
  immediately on any host that doesn't start with `manage.` — the practical
  effect is identical, but Chrome will list the broader host access on the
  extension's details page.
