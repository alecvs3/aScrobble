import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppleTrack, Env } from "../src/env";
import type { LedgerData } from "../src/ledger";
import { KV_KEY_APPLE_DEV_TOKEN, KV_KEY_APPLE_USER_TOKEN } from "../src/kv_keys";

function track(id: string): AppleTrack {
  return { id, name: id, artist: "Artist", album: "Album", duration_ms: 180_000 };
}

function tracks(prefix: string, count: number): AppleTrack[] {
  return Array.from({ length: count }, (_, index) => track(`${prefix}-${index}`));
}

function applePage(history: AppleTrack[], offset: number): Response {
  const page = history.slice(offset, offset + 30);
  const next = offset + page.length;
  return Response.json({
    data: page.map((song) => ({
      id: song.id,
      type: song.id.startsWith("library-") ? "library-songs" : "songs",
      attributes: { name: song.name, artistName: song.artist, durationInMillis: song.duration_ms },
    })),
    next: next < history.length ? `/v1/me/recent/played/tracks?offset=${next}&limit=30` : undefined,
  });
}

function lastfmReceipt(count: number, ignoreFirst = false): Response {
  return Response.json({
    scrobbles: {
      "@attr": { accepted: count - Number(ignoreFirst), ignored: Number(ignoreFirst) },
      scrobble: Array.from({ length: count }, (_, index) => ({
        ignoredMessage: { code: ignoreFirst && index === 0 ? "3" : "0" },
      })),
    },
  });
}

