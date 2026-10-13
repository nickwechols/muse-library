// POST /api/ingest: the machine-facing write API. See DATA_CONTRACT.md.
// Pure validation lives here; server.js wires it to storage.

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;

// field spec: [kind, required, max]
// kinds: id, str, text, ts, date, url, bool, tags, sections
const COMMON = { type: ['str', true, 40], id: ['id', true, 200], timestamp: ['ts', true] };
export const TYPES = {
  briefing: { title: ['str', true, 300], body: ['text', true, 200_000], sections: ['sections', false] },
  library_item: {
    url: ['url', true, 2000], title: ['str', true, 500], hook: ['str', true, 1000],
    summary: ['text', true, 50_000], transcript: ['text', false, 300_000],
    folder: ['str', true, 60, true], tags: ['tags', true], author: ['str', true, 120, true],
    thumbnail_url: ['url', false, 4000],
  },
  package_update: {
    tracking_number: ['str', true, 120], status: ['str', true, 80], detail: ['text', true, 20_000],
    location: ['str', false, 200], eta: ['date', false],
  },
  email_alert: {
    from: ['str', true, 300], subject: ['str', true, 500], snippet: ['text', true, 20_000],
    thread_id: ['str', false, 300], needs_reply: ['bool', true],
  },
  digest: { title: ['str', true, 300], body: ['text', true, 500_000] },
};

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// Returns { ok: true, value } or { ok: false, field, error }.
export function validate(body) {
  if (typeOf(body) !== 'object') return fail('(body)', 'Body must be a JSON object.');
  if (body.type === undefined) return fail('type', `Missing "type". Use one of: ${Object.keys(TYPES).join(', ')}.`);
  if (typeof body.type !== 'string' || !TYPES[body.type]) return fail('type', `Unknown type "${body.type}". Use one of: ${Object.keys(TYPES).join(', ')}.`);
  const spec = { ...COMMON, ...TYPES[body.type] };

  const unknown = Object.keys(body).filter(k => !(k in spec));
  if (unknown.length) return fail(unknown[0], `Unknown field "${unknown[0]}" for type "${body.type}". Allowed: ${Object.keys(spec).join(', ')}.`);

  const out = {};
  for (const [key, [kind, required, max, allowEmpty]] of Object.entries(spec)) {
    let v = body[key];
    if (v === undefined || v === null) {
      if (required) return fail(key, `Missing required field "${key}".`);
      continue;
    }
    const r = check(key, kind, v, max, allowEmpty);
    if (r.error) return fail(r.field || key, r.error);
    out[key] = r.value;
  }
  return { ok: true, value: out };
}

function check(key, kind, v, max, allowEmpty) {
  const t = typeOf(v);
  switch (kind) {
    case 'id':
    case 'str':
    case 'text': {
      if (t !== 'string') return { error: `"${key}" must be a string, got ${t}.` };
      const s = kind === 'text' ? v.replace(/\r\n?/g, '\n') : v.trim();
      if (!s.trim() && !allowEmpty) return { error: `"${key}" must not be empty.` };
      if (max && s.length > max) return { error: `"${key}" is too long (${s.length} chars, max ${max}).` };
      if (kind === 'id' && /[\s/]/.test(s)) return { error: `"${key}" must not contain spaces or slashes.` };
      return { value: s };
    }
    case 'ts': {
      if (t !== 'string' || !ISO.test(v.trim()) || isNaN(Date.parse(v))) return { error: `"${key}" must be an ISO 8601 timestamp like "2026-10-13T08:00:00-04:00".` };
      return { value: new Date(v).toISOString() };
    }
    case 'date': {
      if (t !== 'string' || !DATE.test(v.trim()) || isNaN(Date.parse(v))) return { error: `"${key}" must be a date like "2026-10-16" (or a full ISO 8601 timestamp).` };
      return { value: v.trim() };
    }
    case 'url': {
      if (t !== 'string') return { error: `"${key}" must be a string URL, got ${t}.` };
      try { const u = new URL(v.trim()); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { return { error: `"${key}" must be a full http(s) URL.` }; }
      if (v.length > max) return { error: `"${key}" is too long (max ${max} chars).` };
      return { value: v.trim() };
    }
    case 'bool':
      if (t !== 'boolean') return { error: `"${key}" must be true or false, got ${t}.` };
      return { value: v };
    case 'tags': {
      if (t !== 'array') return { error: `"${key}" must be an array of strings, got ${t}.` };
      if (v.length > 30) return { error: `"${key}" has ${v.length} items, max 30.` };
      const tags = [];
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] !== 'string' || !v[i].trim()) return { field: `${key}[${i}]`, error: `"${key}[${i}]" must be a non-empty string.` };
        if (v[i].length > 40) return { field: `${key}[${i}]`, error: `"${key}[${i}]" is too long (max 40 chars).` };
        tags.push(v[i].trim().replace(/^#/, '').toLowerCase());
      }
      return { value: [...new Set(tags)] };
    }
    case 'sections': {
      if (t !== 'array') return { error: `"${key}" must be an array of {heading, body} objects, got ${t}.` };
      if (v.length > 40) return { error: `"${key}" has ${v.length} items, max 40.` };
      const secs = [];
      for (let i = 0; i < v.length; i++) {
        const s = v[i];
        if (typeOf(s) !== 'object') return { field: `${key}[${i}]`, error: `"${key}[${i}]" must be an object with "heading" and "body".` };
        const extra = Object.keys(s).find(k => k !== 'heading' && k !== 'body');
        if (extra) return { field: `${key}[${i}].${extra}`, error: `Unknown field "${key}[${i}].${extra}". Sections only take "heading" and "body".` };
        for (const f of ['heading', 'body']) {
          if (typeof s[f] !== 'string' || !s[f].trim()) return { field: `${key}[${i}].${f}`, error: `"${key}[${i}].${f}" must be a non-empty string.` };
        }
        secs.push({ heading: s.heading.trim().slice(0, 300), body: s.body.replace(/\r\n?/g, '\n').slice(0, 100_000) });
      }
      return { value: secs };
    }
  }
  return { error: `"${key}" is invalid.` };
}

const fail = (field, error) => ({ ok: false, field, error });
