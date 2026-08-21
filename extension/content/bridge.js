import { createExecutor } from '../act/adapter.js';
import { syntheticImpl } from '../act/synthetic.js';
import { fingerprint } from '../perceive/fingerprint.js';
import { collectInteractive } from '../perceive/collect.js';

let lastElements = [];
const executor = createExecutor(syntheticImpl);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PERCEIVE') {
    lastElements = collectInteractive(document);
    sendResponse({ ok: true, url: location.href, title: document.title, elements: lastElements.map(({ index, tag, type, label }) => ({ index, tag, type, label })) });
    return false;
  }
  if (message?.type === 'EXECUTE') {
    const fresh = lastElements.map((item) => ({ ...item, currentFingerprint: item.el.isConnected ? fingerprint(item.el) : null }));
    executor.execute(message.action, { elements: fresh }).then(sendResponse);
    return true;
  }
  return false;
});
