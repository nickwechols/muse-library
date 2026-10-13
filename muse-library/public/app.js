// Disk command center client. Vanilla JS, no build step.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const S = {
  items: [], folders: [], feed: [], rev: 0, loaded: false,
  tab: 'today',
  lib: store.get('dk.lib', 'all'), mode: store.get('dk.mode', 'grid'), q: '',
  selecting: false, selected: new Set(), activeId: null,
  act: 'all', open: new Set(),
  known: null,
};

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin', ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) { showGate(); throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const patchItem = (id, body) => api(`/api/items/${id}`, { method: 'PATCH', body });

// ---------- time ----------
const DAY = 864e5;
function ago(iso) {
  const s = Math.max(1, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const clock = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const startOf = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
function dayLabel(iso) {
  const diff = Math.round((startOf(Date.now()) - startOf(iso)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: diff > 300 ? 'numeric' : undefined });
}
function when(iso) {
  const diff = Math.round((startOf(Date.now()) - startOf(iso)) / DAY);
  if (diff === 0) return clock(iso);
  if (diff === 1) return `Yesterday ${clock(iso)}`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function etaLabel(eta) {
  if (!eta) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(eta) ? eta + 'T12:00:00' : eta);
  if (isNaN(d)) return eta;
  const diff = Math.round((startOf(d) - startOf(Date.now())) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------- markdown (escaped first, small and safe) ----------
function inl(t) {
  return esc(t).split(/(`[^`]+`)/g).map(part => {
    if (/^`[^`]+`$/.test(part)) return `<code>${part.slice(1, -1)}</code>`;
    return part
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  }).join('');
}
const LIST = /^\s*([-*+]|\d+[.)])\s+/;
function md(src = '') {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue;
    }
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { out.push(`<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`); continue;
    }
    if (LIST.test(l)) {
      const ordered = /^\s*\d/.test(l); const items = [];
      while (i < lines.length && LIST.test(lines[i])) {
        let t = lines[i++].replace(LIST, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST.test(lines[i])) t += '\n' + lines[i++].trim();
        items.push(`<li>${inl(t).replace(/\n/g, '<br>')}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`); continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && /^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]))) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inl).join('<br>')}</p>`);
  }
  return out.join('');
}
const plain = s => String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^#+\s+/gm, '').replace(/[*_`~>]/g, '').replace(/\s+/g, ' ').trim();

// ---------- ui helpers ----------
function toast(msg, icon = 'ph-check-circle') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<i class="ph-fill ${icon}"></i><span>${esc(msg)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2400);
}
async function copyText(text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(msg, 'ph-copy');
}
function ask({ title, label, value = '', help = '', ok = 'Save', placeholder = '' }) {
  const d = $('#dialog');
  $('#dialogTitle').textContent = title; $('#dialogLabel').textContent = label;
  $('#dialogHelp').textContent = help; $('#dialogOk').textContent = ok;
  const input = $('#dialogInput'); input.value = value; input.placeholder = placeholder;
  d.showModal(); setTimeout(() => input.select(), 30);
  return new Promise(r => d.addEventListener('close', () => r(d.returnValue === 'ok' ? input.value.trim() : null), { once: true }));
}

// ---------- records ----------
const KIND = {
  briefing: { label: 'Briefing', icon: 'ph-sun-horizon' },
  email_alert: { label: 'Email', icon: 'ph-envelope-simple' },
  package_update: { label: 'Package', icon: 'ph-package' },
  digest: { label: 'Digest', icon: 'ph-article' },
  library: { label: 'Library', icon: 'ph-bookmark-simple' },
};
const byTime = (a, b) => (b.timestamp || '').localeCompare(a.timestamp || '');
const feedOf = type => S.feed.filter(r => r.type === type).sort(byTime);
const recLink = r => `#/r/${encodeURIComponent(r.key)}`;
const pkgLink = tn => `#/p/${encodeURIComponent(tn)}`;
function pkgState(status = '') {
  const s = status.toLowerCase();
  if (/exception|delay|fail|return|hold|issue|problem|lost|damag/.test(s)) return 'problem';
  if (/out for delivery/.test(s)) return 'out';
  if (/deliver/.test(s)) return 'delivered';
  return 'transit';
}
const PKG_ICON = { problem: 'ph-warning', out: 'ph-truck', delivered: 'ph-check', transit: 'ph-package' };
function packages() {
  const groups = new Map();
  for (const r of feedOf('package_update')) {
    if (!groups.has(r.tracking_number)) groups.set(r.tracking_number, []);
    groups.get(r.tracking_number).push(r);
  }
  return [...groups.entries()].map(([tn, events]) => {
    const latest = events[0];
    const eta = events.find(e => e.eta)?.eta;
    return { tn, events, latest, eta, state: pkgState(latest.status) };
  });
}
const unreadMail = () => feedOf('email_alert').filter(r => !r.read);

