/**
 * neon-storage.js
 * 
 * SAFE HYBRID APPROACH:
 * 1. Tries synchronous XHR first (instant data, prevents empty overwrites)
 * 2. If sync fails (timeout/network), falls back to async load
 * 3. setItem/removeItem are async (non-blocking writes)
 * 4. ready() always resolves — pages can await it for guaranteed data
 * 
 * This prevents the critical bug where async-only loading causes pages
 * to initialize with empty data and overwrite real data in Neon.
 */
(function () {
  var API = '/api/storage';
  var cache = Object.create(null);
  var _ready = false;
  var _readyCbs = [];

  function _resolveReady() {
    _ready = true;
    _readyCbs.forEach(function(cb) { try { cb(); } catch(e) {} });
    _readyCbs = [];
  }

  // ── 1. Try synchronous XHR (fast path — page renders with data immediately) ─
  var syncOk = false;
  try {
    var syncReq = new XMLHttpRequest();
    syncReq.open('GET', API, false); // synchronous
    syncReq.send();
    if (syncReq.status >= 200 && syncReq.status < 300) {
      var parsed = JSON.parse(syncReq.responseText);
      Object.assign(cache, parsed);
      syncOk = true;
      _resolveReady();
    }
  } catch(e) {
    // Sync failed — will use async fallback below
    console.warn('[neon] sync load failed, using async:', e.message);
  }

  // ── 2. Async fallback (if sync failed) ──────────────────────────────────────
  if (!syncOk) {
    fetch(API)
      .then(function(r) { return r.ok ? r.json() : Promise.reject('HTTP ' + r.status); })
      .then(function(data) {
        Object.assign(cache, data);
        _resolveReady();
      })
      .catch(function(e) {
        console.warn('[neon] async load also failed:', e);
        _resolveReady(); // resolve anyway so pages don't hang
      });
  }

  // ── 3. Async write (fire-and-forget, non-blocking) ───────────────────────────
  function asyncPut(key, value) {
    var body = JSON.stringify({ value: String(value) });
    return fetch(API + '/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).catch(function(e) {
      console.error('[neon] PUT "' + key + '" failed:', e.message);
      throw e;
    });
  }

  function asyncDelete(key) {
    return fetch(API + '/' + encodeURIComponent(key), { method: 'DELETE' })
      .catch(function(e) {
        console.error('[neon] DELETE "' + key + '" failed:', e.message);
        throw e;
      });
  }

  window.neonStorage = {
    /**
     * Read from cache. Returns null if not loaded yet.
     * When sync load succeeds (normal case), data is always available immediately.
     */
    getItem: function(key) {
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    },

    /**
     * Write value. Updates cache immediately, persists async (non-blocking).
     */
    setItem: function(key, value) {
      cache[key] = String(value);
      return asyncPut(key, value);
    },

    /**
     * Delete key. Updates cache immediately, deletes async.
     */
    removeItem: function(key) {
      delete cache[key];
      return asyncDelete(key);
    },

    /**
     * Returns a Promise that resolves when data is loaded.
     * Resolves immediately if sync load already succeeded.
     */
    ready: function() {
      if (_ready) return Promise.resolve(cache);
      return new Promise(function(res) { _readyCbs.push(function() { res(cache); }); });
    },

    /**
     * Async full refresh (for dashboard live stats, etc.)
     */
    refresh: function() {
      return fetch(API)
        .then(function(r) { return r.ok ? r.json() : Promise.reject('HTTP ' + r.status); })
        .then(function(data) {
          Object.keys(cache).forEach(function(k) { delete cache[k]; });
          Object.assign(cache, data);
          return data;
        });
    },

    get isLoaded() { return _ready; },
    get _cache()   { return cache; }
  };
})();
