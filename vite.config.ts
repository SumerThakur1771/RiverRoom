import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Every file under a directory, as site paths ("/icons/icon-192.png"). */
function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesIn(full).map(f => '/' + name + f) : ['/' + name];
  });
}

/**
 * Writes sw.js into the build: src/pwa/sw.js with the list of files to cache for offline use
 * (everything the build produced plus public/) and a version that changes with that list.
 */
function serviceWorker(): Plugin {
  return {
    name: 'river-room-sw',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const built = Object.keys(bundle).map(f => '/' + f);
      // the link-preview image is only fetched by link crawlers, never by the app: not cached offline
      const pub = filesIn('public').filter(f => f !== '/sw.js' && f !== '/og-image.png');
      const precache = [...new Set(['/', ...built, ...pub])].sort();
      // the version covers the content of every cached file, so any change (even to an HTML
      // page, whose name never changes) installs a fresh cache
      const hash = createHash('sha256').update(precache.join('\n'));
      for (const f of Object.values(bundle)) hash.update(f.type === 'chunk' ? f.code : f.source);
      for (const f of pub) hash.update(readFileSync(join('public', f)));
      const version = hash.digest('hex').slice(0, 12);
      const src = readFileSync('src/pwa/sw.js', 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `const VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(precache)};\n${src}`,
      });
      this.info(`service worker ${version}: ${precache.length} files precached (${relative('.', 'src/pwa/sw.js')})`);
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker()],
  build: {
    rollupOptions: {
      // the single-player game, and the play-with-friends page
      input: { main: 'index.html', mp: 'mp.html' },
    },
  },
});
