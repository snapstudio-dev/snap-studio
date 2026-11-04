//! Favorites: links to models, set aside from the Library.
//!
//! A favorite is just a saved link: the page's address, its title as the tab
//! shows it, the site, the date. Nothing is downloaded — earlier versions
//! read the page again for a description and a thumbnail, which sites with
//! anti-bot protection refused.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Favorite {
    pub id: String,
    pub url: String,
    pub site: String,
    pub title: String,
    pub added_at: u64,
}

fn dir() -> PathBuf {
    let d = dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("fr.carlini.snapstudio");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn store_path() -> PathBuf {
    dir().join("favorites.json")
}

/// Thumbnails cached by earlier versions: removed once, nothing reads them.
fn forget_old_thumbnails() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if let Some(cache) = dirs::cache_dir() {
            let _ = std::fs::remove_dir_all(cache.join("fr.carlini.snapstudio").join("favimg"));
        }
    });
}

/// Newest first. Older stores (description, thumbnail, done flag) still
/// read: the fields that went are ignored.
pub fn list() -> Vec<Favorite> {
    forget_old_thumbnails();
    let mut v: Vec<Favorite> = std::fs::read(store_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    v.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    v
}

fn save(list: &[Favorite]) -> Result<()> {
    crate::util::write_atomic(&store_path(), &serde_json::to_vec_pretty(list)?)
}

pub fn remove(id: &str) -> Result<Vec<Favorite>> {
    let mut v = list();
    v.retain(|f| f.id != id);
    save(&v)?;
    Ok(list())
}

/// Readable name of a site from its host.
fn site_name(host: &str) -> String {
    let h = host.trim_start_matches("www.").to_ascii_lowercase();
    match h.split('.').next().unwrap_or(&h) {
        "makerworld" => "MakerWorld".into(),
        "printables" => "Printables".into(),
        "thingiverse" => "Thingiverse".into(),
        "cults3d" => "Cults3D".into(),
        other => {
            let mut c = other.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => h.clone(),
            }
        }
    }
}

/// Last URL segment turned into a title: "1284937-vase-spirale" gives
/// "Vase spirale". For a page whose title is not known yet.
fn title_from_url(u: &url::Url) -> String {
    let seg = u.path_segments().and_then(|s| s.filter(|x| !x.is_empty()).next_back()).unwrap_or("");
    let cleaned = seg.split('-').filter(|p| !p.chars().all(|c| c.is_ascii_digit())).collect::<Vec<_>>().join(" ").replace('_', " ");
    let t = cleaned.trim();
    if t.is_empty() {
        return u.host_str().unwrap_or("Model").to_string();
    }
    let mut c = t.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => t.to_string(),
    }
}

/// The page title without the site's own suffix: "Vase | MakerWorld" or
/// "Vase - Printables" gives "Vase".
fn clean_title(title: &str, site: &str) -> String {
    let t = title.trim();
    for sep in [" | ", " - ", " – ", " — ", " · "] {
        if let Some((head, tail)) = t.rsplit_once(sep) {
            if tail.to_ascii_lowercase().contains(&site.to_ascii_lowercase()) && !head.trim().is_empty() {
                return head.trim().to_string();
            }
        }
    }
    t.to_string()
}

/// Saves a link; `title` is the page's, as the tab shows it.
pub fn add(url: &str, title: Option<&str>) -> Result<Vec<Favorite>> {
    let parsed = url::Url::parse(url).map_err(|_| anyhow!(crate::t!("err.fav_url")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(anyhow!(crate::t!("err.fav_url")));
    }
    let mut v = list();
    if let Some(existing) = v.iter().find(|f| f.url == url) {
        return Err(anyhow!(crate::t!("err.fav_exists", name = existing.title)));
    }
    let site = site_name(parsed.host_str().unwrap_or(""));
    let title = title.map(|t| clean_title(t, &site)).filter(|t| !t.is_empty()).unwrap_or_else(|| title_from_url(&parsed));
    v.push(Favorite {
        id: format!("{:x}", crate::util::fnv1a(&[url.as_bytes()])),
        url: url.to_string(),
        site,
        title,
        added_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
    });
    save(&v)?;
    Ok(list())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_lose_the_site_suffix() {
        assert_eq!(clean_title("Vase spiralé | MakerWorld", "MakerWorld"), "Vase spiralé");
        assert_eq!(clean_title("Support - Printables", "Printables"), "Support");
        assert_eq!(clean_title("Pied - de - table", "Thingiverse"), "Pied - de - table", "not the site: kept");
        assert_eq!(clean_title("  MakerWorld ", "MakerWorld"), "MakerWorld");
    }

    #[test]
    fn falls_back_on_the_url() {
        let u = url::Url::parse("https://makerworld.com/fr/models/1284937-vase-spirale").unwrap();
        assert_eq!(title_from_url(&u), "Vase spirale");
        assert_eq!(site_name(u.host_str().unwrap()), "MakerWorld");

        let p = url::Url::parse("https://www.printables.com/model/1234-support_telephone").unwrap();
        assert_eq!(title_from_url(&p), "Support telephone");
        assert_eq!(site_name(p.host_str().unwrap()), "Printables");

        // An address without a meaningful segment must not produce an empty title.
        let bare = url::Url::parse("https://makerworld.com/").unwrap();
        assert!(!title_from_url(&bare).is_empty());
    }

    #[test]
    fn only_web_addresses_are_saved() {
        assert!(add("about:blank", None).is_err());
        assert!(add("not an address", Some("x")).is_err());
    }

    /// Older stores still read, without their extra fields.
    #[test]
    fn older_favorites_still_read() {
        let old = r#"[{"id":"1","url":"https://makerworld.com/x","site":"MakerWorld","title":"X",
            "description":"d","image":"1.jpg","added_at":5,"done":true}]"#;
        let v: Vec<Favorite> = serde_json::from_str(old).unwrap();
        assert_eq!(v[0].title, "X");
    }

    #[test]
    fn store_round_trip() {
        let path = store_path();
        let backup = std::fs::read(&path).ok();
        let url = "https://example.com/models/42-test-part";
        let mut v = list();
        v.retain(|x| x.url != url);
        save(&v).unwrap();

        let after = add(url, Some("Test part | Example")).unwrap();
        let f = after.iter().find(|x| x.url == url).unwrap().clone();
        assert_eq!(f.title, "Test part");
        assert!(add(url, None).is_err(), "no duplicate");
        let left = remove(&f.id).unwrap();
        assert!(!left.iter().any(|x| x.url == url));

        match backup {
            Some(b) => std::fs::write(&path, b).unwrap(),
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}
