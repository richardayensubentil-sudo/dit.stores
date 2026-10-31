const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  console.error('[storage] FATAL: DATABASE_URL not set');
}

let _sql = null;
function getSql() {
  if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL is not set. Add it to Vercel environment variables.');
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// Table ready state — persists across warm invocations in same Lambda instance
let _tableReady = false;

async function ensureTable() {
  if (_tableReady) return;
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS app_storage (
      storage_key   TEXT PRIMARY KEY,
      storage_value TEXT NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Also ensure an index on updated_at for fast ordered reads
  await sql`
    CREATE INDEX IF NOT EXISTS app_storage_updated_at_idx ON app_storage (updated_at DESC)
  `;
  _tableReady = true;
}

function sendJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(body));
}

function getKey(req) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const prefix = '/api/storage/';
  if (url.pathname.startsWith(prefix)) {
    const raw = url.pathname.slice(prefix.length);
    return raw ? decodeURIComponent(raw) : null;
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await ensureTable();
  } catch (err) {
    _tableReady = false; // retry next request
    _sql = null;         // force reconnect
    console.error('[storage] ensureTable failed:', err.message);
    const msg = err.message || '';
    return sendJson(res, 503, {
      error: msg.includes('DATABASE_URL') ? msg : 'Database unavailable: ' + msg.slice(0, 150)
    });
  }

  const sql = getSql();
  const key = getKey(req);

  try {
    // GET /api/storage — return ALL keys (bulk load on page init)
    if (req.method === 'GET' && key === null) {
      const rows = await sql`
        SELECT storage_key, storage_value
        FROM app_storage
        ORDER BY updated_at DESC
      `;
      const out = Object.create(null);
      for (const r of rows) out[r.storage_key] = r.storage_value;
      return sendJson(res, 200, out);
    }

    if (!key) return sendJson(res, 400, { error: 'Key required: /api/storage/<key>' });

    // GET /api/storage/<key>
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT storage_value FROM app_storage WHERE storage_key = ${key}
      `;
      return sendJson(res, 200, { value: rows[0] ? rows[0].storage_value : null });
    }

    // PUT /api/storage/<key>
    if (req.method === 'PUT') {
      let value;
      if (req.body && typeof req.body === 'object' && typeof req.body.value === 'string') {
        value = req.body.value;
      } else if (typeof req.body === 'string') {
        try { const p = JSON.parse(req.body); value = typeof p.value === 'string' ? p.value : req.body; }
        catch { value = req.body; }
      } else {
        return sendJson(res, 400, { error: '"value" must be a string: { "value": "..." }' });
      }

      const byteLen = Buffer.byteLength(value, 'utf8');
      if (byteLen > 8 * 1024 * 1024) {
        return sendJson(res, 413, {
          error: `Value too large (${(byteLen/1024/1024).toFixed(2)} MB). Delete old records to reduce size.`
        });
      }

      await sql`
        INSERT INTO app_storage (storage_key, storage_value, updated_at)
        VALUES (${key}, ${value}, NOW())
        ON CONFLICT (storage_key) DO UPDATE
          SET storage_value = EXCLUDED.storage_value,
              updated_at    = NOW()
      `;
      return res.status(204).end();
    }

    // DELETE /api/storage/<key>
    if (req.method === 'DELETE') {
      await sql`DELETE FROM app_storage WHERE storage_key = ${key}`;
      return res.status(204).end();
    }

    return sendJson(res, 405, { error: 'Method not allowed' });

  } catch (err) {
    console.error(`[storage] ${req.method} ${req.url}:`, err.message || err);
    const msg = err.message || String(err);

    if (msg.includes('54000') || msg.includes('value too long')) {
      return sendJson(res, 413, { error: 'Value too large for database.' });
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('connect')) {
      _sql = null; // force reconnect next request
      return sendJson(res, 503, { error: 'Database connection failed. Try again.' });
    }
    if (msg.includes('password authentication')) {
      _sql = null;
      return sendJson(res, 503, { error: 'Database authentication failed. Check DATABASE_URL.' });
    }
    return sendJson(res, 500, { error: 'Storage error: ' + msg.slice(0, 200) });
  }
};
