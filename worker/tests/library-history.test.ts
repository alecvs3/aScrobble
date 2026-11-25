import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppleTrack, Env } from "../src/env";
import type { LedgerData } from "../src/ledger";
import { KV_KEY_APPLE_DEV_TOKEN, KV_KEY_APPLE_USER_TOKEN } from "../src/kv_keys";

// Library entries use Apple's "i." library IDs, like the real feed.
function track(id: string): AppleTrack {
  const library = id.startsWith("i.");
  return {
    id,
    name: id,
    artist: "Artist",
    album: "Album",
    duration_ms: 180_000,
    ...(library ? { library: true } : {}),
  };
}

function tracks(prefix: string, count: number): AppleTrack[] {
  return Array.from({ length: count }, (_, index) => track(`${prefix}${index}`));
}

function applePage(history: AppleTrack[], url: URL): Response {
  const offset = Number(url.searchParams.get("offset"));
  // Without types, Apple returns catalog plays only.
  const visible = url.searchParams.get("types") === "songs,library-songs"
    ? history
    : history.filter((song) => !song.library);
  const page = visible.slice(offset, offset + 30);
  const next = offset + page.length;
  return Response.json({
    data: page.map((song) => ({
      id: song.id,
      type: song.library ? "library-songs" : "songs",
      attributes: { name: song.name, artistName: song.artist, durationInMillis: song.duration_ms },
    })),
    next: next < visible.length
      ? `/v1/me/recent/played/tracks?offset=${next}&types=songs%2Clibrary-songs`
      : undefined,
  });
}

function lastfmReceipt(count: number): Response {
  return Response.json({
    scrobbles: {
      "@attr": { accepted: count, ignored: 0 },
      scrobble: Array.from({ length: count }, () => ({ ignoredMessage: { code: "0" } })),
    },
  });
}

const NOW = "2026-10-23T12:00:00Z";

async function setup(previous: AppleTrack[], overrides: Partial<LedgerData> = {}) {
  vi.resetModules();
  const worker = await import("../src/scrobbler");
  vi.setSystemTime(new Date(NOW));
  const values = new Map<string, string>([
    [KV_KEY_APPLE_DEV_TOKEN, "dev"],
    [KV_KEY_APPLE_USER_TOKEN, "user"],
    ["ledger:v1", JSON.stringify({
      version: 1,
      last_run_iso: "2026-10-23T11:59:00Z",
      snapshot_poll_iso: "2026-10-23T11:59:00Z",
      previous_recent: previous,
      recent_scrobbles: [],
      stats: {
        total_scrobbled: 0,
        total_runs: 1,
        total_errors: 0,
        last_success_iso: "2026-10-23T11:59:00Z",
        last_error_iso: null,
        last_error_message: null,
      },
      ...overrides,
    } satisfies LedgerData)],
  ]);
  const kv = {
    async get(key: string, type?: string) {
      const value = values.get(key);
      return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  };
  const env: Env = {
    ASCROBBLE_STATE: kv as KVNamespace,
    LASTFM_API_KEY: "key",
    LASTFM_SHARED_SECRET: "secret",
    LASTFM_SESSION_KEY: "session",
    STATUS_AUTH_KEY: "status",
    LISTENBRAINZ_TOKEN: "lb",
  };
  return { worker, env, saved: () => JSON.parse(values.get("ledger:v1")!) as LedgerData };
}

interface Calls {
  apple: URL[];
  lastfm: URLSearchParams[];
  listenbrainz: number;
}

function mockServices(
  history: () => AppleTrack[],
  lastfm: (body: URLSearchParams, count: number) => Response = (_, count) => lastfmReceipt(count),
): Calls {
  const calls: Calls = { apple: [], lastfm: [], listenbrainz: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "api.music.apple.com") {
      calls.apple.push(url);
      expect(url.pathname).toBe("/v1/me/recent/played/tracks");
      return applePage(history(), url);
    }
    if (url.host === "api.listenbrainz.org") {
      calls.listenbrainz++;
      return Response.json({ status: "ok" });
    }
    expect(url.host).toBe("ws.audioscrobbler.com");
    const body = new URLSearchParams(String(init?.body));
    calls.lastfm.push(body);
    const count = [...body.keys()].filter((key) => key.startsWith("track[")).length;
    return lastfm(body, count);
  });
  return calls;
}

