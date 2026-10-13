// Muse Library client. Vanilla JS, no build step.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const S = {
  items: [], folders: [], rev: 0,
  view: store.get('ml.view', 'inbox'),
  sort: store.get('ml.sort', 'new'),
  q: '',
  selecting: false, selected: new Set(),
  activeId: null, known: null,
};

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) { showGate(); throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const patchItem = (id, body) => api(`/api/items/${id}`, { method: 'PATCH', body });

// ---------- helpers ----------
const folderName = id => S.folders.find(f => f.id === id)?.name;
function ago(iso) {
  const s = Math.max(1, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined });
}
function toast(msg, icon = 'ph-check-circle') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<i class="ph-fill ${icon}"></i><span>${esc(msg)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2600);
}
function ask({ title, label, value = '', help = '', ok = 'Save', type = 'text', placeholder = '' }) {
  const d = $('#dialog');
  $('#dialogTitle').textContent = title;
  $('#dialogLabel').textContent = label;
  $('#dialogHelp').textContent = help;
  $('#dialogOk').textContent = ok;
  const input = $('#dialogInput');
  input.type = type; input.value = value; input.placeholder = placeholder;
  d.showModal(); setTimeout(() => input.select(), 30);
  return new Promise(resolve => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? input.value.trim() : null), { once: true });
  });
}

function matches(i) {
  const v = S.view;
  if (v === 'inbox' && i.folder_id) return false;
  if (v === 'starred' && !i.starred) return false;
  if (v.startsWith('type:') && i.media !== v.slice(5)) return false;
  if (v.startsWith('folder:') && i.folder_id !== v.slice(7)) return false;
  if (!S.q) return true;
  const hay = [i.author, i.caption, i.title, i.notes, i.summary, i.url, folderName(i.folder_id), ...(i.tags || []).map(t => '#' + t)].join(' ').toLowerCase();
  return S.q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}
function visible() {
  const list = S.items.filter(matches);
  return S.sort === 'old' ? list.reverse() : list;
}
function viewTitle() {
  const v = S.view;
  if (v === 'inbox') return 'Inbox';
  if (v === 'all') return 'Everything';
  if (v === 'starred') return 'Starred';
  if (v === 'type:video') return 'Reels & video';
  if (v === 'type:image') return 'Photos';
  return folderName(v.slice(7)) || 'Folder';
}

// ---------- render ----------
function renderSide() {
  const counts = {
    inbox: S.items.filter(i => !i.folder_id).length,
    all: S.items.length,
    starred: S.items.filter(i => i.starred).length,
    'type:video': S.items.filter(i => i.media === 'video').length,
    'type:image': S.items.filter(i => i.media === 'image').length,
  };
  $$('[data-count]').forEach(el => { el.textContent = counts[el.dataset.count] || ''; });

  const fl = $('#folderList');
  fl.innerHTML = S.folders.length ? S.folders.map(f => {
    const n = S.items.filter(i => i.folder_id === f.id).length;
    return `<div class="folder-row">
      <button class="nav-item" data-view="folder:${f.id}" data-drop="${f.id}"><i class="ph ph-folder-simple"></i><span>${esc(f.name)}</span><em>${n || ''}</em></button>
      <button class="icon-btn sm folder-menu" data-folder-menu="${f.id}" aria-label="Edit ${esc(f.name)}"><i class="ph ph-dots-three"></i></button>
    </div>`;
  }).join('') : `<div class="folder-empty">No folders yet. Make one, then drag posts onto it.</div>`;

  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));

  const fromMuse = S.items.filter(i => i.added_by === 'muse').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const ms = $('#museStatus');
  ms.classList.toggle('live', !!fromMuse);
  ms.querySelector('span').textContent = fromMuse ? `Muse saved ${ago(fromMuse.created_at)}` : 'Connect Muse';
}

