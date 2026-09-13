import { MAX_BODY_BYTES } from './capture.js';
import { createTree, jqPath } from './tree.js';

const $ = (id) => document.getElementById(id);
document.documentElement.dataset.theme = globalThis.chrome?.devtools?.panels?.themeName
  || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

let store;
let unsubscribe;
let selectedRequest = null;
let selectedNode = null;
let result;
let hasResult = false;
let sourceReady = false;
let busy = false;
let revision = 0;
let worker;
let pending;
let sequence = 0;
let searchTimer;

function message(text = '', error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function updateControls() {
  $('run').disabled = busy || !sourceReady;
  $('reset').disabled = busy || !sourceReady;
  $('copy-result').disabled = !hasResult;
  $('tree-search').disabled = !hasResult;
  $('collapse').disabled = !hasResult;
  $('copy-path').disabled = !selectedNode;
  $('copy-value').disabled = !selectedNode;
}
function cancelWorker() {
  worker?.terminate(); worker = null;
  if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Inspection changed.')); pending = null; }
}
function execute(payload) {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (!pending || data.id !== pending.id) return;
      const current = pending; pending = null; clearTimeout(current.timer);
      if (data.error) current.reject(new Error(data.error)); else current.resolve(data.values);
    };
    worker.onerror = () => {
      const current = pending; pending = null;
      cancelWorker(); sourceReady = false;
      if (current) { clearTimeout(current.timer); current.reject(new Error('Query worker failed. Select the request or import JSON again.')); }
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending = null; cancelWorker(); sourceReady = false;
      reject(new Error('Inspection exceeded 2 seconds. Select the request or import JSON again, then narrow the query.'));
    }, 2000);
    pending = { id, resolve, reject, timer };
    worker.postMessage({ ...payload, id });
  });
}

async function copy(value, label) {
  try { await navigator.clipboard.writeText(value); message(`${label} copied.`); }
  catch { message('Clipboard unavailable. Keep DevTools focused and try again.', true); }
}
let menuOrigin;
function closeMenu(restore = false) { $('context-menu').hidden = true; if (restore) menuOrigin?.focus(); }
function openMenu(actions, x, y, origin) {
  const menu = $('context-menu'); menu.replaceChildren(); menuOrigin = origin;
  for (const [label, action] of actions) {
    const button = document.createElement('button'); button.textContent = label; button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => { closeMenu(true); action(); }); menu.append(button);
  }
  menu.hidden = false;
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  menu.firstElementChild.focus();
}
$('context-menu').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
  if (event.key === 'Tab') closeMenu();
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const buttons = [...$('context-menu').children];
    buttons[(buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
  }
});
document.addEventListener('pointerdown', (event) => { if (!$('context-menu').contains(event.target)) closeMenu(); });
window.addEventListener('blur', () => closeMenu());

const tree = createTree($('tree'), (node) => {
  selectedNode = node; $('selected-path').textContent = node.path; $('selected-path').title = node.path; updateControls();
}, (node, x, y, origin) => openMenu([
  ['Copy JSONPath', () => copy(node.path, 'JSONPath')],
  ['Copy jq path', () => copy(jqPath(node.path), 'jq path')],
  ['Copy value', () => copy(JSON.stringify(node.value, null, 2), 'Value')],
], x, y, origin));

