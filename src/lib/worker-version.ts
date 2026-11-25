import { version } from "../../package.json";

const WORKER_SYNC_VERSION = "ascrobble_worker_sync_version";

export function workerNeedsSync(): boolean {
  return localStorage.getItem(WORKER_SYNC_VERSION) !== version;
}

export function recordWorkerSync(): void {
  localStorage.setItem(WORKER_SYNC_VERSION, version);
}
