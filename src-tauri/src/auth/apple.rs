//! Apple Music authentication.
//!
//! There is no public OAuth flow for Apple Music. The approach used by
//! Cider and similar projects — and the only one that works for a
//! non-ADP-member tool — is to embed a webview loading music.apple.com
//! and capture `MusicKit.getInstance().developerToken` and
//! `.musicUserToken` once the user has signed in.
//!
//! Mechanism:
//!   1. Spawn a webview window navigating to https://music.apple.com with
//!      a spoofed Safari user-agent (Apple's player works with any modern
//!      browser UA; we avoid "wry" or "Tauri" appearing in the UA).
//!   2. Inject an initialization_script that polls
//!      `window.MusicKit?.getInstance?.()` every 500ms.
//!   3. Once both tokens are present and `isAuthorized` is true, the
//!      script navigates the window to a reserved sentinel URL
//!      `https://ascrobble-capture.invalid/?dev=...&mut=...`.
//!   4. Our `on_navigation` callback intercepts that sentinel, extracts
//!      the tokens from the query string, cancels the navigation, and
//!      delivers them via a oneshot channel back to the waiting command.
//!

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use chrono::Utc;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;
use url::Url;

use crate::commands::AppleTokens;

const WINDOW_LABEL: &str = "apple-auth";
const AUTH_TIMEOUT_SECS: u64 = 600; // 10 min — generous for 2FA flows
const CAPTURE_HOST: &str = "ascrobble-capture.invalid";

/// Modern Safari user-agent. Critical that this does NOT contain "wry" or
/// "Tauri" — Apple's MusicKit JS does UA sniffing in places and anything
/// unusual gets 403'd.
const SPOOF_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15";

/// Polled in the webview context. Runs as the initialization_script, so it
/// executes before music.apple.com's own scripts on every real navigation.
/// Uses a window-level guard flag to avoid creating duplicate poll loops
/// when init_script fires twice (e.g., after the Apple ID redirect back).
const POLL_SCRIPT: &str = r#"
(function() {
  if (window.__ascrobblePolling) return;
  window.__ascrobblePolling = true;
  var attempts = 0;
  var lastDeveloperToken, lastMusicUserToken;
  function poll() {
    attempts++;
    if (attempts > 1200) return; // ~10 min cap
    try {
      var mk = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
      if (mk && mk.developerToken && mk.musicUserToken && mk.isAuthorized &&
          (mk.developerToken !== lastDeveloperToken || mk.musicUserToken !== lastMusicUserToken)) {
        lastDeveloperToken = mk.developerToken;
        lastMusicUserToken = mk.musicUserToken;
        var url = "https://ascrobble-capture.invalid/?" +
          "dev=" + encodeURIComponent(mk.developerToken) +
          "&mut=" + encodeURIComponent(mk.musicUserToken);
        window.location.href = url;
      }
    } catch (e) {}
    setTimeout(poll, 500);
  }
  setTimeout(poll, 1500); // give MusicKit a moment to initialize
})();
"#;

type AuthResult = Result<AppleTokens, String>;
type AuthAttempt = Arc<Mutex<Option<oneshot::Sender<AuthResult>>>>;

static SLOT: OnceLock<Mutex<Option<AuthAttempt>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<AuthAttempt>> {
    SLOT.get_or_init(|| Mutex::new(None))
}

fn finish(attempt: &AuthAttempt, result: AuthResult) {
    if let Some(sender) = attempt.lock().unwrap().take() {
        let _ = sender.send(result);
    }
}

/// Open the Apple Music window and wait for a fresh token pair, cancellation, or timeout.
pub async fn start_auth_flow(app: &AppHandle, previous: Option<AppleTokens>) -> Result<AppleTokens> {
    let start_url: Url = "https://music.apple.com/".parse()?;
    let (tx, rx) = oneshot::channel::<AuthResult>();
    let attempt = Arc::new(Mutex::new(Some(tx)));
    {
        let mut active = slot().lock().unwrap();
        if active.is_some() {
            drop(active);
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            return Err(anyhow!("Apple Music sign-in is already open."));
        }
        *active = Some(attempt.clone());
    }

    let capture = attempt.clone();
    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(start_url))
        .title("Sign in to Apple Music")
        .inner_size(1100.0, 780.0)
        .center()
        .focused(true)
        .user_agent(SPOOF_UA)
        .initialization_script(POLL_SCRIPT)
        .on_navigation(move |url: &Url| {
            if url.host_str() != Some(CAPTURE_HOST) {
                return true;
            }

            let token = |name: &str| {
                url.query_pairs()
                    .find_map(|(key, value)| (key == name).then(|| value.into_owned()))
            };
            if let (Some(developer_token), Some(music_user_token)) = (token("dev"), token("mut")) {
                let unchanged = previous.as_ref().is_some_and(|saved| {
                    saved.developer_token == developer_token && saved.music_user_token == music_user_token
                });
                let tokens = AppleTokens {
                    developer_token,
                    music_user_token,
                    captured_at: Utc::now().to_rfc3339(),
                    expires_at: None,
                }.with_decoded_expiry();
                let expired = tokens.expires_at.as_ref().is_some_and(|value| {
                    chrono::DateTime::parse_from_rfc3339(value)
                        .is_ok_and(|expiry| expiry <= Utc::now())
                });
                if !unchanged && !expired {
                    finish(&capture, Ok(tokens));
                }
            }
            false
        })
        .build();

    let window = match window {
        Ok(window) => window,
        Err(error) => {
            slot().lock().unwrap().take();
            return Err(error.into());
        }
    };
    let closing = attempt.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
            finish(&closing, Err("Apple Music sign-in was cancelled.".to_owned()));
        }
    });

    let received = tokio::time::timeout(Duration::from_secs(AUTH_TIMEOUT_SECS), rx).await;
    let _ = window.destroy();
    slot().lock().unwrap().take();
    match received {
        Ok(Ok(result)) => result.map_err(|error| anyhow!(error)),
        Ok(Err(_)) => Err(anyhow!("Apple Music sign-in was cancelled.")),
        Err(_) => Err(anyhow!("Apple Music sign-in timed out. Reopen it, sign out of Apple Music, and sign in again.")),
    }
}

pub fn cancel_auth_flow() {
    if let Some(attempt) = slot().lock().unwrap().as_ref() {
        finish(attempt, Err("Apple Music sign-in was cancelled.".to_owned()));
    }
}
