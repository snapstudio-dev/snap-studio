//! Carries over the data of the former "3MF Studio" (technical name `trimf`).
//!
//! Run once at startup, before any web view is created: the WebKit storage
//! (settings, tabs, site sessions) must be in place when the first page opens.
//!
//! Single rule: never overwrite. A destination already there means the
//! carry-over happened, or that Snap Studio already has its own data. Personal
//! data is copied, the old location stays intact; only the cache, bulky and
//! regenerable, is moved.

use std::path::{Path, PathBuf};

const OLD_ID: &str = "fr.carlini.trimf";
const NEW_ID: &str = "fr.carlini.snapstudio";
/// Binary name: in development, WebKit stores its data under this name.
#[cfg(target_os = "macos")]
const OLD_BIN: &str = "trimf";
#[cfg(target_os = "macos")]
const NEW_BIN: &str = "snap-studio";
/// Short folder, without spaces, under `~/.config` (mounted in the AI container).
const OLD_XDG: &str = "trimf";
const NEW_XDG: &str = "snap-studio";

pub fn run() {
    // Settings, favorites, printers; web view data outside macOS.
    for base in [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir()].into_iter().flatten() {
        copy_once(&base.join(OLD_ID), &base.join(NEW_ID));
    }
    // Thumbnail cache and favorite images.
    if let Some(base) = dirs::cache_dir() {
        move_once(&base.join(OLD_ID), &base.join(NEW_ID));
    }
    // AI conversations, then the history Claude Code stores by their path.
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".config")));
    if let Some(xdg) = xdg {
        let (old_root, new_root) = (xdg.join(OLD_XDG), xdg.join(NEW_XDG));
        copy_once(&old_root, &new_root);
        claude_projects(&old_root.join("ia"), &new_root.join("ia"));
    }
    // macOS WebKit storage: localStorage, site cookies.
    #[cfg(target_os = "macos")]
    if let Some(lib) = dirs::home_dir().map(|h| h.join("Library")) {
        for (old, new) in [(OLD_ID, NEW_ID), (OLD_BIN, NEW_BIN)] {
            copy_once(&lib.join("WebKit").join(old), &lib.join("WebKit").join(new));
            copy_once(&lib.join("HTTPStorages").join(old), &lib.join("HTTPStorages").join(new));
            copy_once(
                &lib.join("HTTPStorages").join(format!("{old}.binarycookies")),
                &lib.join("HTTPStorages").join(format!("{new}.binarycookies")),
            );
        }
    }
}

/// Claude Code names a session's folder after the working path, each
/// non-alphanumeric character becoming a dash (see `ia::session_file`).
fn slug(p: &Path) -> String {
    p.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Copies the conversation history under the name derived from the new path,
/// so that resuming them still works.
fn claude_projects(old_ia: &Path, new_ia: &Path) {
    let Some(projects) = dirs::home_dir().map(|h| h.join(".claude").join("projects")) else {
        return;
    };
    let (old_prefix, new_prefix) = (slug(old_ia), slug(new_ia));
    let Ok(entries) = std::fs::read_dir(&projects) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(rest) = name.strip_prefix(&old_prefix) {
            copy_once(&e.path(), &projects.join(format!("{new_prefix}{rest}")));
        }
    }
}

fn copy_once(from: &Path, to: &Path) {
    if to.symlink_metadata().is_ok() || from.symlink_metadata().is_err() {
        return;
    }
    if let Err(e) = copy_tree(from, to) {
        eprintln!("[migration] could not copy {}: {e}", from.display());
    }
}

fn move_once(from: &Path, to: &Path) {
    if to.symlink_metadata().is_ok() || from.symlink_metadata().is_err() {
        return;
    }
    // A rename fails across volumes: fall back on copying.
    if std::fs::rename(from, to).is_err() {
        copy_once(from, to);
    }
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = from.symlink_metadata()?;
    if meta.file_type().is_symlink() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(std::fs::read_link(from)?, to)?;
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(from, to).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copie_sans_ecraser() {
        let tmp = std::env::temp_dir().join("snapstudio-migrate-test");
        let _ = std::fs::remove_dir_all(&tmp);
        let (old, new) = (tmp.join("old"), tmp.join("new"));
        std::fs::create_dir_all(old.join("ia/abc")).unwrap();
        std::fs::write(old.join("ia/abc/meta.json"), "{}").unwrap();
        copy_once(&old, &new);
        assert_eq!(std::fs::read_to_string(new.join("ia/abc/meta.json")).unwrap(), "{}");
        assert!(old.join("ia/abc/meta.json").exists(), "the old one stays in place");

        // An existing destination is never touched.
        std::fs::write(old.join("ia/abc/meta.json"), "modified").unwrap();
        copy_once(&old, &new);
        assert_eq!(std::fs::read_to_string(new.join("ia/abc/meta.json")).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn nom_des_sessions_claude() {
        let old = Path::new("/Users/moi/.config/trimf/ia");
        let new = Path::new("/Users/moi/.config/snap-studio/ia");
        let dir = format!("{}-abc-workspace", slug(old));
        assert_eq!(dir, "-Users-moi--config-trimf-ia-abc-workspace");
        let rest = dir.strip_prefix(&slug(old)).unwrap();
        assert_eq!(format!("{}{rest}", slug(new)), "-Users-moi--config-snap-studio-ia-abc-workspace");
    }
}
