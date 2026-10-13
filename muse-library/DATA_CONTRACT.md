# Data contract: how Disk writes to the command center

One endpoint. JSON in, JSON out. Built for curl from a server, not a browser.

```
POST https://<your-site>/api/ingest
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
```

- **Auth:** the bearer token is the only credential. No cookies, CSRF, OAuth or captchas.
- **Limits:** bodies up to 8 MB. No rate limit.
- **This file** is also served live at `GET /DATA_CONTRACT.md` (no auth).

## Responses

| Status | Body | When |
|---|---|---|
| 200 | `{"ok": true, "id": "<id>", "type": "<type>", "created": true}` | Saved. `created` is `false` when an existing record was updated. |
| 400 | `{"ok": false, "error": "..."}` | Body is not valid JSON. |
| 401 | `{"ok": false, "error": "..."}` | Missing or wrong bearer token. |
| 413 | `{"ok": false, "error": "..."}` | Body over 8 MB. |
| 422 | `{"ok": false, "error": "...", "field": "<name>"}` | Validation failed. `field` names the bad field, e.g. `title`, `tags[2]`, `sections[0].body`. |

Treat any non-200 as not saved. A 422 will not succeed on retry; fix the named field. Retrying after a network error is always safe (see idempotency).

## Idempotency

Every record has an `id` you choose. POSTing the same `type` + `id` again **updates** that record instead of creating a duplicate. The update replaces the record, except that a `library_item` keeps its previous `transcript` if you omit it. IDs are unique per type, may not contain spaces or slashes, and are at most 200 characters. Make them stable, for example `briefing-2026-10-13` or `pkg-1Z999AA10123456784-delivered`.

## Common fields (every type)

| Field | Type | Notes |
|---|---|---|
| `type` | string | One of `briefing`, `library_item`, `package_update`, `email_alert`, `digest`. |
| `id` | string | Required. Your stable unique id (see above). |
| `timestamp` | string | Required. ISO 8601, with an offset or `Z`: `2026-10-13T07:30:00-04:00`. Used for ordering. |

Unknown fields are rejected with a 422 that names them, so typos never silently drop data. Markdown fields support headings, **bold**, *italic*, `code`, links, lists, quotes and line breaks.

## Types

### `briefing`
| Field | Type | Required |
|---|---|---|
| `title` | string, max 300 | yes |
| `body` | markdown | yes |
| `sections` | array of `{"heading": string, "body": markdown}`, max 40 | no |

The newest briefing is the top card on Today.

### `library_item`
| Field | Type | Required |
|---|---|---|
| `url` | http(s) URL of the source post | yes |
| `title` | string | yes |
| `hook` | string, one line | yes |
| `summary` | markdown. Use the labels `Hook:`, `Format:`, `Structure:`, `Why it works:`, `What to steal:` each on its own line. | yes |
| `transcript` | long text, up to 300,000 chars | no |
| `folder` | string. Existing folder names match case-insensitively; a new name creates a folder. `""` leaves it unfiled. | yes (may be `""`) |
| `tags` | array of strings, max 30. Lowercased on save. | yes (may be `[]`) |
| `author` | string, the account handle, with or without `@`. May be `""`. | yes |
| `thumbnail_url` | direct image URL. The site downloads and keeps a copy. | no |

If the owner has moved an item to a folder by hand, later updates do not move it back. Tags the owner added by hand are kept.

### `package_update`
| Field | Type | Required |
|---|---|---|
| `tracking_number` | string | yes |
| `status` | short string, max 80, e.g. `In transit`, `Out for delivery`, `Delivered`, `Exception` | yes |
| `detail` | markdown | yes |
| `location` | string | no |
| `eta` | date `YYYY-MM-DD` or ISO 8601 | no |

Today shows one pill per tracking number using its newest update. Use a new `id` for each scan event so the full history appears, or reuse one `id` per package to keep a single record.

### `email_alert`
| Field | Type | Required |
|---|---|---|
| `from` | string | yes |
| `subject` | string | yes |
| `snippet` | markdown | yes |
| `thread_id` | string | no |
| `needs_reply` | boolean | yes |

New alerts show as unread on Today until the owner opens them. Re-sending with `needs_reply` flipped from `false` to `true` marks it unread again.

### `digest`
| Field | Type | Required |
|---|---|---|
| `title` | string | yes |
| `body` | markdown, long-form, up to 500,000 chars | yes |
| `sections` | array of `{"heading": string, "body": markdown}`, max 40 | no |

#### Daily news digest

The News tab shows digests whose `id` starts with `news-`. Send one per day with `id` `news-YYYY-MM-DD`, `body` set to a one-line theme, and one section per story. Each story body uses exactly this markdown:

```
_Source · 7:12 AM_

Two-sentence summary of the story.

**Why it matters:** one line on what it means for a one-man clothing brand.

[Read more](https://example.com/article)
```

## Examples

```bash
curl -sS -X POST "$SITE/api/ingest" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "briefing",
    "id": "briefing-2026-10-13",
    "timestamp": "2026-10-13T07:30:00-04:00",
    "title": "Tuesday, October 13",
    "body": "Two customer emails need replies before noon.",
    "sections": [
      { "heading": "Calendar", "body": "- 2:00 pm studio session" },
      { "heading": "Packages", "body": "Sample order is **out for delivery**." }
    ]
  }'
# {"ok":true,"id":"briefing-2026-10-13","type":"briefing","created":true}
```

```bash
curl -sS -X POST "$SITE/api/ingest" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "library_item",
    "id": "ig-DAbc123",
    "timestamp": "2026-10-13T15:02:00-04:00",
    "url": "https://www.instagram.com/reel/DAbc123/",
    "title": "Founder story hook",
    "hook": "Nobody tells you this about your first drop.",
    "summary": "Hook: contrarian claim\nFormat: talking head, one take\nWhy it works: reframes the launch as a story\nWhat to steal: open on the mistake",
    "transcript": "Nobody tells you this about your first drop...",
    "folder": "Hooks",
    "tags": ["talking-head", "founder"],
    "author": "studio.oak"
  }'
```

```bash
curl -sS -X POST "$SITE/api/ingest" -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"package_update","id":"pkg-1Z999-out","timestamp":"2026-10-13T09:10:00-04:00","tracking_number":"1Z999AA10123456784","status":"Out for delivery","detail":"On the truck.","location":"Savannah, GA","eta":"2026-10-13"}'

curl -sS -X POST "$SITE/api/ingest" -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"email_alert","id":"gmail-18f2a","timestamp":"2026-10-13T10:41:00-04:00","from":"Jordan Ellis <jordan@example.com>","subject":"Order #1042 sizing","snippet":"Asking to swap an **M** for an **L** before it ships.","thread_id":"18f2a","needs_reply":true}'
```

Error example:

```bash
# missing "needs_reply"
# 422 {"ok":false,"error":"Missing required field \"needs_reply\".","field":"needs_reply"}
```
