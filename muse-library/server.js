// Muse Library server. Zero dependencies, Node 18+.
// Stores everything in DATA_DIR (db.json + media/). Serves the UI from ./public.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// Railway sets RAILWAY_VOLUME_MOUNT_PATH automatically when a volume is attached.
const VOLUME = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = path.resolve(VOLUME || path.join(__dirname, 'data'));
const ON_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
const PERSISTENT = !ON_RAILWAY || !!VOLUME;
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------- storage ----------
// db.json is written atomically (tmp + rename) through a single write queue.
// The previous good copy is kept as db.json.bak, plus one dated snapshot per day for 14 days.
const BAK_FILE = DB_FILE + '.bak';
const SNAP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(SNAP_DIR, { recursive: true });
function loadDb() {
  for (const f of [DB_FILE, BAK_FILE]) {
    if (!fs.existsSync(f)) continue;
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d && Array.isArray(d.items)) { if (f === BAK_FILE) console.warn('Recovered from db.json.bak'); return d; } }
    catch (e) { console.error(`${path.basename(f)} unreadable`, e.message); }
  }
  return null;
}
let db = loadDb() || { rev: 1, folders: [], items: [] };
db.folders ||= []; db.items ||= []; db.rev ||= 1;
let saveTimer = null, writing = Promise.resolve(), dirty = false;
function writeNow() {
  dirty = false;
  const json = JSON.stringify(db);
  writing = writing.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, json);
    if (fs.existsSync(DB_FILE)) await fsp.copyFile(DB_FILE, BAK_FILE).catch(() => {});
    await fsp.rename(tmp, DB_FILE);
    const day = new Date().toISOString().slice(0, 10);
    const snap = path.join(SNAP_DIR, `db-${day}.json`);
    if (!fs.existsSync(snap)) {
      await fsp.writeFile(snap, json);
      const old = (await fsp.readdir(SNAP_DIR)).filter(f => f.startsWith('db-')).sort().slice(0, -14);
      await Promise.all(old.map(f => fsp.unlink(path.join(SNAP_DIR, f)).catch(() => {})));
    }
  }).catch(e => console.error('Save failed', e));
  return writing;
}
function commit() {
  db.rev = (db.rev || 0) + 1;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 120);
}
function flushSync() {
  if (!dirty) return;
  try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); dirty = false; } catch (e) { console.error(e); }
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { clearTimeout(saveTimer); flushSync(); process.exit(0); });
process.on('unhandledRejection', e => console.error('Unhandled', e));
process.on('uncaughtException', e => { console.error('Uncaught', e); flushSync(); });
const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(6).toString('base64url');

