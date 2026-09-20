const { neon } = require('@neondatabase/serverless');

// Uses the Neon serverless driver over HTTP — works perfectly on Vercel.
// Only DATABASE_URL is required. No other env vars needed for login to work.
if (!process.env.DATABASE_URL) {
  console.error('[storage] FATAL: DATABASE_URL environment variable is not set.');
}

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

// Create the table once per cold start (cached promise)
let tableReady = null;
async function ensureTable() {
  if (!sql) throw new Error('DATABASE_URL is not set in environment variables.');
  if (!tableReady) {
    tableReady = sql`
      CREATE TABLE IF NOT EXISTS app_storage (
        storage_key   TEXT        PRIMARY KEY,
        storage_value TEXT        NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.catch((err) => {
      tableReady = null; // reset so next request retries
      throw err;
    });
  }
  return tableReady;
}

function getKey(req) {
  const pathname = new URL(
    req.url,
    `https://${req.headers.host || 'localhost'}`
  ).pathname;
  const prefix = '/api/storage/';
  return pathname.startsWith(prefix)
    ? decodeURIComponent(pathname.slice(prefix.length))
    : null;
}

function sendJson(res, status, body) {
  res.status(status)
    .setHeader('Content-Type', 'application/json')
    .send(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await ensureTable();
    const key = getKey(req);

    // GET /api/storage — return all key/value pairs
    if (req.method === 'GET' && key === null) {
      const rows = await sql`SELECT storage_key, storage_value FROM app_storage`;
      return sendJson(res, 200,
        Object.fromEntries(rows.map((r) => [r.storage_key, r.storage_value]))
      );
    }

    if (!key) return sendJson(res, 400, { error: 'A storage key is required' });

    // GET /api/storage/:key
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT storage_value FROM app_storage WHERE storage_key = ${key}
      `;
      return sendJson(res, 200, { value: rows[0] ? rows[0].storage_value : null });
    }

    // PUT /api/storage/:key
    if (req.method === 'PUT') {
      if (!req.body || typeof req.body.value !== 'string') {
        return sendJson(res, 400, { error: 'value must be a string' });
      }
      await sql`
        INSERT INTO app_storage (storage_key, storage_value, updated_at)
        VALUES (${key}, ${req.body.value}, CURRENT_TIMESTAMP)
        ON CONFLICT (storage_key) DO UPDATE
          SET storage_value = EXCLUDED.storage_value,
              updated_at    = CURRENT_TIMESTAMP
      `;
      return res.status(204).end();
    }

    // DELETE /api/storage/:key
    if (req.method === 'DELETE') {
      await sql`DELETE FROM app_storage WHERE storage_key = ${key}`;
      return res.status(204).end();
    }

    return sendJson(res, 405, { error: 'Method not allowed' });

  } catch (error) {
    console.error('[storage] Error:', error.message);
    return sendJson(res, 500, {
      error: 'Database error: ' + error.message
    });
  }
};
