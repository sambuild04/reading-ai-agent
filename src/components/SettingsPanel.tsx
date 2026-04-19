import type { UIPreferences } from "../hooks/useUIPreferences";

interface Props {
  visible: boolean;
  prefs: UIPreferences;
  onToggle: (key: "screen_watch_enabled" | "audio_listen_enabled") => void;
  onClose: () => void;
}

export function SettingsPanel({ visible, prefs, onToggle, onClose }: Props) {
  if (!visible) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Settings</h3>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Privacy Controls</div>

          <label className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Screen Watching</span>
              <span className="settings-toggle-desc">
                Allow Samuel to observe your screen for language hints
              </span>
            </div>
            <div
              className={`settings-switch ${prefs.screen_watch_enabled ? "settings-switch-on" : ""}`}
              onClick={() => onToggle("screen_watch_enabled")}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>

          <label className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Audio Listening</span>
              <span className="settings-toggle-desc">
                Allow Samuel to hear ambient audio for language learning
              </span>
            </div>
            <div
              className={`settings-switch ${prefs.audio_listen_enabled ? "settings-switch-on" : ""}`}
              onClick={() => onToggle("audio_listen_enabled")}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">About</div>
          <a
            className="settings-link"
            href="https://github.com/nicepkg/samuel#privacy"
            target="_blank"
            rel="noopener noreferrer"
          >
            Privacy Policy
          </a>
          <p className="settings-note">
            All processing happens locally or via your own API keys.
            No data is sent to third parties. Screen captures and audio
            recordings are ephemeral and never stored permanently.
          </p>
        </div>
      </div>
    </div>
  );
}
