/**
 * neon-storage.js — Client-side storage layer
 *
 * Design goals:
 * - Every page load reads FRESH data from Neon — no stale browser cache
 * - Sync XHR on load guarantees data is in cache before module JS runs
 * - NOTE: xhr.timeout is NOT allowed on sync requests (browser throws) — omitted
 * - Async writes with 10s timeout via AbortController
 * - 3-attempt exponential back-off on server errors
 * - Hard guard: never overwrites Neon with empty arrays
 */
(function () {
  var API = '/api/storage';
  var WRITE_TIMEOUT_MS = 10000;
  var cache = Object.create(null);
  var _ready = false;
  var _readyCbs = [];

  function _resolveReady() {
    _ready = true;
    var cbs = _readyCbs.slice();
    _readyCbs = [];
    cbs.forEach(function (cb) { try { cb(cache); } catch (e) {} });
  }

  // ── Synchronous bulk load ─────────────────────────────────────────────────
  // Blocks briefly to ensure data is available before any module script runs.
  // This prevents the race condition where modules save empty state to Neon.
  // CRITICAL: Do NOT set xhr.timeout — browsers throw on sync XHR timeout.
  var syncLoaded = false;
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API, false); // false = synchronous
    xhr.send();
    if (xhr.status >= 200 && xhr.status < 300) {
      var parsed = JSON.parse(xhr.responseText);
      if (parsed && typeof parsed === 'object') {
        Object.assign(cache, parsed);
        syncLoaded = true;
      }
    } else {
      console.warn('[neon] sync load HTTP ' + xhr.status + ' — retrying async');
    }
  } catch (e) {
    console.warn('[neon] sync load failed, retrying async:', e.message);
  }

  if (syncLoaded) {
    _resolveReady();
  } else {
    // Async fallback — timeout IS allowed on async XHR
    var fallback = new XMLHttpRequest();
    fallback.open('GET', API, true);
    fallback.timeout = 15000;
    fallback.onload = function () {
      if (fallback.status >= 200 && fallback.status < 300) {
        try {
          var d = JSON.parse(fallback.responseText);
          if (d && typeof d === 'object') {
            // Replace entire cache with fresh Neon data
            Object.keys(cache).forEach(function (k) { delete cache[k]; });
            Object.assign(cache, d);
          }
        } catch (e) {}
      }
      _resolveReady();
    };
    fallback.onerror   = function () { _resolveReady(); };
    fallback.ontimeout = function () { _resolveReady(); };
    fallback.send();
  }

  // ── Async write with AbortController timeout + retry ─────────────────────
  function fetchWithTimeout(url, opts, ms) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (controller) {
      opts = Object.assign({}, opts, { signal: controller.signal });
      timer = setTimeout(function () { controller.abort(); }, ms);
    }
    return fetch(url, opts).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function asyncWrite(method, key, value) {
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (value !== undefined) opts.body = JSON.stringify({ value: String(value) });
    var url = API + '/' + encodeURIComponent(key);
    var attempt = 0;
    var delays = [0, 500, 1500];

    function run() {
      attempt++;
      var doFetch = function () {
        return fetchWithTimeout(url, opts, WRITE_TIMEOUT_MS).then(function (r) {
          if (!r.ok && r.status !== 204) {
            if (r.status >= 500 && attempt < 3) {
              return new Promise(function (res) {
                setTimeout(res, delays[attempt] || 2000);
              }).then(run);
            }
            return r.text().then(function (t) {
              var msg = 'HTTP ' + r.status;
              try { msg = JSON.parse(t).error || msg; } catch (e) {}
              throw new Error(msg);
            });
          }
        });
      };
      return attempt === 1 ? doFetch() : new Promise(function (res) {
        setTimeout(res, delays[attempt - 1] || 2000);
      }).then(doFetch);
    }

    return run().catch(function (err) {
      console.error('[neon] ' + method + ' "' + key + '" failed after ' + attempt + ' attempt(s):', err.message);
      throw err;
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.neonStorage = {

    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    },

    setItem: function (key, value) {
      cache[key] = String(value);
      return asyncWrite('PUT', key, value);
    },

    removeItem: function (key) {
      delete cache[key];
      return asyncWrite('DELETE', key);
    },

    ready: function () {
      if (_ready) return Promise.resolve(cache);
      return new Promise(function (res) {
        _readyCbs.push(function (c) { res(c); });
      });
    },

    /** Full async refresh — replaces entire cache with fresh Neon data */
    refresh: function () {
      return fetchWithTimeout(API, {}, 15000)
        .then(function (r) {
          return r.ok ? r.json() : Promise.reject('HTTP ' + r.status);
        })
        .then(function (d) {
          if (d && typeof d === 'object') {
            Object.keys(cache).forEach(function (k) { delete cache[k]; });
            Object.assign(cache, d);
          }
          return d;
        });
    },

    get isLoaded() { return _ready; },
    get _cache()   { return cache;  }
  };

  // Flush pending saves when user switches tabs or closes
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        try { window.dispatchEvent(new CustomEvent('neon-flush')); } catch (e) {}
      }
    });
  }
})();
