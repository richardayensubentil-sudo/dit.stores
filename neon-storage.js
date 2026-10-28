(function () {
  const API_ROOT = '/api/storage';
  const values   = Object.create(null);
  let loadError  = null;
  let _loadDone  = false;  // true once initial fetch completes

  // ── Fast sync XHR with short timeout — doesn't block more than 5s ──────────
  try {
    const req = new XMLHttpRequest();
    req.open('GET', API_ROOT, false);  // synchronous
    // Note: timeout on sync XHR is not honoured in all browsers,
    // but the server has its own 15s limit via Vercel's maxDuration.
    req.send();
    if (req.status >= 200 && req.status < 300) {
      Object.assign(values, JSON.parse(req.responseText));
      _loadDone = true;
    } else {
      console.warn('[neon] initial load HTTP ' + req.status);
    }
  } catch (err) {
    loadError = err;
    console.warn('[neon] preload failed, reads will fall back to live fetch:', err.message || err);
  }

  // ── Sync PUT/DELETE helper (2 attempts max) ─────────────────────────────────
  function syncRpc(method, url, body) {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const r = new XMLHttpRequest();
        r.open(method, url, false);
        if (body !== undefined) r.setRequestHeader('Content-Type', 'application/json');
        r.send(body !== undefined ? body : null);
        if (r.status >= 200 && r.status < 300) return r;
        if (r.status === 413) throw new Error('Payload too large (HTTP 413) — delete old records to free space.');
        if (r.status >= 500 && i === 0) continue; // retry once on 5xx
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

    getItem(key) {
      if (loadError) {
        // Initial load failed — do a live single-key fetch
        try {
          const r = syncRpc('GET', API_ROOT + '/' + encodeURIComponent(key));
          const v = JSON.parse(r.responseText || '{}').value;
          if (v != null) values[key] = v;
          return v != null ? v : null;
        } catch (e) {
          console.error('[neon] getItem fallback failed:', e.message);
          return null;
        }
      }
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },

    setItem(key, value) {
      const serialized = String(value);
      const body       = JSON.stringify({ value: serialized });
      const kb = body.length / 1024;
      if (kb > 3000) console.warn('[neon] large write "' + key + '" ' + (kb/1024).toFixed(1) + ' MB');
      syncRpc('PUT', API_ROOT + '/' + encodeURIComponent(key), body);
      values[key] = serialized;
    },

    removeItem(key) {
      syncRpc('DELETE', API_ROOT + '/' + encodeURIComponent(key));
      delete values[key];
    },

    // Async refresh — call after DOMContentLoaded to get latest data
    refresh() {
      return new Promise((resolve, reject) => {
        const r = new XMLHttpRequest();
        r.open('GET', API_ROOT, true); // async — doesn't block
        r.onload = () => {
          if (r.status >= 200 && r.status < 300) {
            try {
              const fresh = JSON.parse(r.responseText);
              Object.keys(values).forEach(k => delete values[k]);
              Object.assign(values, fresh);
              loadError = null;
              _loadDone = true;
              resolve(fresh);
            } catch (e) { reject(e); }
          } else { reject(new Error('HTTP ' + r.status)); }
        };
        r.onerror = () => reject(new Error('Network error'));
        r.send();
      });
    },

    get isLoaded()  { return _loadDone; },
    get _cache()    { return values; }
  };

})();
