/**
 * Mist Stale Check — content script.
 *
 * Watches the currently open switch detail page in the Mist dashboard,
 * periodically re-GETs the switch's API object, and shows a red banner if
 * someone else modified it since this page loaded. Read-only: the extension
 * only ever issues GETs.
 *
 * Note on manifest matches: Chrome match patterns only allow a wildcard as
 * the leftmost host label (`*.mist.com` is valid, `manage.*.mist.com` is
 * not), so the manifest matches all of *.mist.com / *.mist-federal.com and
 * this script exits immediately unless the hostname starts with "manage.".
 */
(() => {
  'use strict';

  const DEBUG = false;
  const LOG_PREFIX = '[mist-stale]';

  const DEFAULT_POLL_MS = 60 * 1000;       // default cadence; user-tunable via popup
  const MAX_BACKOFF_MS = 5 * 60 * 1000;    // cap for error backoff
  const MIN_CHECK_GAP_MS = 5 * 1000;       // debounce: visibility/focus/timer can pile up

  // Current poll interval. The popup writes `pollIntervalSec` to
  // chrome.storage.sync; we read it at startup and track live changes.
  // Falls back to the default outside an extension context (test.html/Node).
  let pollIntervalMs = DEFAULT_POLL_MS;

  // Clicking Save in the Mist UI opens a review/preview step first — nothing
  // is PUT yet. A check fired on that click finishes while the user is still
  // reviewing, so the banner can appear before they confirm. Matched by
  // visible button text; adjust if the dashboard wording differs.
  const SAVE_BUTTON_RE = /^\s*save\s*$/i;

  // Page types handled, keyed by the lowercased first segment of the hash
  // route `#!{type}/detail/{id1}/{id2}`. Each entry maps that route to the
  // API object to watch:
  //  - Device pages (switch, later ap/gateway): id1 = device_id, id2 = site_id,
  //    endpoint sites/{site_id}/devices/{device_id}. To add ap/gateway later,
  //    copy the 'switch' entry.
  //  - switchConfig (site-level switch configuration): both ids are the
  //    site_id, endpoint sites/{site_id}/setting.
  //  - org (org settings): hash is `#!org/{uuid}` where the uuid is NOT the
  //    org id — the org id comes from the ?org_id= query param; endpoint
  //    orgs/{org_id}/setting.
  // `label` is what the banner calls the object.
  const ROUTE_TYPES = {
    switch: {
      label: 'switch',
      apiPath: (r) => `sites/${r.siteId}/devices/${r.deviceId}`,
    },
    switchconfig: {
      label: 'switch configuration (site setting)',
      apiPath: (r) => `sites/${r.siteId}/setting`,
    },
    org: {
      label: 'organization settings',
      apiPath: (r) => `orgs/${r.orgId}/setting`,
    },
  };

  // Top-level fields that can change on their own without a human config edit.
  // Ignored by the fallback (full-JSON) comparison and by the changed-keys
  // diff. Adjust this list after inspecting real API responses.
  const VOLATILE_KEYS = new Set([
    'modified_time',   // primary check — compared separately, not as a "changed key"
    'last_seen',
    'uptime',
    'status',
    'version',
    'fw_version',
    'ext_ip',
  ]);

  function log(...args) {
    if (DEBUG) console.log(LOG_PREFIX, ...args);
  }

  // ------------------------------------------------------------------
  // URL parsing
  // ------------------------------------------------------------------

  /**
   * Parse the SPA hash route.
   *
   * Expected shapes:
   *   #!switch/detail/{device_id}/{site_id}
   *   #!switchConfig/detail/{site_id}/{site_id}
   *
   * IMPORTANT — order on device pages: in the hash the DEVICE id comes first
   * and the SITE id second. The API path (see ROUTE_TYPES) is the other way
   * around: sites/{site_id}/devices/{device_id}. Do not invert these.
   * On switchConfig pages both segments carry the site_id; we take the
   * SECOND segment as siteId either way, keeping the convention uniform.
   *
   * There is also the org settings page, whose hash carries a UUID that is
   * NOT the org id:
   *   #!org/{page_uuid}     (org_id comes from the ?org_id= query param)
   *
   * Returns a route object with a `key` uniquely identifying the watched
   * object ({ type, key, ...ids }), or null when the hash is not a supported
   * page. `type` is lowercased (hash says "switchConfig").
   *
   * `search` is the location.search string — needed only for the org route.
   */
  function parseHash(hash, search) {
    // Detail pages: both ids are 36-char UUIDs. Allow trailing "/..." or
    // "?..." segments in case the dashboard appends sub-routes.
    const m = /^#!([a-z]+)\/detail\/([0-9a-f-]{36})\/([0-9a-f-]{36})(?:[/?].*)?$/i.exec(hash || '');
    if (m) {
      const type = m[1].toLowerCase();
      if (!ROUTE_TYPES[type] || type === 'org') {
        log('parseHash: unsupported page type', type);
        return null;
      }
      const route = {
        type,
        deviceId: m[2].toLowerCase(),
        siteId: m[3].toLowerCase(),
        key: `${type}/${m[2].toLowerCase()}/${m[3].toLowerCase()}`,
      };
      log('parseHash:', route);
      return route;
    }

    // Org settings page: #!org/{uuid}. The uuid in the hash is not the org
    // id — the real org id is the ?org_id= query param on the page URL.
    const om = /^#!org\/([0-9a-f-]{36})(?:[/?].*)?$/i.exec(hash || '');
    if (om) {
      const orgId = (new URLSearchParams((search || '').replace(/^\?/, '')).get('org_id') || '').toLowerCase();
      if (!/^[0-9a-f-]{36}$/.test(orgId)) {
        log('parseHash: org page but no valid org_id query param in', search);
        return null;
      }
      const route = { type: 'org', orgId, key: `org/${orgId}` };
      log('parseHash:', route);
      return route;
    }

    log('parseHash: no match for', hash);
    return null;
  }

  /**
   * Derive the API host from the dashboard host by replacing the leading
   * "manage." label with "api.". Everything after that label is preserved,
   * so any regional/cloud suffix works without a hardcoded list:
   *   manage.mist.com             -> api.mist.com
   *   manage.gc1.mist.com         -> api.gc1.mist.com
   *   manage.us.mist-federal.com  -> api.us.mist-federal.com
   * Returns null when the host doesn't start with "manage.".
   */
  function deriveApiHost(hostname) {
    if (!/^manage\./i.test(hostname)) return null;
    return hostname.replace(/^manage\./i, 'api.');
  }

  /**
   * Build the GET endpoint for a parsed route. The path shape comes from
   * ROUTE_TYPES — for devices, note the site/device order is INVERTED
   * relative to the hash: sites/{site_id}/devices/{device_id}.
   */
  function buildApiUrl(hostname, route) {
    const apiHost = deriveApiHost(hostname);
    if (!apiHost) return null;
    return `https://${apiHost}/api/v1/${ROUTE_TYPES[route.type].apiPath(route)}`;
  }

  // ------------------------------------------------------------------
  // Comparison
  // ------------------------------------------------------------------

  /**
   * Deterministic JSON serialization: object keys sorted at every level, so
   * key-order differences between responses can't cause a false "changed".
   */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') + '}';
  }

  /** Copy of obj with VOLATILE_KEYS removed (top level only). */
  function stripVolatile(obj) {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (!VOLATILE_KEYS.has(k)) out[k] = obj[k];
    }
    return out;
  }

  /** Sorted list of non-volatile top-level keys whose values differ. */
  function changedTopLevelKeys(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const changed = [];
    for (const k of keys) {
      if (VOLATILE_KEYS.has(k)) continue;
      if (stableStringify(a[k]) !== stableStringify(b[k])) changed.push(k);
    }
    return changed.sort();
  }

  /**
   * Compare a fresh response against the baseline.
   *
   * Primary check: `modified_time` (epoch seconds on Mist objects). If both
   * sides carry it, it alone decides — an equal modified_time means no config
   * edit happened, and a different one means an edit happened even if the
   * top-level key diff comes back empty (e.g. a nested change inside a key we
   * treat as volatile).
   *
   * Fallback (modified_time missing on either side): compare the stable
   * serialization with volatile fields stripped.
   *
   * Returns null when unchanged, otherwise the (possibly empty) list of
   * changed top-level keys for the banner.
   */
  function compareToBaseline(baseline, current) {
    const baseMod = baseline.modified_time;
    const curMod = current.modified_time;
    if (baseMod !== undefined && curMod !== undefined) {
      if (baseMod === curMod) {
        log('compare: modified_time unchanged', curMod);
        return null;
      }
      const keys = changedTopLevelKeys(baseline, current);
      log('compare: modified_time changed', baseMod, '->', curMod, 'keys:', keys);
      return keys;
    }
    // Fallback path.
    const baseSer = stableStringify(stripVolatile(baseline));
    const curSer = stableStringify(stripVolatile(current));
    if (baseSer === curSer) {
      log('compare: fallback serialization unchanged');
      return null;
    }
    const keys = changedTopLevelKeys(baseline, current);
    log('compare: fallback serialization changed, keys:', keys);
    return keys;
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  const state = {
    route: null,       // { type, deviceId, siteId } for the current page, or null
    apiUrl: null,      // GET endpoint for the current route
    baseline: null,    // full JSON from the first successful GET
    timerId: null,     // pending setTimeout for the next poll
    delayMs: DEFAULT_POLL_MS, // current poll delay (doubles on errors)
    inFlight: false,
    lastCheckAt: 0,
    stopped: false,    // true after auth failure or after a change is detected
    epoch: 0,          // bumped on every route change; in-flight fetches from
                       // an older epoch discard their response instead of
                       // baselining the new page with the old page's object
  };

  function clearTimer() {
    if (state.timerId !== null) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
  }

  /** Chain of setTimeouts instead of setInterval, so error backoff can stretch the delay. */
  function scheduleNext() {
    clearTimer();
    if (state.stopped || !state.apiUrl) return;
    // No timer while hidden — the visibilitychange handler restarts the
    // chain when the tab becomes visible again.
    if (document.visibilityState === 'hidden') return;
    state.timerId = setTimeout(() => {
      state.timerId = null;
      check('timer').finally(scheduleNext);
    }, state.delayMs);
  }

  function backOff() {
    state.delayMs = Math.min(state.delayMs * 2, MAX_BACKOFF_MS);
    log('backing off, next delay', state.delayMs, 'ms');
  }

  // ------------------------------------------------------------------
  // Polling
  // ------------------------------------------------------------------

  async function check(reason, force = false) {
    if (state.stopped || !state.apiUrl) return;
    if (state.inFlight) { log('check skipped (in flight):', reason); return; }
    if (document.visibilityState === 'hidden') { log('check skipped (hidden):', reason); return; }
    const now = Date.now();
    // `force` (Save click) skips the debounce — that check must run NOW so
    // the banner can appear while the user is still on the preview step.
    if (!force && now - state.lastCheckAt < MIN_CHECK_GAP_MS) { log('check debounced:', reason); return; }
    state.lastCheckAt = now;
    state.inFlight = true;
    // Snapshot the epoch: if the route changes while this fetch is in the
    // air, applyRoute bumps state.epoch (and resets inFlight), and this
    // response must be thrown away WITHOUT touching state — otherwise the old
    // page's object would become the new page's baseline.
    const epoch = state.epoch;
    log('GET', state.apiUrl, '(reason:', reason + ')');

    let res;
    try {
      res = await fetch(state.apiUrl, { credentials: 'include' });
    } catch (err) {
      if (state.epoch !== epoch) { log('discarding stale fetch error (route changed)'); return; }
      state.inFlight = false;
      log('fetch error:', err);
      backOff();
      return;
    }
    if (state.epoch !== epoch) { log('discarding stale response (route changed)'); return; }

    if (res.status === 401 || res.status === 403) {
      // Session expired / no access. Stop silently — the dashboard itself
      // will surface the auth problem to the user.
      state.inFlight = false;
      state.stopped = true;
      clearTimer();
      log('auth failure', res.status, '— polling stopped');
      return;
    }

    if (!res.ok) {
      state.inFlight = false;
      log('HTTP', res.status, '— will retry with backoff');
      backOff();
      return;
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      if (state.epoch !== epoch) { log('discarding stale parse error (route changed)'); return; }
      state.inFlight = false;
      log('JSON parse error:', err);
      backOff();
      return;
    }
    if (state.epoch !== epoch) { log('discarding stale response (route changed)'); return; }
    state.inFlight = false;

    // The comparison code assumes a plain JSON object; anything else (null,
    // array, unexpected wrapper) is treated like a bad response.
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      log('unexpected response shape — will retry with backoff');
      backOff();
      return;
    }
    state.delayMs = pollIntervalMs; // successful GET resets backoff

    if (!state.baseline) {
      state.baseline = body;
      log('baseline set; modified_time =', body.modified_time);
      return;
    }

    const changedKeys = compareToBaseline(state.baseline, body);
    if (changedKeys !== null) {
      // Nothing more to learn until the user refreshes — stop polling.
      state.stopped = true;
      clearTimer();
      showBanner(changedKeys, body);
    }
  }

  // ------------------------------------------------------------------
  // Banner
  // ------------------------------------------------------------------

  const BANNER_ID = 'mist-stale-banner';

  function removeBanner() {
    const el = document.getElementById(BANNER_ID);
    if (el) el.remove();
  }

  function showBanner(changedKeys, detectedObject) {
    removeBanner();

    const banner = document.createElement('div');
    banner.id = BANNER_ID;

    const msg = document.createElement('span');
    msg.className = 'mist-stale-msg';
    const when = new Date().toLocaleTimeString();
    const label = state.route ? ROUTE_TYPES[state.route.type].label : 'object';
    let text = `This ${label} was modified by someone else at ${when} — refresh before saving or you will overwrite their changes.`;
    if (changedKeys.length) {
      text += ` Changed: ${changedKeys.join(', ')}.`;
    }
    msg.textContent = text;

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', () => location.reload());

    // Dismiss: hide the banner and re-baseline on the object we just saw, so
    // the banner only comes back if modified_time changes AGAIN. Polling
    // resumes against the new baseline.
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'mist-stale-dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      removeBanner();
      state.baseline = detectedObject;
      state.stopped = false;
      state.delayMs = pollIntervalMs;
      log('dismissed; re-baselined at modified_time =', detectedObject.modified_time);
      scheduleNext();
    });

    banner.appendChild(msg);
    banner.appendChild(refreshBtn);
    banner.appendChild(dismissBtn);
    (document.body || document.documentElement).appendChild(banner);
    log('banner shown; changed keys:', changedKeys);
  }

  // ------------------------------------------------------------------
  // Route handling (hash-routed SPA — no page reloads between devices)
  // ------------------------------------------------------------------

  function applyRoute() {
    const route = parseHash(location.hash, location.search);
    if (route && state.route && route.key === state.route.key) {
      return; // same watched object (e.g. tab change within page) — keep baseline
    }

    // Different page: tear down and start over. Bumping the epoch makes any
    // in-flight fetch for the old page discard its response; inFlight is
    // reset here so the new page's first check isn't blocked by it.
    clearTimer();
    removeBanner();
    state.epoch++;
    state.route = route;
    state.baseline = null;
    state.delayMs = pollIntervalMs;
    state.stopped = false;
    state.lastCheckAt = 0;
    state.inFlight = false;

    if (!route) {
      state.apiUrl = null;
      log('not a supported detail page — idle');
      return;
    }

    state.apiUrl = buildApiUrl(location.hostname, route);
    log('watching', route.key, 'via', state.apiUrl);
    check('route');
    scheduleNext();
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------

  if (DEBUG) {
    // Exposed for test.html / console experiments only.
    window.__mistStale = {
      parseHash,
      deriveApiHost,
      buildApiUrl,
      stableStringify,
      stripVolatile,
      changedTopLevelKeys,
      compareToBaseline,
    };
  }

  if (!/^manage\./i.test(location.hostname)) {
    log('hostname is not manage.* — parser exposed for tests, polling disabled');
    return;
  }

  // Poll-rate setting from the popup. Guarded so content.js still runs in
  // plain-page contexts (test.html) where `chrome.storage` doesn't exist.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get({ pollIntervalSec: DEFAULT_POLL_MS / 1000 }, (items) => {
      applyPollInterval(items.pollIntervalSec);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.pollIntervalSec) {
        applyPollInterval(changes.pollIntervalSec.newValue);
      }
    });
  }

  function applyPollInterval(sec) {
    const ms = Number(sec) * 1000;
    if (!Number.isFinite(ms) || ms < 10 * 1000 || ms > MAX_BACKOFF_MS) {
      log('ignoring invalid pollIntervalSec:', sec);
      return;
    }
    if (ms === pollIntervalMs) return;
    const oldMs = pollIntervalMs;
    pollIntervalMs = ms;
    log('poll interval set to', sec, 's');
    // Apply immediately if the pending delay is the old normal cadence.
    // If we're mid-backoff after errors, leave the backoff alone — delayMs
    // resets to the new value on the next successful GET anyway.
    if (!state.stopped && state.delayMs === oldMs) {
      state.delayMs = ms;
      if (state.apiUrl && document.visibilityState === 'visible') scheduleNext();
    }
  }

  window.addEventListener('hashchange', applyRoute);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Main use case: user comes back to a tab left open. Check immediately,
      // then resume the normal cadence.
      check('visibilitychange');
      scheduleNext();
    } else {
      // Don't poll while hidden.
      clearTimer();
      log('tab hidden — polling paused');
    }
  });

  window.addEventListener('focus', () => check('focus'));

  /**
   * Save-click detection. Mist's Save button opens a review/preview step
   * before anything is submitted, so a check fired here completes while the
   * user is still reviewing — the banner appears before they can confirm.
   *
   * Capture phase on document, so the dashboard can't swallow the event
   * before we see it. Purely observational: never preventDefault/stopPropagation.
   * Matching is by visible text ("Save") on the clicked element or its nearest
   * button-ish ancestor — resilient to Mist's minified/random class names.
   */
  document.addEventListener('click', (ev) => {
    if (!state.apiUrl || state.stopped) return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const btn = target.closest('button, [role="button"], input[type="submit"], a');
    if (!btn) return;
    const label = (btn.tagName === 'INPUT' ? btn.value : btn.textContent) || '';
    if (!SAVE_BUTTON_RE.test(label)) return;
    log('Save click detected on', btn.tagName, '— forcing check');
    check('save-click', true);
  }, true);

  applyRoute();
})();
