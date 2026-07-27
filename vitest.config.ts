import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['extension/**/*.test.js', 'server/**/*.test.ts'],
    globals: false,
  },
});