function submittedTracks(body: URLSearchParams): string[] {
  return [...body.entries()].filter(([key]) => key.startsWith("track[")).map(([, value]) => value);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plays from the Apple Music library", () => {
  it("reads both history lists and marks library plays", async () => {
    const { fetchRecentlyPlayed } = await import("../src/apple");
    const calls = mockServices(() => [track("c1"), track("i.l1"), track("c2")]);
    const result = await fetchRecentlyPlayed("dev", "user");
    expect(result.map((song) => song.id)).toEqual(["c1", "i.l1", "c2"]);
    expect(result[1].library).toBe(true);
    expect(result[0].library).toBeUndefined();
    expect(calls.apple.every((url) => url.searchParams.get("types") === "songs,library-songs")).toBe(true);
  });

  it("upgrades a catalog-only snapshot without scrobbling old library plays", async () => {
    // Saved before library plays were read: catalog plays only, no marker.
    const previous = tracks("c", 12);
    const { worker, env, saved } = await setup(previous);
    let history = [track("c-new"), ...previous.slice(0, 3), track("i.old1"), ...previous.slice(3, 9), track("i.old2"), ...previous.slice(9)];
    const calls = mockServices(() => history);

    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 1, accepted: 1 });
    expect(submittedTracks(calls.lastfm[0])).toEqual(["c-new"]);
    expect(saved().library_history_since_iso).toBe(new Date(NOW).toISOString());
    expect(saved().previous_recent.map((song) => song.id)).toEqual(history.map((song) => song.id));

    // From now on, a library play is scrobbled like any other.
    history = [track("i.played-now"), ...history];
    vi.setSystemTime(new Date("2026-10-23T12:01:00Z"));
    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 1, accepted: 1 });
    expect(submittedTracks(calls.lastfm[1])).toEqual(["i.played-now"]);
  });

  it("saves the upgraded snapshot even when nothing new was played", async () => {
    const previous = tracks("c", 12);
    const { worker, env, saved } = await setup(previous, { last_save_iso: "2026-10-23T11:59:30Z" });
    const history = [...previous.slice(0, 5), track("i.old"), ...previous.slice(5)];
    const calls = mockServices(() => history);

    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 0 });
    expect(calls.lastfm).toHaveLength(0);
    expect(saved().library_history_since_iso).toBeDefined();
    expect(saved().previous_recent.some((song) => song.library)).toBe(true);
  });

  it("makes one Apple request per page and no play-count lookups", async () => {
    const previous = [...tracks("c", 6), track("i.l"), ...tracks("d", 5)];
    const { worker, env } = await setup(previous, { library_history_since_iso: "2026-10-01T00:00:00Z" });
    const calls = mockServices(() => previous);
    await worker.pollAndScrobble(env);
    expect(calls.apple).toHaveLength(1);
  });
});

describe("outage recovery with library plays", () => {
  const interrupted: Partial<LedgerData> = { apple_history_interrupted: true };

  it("recovers only library plays known to be newer than a catalog-only checkpoint", async () => {
    const checkpoint = tracks("saved", 10);
    const { worker, env, saved } = await setup(checkpoint, interrupted);
    const history = [
      track("i.new-a"), track("missed-1"), track("i.new-b"), track("missed-0"),
      // Could have been played before the checkpoint was saved.
      track("i.unknown"),
      ...checkpoint.slice(0, 4), track("i.older"), ...checkpoint.slice(4),
    ];
    mockServices(() => history);

    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 4, accepted: 0 });
    const queued = saved().pending_history_recovery!;
    // Queued oldest first.
    expect(queued.plays.map((play) => play.track.id)).toEqual(["missed-0", "i.new-b", "missed-1", "i.new-a"]);
    expect(queued.source).toBe("recovery");
    expect(saved().library_history_since_iso).toBeDefined();
    expect(saved().previous_recent[0].id).toBe("i.new-a");
  });

  it("recovers every newer play when the checkpoint already lists library plays", async () => {
    const checkpoint = [...tracks("saved", 3), track("i.saved"), ...tracks("more", 6)];
    const { worker, env, saved } = await setup(checkpoint, {
      ...interrupted,
      library_history_since_iso: "2026-10-01T00:00:00Z",
    });
    const history = [track("missed"), track("i.just-above"), ...checkpoint];
    mockServices(() => history);

    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 2 });
    expect(saved().pending_history_recovery!.plays.map((play) => play.track.id))
      .toEqual(["i.just-above", "missed"]);
  });

  it("does not backfill a gap that started more than 13 days ago", async () => {
    const checkpoint = tracks("saved", 10);
    const { worker, env, saved } = await setup(checkpoint, {
      ...interrupted,
      snapshot_poll_iso: "2026-10-09T23:00:00Z",
    });
    mockServices(() => [track("missed"), ...checkpoint]);

    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 1, accepted: 0 });
    expect(saved().pending_history_recovery).toBeUndefined();
    expect(saved().history_recovery_notice).toContain("outside Last.fm’s backfill window");
  });
});

describe("plays Last.fm doesn't confirm", () => {
  it("queues them with their timestamps and resends them on the next poll", async () => {
    const previous = tracks("c", 10);
    const { worker, env, saved } = await setup(previous, { library_history_since_iso: "2026-10-01T00:00:00Z" });
    let history = [track("first"), track("i.second"), ...previous];
    let lastfmUp = false;
    const calls = mockServices(() => history, (_, count) =>
      lastfmUp ? lastfmReceipt(count) : new Response("unavailable", { status: 503 }));

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 2, accepted: 0, errors: 2, ok: false });
    // Sent once, then retried once within the poll.
    expect(calls.lastfm).toHaveLength(2);
    expect(calls.listenbrainz).toBe(1);
    const queued = saved().pending_history_recovery!;
    expect(queued.source).toBe("retry");
    // Oldest first, like every other queue.
    expect(queued.plays.map((play) => play.track.id)).toEqual(["i.second", "first"]);
    // The snapshot moved on, so these plays aren't detected a second time.
    expect(saved().previous_recent[0].id).toBe("first");

    lastfmUp = true;
    vi.setSystemTime(new Date("2026-10-23T12:01:00Z"));
    expect(await worker.pollAndScrobble(env)).toMatchObject({ accepted: 2 });
    expect(calls.lastfm[2].toString()).toBe(calls.lastfm[0].toString());
    // ListenBrainz already has these plays from the first poll.
    expect(calls.listenbrainz).toBe(1);
    expect(saved().pending_history_recovery).toBeUndefined();
    expect(saved().history_recovery_notice).toContain("Resent plays Last.fm missed");
    expect(saved().recent_scrobbles.map((play) => play.track).sort()).toEqual(["first", "i.second"]);

    // Regular polling resumes.
    history = [track("third"), ...history];
    vi.setSystemTime(new Date("2026-10-23T12:02:00Z"));
    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 1, accepted: 1 });
  });
});