function cardHTML(i, idx) {
  const cap = i.caption || i.title || '';
  const thumb = i.thumb
    ? `<img src="${esc(i.thumb)}" alt="${esc(cap.slice(0, 100) || 'Saved post')}" loading="lazy" decoding="async">`
    : i.status === 'pending' ? '' : `<span class="ph-glyph"><i class="ph ${i.kind === 'link' ? 'ph-link' : 'ph-image-broken'}"></i></span>`;
  const fresh = S.known && !S.known.has(i.id) ? ' fresh' : '';
  return `<button class="card${i.id === S.activeId ? ' active' : ''}${S.selected.has(i.id) ? ' selected' : ''}${fresh}" data-id="${i.id}" draggable="true" style="--i:${Math.min(idx, 24)}">
    <div class="thumb${!i.thumb && i.status === 'pending' ? ' loading' : ''}">
      ${thumb}
      ${i.media === 'video' ? '<span class="play"><i class="ph-fill ph-play"></i></span>' : ''}
    </div>
    <span class="check"><i class="ph ph-check"></i></span>
    <div class="card-body">
      <div class="card-author"><span>${i.author ? '@' + esc(i.author) : esc(i.source || 'instagram')}</span>
        <span class="card-flags">${i.starred ? '<i class="ph-fill ph-star"></i>' : ''}${i.notes ? '<i class="ph ph-note-pencil"></i>' : ''}</span>
      </div>
      <p class="card-cap${cap ? '' : ' muted'}">${esc(cap) || (i.status === 'pending' ? 'Fetching preview' : 'No caption')}</p>
      ${i.folder_id && !S.view.startsWith('folder:') ? `<span class="card-folder"><i class="ph ph-folder-simple"></i>${esc(folderName(i.folder_id))}</span>` : ''}
    </div>
  </button>`;
}

function renderEmpty(count) {
  const el = $('#empty');
  el.hidden = count > 0;
  if (count) return;
  let icon = 'ph-tray', h = 'Inbox is clear', p = 'Send Muse a reel or post from Instagram and it lands here, ready to sort.';
  if (S.q) { icon = 'ph-magnifying-glass'; h = 'Nothing matches'; p = `No saved posts match "${esc(S.q)}" in this view.`; }
  else if (S.view.startsWith('folder:')) { icon = 'ph-folder-simple'; h = 'This folder is empty'; p = 'Drag posts onto it in the sidebar, or pick it from the Folder menu inside a post.'; }
  else if (S.view === 'starred') { icon = 'ph-star'; h = 'No starred posts'; p = 'Star the ones you keep coming back to.'; }
  else if (S.view !== 'inbox') { icon = 'ph-bookmark-simple'; h = 'Nothing saved yet'; p = 'Send Muse an Instagram link, or add one yourself.'; }
  el.innerHTML = `<div class="empty-icon"><i class="ph ${icon}"></i></div><h2>${h}</h2><p>${p}</p>
    ${S.q ? '' : '<button class="btn btn-accent" data-action="add"><i class="ph ph-plus"></i><span>Add link</span></button>'}`;
}

function renderGrid() {
  const list = visible();
  $('#viewTitle').textContent = viewTitle();
  $('#viewCount').textContent = list.length || '';
  document.title = `${viewTitle()} · Muse Library`;
  $('#grid').classList.toggle('selecting', S.selecting);
  $('#grid').innerHTML = list.map(cardHTML).join('');
  renderEmpty(list.length);
}
function renderSelbar() {
  $('#selbar').hidden = !S.selecting;
  $('#selCount').textContent = `${S.selected.size} selected`;
  $('#selMove').innerHTML = `<option value="">Move to</option><option value="__inbox">Inbox</option>` +
    S.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  $('#selectBtn span').textContent = S.selecting ? 'Done' : 'Select';
}
function render() { renderSide(); renderGrid(); renderSelbar(); renderDrawer(); $$('[data-sort]').forEach(b => b.setAttribute('aria-pressed', b.dataset.sort === S.sort)); }

