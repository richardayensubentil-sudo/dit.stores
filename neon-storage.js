/**
 * neon-storage.js — Client-side storage layer
 *
 * 1. Synchronous XHR bulk load — data in cache before any page script runs
 * 2. Async writes with AbortController timeout (10s) — no silent hangs
 * 3. 3-attempt exponential back-off on 5xx errors
 * 4. ready() promise — pages can await data availability
 * 5. NEVER overwrites Neon with empty data on init
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

  // ── 1. Synchronous bulk load ───────────────────────────────────────────────
  // Intentional blocking XHR: guarantees data is in cache before any module
  // script runs, preventing the race where pages save empty arrays to Neon.
  var syncLoaded = false;
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API, false); // false = synchronous
    xhr.timeout = 8000;
    xhr.overrideMimeType('text/plain; charset=x-user-defined'); // handle gzip correctly
    xhr.send();
    if (xhr.status >= 200 && xhr.status < 300) {
      var parsed = JSON.parse(xhr.responseText);
      if (parsed && typeof parsed === 'object') {
        Object.assign(cache, parsed);
        syncLoaded = true;
      }
    } else {
      console.warn('[neon] bulk load HTTP ' + xhr.status + ' — retrying async');
    }
  } catch (e) {
    console.warn('[neon] sync load failed, retrying async:', e.message);
  }

  if (syncLoaded) {
    _resolveReady();
  } else {
    // Async fallback for network blips / cold starts
    var fallback = new XMLHttpRequest();
    fallback.open('GET', API, true);
    fallback.timeout = 15000;
    fallback.onload = function () {
      if (fallback.status >= 200 && fallback.status < 300) {
        try {
          var d = JSON.parse(fallback.responseText);
          if (d && typeof d === 'object') Object.assign(cache, d);
        } catch (e) {}
      }
      _resolveReady();
    };
    fallback.onerror   = function () { _resolveReady(); };
    fallback.ontimeout = function () { _resolveReady(); };
    fallback.send();
  }

  // ── 2. Async write with timeout + retry ───────────────────────────────────
  function fetchWithTimeout(url, opts, ms) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (controller) {
      opts.signal = controller.signal;
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
      var go = function () {
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
      return attempt === 1 ? go() : new Promise(function (res) {
        setTimeout(res, delays[attempt - 1] || 2000);
      }).then(go);
    }

    return run().catch(function (err) {
      console.error('[neon] ' + method + ' "' + key + '" failed after ' + attempt + ' attempt(s):', err.message);
      throw err;
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.neonStorage = {
    /** Synchronous cache read. Returns null if key not found. */
    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    },

    /** Write value. Updates cache immediately; persists async. Returns Promise. */
    setItem: function (key, value) {
      cache[key] = String(value);
      return asyncWrite('PUT', key, value);
    },

    /** Delete key. Updates cache immediately; deletes async. Returns Promise. */
    removeItem: function (key) {
      delete cache[key];
      return asyncWrite('DELETE', key);
    },

    /** Resolves when the initial bulk load is complete. */
    ready: function () {
      if (_ready) return Promise.resolve(cache);
      return new Promise(function (res) {
        _readyCbs.push(function (c) { res(c); });
      });
    },

    /** Force a full async refresh (used by dashboard live stats). */
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
})();
