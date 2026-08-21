import { describe, expect, it, vi } from 'vitest';
import { createPetState, PET_STATES, stateEmoji } from './pet-state.js';

describe('pet state', () => {
  it('has the supported visual states and emojis', () => {
    expect(PET_STATES).toEqual(['idle', 'thinking', 'acting', 'alert', 'offline']);
    for (const state of PET_STATES) expect(stateEmoji(state)).toBeTruthy();
    expect(stateEmoji('unknown')).toBe(stateEmoji('idle'));
  });
  it('changes only to valid new states and informs subscribers', () => {
    const pet = createPetState(); const changed = vi.fn(); pet.onChange(changed);
    pet.set('thinking'); pet.set('thinking'); pet.set('broken');
    expect(pet.get()).toBe('thinking'); expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith('thinking', 'idle');
  });
});
