# DIT Stores Inventory System

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to the Neon connection string. This is the only application-data storage backend.
3. Run `npm install` once.
4. Use `vercel dev` to preview the static pages and serverless API locally.

## Direct Neon connection

`pg.neon.tech` is not a complete Neon endpoint. Use the full `DATABASE_URL` from the Neon dashboard. In PowerShell, load the local value and connect without another password prompt:

```powershell
$env:DATABASE_URL = (Get-Content .env | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', ''
psql $env:DATABASE_URL
```

For repeated connections, store the credentials in your user's PostgreSQL password file instead of adding them to the repository. On Windows, use `%APPDATA%\postgresql\pgpass.conf` with one line in this format:

```text
host:5432:database:user:password
```

Neon requires SSL; keep `sslmode=require` in the connection settings.

The serverless API creates the `app_storage` table when it receives its first storage request. Keep `.env` private and configure the same variables in the hosting provider's environment settings; do not put database credentials in HTML or JavaScript files.

## Hosting

For Vercel, import this folder as a project and add `DATABASE_URL` under Project Settings > Environment Variables. The static HTML pages are served from the project root and `/api/storage` is provided by `api/storage.js`. Vercel does not store application records locally.

## Storage model

The browser uses `/api/storage` as a small key/value API. Application records are serialized JSON values stored in the Neon `app_storage` table. The browser keeps only a temporary in-memory cache for the current page; it does not use `localStorage` or IndexedDB. Login state in `sessionStorage` is temporary session metadata, not application data.
