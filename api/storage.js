const { neon } = require('@neondatabase/serverless');

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const dataApiUrl = process.env.NEON_DATA_API_URL && process.env.NEON_DATA_API_KEY
  ? process.env.NEON_DATA_API_URL.replace(/\/$/, '')
  : '';
let tableReady;

async function dataApiFetch(path, options) {
  const headers = {
    Accept: 'application/json',
    ...(options && options.headers),
    ...(process.env.NEON_DATA_API_KEY
      ? {
          apikey: process.env.NEON_DATA_API_KEY,
          Authorization: `Bearer ${process.env.NEON_DATA_API_KEY}`,
        }
      : {}),
  };
  const response = await fetch(`${dataApiUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Neon Data API returned HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.status === 204 ? null : response.json();
}

async function ensureTable() {
  if (dataApiUrl) return;
  if (!sql) throw new Error('Configure DATABASE_URL or both NEON_DATA_API_URL and NEON_DATA_API_KEY');
  if (!tableReady) {
    tableReady = sql`
      CREATE TABLE IF NOT EXISTS app_storage (
        storage_key TEXT PRIMARY KEY,
        storage_value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  }
  await tableReady;
}

function getKey(req) {
  const pathname = new URL(req.url, `https://${req.headers.host || 'localhost'}`).pathname;
  const prefix = '/api/storage/';
  return pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : null;
}

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
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

    if (req.method === 'GET' && key === null) {
      if (dataApiUrl) {
        const rows = await dataApiFetch('/app_storage?select=storage_key,storage_value');
        return sendJson(res, 200, Object.fromEntries(rows.map((row) => [row.storage_key, row.storage_value])));
      }
      const rows = await sql`SELECT storage_key, storage_value FROM app_storage`;
      return sendJson(res, 200, Object.fromEntries(rows.map((row) => [row.storage_key, row.storage_value])));
    }

    if (!key) return sendJson(res, 400, { error: 'A storage key is required' });

    if (req.method === 'GET') {
      if (dataApiUrl) {
        const rows = await dataApiFetch(`/app_storage?select=storage_value&storage_key=eq.${encodeURIComponent(key)}`);
        return sendJson(res, 200, { value: rows[0] ? rows[0].storage_value : null });
      }
      const rows = await sql`SELECT storage_value FROM app_storage WHERE storage_key = ${key}`;
      return sendJson(res, 200, { value: rows[0] ? rows[0].storage_value : null });
    }

    if (req.method === 'PUT') {
      if (!req.body || typeof req.body.value !== 'string') {
        return sendJson(res, 400, { error: 'value must be a string' });
      }
      if (dataApiUrl) {
        await dataApiFetch('/app_storage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify([{ storage_key: key, storage_value: req.body.value }]),
        });
        return res.status(204).end();
      }
      await sql`
        INSERT INTO app_storage (storage_key, storage_value, updated_at)
        VALUES (${key}, ${req.body.value}, CURRENT_TIMESTAMP)
        ON CONFLICT (storage_key) DO UPDATE
        SET storage_value = EXCLUDED.storage_value, updated_at = CURRENT_TIMESTAMP
      `;
      return res.status(204).end();
    }

    if (req.method === 'DELETE') {
      if (dataApiUrl) {
        await dataApiFetch(`/app_storage?storage_key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' });
        return res.status(204).end();
      }
      await sql`DELETE FROM app_storage WHERE storage_key = ${key}`;
      return res.status(204).end();
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Storage API error:', error);
    return sendJson(res, 500, { error: 'Could not access application data' });
  }
};