async function setup(checkpoint: AppleTrack[], overrides: Partial<LedgerData> = {}) {
  vi.resetModules();
  const worker = await import("../src/scrobbler");
  const lastRun = "2026-10-23T11:59:00Z";
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  const values = new Map<string, string>([
    [KV_KEY_APPLE_DEV_TOKEN, "dev"],
    [KV_KEY_APPLE_USER_TOKEN, "user"],
    ["ledger:v1", JSON.stringify({
      version: 1,
      last_run_iso: lastRun,
      previous_recent: checkpoint,
      recent_scrobbles: [],
      stats: {
        total_scrobbled: 20,
        total_runs: 40,
        total_errors: 1,
        last_success_iso: "2026-10-22T12:00:00Z",
        last_error_iso: lastRun,
        last_error_message: "apple_token_expired",
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
  };
  return { worker, env, saved: () => JSON.parse(values.get("ledger:v1")!) as LedgerData };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Apple Music outage recovery", () => {
  it("finds a checkpoint across a page boundary beyond 120 tracks and resumes batches with stable timestamps", async () => {
    const checkpoint = tracks("saved", 12);
    const { worker, env, saved } = await setup(checkpoint);
    // Rotate against a ledger created before the recovery fields existed.
    await worker.updateTokens(env, "fresh-dev", "fresh-user");
    expect(saved().apple_history_interrupted).toBe(true);

    const missing = tracks("missing", 147);
    const history = [...missing, ...checkpoint, ...tracks("older", 10)];
    const offsets: number[] = [];
    const submissions: URLSearchParams[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "api.music.apple.com") {
        const offset = Number(url.searchParams.get("offset"));
        offsets.push(offset);
        return applePage(history, offset);
      }
      expect(url.host).toBe("ws.audioscrobbler.com");
      const body = new URLSearchParams(String(init?.body));
      submissions.push(body);
      if (submissions.length === 1) return Response.json({ error: 16 });
      const count = [...body.keys()].filter((key) => key.startsWith("track[")).length;
      return lastfmReceipt(count, submissions.length === 2);
    });

    expect(await worker.pollAndScrobble(env, true)).toMatchObject({ recovery_deferred: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 147, accepted: 0 });
    expect(offsets).toEqual([0, 30, 60, 90, 120, 150, 0]);
    expect(saved().pending_history_recovery?.plays).toHaveLength(147);
    expect(submissions).toHaveLength(0);

    vi.setSystemTime(new Date("2026-10-23T12:01:00Z"));
    expect(await worker.pollAndScrobble(env)).toMatchObject({ ok: false, error_message: "history_recovery_submit_failed" });
    expect(saved().pending_history_recovery?.plays).toHaveLength(147);
    expect(saved().stats.total_scrobbled).toBe(20);

    vi.setSystemTime(new Date("2026-10-23T12:02:00Z"));
    expect(await worker.pollAndScrobble(env)).toMatchObject({ accepted: 49, ignored: 1 });
    expect(submissions[0].toString()).toBe(submissions[1].toString());
    expect(submissions[1].get("track[0]")).toBe("missing-146");
    expect(saved().pending_history_recovery?.plays).toHaveLength(97);

    vi.setSystemTime(new Date("2026-10-23T12:03:00Z"));
    expect(await worker.pollAndScrobble(env)).toMatchObject({ accepted: 50 });
    vi.setSystemTime(new Date("2026-10-23T12:04:00Z"));
    expect(await worker.pollAndScrobble(env)).toMatchObject({ accepted: 47 });
    expect(saved().pending_history_recovery).toBeUndefined();
    expect(saved().stats.total_scrobbled).toBe(166);
    expect(saved().recent_scrobbles).toHaveLength(146);
    expect(saved().recent_scrobbles.every((play) => /^missing-/.test(play.track))).toBe(true);
    expect(saved().recent_scrobbles.some((play) => play.track === "missing-146")).toBe(false);
    expect(saved().history_recovery_notice).toContain("146 of 147");
  });

  it("reports the gap when Apple's history ends without an overlap and then scrobbles new plays normally", async () => {
    const { worker, env, saved } = await setup(tracks("saved", 12));
    const unrelated = tracks("current", 61);
    let history = unrelated;
    const submissions: URLSearchParams[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "api.music.apple.com") {
        return applePage(history, Number(url.searchParams.get("offset")));
      }
      submissions.push(new URLSearchParams(String(init?.body)));
      return lastfmReceipt(1);
    });

    await worker.pollAndScrobble(env);
    expect(saved().history_recovery_notice).toContain("history ended");
    expect(saved().pending_history_recovery).toBeUndefined();
    expect(submissions).toHaveLength(0);

    history = [track("new-play"), ...unrelated];
    vi.setSystemTime(new Date("2026-10-23T12:01:00Z"));
    expect(await worker.pollAndScrobble(env)).toMatchObject({ accepted: 1 });
    expect(submissions).toHaveLength(1);
    expect(submissions[0].get("track[0]")).toBe("new-play");
  });

  it("keeps the checkpoint when a deeper Apple page fails", async () => {
    const checkpoint = tracks("saved", 12);
    const { worker, env, saved } = await setup(checkpoint);
    const history = [...tracks("current", 50), ...checkpoint];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return offset === 30 ? new Response(null, { status: 503 }) : applePage(history, offset);
    });

    expect(await worker.pollAndScrobble(env)).toMatchObject({ ok: false });
    expect(saved().previous_recent).toEqual(checkpoint);
    expect(saved().apple_history_interrupted).toBe(true);
    expect(saved().pending_history_recovery).toBeUndefined();
  });

  it("does not submit when the saved sequence appears twice in the fetched history", async () => {
    const checkpoint = tracks("saved", 12);
    const { worker, env, saved } = await setup(checkpoint);
    const history = [track("new-play"), ...checkpoint, track("another-play"), ...checkpoint];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.host).toBe("api.music.apple.com");
      return applePage(history, Number(url.searchParams.get("offset")));
    });

    await worker.pollAndScrobble(env);
    expect(saved().history_recovery_notice).toContain("checkpoint was ambiguous");
    expect(saved().pending_history_recovery).toBeUndefined();
  });

  it("finds a legacy checkpoint in the names of saved scrobbles when the Apple snapshot is empty", async () => {
    const checkpoint = tracks("saved", 8);
    const recentScrobbles = checkpoint.map((song, index) => ({
      track: song.name,
      artist: song.artist.toUpperCase(),
      album: song.album,
      timestamp_iso: new Date(Date.UTC(2026, 9, 22, 11, 59 - index)).toISOString(),
      kind: "new" as const,
    })).reverse();
    const { worker, env, saved } = await setup([], { recent_scrobbles: recentScrobbles });
    // Library plays above a newer catalog play are newer too. The 33 library
    // plays just above the match may predate the catalog-only checkpoint.
    const history = [
      ...tracks("library-new", 3), ...tracks("missed", 121), ...tracks("library", 33),
      checkpoint[0], track("library-older"), ...checkpoint.slice(1),
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.host).toBe("api.music.apple.com");
      expect(url.searchParams.get("types")).toBe("songs,library-songs");
      return applePage(history, Number(url.searchParams.get("offset")));
    });

    expect(await worker.pollAndScrobble(env, true)).toMatchObject({ recovery_deferred: true });
    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 124, accepted: 0 });
    expect(saved().history_recovery_notice).toContain("The original Apple Music checkpoint is missing");
    expect(saved().pending_history_recovery).toBeUndefined();
    expect(saved().previous_recent).toHaveLength(120);
    expect(saved().previous_recent.slice(0, 3).every((song) => song.library)).toBe(true);
    expect(saved().library_history_since_iso).toBeDefined();
  });

  it("reports a verified old gap without assigning recent timestamps to undated history", async () => {
    const checkpoint = tracks("saved", 8);
    const { worker, env, saved } = await setup(checkpoint, {
      snapshot_poll_iso: "2026-09-22T12:00:00Z",
    });
    const history = [...tracks("missed", 20), ...checkpoint];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.host).toBe("api.music.apple.com");
      return applePage(history, Number(url.searchParams.get("offset")));
    });

    expect(await worker.pollAndScrobble(env)).toMatchObject({ detected: 20, accepted: 0 });
    expect(saved().history_recovery_notice).toContain("outside Last.fm’s backfill window");
    expect(saved().pending_history_recovery).toBeUndefined();
    expect(saved().stats.total_scrobbled).toBe(20);
  });
});
