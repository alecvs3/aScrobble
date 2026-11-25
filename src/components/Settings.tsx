import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadUserSettings, redeployWorker, saveUserSettings, updatePollInterval } from "../lib/tauri";
import { recordWorkerSync } from "../lib/worker-version";

const enableAutostart = () => invoke("plugin:autostart|enable");
const disableAutostart = () => invoke("plugin:autostart|disable");
const isAutostartEnabled = () => invoke<boolean>("plugin:autostart|is_enabled");

interface SettingsProps {
  onBack: () => void;
}

function Toggle({ label, checked, disabled, onChange }: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={`toggle-switch ${checked ? "active" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Settings({ onBack }: SettingsProps) {
  const [theme, setTheme] = useState<"dark" | "oled" | "auto">("dark");
  const [accentColor, setAccentColor] = useState<"brand" | "spotify" | "blue">("brand");
  const [pollingInterval, setPollingInterval] = useState(1);
  const [notifications, setNotifications] = useState(true);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiTestLoading, setApiTestLoading] = useState(false);
  const [apiTestResult, setApiTestResult] = useState<string | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const syncWorkerCode = async () => {
    setSyncLoading(true);
    setError(null);
    try {
      await redeployWorker();
      recordWorkerSync();
      setToast("Worker code synced to Cloudflare.");
      setTimeout(() => setToast(null), 3000);
    } catch (error) {
      setError(`Worker sync failed: ${String(error)}`);
    } finally {
      setSyncLoading(false);
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem("ascrobble_settings") || localStorage.getItem("ascrobble-settings");
    if (saved) {
      try {
        const { theme: savedTheme, accentColor: savedAccent } = JSON.parse(saved);
        setTheme(savedTheme || "dark");
        setAccentColor(savedAccent || "brand");
      } catch {
        // Ignore obsolete or invalid appearance settings.
      }
    }
    setSaving(true);
    Promise.allSettled([loadUserSettings(), isAutostartEnabled()])
      .then(([settings, startup]) => {
        if (settings.status === "fulfilled") {
          setPollingInterval(settings.value.poll_interval_minutes);
          setMinimizeToTray(settings.value.minimize_to_tray ?? true);
          setNotifications(settings.value.notifications ?? true);
        } else {
          setError(`Could not load settings: ${String(settings.reason)}`);
        }
        if (startup.status === "fulfilled") setAutostart(startup.value);
      })
      .finally(() => setSaving(false));
  }, []);

  const saveAppearance = (nextTheme: typeof theme, nextAccent: typeof accentColor) => {
    setError(null);
    try {
      localStorage.setItem("ascrobble_settings", JSON.stringify({ theme: nextTheme, accentColor: nextAccent }));
      setTheme(nextTheme);
      setAccentColor(nextAccent);
      document.documentElement.setAttribute("data-theme", nextTheme);
      document.documentElement.setAttribute("data-accent", nextAccent);
    } catch (error) {
      setError(`Could not save appearance settings: ${String(error)}`);
    }
  };

  const saveSetting = async (change: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await change();
      setToast("Setting saved.");
      setTimeout(() => setToast(null), 2000);
    } catch (error) {
      setError(`Could not save the setting: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  // Download diagnostic logs
  const downloadLogs = async () => {
    setLogsLoading(true);
    setError(null);
    try {
      const fullLog = await invoke<string>("export_full_diagnostics");

      // Also trigger browser/file download for convenience
      const blob = new Blob([fullLog], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ascrobble-diagnostics-${new Date().toISOString().split("T")[0]}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setToast("Diagnostic logs exported & saved to data folder ✓");
      setTimeout(() => setToast(null), 3500);
    } catch (e) {
      console.error("Failed to download logs:", e);
      setError(`Export logs failed: ${String(e)}`);
    } finally {
      setLogsLoading(false);
    }
  };

  const openDataFolder = async () => {
    setError(null);
    try {
      await invoke("open_data_folder");
    } catch (e) {
      setError(`Could not open data folder: ${String(e)}`);
    }
  };

  const testAppleApi = async () => {
    setApiTestLoading(true);
    setApiTestResult(null);
    setError(null);
    try {
      setApiTestResult(await invoke<string>("test_apple_api"));
    } catch (error) {
      setError(String(error));
    } finally {
      setApiTestLoading(false);
    }
  };

  return (
    <div className="settings-container">
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {error && <div className="status status-error" role="alert">{error}</div>}
      
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Settings</h2>
            <p className="card-subtitle">Customize your aScrobble experience</p>
          </div>
          <button className="btn btn-secondary" onClick={onBack}>
            ← Back
          </button>
        </div>

        <div className="settings-section">
          <h3>Appearance</h3>
          
          <div className="settings-row">
            <div className="settings-info">
              <label>Theme</label>
              <p>Choose your preferred color scheme for the app interface</p>
            </div>
            <div className="settings-control">
              <select 
                value={theme} 
                onChange={(e) => {
                  const value = e.target.value as "dark" | "oled" | "auto";
                  saveAppearance(value, accentColor);
                }}
              >
                <option value="dark">🌙 Dark (Default)</option>
                <option value="oled">⚫ OLED Black</option>
                <option value="auto">💻 Auto (System)</option>
              </select>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-info">
              <label>Accent Color</label>
              <p>The accent color used for buttons and highlights throughout the app</p>
            </div>
            <div className="settings-control">
              <select 
                value={accentColor} 
                onChange={(e) => {
                  const value = e.target.value as "brand" | "spotify" | "blue";
                  saveAppearance(theme, value);
                }}
              >
                <option value="brand">🔴 Brand Red</option>
                <option value="spotify">🟢 Spotify Green</option>
                <option value="blue">🔵 Blue</option>
              </select>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3>Behavior</h3>
          
          <div className="settings-row">
            <div className="settings-info">
              <label>Minimize to Tray</label>
              <p>Keep the app running in the system tray when you close the window</p>
            </div>
            <div className="settings-control">
              <Toggle 
                label="Minimize to Tray"
                disabled={saving}
                checked={minimizeToTray} 
                onChange={(v) => void saveSetting(async () => {
                  await saveUserSettings({ ...await loadUserSettings(), minimize_to_tray: v });
                  setMinimizeToTray(v);
                })}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-info">
              <label>Start on System Startup</label>
              <p>Automatically launch aScrobble in the background (hidden to tray) when your PC boots up</p>
            </div>
            <div className="settings-control">
              <Toggle 
                label="Start on System Startup"
                disabled={saving}
                checked={autostart} 
                onChange={(v) => void saveSetting(async () => {
                  await (v ? enableAutostart() : disableAutostart());
                  setAutostart(v);
                  await saveUserSettings({ ...await loadUserSettings(), autostart: v });
                })}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-info">
              <label>Error Notifications</label>
              <p>Show desktop notifications when scrobbling errors occur</p>
            </div>
            <div className="settings-control">
              <Toggle 
                label="Notifications"
                disabled={saving}
                checked={notifications} 
                onChange={(v) => void saveSetting(async () => {
                  await saveUserSettings({ ...await loadUserSettings(), notifications: v });
                  setNotifications(v);
                })}
              />
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3>Advanced</h3>
          
          <div className="settings-row">
            <div className="settings-info">
              <label>Polling Interval</label>
              <p>How often the Cloudflare worker checks Apple Music for new plays. 1 minute is recommended.</p>
            </div>
            <div className="settings-control">
              <select 
                value={pollingInterval} 
                disabled={saving}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  void saveSetting(async () => {
                    await updatePollInterval(value);
                    setPollingInterval(value);
                  });
                }}
              >
                <option value={1}>1 minute (recommended)</option>
                <option value={2}>2 minutes</option>
                <option value={3}>3 minutes</option>
                <option value={5}>5 minutes</option>
                <option value={10}>10 minutes</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
              </select>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-info">
              <label>Debug & Diagnostics</label>
              <p>Download logs or open the data folder for troubleshooting</p>
            </div>
            <div className="settings-control">
              <div className="settings-actions-row">
                <button 
                  className="btn btn-secondary btn-sm" 
                  onClick={downloadLogs}
                  disabled={logsLoading}
                >
                  {logsLoading ? "⏳ Exporting..." : "📥 Download Logs"}
                </button>
                <button 
                  className="btn btn-secondary btn-sm" 
                  onClick={syncWorkerCode}
                  disabled={syncLoading}
                  title="Push latest worker bundle to Cloudflare"
                >
                  {syncLoading ? "⏳ Syncing..." : "⚡ Sync Worker Code"}
                </button>
                <button 
                  className="btn btn-ghost btn-sm" 
                  onClick={openDataFolder}
                >
                  📁 Open Data Folder
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={testAppleApi}
                  disabled={apiTestLoading}
                >
                  {apiTestLoading ? "⏳ Testing..." : "🧪 Test Apple API"}
                </button>
              </div>
              {apiTestResult && (
                <div style={{ 
                  marginTop: '12px', 
                  padding: '12px', 
                  background: 'rgba(255,255,255,0.05)', 
                  borderRadius: '8px',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '200px',
                  overflow: 'auto'
                }}>
                  {apiTestResult}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
