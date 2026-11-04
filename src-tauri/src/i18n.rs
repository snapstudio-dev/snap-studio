//! Interface language.
//!
//! The catalogs live in `ui/i18n/*.json` and are shared with the web UI: they
//! are compiled into the binary, used here for native menus and messages, and
//! injected into the main window before its scripts run (see `init_script`).
//!
//! Keys are flat and dotted (`menu.file.open`). A value is either a string or,
//! for plurals, an object keyed by `Intl.PluralRules` categories
//! (`{"one": "…", "other": "…"}`). Placeholders read `{name}`.
//!
//! English is the reference: a key missing from another catalog falls back to
//! it, then to the key itself. French is kept complete by hand; the other
//! languages may lag behind English while their translations are reviewed.
//!
//! Adding a language: its catalog in `ui/i18n/<code>.json` and a row in
//! `LANGS` (code, names, locale, plural rule): nothing else to keep in step.

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

/// A language of the interface.
pub struct Lang {
    /// Code of the catalog file and of the preference: `pt-BR`.
    pub code: &'static str,
    /// Name in the language itself, for the pickers.
    pub name: &'static str,
    /// Name in English, for instructions given to an AI.
    pub english: &'static str,
    /// BCP 47 locale for dates and numbers.
    pub locale: &'static str,
    /// Which counts take the singular form.
    plural: Plural,
    raw: &'static str,
}

/// The counts a language says in the singular (`Intl.PluralRules`' `one`).
#[derive(Clone, Copy)]
enum Plural {
    /// One only: English, German, Spanish, Italian.
    One,
    /// Zero and one: French, Brazilian Portuguese.
    ZeroOne,
    /// None, every count reads `other`: Japanese, Chinese, Korean.
    Never,
}

/// Supported languages, in the order the pickers show them.
pub const LANGS: &[Lang] = &[
    Lang {
        code: "en",
        name: "English",
        english: "English",
        locale: "en-US",
        plural: Plural::One,
        raw: include_str!("../../ui/i18n/en.json"),
    },
    Lang {
        code: "fr",
        name: "Français",
        english: "French",
        locale: "fr-FR",
        plural: Plural::ZeroOne,
        raw: include_str!("../../ui/i18n/fr.json"),
    },
    Lang {
        code: "de",
        name: "Deutsch",
        english: "German",
        locale: "de-DE",
        plural: Plural::One,
        raw: include_str!("../../ui/i18n/de.json"),
    },
    Lang {
        code: "es",
        name: "Español",
        english: "Spanish",
        locale: "es-ES",
        plural: Plural::One,
        raw: include_str!("../../ui/i18n/es.json"),
    },
    Lang {
        code: "pt-BR",
        name: "Português (Brasil)",
        english: "Brazilian Portuguese",
        locale: "pt-BR",
        plural: Plural::ZeroOne,
        raw: include_str!("../../ui/i18n/pt-BR.json"),
    },
    Lang {
        code: "it",
        name: "Italiano",
        english: "Italian",
        locale: "it-IT",
        plural: Plural::One,
        raw: include_str!("../../ui/i18n/it.json"),
    },
    Lang {
        code: "ja",
        name: "日本語",
        english: "Japanese",
        locale: "ja-JP",
        plural: Plural::Never,
        raw: include_str!("../../ui/i18n/ja.json"),
    },
    Lang {
        code: "zh-Hans",
        name: "简体中文",
        english: "Simplified Chinese",
        locale: "zh-CN",
        plural: Plural::Never,
        raw: include_str!("../../ui/i18n/zh-Hans.json"),
    },
    Lang {
        code: "ko",
        name: "한국어",
        english: "Korean",
        locale: "ko-KR",
        plural: Plural::Never,
        raw: include_str!("../../ui/i18n/ko.json"),
    },
];

fn lang_of(code: &str) -> Option<&'static Lang> {
    LANGS.iter().find(|l| l.code == code)
}

fn supported(code: &str) -> bool {
    lang_of(code).is_some()
}

fn catalogs() -> &'static [(&'static str, Map<String, Value>)] {
    static C: OnceLock<Vec<(&'static str, Map<String, Value>)>> = OnceLock::new();
    C.get_or_init(|| {
        LANGS
            .iter()
            .map(|l| {
                let v: Value = serde_json::from_str(l.raw).expect("invalid i18n catalog");
                (l.code, v.as_object().cloned().unwrap_or_default())
            })
            .collect()
    })
}

fn catalog(lang: &str) -> Option<&'static Map<String, Value>> {
    catalogs().iter().find(|(l, _)| *l == lang).map(|(_, m)| m)
}

// ------------------------------------------------------------ preference

fn settings_path() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("fr.carlini.snapstudio").join("settings.json")
}

