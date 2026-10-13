# Disk

A private command center for what Disk (your AI assistant) produces: morning briefings, email alerts, package tracking, digests, and an Instagram reference library. Disk writes to it over HTTP; you read it on your phone or computer.

- **Today:** packages, the latest briefing, unread email, recent saves.
- **Library:** folders, search, hooks, breakdowns, transcripts, notes, copy all transcripts.
- **Activity:** everything Disk has sent, newest first, expandable.

Disk's write API is documented in [DATA_CONTRACT.md](DATA_CONTRACT.md) (also served live at `/DATA_CONTRACT.md`).

## Deploy (Railway)

1. Push this folder to GitHub and deploy it on Railway. No build step, no dependencies.
2. Attach a **Volume** to the service (any mount path). Data lives there.
3. Optional but recommended: add a variable `INGEST_TOKEN` with a long random secret. That is the bearer token Disk uses. Without it, the site generates one for you.
4. Generate a domain, open it, and create your password.
5. Click the plug icon, copy the message, and send it to Disk privately.

Make a token with: `openssl rand -base64 32`

## Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `INGEST_TOKEN` | Bearer token for `POST /api/ingest`. Overrides the generated one. |
| `OWNER_KEY` | Fixed site password instead of the first-run setup. |
| `DATA_DIR` | Storage folder. Railway volumes are detected automatically. |

## Data and backups

Everything is stored in `db.json` on the volume, written atomically, with a `.bak` copy and 14 daily snapshots in `backups/`. `GET /api/export` (signed in) downloads a full JSON backup.

## Run locally

```
INGEST_TOKEN=dev node server.js
```
Then open http://localhost:3000. Node 20+.
