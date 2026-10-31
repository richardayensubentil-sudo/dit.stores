(function () {
  const API_ROOT = '/api/storage';
  const values   = Object.create(null);
  let loadError  = null;
  let _bulkDone  = false;

  // ── Async bulk load (non-blocking) — runs in background ─────────────────────
  // Does NOT block the page. Items populate the cache as they arrive.
  (function asyncBulkLoad() {
    try {
      const req = new XMLHttpRequest();
      req.open('GET', API_ROOT, true); // ASYNC — does not block
      req.onload = function () {
        if (req.status >= 200 && req.status < 300) {
          try {
            Object.assign(values, JSON.parse(req.responseText));
            _bulkDone = true;
          } catch (e) { loadError = e; }
        } else {
          loadError = new Error('HTTP ' + req.status);
        }
      };
      req.onerror = function () { loadError = new Error('Network error'); };
      req.send();
    } catch (err) {
      loadError = err;
    }
  })();

  // ── Sync single-key fetch (only used as fallback if cache is empty) ────────
  // This is fast because it fetches ONE small key, not ALL keys.
  function syncGetKey(key) {
    try {
      const req = new XMLHttpRequest();
      req.open('GET', API_ROOT + '/' + encodeURIComponent(key), false);
      req.send();
      if (req.status >= 200 && req.status < 300) {
        const v = JSON.parse(req.responseText || '{}').value;
        if (v != null) values[key] = v;
        return v != null ? v : null;
      }
    } catch (e) { /* fall through to null */ }
    return null;
  }

  // ── Sync write helper (2 attempts) ──────────────────────────────────────────
  function syncRpc(method, url, body) {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const r = new XMLHttpRequest();
        r.open(method, url, false);
        if (body !== undefined) r.setRequestHeader('Content-Type', 'application/json');
        r.send(body !== undefined ? body : null);
        if (r.status >= 200 && r.status < 300) return r;
        if (r.status === 413) throw new Error('Payload too large (HTTP 413) — delete old records.');
        if (r.status >= 500 && i === 0) continue;
        throw new Error('HTTP ' + r.status + ': ' + (r.responseText || '').slice(0, 200));
      } catch (e) {
        last = e;
        if (e.message && e.message.startsWith('Payload too large')) throw e;
        if (i === 0) continue;
      }
    }
    throw last || new Error('RPC failed');
  }

  window.neonStorage = {

    /**
     * Read a value.
     * 1. Check in-memory cache (instant — the common path after async load completes)
     * 2. If not in cache, do a quick sync fetch for this ONE key only
     */
    getItem(key) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        return values[key];
      }
      // Cache miss — fetch this one key (fast, small payload)
      return syncGetKey(key);
    },

    /**
     * Persist a value to Neon and update the cache.
     */
    setItem(key, value) {
      const serialized = String(value);
      const body = JSON.stringify({ value: serialized });
      const kb = body.length / 1024;
      if (kb > 3000) console.warn('[neon] large write "' + key + '" ' + (kb / 1024).toFixed(1) + ' MB');
      syncRpc('PUT', API_ROOT + '/' + encodeURIComponent(key), body);
      values[key] = serialized;
    },

    /**
     * Delete a key from Neon and the cache.
     */
    removeItem(key) {
      syncRpc('DELETE', API_ROOT + '/' + encodeURIComponent(key));
      delete values[key];
    },

    /**
     * Async refresh — replaces entire cache with fresh data from Neon.
     * Non-blocking. Call after DOMContentLoaded for live stats.
     */
    refresh() {
      return new Promise((resolve, reject) => {
        const r = new XMLHttpRequest();
        r.open('GET', API_ROOT, true);
        r.onload = () => {
          if (r.status >= 200 && r.status < 300) {
            try {
              const fresh = JSON.parse(r.responseText);
              Object.keys(values).forEach(k => delete values[k]);
              Object.assign(values, fresh);
              loadError = null;
              _bulkDone = true;
              resolve(fresh);
            } catch (e) { reject(e); }
          } else { reject(new Error('HTTP ' + r.status)); }
        };
        r.onerror = () => reject(new Error('Network error'));
        r.send();
      });
    },

    get isLoaded()  { return _bulkDone; },
    get _cache()    { return values; }
  };
})();