/// The language the user picked, if they ever did.
#[cfg_attr(test, allow(dead_code))]
fn stored() -> Option<String> {
    let l = stored_value("language")?.as_str()?.to_string();
    supported(&l).then_some(l)
}

/// The system language when we support it, English otherwise.
#[cfg_attr(test, allow(dead_code))]
fn system() -> String {
    from_locale(&sys_locale::get_locale().unwrap_or_default())
}

/// Language of the app for a system locale (`de_AT.UTF-8`, `pt-PT`, `fr`):
/// matched on the language alone; any Portuguese reads Brazilian Portuguese,
/// the only one there is. Chinese reads Simplified Chinese when written in
/// it (`zh-Hans-*`, `zh-CN`, `zh-SG`, `zh`, Windows' old `zh-CHS`), English
/// when written in Traditional Chinese (`zh-Hant-*`, `zh-TW`, `zh-HK`,
/// `zh-MO`, `zh-CHT`), which has no catalog yet.
fn from_locale(loc: &str) -> String {
    let loc = loc.split('.').next().unwrap_or("").to_lowercase();
    let mut parts = loc.split(['-', '_']);
    let code = parts.next().unwrap_or("");
    match code {
        "pt" => "pt-BR".into(),
        "zh" => {
            let rest: Vec<&str> = parts.collect();
            // The script first (Hans, Hant; Windows' old CHS, CHT), else the
            // region.
            let traditional = match rest.first() {
                Some(&("hans" | "chs")) => false,
                Some(&("hant" | "cht")) => true,
                _ => rest.iter().any(|p| matches!(*p, "tw" | "hk" | "mo")),
            };
            if traditional { "en" } else { "zh-Hans" }.into()
        }
        c if supported(c) => c.into(),
        _ => "en".into(),
    }
}

fn current() -> &'static RwLock<String> {
    static L: OnceLock<RwLock<String>> = OnceLock::new();
    L.get_or_init(|| RwLock::new(initial()))
}

#[cfg(not(test))]
fn initial() -> String {
    stored().unwrap_or_else(system)
}

/// Tests read messages in English, whatever the machine they run on.
#[cfg(test)]
fn initial() -> String {
    "en".into()
}

pub fn lang() -> String {
    current().read().unwrap().clone()
}

/// Switches language and remembers the choice.
pub fn set(lang: &str) -> Result<()> {
    if !supported(lang) {
        return Err(anyhow!("unsupported language: {lang}"));
    }
    store("language", Value::String(lang.into()))?;
    *current().write().unwrap() = lang.to_string();
    Ok(())
}

/// A value of the settings file read before the window exists (language,
/// title bar), if it was ever written.
#[cfg_attr(all(test, not(target_os = "linux")), allow(dead_code))]
pub fn stored_value(key: &str) -> Option<Value> {
    let raw = std::fs::read(settings_path()).ok()?;
    let mut v: Value = serde_json::from_slice(&raw).ok()?;
    v.get_mut(key).map(Value::take)
}

/// Writes one value of the settings file, keeping the others.
pub fn store(key: &str, value: Value) -> Result<()> {
    let path = settings_path();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let mut v: Value = std::fs::read(&path)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()));
    v[key] = value;
    std::fs::write(&path, serde_json::to_vec_pretty(&v)?)?;
    Ok(())
}

// ------------------------------------------------------------ lookup

fn lookup(lang: &str, key: &str) -> Option<&'static Value> {
    catalog(lang).and_then(|m| m.get(key)).or_else(|| catalog("en").and_then(|m| m.get(key)))
}

/// The `one` and `other` forms of `Intl.PluralRules`, enough for the counts
/// shown here: some languages count zero as singular, most only one,
/// Japanese, Chinese and Korean none. (Spanish and Italian `many`, for
/// millions, falls back to `other`.)
fn plural_form(lang: &str, n: f64) -> &'static str {
    let one = match lang_of(lang).map_or(Plural::One, |l| l.plural) {
        Plural::One => n == 1.0,
        Plural::ZeroOne => (0.0..2.0).contains(&n),
        Plural::Never => false,
    };
    if one {
        "one"
    } else {
        "other"
    }
}