// ---------- drawer ----------
let drawerFor = null;
function renderDrawer() {
  const i = S.items.find(x => x.id === S.activeId);
  const d = $('#drawer');
  if (!i) { d.hidden = true; drawerFor = null; return; }
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
  $('#dDate').textContent = `${i.added_by === 'muse' ? 'Muse' : 'You'} · ${ago(i.created_at)}`;
  $('#dCaption').textContent = i.caption || i.title || '';
  $('#dCaption').hidden = !(i.caption || i.title);

  $('#dFolder').innerHTML = `<option value="">Inbox</option>` + S.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('') + `<option value="__new">New folder</option>`;
  $('#dFolder').value = i.folder_id || '';

  $$('#dTags .tag').forEach(t => t.remove());
  $('#dTagInput').insertAdjacentHTML('beforebegin', (i.tags || []).map(t => `<span class="tag">#${esc(t)}<button data-untag="${esc(t)}" aria-label="Remove ${esc(t)}"><i class="ph ph-x"></i></button></span>`).join(''));

  for (const [sel, key] of [['#dNotes', 'notes'], ['#dSummary', 'summary']]) {
    const el = $(sel);
    if (fresh || document.activeElement !== el) el.value = i[key] || '';
  }
  if (fresh) { $('#notesSaved').textContent = ''; $('#summarySaved').textContent = ''; renderMedia(i); }
  else if (!$('#dMedia iframe')) renderMedia(i);
}
function renderMedia(i) {
  const m = $('#dMedia');
  m.classList.remove('embed');
  const canEmbed = i.source === 'instagram' && i.shortcode;
  if (i.thumb) {
    m.innerHTML = `<img src="${esc(i.thumb)}" alt="">${canEmbed ? `<button class="play-big" data-embed><i class="ph-fill ph-play"></i>${i.media === 'video' ? 'Play here' : 'View post'}</button>` : ''}`;
  } else {
    m.innerHTML = `<div class="no-prev"><i class="ph ph-image-broken"></i><span>${i.status === 'pending' ? 'Fetching preview' : 'No preview yet. Try refresh, or open the post.'}</span>
      ${canEmbed ? '<button class="btn" data-embed><i class="ph ph-play"></i><span>Load embed</span></button>' : ''}</div>`;
  }
}
function embed(i) {
  const m = $('#dMedia');
  m.classList.add('embed');
  m.innerHTML = `<iframe src="https://www.instagram.com/${i.kind === 'reel' ? 'reel' : 'p'}/${i.shortcode}/embed/" allow="autoplay; encrypted-media; clipboard-write" allowfullscreen loading="lazy" title="Instagram post"></iframe>`;
}
function openItem(id) {
  S.activeId = id;
  $$('.card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
  renderDrawer();
}
function closeDrawer() { S.activeId = null; $$('.card.active').forEach(c => c.classList.remove('active')); renderDrawer(); }

const timers = {};
function autosave(key, el, flag) {
  clearTimeout(timers[key]);
  $(flag).textContent = 'Editing';
  const id = S.activeId;
  timers[key] = setTimeout(async () => {
    const it = S.items.find(x => x.id === id); if (!it) return;
    it[key] = el.value;
    try { await patchItem(id, { [key]: el.value }); $(flag).textContent = 'Saved'; renderGrid(); }
    catch (e) { $(flag).textContent = 'Not saved'; toast(e.message, 'ph-warning'); }
  }, 600);
}

// ---------- mutations ----------
async function moveItems(ids, folderId) {
  const fid = folderId || null;
  ids.forEach(id => { const it = S.items.find(x => x.id === id); if (it) it.folder_id = fid; });
  render();
  await api('/api/items/bulk', { method: 'POST', body: { ids, folder_id: fid } });
  toast(`${ids.length > 1 ? ids.length + ' posts' : 'Moved'} to ${fid ? folderName(fid) : 'Inbox'}`, 'ph-folder-simple');
}
async function deleteItems(ids) {
  if (!confirm(ids.length > 1 ? `Delete ${ids.length} posts?` : 'Delete this post?')) return;
  S.items = S.items.filter(i => !ids.includes(i.id));
  ids.forEach(id => S.selected.delete(id));
  if (ids.includes(S.activeId)) S.activeId = null;
  render();
  await api('/api/items/bulk', { method: 'POST', body: { ids, action: 'delete' } });
}
async function newFolder() {
  const name = await ask({ title: 'New folder', label: 'Name', placeholder: 'Hooks, Transitions, Fits', ok: 'Create' });
  if (!name) return null;
  const { folder } = await api('/api/folders', { method: 'POST', body: { name } });
  if (!S.folders.some(f => f.id === folder.id)) S.folders.push(folder);
  render();
  return folder;
}
async function folderMenu(id) {
  const f = S.folders.find(x => x.id === id);
  const name = await ask({ title: 'Edit folder', label: 'Name', value: f.name, help: 'Clear the name and save to delete the folder. Its posts go back to Inbox.' });
  if (name === null) return;
  if (name === '') {
    if (!confirm(`Delete "${f.name}"? Posts inside go back to Inbox.`)) return;
    await api(`/api/folders/${id}`, { method: 'DELETE' });
    S.folders = S.folders.filter(x => x.id !== id);
    S.items.forEach(i => { if (i.folder_id === id) i.folder_id = null; });
    if (S.view === `folder:${id}`) setView('inbox');
  } else {
    await api(`/api/folders/${id}`, { method: 'PATCH', body: { name } });
    f.name = name;
  }
  render();
}
async function addLink() {
  const url = await ask({ title: 'Add a post', label: 'Instagram link', type: 'url', placeholder: 'https://www.instagram.com/reel/...', ok: 'Add', help: 'Muse normally does this for you.' });
  if (!url) return;
  try {
    const out = await api('/api/items', { method: 'POST', body: { url } });
    await sync(true);
    toast(out.duplicate ? 'Already saved' : 'Added to Inbox');
    openItem(out.item.id);
  } catch (e) { toast(e.message, 'ph-warning'); }
}
function setView(v) {
  S.view = v; store.set('ml.view', v);
  S.selected.clear();
  closeSide();
  render();
  window.scrollTo({ top: 0 });
}
function toggleSelecting(on = !S.selecting) {
  S.selecting = on;
  if (!on) S.selected.clear();
  render();
}

// ---------- sync ----------
async function sync(force = false) {
  try {
    if (!force) {
      const { rev } = await api('/api/rev');
      if (rev === S.rev) return;
    }
    const data = await api('/api/state');
    const before = S.known;
    S.known = before || new Set();
    const incoming = data.items.filter(i => !S.known.has(i.id));
    S.items = data.items; S.folders = data.folders; S.rev = data.rev;
    if (before) {
      const fromMuse = incoming.filter(i => i.added_by === 'muse');
      if (fromMuse.length) toast(`Muse saved ${fromMuse.length} new post${fromMuse.length > 1 ? 's' : ''}`, 'ph-robot');
    }
    render();
    S.known = new Set(S.items.map(i => i.id));
  } catch (e) { if (e.message !== 'Signed out') console.warn(e); }
}

// ---------- gate (sign in, or create a password on first visit) ----------
let setupMode = false;
function showGate(first = false) {
  setupMode = first;
  clearInterval(boot.t);
  $('#app').hidden = true; $('#gate').hidden = false;
  $('#gateIntro').hidden = !first;
  $('#gateLabel').textContent = first ? 'New password' : 'Password';
  $('#gateKey').autocomplete = first ? 'new-password' : 'current-password';
  $('#gateBtn').textContent = first ? 'Create library' : 'Open library';
  $('#gateKey').value = ''; $('#gateKey').focus();
}
$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#gateError').textContent = '';
  const btn = $('#gateBtn'); btn.disabled = true;
  try {
    const res = await fetch(setupMode ? '/api/setup' : '/api/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: $('#gateKey').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not sign in');
    $('#gate').hidden = true;
    await boot();
    if (setupMode) openConnect();
  } catch (err) { $('#gateError').textContent = err.message; }
  finally { btn.disabled = false; }
});

