// MV3 content-script entries cannot use static imports. Load the module at runtime.
(async () => {
  const base = chrome.runtime.getURL('');
  await import(`${base}content/pet.js`);
  await import(`${base}content/bridge.js`);
  await import(`${base}content/official-agent.js`);
})();
