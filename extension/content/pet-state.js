export const PET_STATES = ['idle', 'thinking', 'acting', 'alert', 'offline'];

const EMOJI = { idle: '🐾', thinking: '💭', acting: '✨', alert: '❗', offline: '💤' };

export function stateEmoji(state) {
  return EMOJI[state] || EMOJI.idle;
}

export function createPetState(initial = 'idle') {
  let current = PET_STATES.includes(initial) ? initial : 'idle';
  const listeners = new Set();
  return {
    get: () => current,
    set(next) {
      if (!PET_STATES.includes(next) || next === current) return;
      const previous = current;
      current = next;
      listeners.forEach((listener) => listener(current, previous));
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
