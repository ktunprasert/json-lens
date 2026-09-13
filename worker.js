import { query } from './query.js';

let source;
let loaded = false;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'load') {
      loaded = false;
      source = JSON.parse(data.text);
      loaded = true;
      self.postMessage({ id: data.id, values: [source] });
    } else {
      if (!loaded) throw new Error('Select a request or import JSON first.');
      self.postMessage({ id: data.id, values: query(source, data.query, data.mode) });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
