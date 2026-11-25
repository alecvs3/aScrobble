// Typed fetch wrappers for the deployed worker's HTTP endpoints.
// Each takes the worker URL and status auth key as params.

import type { WorkerLedger, WorkerTrigger } from "../types";
import { getWorkerStatus, resetWorkerStatsBackend, triggerWorker } from "./tauri";

export async function fetchHealth(
  workerUrl: string
): Promise<{ ok: boolean; service: string; version: string }> {
  try {
    const resp = await fetch(`${workerUrl}/health`);
    if (!resp.ok) throw new Error(`Health check failed: HTTP ${resp.status}`);
    return resp.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to reach worker at ${workerUrl}: ${msg}`);
  }
}

export async function fetchStatus(
  _workerUrl: string,
  _authKey: string
): Promise<WorkerLedger> {
  // Call backend command instead of fetching directly - avoids CORS issues
  try {
    console.log("Fetching worker status from backend command");
    const ledger = await getWorkerStatus();
    console.log("Successfully got worker status from backend:", ledger);
    return ledger;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("get_worker_status error:", msg);
    throw new Error(
      `Worker is unreachable. Backend error: ${msg}. Try redeploying the worker.`
    );
  }
}

export function triggerScrobble(
  _workerUrl: string,
  _authKey: string,
): Promise<WorkerTrigger> {
  return triggerWorker();
}

export function resetWorkerStats(
  _workerUrl: string,
  _authKey: string,
): Promise<WorkerLedger> {
  return resetWorkerStatsBackend();
}

export async function fetchLastfmAlbumArt(
  apiKey: string,
  artist: string,
  album: string
): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      method: "album.getinfo",
      artist: artist,
      album: album,
      api_key: apiKey,
      format: "json",
    });
    
    const resp = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    if (!resp.ok) return null;
    
    const data = await resp.json();
    if (!data.album?.image) return null;
    
    // Find the largest image available
    const images = data.album.image as Array<{ size: string; "#text": string }>;
    const largeImage = images.find((img) => img.size === "large" || img.size === "extralarge");
    return largeImage?.["#text"] || images[images.length - 1]?.["#text"] || null;
  } catch (e) {
    // Silently fail - not critical if album art is missing
    return null;
  }
}
