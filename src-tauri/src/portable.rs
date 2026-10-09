//! Portable mode support for Handy.
//!
//! When a file named `portable` exists next to the executable, all user data
//! (settings, models, recordings, database, logs) is stored in a `Data/`
//! directory alongside the executable instead of `%APPDATA%`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::Manager;

static PORTABLE_DATA_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Detect portable mode by looking for a `portable` marker file next to the exe.
/// Must be called once at startup before Tauri initializes.
pub fn init() {
    PORTABLE_DATA_DIR.get_or_init(|| {
        let exe_path = std::env::current_exe().ok()?;
        let exe_dir = exe_path.parent()?;

        let marker_path = exe_dir.join("portable");
        let data_dir = exe_dir.join("Data");

        let is_portable = if is_valid_portable_marker(&marker_path) {
            true
        } else if marker_path.exists() && data_dir.exists() {
            // Migration: v0.8.0 created an empty marker file. If we find an
            // empty/invalid marker alongside an existing Data/ dir, this is a
            // real portable install — upgrade the marker in place.
            eprintln!("[portable] upgrading legacy empty marker to magic string");
            let _ = std::fs::write(&marker_path, "Handy Portable Mode");
            true
        } else {
            false
        };

        if is_portable {
            if !data_dir.exists() {
                std::fs::create_dir_all(&data_dir).ok()?;
            }
            let hf_home = hugging_face_home(&data_dir);
            std::env::set_var("HF_HOME", &hf_home);
            eprintln!("[portable] data dir: {}", data_dir.display());
            eprintln!("[portable] Hugging Face home: {}", hf_home.display());
            Some(data_dir)
        } else {
            None
        }
    });
}

/// Keep hf-hub downloads inside the portable data directory. hf-hub appends
/// its own `hub` component to `HF_HOME` for model snapshots and blobs.
fn hugging_face_home(data_dir: &Path) -> PathBuf {
    data_dir.join("huggingface")
}

/// Returns `true` if running in portable mode.
pub fn is_portable() -> bool {
    PORTABLE_DATA_DIR.get().and_then(|v| v.as_ref()).is_some()
}

/// Get the portable data dir (if active). Does not require an AppHandle.
/// Returns `None` when not in portable mode.
pub fn data_dir() -> Option<&'static PathBuf> {
    PORTABLE_DATA_DIR.get().and_then(|v| v.as_ref())
}

/// Portable-aware replacement for `app.path().app_data_dir()`.
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    if let Some(dir) = data_dir() {
        Ok(dir.clone())
    } else {
        app.path().app_data_dir()
    }
}

/// Portable-aware replacement for `app.path().app_log_dir()`.
pub fn app_log_dir(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    if let Some(dir) = data_dir() {
        Ok(dir.join("logs"))
    } else {
        app.path().app_log_dir()
    }
}

/// Move files into the new brand directory without replacing newer data.
fn merge_brand_directory(old_dir: &Path, new_dir: &Path) -> std::io::Result<()> {
    if !old_dir.exists() {
        return Ok(());
    }
    if !new_dir.exists() {
        return std::fs::rename(old_dir, new_dir);
    }
    for entry in std::fs::read_dir(old_dir)? {
        let entry = entry?;
        let old_path = entry.path();
        let new_path = new_dir.join(entry.file_name());
        if old_path.is_dir() && new_path.is_dir() {
            merge_brand_directory(&old_path, &new_path)?;
        } else if !new_path.exists() {
            std::fs::rename(&old_path, &new_path)?;
        }
    }
    Ok(())
}

/// Preserve the previous branded install's settings, models, meetings and logs.
pub fn migrate_meeting_brand_data(app: &tauri::AppHandle) {
    if is_portable() || app.config().identifier != "com.shiliu.meetingassistant" {
        return;
    }
    let migrations = [
        app.path().app_data_dir().ok().and_then(|new_dir| {
            let old_dir = new_dir.parent()?.join("com.pais.shiliu.meetingassistant");
            Some((old_dir, new_dir))
        }),
        app.path().app_log_dir().ok().and_then(|new_dir| {
            let old_dir = new_dir
                .parent()?
                .parent()?
                .join("com.pais.shiliu.meetingassistant")
                .join("logs");
            Some((old_dir, new_dir))
        }),
    ];
    for (old_dir, new_dir) in migrations.into_iter().flatten() {
        if let Err(error) = merge_brand_directory(&old_dir, &new_dir) {
            log::warn!(
                "could not migrate branded data from {}: {}",
                old_dir.display(),
                error
            );
        }
    }
}

