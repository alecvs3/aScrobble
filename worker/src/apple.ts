/**
 * Apple Music API client.
 *
 * Ported 1:1 from v1/apple_scrobbler/apple.py.
 *
 * Uses the developer token and Music-User-Token captured by the desktop app.
 * Apple returns at most 30 recently played tracks per request, with no play
 * timestamps. Regular polls read up to four pages. Outage recovery can go deeper.
 *
 * The Origin + Referer + User-Agent spoof makes the request look
 * indistinguishable from the real web player, which is how Cider
 * worked around Apple's client checks after they tightened them
 * in late 2022.
 *
 * Apple keeps catalog plays and plays from the user's library in separate
 * lists. Without `types`, the endpoint returns only catalog plays, so every
 * request asks for both. Apple then merges them in play order.
 *
 * Regular polls drop identical entries at a page boundary, where changes
 * during offset pagination can duplicate an entry. Recovery verifies the
 * first page again and keeps legitimate repeats in the recovered sequence.
 */
import type { AppleTrack } from "./env";

const API_BASE = "https://api.music.apple.com/v1";
const PAGE_SIZE = 30;
const RECENT_TRACKS_URL = `${API_BASE}/me/recent/played/tracks`;
const HISTORY_TYPES = "songs,library-songs";
const POLL_PAGES = 4;
// Bound the one-off search within the Worker's per-invocation request budget.
const RECOVERY_PAGES = 30;
const MIN_CHECKPOINT_TRACKS = 5;
const MAX_CHECKPOINT_TRACKS = 8;

export class TokenExpiredError extends Error {
  constructor() {
    super(
      "Apple Music API returned 401. Dev token or Music-User-Token expired. " +
        "Re-open the aScrobble desktop app to re-authenticate with Apple Music."
    );
    this.name = "TokenExpiredError";
  }
}

const SPOOFED_HEADERS = {
  Origin: "https://music.apple.com",
  Referer: "https://music.apple.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15",
} as const;

interface AppleApiItem {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumArtistName?: string;
    albumName?: string;
    durationInMillis?: number;
    isrc?: string;
  };
}

interface AppleApiResponse {
  data: AppleApiItem[];
  next?: string;
}

/** Normalize album name by stripping trailing ' - EP' or ' - Single' suffixes. */
function normalizeAlbumName(rawAlbum: string): string {
  if (!rawAlbum) return "";
  return rawAlbum.replace(/ - (EP|Single)$/i, "").trim();
}

function trackFromItem(item: AppleApiItem): AppleTrack {
  const attrs = item.attributes ?? {};
  return {
    id: item.id,
    name: attrs.name ?? "",
    artist: attrs.artistName ?? "",
    album_artist: attrs.albumArtistName ?? attrs.artistName ?? "",
    album: normalizeAlbumName(attrs.albumName ?? ""),
    duration_ms: attrs.durationInMillis ?? 180_000,
    isrc: attrs.isrc,
    ...(item.type === "library-songs" ? { library: true } : {}),
  };
}

async function fetchHistoryPage(
  url: URL,
  headers: Record<string, string>,
  probingOffset = false,
): Promise<AppleApiResponse> {
  // Workers returns redirect responses in manual mode. Reject them below
  // so Apple credentials are never forwarded to the redirect destination.
  const response = await fetch(url, { headers, redirect: "manual" });
  if (response.status === 401) throw new TokenExpiredError();
  if (!response.ok) {
    await response.body?.cancel();
    if (probingOffset && (response.status === 400 || response.status === 404)) return { data: [] };
    throw new Error(`Apple Music history returned HTTP ${response.status}`);
  }
  const page = await response.json<AppleApiResponse>();
  if (!Array.isArray(page.data)) throw new Error("Apple Music history response has no track list");
  return page;
}

function historyUrl(offset: number): URL {
  const url = new URL(RECENT_TRACKS_URL);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("types", HISTORY_TYPES);
  return url;
}

