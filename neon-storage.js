(function () {
  const API_ROOT = '/api/storage';

  // In-memory cache — populated on page load, kept in sync on every write
  const values = Object.create(null);
  let loadError = null;
  let loadPromise = null;

  // ── Initial fetch (async, not synchronous) ─────────────────────────────────
  // Using async fetch avoids the browser warning about synchronous XHR and
  // is more reliable on Vercel cold starts (no timeout ceiling).
  loadPromise = fetch(API_ROOT)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from /api/storage');
      return r.json();
    })
    .then(function (data) {
      Object.assign(values, data);
      loadError = null;
    })
    .catch(function (err) {
      loadError = err;
      console.warn('[neon-storage] Initial load failed:', err.message);
    });

  // ── HTTP helpers ───────────────────────────────────────────────────────────
  function apiFetch(method, url, body) {
    var opts = {
      method: method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body:    body !== undefined ? JSON.stringify(body) : undefined,
    };
    return fetch(url, opts).then(function (r) {
      if (!r.ok) return r.text().then(function (t) {
        throw new Error('HTTP ' + r.status + ' — ' + t.slice(0, 200));
      });
      return r;
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.neonStorage = {

    // Wait for the initial load before doing anything.
    // All pages should call this once before reading data.
    ready: function () { return loadPromise; },

    // Synchronous read from cache.
    // Returns null if key not found or if initial load failed.
    getItem: function (key) {
      if (loadError) return null; // graceful: don't throw, let callers handle
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },

    // Async read — waits for initial load if not done yet.
    getItemAsync: function (key) {
      return loadPromise.then(function () {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      });
    },

    // Write to Neon AND update local cache immediately.
    // Returns a Promise — callers should await or .then() it for reliability.
    setItem: function (key, value) {
      var serialized = String(value);
      // Update cache immediately so subsequent getItem calls see the new value
      values[key] = serialized;
      return apiFetch('PUT', API_ROOT + '/' + encodeURIComponent(key), { value: serialized })
        .catch(function (err) {
          console.error('[neon-storage] setItem failed for "' + key + '":', err.message);
          throw err;
        });
    },

    // Delete from Neon and remove from local cache.
    // Returns a Promise.
    removeItem: function (key) {
      delete values[key];
      return apiFetch('DELETE', API_ROOT + '/' + encodeURIComponent(key))
        .catch(function (err) {
          console.error('[neon-storage] removeItem failed for "' + key + '":', err.message);
          throw err;
        });
    },

    // Force reload the full cache from the server.
    reload: function () {
      loadPromise = apiFetch('GET', API_ROOT)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          // Clear and repopulate
          Object.keys(values).forEach(function (k) { delete values[k]; });
          Object.assign(values, data);
          loadError = null;
        })
        .catch(function (err) {
          loadError = err;
          console.warn('[neon-storage] reload failed:', err.message);
        });
      return loadPromise;
    },
  };
})();
