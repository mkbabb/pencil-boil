/**
 * Registers the extensionless-relative TS resolve hook for the proof scripts.
 * Usage: node --import ./proofs/loader.mjs proofs/<name>.proof.ts
 */
import { register } from 'node:module';

register('./ts-ext-resolver.mjs', import.meta.url);
