//! Slicers installed on the machine. Snap Studio slices with its own engine;
//! an installed Snapmaker Orca still lends its custom profiles, and serves
//! as the engine in development builds.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// A known slicer and its usual locations, per system. Each system only
/// reads its column.
#[allow(dead_code)]
struct Known {
    name: &'static str,
    /// macOS: application bundles, in `/Applications` or `~/Applications`.
    mac: &'static [&'static str],
    /// Windows: executables, relative to `Program Files` or `%LOCALAPPDATA%\Programs`.
    win: &'static [&'static str],
    /// Linux: `PATH` commands, and the start of the AppImage's name.
    linux: &'static [&'static str],
}

/// Known slicers, in order of preference.
const KNOWN: &[Known] = &[
    Known {
        name: "Snapmaker Orca",
        mac: &["Snapmaker Orca.app"],
        win: &[r"Snapmaker_Orca\snapmaker-orca.exe", r"Snapmaker Orca\snapmaker-orca.exe"],
        linux: &["snapmaker-orca", "Snapmaker_Orca"],
    },
    Known { name: "OrcaSlicer", mac: &["OrcaSlicer.app"], win: &[r"OrcaSlicer\orca-slicer.exe"], linux: &["orca-slicer", "OrcaSlicer"] },
    Known {
        name: "Bambu Studio",
        mac: &["BambuStudio.app", "Bambu Studio.app"],
        win: &[r"Bambu Studio\bambu-studio.exe"],
        linux: &["bambu-studio", "BambuStudio", "Bambu_Studio"],
    },
    Known {
        name: "PrusaSlicer",
        mac: &["PrusaSlicer.app"],
        win: &[r"Prusa3D\PrusaSlicer\prusa-slicer.exe"],
        linux: &["prusa-slicer", "PrusaSlicer"],
    },
    Known {
        name: "SuperSlicer",
        mac: &["SuperSlicer.app"],
        win: &[r"SuperSlicer\superslicer.exe"],
        linux: &["superslicer", "SuperSlicer"],
    },
    Known {
        name: "UltiMaker Cura",
        mac: &["UltiMaker Cura.app", "Ultimaker Cura.app", "Cura.app"],
        win: &[],
        linux: &["cura", "UltiMaker-Cura"],
    },
    Known { name: "Creality Print", mac: &["Creality Print.app"], win: &[], linux: &["CrealityPrint"] },
    Known { name: "Snapmaker Luban", mac: &["Snapmaker Luban.app"], win: &[], linux: &[] },
];

#[derive(Serialize, Clone)]
pub struct Slicer {
    pub name: String,
    /// macOS: the `.app` bundle; elsewhere: the executable or the AppImage.
    pub path: String,
}

/// Candidate locations of a slicer on this system.
#[cfg(target_os = "macos")]
fn candidates(k: &Known) -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    k.mac.iter().flat_map(|b| roots.iter().map(move |r| r.join(b))).filter(|p| p.is_dir()).collect()
}

#[cfg(windows)]
fn candidates(k: &Known) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> =
        ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"].iter().filter_map(|v| std::env::var_os(v).map(PathBuf::from)).collect();
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.join("Programs"));
    }
    k.win.iter().flat_map(|e| roots.iter().map(move |r| r.join(e))).filter(|p| p.is_file()).collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn candidates(k: &Known) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = k.linux.iter().filter_map(|c| crate::util::which(c)).collect();
    // AppImage dropped in a usual folder: "Snapmaker_Orca_Linux_V2.4.0.AppImage".
    let mut dirs_ = vec![PathBuf::from("/opt")];
    if let Some(h) = dirs::home_dir() {
        for d in ["Applications", "Downloads", "Téléchargements", ".local/bin", "bin"] {
            dirs_.push(h.join(d));
        }
    }
    for d in dirs_ {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_lowercase();
            let hit = n.ends_with(".appimage") && k.linux.iter().any(|p| n.starts_with(&p.to_lowercase()));
            if hit && e.path().is_file() {
                out.push(e.path());
            }
        }
    }
    out
}

/// Slicers present on the machine.
pub fn list() -> Vec<Slicer> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for k in KNOWN {
        for p in candidates(k) {
            // Case-insensitive file systems (macOS, Windows): two spellings of the
            // same name designate the same application.
            let key = std::fs::canonicalize(&p)
                .map(|c| c.to_string_lossy().to_lowercase())
                .unwrap_or_else(|_| p.to_string_lossy().to_lowercase());
            if seen.insert(key) {
                out.push(Slicer { name: k.name.to_string(), path: p.to_string_lossy().to_string() });
            }
        }
    }
    out
}