// ---------- library helpers ----------
const folderName = id => S.folders.find(f => f.id === id)?.name;
const firstSentence = t => (String(t).trim().match(/^[\s\S]{1,220}?[.!?](?=\s|$)/) || [String(t).trim().split('\n')[0].slice(0, 160)])[0].trim();
function hookOf(i) {
  const t = (i.transcript || '').trim();
  if (i.hook) {
    let body = t;
    const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const first = firstSentence(body);
    if (norm(first) && norm(first) === norm(i.hook)) body = body.slice(first.length).trim();
    return { hook: i.hook.trim(), body };
  }
  if (!t) return { hook: '', body: '' };
  const h = firstSentence(t);
  return { hook: h, body: t.slice(h.length).trim() };
}
const headline = i => i.hook || hookOf(i).hook || i.title || i.caption || '';
const words = t => (String(t || '').trim().match(/\S+/g) || []).length;
const spoken = n => { const sec = Math.max(1, Math.round(n / 2.5)); return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const scriptMeta = i => { const n = words(i.transcript); return n ? `${n} words, ${spoken(n)}` : ''; };
function libMatches(i) {
  const v = S.lib;
  if (v === 'inbox' && i.folder_id) return false;
  if (v === 'starred' && !i.starred) return false;
  if (v.startsWith('folder:') && i.folder_id !== v.slice(7)) return false;
  if (!S.q) return true;
  const hay = [i.title, i.hook, i.summary, i.transcript, i.author, i.caption, i.notes, folderName(i.folder_id), ...(i.tags || []).map(t => '#' + t + ' ' + t)].join(' ').toLowerCase();
  return S.q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}
const libVisible = () => S.items.filter(libMatches).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
function libTitle() {
  const v = S.lib;
  if (v === 'all') return 'All';
  if (v === 'inbox') return 'Unfiled';
  if (v === 'starred') return 'Starred';
  return folderName(v.slice(7)) || 'Folder';
}
const withScripts = list => list.filter(i => (i.transcript || '').trim());
function scriptBlock(i) {
  const head = [i.author ? '@' + i.author : i.source, folderName(i.folder_id)].filter(Boolean).join(' / ');
  const { hook } = hookOf(i);
  return [i.title && i.title !== hook ? i.title : '', head, i.url, '', hook ? `HOOK: ${hook}\n` : '', (i.transcript || '').trim()]
    .filter((x, n) => x || n === 3).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// =====================================================================
// Routing: #/today  #/library  #/library/<itemId>  #/activity  #/activity/<filter>
//          #/r/<record key>  #/p/<tracking number>   (sheets over the current tab)
// =====================================================================
let pushedDetail = 0;
function nav(hash) { if (location.hash !== hash) { pushedDetail++; location.hash = hash; } else route(); }
function closeDetail() {
  if (pushedDetail > 0) { pushedDetail--; history.back(); }
  else { history.replaceState(null, '', `#/${S.tab}`); route(); }
}
function route() {
  const h = decodeURI(location.hash.replace(/^#\/?/, ''));
  const [head, ...rest] = h.split('/');
  const arg = rest.join('/');
  let sheet = null, item = null;
  if (head === 'r' || head === 'p') sheet = { kind: head, key: decodeURIComponent(arg) };
  else if (['today', 'library', 'activity'].includes(head)) {
    S.tab = head;
    if (head === 'library' && arg) item = arg;
    if (head === 'activity' && arg && KIND[arg]) S.act = arg;
  } else if (!h) { S.tab = 'today'; }
  if (S.tab !== 'library' && S.selecting) toggleSelecting(false);
  S.activeId = item;
  renderTabs();
  renderView();
  renderDrawer();
  renderSheet(sheet);
}
function renderTabs() {
  $$('.tab').forEach(t => t.dataset.tab === S.tab ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current'));
  $$('.view').forEach(v => { v.hidden = v.dataset.view !== S.tab; });
  const n = unreadMail().length;
  $('[data-badge="today"]').textContent = n ? (n > 9 ? '9+' : n) : '';
  document.title = `${{ today: 'Today', library: libTitle(), activity: 'Activity' }[S.tab]} - Disk`;
}
let lastTab = null;
function renderView() {
  if (!S.loaded) return;
  if (S.tab === 'today') renderToday();
  if (S.tab === 'library') renderLibrary();
  if (S.tab === 'activity') renderActivity();
  if (lastTab !== S.tab) { window.scrollTo({ top: 0 }); lastTab = S.tab; }
}

// =====================================================================
// Today
// =====================================================================
function renderToday() {
  $('#todayDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const latest = [...S.feed.map(r => r.received_at || r.timestamp), ...S.items.filter(i => i.added_by === 'muse').map(i => i.updated_at || i.created_at)].sort().pop();
  $('#todayStatus').textContent = latest ? `Last update from Disk ${ago(latest)}` : 'Nothing from Disk yet. Use the plug icon to connect it.';

  // packages: everything not delivered, plus deliveries from the last 3 days
  const pk = packages().filter(p => p.state !== 'delivered' || Date.now() - new Date(p.latest.timestamp) < 3 * DAY)
    .sort((a, b) => ({ problem: 0, out: 1, transit: 2, delivered: 3 }[a.state] - { problem: 0, out: 1, transit: 2, delivered: 3 }[b.state]));
  $('#packages').innerHTML = pk.map(p => `<a class="pkg ${p.state}" href="${pkgLink(p.tn)}">
      <span class="pkg-icon"><i class="ph ${PKG_ICON[p.state]}"></i></span>
      <span class="pkg-status">${esc(p.latest.status)}</span>
      <span class="pkg-sub"><span>${esc(p.tn)}</span>${p.eta && p.state !== 'delivered' ? `<span>ETA ${esc(etaLabel(p.eta))}</span>` : `<span>${esc(when(p.latest.timestamp))}</span>`}</span>
    </a>`).join('');

  // briefing
  const b = feedOf('briefing')[0];
  if (!b) {
    $('#briefing').innerHTML = `<div class="brief-empty"><h2>No briefing yet</h2><p>Disk's morning briefing shows up here.</p></div>`;
  } else {
    const long = (b.body || '').length > 700;
    const older = feedOf('briefing').length > 1;
    $('#briefing').innerHTML = `<article class="brief">
      <div class="brief-meta"><i class="ph ph-sun-horizon"></i><span>Briefing, ${esc(when(b.timestamp))}</span></div>
      <h2>${esc(b.title)}</h2>
      <div class="brief-body md${long ? ' fade' : ''}">${md(b.body)}</div>
      ${b.sections?.length ? `<div class="brief-sections">${b.sections.map((s, n) => `<details${n === 0 ? ' open' : ''}><summary>${esc(s.heading)}<i class="ph ph-caret-down"></i></summary><div class="md">${md(s.body)}</div></details>`).join('')}</div>` : ''}
      <div class="brief-foot">
        <a class="link-btn" href="${recLink(b)}" data-push><i class="ph ph-arrows-out-simple"></i>Read full</a>
        ${older ? `<a class="link-btn" href="#/activity/briefing"><i class="ph ph-clock-counter-clockwise"></i>Earlier briefings</a>` : ''}
      </div>
    </article>`;
  }

  // email
  const mail = feedOf('email_alert');
  const unread = mail.filter(r => !r.read);
  $('#inboxCount').textContent = unread.length ? `${unread.length} unread` : '';
  $('#markAllRead').hidden = !unread.length;
  const show = unread.length ? unread : [];
  $('#inbox').innerHTML = show.length
    ? show.slice(0, 8).map(mailRow).join('') + (unread.length > 8 ? `<a class="mail" href="#/activity/email_alert"><span></span><span class="mail-subj">${unread.length - 8} more in Activity</span></a>` : '')
    : `<p class="inbox-empty">${mail.length ? 'All caught up.' : 'Customer emails Disk flags will show up here.'}${mail.length ? ' <a class="link-btn" href="#/activity/email_alert">See all</a>' : ''}</p>`;

  // recent library
  const recent = [...S.items].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 4);
  $('#recent').innerHTML = recent.length
    ? recent.map(i => `<a href="#/library/${i.id}" data-push title="${esc(headline(i).slice(0, 120))}">${i.thumb ? `<img src="${esc(i.thumb)}" alt="" loading="lazy">` : '<span><i class="ph ph-film-strip"></i></span>'}</a>`).join('')
    : `<p class="recent-empty">Send Disk a reel and it lands here.</p>`;
}
function mailRow(r) {
  return `<a class="mail${r.read ? ' read' : ''}" href="${recLink(r)}" data-push>
    <span class="mail-dot"></span>
    <span class="mail-from">${esc(r.from.replace(/\s*<[^>]+>\s*$/, ''))}</span>
    <span class="mail-time">${esc(when(r.timestamp))}</span>
    <span class="mail-subj">${r.needs_reply ? '<span class="tag-reply">Reply</span>' : ''}${esc(r.subject)}</span>
    <span class="mail-snip">${esc(plain(r.snippet))}</span>
  </a>`;
}

// =====================================================================
// Sheet: one record or one package
// =====================================================================
let sheetFor = null;
function renderSheet(target) {
  const el = $('#sheet');
  if (!target || !S.loaded) { el.hidden = true; sheetFor = null; syncScrim(); return; }
  let html = '', kind = '', copy = '';
  if (target.kind === 'p') {
    const p = packages().find(x => x.tn === target.key);
    if (!p) { el.hidden = true; return; }
    kind = 'Package';
    const l = p.latest;
    html = `<h1>${esc(l.status)}</h1>
      <p class="meta">Updated ${esc(ago(l.timestamp))}</p>
      <dl class="kv">
        <div><dt>Tracking</dt><dd><code>${esc(p.tn)}</code><button class="link-btn" data-copy="${esc(p.tn)}"><i class="ph ph-copy"></i></button></dd></div>
        ${p.eta ? `<div><dt>ETA</dt><dd>${esc(etaLabel(p.eta))}</dd></div>` : ''}
        ${l.location ? `<div><dt>Location</dt><dd>${esc(l.location)}</dd></div>` : ''}
      </dl>
      <ol class="tl">${p.events.map(e => `<li><span class="tl-status">${esc(e.status)}</span><span class="tl-meta">${esc(when(e.timestamp))}${e.location ? ', ' + esc(e.location) : ''}</span><div class="md">${md(e.detail)}</div></li>`).join('')}</ol>`;
    copy = `${p.tn}\n${l.status}${p.eta ? `\nETA ${p.eta}` : ''}`;
  } else {
    const r = S.feed.find(x => x.key === target.key);
    if (!r) { el.hidden = true; return; }
    kind = `${KIND[r.type]?.label || r.type}, ${when(r.timestamp)}`;
    if (r.type === 'email_alert') {
      html = `<h1>${esc(r.subject)}</h1>
        <dl class="kv">
          <div><dt>From</dt><dd>${esc(r.from)}</dd></div>
          <div><dt>Received</dt><dd>${esc(new Date(r.timestamp).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</dd></div>
          ${r.needs_reply ? `<div><dt>Status</dt><dd>Needs a reply</dd></div>` : ''}
          ${r.thread_id ? `<div><dt>Thread</dt><dd><code>${esc(r.thread_id)}</code></dd></div>` : ''}
        </dl>
        <div class="md">${md(r.snippet)}</div>
        <div class="ev-actions"><button class="link-btn" data-unread="${esc(r.key)}"><i class="ph ph-envelope-simple"></i>Mark unread</button></div>`;
      copy = `${r.from}\n${r.subject}\n\n${r.snippet}`;
      if (!r.read) markRead([r.key]);
    } else if (r.type === 'package_update') {
      return renderSheet({ kind: 'p', key: r.tracking_number });
    } else {
      html = `<h1>${esc(r.title)}</h1><div class="md">${md(r.body)}</div>` +
        (r.sections || []).map(s => `<section class="sheet-section"><h2>${esc(s.heading)}</h2><div class="md">${md(s.body)}</div></section>`).join('');
      copy = [r.title, '', r.body, ...(r.sections || []).flatMap(s => ['', s.heading, s.body])].join('\n');
    }
  }
  $('#sheetKind').textContent = kind;
  $('#sheetBody').innerHTML = html;
  $('#sheetCopy').onclick = () => copyText(copy);
  const fresh = sheetFor !== target.kind + target.key;
  sheetFor = target.kind + target.key;
  el.hidden = false;
  if (fresh) $('#sheetBody').scrollTop = 0;
  syncScrim();
}
async function markRead(keys, read = true) {
  keys.forEach(k => { const r = S.feed.find(x => x.key === k); if (r) r.read = read; });
  renderTabs(); if (S.tab === 'today') renderToday(); if (S.tab === 'activity') renderActivity();
  try { for (const k of keys) await api(`/api/feed/${encodeURIComponent(k)}`, { method: 'PATCH', body: { read } }); } catch (e) { console.warn(e); }
}
function syncScrim() { $('#scrim').classList.toggle('open', !$('#sheet').hidden || !$('#drawer').hidden); }

// =====================================================================
// Activity
// =====================================================================
const ACT_FILTERS = [['all', 'All'], ['briefing', 'Briefings'], ['email_alert', 'Email'], ['package_update', 'Packages'], ['digest', 'Digests'], ['library', 'Library']];
function activityEvents() {
  const lib = S.items.map(i => ({ key: 'lib:' + i.id, type: 'library', timestamp: i.created_at, item: i }));
  return [...S.feed, ...lib].filter(e => S.act === 'all' || e.type === S.act).sort(byTime);
}
function evTitle(e) {
  switch (e.type) {
    case 'briefing': case 'digest': return e.title;
    case 'email_alert': return e.subject;
    case 'package_update': return `${e.status}`;
    case 'library': return headline(e.item) || 'Saved post';
  }
}
function evSub(e) {
  switch (e.type) {
    case 'briefing': case 'digest': return plain(e.body).slice(0, 160);
    case 'email_alert': return `${e.from.replace(/\s*<[^>]+>\s*$/, '')}: ${plain(e.snippet).slice(0, 140)}`;
    case 'package_update': return [e.tracking_number, e.location, plain(e.detail).slice(0, 80)].filter(Boolean).join(', ');
    case 'library': return [e.item.author ? '@' + e.item.author : '', folderName(e.item.folder_id) ? `Saved to ${folderName(e.item.folder_id)}` : 'Saved'].filter(Boolean).join(', ');
  }
}
function evBody(e) {
  switch (e.type) {
    case 'briefing': case 'digest':
      return `<div class="md">${md(e.body)}</div>${(e.sections || []).map(s => `<section class="sheet-section"><h2>${esc(s.heading)}</h2><div class="md">${md(s.body)}</div></section>`).join('')}
        <div class="ev-actions"><a class="link-btn" href="${recLink(e)}" data-push><i class="ph ph-arrows-out-simple"></i>Open</a></div>`;
    case 'email_alert':
      return `<dl class="kv"><div><dt>From</dt><dd>${esc(e.from)}</dd></div>${e.needs_reply ? '<div><dt>Status</dt><dd>Needs a reply</dd></div>' : ''}${e.thread_id ? `<div><dt>Thread</dt><dd><code>${esc(e.thread_id)}</code></dd></div>` : ''}</dl>
        <div class="md">${md(e.snippet)}</div>`;
    case 'package_update':
      return `<dl class="kv"><div><dt>Tracking</dt><dd><code>${esc(e.tracking_number)}</code></dd></div>${e.eta ? `<div><dt>ETA</dt><dd>${esc(etaLabel(e.eta))}</dd></div>` : ''}${e.location ? `<div><dt>Location</dt><dd>${esc(e.location)}</dd></div>` : ''}</dl>
        <div class="md">${md(e.detail)}</div>
        <div class="ev-actions"><a class="link-btn" href="${pkgLink(e.tracking_number)}" data-push><i class="ph ph-path"></i>Full history</a></div>`;
    case 'library': {
      const i = e.item;
      return `${i.title && i.title !== headline(i) ? `<p class="md"><strong>${esc(i.title)}</strong></p>` : ''}
        ${i.summary ? `<div class="rbox-read">${breakdownHTML(i.summary)}</div>` : ''}
        <div class="ev-actions"><a class="link-btn" href="#/library/${i.id}" data-push><i class="ph ph-books"></i>Open in library</a><a class="link-btn" href="${esc(i.url)}" target="_blank" rel="noopener"><i class="ph ph-arrow-up-right"></i>Source</a></div>`;
    }
  }
}
function renderActivity() {
  $('#actFilters').innerHTML = ACT_FILTERS.map(([k, label]) => {
    const n = k === 'email_alert' ? unreadMail().length : 0;
    return `<button class="chip" data-act="${k}" aria-pressed="${S.act === k}">${label}${n ? `<em>${n}</em>` : ''}</button>`;
  }).join('');
  const evs = activityEvents();
  let html = '', day = '';
  for (const e of evs) {
    const d = dayLabel(e.timestamp);
    if (d !== day) { html += `<div class="day">${esc(d)}</div>`; day = d; }
    const open = S.open.has(e.key);
    const unread = e.type === 'email_alert' && !e.read;
    html += `<div class="ev${unread ? ' unread' : ''}" data-ev="${esc(e.key)}">
      <button class="ev-row" data-toggle="${esc(e.key)}" aria-expanded="${open}">
        <span class="ev-icon"><i class="ph ${e.type === 'package_update' ? PKG_ICON[pkgState(e.status)] : KIND[e.type].icon}"></i></span>
        <span class="ev-title">${e.type === 'email_alert' && e.needs_reply ? '<span class="tag-reply">Reply</span>' : ''}${esc(evTitle(e))}</span>
        <span class="ev-time">${esc(clock(e.timestamp))}</span>
        <span class="ev-sub">${esc(evSub(e))}</span>
      </button>
      ${open ? `<div class="ev-body">${evBody(e)}</div>` : ''}
    </div>`;
  }
  $('#feed').innerHTML = html;
  const em = $('#actEmpty');
  em.hidden = !!evs.length;
  if (!evs.length) em.innerHTML = `<i class="ph ph-pulse"></i><h2>Nothing here yet</h2><p>Everything Disk sends, newest first.</p>`;
}

// =====================================================================
// Library
// =====================================================================
function renderLibrary() {
  const counts = { all: S.items.length, inbox: S.items.filter(i => !i.folder_id).length, starred: S.items.filter(i => i.starred).length };
  $$('[data-count]').forEach(el => { el.textContent = counts[el.dataset.count] || ''; });
  $$('.rail-item[data-lib]').forEach(b => b.classList.toggle('active', b.dataset.lib === S.lib));
  $('#folderList').innerHTML = S.folders.length ? S.folders.map(f => {
    const n = S.items.filter(i => i.folder_id === f.id).length;
    return `<div class="folder-row"><button class="rail-item${S.lib === 'folder:' + f.id ? ' active' : ''}" data-lib="folder:${f.id}" data-drop="${f.id}"><i class="ph ph-folder-simple"></i><span>${esc(f.name)}</span><em>${n || ''}</em></button>
      <button class="icon-btn sm folder-menu" data-folder-menu="${f.id}" aria-label="Edit ${esc(f.name)}"><i class="ph ph-dots-three"></i></button></div>`;
  }).join('') : `<div class="folder-empty">Disk creates folders as it sorts. You can add your own too.</div>`;

  const chip = (k, label, n) => `<button class="chip" data-lib="${k}" aria-pressed="${S.lib === k}">${esc(label)}${n ? `<em>${n}</em>` : ''}</button>`;
  const active = S.lib.startsWith('folder:') ? S.lib.slice(7) : null;
  $('#folderChips').innerHTML = chip('all', 'All', counts.all) + chip('inbox', 'Unfiled', counts.inbox) + (counts.starred ? chip('starred', 'Starred', counts.starred) : '') +
    S.folders.map(f => chip('folder:' + f.id, f.name, S.items.filter(i => i.folder_id === f.id).length)).join('') +
    (active ? `<button class="chip" data-folder-menu="${active}" aria-label="Edit folder"><i class="ph ph-pencil-simple"></i>Edit</button>` : '') +
    `<button class="chip" data-new-folder aria-label="New folder"><i class="ph ph-plus"></i></button>`;

  const list = libVisible();
  $('#libTitle').textContent = libTitle();
  $('#libCount').textContent = list.length || '';
  $$('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === S.mode));
  $('#selectBtn span').textContent = S.selecting ? 'Done' : 'Select';
  const scripts = S.mode === 'scripts';
  $('#grid').hidden = scripts; $('#scripts').hidden = !scripts;
  if (scripts) renderScripts(list);
  else {
    $('#scriptsBar').hidden = true;
    $('#grid').classList.toggle('selecting', S.selecting);
    $('#grid').innerHTML = list.map(cardHTML).join('');
    libEmpty(list.length, false);
  }
  renderSelbar();
}
function cardHTML(i, idx) {
  const h = headline(i);
  const thumb = i.thumb
    ? `<img src="${esc(i.thumb)}" alt="${esc(h.slice(0, 100) || 'Saved post')}" loading="lazy" decoding="async">`
    : i.status === 'pending' ? '' : `<span class="ph-glyph"><i class="ph ${i.kind === 'link' ? 'ph-link' : 'ph-image-broken'}"></i></span>`;
  const fresh = S.known && !S.known.has(i.id);
  const folder = i.folder_id && !S.lib.startsWith('folder:') ? `<span class="f"><i class="ph ph-folder-simple"></i>${esc(folderName(i.folder_id))}</span>` : '';
  const tags = (i.tags || []).slice(0, 2).map(t => `<span>#${esc(t)}</span>`).join('');
  const flags = `${i.starred ? '<i class="ph-fill ph-star"></i>' : ''}${i.transcript ? '<i class="ph ph-text-align-left" title="Has transcript"></i>' : ''}${i.notes ? '<i class="ph ph-note-pencil" title="Has notes"></i>' : ''}`;
  return `<button class="card${i.id === S.activeId ? ' active' : ''}${S.selected.has(i.id) ? ' selected' : ''}" data-id="${i.id}" draggable="true" style="--i:${fresh ? 0 : Math.min(idx, 20)}">
    <div class="thumb${!i.thumb && i.status === 'pending' ? ' loading' : ''}">${thumb}${i.media === 'video' ? '<span class="play"><i class="ph-fill ph-play"></i></span>' : ''}</div>
    <span class="check"><i class="ph ph-check"></i></span>
    <div class="card-body">
      <p class="card-hook${h ? '' : ' muted'}">${esc(h) || (i.status === 'pending' ? 'Fetching preview' : 'No hook yet')}</p>
      <div class="card-meta">${folder}${tags}${flags ? `<span class="flags">${flags}</span>` : ''}</div>
    </div>
  </button>`;
}
function libEmpty(count, scripts) {
  const el = $('#libEmpty');
  el.hidden = count > 0;
  if (count) return;
  let icon = 'ph-books', h = 'Nothing saved yet', p = 'Send Disk an Instagram reel or post and it shows up here, sorted into a folder.';
  if (S.q) { icon = 'ph-magnifying-glass'; h = 'Nothing matches'; p = `No saved posts match "${esc(S.q)}" here.`; }
  else if (scripts && libVisible().length) { icon = 'ph-text-align-left'; h = 'No transcripts here yet'; p = 'When Disk transcribes a reel, its transcript shows up here.'; }
  else if (S.lib.startsWith('folder:')) { icon = 'ph-folder-simple'; h = 'This folder is empty'; p = 'Drag posts onto it, or pick it from the Folder menu inside a post.'; }
  else if (S.lib === 'starred') { icon = 'ph-star'; h = 'No starred posts'; p = 'Star the ones you keep coming back to.'; }
  else if (S.lib === 'inbox') { icon = 'ph-tray'; h = 'Everything is filed'; p = 'Posts Disk could not place in a folder land here.'; }
  el.innerHTML = `<i class="ph ${icon}"></i><h2>${h}</h2><p>${p}</p>`;
}
const openRows = new Set();
function scriptRowHTML(i) {
  const { hook, body } = hookOf(i);
  const long = body.length > 420, open = openRows.has(i.id), folder = folderName(i.folder_id);
  return `<article class="srow${i.id === S.activeId ? ' active' : ''}" data-row="${i.id}">
    <button class="srow-thumb" data-open="${i.id}" aria-label="Open post">${i.thumb ? `<img src="${esc(i.thumb)}" alt="" loading="lazy" decoding="async">` : '<i class="ph ph-film-strip"></i>'}${i.media === 'video' ? '<span class="srow-len">' + spoken(words(i.transcript)) + '</span>' : ''}</button>
    <div class="srow-main">
      <div class="srow-meta"><span class="srow-author">${i.author ? '@' + esc(i.author) : esc(i.source || 'post')}</span>${folder && !S.lib.startsWith('folder:') ? `<span>${esc(folder)}</span>` : ''}</div>
      <button class="srow-hook" data-open="${i.id}">${esc(hook)}</button>
      ${body ? `<p class="srow-text${long && !open ? ' clamp' : ''}">${esc(body)}</p>` : ''}
      <div class="srow-actions">
        <button class="link-btn" data-copy-script="${i.id}"><i class="ph ph-copy"></i>Copy</button>
        ${long ? `<button class="link-btn" data-expand="${i.id}"><i class="ph ${open ? 'ph-arrows-in-line-vertical' : 'ph-arrows-out-line-vertical'}"></i>${open ? 'Less' : 'Full transcript'}</button>` : ''}
        <a class="link-btn" href="${esc(i.url)}" target="_blank" rel="noopener"><i class="ph ph-arrow-up-right"></i>Source</a>
      </div>
    </div>
  </article>`;
}
function renderScripts(list) {
  const have = withScripts(list);
  const missing = list.filter(i => i.media === 'video' && !(i.transcript || '').trim()).length;
  const total = have.reduce((n, i) => n + words(i.transcript), 0);
  $('#scriptsBar').hidden = !have.length;
  $('#scriptsInfo').innerHTML = `<strong>${have.length} transcript${have.length === 1 ? '' : 's'}</strong><span>${total.toLocaleString()} words</span>${missing ? `<span>${missing} waiting on Disk</span>` : ''}`;
  $('#scripts').innerHTML = have.map(scriptRowHTML).join('');
  libEmpty(have.length, true);
}
function allScriptsText() {
  const have = withScripts(libVisible());
  const title = `${libTitle()} transcripts (${have.length})`;
  return [title, '='.repeat(title.length), '', have.map(scriptBlock).join('\n\n----------\n\n')].join('\n') + '\n';
}
function renderSelbar() {
  $('#selbar').hidden = !S.selecting;
  $('#selCount').textContent = `${S.selected.size} selected`;
  $('#selMove').innerHTML = `<option value="">Move to</option><option value="__inbox">Unfiled</option>` + S.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
}
function setLib(v) { S.lib = v; store.set('dk.lib', v); S.selected.clear(); renderLibrary(); window.scrollTo({ top: 0 }); }
function setMode(m) { S.mode = m; store.set('dk.mode', m); if (m === 'scripts' && S.selecting) toggleSelecting(false); renderLibrary(); }
function toggleSelecting(on = !S.selecting) { S.selecting = on; if (!on) S.selected.clear(); if (S.tab === 'library') renderLibrary(); else renderSelbar(); }

// ---------- library item drawer ----------
let drawerFor = null;
const editing = { transcript: false, summary: false };
const BOX = {
  transcript: { empty: i => i.media === 'video' ? 'No transcript yet. Disk adds it when it transcribes the reel.' : 'No transcript for this post.', add: 'Paste one' },
  summary: { empty: () => 'No breakdown yet. Disk writes one when it saves a post.', add: 'Write one' },
};
const box = (k, sel) => $(`.rbox[data-box="${k}"] ${sel}`);
const BREAK_LABELS = /(?:^|\n|(?<=[.!?])\s+)\s*[-*]?\s*\**(hook|format|structure|pacing|visuals?|audio|cta|why it works|what to steal)\**\s*:\s*\**/gi;
function breakdownHTML(text) {
  const parts = [...text.matchAll(BREAK_LABELS)];
  if (parts.length < 2) return `<div class="md">${md(text)}</div>`;
  const lead = text.slice(0, parts[0].index).trim();
  const rows = parts.map((m, n) => {
    const val = text.slice(m.index + m[0].length, n + 1 < parts.length ? parts[n + 1].index : undefined).trim();
    const label = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `<div><dt>${esc(label)}</dt><dd>${inl(val)}</dd></div>`;
  }).join('');
  return `${lead ? `<div class="md">${md(lead)}</div>` : ''}<dl class="bd">${rows}</dl>`;
}
function renderBox(i, k) {
  const val = (i[k] || '').trim(), on = editing[k];
  const input = box(k, '.rbox-input'), read = box(k, '.rbox-read');
  if (document.activeElement !== input) box(k, '.rbox-meta').textContent = k === 'transcript' && val ? scriptMeta(i) : '';
  box(k, '[data-box-copy]').hidden = !val || on;
  box(k, '[data-box-edit]').hidden = !val && !on;
  box(k, '[data-box-edit]').innerHTML = `<i class="ph ${on ? 'ph-check' : 'ph-pencil-simple'}"></i>`;
  input.hidden = !on; read.hidden = on;
  if (on) { if (document.activeElement !== input) input.value = i[k] || ''; return; }
  read.classList.toggle('empty', !val);
  if (!val) { read.innerHTML = `<p>${BOX[k].empty(i)}</p><button class="btn btn-sm" data-box-add><i class="ph ph-plus"></i><span>${BOX[k].add}</span></button>`; return; }
  if (k === 'summary') { read.innerHTML = breakdownHTML(val); return; }
  const { hook, body } = hookOf(i);
  read.innerHTML = `<p class="rbox-hook">${esc(hook)}</p>${body ? `<p class="rbox-text">${esc(body)}</p>` : ''}`;
}
function toggleBox(k, on = !editing[k]) {
  const i = S.items.find(x => x.id === S.activeId); if (!i) return;
  if (!on && editing[k]) {
    const v = box(k, '.rbox-input').value;
    clearTimeout(timers[k]);
    if (v !== (i[k] || '')) { i[k] = v; patchItem(i.id, { [k]: v }).catch(e => toast(e.message, 'ph-warning')); }
  }
  editing[k] = on;
  renderBox(i, k);
  if (on) { const el = box(k, '.rbox-input'); el.value = i[k] || ''; el.focus(); }
}
function renderDrawer() {
  const i = S.items.find(x => x.id === S.activeId);
  const d = $('#drawer');
  if (!i) { d.hidden = true; drawerFor = null; syncScrim(); return; }
  d.hidden = false;
  const fresh = drawerFor !== i.id;
  drawerFor = i.id;
  $('#dOpen').href = i.url;
  $('#dOpen span').textContent = i.source === 'instagram' ? 'Instagram' : 'Open';
  $('#dStar').innerHTML = `<i class="${i.starred ? 'ph-fill' : 'ph'} ph-star"></i>`;
  $('#dStar').classList.toggle('on', i.starred);
  const a = $('#dAuthor');
  a.textContent = i.author ? '@' + i.author : (i.source || '');
  a.href = i.author && i.source === 'instagram' ? `https://www.instagram.com/${i.author}/` : i.url;
  $('#dDate').textContent = `${i.added_by === 'muse' ? 'Disk' : 'You'}, ${ago(i.created_at)}`;
  $('#dTitle').textContent = i.title || '';
  $('#dTitle').hidden = !i.title;
  $('#dCaption').textContent = i.caption || '';
  $('#dCaption').hidden = !i.caption;
  $('#dFolder').innerHTML = `<option value="">Unfiled</option>` + S.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('') + `<option value="__new">New folder</option>`;
  $('#dFolder').value = i.folder_id || '';
  $$('#dTags .tag').forEach(t => t.remove());
  $('#dTagInput').insertAdjacentHTML('beforebegin', (i.tags || []).map(t => `<span class="tag">#${esc(t)}<button data-untag="${esc(t)}" aria-label="Remove ${esc(t)}"><i class="ph ph-x"></i></button></span>`).join(''));
  if (fresh || document.activeElement !== $('#dNotes')) $('#dNotes').value = i.notes || '';
  if (fresh) { editing.transcript = editing.summary = false; $('#dCaption').classList.add('clamp'); $('.drawer-body').scrollTop = 0; }
  renderBox(i, 'summary'); renderBox(i, 'transcript');
  if (fresh) { $('#notesSaved').textContent = ''; renderMedia(i); }
  else if (!$('#dMedia iframe')) renderMedia(i);
  $$('.card').forEach(c => c.classList.toggle('active', c.dataset.id === i.id));
  syncScrim();
}
function renderMedia(i) {
  const m = $('#dMedia');
  m.classList.remove('embed');
  const canEmbed = i.source === 'instagram' && i.shortcode;
  if (i.thumb) m.innerHTML = `<img src="${esc(i.thumb)}" alt="">${canEmbed ? `<button class="play-big" data-embed><i class="ph-fill ph-play"></i>${i.media === 'video' ? 'Play here' : 'View post'}</button>` : ''}`;
  else m.innerHTML = `<div class="no-prev"><i class="ph ph-image-broken"></i><span>${i.status === 'pending' ? 'Fetching preview' : 'No preview yet. Try refresh, or open the post.'}</span>${canEmbed ? '<button class="btn btn-sm" data-embed><i class="ph ph-play"></i><span>Load embed</span></button>' : ''}</div>`;
}
function embed(i) {
  const m = $('#dMedia'); m.classList.add('embed');
  m.innerHTML = `<iframe src="https://www.instagram.com/${i.kind === 'reel' ? 'reel' : 'p'}/${i.shortcode}/embed/" allow="autoplay; encrypted-media; clipboard-write" allowfullscreen loading="lazy" title="Instagram post"></iframe>`;
}
const timers = {};
function autosave(key, el, flag) {
  clearTimeout(timers[key]);
  $(flag).textContent = 'Editing';
  const id = S.activeId;
  timers[key] = setTimeout(async () => {
    const it = S.items.find(x => x.id === id); if (!it) return;
    it[key] = el.value;
    try { await patchItem(id, { [key]: el.value }); $(flag).textContent = 'Saved'; }
    catch (e) { $(flag).textContent = 'Not saved'; toast(e.message, 'ph-warning'); }
  }, 600);
}

// ---------- library mutations ----------
async function moveItems(ids, folderId) {
  const fid = folderId || null;
  ids.forEach(id => { const it = S.items.find(x => x.id === id); if (it) it.folder_id = fid; });
  renderLibrary(); renderDrawer();
  await api('/api/items/bulk', { method: 'POST', body: { ids, folder_id: fid } });
  toast(`${ids.length > 1 ? ids.length + ' posts moved' : 'Moved'} to ${fid ? folderName(fid) : 'Unfiled'}`, 'ph-folder-simple');
}
async function deleteItems(ids) {
  if (!confirm(ids.length > 1 ? `Delete ${ids.length} posts?` : 'Delete this post?')) return;
  S.items = S.items.filter(i => !ids.includes(i.id));
  ids.forEach(id => S.selected.delete(id));
  if (ids.includes(S.activeId)) closeDetail();
  renderLibrary();
  await api('/api/items/bulk', { method: 'POST', body: { ids, action: 'delete' } });
}
async function newFolder() {
  const name = await ask({ title: 'New folder', label: 'Name', placeholder: 'Hooks, Founder content, Fits', ok: 'Create' });
  if (!name) return null;
  const { folder } = await api('/api/folders', { method: 'POST', body: { name } });
  if (!S.folders.some(f => f.id === folder.id)) S.folders.push(folder);
  renderLibrary();
  return folder;
}
async function folderMenu(id) {
  const f = S.folders.find(x => x.id === id); if (!f) return;
  const name = await ask({ title: 'Edit folder', label: 'Name', value: f.name, help: 'Clear the name and save to delete the folder. Its posts become unfiled.' });
  if (name === null) return;
  if (name === '') {
    if (!confirm(`Delete "${f.name}"? Posts inside become unfiled.`)) return;
    await api(`/api/folders/${id}`, { method: 'DELETE' });
    S.folders = S.folders.filter(x => x.id !== id);
    S.items.forEach(i => { if (i.folder_id === id) i.folder_id = null; });
    if (S.lib === `folder:${id}`) S.lib = 'all';
  } else { await api(`/api/folders/${id}`, { method: 'PATCH', body: { name } }); f.name = name; }
  renderLibrary();
}

// =====================================================================
// Events
// =====================================================================
document.addEventListener('click', e => {
  const t = e.target;
  const push = t.closest('a[data-push]');
  if (push && !e.metaKey && !e.ctrlKey) { e.preventDefault(); return nav(push.getAttribute('href')); }
  const lib = t.closest('[data-lib]'); if (lib) return setLib(lib.dataset.lib);
  const act = t.closest('[data-act]'); if (act) { S.act = act.dataset.act; history.replaceState(null, '', S.act === 'all' ? '#/activity' : `#/activity/${S.act}`); return renderActivity(); }
  const tog = t.closest('[data-toggle]');
  if (tog) {
    const k = tog.dataset.toggle;
    S.open.has(k) ? S.open.delete(k) : S.open.add(k);
    const r = S.feed.find(x => x.key === k);
    if (r && r.type === 'email_alert' && !r.read && S.open.has(k)) return markRead([k]);
    return renderActivity();
  }
  const fm = t.closest('[data-folder-menu]'); if (fm) return folderMenu(fm.dataset.folderMenu);
  if (t.closest('[data-new-folder]')) return newFolder();
  const mb = t.closest('[data-mode]'); if (mb) return setMode(mb.dataset.mode);
  const cp = t.closest('[data-copy]'); if (cp) return copyText(cp.dataset.copy);
  const un = t.closest('[data-unread]'); if (un) { markRead([un.dataset.unread], false); toast('Marked unread', 'ph-envelope-simple'); return closeDetail(); }
  const cs = t.closest('[data-copy-script]');
  if (cs) { const it = S.items.find(x => x.id === cs.dataset.copyScript); if (it) copyText(scriptBlock(it), 'Transcript copied'); return; }
  const ex = t.closest('[data-expand]');
  if (ex) { const id = ex.dataset.expand; openRows.has(id) ? openRows.delete(id) : openRows.add(id); return renderLibrary(); }
  const op = t.closest('[data-open]'); if (op) return nav(`#/library/${op.dataset.open}`);
  const rb = t.closest('.rbox');
  if (rb) {
    const k = rb.dataset.box;
    if (t.closest('[data-box-edit]')) return toggleBox(k);
    if (t.closest('[data-box-add]')) return toggleBox(k, true);
    if (t.closest('[data-box-copy]')) { const it = S.items.find(x => x.id === S.activeId); if (it) copyText(it[k].trim(), k === 'transcript' ? 'Transcript copied' : 'Breakdown copied'); return; }
  }
  if (t.closest('#dCaption')) return $('#dCaption').classList.toggle('clamp');
  if (t.closest('[data-embed]')) { const it = S.items.find(x => x.id === S.activeId); if (it) embed(it); return; }
  const untag = t.closest('[data-untag]');
  if (untag) {
    const it = S.items.find(x => x.id === S.activeId);
    it.tags = it.tags.filter(x => x !== untag.dataset.untag);
    renderDrawer(); renderLibrary(); patchItem(it.id, { tags: it.tags });
    return;
  }
  const card = t.closest('.card');
  if (card) {
    const id = card.dataset.id;
    if (S.selecting || e.metaKey || e.ctrlKey || e.shiftKey) {
      if (!S.selecting) S.selecting = true;
      S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
      card.classList.toggle('selected', S.selected.has(id));
      renderSelbar(); $('#grid').classList.add('selecting');
      return;
    }
    return S.activeId ? (history.replaceState(null, '', `#/library/${id}`), route()) : nav(`#/library/${id}`);
  }
});
window.addEventListener('hashchange', route);
$('#scrim').onclick = closeDetail;
$('#sheetClose').onclick = closeDetail;
$('#drawerClose').onclick = closeDetail;
$('#markAllRead').onclick = () => markRead(unreadMail().map(r => r.key));
$('#newFolder').onclick = newFolder;
$('#selectBtn').onclick = () => toggleSelecting();
$('#selDone').onclick = () => toggleSelecting(false);
$('#selDelete').onclick = () => S.selected.size && deleteItems([...S.selected]);
$('#selMove').onchange = async e => {
  const v = e.target.value; if (!v || !S.selected.size) return;
  await moveItems([...S.selected], v === '__inbox' ? null : v);
  toggleSelecting(false);
};
let qTimer; $('#search').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value.trim(); renderLibrary(); }, 120); });
$('#dStar').onclick = () => { const it = S.items.find(x => x.id === S.activeId); it.starred = !it.starred; renderDrawer(); renderLibrary(); patchItem(it.id, { starred: it.starred }); };
$('#dDelete').onclick = () => deleteItems([S.activeId]);
$('#dRefresh').onclick = async () => {
  const id = S.activeId; toast('Refreshing preview', 'ph-arrows-clockwise');
  try { await api(`/api/items/${id}/refresh`, { method: 'POST', body: {} }); drawerFor = null; await sync(true); }
  catch (e) { toast(e.message, 'ph-warning'); }
};
$('#dFolder').onchange = async e => {
  const id = S.activeId; let v = e.target.value;
  if (v === '__new') { const f = await newFolder(); if (!f) { renderDrawer(); return; } v = f.id; }
  await moveItems([id], v);
};
$('#dNotes').addEventListener('input', e => autosave('notes', e.target, '#notesSaved'));
$$('.rbox-input').forEach(el => el.addEventListener('input', () => { const k = el.closest('.rbox').dataset.box; autosave(k, el, `.rbox[data-box="${k}"] .rbox-meta`); }));
$('#dTagInput').addEventListener('keydown', e => {
  const el = e.target, it = S.items.find(x => x.id === S.activeId);
  if ((e.key === 'Enter' || e.key === ',') && el.value.trim()) {
    e.preventDefault();
    const tag = el.value.trim().replace(/^#/, '').toLowerCase();
    if (!it.tags.includes(tag)) it.tags = [...it.tags, tag];
    el.value = ''; renderDrawer(); renderLibrary(); patchItem(it.id, { tags: it.tags }); $('#dTagInput').focus();
  } else if (e.key === 'Backspace' && !el.value && it.tags.length) {
    it.tags = it.tags.slice(0, -1); renderDrawer(); renderLibrary(); patchItem(it.id, { tags: it.tags }); $('#dTagInput').focus();
  }
});
$('#copyScripts').onclick = () => copyText(allScriptsText(), `${withScripts(libVisible()).length} transcripts copied`);
$('#downloadScripts').onclick = () => {
  const blob = new Blob([allScriptsText()], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${libTitle().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'library'}-transcripts.txt`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// drag posts onto folders (desktop)
let dragIds = [];
document.addEventListener('dragstart', e => {
  const card = e.target.closest?.('.card'); if (!card) return;
  const id = card.dataset.id;
  dragIds = S.selected.has(id) ? [...S.selected] : [id];
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragIds.join(','));
  requestAnimationFrame(() => dragIds.forEach(x => $(`.card[data-id="${x}"]`)?.classList.add('dragging')));
});
document.addEventListener('dragend', () => { $$('.dragging').forEach(c => c.classList.remove('dragging')); $$('.drop-over').forEach(c => c.classList.remove('drop-over')); });
document.addEventListener('dragover', e => {
  const tgt = e.target.closest?.('[data-drop]'); if (!tgt || !dragIds.length) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  $$('.drop-over').forEach(c => c !== tgt && c.classList.remove('drop-over')); tgt.classList.add('drop-over');
});
document.addEventListener('dragleave', e => { const tgt = e.target.closest?.('[data-drop]'); if (tgt && !tgt.contains(e.relatedTarget)) tgt.classList.remove('drop-over'); });
document.addEventListener('drop', async e => {
  const tgt = e.target.closest?.('[data-drop]'); if (!tgt || !dragIds.length) return;
  e.preventDefault();
  const ids = dragIds; dragIds = [];
  tgt.classList.remove('drop-over'); S.selected.clear(); S.selecting = false;
  await moveItems(ids, tgt.dataset.drop || null);
});

// keyboard
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if ($('#dialog').open || $('#connect').open) return;
  if (e.key === '/' && !typing && S.tab === 'library') { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape') {
    if (typing) { document.activeElement.blur(); return; }
    if (!$('#sheet').hidden || S.activeId) closeDetail(); else if (S.selecting) toggleSelecting(false);
  }
  if (!typing && S.activeId && ['ArrowRight', 'ArrowLeft', 'j', 'k'].includes(e.key)) {
    const list = S.mode === 'scripts' ? withScripts(libVisible()) : libVisible();
    const idx = list.findIndex(i => i.id === S.activeId);
    const next = list[idx + (e.key === 'ArrowRight' || e.key === 'j' ? 1 : -1)];
    if (next) { history.replaceState(null, '', `#/library/${next.id}`); route(); $(`.card[data-id="${next.id}"], .srow[data-row="${next.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  if (!typing && !e.metaKey && !e.ctrlKey && ['1', '2', '3'].includes(e.key)) location.hash = ['#/today', '#/library', '#/activity'][+e.key - 1];
});

// =====================================================================
// Connect Disk
// =====================================================================
let disk = null, reveal = false;
const mask = k => k.slice(0, 6) + '•'.repeat(Math.max(4, Math.min(18, k.length - 10))) + k.slice(-4);
function diskMessage({ base, key }) {
  return `You push data to my command center at ${base}

Read the full API contract first and follow it exactly:
${base}/DATA_CONTRACT.md

Endpoint: POST ${base}/api/ingest
Header: Authorization: Bearer ${key}
Header: Content-Type: application/json

Send one JSON object per request with a "type" of briefing, library_item, package_update, email_alert or digest. Use stable ids so resending updates a record instead of duplicating it. A 200 with {"ok":true} means saved. On a 422, fix the field named in "field" and send again.

When I send you an Instagram link: watch it, transcribe what is spoken, then POST a library_item with the hook, a summary (Hook / Format / Structure / Why it works / What to steal), the transcript, a folder and tags. To reuse my folder names, GET ${base}/api/folders with the same Authorization header.

Keep this token private.`;
}
function paintConnect() {
  $('#cEndpoint').textContent = `POST ${disk.base}/api/ingest`;
  $('#cToken').textContent = reveal ? disk.key : mask(disk.key);
  $('#cReveal').textContent = reveal ? 'Hide' : 'Show';
  $('#cContract').href = `${disk.base}/DATA_CONTRACT.md`;
  $('#cContract').textContent = `${disk.base.replace(/^https?:\/\//, '')}/DATA_CONTRACT.md`;
  $('#connectMsg').textContent = diskMessage(disk).replace(disk.key, reveal ? disk.key : mask(disk.key));
  $('#connectWarn').hidden = disk.persistent;
  $('#connectRotate').hidden = !!disk.fixed;
}
async function openConnect() {
  try { disk = await api('/api/muse'); } catch (e) { return toast(e.message, 'ph-warning'); }
  reveal = false; paintConnect(); $('#connect').showModal();
}
$('#connectBtn').onclick = openConnect;
$('#connectClose').onclick = () => $('#connect').close();
$('#cReveal').onclick = () => { reveal = !reveal; paintConnect(); };
$('#connectCopy').onclick = () => copyText(diskMessage(disk), 'Copied. Send it to Disk privately.');
$('#connectRotate').onclick = async () => {
  if (!confirm('Make a new token? The old one stops working right away, so Disk needs the new message.')) return;
  const { key } = await api('/api/muse/rotate', { method: 'POST' });
  disk.key = key; paintConnect(); toast('New token made. Send Disk the updated message.', 'ph-key');
};

// =====================================================================
// Sync, sign-in, boot
// =====================================================================
async function sync(force = false) {
  try {
    if (!force) { const { rev } = await api('/api/rev'); if (rev === S.rev) return; }
    const data = await api('/api/state');
    const before = S.known;
    const ids = new Set([...data.items.map(i => i.id), ...data.feed.map(r => r.key)]);
    S.items = data.items; S.folders = data.folders; S.feed = data.feed || []; S.rev = data.rev; S.loaded = true;
    if (before) {
      const fresh = [...ids].filter(id => !before.has(id)).length;
      if (fresh) toast(`${fresh} new from Disk`, 'ph-circle-half');
    }
    route();
    S.known = ids;
  } catch (e) { if (e.message !== 'Signed out') console.warn(e); }
}

let setupMode = false;
function showGate(first = false) {
  setupMode = first;
  clearInterval(boot.t);
  $('#app').hidden = true; $('#gate').hidden = false;
  $('#gateIntro').hidden = !first;
  $('#gateLabel').textContent = first ? 'New password' : 'Password';
  $('#gateKey').autocomplete = first ? 'new-password' : 'current-password';
  $('#gateBtn').textContent = first ? 'Create' : 'Sign in';
  $('#gateKey').value = ''; $('#gateKey').focus();
}
$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#gateError').textContent = '';
  const btn = $('#gateBtn'); btn.disabled = true;
  try {
    const res = await fetch(setupMode ? '/api/setup' : '/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: $('#gateKey').value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not sign in');
    $('#gate').hidden = true;
    await boot();
    if (setupMode) openConnect();
  } catch (err) { $('#gateError').textContent = err.message; }
  finally { btn.disabled = false; }
});
$('#logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showGate(); };

function skeleton() {
  $('#grid').innerHTML = Array.from({ length: 6 }, () => `<div class="card skeleton"><div class="thumb"></div><div class="card-body"><div class="bar" style="width:88%"></div><div class="bar" style="width:46%"></div></div></div>`).join('');
}
async function boot() {
  let status = { needsSetup: false, persistent: true };
  try { status = await (await fetch('/api/setup-status')).json(); } catch {}
  if (status.needsSetup) return showGate(true);
  $('#persistBanner').hidden = status.persistent !== false;
  $('#app').hidden = false; skeleton();
  if (!location.hash) history.replaceState(null, '', '#/today');
  route();
  S.rev = 0;
  await sync(true);
  if ($('#app').hidden) return;
  if (S.lib.startsWith('folder:') && !S.folders.some(f => `folder:${f.id}` === S.lib)) { S.lib = 'all'; route(); }
  clearInterval(boot.t); boot.t = setInterval(() => document.visibilityState === 'visible' && sync(), 6000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
  setInterval(() => S.tab === 'today' && renderToday(), 60e3);
}
boot();
