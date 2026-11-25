//! #[tauri::command] surface for the React frontend.
//!
//! Commands are deliberately small — each one delegates to an auth/* or
//! storage module. The bulky logic lives in those modules so this file
//! stays as a clean API reference for the frontend.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::auth;
use crate::storage;

// ---------- shared DTOs ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppleTokens {
    pub developer_token: String,
    pub music_user_token: String,
    pub captured_at: String, // ISO-8601
    pub expires_at: Option<String>, // ISO-8601 from JWT exp claim, if decodable
}

impl AppleTokens {
    /// Decode the JWT payload to extract the expiration time
    pub fn with_decoded_expiry(mut self) -> Self {
        self.expires_at = Self::decode_jwt_exp(&self.developer_token);
        self
    }
    
    pub fn decode_jwt_exp(token: &str) -> Option<String> {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        
        // JWT format: header.payload.signature
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        
        // Decode payload (base64url)
        let payload = parts[1];
        let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
        let json_str = String::from_utf8(decoded).ok()?;
        
        // Parse JSON to get exp claim
        let json: serde_json::Value = serde_json::from_str(&json_str).ok()?;
        let exp = json.get("exp")?.as_i64()?;
        
        // Convert Unix timestamp to ISO-8601
        let datetime = chrono::DateTime::from_timestamp(exp, 0)?;
        Some(datetime.to_rfc3339())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastfmSession {
    pub session_key: String,
    pub username: String,
    pub api_key: String,
    pub shared_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudflareAccount {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudflareOauth {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64, // unix seconds
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredentials {
    pub apple: Option<AppleTokens>,
    pub lastfm: Option<LastfmSession>,
    pub cloudflare_oauth: Option<CloudflareOauth>,
    pub cloudflare_token: Option<String>,
    pub cloudflare_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettings {
    pub poll_interval_minutes: u32, // 1, 2, 3, 5, 10, 15, or 30
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default = "default_true")]
    pub notifications: bool,
}

fn default_true() -> bool {
    true
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            poll_interval_minutes: 1,
            minimize_to_tray: true,
            autostart: false,
            notifications: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployStatus {
    pub deployed: bool,
    pub worker_name: Option<String>,
    pub last_run_iso: Option<String>,
    pub total_scrobbled: u64,
    pub total_runs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentScrobble {
    pub artist: String,
    pub track: String,
    pub album: Option<String>,
    pub timestamp_iso: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerStats {
    pub total_scrobbled: u64,
    pub total_runs: u64,
    pub total_errors: u64,
    pub last_error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp_iso: String,
    pub step: String,
    pub details: Option<String>,
    pub level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerLedger {
    pub version: u32,
    pub last_run_iso: Option<String>,
    pub circuit_open_until_iso: Option<String>,
    pub history_recovery_notice: Option<String>,
    pub recent_scrobbles: Vec<RecentScrobble>,
    pub stats: LedgerStats,
    pub log_entries: Option<Vec<LogEntry>>,
}


// Generic error string — we convert anyhow to String for serialization
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------- Apple Music ----------

#[tauri::command]
pub async fn apple_start_auth(app: AppHandle) -> Result<AppleTokens, String> {
    let tokens = auth::apple::start_auth_flow(&app, None).await.map_err(err)?;
    storage::save_apple_tokens(&tokens).map_err(err)?;
    Ok(tokens)
}

#[tauri::command]
pub async fn apple_get_tokens() -> Result<Option<AppleTokens>, String> {
    storage::load_apple_tokens().map_err(err)
}

#[tauri::command]
pub fn apple_cancel_auth() {
    auth::apple::cancel_auth_flow();
}

// ---------- Last.fm ----------

#[tauri::command]
pub async fn lastfm_start_auth(
    app: AppHandle,
    api_key: String,
    shared_secret: String,
) -> Result<LastfmSession, String> {
    auth::lastfm::start_auth_flow(&app, api_key, shared_secret)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn lastfm_cancel_auth() -> Result<(), String> {
    auth::lastfm::cancel_auth_flow().await.map_err(err)
}

// ---------- Cloudflare ----------

#[tauri::command]
pub async fn cloudflare_validate_token(token: String) -> Result<bool, String> {
    auth::cloudflare::validate_token(&token).await.map_err(err)
}

#[tauri::command]
pub async fn cloudflare_list_accounts(token: String) -> Result<Vec<CloudflareAccount>, String> {
    // Cloudflare accepts both OAuth access tokens and API tokens with the
    // same Authorization: Bearer <token> header shape.
    auth::cloudflare::list_accounts(&token).await.map_err(err)
}

#[tauri::command]
pub async fn cloudflare_oauth_login(app: AppHandle) -> Result<CloudflareOauth, String> {
    let oauth = auth::cloudflare_oauth::start_oauth_flow(&app)
        .await
        .map_err(err)?;

    storage::save_cloudflare_oauth(&oauth).map_err(err)?;
    Ok(oauth)
}

/// Decode JWT expiry from an existing Apple developer token
#[tauri::command]
pub fn apple_decode_token_expiry(developer_token: String) -> Result<Option<String>, String> {
    Ok(AppleTokens::decode_jwt_exp(&developer_token))
}

#[tauri::command]
pub async fn cloudflare_oauth_logout() -> Result<(), String> {
    if let Some(oauth) = storage::load_cloudflare_oauth().map_err(err)? {
        // Best-effort revocation: ignore any failures and still clear local state.
        let _ = auth::cloudflare_oauth::revoke_token(&oauth.access_token).await;
        let _ = auth::cloudflare_oauth::revoke_token(&oauth.refresh_token).await;
    }
    storage::clear_cloudflare_oauth().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn cloudflare_save_credentials(
    token: String,
    account_id: String,
) -> Result<(), String> {
    // Validate first so we don't store a broken token
    auth::cloudflare::validate_token(&token).await.map_err(err)?;
    auth::cloudflare::preflight_deploy_access(&token, &account_id)
        .await
        .map_err(err)?;
    storage::save_cloudflare_token(&token).map_err(err)?;
    storage::save_cloudflare_account_id(&account_id).map_err(err)?;

    Ok(())
}

#[tauri::command]
pub async fn cloudflare_save_account_id(account_id: String) -> Result<(), String> {
    storage::save_cloudflare_account_id(&account_id).map_err(err)
}

#[tauri::command]
pub fn cloudflare_template_url() -> String {
    auth::cloudflare::TOKEN_TEMPLATE_URL.to_string()
}

// ---------- Stored credentials ----------

#[tauri::command]
pub async fn storage_get_all() -> Result<StoredCredentials, String> {
    let apple = storage::load_apple_tokens().map_err(err)?;
    let lastfm = storage::load_lastfm_session().map_err(err)?;
    let cloudflare_oauth = storage::load_cloudflare_oauth().map_err(err)?;
    let cloudflare_token = storage::load_cloudflare_token().map_err(err)?;
    let cloudflare_account_id = storage::load_cloudflare_account_id().map_err(err)?;

    // Log what we loaded for debugging
    log::debug!(
        "Loaded credentials: apple={}, lastfm={}, oauth={}, token={}, account_id={}",
        apple.is_some(),
        lastfm.is_some(),
        cloudflare_oauth.is_some(),
        cloudflare_token.is_some(),
        cloudflare_account_id.is_some()
    );

    Ok(StoredCredentials {
        apple,
        lastfm,
        cloudflare_oauth,
        cloudflare_token,
        cloudflare_account_id,
    })
}

#[tauri::command]
pub async fn storage_clear_all() -> Result<(), String> {
    storage::clear_all().map_err(err)
}

// ---------- Deployment ----------

#[tauri::command]
pub async fn deploy_worker(
    app: AppHandle,
    account_id: String,
    poll_interval_minutes: u32,
    listenbrainz_token: Option<String>,
    webhook_url: Option<String>,
) -> Result<String, String> {
    crate::deploy::deploy_full(
        &app,
        &account_id,
        poll_interval_minutes,
        listenbrainz_token,
        webhook_url,
    )
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn save_user_settings(settings: UserSettings) -> Result<(), String> {
    storage::save_user_settings(&settings).map_err(err)
}

#[tauri::command]
pub async fn load_user_settings() -> Result<UserSettings, String> {
    storage::load_user_settings().map_err(err)
}

#[tauri::command]
pub async fn rotate_apple_tokens(
    app: AppHandle,
    account_id: Option<String>,
) -> Result<(), String> {
    let previous = storage::load_apple_tokens().map_err(err)?;
    let apple = auth::apple::start_auth_flow(&app, previous).await.map_err(err)?;
    let account_id = storage::load_cloudflare_account_id().map_err(err)?.or(account_id);
    crate::deploy::rotate_apple_tokens(account_id.as_deref(), &apple)
        .await
        .map_err(err)?;
    storage::save_apple_tokens(&apple).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn get_worker_url() -> Result<Option<String>, String> {
    storage::load_worker_url().map_err(err)
}

#[tauri::command]
pub async fn get_status_auth_key() -> Result<Option<String>, String> {
    storage::load_status_auth_key().map_err(err)
}

async fn worker_request(method: reqwest::Method, path: &str) -> Result<reqwest::Response, String> {
    let worker_url = storage::load_worker_url().map_err(err)?;
    let auth_key = storage::load_status_auth_key().map_err(err)?;
    let (Some(url), Some(key)) = (worker_url, auth_key) else {
        return Err("Worker connection details are missing. Reconnect the existing Worker in setup.".into());
    };

    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(err)?
        .request(method, format!("{url}{path}"))
        .header("x-ascrobble-auth", key)
        .send()
        .await
        .map_err(|error| format!("Could not reach the Worker: {}", error.without_url()))?;

    if !response.status().is_success() {
        return Err(format!("Worker {path} returned HTTP {}", response.status()));
    }
    Ok(response)
}

#[tauri::command]
pub async fn get_worker_status() -> Result<WorkerLedger, String> {
    worker_request(reqwest::Method::GET, "/status")
        .await?
        .json()
        .await
        .map_err(|error| format!("Could not read Worker status: {}", error.without_url()))
}

#[derive(Serialize, Deserialize)]
pub struct WorkerTrigger {
    ok: bool,
    triggered: bool,
    ledger: Option<WorkerLedger>,
    error: Option<String>,
}

#[tauri::command]
pub async fn trigger_worker() -> Result<WorkerTrigger, String> {
    worker_request(reqwest::Method::POST, "/trigger")
        .await?
        .json()
        .await
        .map_err(|error| format!("Could not read the poll result: {}", error.without_url()))
}


#[tauri::command]
pub async fn deploy_status(app: AppHandle, account_id: String) -> Result<DeployStatus, String> {
    crate::deploy::fetch_status(&app, &account_id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn test_apple_api() -> Result<String, String> {
    let tokens = storage::load_apple_tokens().map_err(err)?
        .ok_or("Connect Apple Music before testing the API.")?;
    let response = reqwest::Client::new()
        .get("https://api.music.apple.com/v1/me/recent/played/tracks?limit=1")
        .bearer_auth(tokens.developer_token)
        .header("Music-User-Token", tokens.music_user_token)
        .header("Origin", "https://music.apple.com")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| format!("Could not reach Apple Music: {}", error.without_url()))?;

    match response.status().as_u16() {
        200 => Ok("Apple Music accepted the saved tokens.".into()),
        401 => Err("Apple Music rejected the saved tokens. Rotate them from the dashboard.".into()),
        status => Err(format!("Apple Music returned HTTP {status}.")),
    }
}

#[tauri::command]
pub async fn open_data_folder(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    open::that(&path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_poll_interval(minutes: u32) -> Result<(), String> {
    if !crate::deploy::VALID_INTERVALS.contains(&minutes) {
        return Err("Unsupported polling interval.".into());
    }
    let mut settings = storage::load_user_settings().map_err(err)?;
    if settings.poll_interval_minutes == minutes {
        return Ok(());
    }
    let account_id = storage::load_cloudflare_account_id().map_err(err)?
        .ok_or("Reconnect Cloudflare in setup to change the polling interval.")?;
    let token = crate::deploy::resolve_cloudflare_api_token().await.map_err(err)?;
    let cron_expr = format!("*/{} * * * *", minutes);
    crate::deploy::set_cron_schedule(&reqwest::Client::new(), &token, &account_id, &cron_expr)
        .await
        .map_err(err)?;
    settings.poll_interval_minutes = minutes;
    storage::save_user_settings(&settings).map_err(err)
}

#[tauri::command]
pub async fn reset_worker_stats() -> Result<WorkerLedger, String> {
    worker_request(reqwest::Method::POST, "/reset-stats")
        .await?
        .json()
        .await
        .map_err(|error| format!("Could not read the reset result: {}", error.without_url()))
}

#[tauri::command]
pub async fn redeploy_worker(app: AppHandle) -> Result<(), String> {
    crate::deploy::redeploy_worker_script(&app)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn get_app_logs(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let log_path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ascrobble.log");
    if log_path.exists() {
        std::fs::read_to_string(&log_path).map_err(|e| e.to_string())
    } else {
        Ok("Log file initialized. No previous error logs.".to_string())
    }
}

#[tauri::command]
pub async fn export_full_diagnostics(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let mut out = String::new();
    let now = chrono::Utc::now().to_rfc3339();

    out.push_str("=====================================================\n");
    out.push_str("          aScrobble Diagnostic System Log           \n");
    out.push_str(&format!("  Export Timestamp: {}\n", now));
    out.push_str("=====================================================\n\n");

    // 1. System & App settings
    out.push_str("[1] Desktop App State & Settings:\n");
    if let Ok(settings) = storage::load_user_settings() {
        out.push_str(&format!("  - Poll Interval: {} min\n", settings.poll_interval_minutes));
    }
    if let Ok(url) = storage::load_worker_url() {
        out.push_str(&format!("  - Deployed Worker URL: {}\n", url.unwrap_or_else(|| "None".to_string())));
    }
    out.push_str("\n");

    // 2. Fetch live Cloudflare Worker status & step logs
    out.push_str("[2] Live Cloudflare Worker Ledger & Step Logs:\n");
    match get_worker_status().await {
        Ok(ledger) => {
            out.push_str(&format!("  - Ledger Version: {}\n", ledger.version));
            out.push_str(&format!("  - Last Worker Run ISO: {}\n", ledger.last_run_iso.unwrap_or_else(|| "Never".to_string())));
            out.push_str(&format!("  - Total Scrobbled: {}\n", ledger.stats.total_scrobbled));
            out.push_str(&format!("  - Total Runs: {}\n", ledger.stats.total_runs));
            out.push_str(&format!("  - Total Errors: {}\n", ledger.stats.total_errors));
            if let Some(err_msg) = &ledger.stats.last_error_message {
                out.push_str(&format!("  - Last Error Message: {}\n", err_msg));
            }
            if let Some(until) = &ledger.circuit_open_until_iso {
                out.push_str(&format!("  - Circuit Open Until: {}\n", until));
            }
            
            out.push_str("\n--- Cloudflare Worker Verbose Step Execution Log ---\n");
            if let Some(entries) = &ledger.log_entries {
                for (i, entry) in entries.iter().enumerate() {
                    let lvl = entry.level.as_deref().unwrap_or("info").to_uppercase();
                    let dt = &entry.timestamp_iso;
                    let details = entry.details.as_deref().unwrap_or("");
                    out.push_str(&format!(" {:02}. [{}] [{}] {} {}\n", i + 1, dt, lvl, entry.step, details));
                }
            } else {
                out.push_str("  No Cloudflare step entries recorded yet.\n");
            }
        }
        Err(e) => {
            out.push_str(&format!("  FAILED to query Cloudflare status: {}\n", e));
        }
    }

    // 3. Desktop log file contents
    out.push_str("\n[3] Desktop App Log File:\n");
    let log_path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ascrobble.log");
    if log_path.exists() {
        if let Ok(app_log) = std::fs::read_to_string(&log_path) {
            out.push_str(&app_log);
        }
    } else {
        out.push_str("  No desktop log file present.\n");
    }

    // Save to AppData file
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let file_path = path.join("ascrobble-diagnostics.log");
    std::fs::write(&file_path, &out).map_err(|e| e.to_string())?;

    Ok(out)
}

#[tauri::command]
pub async fn save_log_file(app: AppHandle, content: String) -> Result<String, String> {
    use tauri::Manager;
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let file_path = path.join("ascrobble-diagnostics.log");
    std::fs::write(&file_path, content).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

// ---------- Health Status ----------

#[tauri::command]
pub async fn get_health_status() -> Result<crate::health::HealthStatus, String> {
    Ok(crate::health::check_health().await)
}





