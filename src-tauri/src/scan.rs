use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub struct ScannedFile {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub modified: SystemTime,
    /// "3mf", "stl" or "gcode"
    pub kind: &'static str,
}

/// Supported extensions, with their family.
pub fn kind_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "3mf" => Some("3mf"),
        "stl" => Some("stl"),
        "gcode" | "gco" | "g" | "nc" => Some("gcode"),
        _ => None,
    }
}

/// Lists the models (.3mf, .stl) and G-code files of a directory (optionally recursive), hidden files excluded.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_from_the_extension() {
        for (name, kind) in [
            ("a.3mf", Some("3mf")),
            ("a.3MF", Some("3mf")),
            ("a.stl", Some("stl")),
            ("a.STL", Some("stl")),
            ("a.Stl", Some("stl")),
            ("a.gcode", Some("gcode")),
            ("a.obj", None),
            ("stl", None),
        ] {
            assert_eq!(kind_of(Path::new(name)), kind, "{name}");
        }
    }

    #[test]
    fn a_folder_lists_models_and_gcode() {
        let dir = std::env::temp_dir().join(format!("snap-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a.3mf", "b.STL", "c.gcode", "d.txt", ".e.stl"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let mut found: Vec<(String, &str)> = scan_dir(&dir, false).into_iter().map(|f| (f.name, f.kind)).collect();
        found.sort();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            found,
            [("a.3mf".to_string(), "3mf"), ("b.STL".to_string(), "stl"), ("c.gcode".to_string(), "gcode")],
            "a hidden file and other formats stay out"
        );
    }
}
