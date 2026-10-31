// Page setup shared by both pages: the service worker (offline play) and Vercel Web Analytics.
import { inject } from '@vercel/analytics';

const local = (): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export function initSite(): void {
  // Production builds only, so the dev server is never cached.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err: unknown) => console.warn('service worker not registered:', err));
    });
  }
  // The analytics script is served by Vercel (/_vercel/insights), so skip it on local builds.
  // Query strings are dropped: the multiplayer page's ?code= is a private invite code.
  if (import.meta.env.PROD && !local()) {
    inject({ mode: 'production', beforeSend: e => ({ ...e, url: e.url.split('?')[0]! }) });
  }
}
