//! Proactive health check and notification service.
//!
//! Periodically evaluates Apple Music JWT expiration, Last.fm status, and
//! Cloudflare worker responsiveness. Emits live `health-status` events to
//! the frontend and triggers desktop OS notifications when issues occur.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthStatus {
    pub apple_ok: bool,
    pub apple_days_remaining: Option<i64>,
    pub apple_expiry_iso: Option<String>,
    pub apple_expires_soon: bool, // <= 3 days
    pub apple_expired: bool,       // <= 0 days
    pub lastfm_ok: bool,
    pub worker_deployed: bool,
    pub worker_reachable: bool,
    pub worker_error: Option<String>,
    pub circuit_open: bool,
}

pub async fn check_health() -> HealthStatus {
    let mut status = HealthStatus {
        apple_ok: false,
        apple_days_remaining: None,
        apple_expiry_iso: None,
        apple_expires_soon: false,
        apple_expired: false,
        lastfm_ok: false,
        worker_deployed: false,
        worker_reachable: false,
        worker_error: None,
        circuit_open: false,
    };

    // 1. Apple Music token check
    if let Ok(Some(apple)) = storage::load_apple_tokens() {
        status.apple_ok = true;
        let exp_iso = apple.expires_at.or_else(|| {
            crate::commands::AppleTokens::decode_jwt_exp(&apple.developer_token)
        });
        if let Some(ref iso) = exp_iso {
            status.apple_expiry_iso = Some(iso.clone());
            if let Ok(dt) = DateTime::parse_from_rfc3339(iso) {
                let now = Utc::now();
                let diff_sec = dt.with_timezone(&Utc).timestamp() - now.timestamp();
                let days = if diff_sec > 0 { (diff_sec + 86_399) / 86_400 } else { 0 };
                status.apple_days_remaining = Some(days);
                if diff_sec <= 0 {
                    status.apple_ok = false;
                    status.apple_expired = true;
                } else if days <= 3 {
                    status.apple_expires_soon = true;
                }
            }
        }
    }

    // 2. Last.fm session check
    if let Ok(Some(_)) = storage::load_lastfm_session() {
        status.lastfm_ok = true;
    }

    // 3. Cloudflare Worker status check
    let worker_url = storage::load_worker_url().ok().flatten();
    let auth_key = storage::load_status_auth_key().ok().flatten();

    if worker_url.is_some() && auth_key.is_some() {
        status.worker_deployed = true;
        match crate::commands::get_worker_status().await {
            Ok(ledger) => {
                status.worker_reachable = true;
                let error = ledger.stats.last_error_message.as_deref();
                if error == Some("apple_token_expired") {
                    status.apple_ok = false;
                    status.apple_expired = true;
                    status.apple_expires_soon = false;
                    status.apple_days_remaining = Some(0);
                }
                if let Some(until) = ledger.circuit_open_until_iso
                    .as_deref()
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .filter(|until| *until > Utc::now())
                {
                    status.circuit_open = true;
                    if !status.apple_expired {
                        status.worker_error = Some(format!(
                            "Polling is paused until {}. You can retry now.",
                            until.with_timezone(&chrono::Local).format("%b %d at %I:%M %p")
                        ));
                    }
                } else if error != Some("apple_token_expired") {
                    status.worker_error = error.map(str::to_owned);
                }
            }
            Err(e) => {
                status.worker_error = Some(e);
            }
        }
    }

    status
}

pub async fn run_and_emit_health(app: &AppHandle) -> HealthStatus {
    let status = check_health().await;
    let _ = app.emit("health-status", &status);
    status
}

pub async fn maybe_notify_os(app: &AppHandle, status: &HealthStatus) {
    if !storage::load_user_settings().unwrap_or_default().notifications {
        return;
    }
    if let Some(days) = status.apple_days_remaining {
        if days <= 3 && days > 0 {
            let _ = app
                .notification()
                .builder()
                .title("aScrobble — Apple Music Token Expiring Soon")
                .body(format!(
                    "Your Apple Music token expires in {} day(s). Open aScrobble to rotate it.",
                    days
                ))
                .show();
        } else if days <= 0 {
            let _ = app
                .notification()
                .builder()
                .title("aScrobble — Apple Music Token Expired")
                .body("Your Apple Music token has expired. Open aScrobble to re-authenticate.")
                .show();
        }
    } else if status.apple_expired {
        let _ = app
            .notification()
            .builder()
            .title("aScrobble — Apple Music Token Expired")
            .body("Your Apple Music token has expired. Open aScrobble to re-authenticate.")
            .show();
    }

    if let Some(ref err) = status.worker_error {
        let _ = app
            .notification()
            .builder()
            .title("aScrobble — Scrobbler Alert")
            .body(err.clone())
            .show();
    }
}
