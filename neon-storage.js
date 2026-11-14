/**
 * neon-storage.js — Client-side storage layer
 *
 * Architecture:
 * 1. Synchronous XHR bulk load on script init — data in cache before page renders
 * 2. Async writes (fetch) — non-blocking, don't freeze the UI
 * 3. ready() promise — pages can await data availability
 * 4. NEVER saves empty data on init — prevents wiping Neon accidentally
 */
(function () {
  var API = '/api/storage';
  var cache = Object.create(null);
  var _ready = false;
  var _readyCbs = [];

  function _resolveReady() {
    _ready = true;
    var cbs = _readyCbs.slice();
    _readyCbs = [];
    cbs.forEach(function(cb) { try { cb(cache); } catch(e) {} });
  }

  // ── 1. Synchronous bulk load — data ready before page script runs ────────────
  // This is intentional: prevents race condition where pages save empty data
  // before the async load completes (which would wipe Neon data).
  var syncLoaded = false;
  try {
    var req = new XMLHttpRequest();
    req.open('GET', API, false); // synchronous
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
    // Async fallback if sync failed (e.g. network blip on cold start)
    var retryReq = new XMLHttpRequest();
    retryReq.open('GET', API, true); // async
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
    retryReq.send();
  }

  // ── 2. Async write with retry ────────────────────────────────────────────────
  function asyncWrite(method, key, value) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (value !== undefined) opts.body = JSON.stringify({ value: String(value) });
    var url = API + '/' + encodeURIComponent(key);

    var attempt = 0;
    function run() {
      attempt++;
      return fetch(url, opts).then(function(r) {
        if (!r.ok && r.status !== 204) {
          if (r.status >= 500 && attempt < 2) return new Promise(function(res){ setTimeout(res, 300); }).then(run);
          return r.text().then(function(t) {
            var msg = 'HTTP ' + r.status;
            try { msg = JSON.parse(t).error || msg; } catch(e) {}
            throw new Error(msg);
          });
        }
      }).catch(function(err) {
        if (attempt < 2 && err.message !== 'Failed to fetch') {
          return new Promise(function(res){ setTimeout(res, 500); }).then(run);
        }
        console.error('[neon] ' + method + ' "' + key + '" failed:', err.message);
        throw err;
      });
    }
    return run();
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
      return fetch(API)
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
