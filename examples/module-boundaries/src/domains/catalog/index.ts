/**
 * Catalog's public surface. Re-exports only — no logic lives in a barrel.
 *
 * This is the whole API other modules get. It is the same contract a service
 * boundary would give you, minus the network.
 */

export { findProduct } from './product.js';
