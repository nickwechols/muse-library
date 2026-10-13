# Muse API

The easiest way to connect Muse: open your library, click **Connect Muse** in the sidebar, and copy the message. It already has your URL and key filled in, plus instructions to transcribe each reel and file it in a folder.

Reference. All requests use `Authorization: Bearer <MUSE_KEY>`:

- `GET /api/folders` lists folder names and counts, so Muse can file into existing folders.
- `POST /api/items` with JSON:
  - `url` (required): the Instagram link
  - `transcript`: the full spoken script, plain text
  - `hook`: the opening line or on-screen text from the first 3 seconds
  - `summary`: breakdown (hook, format, structure, why it works, what to steal)
  - `folder`: folder name, created if it doesn't exist
  - `tags`: list of short tags
  - `thumbnail_url`: direct preview image URL, optional
  Sending the same URL again updates the item instead of duplicating it.
- `GET /api/ingest?key=<MUSE_KEY>&url=<encoded link>&folder=...&hook=...&transcript=...` for agents that can only open links.
- `GET /api/state` returns all folders and items.
- `PATCH /api/items/<id>` with any of `notes`, `summary`, `transcript`, `hook`, `tags`, `folder`, `starred`.
- `POST /api/folders` with `{"name": "..."}`.
