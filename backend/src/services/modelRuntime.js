import { AsyncLocalStorage } from 'node:async_hooks';
/** Per-request inference options are isolated across users and concurrent requests. */
export const modelRuntime = new AsyncLocalStorage();

/**
 * The model the current request was routed to, or `fallback` outside a routed request. Planner/classifier calls that
 * do not name a model use this instead of a fixed tag, so they follow what is actually installed and selected.
 */
export const routedModelOr = (fallback) => modelRuntime.getStore()?.model || fallback;
