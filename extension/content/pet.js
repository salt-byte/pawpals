import { createPetState, stateEmoji } from './pet-state.js';

const state = createPetState();

function mount() {
  if (document.getElementById('pawpals-pet')) return;
  const pet = document.createElement('button');
  pet.id = 'pawpals-pet';
  pet.type = 'button';
  pet.title = 'PawPals — 点击打开助手';
  const render = () => { pet.textContent = stateEmoji(state.get()); pet.dataset.state = state.get(); };
  render();
  state.onChange(render);
  pet.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }));
  document.body.appendChild(pet);
  chrome.runtime.sendMessage({ type: 'PING_SERVER' }, (result) => state.set(result?.alive ? 'idle' : 'offline'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