// ---------- connect Muse ----------
let museInfo = null;
function museMessage({ base, key }) {
  return `You have a library where you save Instagram posts for me.

Whenever I send you an Instagram reel or post, save it by sending:

POST ${base}/api/items
Header: Authorization: Bearer ${key}
Header: Content-Type: application/json
Body: {"url": "<the instagram link>"}

Optional fields in the body:
- "summary": your breakdown of the post (hook, format, why it works)
- "tags": a list of short tags, like ["hook", "transition"]
- "folder": a folder name to file it in (created if it doesn't exist)
- "thumbnail_url": a direct image URL for the preview, if you have one

Sending the same link again updates it instead of duplicating it. A 201 or 200 response means it saved.

If you can only open links, open this instead (URL-encode the Instagram link):
${base}/api/ingest?key=${key}&url=<instagram link>

To see everything saved: GET ${base}/api/state with the same Authorization header.`;
}
async function openConnect() {
  try { museInfo = await api('/api/muse'); } catch (e) { return toast(e.message, 'ph-warning'); }
  $('#connectMsg').textContent = museMessage(museInfo);
  $('#connectWarn').hidden = museInfo.persistent;
  $('#connect').showModal();
}
$('#museStatus').onclick = openConnect;
$('#connectClose').onclick = () => $('#connect').close();
$('#connectCopy').onclick = async () => {
  const text = $('#connectMsg').textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it to Muse.', 'ph-copy'); }
  catch { const r = document.createRange(); r.selectNodeContents($('#connectMsg')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Selected. Copy it and paste to Muse.', 'ph-copy'); }
};
$('#connectRotate').onclick = async () => {
  if (!confirm('Make a new Muse key? The old one stops working, so you will need to send Muse the new message.')) return;
  const { key } = await api('/api/muse/rotate', { method: 'POST' });
  museInfo.key = key; $('#connectMsg').textContent = museMessage(museInfo);
  toast('New key made. Send Muse the updated message.', 'ph-key');
};

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target;
  const nav = t.closest('.nav-item[data-view]'); if (nav) return setView(nav.dataset.view);
  const fm = t.closest('[data-folder-menu]'); if (fm) return folderMenu(fm.dataset.folderMenu);
  if (t.closest('[data-action="add"]')) return addLink();
  if (t.closest('[data-embed]')) { const it = S.items.find(x => x.id === S.activeId); if (it) embed(it); return; }
  const untag = t.closest('[data-untag]');
  if (untag) {
    const it = S.items.find(x => x.id === S.activeId);
    it.tags = it.tags.filter(x => x !== untag.dataset.untag);
    renderDrawer(); renderGrid(); patchItem(it.id, { tags: it.tags });
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
    return openItem(id);
  }
});
$('#newFolder').onclick = newFolder;
$('#addBtn').onclick = addLink;
$('#selectBtn').onclick = () => toggleSelecting();
$('#selDone').onclick = () => toggleSelecting(false);
$('#selDelete').onclick = () => S.selected.size && deleteItems([...S.selected]);
$('#selMove').onchange = async e => {
  const v = e.target.value; if (!v || !S.selected.size) return;
  await moveItems([...S.selected], v === '__inbox' ? null : v);
  toggleSelecting(false);
};
$$('[data-sort]').forEach(b => b.onclick = () => { S.sort = b.dataset.sort; store.set('ml.sort', S.sort); render(); });
let qTimer; $('#search').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value.trim(); renderGrid(); }, 120); });

