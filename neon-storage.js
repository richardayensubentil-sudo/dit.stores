(function () {
  const API_ROOT = '/api/storage';

  // In-memory cache, populated synchronously on page load
  const values = Object.create(null);
  let loadError = null;

  // Synchronous initial fetch — populates the cache before any page script runs
  try {
    const req = new XMLHttpRequest();
    req.open('GET', API_ROOT, false); // false = synchronous
    req.send();
    if (req.status >= 200 && req.status < 300) {
      Object.assign(values, JSON.parse(req.responseText || '{}'));
    } else {
      throw new Error('HTTP ' + req.status + ' from /api/storage');
    }
  } catch (err) {
    loadError = err;
    console.warn('[neon-storage] Initial load failed — will retry on first use:', err.message);
  }

  // Async helper for writes
  function xhrAsync(method, url, body) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);
        else reject(new Error('HTTP ' + xhr.status + ' — ' + xhr.responseText.slice(0, 200)));
      };
      xhr.onerror   = function () { reject(new Error('Network error')); };
      xhr.ontimeout = function () { reject(new Error('Request timed out')); };
      xhr.timeout   = 15000;
      xhr.send(body !== undefined ? JSON.stringify(body) : null);
    });
  }

  // Reload the full cache from the server (used as a fallback)
  function reload() {
    return xhrAsync('GET', API_ROOT).then(function (xhr) {
      const fresh = JSON.parse(xhr.responseText || '{}');
      // Merge fresh data into cache
      Object.keys(fresh).forEach(function (k) { values[k] = fresh[k]; });
      loadError = null; // clear the error — connection is working now
    });
  }

  window.neonStorage = {
    // Returns cached value — if initial load failed, reloads first then returns
    getItem: function (key) {
      if (!loadError) {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      }
      // Initial load failed — reload and return value after
      // (callers that need async should use getItemAsync)
      throw loadError;
    },

    // Async version — safe to use when initial load may have failed
    getItemAsync: function (key) {
      if (!loadError) {
        return Promise.resolve(
          Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null
        );
      }
      return reload().then(function () {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      });
    },

    setItem: function (key, value) {
      const serialized = String(value);
      return xhrAsync('PUT', API_ROOT + '/' + encodeURIComponent(key), { value: serialized })
        .then(function () { values[key] = serialized; });
    },

    removeItem: function (key) {
      return xhrAsync('DELETE', API_ROOT + '/' + encodeURIComponent(key))
        .then(function () { delete values[key]; });
    },

    // Expose reload so pages can prefetch after a failed initial load
    reload: reload,
  };
})();
