/**
 * api/storage.js — Neon serverless key-value store
 *
 * Architecture for multi-user production use:
 * - Uses @neondatabase/serverless which handles HTTP-based connection pooling
 * - Each request gets a lightweight HTTP connection (no TCP overhead)
 * - The neon() client is reused across warm Lambda invocations
 * - Table creation is cached after first run (_tableReady flag)
 * - Proper error messages for common failure modes
 */
const { neon } = require('@neondatabase/serverless');

// ── Boot-time check ───────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('[storage] FATAL: DATABASE_URL not set in environment');
}

// ── Connection — reused across warm invocations (serverless pooling) ──────────
let _sql = null;
function getSql() {
  if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL is not configured. Set it in Vercel environment variables.');
  // Lazy init — reused across warm Lambda calls for connection efficiency
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// ── Table bootstrap — runs once per cold start ────────────────────────────────
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
  // Index for fast ordered bulk reads
  await sql`
    CREATE INDEX IF NOT EXISTS app_storage_updated_idx ON app_storage (updated_at DESC)
  `;
  _tableReady = true;
}

// ── Response helpers ──────────────────────────────────────────────────────────
function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
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

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS — allow all origins for the client-side fetch calls
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Ensure table exists
  try {
    await ensureTable();
  } catch (err) {
    _tableReady = false; // retry on next request
    _sql = null;         // force reconnect on auth/connection errors
    console.error('[storage] ensureTable failed:', err.message);
    const msg = err.message || '';
    return json(res, 503, {
      error: msg.includes('DATABASE_URL') ? msg : 'Database unavailable: ' + msg.slice(0, 150)
    });
  }

  const sql = getSql();
  const key = getKey(req);

  try {
    // ── GET /api/storage — bulk load all keys (page init) ────────────────────
    if (req.method === 'GET' && key === null) {
      const rows = await sql`
        SELECT storage_key, storage_value
        FROM app_storage
        ORDER BY updated_at DESC
      `;
      const out = Object.create(null);
      for (const r of rows) out[r.storage_key] = r.storage_value;
      return json(res, 200, out);
    }

    if (!key) return json(res, 400, { error: 'Key required: /api/storage/<key>' });

    // ── GET /api/storage/<key> ───────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT storage_value FROM app_storage WHERE storage_key = ${key}
      `;
      return json(res, 200, { value: rows[0] ? rows[0].storage_value : null });
    }

    // ── PUT /api/storage/<key> ───────────────────────────────────────────────
    if (req.method === 'PUT') {
      let value;
      if (req.body && typeof req.body === 'object' && typeof req.body.value === 'string') {
        value = req.body.value;
      } else if (typeof req.body === 'string') {
        try { const p = JSON.parse(req.body); value = typeof p.value === 'string' ? p.value : req.body; }
        catch { value = req.body; }
      } else {
        return json(res, 400, { error: 'Body must be { "value": "..." }' });
      }

      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > 8 * 1024 * 1024) {
        return json(res, 413, {
          error: `Value too large (${(bytes/1024/1024).toFixed(2)} MB). Delete old records to free space.`
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

    // ── DELETE /api/storage/<key> ────────────────────────────────────────────
    if (req.method === 'DELETE') {
      await sql`DELETE FROM app_storage WHERE storage_key = ${key}`;
      return res.status(204).end();
    }

    return json(res, 405, { error: 'Method not allowed' });

  } catch (err) {
    console.error(`[storage] ${req.method} ${req.url}:`, err.message || err);
    const msg = err.message || String(err);

    if (msg.includes('54000') || msg.includes('value too long')) {
      return json(res, 413, { error: 'Value too large for the database column.' });
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('connect ETIMEOUT')) {
      _sql = null; // force reconnect
      return json(res, 503, { error: 'Database connection failed. Please try again in a moment.' });
    }
    if (msg.includes('password authentication') || msg.includes('authentication failed')) {
      _sql = null;
      return json(res, 503, { error: 'Database authentication failed. Contact the system administrator.' });
    }
    return json(res, 500, { error: 'Storage error: ' + msg.slice(0, 200) });
  }
};
