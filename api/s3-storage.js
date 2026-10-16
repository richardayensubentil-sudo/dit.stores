// api/s3-storage.js
// Neon Object Storage (S3-compatible) — file upload and pre-signed URL handler.
// Vercel routes: POST /api/s3-storage  → upload a file, returns a pre-signed view URL
//                GET  /api/s3-storage  → generate a pre-signed URL for an existing key
//
// Required environment variables (set in .env and Vercel dashboard):
//   AWS_ENDPOINT_URL_S3    — your Neon branch S3 endpoint
//   AWS_REGION             — e.g. us-east-2
//   AWS_ACCESS_KEY_ID      — Neon credential token_id  (nak_live_...)
//   AWS_SECRET_ACCESS_KEY  — Neon credential secret    (nsk_live_...)

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = 'assets';
const SIGNED_URL_EXPIRES = 3600; // seconds (1 hour)

// The SDK reads AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID, and
// AWS_SECRET_ACCESS_KEY automatically from process.env.
const s3 = new S3Client({ forcePathStyle: true });

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Validate that S3 env vars are present
  if (!process.env.AWS_ENDPOINT_URL_S3 || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return sendJson(res, 500, {
      error: 'Neon Object Storage is not configured. Set AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.',
    });
  }

  try {
    // POST /api/s3-storage
    // Body: { key: "uploads/file.txt", body: "file content or base64", contentType: "text/plain" }
    // Returns: { url: "<pre-signed view URL>" }
    if (req.method === 'POST') {
      const { key, body: fileBody, contentType } = req.body || {};

      if (!key || fileBody === undefined) {
        return sendJson(res, 400, { error: '"key" and "body" are required.' });
      }

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: fileBody,
          ContentType: contentType || 'application/octet-stream',
        })
      );

      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: SIGNED_URL_EXPIRES }
      );

      console.log(`[s3-storage] uploaded — key: ${key}`);
      return sendJson(res, 200, { url });
    }

    // GET /api/s3-storage?key=uploads/file.txt
    // Returns: { url: "<pre-signed view URL>" }
    if (req.method === 'GET') {
      const url_obj = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
      const key = url_obj.searchParams.get('key');

      if (!key) {
        return sendJson(res, 400, { error: '"key" query parameter is required.' });
      }

      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: SIGNED_URL_EXPIRES }
      );

      console.log(`[s3-storage] pre-signed URL generated — key: ${key}`);
      return sendJson(res, 200, { url });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('S3 storage error:', error);
    return sendJson(res, 500, { error: 'Could not access Neon Object Storage.' });
  }
};
