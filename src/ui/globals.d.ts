// Browser globals the screen code uses that the DOM types don't know about.
export {};

/**
 * The host API when the page runs as a Claude artifact (storage, account, model access). It
 * has no published types, so its results stay untyped here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- untyped external host API */
interface ClaudeHost {
  use?: (name: 'db' | 'user' | 'sample') => Promise<any>;
  hot?: { ready?: (cb: (data: any) => void) => void; data?: any; snapshot?: (fn: () => unknown) => void };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    claude?: ClaudeHost;
    /** Safari before 14.1 */
    webkitAudioContext?: typeof AudioContext;
    // measurement hooks, only in `--mode measure` builds (tools/measure)
    __on?: boolean;
    __T?: Record<string, number[]>;
    __C?: Array<[string, number, number]>;
    __force?: unknown;
  }
}

// The screens attach each seat's elements to its player (never read by the engine, and
// skipped when game state is copied to the worker).
declare module '../engine/state' {
  interface Player {
    el?: HTMLElement;
    betEl?: HTMLElement;
  }
}
