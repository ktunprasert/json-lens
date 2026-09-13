export const MAX_REQUESTS = 300;
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function decodeBody(content, encoding) {
  if (typeof content !== 'string') throw new Error('Response body is unavailable. Reload the page with DevTools open.');
  if (content.length > MAX_BODY_BYTES * (encoding === 'base64' ? 1.4 : 1)) {
    throw new Error('Response exceeds the 10 MiB inspection limit.');
  }
  const text = encoding === 'base64'
    ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(content), (char) => char.charCodeAt(0)))
    : content;
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new Error('Response exceeds the 10 MiB inspection limit.');
  return text.replace(/^\uFEFF/, '');
}

function fingerprint(entry) {
  return JSON.stringify([entry.startedDateTime, entry.request.method, entry.request.url, entry.response.status, entry.time]);
}

export function createCapture(network) {
  let entries = [];
  let nextId = 1;
  let generation = 0;
  let preserve = false;
  let recording = true;
  let booting = true;
  let pending = [];
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  function append(entry) {
    entries.push({
      id: nextId++,
      url: entry.request.url,
      method: entry.request.method,
      status: entry.response.status,
      mime: entry.response.content?.mimeType || '',
      size: entry.response.content?.size ?? -1,
      time: entry.time,
      started: entry.startedDateTime,
      entry,
    });
    if (entries.length > MAX_REQUESTS) entries.splice(0, entries.length - MAX_REQUESTS);
  }

  network.onRequestFinished.addListener((entry) => {
    if (!recording) return;
    if (booting) {
      pending.push(entry);
      if (pending.length > MAX_REQUESTS) pending.shift();
    }
    else { append(entry); notify(); }
  });
  network.onNavigated.addListener(() => {
    generation++;
    booting = false;
    if (preserve) pending.forEach(append);
    pending = [];
    if (!preserve) entries = [];
    notify();
  });
  const initialGeneration = generation;
  network.getHAR((har) => {
    if (generation !== initialGeneration) return;
    const seen = new Map();
    if (recording) {
      for (const entry of har?.entries || []) {
        append(entry);
        const key = fingerprint(entry);
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      for (const entry of pending) {
        const key = fingerprint(entry);
        if (seen.get(key)) seen.set(key, seen.get(key) - 1);
        else append(entry);
      }
    }
    pending = [];
    booting = false;
    notify();
  });

  return {
    get entries() { return entries; },
    get recording() { return recording; },
    get preserve() { return preserve; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setRecording(value) { recording = value; notify(); },
    setPreserve(value) { preserve = value; notify(); },
    clear() { generation++; booting = false; pending = []; entries = []; notify(); },
    async read(id) {
      const item = entries.find((item) => item.id === id);
      if (!item) throw new Error('Request was cleared or evicted. Select another request.');
      if (item.size > MAX_BODY_BYTES) throw new Error('Response exceeds the 10 MiB inspection limit.');
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Response body timed out. Reload and retry.')), 15000);
        try {
          item.entry.getContent((content, encoding) => {
            clearTimeout(timeout);
            try { resolve(decodeBody(content, encoding)); } catch (error) { reject(error); }
          });
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
    },
  };
}
