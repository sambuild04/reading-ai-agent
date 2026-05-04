mod browser;
mod commands;
mod cua;
mod cua_browser;
mod flashcards;
mod memory;
mod oauth;
mod plugins;
mod secrets;
mod wake_word;

use browser::*;
use commands::*;
use cua::*;
use flashcards::*;
use memory::*;
use oauth::*;
use plugins::*;
use secrets::*;
use wake_word::*;
use tauri::Manager;

#[cfg(target_os = "macos")]
fn request_accessibility_permission() {
    use std::process::Command;
    // Use osascript to check + prompt. If not trusted, the Swift helper's
    // AXIsProcessTrustedWithOptions call will trigger the system dialog.
    // We also run a quick AX probe that triggers the macOS permission prompt.
    let result = Command::new("/usr/bin/osascript")
        .args(["-e", r#"tell application "System Events" to name of first application process whose frontmost is true"#])
        .output();
    match result {
        Ok(output) if output.status.success() => {
            eprintln!("[accessibility] permission granted ✓");
        }
        _ => {
            eprintln!("[accessibility] permission may not be granted — check System Settings → Privacy → Accessibility");
            // Open System Settings directly to the Accessibility pane
            let _ = Command::new("/usr/bin/open")
                .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"])
                .spawn();
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn check_accessibility_permission() -> bool {
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", r#"tell application "System Events" to name of first application process whose frontmost is true"#])
        .output();
    matches!(output, Ok(o) if o.status.success())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{NSColor, NSWindow};
                use cocoa::base::nil;

                let win = app
                    .get_webview_window("main")
                    .expect("main window not found");
                let ns_win = win.ns_window().unwrap() as cocoa::base::id;
                unsafe {
                    let clear = NSColor::clearColor(nil);
                    ns_win.setBackgroundColor_(clear);
                    ns_win.setOpaque_(cocoa::base::NO);
                    ns_win.setHasShadow_(cocoa::base::NO);
                }

                // Request Accessibility permission (shows system dialog if not granted).
                // Required for read_app (AX tree) to read content from other apps.
                request_accessibility_permission();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_ephemeral_key,
            capture_active_window,
            capture_if_changed,
            capture_screen_now,
            open_app,
            read_app_content,
            list_app_windows,
            check_accessibility_permission,
            set_system_volume,
            get_config,
            transcribe_audio,
            list_displays,
            set_default_display,
            start_recording,
            stop_recording,
            analyze_recording,
            transcribe_recording,
            check_screen_for_language,
            check_screen_text,
            check_audio_for_language,
            get_attention_state,
            triage_observation,
            start_learning_audio,
            stop_learning_audio,
            flush_learning_audio,
            check_learning_audio,
            record_samuel_speech,
            get_selected_text,
            memory_clear,
            memory_get_context,
            memory_set_fact,
            memory_mark_known,
            memory_add_correction,
            extract_session_feedback,
            watch_add,
            watch_remove,
            watch_list,
            watch_clear,
            watch_check,
            watch_get_classifier,
            watch_mark_fired,
            watch_evaluate_classifier,
            get_flashcard_deck,
            save_flashcard,
            delete_flashcard,
            read_flashcard_file,
            increment_flashcard_review,
            append_transcript_window,
            assess_viewing_session,
            get_plugin_dir,
            list_plugins,
            read_plugin,
            write_plugin,
            delete_plugin,
            generate_plugin_code,
            judge_plugin_code,
            diagnose_plugin_failure,
            get_secret,
            set_secret,
            delete_secret,
            list_secrets,
            fetch_genius_lyrics,
            web_search,
            web_search_openai,
            web_read,
            agent_write_file,
            agent_read_file,
            agent_list_directory,
            skill_list_summaries,
            skill_delete,
            oauth_flow,
            oauth_refresh,
            browser_command,
            browser_close,
            cua_run,
            cua_run_native,
            native_computer_action,
            native_screenshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
