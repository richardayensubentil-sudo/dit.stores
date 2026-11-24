/**
 * api/storage.js — Neon serverless key-value store
 *
 * Production-hardened for public use:
 * - Shadow backup: every PUT on critical keys also writes _bak_<key>
 *   so data survives accidental overwrites with empty values
 * - On bulk GET, if a critical key has 0-record data, transparently
 *   serves from the backup key so modules never see empty data
 * - HTTP-based Neon pooling (reused across warm Lambdas)
 * - 8 MB per-value hard limit
 * - Auto-reconnect on auth/connection errors
 */
const { neon } = require('@neondatabase/serverless');
const zlib = require('zlib');

if (!process.env.DATABASE_URL) {
  console.error('[storage] FATAL: DATABASE_URL not set');
}

// Keys that hold large arrays — wipe protection is critical for these
const PROTECTED_KEYS = new Set([
  'military_clothing_db_v6',
  'dit_stores_data_v33',
  'dit_personnel_data',
  'dit_jobs_data',
  'military_clothing_config_v3',
  'military_saved_forms_v3',
  'military_clothing_receipts_v1',
  'military_clothing_issues_v1',
  'payStore.registries',
]);

function bakKey(k) { return '_bak_' + k; }

// Check if a stored value is "empty" (would wipe real data)
function isEmptyPayload(value) {
  try {
    const p = JSON.parse(value);
    if (!p) return true;
    // Check clothing/personnel db: { records: [] }
    if (Array.isArray(p.records) && p.records.length === 0) return true;
    // Check inventory: { data: { items: [] } }
    if (p.data && Array.isArray(p.data.items) && p.data.items.length === 0) return true;
    // Check simple arrays
    if (Array.isArray(p) && p.length === 0) return true;
    return false;
  } catch { return false; }
}

// ── Connection ────────────────────────────────────────────────────────────────
let _sql = null;
function getSql() {
  if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL not configured. Set it in Vercel environment variables.');
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// ── Table bootstrap ───────────────────────────────────────────────────────────
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
  await sql`CREATE INDEX IF NOT EXISTS app_storage_updated_idx ON app_storage (updated_at DESC)`;
  _tableReady = true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function sendGzip(res, statusCode, bodyStr) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  zlib.gzip(Buffer.from(bodyStr, 'utf8'), (err, compressed) => {
    if (err) {
      res.status(statusCode).send(bodyStr);
    } else {
      res.setHeader('Content-Encoding', 'gzip');
      res.status(statusCode).end(compressed);
    }
  });
}

// Upsert a single key/value in the DB
async function upsertRow(sql, key, value) {
  await sql`
    INSERT INTO app_storage (storage_key, storage_value, updated_at)
    VALUES (${key}, ${value}, NOW())
    ON CONFLICT (storage_key) DO UPDATE
      SET storage_value = EXCLUDED.storage_value, updated_at = NOW()
  `;
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await ensureTable();
  } catch (err) {
    _tableReady = false; _sql = null;
    console.error('[storage] ensureTable failed:', err.message);
    return json(res, 503, { error: 'Database unavailable: ' + (err.message || '').slice(0, 150) });
  }

  const sql = getSql();
  const key = getKey(req);

  try {
    // ── GET /api/storage — bulk load all keys ────────────────────────────────
    if (req.method === 'GET' && key === null) {
      const rows = await sql`
        SELECT storage_key, storage_value FROM app_storage ORDER BY updated_at DESC
      `;

      const out = Object.create(null);
      const bakRows = Object.create(null);

      for (const r of rows) {
        if (r.storage_key.startsWith('_bak_')) {
          bakRows[r.storage_key.slice(5)] = r.storage_value; // strip _bak_ prefix
        } else {
          out[r.storage_key] = r.storage_value;
        }
      }

      // For protected keys: if the live value is empty but backup has real data, serve backup
      for (const k of PROTECTED_KEYS) {
        if (out[k] && isEmptyPayload(out[k]) && bakRows[k] && !isEmptyPayload(bakRows[k])) {
          console.log('[storage] serving backup for key:', k);
          out[k] = bakRows[k];
          // Silently restore the main key so future reads work too
          upsertRow(sql, k, bakRows[k]).catch(e => console.error('[storage] restore failed:', e.message));
        }
      }

      sendGzip(res, 200, JSON.stringify(out));
      return;
    }

    if (!key) return json(res, 400, { error: 'Key required: /api/storage/<key>' });

    // ── GET /api/storage/<key> ───────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`SELECT storage_value FROM app_storage WHERE storage_key = ${key}`;
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
      if (bytes > 8 * 1024 * 1024)
        return json(res, 413, { error: `Value too large (${(bytes/1024/1024).toFixed(2)} MB). Delete old records to free space.` });

      // Server-side wipe guard: if this is a protected key and value is empty,
      // but we already have real data, refuse the write
      if (PROTECTED_KEYS.has(key) && isEmptyPayload(value)) {
        const existing = await sql`SELECT storage_value FROM app_storage WHERE storage_key = ${key}`;
        if (existing[0] && !isEmptyPayload(existing[0].storage_value)) {
          console.warn('[storage] BLOCKED empty write to protected key:', key);
          return res.status(204).end(); // silent success — don't tell client it was blocked
        }
      }

      // Write main key
      await upsertRow(sql, key, value);

      // Write shadow backup for protected keys (only when value has real data)
      if (PROTECTED_KEYS.has(key) && !isEmptyPayload(value)) {
        await upsertRow(sql, bakKey(key), value).catch(e =>
          console.error('[storage] backup write failed for', key, ':', e.message)
        );
      }

      return res.status(204).end();
    }

    // ── DELETE /api/storage/<key> ────────────────────────────────────────────
    if (req.method === 'DELETE') {
      // Never delete protected keys outright — they may need recovery
      if (PROTECTED_KEYS.has(key)) {
        console.warn('[storage] DELETE blocked for protected key:', key);
        return res.status(204).end();
      }
      await sql`DELETE FROM app_storage WHERE storage_key = ${key}`;
      return res.status(204).end();
    }

    return json(res, 405, { error: 'Method not allowed' });

  } catch (err) {
    console.error(`[storage] ${req.method} ${req.url}:`, err.message);
    const msg = err.message || String(err);
    if (msg.includes('54000') || msg.includes('value too long'))
      return json(res, 413, { error: 'Value too large for the database column.' });
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('ETIMEOUT')) {
      _sql = null;
      return json(res, 503, { error: 'Database connection failed. Try again in a moment.' });
    }
    if (msg.includes('password authentication') || msg.includes('authentication failed')) {
      _sql = null;
      return json(res, 503, { error: 'Database authentication failed. Contact the system administrator.' });
    }
    return json(res, 500, { error: 'Storage error: ' + msg.slice(0, 200) });
  }
};
