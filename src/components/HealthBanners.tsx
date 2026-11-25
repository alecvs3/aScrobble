import { useState } from "react";
import type { HealthStatus } from "../types";

interface HealthBannersProps {
  status: HealthStatus | null;
  busy: boolean;
  rotating: boolean;
  syncing: boolean;
  retrying: boolean;
  onRotateApple?: () => void;
  onFixWorker?: () => void;
  onRetryWorker?: () => void;
}

export function HealthBanners({
  status, busy, rotating, syncing, retrying, onRotateApple, onFixWorker, onRetryWorker,
}: HealthBannersProps) {
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  // DEV Test Overrides
  const [devOverride, setDevOverride] = useState<Partial<HealthStatus> | null>(null);

  const activeStatus: HealthStatus | null = devOverride
    ? ({
        apple_ok: true,
        apple_days_remaining: 3,
        apple_expiry_iso: new Date(Date.now() + 3 * 86400000).toISOString(),
        apple_expires_soon: true,
        apple_expired: false,
        lastfm_ok: true,
        worker_deployed: true,
        worker_reachable: true,
        worker_error: null,
        circuit_open: false,
        ...devOverride,
      } as HealthStatus)
    : status;

  if (!activeStatus) return null;

  const dismiss = (id: string) => {
    setDismissed((prev) => ({ ...prev, [id]: true }));
  };

  const appleExpiredKey = `apple-expired:${activeStatus.apple_expiry_iso ?? ""}`;
  const appleSoonKey = `apple-soon:${activeStatus.apple_expiry_iso ?? ""}`;
  const workerErrorKey = `worker-error:${activeStatus.worker_error}`;
  const showAppleExpired = activeStatus.apple_expired && !dismissed[appleExpiredKey];
  const showAppleSoon =
    !activeStatus.apple_expired &&
    activeStatus.apple_expires_soon &&
    !dismissed[appleSoonKey];
  const showWorkerError =
    activeStatus.worker_deployed &&
    activeStatus.worker_error &&
    !dismissed[workerErrorKey];

  return (
    <div className="health-banners-container">
      {/* Dev Mode Banner Tester Bar */}
      {Boolean((import.meta as any).env?.DEV) && (
        <div className="dev-health-tester">
          <span className="dev-tester-label">🧪 DEV Banner Tester:</span>
          <button
            className={`btn-dev-pill ${devOverride?.apple_expires_soon ? "active" : ""}`}
            onClick={() =>
              setDevOverride({
                apple_expires_soon: true,
                apple_expired: false,
                apple_days_remaining: 3,
              })
            }
          >
            ⚠️ Token Expiring (3d)
          </button>
          <button
            className={`btn-dev-pill ${devOverride?.apple_expired ? "active" : ""}`}
            onClick={() =>
              setDevOverride({
                apple_expires_soon: false,
                apple_expired: true,
                apple_days_remaining: 0,
              })
            }
          >
            🔴 Token Expired
          </button>
          <button
            className={`btn-dev-pill ${devOverride?.worker_error ? "active" : ""}`}
            onClick={() =>
              setDevOverride({
                worker_error: "Worker HTTP 500: KV Namespace quota exceeded",
                worker_reachable: false,
              })
            }
          >
            ☁️ Worker Down
          </button>
          {devOverride && (
            <button
              className="btn-dev-pill reset"
              onClick={() => {
                setDevOverride(null);
                setDismissed({});
              }}
            >
              ✕ Clear Test State
            </button>
          )}
        </div>
      )}

      {/* Banner 1: Apple Token Expired */}
      {showAppleExpired && (
        <div className="health-banner health-banner-danger">
          <div className="health-banner-header">
            <span className="health-banner-badge danger">🚨 Scrobbling Stopped</span>
            <button
              className="update-banner-close"
              onClick={() => dismiss(appleExpiredKey)}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
          <div className="health-banner-title">Your Apple Music token has expired</div>
          <div className="health-banner-desc">
            Apple Music session tokens expire every 6 months. Rotate your token to resume scrobbling automatically.
          </div>
          <div className="health-banner-actions">
            {onRotateApple && (
              <button className="btn-health-action danger" onClick={onRotateApple} disabled={busy}>
                {rotating ? "Waiting for Apple Music…" : "🔑 Rotate Apple Tokens"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Banner 2: Apple Token Expiring Soon */}
      {showAppleSoon && (
        <div className="health-banner health-banner-warning">
          <div className="health-banner-header">
            <span className="health-banner-badge warning">⚠️ Token Expiring Soon</span>
            <button
              className="update-banner-close"
              onClick={() => dismiss(appleSoonKey)}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
          <div className="health-banner-title">
            Apple Music token expires in {activeStatus.apple_days_remaining ?? 3} day(s)
          </div>
          <div className="health-banner-desc">
            Rotate your Apple Music token now so your cloud scrobbler keeps running uninterrupted.
          </div>
          <div className="health-banner-actions">
            {onRotateApple && (
              <button className="btn-health-action warning" onClick={onRotateApple} disabled={busy}>
                {rotating ? "Waiting for Apple Music…" : "🔑 Rotate Token Now"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Banner 3: Worker Error */}
      {showWorkerError && (
        <div className="health-banner health-banner-danger">
          <div className="health-banner-header">
            <span className="health-banner-badge danger">
              {activeStatus.worker_reachable ? "Polling issue" : "☁️ Worker unavailable"}
            </span>
            <button
              className="update-banner-close"
              onClick={() => dismiss(workerErrorKey)}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
          <div className="health-banner-title">Scrobbler Worker Alert</div>
          <div className="health-banner-desc">{activeStatus.worker_error}</div>
          {activeStatus.worker_reachable && onRetryWorker ? (
            <div className="health-banner-actions">
              <button className="btn-health-action danger" onClick={onRetryWorker} disabled={busy}>
                {retrying ? "Retrying…" : "Retry Poll"}
              </button>
            </div>
          ) : onFixWorker && (
            <div className="health-banner-actions">
              <button className="btn-health-action danger" onClick={onFixWorker} disabled={busy}>
                {syncing ? "Syncing Worker…" : "⚡ Resync Worker Code"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
