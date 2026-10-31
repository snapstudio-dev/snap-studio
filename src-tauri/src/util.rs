/// Cleans an HTML description coming from slicers (MakerWorld double-encodes).
pub fn strip_html(input: &str) -> String {
    let mut s = input.to_string();
    for _ in 0..2 {
        s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'");
    }
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let mut cleaned = String::new();
    for line in out.lines() {
        let l = line.trim();
        if !l.is_empty() {
            cleaned.push_str(l);
            cleaned.push('\n');
        }
    }
    cleaned.trim().to_string()
}

/// 64-bit FNV-1a hash, for cache keys.
pub fn fnv1a(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in *p {
            h ^= *b as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// Folders searched for a program: the inherited `PATH`, the usual places
/// a user installs to (`~/.local/bin`, Homebrew, `/usr/local/bin`) before
/// the system's own folders.
///
/// An app launched from the Finder does not inherit the terminal's `PATH`,
/// only `/usr/bin:/bin:/usr/sbin:/sbin`: put first, the system's folders
/// would win, and macOS's `/usr/bin/python3` (the developer tools' 3.9)
/// would be found instead of the user's Homebrew Python. Launched from a
/// terminal, the user's own order is kept (its folders come first).
pub fn search_path() -> Vec<std::path::PathBuf> {
    let inherited: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    ordered_path(inherited, home.as_deref())
}

/// The system's own folders: after the user's.
const SYSTEM_DIRS: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

fn ordered_path(inherited: Vec<std::path::PathBuf>, home: Option<&std::path::Path>) -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let system = |p: &PathBuf| SYSTEM_DIRS.iter().any(|s| p == std::path::Path::new(s));
    let mut out: Vec<PathBuf> = inherited.iter().filter(|p| !system(p)).cloned().collect();
    if cfg!(unix) {
        if let Some(h) = home {
            out.push(h.join(".local/bin"));
        }
        out.extend(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"].map(PathBuf::from));
    }
    out.extend(inherited.iter().filter(|p| system(p)).cloned());
    if cfg!(unix) {
        out.extend(["/usr/bin", "/bin"].map(PathBuf::from));
        if let Some(h) = home {
            out.push(h.join("bin"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| !p.as_os_str().is_empty() && seen.insert(p.clone()));
    out
}

/// Looks for an executable, like `which`, without depending on the shell,
/// in [`search_path`]'s folders: launched from the Finder, `claude`,
/// `docker` or Homebrew's `python3` are found all the same.
pub fn which(name: &str) -> Option<std::path::PathBuf> {
    let dirs = search_path();
    // Windows: the command is written without its extension.
    let names: Vec<String> =
        if cfg!(windows) { vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()] } else { vec![name.to_string()] };
    dirs.into_iter().find_map(|d| names.iter().map(|n| d.join(n)).find(|c| c.is_file()))
}

/// Windows: runs the command without opening a console window.
pub fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Base64 encoding, without a dependency: the counterpart of `gcode.rs`'s
/// decoder.
///
/// Carries a terminal's raw bytes up to the UI, where only the emulator can
/// glue back a character split in two.
/// Base64 decoding, tolerant: invalid characters are skipped.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    const INVALID: u8 = 255;
    let val = |c: u8| -> u8 {
        match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => INVALID,
        }
    };
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = val(c);
        if v == INVALID {
            continue;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    (!out.is_empty()).then_some(out)
}

pub fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// JSON bytes without a leading UTF-8 byte order mark: serde_json refuses
/// one, Snapmaker Orca accepts it, and some of its profiles start with one
/// since 2.4.1 (`0.20mm Standard @Snapmaker U1 (0.4 nozzle).json`).
pub fn strip_bom(data: &[u8]) -> &[u8] {
    data.strip_prefix(b"\xEF\xBB\xBF".as_slice()).unwrap_or(data)
}

/// An error as the UI shows it: the message and its causes
/// (`copying a to b: Permission denied`), where `to_string()` would keep
/// only the first.
pub fn ui_err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

/// Writes a file whole or not at all (a temporary file, then a rename): a
/// crash mid-write never leaves a truncated store. Errors name the file.
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> anyhow::Result<()> {
    use anyhow::Context;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_the_reference() {
        for (raw, enc) in [("", ""), ("a", "YQ=="), ("ab", "YWI="), ("abc", "YWJj"), ("bonjour, été", "Ym9uam91ciwgw6l0w6k=")] {
            assert_eq!(super::b64_encode(raw.as_bytes()), enc, "for {raw:?}");
        }
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;
    use std::path::PathBuf;

    fn order(path: &str) -> Vec<String> {
        let inherited = std::env::split_paths(path).collect();
        ordered_path(inherited, Some(std::path::Path::new("/Users/me"))).iter().map(|p| p.display().to_string()).collect()
    }

    /// Launched from the Finder (the system's PATH only), the user's
    /// folders come before the system's: Homebrew's python3 before macOS's.
    #[test]
    #[cfg(unix)]
    fn user_folders_come_before_the_systems() {
        let p = order("/usr/bin:/bin:/usr/sbin:/sbin");
        let at = |d: &str| p.iter().position(|x| x == d).unwrap();
        assert!(at("/opt/homebrew/bin") < at("/usr/bin"), "{p:?}");
        assert!(at("/Users/me/.local/bin") < at("/usr/bin"));
        assert!(at("/usr/local/bin") < at("/usr/bin"));
        assert!(at("/usr/bin") < at("/sbin"), "the system's own order kept");
        assert_eq!(p.iter().filter(|x| *x == "/usr/bin").count(), 1, "no duplicates");
        // From a terminal: the user's own order comes first.
        let p = order("/Users/me/.pyenv/shims:/opt/homebrew/bin:/usr/bin:/bin");
        assert_eq!(p[0], "/Users/me/.pyenv/shims");
        assert!(p.iter().position(|x| x == "/opt/homebrew/bin") < p.iter().position(|x| x == "/usr/bin"));
        // No PATH at all: still the usual places.
        let p = ordered_path(Vec::new(), None);
        assert!(p.contains(&PathBuf::from("/opt/homebrew/bin")) && p.contains(&PathBuf::from("/usr/bin")));
    }

    #[test]
    fn a_failed_write_names_the_file_and_keeps_the_cause() {
        let missing = std::env::temp_dir().join("snapstudio-no-such-dir").join("store.json");
        let e = write_atomic(&missing, b"{}").unwrap_err();
        let shown = ui_err(&e);
        assert!(shown.contains("store.tmp"), "{shown}");
        assert!(shown.len() > e.to_string().len(), "the OS cause follows: {shown}");
    }
}
