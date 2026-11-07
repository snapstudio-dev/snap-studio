use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub struct ScannedFile {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub modified: SystemTime,
    /// "3mf" or "gcode"
    pub kind: &'static str,
}

/// Supported extensions, with their family.
pub fn kind_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "3mf" => Some("3mf"),
        "gcode" | "gco" | "g" | "nc" => Some("gcode"),
        _ => None,
    }
}

/// Lists the .3mf of a directory (optionally recursive), hidden files excluded.
pub fn scan_dir(root: &Path, recursive: bool) -> Vec<ScannedFile> {
    let depth = if recursive { usize::MAX } else { 1 };
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_str().map(|s| s.starts_with('.') && s != ".").unwrap_or(false))
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(kind) = kind_of(path) else {
            continue;
        };
        let md = match entry.metadata() {
            Ok(md) => md,
            Err(_) => continue,
        };
        out.push(ScannedFile {
            name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            size: md.len(),
            modified: md.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            path: path.to_path_buf(),
            kind,
        });
    }
    out
}
