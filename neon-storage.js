(function () {
  // All application data is persisted by the server API in Neon Postgres.
  // The values object is a per-page in-memory cache populated on load.
  const API_ROOT = '/api/storage';
  const values = Object.create(null);
  let loadError = null;

  // ── Initial bulk load (synchronous so page scripts can read immediately) ──
  try {
    const request = new XMLHttpRequest();
    request.open('GET', API_ROOT, false); // synchronous
    request.send();
    if (request.status >= 200 && request.status < 300) {
      Object.assign(values, JSON.parse(request.responseText));
    } else {
      // Non-fatal: page can still work, writes will go direct to Neon
      console.warn('neon-storage: initial load returned HTTP ' + request.status + ' — running without cache');
    }
  } catch (error) {
    loadError = error;
    console.warn('neon-storage: could not preload from Neon:', error.message || error);
  }

  // ── Helper: synchronous XHR with retries ──
  function syncRequest(method, url, body) {
    const MAX_TRIES = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        const req = new XMLHttpRequest();
        req.open(method, url, false);
        if (body !== undefined) req.setRequestHeader('Content-Type', 'application/json');
        req.send(body !== undefined ? body : null);
        if (req.status >= 200 && req.status < 300) return req;
        // 413 = payload too large — no point retrying
        if (req.status === 413) {
          throw new Error('Payload too large (HTTP 413). The data blob exceeds the server limit. Try clearing old records.');
        }
        // 5xx — retry
        if (req.status >= 500 && attempt < MAX_TRIES) {
          console.warn('neon-storage: server error HTTP ' + req.status + ', retrying (' + attempt + '/' + MAX_TRIES + ')');
          continue;
        }
        throw new Error('HTTP ' + req.status + ': ' + (req.responseText || '').slice(0, 200));
      } catch (e) {
        lastErr = e;
        if (e.message && e.message.startsWith('Payload too large')) throw e;
        if (attempt < MAX_TRIES) continue;
      }
    }
    throw lastErr || new Error('Request failed after ' + MAX_TRIES + ' attempts');
  }

  window.neonStorage = {
    /**
     * Read a value from the in-memory cache (populated on page load).
     * Returns null if the key does not exist.
     */
    getItem(key) {
      // If initial load failed, attempt a live fetch for this key
      if (loadError) {
        try {
          const req = syncRequest('GET', API_ROOT + '/' + encodeURIComponent(key));
          const parsed = JSON.parse(req.responseText || '{}');
          const val = parsed.value !== undefined ? parsed.value : null;
          if (val !== null) values[key] = val;
          return val;
        } catch (e) {
          console.error('neon-storage: getItem live fetch failed:', e.message || e);
          return null;
        }
      }
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },

    /**
     * Persist a value to Neon and update the in-memory cache.
     * Throws on failure so callers can show an error to the user.
     */
    setItem(key, value) {
      const serialized = String(value);
      const body = JSON.stringify({ value: serialized });

      // Warn if payload is very large (> 3 MB) — Vercel limit is 4.5 MB
      const bytes = new Blob([body]).size;
      if (bytes > 3 * 1024 * 1024) {
        console.warn('neon-storage: setItem "' + key + '" payload is ' + (bytes / 1024 / 1024).toFixed(2) + ' MB — approaching server limit');
      }

      try {
        syncRequest('PUT', API_ROOT + '/' + encodeURIComponent(key), body);
        values[key] = serialized; // update cache only after confirmed write
      } catch (error) {
        console.error('neon-storage: setItem failed for key "' + key + '":', error.message || error);
        throw error;
      }
    },

    /**
     * Delete a key from Neon and remove it from the in-memory cache.
     * Throws on failure.
     */
    removeItem(key) {
      try {
        syncRequest('DELETE', API_ROOT + '/' + encodeURIComponent(key));
        delete values[key]; // update cache only after confirmed delete
      } catch (error) {
        console.error('neon-storage: removeItem failed for key "' + key + '":', error.message || error);
        throw error;
      }
    },

    /**
     * Force a fresh reload of all data from Neon into the cache.
     * Returns a Promise — call with await or .then().
     */
    refresh() {
      return new Promise(function (resolve, reject) {
        const req = new XMLHttpRequest();
        req.open('GET', API_ROOT, true); // async
        req.onload = function () {
          if (req.status >= 200 && req.status < 300) {
            try {
              const fresh = JSON.parse(req.responseText);
              // Clear stale cache and replace with fresh data
              Object.keys(values).forEach(function (k) { delete values[k]; });
              Object.assign(values, fresh);
              loadError = null;
              resolve(fresh);
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error('HTTP ' + req.status));
          }
        };
        req.onerror = function () { reject(new Error('Network error')); };
        req.send();
      });
    },

    /**
     * Expose raw cache for debugging (read-only reference).
     */
    get _cache() { return values; }
  };
})();
