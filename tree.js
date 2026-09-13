const PAGE_SIZE = 80;
const SEARCH_LIMIT = 300;
const SCAN_LIMIT = 100000;
const container = (value) => value !== null && typeof value === 'object';

export function childPath(path, key, array) {
  return array ? `${path}[${key}]` : /^[A-Za-z_][A-Za-z_0-9]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

export function jqPath(path) {
  const result = path.slice(1);
  return result.startsWith('.') ? result : `.${result}`;
}

function preview(value) {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (container(value)) return `{ ${Object.keys(value).length} properties }`;
  if (typeof value === 'string') return JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
  return JSON.stringify(value);
}

export function createTree(host, onSelect, onContext) {
  let root;
  let selected;
  function select(element, value, path) {
    selected?.classList.remove('selected');
    selected = element;
    element.classList.add('selected');
    onSelect({ value, path });
  }
  function node(value, path, label, open = false) {
    const branch = container(value);
    const wrapper = document.createElement(branch ? 'details' : 'div');
    wrapper.className = branch ? 'branch' : 'leaf';
    const row = document.createElement(branch ? 'summary' : 'div');
    row.className = 'tree-row';
    if (!branch) { row.tabIndex = 0; row.setAttribute('role', 'button'); }
    const key = document.createElement('span');
    key.className = 'key'; key.textContent = label;
    const content = document.createElement('span');
    content.className = `value ${value === null ? 'null' : typeof value}`;
    content.textContent = preview(value);
    row.append(key, content); row.title = path;
    row.addEventListener('click', () => select(row, value, path));
    row.addEventListener('keydown', (event) => {
      if (!branch && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(row, value, path); }
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault(); select(row, value, path);
        const rect = row.getBoundingClientRect(); onContext({ value, path }, rect.left + 30, rect.bottom, row);
      }
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault(); event.stopPropagation(); select(row, value, path);
      onContext({ value, path }, event.clientX, event.clientY, row);
    });
    wrapper.append(row);
    if (branch) {
      let rendered = false;
      const renderChildren = () => {
        if (rendered || !wrapper.open) return;
        rendered = true;
        const children = document.createElement('div'); children.className = 'children';
        const keys = Object.keys(value);
        let offset = 0;
        const more = document.createElement('button'); more.className = 'load-more';
        const page = () => {
          more.remove();
          const end = Math.min(offset + PAGE_SIZE, keys.length);
          for (; offset < end; offset++) {
            const key = keys[offset];
            children.append(node(value[key], childPath(path, key, Array.isArray(value)), Array.isArray(value) ? key : JSON.stringify(key)));
          }
          if (offset < keys.length) { more.textContent = `Show next ${Math.min(PAGE_SIZE, keys.length - offset)} · ${keys.length - offset} remaining`; children.append(more); }
          if (!keys.length) { const empty = document.createElement('span'); empty.className = 'muted'; empty.textContent = 'Empty'; children.append(empty); }
        };
        more.addEventListener('click', page); page(); wrapper.append(children);
      };
      wrapper.addEventListener('toggle', renderChildren);
      wrapper.open = open;
      if (open) renderChildren();
    }
    return wrapper;
  }
  function show(value) { root = value; selected = null; host.replaceChildren(node(value, '$', '$', true)); }
  function search(term) {
    term = term.trim().toLowerCase();
    if (!term) { show(root); return ''; }
    host.replaceChildren(); selected = null;
    let scanned = 0, matches = 0;
    // Iterator frames keep wide documents from filling a traversal stack.
    const stack = [{ value: root, path: '$', key: '$', depth: 0 }];
    while (stack.length && scanned < SCAN_LIMIT && matches < SEARCH_LIMIT) {
      const item = stack.pop();
      if (item.iterator) {
        const next = item.iterator.next();
        if (!next.done) {
          stack.push(item);
          const key = next.value;
          stack.push({ value: item.value[key], path: childPath(item.path, key, Array.isArray(item.value)), key, depth: item.depth + 1 });
        }
        continue;
      }
      scanned++;
      const scalar = container(item.value) ? '' : String(item.value);
      if (item.key.toLowerCase().includes(term) || scalar.toLowerCase().includes(term)) {
        host.append(node(item.value, item.path, item.path)); matches++;
      }
      if (container(item.value) && item.depth < 256) stack.push({ ...item, iterator: Object.keys(item.value)[Symbol.iterator]() });
    }
    const limited = stack.length > 0;
    const note = document.createElement('p'); note.className = 'search-note';
    note.textContent = `${matches} matching nodes${limited ? ' · search limit reached; narrow your search' : ''}. Search depth limit: 256.`;
    host.prepend(note);
    return note.textContent;
  }
  return {
    show,
    search,
    clear() { root = undefined; selected = null; host.replaceChildren(); },
    collapse() { host.querySelectorAll('details').forEach((item) => { item.open = false; }); },
  };
}
