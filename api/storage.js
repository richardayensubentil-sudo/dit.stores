const { neon } = require('@neondatabase/serverless');

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
let tableReady;

// ── Ensure the storage table exists ──────────────────────────────────────────
async function ensureTable() {
  if (!sql) throw new Error('DATABASE_URL is not set. Configure it in your Vercel environment variables.');
  if (!tableReady) {
    tableReady = sql`
      CREATE TABLE IF NOT EXISTS app_storage (
        storage_key   TEXT PRIMARY KEY,
        storage_value TEXT NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  }
  await tableReady;
}

// ── Extract the storage key from the URL path ─────────────────────────────────
function getKey(req) {
  const pathname = new URL(req.url, `https://${req.headers.host || 'localhost'}`).pathname;
  const prefix = '/api/storage/';
  return pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : null;
}

// ── Send a JSON response ──────────────────────────────────────────────────────
function sendJson(res, status, body) {
  res.status(status)
     .setHeader('Content-Type', 'application/json')
     .send(JSON.stringify(body));
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Security and cache headers
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await ensureTable();
    const key = getKey(req);

    // ── GET /api/storage — return all key-value pairs ──
    if (req.method === 'GET' && key === null) {
      const rows = await sql`SELECT storage_key, storage_value FROM app_storage ORDER BY updated_at DESC`;
      const result = Object.fromEntries(rows.map(r => [r.storage_key, r.storage_value]));
      return sendJson(res, 200, result);
    }

    // All other methods require a key in the path
    if (!key) return sendJson(res, 400, { error: 'A storage key is required in the path: /api/storage/<key>' });

    // ── GET /api/storage/<key> — return a single value ──
    if (req.method === 'GET') {
      const rows = await sql`SELECT storage_value FROM app_storage WHERE storage_key = ${key}`;
      return sendJson(res, 200, { value: rows[0] ? rows[0].storage_value : null });
    }

    // ── PUT /api/storage/<key> — upsert a value ──
    if (req.method === 'PUT') {
      if (!req.body || typeof req.body.value !== 'string') {
        return sendJson(res, 400, { error: '"value" must be a string in the request body' });
      }

      const value = req.body.value;

      // Warn about very large values in logs (> 4 MB)
      const byteLen = Buffer.byteLength(value, 'utf8');
      if (byteLen > 4 * 1024 * 1024) {
        console.warn(`[storage] Large write for key "${key}": ${(byteLen / 1024 / 1024).toFixed(2)} MB`);
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

    // ── DELETE /api/storage/<key> — remove a key ──
    if (req.method === 'DELETE') {
      await sql`DELETE FROM app_storage WHERE storage_key = ${key}`;
      return res.status(204).end();
    }

    return sendJson(res, 405, { error: 'Method not allowed' });

  } catch (error) {
    console.error('[storage] API error:', error.message || error);

    // Give callers a useful hint for common failures
    const msg = error.message || String(error);
    if (msg.includes('too large') || msg.includes('54000')) {
      return sendJson(res, 413, { error: 'Value is too large to store. Reduce the data size.' });
    }
    if (msg.includes('DATABASE_URL')) {
      return sendJson(res, 503, { error: msg });
    }
    return sendJson(res, 500, { error: 'Storage service error. Check server logs for details.' });
  }
};
