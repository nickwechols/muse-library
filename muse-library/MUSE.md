# Muse API

The easiest way to connect Muse: open your library, click **Connect Muse** in the sidebar, and copy the message. It already has your URL and key filled in.

Reference, all requests use `Authorization: Bearer <MUSE_KEY>`:

- `POST /api/items` with JSON `{"url": "...", "summary": "...", "tags": [...], "folder": "...", "thumbnail_url": "..."}`. Only `url` is required. Same URL again updates instead of duplicating.
- `GET /api/ingest?key=<MUSE_KEY>&url=<encoded link>` for agents that can only open links.
- `GET /api/state` returns all folders and items.
- `PATCH /api/items/<id>` with any of `notes`, `summary`, `tags`, `folder`, `starred`.
- `POST /api/folders` with `{"name": "..."}`.