function clearNode() { selectedNode = null; $('selected-path').textContent = 'Paths refer to the displayed result'; $('selected-path').removeAttribute('title'); }
function showResults(values) {
  result = values.length === 1 ? values[0] : values;
  hasResult = true; clearNode();
  $('tree-search').value = ''; clearTimeout(searchTimer);
  tree.show(result);
  $('result-count').textContent = `${values.length} output${values.length === 1 ? '' : 's'}`;
  updateControls();
}
function beginInspection(title, method, meta) {
  const token = ++revision;
  cancelWorker(); closeMenu(); sourceReady = false; hasResult = false; result = undefined; busy = true;
  clearNode(); clearTimeout(searchTimer);
  $('response-url').textContent = title; $('response-url').title = title;
  $('response-method').textContent = method; $('response-meta').textContent = meta;
  $('query').value = $('query-mode').value === 'jq' ? '.' : '$';
  $('tree-search').value = ''; $('result-count').textContent = ''; tree.clear();
  updateControls(); message('Loading response…');
  return token;
}
async function loadText(text, token) {
  if (text.length > MAX_BODY_BYTES || new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new Error('JSON exceeds the 10 MiB inspection limit.');
  const values = await execute({ type: 'load', text: text.replace(/^\uFEFF/, '') });
  if (token !== revision) return;
  sourceReady = true; showResults(values); message();
}
function finish(token, error) {
  if (token !== revision) return;
  busy = false;
  if (error) message(error.message, true);
  updateControls();
}
async function inspectRequest(item) {
  selectedRequest = item.id; renderRequests();
  const meta = `${item.status} · ${item.mime || 'unknown content type'} · ${formatBytes(item.size)} · ${Math.round(item.time || 0)} ms`;
  const token = beginInspection(item.url, item.method, meta);
  try {
    const text = await store.read(item.id);
    if (token !== revision) return;
    await loadText(text, token); finish(token);
  } catch (error) { finish(token, error); }
}
async function inspectText(text, title = 'Pasted JSON') {
  selectedRequest = null; renderRequests();
  const token = beginInspection(title, 'LOCAL', `${formatBytes(new TextEncoder().encode(text).length)} · local JSON`);
  try { await loadText(text, token); finish(token); return token === revision && sourceReady; }
  catch (error) { finish(token, error); return false; }
}
async function runQuery() {
  if (busy || !sourceReady) return;
  busy = true; updateControls(); message('Running query…');
  const token = revision;
  try {
    const values = await execute({ type: 'query', mode: $('query-mode').value, query: $('query').value });
    if (token !== revision) return;
    showResults(values); message(values.length === 0 ? 'No matches. Try a broader path or filter.' : ''); finish(token);
  } catch (error) {
    if (token === revision) { error.message += hasResult ? ' Previous result remains displayed.' : ''; finish(token, error); }
  }
}
function formatBytes(size) { return size < 0 ? 'size unknown' : size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`; }

function renderRequests() {
  const list = $('request-list');
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const term = $('request-filter').value.toLowerCase().trim();
  const entries = (store?.entries || []).filter((item) => (!$('json-only').checked || /json/i.test(item.mime)) && `${item.url} ${item.method} ${item.status}`.toLowerCase().includes(term));
  $('request-count').textContent = `${entries.length}/${store?.entries.length || 0}`;
  list.replaceChildren();
  for (const item of entries.toReversed()) {
    const button = document.createElement('button'); button.className = `request${item.id === selectedRequest ? ' active' : ''}`;
    button.dataset.id = item.id; button.title = item.url; button.setAttribute('aria-pressed', String(item.id === selectedRequest));
    const top = document.createElement('div'); top.className = 'request-top';
    const method = document.createElement('span'); method.className = 'method'; method.textContent = item.method;
    const name = document.createElement('span'); name.className = 'request-name';
    try { const url = new URL(item.url); name.textContent = url.pathname.split('/').filter(Boolean).pop() || url.hostname; } catch { name.textContent = item.url; }
    const status = document.createElement('span'); status.className = `status${item.status >= 400 || item.status === 0 ? ' failed' : ''}`; status.textContent = item.status;
    top.append(method, name, status);
    const detail = document.createElement('div'); detail.className = 'request-detail'; detail.textContent = item.url;
    button.append(top, detail); button.addEventListener('click', () => inspectRequest(item));
    const context = (x, y) => openMenu([
      ['Inspect response', () => inspectRequest(item)],
      ['Copy URL', () => copy(item.url, 'URL')],
    ], x, y, button);
    button.addEventListener('contextmenu', (event) => { event.preventDefault(); context(event.clientX, event.clientY); });
    button.addEventListener('keydown', (event) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault(); const rect = button.getBoundingClientRect(); context(rect.left + 15, rect.bottom);
      }
    });
    list.append(button);
  }
  if (!entries.length) {
    const empty = document.createElement('p'); empty.className = 'request-empty';
    empty.textContent = store ? 'No matching requests. Reload the page, adjust the filter, or uncheck “JSON responses only” for mislabeled responses.' : 'Open this panel in DevTools to capture requests. Paste JSON or try the sample here.';
    list.append(empty);
  }
  if (focusedId) list.querySelector(`[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
  $('record').disabled = !store; $('preserve').disabled = !store; $('clear').disabled = !store;
  $('record').textContent = store?.recording === false ? '○ Paused' : '● Recording';
  $('record').setAttribute('aria-pressed', String(store?.recording !== false));
  $('preserve').checked = store?.preserve || false;
}
let renderQueued = false;
function scheduleRequests() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderRequests(); });
}
function connect() {
  if (!window.requestStore || window.requestStore === store) return;
  unsubscribe?.(); store = window.requestStore; unsubscribe = store.subscribe(scheduleRequests); renderRequests();
}
window.addEventListener('capture-ready', connect);
window.addEventListener('unload', () => { unsubscribe?.(); cancelWorker(); });
connect(); renderRequests();