$('#drawerClose').onclick = closeDrawer;
$('#dStar').onclick = () => { const it = S.items.find(x => x.id === S.activeId); it.starred = !it.starred; render(); patchItem(it.id, { starred: it.starred }); };
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
$('#dSummary').addEventListener('input', e => autosave('summary', e.target, '#summarySaved'));
$('#dTagInput').addEventListener('keydown', e => {
  const el = e.target;
  if ((e.key === 'Enter' || e.key === ',') && el.value.trim()) {
    e.preventDefault();
    const it = S.items.find(x => x.id === S.activeId);
    const tag = el.value.trim().replace(/^#/, '').toLowerCase();
    if (!it.tags.includes(tag)) it.tags = [...it.tags, tag];
    el.value = ''; renderDrawer(); renderGrid(); patchItem(it.id, { tags: it.tags });
    $('#dTagInput').focus();
  } else if (e.key === 'Backspace' && !el.value) {
    const it = S.items.find(x => x.id === S.activeId);
    if (it.tags.length) { it.tags = it.tags.slice(0, -1); renderDrawer(); renderGrid(); patchItem(it.id, { tags: it.tags }); $('#dTagInput').focus(); }
  }
});

// drag posts onto folders
let dragIds = [];
document.addEventListener('dragstart', e => {
  const card = e.target.closest?.('.card'); if (!card) return;
  const id = card.dataset.id;
  dragIds = S.selected.has(id) ? [...S.selected] : [id];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragIds.join(','));
  requestAnimationFrame(() => dragIds.forEach(x => $(`.card[data-id="${x}"]`)?.classList.add('dragging')));
});
document.addEventListener('dragend', () => { $$('.dragging').forEach(c => c.classList.remove('dragging')); $$('.drop-over').forEach(c => c.classList.remove('drop-over')); });
document.addEventListener('dragover', e => {
  const tgt = e.target.closest?.('[data-drop]'); if (!tgt || !dragIds.length) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  $$('.drop-over').forEach(c => c !== tgt && c.classList.remove('drop-over'));
  tgt.classList.add('drop-over');
});
document.addEventListener('dragleave', e => { const tgt = e.target.closest?.('[data-drop]'); if (tgt && !tgt.contains(e.relatedTarget)) tgt.classList.remove('drop-over'); });
document.addEventListener('drop', async e => {
  const tgt = e.target.closest?.('[data-drop]'); if (!tgt || !dragIds.length) return;
  e.preventDefault();
  const ids = dragIds; dragIds = [];
  tgt.classList.remove('drop-over');
  S.selected.clear(); S.selecting = false;
  await moveItems(ids, tgt.dataset.drop || null);
});

