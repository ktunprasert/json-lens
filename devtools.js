import { createCapture } from './capture.js';

const store = createCapture(chrome.devtools.network);
chrome.devtools.panels.create('JSON Lens', '', 'panel.html', (panel) => {
  panel.onShown.addListener((window) => {
    window.requestStore = store;
    window.dispatchEvent(new Event('capture-ready'));
  });
});
