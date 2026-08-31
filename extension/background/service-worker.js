import { createSessionClient } from './session-client.js';

const client = createSessionClient();

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/pet.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/loader.js'] });
  } catch (error) {
    console.warn('[pawpals] cannot attach to current tab', error);
  }
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PING_SERVER') {
    client.ping().then((alive) => sendResponse({ alive }));
    return true;
  }
  if (message?.type === 'OPEN_PANEL') {
    if (sender.tab?.id) chrome.sidePanel.open({ tabId: sender.tab.id });
    sendResponse({ ok: true });
  }
  return false;
});