function historyHeaders(devToken: string, musicUserToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${devToken}`,
    "Music-User-Token": musicUserToken,
    ...SPOOFED_HEADERS,
  };
}

export async function fetchRecentlyPlayed(
  devToken: string,
  musicUserToken: string
): Promise<AppleTrack[]> {
  const tracks: AppleTrack[] = [];
  const headers = historyHeaders(devToken, musicUserToken);
  for (let page = 0; page < POLL_PAGES; page++) {
    const { data: items } = await fetchHistoryPage(historyUrl(page * PAGE_SIZE), headers, page > 0);
    const previousId = tracks.at(-1)?.id;
    tracks.push(...items.filter((item, index) => item.id && (index > 0 || item.id !== previousId)).map(trackFromItem));
    if (items.length < PAGE_SIZE) break;
  }
  return tracks;
}

export interface AppleHistoryRecovery {
  snapshot: AppleTrack[];
  checked: number;
  matchLength: number;
  missing: AppleTrack[] | null;
  reason?: "history ended" | "search limit reached" | "checkpoint was ambiguous" | "checkpoint was too short";
}

export interface HistoryCheckpoint {
  keys: string[];
  identity: "apple-id" | "track-metadata";
  capturedAt: Date | null;
  /** Saved before the worker read library plays, so it holds catalog plays only. */
  catalogOnly: boolean;
}

export function historyTrackKey(artist: string, track: string): string {
  const normalize = (value: string) =>
    value.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  return JSON.stringify([normalize(artist), normalize(track)]);
}

function nextHistoryPage(url: URL, page: AppleApiResponse): URL | null {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!page.next) {
    // The web player endpoint has returned full pages without a next link.
    return page.data.length === PAGE_SIZE ? historyUrl(offset + PAGE_SIZE) : null;
  }
  const next = new URL(page.next, url);
  const nextOffset = Number(next.searchParams.get("offset"));
  if (next.origin !== url.origin || next.pathname !== url.pathname ||
      !Number.isSafeInteger(nextOffset) || nextOffset !== offset + page.data.length) {
    throw new Error("Apple Music returned an invalid history continuation");
  }
  // Keep the page size and both history lists if Apple's link drops them.
  next.searchParams.set("limit", String(PAGE_SIZE));
  next.searchParams.set("types", HISTORY_TYPES);
  return next;
}

export async function fetchRecoveryHistory(
  devToken: string,
  musicUserToken: string,
  checkpoint: HistoryCheckpoint,
): Promise<AppleHistoryRecovery> {
  const metadata = checkpoint.identity === "track-metadata";
  const anchor = checkpoint.keys.slice(0, metadata ? MIN_CHECKPOINT_TRACKS : MAX_CHECKPOINT_TRACKS);
  const matchesAt = (keys: string[], index: number) =>
    anchor.every((key, offset) => keys[index + offset] === key);
  const shortCheckpoint = anchor.length < MIN_CHECKPOINT_TRACKS || new Set(anchor).size < 3;
  const repeatedCheckpoint = !shortCheckpoint &&
    checkpoint.keys.some((_, index) => index > 0 && matchesAt(checkpoint.keys, index));
  const headers = historyHeaders(devToken, musicUserToken);
  const firstUrl = historyUrl(0);
  const tracks: AppleTrack[] = [];
  // Matching runs over the entries the checkpoint could contain. A catalog-only
  // checkpoint never saw library plays, so they are skipped while matching.
  const keys: string[] = [];
  const keyPositions: number[] = [];
  const result: AppleHistoryRecovery = { snapshot: [], checked: 0, matchLength: anchor.length, missing: null };
  const pageSignatures = new Set<string>();
  let url: URL | null = firstUrl;
  let firstPageSignature = "";
  let nextMatchIndex = 0;
  let matchIndex = -1;
  let ambiguous = repeatedCheckpoint;
  let probingOffset = false;
  let pagesWithTracks = 0;

  for (let page = 0; url && page < RECOVERY_PAGES; page++) {
    const response = await fetchHistoryPage(url, headers, probingOffset);
    const items = response.data;
    const signature = JSON.stringify(items.map((item) => item.id));
    if (page === 0) firstPageSignature = signature;
    if ((probingOffset && !response.next && pageSignatures.has(signature)) || items.length === 0) {
      url = null;
      break;
    }
    pageSignatures.add(signature);
    pagesWithTracks++;
    // Keep every entry, including repeats at page boundaries. Verify the head
    // after finding a match to catch offset shifts while scanning.
    for (const item of items) {
      const track = trackFromItem(item);
      tracks.push(track);
      if (checkpoint.catalogOnly && track.library) continue;
      keys.push(metadata ? historyTrackKey(track.artist, track.name) : track.id);
      keyPositions.push(tracks.length - 1);
    }
    if (!shortCheckpoint && !ambiguous) {
      for (; nextMatchIndex + anchor.length <= keys.length; nextMatchIndex++) {
        if (!matchesAt(keys, nextMatchIndex)) continue;
        if (matchIndex !== -1) {
          ambiguous = true;
          break;
        }
        matchIndex = keyPositions[nextMatchIndex];
      }
    }

    if (tracks.length >= POLL_PAGES * PAGE_SIZE &&
        (shortCheckpoint || ambiguous || matchIndex !== -1)) break;
    url = nextHistoryPage(url, response);
    probingOffset = !response.next;
  }

  result.snapshot = tracks.slice(0, POLL_PAGES * PAGE_SIZE).filter((track) => track.id);
  result.checked = tracks.length;
  if (result.snapshot.length === 0) throw new Error("Apple Music returned an empty recovery history");
  if (!shortCheckpoint && !ambiguous && pagesWithTracks > 1) {
    const head = await fetchHistoryPage(firstUrl, headers);
    if (JSON.stringify(head.data.map((item) => item.id)) !== firstPageSignature) {
      throw new Error("Apple Music history shifted during recovery");
    }
  }
  if (shortCheckpoint) result.reason = "checkpoint was too short";
  else if (ambiguous) result.reason = "checkpoint was ambiguous";
  else if (matchIndex === -1) result.reason = url ? "search limit reached" : "history ended";
  else result.missing = tracks.slice(0, newerThanCheckpoint(tracks, matchIndex, checkpoint.catalogOnly))
    .filter((track) => track.id);
  return result;
}

/**
 * Count the entries played after the checkpoint was saved.
 *
 * Everything above the matched sequence is newer than its first track. For a
 * catalog-only checkpoint, a library play just above the match may predate the
 * checkpoint, because the checkpoint never listed library plays. A library play
 * above a newer catalog play is newer too, so the cut is placed after the
 * lowest newer catalog play.
 */
function newerThanCheckpoint(tracks: AppleTrack[], matchIndex: number, catalogOnly: boolean): number {
  if (!catalogOnly) return matchIndex;
  for (let index = matchIndex - 1; index >= 0; index--) {
    if (!tracks[index].library) return index + 1;
  }
  return 0;
}
