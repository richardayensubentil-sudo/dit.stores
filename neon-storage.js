/**
 * neon-storage.js — Non-blocking Neon storage layer
 * 
 * DESIGN: Zero synchronous XHR. All reads go through an async cache.
 * Pages must call neonStorage.ready() which resolves when data is loaded.
 * Writes (setItem/removeItem) are fire-and-forget async with retry.
 */
(function () {
  const API = '/api/storage';
  const cache = Object.create(null);
  let _ready = false;
  let _readyResolvers = [];
  let _readyPromise = new Promise(r => _readyResolvers.push(r));

  // ── Async fetch with timeout ────────────────────────────────────────────────
  function fetchWithTimeout(url, opts, ms) {
    ms = ms || 8000;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), ms);
      fetch(url, opts).then(r => { clearTimeout(t); res(r); }).catch(e => { clearTimeout(t); rej(e); });
    });
  }

  // ── Initial bulk load (async — never blocks the page) ──────────────────────
  fetchWithTimeout(API, {}, 10000)
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(data => {
      Object.assign(cache, data);
      _ready = true;
      _readyResolvers.forEach(r => r(data));
      _readyResolvers = [];
    })
    .catch(err => {
      console.warn('[neon] bulk load failed:', err.message);
      // Still resolve so pages don't hang forever
      _ready = true;
      _readyResolvers.forEach(r => r({}));
      _readyResolvers = [];
    });

  // ── Async write with retry ──────────────────────────────────────────────────
  function asyncWrite(method, key, value) {
    const url = API + '/' + encodeURIComponent(key);
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (value !== undefined) opts.body = JSON.stringify({ value: String(value) });

    let attempts = 0;
    function attempt() {
      attempts++;
      return fetchWithTimeout(url, opts, 6000)
        .then(r => {
          if (!r.ok && r.status !== 204) {
            return r.text().then(t => { throw new Error('HTTP ' + r.status + ': ' + t.slice(0,100)); });
          }
          if (value !== undefined) cache[key] = String(value);
          else delete cache[key];
        })
        .catch(err => {
          if (attempts < 2) return new Promise(r => setTimeout(r, 500)).then(attempt);
          console.error('[neon] ' + method + ' "' + key + '" failed:', err.message);
          throw err;
        });
    }
    return attempt();
  }

  window.neonStorage = {
    /**
     * Get a value. Returns from cache synchronously if loaded,
     * otherwise returns null (use ready().then() to ensure data is available).
     */
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    },

    /**
     * Set a value. Async fire-and-forget — updates cache immediately,
     * persists to Neon in background. Throws on persistent failure.
     */
    setItem(key, value) {
      cache[key] = String(value); // update cache immediately
      return asyncWrite('PUT', key, value);
    },

    /**
     * Remove a value. Async.
     */
    removeItem(key) {
      delete cache[key];
      return asyncWrite('DELETE', key);
    },

    /**
     * Returns a Promise that resolves when the initial bulk load is done.
     * Call this before reading data at page init.
     */
    ready() { return _readyPromise; },

    /**
     * Force a full refresh from Neon.
     */
    refresh() {
      return fetchWithTimeout(API, {}, 10000)
        .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(data => {
          Object.keys(cache).forEach(k => delete cache[k]);
          Object.assign(cache, data);
          return data;
        });
    },

    get isLoaded() { return _ready; },
    get _cache()   { return cache; }
  };
})();
