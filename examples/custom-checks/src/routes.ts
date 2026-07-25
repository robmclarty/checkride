/** One HTTP route the app serves. */
export type Route = {
  method: 'GET' | 'POST';
  path: string;
};

/**
 * The routes this service exposes. `scripts/validate-openapi.mjs` reads the
 * `path:` literals out of this file and checks them against `openapi.json`, so
 * adding a route here without documenting it fails the pipeline.
 */
export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/orders' },
  { method: 'POST', path: '/orders' },
];
