/**
 * Mist Stale Check — popup. Lets the user pick the poll interval.
 * Persisted in chrome.storage.sync (synced across their Chrome profile);
 * content.js reads it on load and reacts live via chrome.storage.onChanged.
 */
(() => {
  'use strict';

  const DEFAULT_SEC = 60;
  const CHOICES = [
    { sec: 30, label: 'Every 30 seconds' },
    { sec: 60, label: 'Every minute (default)' },
    { sec: 120, label: 'Every 2 minutes' },
    { sec: 300, label: 'Every 5 minutes' },
  ];

  const optionsEl = document.getElementById('options');
  const savedEl = document.getElementById('saved');
  let savedTimer = null;

  function render(currentSec) {
    optionsEl.textContent = '';
    for (const { sec, label } of CHOICES) {
      const lab = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'poll';
      radio.value = String(sec);
      radio.checked = sec === currentSec;
      radio.addEventListener('change', () => save(sec));
      lab.appendChild(radio);
      lab.appendChild(document.createTextNode(label));
      optionsEl.appendChild(lab);
    }
  }

  function save(sec) {
    chrome.storage.sync.set({ pollIntervalSec: sec }, () => {
      savedEl.textContent = 'Saved.';
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => { savedEl.textContent = ''; }, 1500);
    });
  }

  chrome.storage.sync.get({ pollIntervalSec: DEFAULT_SEC }, (items) => {
    const sec = CHOICES.some((c) => c.sec === items.pollIntervalSec)
      ? items.pollIntervalSec
      : DEFAULT_SEC;
    render(sec);
  });
})();