/// Resolve a relative path against the app data directory (portable-aware).
/// Replaces `app.path().resolve(path, BaseDirectory::AppData)`.
pub fn resolve_app_data(app: &tauri::AppHandle, relative: &str) -> Result<PathBuf, tauri::Error> {
    Ok(app_data_dir(app)?.join(relative))
}

/// Get the path to use with `tauri-plugin-store`.
/// Returns an absolute path in portable mode (so the store plugin writes to
/// the portable Data dir) or the original relative path otherwise.
pub fn store_path(relative: &str) -> PathBuf {
    if let Some(dir) = data_dir() {
        dir.join(relative)
    } else {
        PathBuf::from(relative)
    }
}

/// Check if a marker file path contains the portable magic string.
/// Extracted for testability.
fn is_valid_portable_marker(path: &std::path::Path) -> bool {
    std::fs::read_to_string(path)
        .map(|s| s.trim().starts_with("Handy Portable Mode"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Verify saved data moves to the new brand identifier without replacing newer files.
    #[test]
    fn test_brand_directory_merge_preserves_newer_data() {
        let root = std::env::temp_dir().join(format!(
            "shiliu_brand_merge_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let old_dir = root.join("old");
        let new_dir = root.join("new");
        std::fs::create_dir_all(old_dir.join("models")).unwrap();
        std::fs::create_dir_all(new_dir.join("models")).unwrap();
        std::fs::write(old_dir.join("models").join("voice.bin"), b"model").unwrap();
        std::fs::write(old_dir.join("settings_store.json"), b"old").unwrap();
        std::fs::write(new_dir.join("settings_store.json"), b"new").unwrap();

        merge_brand_directory(&old_dir, &new_dir).unwrap();

        assert_eq!(
            std::fs::read(new_dir.join("models").join("voice.bin")).unwrap(),
            b"model"
        );
        assert_eq!(
            std::fs::read(new_dir.join("settings_store.json")).unwrap(),
            b"new"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn test_valid_magic_string_enables_portable() {
        let dir = std::env::temp_dir().join("handy_test_valid");
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("portable");
        let mut f = std::fs::File::create(&marker).unwrap();
        write!(f, "Handy Portable Mode").unwrap();
        assert!(is_valid_portable_marker(&marker));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_empty_file_does_not_enable_portable() {
        let dir = std::env::temp_dir().join("handy_test_empty");
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("portable");
        std::fs::File::create(&marker).unwrap();
        assert!(!is_valid_portable_marker(&marker));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_wrong_content_does_not_enable_portable() {
        let dir = std::env::temp_dir().join("handy_test_wrong");
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("portable");
        let mut f = std::fs::File::create(&marker).unwrap();
        write!(f, "some other content").unwrap();
        assert!(!is_valid_portable_marker(&marker));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_missing_file_does_not_enable_portable() {
        let path = std::path::Path::new("/nonexistent/portable");
        assert!(!is_valid_portable_marker(path));
    }

    #[test]
    fn test_legacy_empty_marker_without_data_dir_does_not_enable_portable() {
        // Empty marker alone (scoop scenario) — no Data/ dir → not portable
        let dir = std::env::temp_dir().join("handy_test_legacy_no_data");
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("portable");
        std::fs::File::create(&marker).unwrap();
        assert!(!is_valid_portable_marker(&marker));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_magic_string_with_whitespace_enables_portable() {
        let dir = std::env::temp_dir().join("handy_test_ws");
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("portable");
        let mut f = std::fs::File::create(&marker).unwrap();
        write!(f, "  Handy Portable Mode\n").unwrap();
        assert!(is_valid_portable_marker(&marker));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_hugging_face_home_is_inside_portable_data() {
        let data_dir = Path::new("portable-root").join("Data");

        assert_eq!(hugging_face_home(&data_dir), data_dir.join("huggingface"));
    }
}