$('request-filter').addEventListener('input', renderRequests);
$('json-only').addEventListener('change', renderRequests);
$('record').addEventListener('click', () => store?.setRecording(!store.recording));
$('preserve').addEventListener('change', () => store?.setPreserve($('preserve').checked));
$('clear').addEventListener('click', () => {
  store?.clear(); selectedRequest = null;
  beginInspection('Select a request to inspect', 'JSON', 'Request log cleared.');
  busy = false; message('Request log cleared. New requests will appear while recording.'); updateControls();
});
$('query-form').addEventListener('submit', (event) => { event.preventDefault(); runQuery(); });
$('query-mode').addEventListener('change', () => {
  const jq = $('query-mode').value === 'jq';
  $('query').value = jq ? '.' : '$';
  $('query').placeholder = jq ? '.data.users[] | select(.active == true)' : '$.data.users[*]';
});
$('reset').addEventListener('click', () => { $('query').value = $('query-mode').value === 'jq' ? '.' : '$'; runQuery(); });
$('tree-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { if (hasResult) { clearNode(); tree.search($('tree-search').value); updateControls(); } }, 180);
});
$('collapse').addEventListener('click', () => tree.collapse());
$('copy-result').addEventListener('click', () => { if (hasResult) copy(JSON.stringify(result, null, 2), 'Result'); });
$('copy-path').addEventListener('click', () => { if (selectedNode) copy(selectedNode.path, 'JSONPath'); });
$('copy-value').addEventListener('click', () => { if (selectedNode) copy(JSON.stringify(selectedNode.value, null, 2), 'Value'); });
$('help-open').addEventListener('click', () => $('help-dialog').showModal());
$('help-close').addEventListener('click', () => $('help-dialog').close());
$('import-open').addEventListener('click', () => { $('import-error').textContent = ''; $('import-dialog').showModal(); $('import-text').focus(); });
$('import-cancel').addEventListener('click', () => $('import-dialog').close());
$('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  const success = await inspectText($('import-text').value);
  button.disabled = false;
  if (success) { $('import-dialog').close(); $('import-text').value = ''; }
  else $('import-error').textContent = $('message').textContent;
});
$('demo').addEventListener('click', () => inspectText(JSON.stringify({
  data: { users: [
    { id: 1, name: 'Ada', age: 36, active: true, roles: ['admin', 'developer'] },
    { id: 2, name: 'Grace', age: 28, active: false, roles: ['developer'] },
    { id: 3, name: 'Linus', age: 31, active: true, roles: ['reviewer'] },
  ] },
  meta: { total: 3, next: null, 'request.id': 'demo-001' },
}), 'Sample response'));