// ---------- settings + auth ----------
// No env vars needed: the owner password is created on first visit, the Muse key is generated.
// OWNER_KEY / MUSE_KEY env vars still work and take priority if set.
db.settings ||= {};
const S = db.settings;
if (!S.secret) S.secret = crypto.randomBytes(32).toString('hex');
if (!S.muse_key) S.muse_key = 'muse_' + crypto.randomBytes(18).toString('base64url');
commit();
const museKey = () => process.env.MUSE_KEY || S.muse_key;
const hasOwner = () => !!(process.env.OWNER_KEY || S.owner_hash);
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function isOwnerKey(k) {
  if (!k) return false;
  if (process.env.OWNER_KEY) return safeEq(k, process.env.OWNER_KEY);
  if (!S.owner_hash) return false;
  return safeEq(hashPw(k, S.owner_salt), S.owner_hash);
}
const session = () => crypto.createHmac('sha256', S.secret).update('session:' + (process.env.OWNER_KEY || S.owner_hash || '')).digest('hex');
function sessionCookie(req) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `ml_session=${session()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000${secure}`;
}
function whoIs(req, url) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const qkey = url.searchParams.get('key');
  for (const k of [bearer, qkey]) {
    if (!k) continue;
    if (safeEq(k, museKey())) return 'muse';
    if (isOwnerKey(k)) return 'you';
  }
  const cookie = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
  if (hasOwner() && cookie.ml_session && safeEq(cookie.ml_session, session())) return 'you';
  return null;
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Body too large'); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const type = req.headers['content-type'] || '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { return { url: raw.trim() }; }
}
const decode = (s = '') => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Accepts instagram.com/p/ID, /reel/ID, /reels/ID, /tv/ID, with or without a username prefix or query.
function parseUrl(input) {
  let raw = String(input || '').trim();
  const found = raw.match(/https?:\/\/[^\s"'<>]+/);
  if (found) raw = found[0];
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u; try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'instagram.com' || host === 'instagr.am') {
    const m = u.pathname.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (m) {
      const isReel = m[1] !== 'p';
      return {
        source: 'instagram',
        shortcode: m[2],
        kind: isReel ? 'reel' : 'post',
        url: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${m[2]}/`,
      };
    }
  }
  u.hash = '';
  return { source: host, shortcode: null, kind: 'link', url: u.toString() };
}

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const c = tag.match(/content=["']([^"']*)["']/i);
  return c ? decode(c[1]) : null;
}

async function fetchMeta(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Page returned ${res.status}`);
  const html = await res.text();
  const out = {
    image: meta(html, 'og:image'),
    title: meta(html, 'og:title'),
    description: meta(html, 'og:description') || meta(html, 'description'),
    video: meta(html, 'og:video') || meta(html, 'og:video:secure_url'),
    type: meta(html, 'og:type'),
  };
  // Instagram descriptions look like: '1,204 likes, 33 comments - handle on October 2, 2026: "caption"'
  const d = out.description || '';
  const m = d.match(/-\s*([\w.]+)\s+on\s+[^:]+:\s*["“]?([\s\S]*?)["”]?\.?\s*$/);
  if (m) { out.author = m[1]; out.caption = m[2]; }
  if (!out.author && out.title) {
    const t = out.title.match(/^(.*?)\s+(?:on Instagram|\(@([\w.]+)\))/);
    if (t) out.author = t[2] || t[1];
    const q = out.title.match(/:\s*["“]([\s\S]*)["”]\s*$/);
    if (q && !out.caption) out.caption = q[1];
  }
  return out;
}

async function saveImage(item, { remote, base64 }) {
  let buf, type = 'image/jpeg';
  if (base64) {
    const m = String(base64).match(/^data:([^;]+);base64,(.*)$/);
    if (m) { type = m[1]; buf = Buffer.from(m[2], 'base64'); } else buf = Buffer.from(base64, 'base64');
  } else if (remote) {
    const r = await fetch(remote, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Image returned ${r.status}`);
    type = r.headers.get('content-type') || type;
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (!buf || buf.length < 200) throw new Error('Empty image');
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const name = `${item.id}.${ext}`;
  await fsp.writeFile(path.join(MEDIA_DIR, name), buf);
  item.thumb = `/media/${name}?v=${Date.now().toString(36)}`;
}

// Fill in preview, author and caption. Instagram thumbnail URLs expire, so the image is stored locally.
async function enrich(item, hints = {}) {
  item.status = 'pending';
  item.attempts = (item.attempts || 0) + 1;
  item.last_attempt = now();
  commit();
  const errors = [];
  try {
    if (hints.image_base64 || hints.thumbnail_url) {
      await saveImage(item, { base64: hints.image_base64, remote: hints.thumbnail_url });
    }
  } catch (e) { errors.push(`thumbnail: ${e.message}`); }
  try {
    const m = await fetchMeta(item.url);
    if (!item.author && m.author) item.author = m.author.replace(/^@/, '').trim();
    if (!item.caption && m.caption) item.caption = m.caption;
    if (!item.title && m.title && item.kind === 'link') item.title = m.title;
    if (item.kind === 'post' && m.video) item.media = 'video';
    if (!item.thumb && m.image) await saveImage(item, { remote: m.image });
  } catch (e) { errors.push(`page: ${e.message}`); }
  if (item.thumb) item.attempts = 0;
  item.status = item.thumb ? 'ready' : 'no_preview';
  item.enrich_error = item.thumb ? null : errors.join('; ') || 'No preview image found';
  item.updated_at = now();
  commit();
}

// Preview queue: 2 at a time, retried with backoff (2m, 15m, 2h) if Instagram fails.
const queue = new Map(); let running = 0;
const BACKOFF = [2, 15, 120].map(m => m * 60e3);
function enqueue(item, hints = {}) {
  queue.set(item.id, hints);
  pump();
}
function pump() {
  while (running < 2 && queue.size) {
    const [id, hints] = queue.entries().next().value;
    queue.delete(id);
    const item = db.items.find(i => i.id === id);
    if (!item) continue;
    running++;
    enrich(item, hints).catch(e => console.error('enrich', e)).finally(() => { running--; pump(); });
  }
}
setInterval(() => {
  const t = Date.now();
  for (const i of db.items) {
    if (i.status === 'ready' || queue.has(i.id)) continue;
    const n = i.attempts || 0;
    if (n > BACKOFF.length) continue;
    if (t - new Date(i.last_attempt || 0).getTime() >= (BACKOFF[n - 1] || 0)) enqueue(i);
  }
}, 60e3).unref();
// Anything stuck mid-fetch from a previous run gets picked up again.
db.items.filter(i => i.status === 'pending').forEach(i => enqueue(i));

function findOrCreateFolder(name) {
  if (!name) return null;
  const clean = String(name).trim().slice(0, 60);
  if (!clean) return null;
  let f = db.folders.find(x => x.name.toLowerCase() === clean.toLowerCase() || x.id === clean);
  if (!f) { f = { id: uid(), name: clean, order: db.folders.length, created_at: now() }; db.folders.push(f); }
  return f.id;
}
const clip = (v, n) => String(v ?? '').slice(0, n);
const cleanTags = t => [...new Set((Array.isArray(t) ? t : String(t || '').split(','))
  .map(x => String(x).trim().replace(/^#/, '').toLowerCase()).filter(Boolean))].slice(0, 20);

async function ingest(body, who) {
  const parsed = parseUrl(body.url || body.link || body.text);
  if (!parsed) return [400, { error: 'Send a "url" for the Instagram post or reel.' }];
  let item = db.items.find(i => i.url === parsed.url);
  const duplicate = !!item;
  if (!item) {
    item = {
      id: uid(), ...parsed,
      media: parsed.kind === 'reel' ? 'video' : parsed.kind === 'post' ? 'image' : 'link',
      author: null, caption: null, title: null, thumb: null,
      folder_id: null, tags: [], notes: '', summary: '', starred: false,
      added_by: who, created_at: now(), updated_at: now(), status: 'pending',
    };
    db.items.unshift(item);
  }
  if (body.author) item.author = clip(body.author, 80).replace(/^@/, '');
  if (body.caption) item.caption = clip(body.caption, 5000);
  if (body.title) item.title = clip(body.title, 300);
  if (body.summary) item.summary = clip(body.summary, 20000);
  if (body.note || body.notes) item.notes = [item.notes, body.note || body.notes].filter(Boolean).join('\n\n');
  if (body.tags) item.tags = cleanTags([...item.tags, ...cleanTags(body.tags)]);
  if (body.folder) item.folder_id = findOrCreateFolder(body.folder);
  if (body.media_type) item.media = body.media_type === 'video' ? 'video' : 'image';
  item.updated_at = now();
  commit();
  if (!duplicate || !item.thumb || body.thumbnail_url || body.image_base64) {
    item.attempts = 0;
    enqueue(item, { thumbnail_url: body.thumbnail_url, image_base64: body.image_base64 });
  }
  return [duplicate ? 200 : 201, { ok: true, duplicate, item }];
}

// ---------- routes ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

async function serveFile(res, file, cache = 'no-cache') {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
    });
    res.end(data);
  } catch { send(res, 404, 'Not found'); }
}

const attempts = new Map();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE' });
      return res.end();
    }
    if (p === '/api/health') return send(res, 200, { ok: true, items: db.items.length, persistent: PERSISTENT, queue: queue.size + running });

    if (p === '/api/setup-status') return send(res, 200, { needsSetup: !hasOwner(), persistent: PERSISTENT });
    if (p === '/api/setup' && req.method === 'POST') {
      if (hasOwner()) return send(res, 409, { error: 'A password is already set.' });
      const { key } = await readBody(req);
      if (String(key || '').length < 6) return send(res, 400, { error: 'Use at least 6 characters.' });
      S.owner_salt = crypto.randomBytes(16).toString('hex');
      S.owner_hash = hashPw(key, S.owner_salt);
      commit();
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const rec = attempts.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - rec.t > 15 * 60e3) { rec.n = 0; rec.t = Date.now(); }
      if (rec.n >= 10) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
      const { key } = await readBody(req);
      if (!isOwnerKey(key || '')) { rec.n++; attempts.set(ip, rec); return send(res, 401, { error: 'That password is not right.' }); }
      attempts.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req) });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'ml_session=; Path=/; Max-Age=0' });
    }

    if (p.startsWith('/api/') || p.startsWith('/media/')) {
      const who = whoIs(req, url);
      if (!who) return send(res, 401, { error: 'Unauthorized' });

      if (p.startsWith('/media/')) {
        const name = path.basename(p);
        return serveFile(res, path.join(MEDIA_DIR, name), 'private, max-age=31536000, immutable');
      }

      // Muse: POST /api/items  or  GET /api/ingest?url=...&key=...
      if ((p === '/api/items' && req.method === 'POST') || p === '/api/ingest') {
        const body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
        const [status, out] = await ingest(body, who);
        return send(res, status, out, { 'Access-Control-Allow-Origin': '*' });
      }
      if (p === '/api/rev') return send(res, 200, { rev: db.rev });
      if (p === '/api/export' && who === 'you') {
        const { settings, ...data } = db;
        return send(res, 200, data, { 'Content-Disposition': `attachment; filename="muse-library-${now().slice(0, 10)}.json"` });
      }
      if (p === '/api/muse' && who === 'you') {
        const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
        const base = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
        return send(res, 200, { base, key: museKey(), persistent: PERSISTENT });
      }
      if (p === '/api/muse/rotate' && req.method === 'POST' && who === 'you') {
        S.muse_key = 'muse_' + crypto.randomBytes(18).toString('base64url'); commit();
        return send(res, 200, { key: museKey() });
      }
      if (p === '/api/state' || (p === '/api/items' && req.method === 'GET')) {
        let items = db.items;
        const q = url.searchParams;
        if (q.get('folder')) items = items.filter(i => i.folder_id === q.get('folder') || db.folders.find(f => f.id === i.folder_id)?.name === q.get('folder'));
        if (q.get('unsorted') === '1') items = items.filter(i => !i.folder_id);
        if (q.get('limit')) items = items.slice(0, Number(q.get('limit')));
        return send(res, 200, { rev: db.rev, me: who, folders: [...db.folders].sort((a, b) => a.order - b.order), items });
      }

      const itemM = p.match(/^\/api\/items\/([\w-]+)(\/refresh)?$/);
      if (itemM) {
        const item = db.items.find(i => i.id === itemM[1]);
        if (!item) return send(res, 404, { error: 'No such item' });
        if (itemM[2] && req.method === 'POST') {
          const old = item.thumb;
          item.thumb = null; item.attempts = 0;
          await enrich(item, await readBody(req));
          if (!item.thumb && old) { item.thumb = old; item.status = 'ready'; item.enrich_error = null; commit(); }
          return send(res, 200, { item });
        }
        if (req.method === 'GET') return send(res, 200, { item });
        if (req.method === 'PATCH') {
          const b = await readBody(req);
          if ('folder_id' in b) item.folder_id = b.folder_id && db.folders.some(f => f.id === b.folder_id) ? b.folder_id : null;
          if ('folder' in b) item.folder_id = findOrCreateFolder(b.folder);
          for (const k of ['notes', 'summary', 'caption', 'author', 'title']) if (k in b) item[k] = clip(b[k], 20000);
          if ('starred' in b) item.starred = !!b.starred;
          if ('tags' in b) item.tags = cleanTags(b.tags);
          item.updated_at = now(); commit();
          return send(res, 200, { item });
        }
        if (req.method === 'DELETE') {
          db.items = db.items.filter(i => i !== item);
          if (item.thumb) fsp.unlink(path.join(MEDIA_DIR, path.basename(item.thumb.split('?')[0]))).catch(() => {});
          commit();
          return send(res, 200, { ok: true });
        }
      }

      if (p === '/api/items/bulk' && req.method === 'POST') {
        const b = await readBody(req);
        const ids = new Set(b.ids || []);
        const targets = db.items.filter(i => ids.has(i.id));
        if (b.action === 'delete') {
          db.items = db.items.filter(i => !ids.has(i.id));
          targets.forEach(i => i.thumb && fsp.unlink(path.join(MEDIA_DIR, path.basename(i.thumb.split('?')[0]))).catch(() => {}));
        } else {
          const fid = b.folder_id && db.folders.some(f => f.id === b.folder_id) ? b.folder_id : null;
          targets.forEach(i => { i.folder_id = fid; i.updated_at = now(); });
        }
        commit();
        return send(res, 200, { ok: true, count: targets.length });
      }

      if (p === '/api/folders' && req.method === 'POST') {
        const { name } = await readBody(req);
        if (!String(name || '').trim()) return send(res, 400, { error: 'Folder needs a name' });
        const id = findOrCreateFolder(name); commit();
        return send(res, 201, { folder: db.folders.find(f => f.id === id) });
      }
      if (p === '/api/folders/reorder' && req.method === 'POST') {
        const { ids = [] } = await readBody(req);
        ids.forEach((id, i) => { const f = db.folders.find(x => x.id === id); if (f) f.order = i; });
        commit();
        return send(res, 200, { ok: true });
      }
      const folderM = p.match(/^\/api\/folders\/([\w-]+)$/);
      if (folderM) {
        const f = db.folders.find(x => x.id === folderM[1]);
        if (!f) return send(res, 404, { error: 'No such folder' });
        if (req.method === 'PATCH') {
          const { name } = await readBody(req);
          if (String(name || '').trim()) f.name = String(name).trim().slice(0, 60);
          commit(); return send(res, 200, { folder: f });
        }
        if (req.method === 'DELETE') {
          db.folders = db.folders.filter(x => x !== f);
          db.items.forEach(i => { if (i.folder_id === f.id) i.folder_id = null; });
          commit(); return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'Unknown endpoint' });
    }

    // static UI
    const safe = path.normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, safe);
    if (file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return serveFile(res, file, safe.startsWith('/vendor/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message || 'Server error' });
  }
});

server.requestTimeout = 60e3;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Muse Library on port ${PORT}  (data: ${DATA_DIR})`);
  if (!PERSISTENT) console.warn('WARNING: no Railway volume attached. Saves will be lost on redeploy. Add a volume to this service.');
});