fn fill(mut s: String, params: &[(&str, String)]) -> String {
    for (k, v) in params {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

/// Translation of `key` in the current language.
pub fn t(key: &str) -> String {
    tf(key, &[])
}

/// Translation with placeholders; a numeric `n` also selects the plural form.
pub fn tf(key: &str, params: &[(&str, String)]) -> String {
    let lang = lang();
    let s = match lookup(&lang, key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(forms)) => {
            let n = params.iter().find(|(k, _)| *k == "n").and_then(|(_, v)| v.parse::<f64>().ok()).unwrap_or(0.0);
            forms.get(plural_form(&lang, n)).or_else(|| forms.get("other")).and_then(Value::as_str).unwrap_or(key).to_string()
        }
        _ => key.to_string(),
    };
    fill(s, params)
}

/// `t!("key")` or `t!("key", name = value, …)`.
#[macro_export]
macro_rules! t {
    ($key:expr) => {
        $crate::i18n::t($key)
    };
    ($key:expr, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::tf($key, &[$((stringify!($name), $value.to_string())),+])
    };
}

// ------------------------------------------------------------ web UI

/// Script run in the main window before any page script: the languages, the
/// English catalog and the current one, so the UI renders translated from its
/// first frame. The others are fetched from `i18n/<code>.json` when picked.
pub fn init_script() -> String {
    let lang = lang();
    let langs: Vec<Value> = LANGS.iter().map(|l| serde_json::json!({ "code": l.code, "name": l.name, "locale": l.locale })).collect();
    let raw = |code: &str| lang_of(code).map(|l| l.raw.trim()).unwrap_or("{}");
    let mut catalogs = format!("{}:{}", serde_json::to_string("en").unwrap(), raw("en"));
    if lang != "en" {
        catalogs += &format!(",{}:{}", serde_json::to_string(&lang).unwrap(), raw(&lang));
    }
    format!(
        "window.__I18N__={{lang:{},langs:{},catalogs:{{{catalogs}}}}};",
        serde_json::to_string(&lang).unwrap(),
        serde_json::to_string(&langs).unwrap(),
    )
}

/// The current language named in English, for instructions given to an AI.
pub fn english_name() -> &'static str {
    lang_of(&lang()).map_or("English", |l| l.english)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogs_parse_and_share_their_keys() {
        let en = catalog("en").unwrap();
        let fr = catalog("fr").unwrap();
        let missing: Vec<_> = en.keys().filter(|k| !fr.contains_key(*k)).collect();
        assert!(missing.is_empty(), "missing from fr.json: {missing:?}");
        // The other languages may miss keys (English shows), never add any.
        for l in LANGS {
            let cat = catalog(l.code).unwrap_or_else(|| panic!("no catalog for {}", l.code));
            let extra: Vec<_> = cat.keys().filter(|k| !en.contains_key(*k)).collect();
            assert!(extra.is_empty(), "unknown to en.json, in {}.json: {extra:?}", l.code);
        }
    }

    #[test]
    fn system_locales() {
        assert_eq!(from_locale("de_AT.UTF-8"), "de");
        assert_eq!(from_locale("es-MX"), "es");
        assert_eq!(from_locale("pt-PT"), "pt-BR");
        assert_eq!(from_locale("pt_BR"), "pt-BR");
        assert_eq!(from_locale("IT"), "it");
        assert_eq!(from_locale("fr-CA"), "fr");
        assert_eq!(from_locale("ja_JP.UTF-8"), "ja");
        assert_eq!(from_locale("ko-KR"), "ko");
        assert_eq!(from_locale("zh-Hans-CN"), "zh-Hans");
        assert_eq!(from_locale("zh_CN.UTF-8"), "zh-Hans");
        assert_eq!(from_locale("zh-SG"), "zh-Hans");
        assert_eq!(from_locale("zh-Hans-HK"), "zh-Hans");
        assert_eq!(from_locale("zh"), "zh-Hans");
        assert_eq!(from_locale("zh-Hant-TW"), "en");
        assert_eq!(from_locale("zh_TW"), "en");
        assert_eq!(from_locale("zh-HK"), "en");
        // Windows' old neutral names.
        assert_eq!(from_locale("zh-CHT"), "en");
        assert_eq!(from_locale("zh-CHS"), "zh-Hans");
        assert_eq!(from_locale("nl-NL"), "en");
        assert_eq!(from_locale(""), "en");
    }

    #[test]
    fn init_script_carries_english_and_the_languages() {
        let s = init_script();
        assert!(s.starts_with("window.__I18N__={lang:\"en\",langs:["));
        assert!(s.contains("\"code\":\"pt-BR\""));
        assert!(s.contains("\"name\":\"Deutsch\""));
    }

    #[test]
    fn placeholders_and_plurals() {
        assert_eq!(fill("Saved: {name}".into(), &[("name", "a.3mf".into())]), "Saved: a.3mf");
        assert_eq!(plural_form("en", 0.0), "other");
        assert_eq!(plural_form("fr", 0.0), "one");
        assert_eq!(plural_form("fr", 1.0), "one");
        assert_eq!(plural_form("en", 2.0), "other");
        assert_eq!(plural_form("pt-BR", 0.0), "one");
        assert_eq!(plural_form("de", 0.0), "other");
        assert_eq!(plural_form("it", 1.0), "one");
        assert_eq!(plural_form("ja", 1.0), "other");
        assert_eq!(plural_form("zh-Hans", 0.0), "other");
        assert_eq!(plural_form("ko", 1.0), "other");
        assert_eq!(t("no.such.key"), "no.such.key");
    }
}
