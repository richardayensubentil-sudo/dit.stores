(function () {
  // All application data is persisted by the server API in Neon Postgres.
  // The values object is only a per-page cache and is never used as storage.
  const API_ROOT = '/api/storage';
  const values = Object.create(null);
  let loadError = null;

  try {
    const request = new XMLHttpRequest();
    request.open('GET', API_ROOT, false);
    request.send();
    if (request.status >= 200 && request.status < 300) {
      Object.assign(values, JSON.parse(request.responseText));
    } else {
      throw new Error('Neon returned HTTP ' + request.status);
    }
  } catch (error) {
    loadError = error;
    console.error('Could not load data from Neon:', error);
  }

  window.neonStorage = {
    getItem(key) {
      if (loadError) throw loadError;
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    setItem(key, value) {
      if (loadError) throw loadError;
      const serialized = String(value);
      const request = new XMLHttpRequest();
      request.open('PUT', API_ROOT + '/' + encodeURIComponent(key), false);
      request.setRequestHeader('Content-Type', 'application/json');
      try {
        request.send(JSON.stringify({ value: serialized }));
        if (request.status < 200 || request.status >= 300) {
          throw new Error('Neon returned HTTP ' + request.status);
        }
        values[key] = serialized;
      } catch (error) {
        console.error('Could not save data to Neon:', error);
        throw error;
      }
    },
    removeItem(key) {
      if (loadError) throw loadError;
      const request = new XMLHttpRequest();
      request.open('DELETE', API_ROOT + '/' + encodeURIComponent(key), false);
      try {
        request.send();
        if (request.status < 200 || request.status >= 300) {
          throw new Error('Neon returned HTTP ' + request.status);
        }
        delete values[key];
      } catch (error) {
        console.error('Could not delete data from Neon:', error);
        throw error;
      }
    }
  };
})(); 