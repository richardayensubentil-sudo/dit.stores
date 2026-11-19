/**
 * neon-storage.js — Client-side storage layer
 *
 * Architecture:
 * 1. Synchronous XHR bulk load on script init — data in cache before page renders
 * 2. Async writes (fetch) — non-blocking, don't freeze the UI
 * 3. ready() promise — pages can await data availability
 * 4. NEVER saves empty data on init — prevents wiping Neon accidentally
 * 5. 10 second timeout on all writes — no silent hangs
 * 6. 3 retry attempts on 5xx errors, exponential back-off
 */
(function () {
  var API = '/api/storage';
  var WRITE_TIMEOUT_MS = 10000; // 10 s — abort slow/hung writes
  var cache = Object.create(null);

  // Read the auth token from a <meta name="storage-token" content="..."> in <head>
  // This avoids hard-coding the secret in JS while keeping zero build tooling.
  var _token = (function() {
    try {
      var m = document.querySelector('meta[name="storage-token"]');
      return m ? m.getAttribute('content') : '';
    } catch(e) { return ''; }
  })();
  var _ready = false;
  var _readyCbs = [];

  function _resolveReady() {
    _ready = true;
    var cbs = _readyCbs.slice();
    _readyCbs = [];
    cbs.forEach(function(cb) { try { cb(cache); } catch(e) {} });
  }

  // ── 1. Synchronous bulk load — data ready before page script runs ────────────
  // Intentional: prevents race condition where pages save empty data before the
  // async load completes, which would wipe all Neon data.
  var syncLoaded = false;
  try {
    var req = new XMLHttpRequest();
    req.open('GET', API, false); // synchronous
    req.timeout = 8000;          // 8 s hard limit on the blocking XHR
    if (_token) req.setRequestHeader('X-Storage-Token', _token);
    req.send();
    if (req.status >= 200 && req.status < 300) {
      var parsed = JSON.parse(req.responseText);
      if (parsed && typeof parsed === 'object') {
        Object.assign(cache, parsed);
        syncLoaded = true;
      }
    } else {
      console.warn('[neon] bulk load HTTP ' + req.status + ' — will retry async');
    }
  } catch(e) {
    console.warn('[neon] sync load failed, trying async:', e.message);
  }

  if (syncLoaded) {
    _resolveReady();
  } else {
    // Async fallback if sync failed (network blip or cold start)
    var retryReq = new XMLHttpRequest();
    retryReq.open('GET', API, true); // async
    retryReq.timeout = 15000;
    if (_token) retryReq.setRequestHeader('X-Storage-Token', _token);
    retryReq.onload = function() {
      if (retryReq.status >= 200 && retryReq.status < 300) {
        try {
          var d = JSON.parse(retryReq.responseText);
          if (d && typeof d === 'object') Object.assign(cache, d);
        } catch(e) {}
      }
      _resolveReady();
    };
    retryReq.onerror = function() { _resolveReady(); };
    retryReq.ontimeout = function() { _resolveReady(); };
    retryReq.send();
  }

  // ── 2. Async write with timeout + exponential-backoff retry ─────────────────
  function fetchWithTimeout(url, opts, timeoutMs) {
    return new Promise(function(resolve, reject) {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = null;
      if (controller) {
        opts.signal = controller.signal;
        timer = setTimeout(function() {
          controller.abort();
          reject(new Error('Request timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
      }
      fetch(url, opts).then(function(r) {
        if (timer) clearTimeout(timer);
        resolve(r);
      }).catch(function(err) {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }

  function asyncWrite(method, key, value) {
    var headers = { 'Content-Type': 'application/json' };
    if (_token) headers['X-Storage-Token'] = _token;
    var opts = { method: method, headers: headers };
    if (value !== undefined) opts.body = JSON.stringify({ value: String(value) });
    var url = API + '/' + encodeURIComponent(key);

    var attempt = 0;
    var delays = [0, 500, 1500]; // immediate, then 0.5 s, then 1.5 s

    function run() {
      attempt++;
      var delay = delays[attempt - 1] || 2000;
      var doFetch = function() {
        return fetchWithTimeout(url, opts, WRITE_TIMEOUT_MS).then(function(r) {
          if (!r.ok && r.status !== 204) {
            if (r.status >= 500 && attempt < 3) {
              return new Promise(function(res) { setTimeout(res, delays[attempt] || 2000); }).then(run);
            }
            return r.text().then(function(t) {
              var msg = 'HTTP ' + r.status;
              try { msg = JSON.parse(t).error || msg; } catch(e) {}
              throw new Error(msg);
            });
          }
        });
      };

      if (attempt === 1) return doFetch();
      return new Promise(function(res) { setTimeout(res, delay); }).then(doFetch);
    }

    return run().catch(function(err) {
      console.error('[neon] ' + method + ' "' + key + '" failed after ' + attempt + ' attempts:', err.message);
      throw err;
    });
  }

  window.neonStorage = {
    /**
     * Read from cache synchronously.
     * Returns null if key not found.
     */
    getItem: function(key) {
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    },

    /**
     * Write value. Updates cache immediately, persists async.
     * Returns a Promise.
     */
    setItem: function(key, value) {
      cache[key] = String(value);
      return asyncWrite('PUT', key, value);
    },

    /**
     * Delete key. Updates cache immediately, deletes async.
     * Returns a Promise.
     */
    removeItem: function(key) {
      delete cache[key];
      return asyncWrite('DELETE', key);
    },

    /**
     * Resolves when initial data load is complete.
     * Use in page init: window.neonStorage.ready().then(() => { ... })
     */
    ready: function() {
      if (_ready) return Promise.resolve(cache);
      return new Promise(function(res) {
        _readyCbs.push(function(c) { res(c); });
      });
    },

    /**
     * Force full async refresh (e.g. for dashboard live stats).
     */
    refresh: function() {
      var headers = _token ? { 'X-Storage-Token': _token } : {};
      return fetchWithTimeout(API, { headers: headers }, 15000)
        .then(function(r) { return r.ok ? r.json() : Promise.reject('HTTP ' + r.status); })
        .then(function(d) {
          if (d && typeof d === 'object') {
            Object.keys(cache).forEach(function(k) { delete cache[k]; });
            Object.assign(cache, d);
          }
          return d;
        });
    },

    get isLoaded() { return _ready; },
    get _cache() { return cache; }
  };
})();