/// Executable to run on the command line for a slicer of [`list`].
pub fn executable(app: &Path) -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let macos = app.join("Contents/MacOS");
        // The bundle names its main executable (`CFBundleExecutable`); the
        // other binaries in the folder are utilities, and `read_dir` has
        // no order to rely on.
        let plist = std::fs::read_to_string(app.join("Contents/Info.plist")).unwrap_or_default();
        if let Some(name) = plist_string(&plist, "CFBundleExecutable") {
            let p = macos.join(name);
            if p.is_file() {
                return Ok(p);
            }
        }
        // No plist to read: the binary named like the app, else any that is
        // not the crash handler.
        let stem = app.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let mut any = None;
        for e in std::fs::read_dir(&macos)?.flatten() {
            let p = e.path();
            let Some(n) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
            if !p.is_file() || n == "crashpad_handler" {
                continue;
            }
            if n == stem {
                return Ok(p);
            }
            any.get_or_insert(p);
        }
        any.ok_or_else(|| anyhow!(crate::t!("err.no_executable_in", path = macos.display())))
    }
    #[cfg(not(target_os = "macos"))]
    {
        if app.is_file() {
            Ok(app.to_path_buf())
        } else {
            Err(anyhow!(crate::t!("err.no_executable", path = app.display())))
        }
    }
}

/// A slicer's `resources` folder (profiles, images…).
pub fn resources(app: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let found = Some(app.join("Contents/Resources"));
    #[cfg(windows)]
    let found = app.parent().map(|d| d.join("resources"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let found = linux_resources(app);
    found.filter(|r| r.is_dir())
}

/// Linux: next to the executable, in a `share/` installation, or inside the
/// AppImage, extracted once into the cache.
#[cfg(all(unix, not(target_os = "macos")))]
fn linux_resources(app: &Path) -> Option<PathBuf> {
    let is_appimage = app.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("appimage"));
    if is_appimage {
        return appimage_resources(app);
    }
    let real = std::fs::canonicalize(app).ok()?;
    let dir = real.parent()?;
    let mut cands = vec![dir.join("resources"), dir.join("../resources")];
    if let Ok(rd) = std::fs::read_dir(dir.join("../share")) {
        cands.extend(rd.flatten().map(|e| e.path()));
    }
    cands.into_iter().find(|c| c.join("profiles").is_dir())
}

/// Extracts the AppImage's profiles into the cache, once per file version
/// (size and date), and returns the `resources` folder obtained.
#[cfg(all(unix, not(target_os = "macos")))]
fn appimage_resources(app: &Path) -> Option<PathBuf> {
    let meta = std::fs::metadata(app).ok()?;
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let key = crate::util::fnv1a(&[format!("{}|{}|{}", app.display(), meta.len(), stamp).as_bytes()]);
    let root = dirs::cache_dir()?.join("fr.carlini.snapstudio").join("engine").join(format!("{key:016x}"));
    let res = root.join("squashfs-root/resources");
    if res.join("profiles").is_dir() {
        return Some(res);
    }
    let _ = std::fs::create_dir_all(&root);
    // The profiles only, otherwise the whole content.
    for pattern in [Some("resources/profiles/*"), None] {
        let mut cmd = std::process::Command::new(app);
        cmd.arg("--appimage-extract").current_dir(&root);
        if let Some(p) = pattern {
            cmd.arg(p);
        }
        let ok = cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success());
        if ok && res.join("profiles").is_dir() {
            return Some(res);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_installed_slicers() {
        let l = list();
        for s in &l {
            println!("{} — {}", s.name, s.path);
            assert!(Path::new(&s.path).exists());
        }
        // Nothing installed on a build machine: only check consistency, not
        // presence.
        assert!(l.iter().all(|s| KNOWN.iter().any(|k| k.name == s.name)));
    }
}

/// The string under `key` in an Info.plist (`<key>K</key><string>V</string>`),
/// read without an XML parser: the file is small and regular.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn plist_string(plist: &str, key: &str) -> Option<String> {
    let needle = format!("<key>{key}</key>");
    let after = &plist[plist.find(&needle)? + needle.len()..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")? + start;
    let v = after[start..end].trim();
    (!v.is_empty() && !v.contains(['/', '\\'])).then(|| v.to_string())
}

#[cfg(test)]
mod plist_tests {
    use super::plist_string;

    #[test]
    fn the_bundle_names_its_executable() {
        let p = "<plist><dict>\n<key>CFBundleName</key>\n<string>Snapmaker Orca</string>\n<key>CFBundleExecutable</key>\n<string>Snapmaker_Orca</string>\n</dict></plist>";
        assert_eq!(plist_string(p, "CFBundleExecutable").as_deref(), Some("Snapmaker_Orca"));
        assert_eq!(plist_string(p, "CFBundleName").as_deref(), Some("Snapmaker Orca"));
        assert_eq!(plist_string(p, "Missing"), None);
        assert_eq!(plist_string("<key>CFBundleExecutable</key><string>../x</string>", "CFBundleExecutable"), None);
    }
}
