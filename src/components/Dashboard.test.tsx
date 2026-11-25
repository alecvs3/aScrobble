import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Dashboard } from "./Dashboard";
import * as workerApi from "../lib/worker-api";
import { appleGetTokens, redeployWorker, rotateAppleTokens } from "../lib/tauri";
import type { HealthStatus } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("../lib/tauri", () => ({
  getWorkerUrl: vi.fn().mockResolvedValue("https://test-worker.workers.dev"),
  getStatusAuthKey: vi.fn().mockResolvedValue("test-auth-key"),
  getWorkerStatus: vi.fn(),
  rotateAppleTokens: vi.fn().mockResolvedValue(undefined),
  appleGetTokens: vi.fn().mockResolvedValue(null),
  loadUserSettings: vi.fn().mockResolvedValue({ poll_interval_minutes: 1 }),
  storageClearAll: vi.fn(),
  updatePollInterval: vi.fn().mockResolvedValue(undefined),
  redeployWorker: vi.fn().mockResolvedValue(undefined),
  appleDecodeTokenExpiry: vi.fn().mockReturnValue(null),
}));

vi.mock("../lib/worker-api", () => ({
  fetchStatus: vi.fn(),
  triggerScrobble: vi.fn().mockResolvedValue({ ok: true, triggered: true }),
  fetchLastfmAlbumArt: vi.fn().mockResolvedValue(null),
  resetWorkerStats: vi.fn(),
}));

const mockCreds = {
  apple: {
    developer_token: "dev_token",
    music_user_token: "user_token",
    captured_at: new Date().toISOString(),
  },
  lastfm: {
    username: "testuser",
    session_key: "lfm_session",
    api_key: "lfm_key",
    shared_secret: "lfm_secret",
  },
  cloudflare_oauth: null,
  cloudflare_token: "cf_token",
  cloudflare_account_id: "cf_account_id",
};

const mockLedger = {
  version: 1,
  last_run_iso: new Date().toISOString(),
  recent_scrobbles: [
    {
      artist: "Aphex Twin",
      track: "Avril 14th",
      album: "Drukqs",
      timestamp_iso: new Date().toISOString(),
      kind: "new" as const,
    },
  ],
  stats: {
    total_scrobbled: 42,
    total_runs: 10,
    total_errors: 0,
    last_success_iso: new Date().toISOString(),
    last_error_iso: null,
    last_error_message: null,
  },
  log_entries: [
    {
      timestamp_iso: new Date().toISOString(),
      step: "poll_idle",
      details: "Checked Apple tracks",
      level: "info" as const,
    },
  ],
};

const healthy: HealthStatus = {
  apple_ok: true,
  apple_days_remaining: null,
  apple_expiry_iso: null,
  apple_expires_soon: false,
  apple_expired: false,
  lastfm_ok: true,
  worker_deployed: true,
  worker_reachable: true,
  worker_error: null,
  circuit_open: false,
};

describe("Dashboard component integration tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(healthy);
    vi.mocked(workerApi.fetchStatus).mockResolvedValue(mockLedger as any);
  });

  it("renders status active, recent scrobble and scrobble count", async () => {
    render(<Dashboard creds={mockCreds} onReset={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Avril 14th")).toBeInTheDocument();
      expect(screen.getByText("Aphex Twin")).toBeInTheDocument();
      expect(screen.getByText("42")).toBeInTheDocument();
    });
  });

  it("shows the worker's recovery status after a manual trigger", async () => {
    const notice = "Apple Music recovery will start on the next scheduled poll.";
    vi.mocked(workerApi.triggerScrobble).mockResolvedValueOnce({
      ok: true,
      triggered: true,
      ledger: { ...mockLedger, history_recovery_notice: notice },
    });
    render(<Dashboard creds={mockCreds} onReset={vi.fn()} />);

    await screen.findByText("Avril 14th");
    fireEvent.click(screen.getByRole("button", { name: "Trigger scrobble now" }));
    expect(workerApi.triggerScrobble).toHaveBeenCalledWith(
      "https://test-worker.workers.dev",
      "test-auth-key"
    );
    expect(await screen.findByText(notice)).toBeInTheDocument();
  });

  it("toggles Worker Log panel collapse state", async () => {
    render(<Dashboard creds={mockCreds} onReset={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Worker Log/)).toBeInTheDocument();
    });

    const toggleBtn = screen.getByRole("button", { name: /Worker Log/ });
    expect(screen.queryByText("poll_idle")).not.toBeInTheDocument();
    fireEvent.click(toggleBtn);
    expect(screen.getByText("poll_idle")).toBeInTheDocument();
    fireEvent.click(toggleBtn);
    expect(screen.queryByText("poll_idle")).not.toBeInTheDocument();
  });

  it("rotates Apple Music without a saved Cloudflare account ID and refreshes health", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ...healthy, apple_ok: false, apple_expired: true });
    let finishRotation!: () => void;
    vi.mocked(rotateAppleTokens).mockImplementationOnce(() => new Promise((resolve) => {
      finishRotation = resolve;
    }));
    vi.mocked(appleGetTokens).mockResolvedValueOnce(mockCreds.apple);

    render(<Dashboard creds={{ ...mockCreds, cloudflare_account_id: null }} onReset={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Rotate Apple Tokens/ }));
    expect(rotateAppleTokens).toHaveBeenCalledWith(null);
    expect(screen.getByRole("button", { name: "Waiting for Apple Music…" })).toBeDisabled();
    finishRotation();

    expect(await screen.findByText("Apple Music tokens updated.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Rotate Apple Tokens/ })).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reports a failed Worker resync and lets the user retry", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ...healthy, worker_reachable: false, worker_error: "Worker HTTP 503" });
    vi.mocked(redeployWorker).mockRejectedValueOnce("Cloudflare authorization expired");

    render(<Dashboard creds={mockCreds} onReset={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Resync Worker Code/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Worker sync failed: Cloudflare authorization expired");

    fireEvent.click(screen.getByRole("button", { name: /Resync Worker Code/ }));
    expect(await screen.findByText("Worker code synced to Cloudflare.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Resync Worker Code/ })).not.toBeInTheDocument());
    expect(redeployWorker).toHaveBeenCalledTimes(2);
  });

  it("retries a paused poll and shows the Worker error", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ...healthy, circuit_open: true, worker_error: "Polling is paused." });
    vi.mocked(workerApi.triggerScrobble).mockResolvedValueOnce({
      ok: false,
      triggered: true,
      ledger: mockLedger,
      error: "Apple Music is unavailable.",
    });

    render(<Dashboard creds={mockCreds} onReset={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry Poll" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Apple Music is unavailable.");
    expect(redeployWorker).not.toHaveBeenCalled();
  });
});