// mobile sidebar
const openSide = () => { $('#side').classList.add('open'); $('#scrim').classList.add('open'); };
function closeSide() { $('#side').classList.remove('open'); $('#scrim').classList.remove('open'); }
$('#menuBtn').onclick = openSide; $('#sideClose').onclick = closeSide; $('#scrim').onclick = closeSide;

// keyboard
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape') {
    if ($('#dialog').open || $('#connect').open) return;
    if (typing) { document.activeElement.blur(); return; }
    if (S.activeId) closeDrawer(); else if (S.selecting) toggleSelecting(false);
  }
  if (!typing && S.activeId && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'k')) {
    const list = visible(); const idx = list.findIndex(i => i.id === S.activeId);
    const next = list[idx + (e.key === 'ArrowRight' || e.key === 'j' ? 1 : -1)];
    if (next) { openItem(next.id); $(`.card[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
});

// theme: system, light, dark
const themes = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  $('#themeBtn').setAttribute('aria-label', `Theme: ${t}`); $('#themeBtn').title = `Theme: ${t}`;
}
applyTheme(store.get('ml.theme', 'system'));
$('#themeBtn').onclick = () => { const t = themes[(themes.indexOf(store.get('ml.theme', 'system')) + 1) % 3]; store.set('ml.theme', t); applyTheme(t); toast(`Theme: ${t}`, 'ph-circle-half'); };
$('#logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showGate(); };

// ---------- boot ----------
function skeleton() {
  $('#grid').innerHTML = Array.from({ length: 8 }, () => `<div class="card skeleton"><div class="thumb"></div><div class="card-body"><div class="bar" style="width:46%"></div><div class="bar" style="width:88%"></div></div></div>`).join('');
}
async function boot() {
  let status = { needsSetup: false, persistent: true };
  try { status = await (await fetch('/api/setup-status')).json(); } catch {}
  if (status.needsSetup) return showGate(true);
  $('#persistBanner').hidden = status.persistent !== false;
  $('#app').hidden = false; skeleton();
  S.rev = 0;
  await sync(true);
  if ($('#app').hidden) return;
  if (!S.view.startsWith('folder:') || S.folders.some(f => `folder:${f.id}` === S.view)) render(); else setView('inbox');
  clearInterval(boot.t); boot.t = setInterval(() => document.visibilityState === 'visible' && sync(), 6000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
}
boot();
