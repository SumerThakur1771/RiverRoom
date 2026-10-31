import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      // the single-player game, and the play-with-friends page
      input: { main: 'index.html', mp: 'mp.html' },
    },
  },
});
