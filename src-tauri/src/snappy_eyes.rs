//! What Snappy can see: a printer camera's picture, Prepare's plate, the
//! images the user attaches to a message.
//!
//! A tool answers with an image through `image()`: the MCP server sends it
//! as an image block Claude looks at (`snappy_mcp.rs`), beside the rest of
//! the answer as text. Images never go through the text privacy filter
//! (base64 would be mangled); a camera picture is confirmed by the user
//! before it leaves (it shows their workshop).

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Longest side of an image sent to Claude: the model scales larger ones
/// down anyway.
const MAX_SIDE: u32 = 1568;
/// Attachments kept per message, and their size.
pub const MAX_IMAGES: usize = 4;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// A tool answer carrying an image (`mime`, base64 `data`) and `rest` as text.
pub fn image(mime: &str, data: &[u8], rest: Value) -> Value {
    let mut v = if rest.is_object() { rest } else { json!({}) };
    v["_image"] = json!({ "mime": mime, "data": crate::util::b64_encode(data) });
    v
}

/// The image of a tool answer, taken out of it (it is not text).
pub fn take_image(v: &mut Value) -> Option<Value> {
    v.as_object_mut()?.remove("_image")
}

/// A JPEG of at most MAX_SIDE, from any image the `image` crate reads.
fn fit_jpeg(bytes: &[u8]) -> Result<Vec<u8>> {
    let img = image::load_from_memory(bytes)?;
    let img =
        if img.width().max(img.height()) > MAX_SIDE { img.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Triangle) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    img.to_rgb8().write_to(&mut out, image::ImageFormat::Jpeg)?;
    Ok(out.into_inner())
}

// ------------------------------------------------------------ the camera

pub fn ask_camera(args: &Value) -> Result<String> {
    let p = crate::snappy_tools::printer_named(args["printer"].as_str().unwrap_or_default())?;
    Ok(crate::t!("snappy.ask.camera", printer = p.name))
}

/// The printer's camera, now: woken, then its latest picture.
pub fn camera(args: &Value) -> Result<Value> {
    let p = crate::snappy_tools::printer_named(args["printer"].as_str().unwrap_or_default())?;
    let jpeg = tauri::async_runtime::block_on(async {
        crate::printers::camera_start(&p.host, p.port).await?;
        // The camera publishes a fresh picture within about a second.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        crate::printers::camera_frame(&p.host, p.port).await
    })?;
    Ok(image("image/jpeg", &fit_jpeg(&jpeg)?, json!({ "printer": p.name, "camera": "now" })))
}

// ------------------------------------------------------------ the plate

/// Prepare's plate as the 3D view shows it (drawn by the page).
pub fn plate_view(_: &Value) -> Result<Value> {
    let v = crate::snappy_tools::ui_call("plate_view", json!({}))?;
    let data = v["png"].as_str().and_then(crate::util::b64_decode).ok_or_else(|| anyhow!("Prepare has no plate to show"))?;
    let mut rest = v.clone();
    if let Some(o) = rest.as_object_mut() {
        o.remove("png");
    }
    Ok(image("image/jpeg", &fit_jpeg(&data)?, rest))
}

// ------------------------------------------------------------ attachments

pub fn attachments_dir() -> PathBuf {
    crate::snappy::root().join("attachments")
}

/// Whether `name` can be an attachment's: the characters
/// `chat::attachment_name` keeps (any letter or digit, accents and CJK
/// included, dots, dashes, underscores), never a separator or a dot first.
fn attachment_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 240
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// An attachment's file, by its name only (no path can reach elsewhere).
fn attachment_path(name: &str) -> Result<PathBuf> {
    let p = attachments_dir().join(name);
    if !attachment_name_ok(name) || !p.is_file() {
        return Err(anyhow!("no attachment named “{name}”"));
    }
    Ok(p)
}

/// Saves the images of a message (base64), scaled, as numbered JPEGs;
/// returns their names.
pub fn save_attachments(images: &[crate::chat::Attachment]) -> Result<Vec<String>> {
    if images.len() > MAX_IMAGES {
        return Err(anyhow!(crate::t!("chat.too_many", n = MAX_IMAGES)));
    }
    let dir = attachments_dir();
    std::fs::create_dir_all(&dir)?;
    let mut names = Vec::new();
    for a in images {
        let bytes = crate::util::b64_decode(&a.data).ok_or_else(|| anyhow!(crate::t!("chat.bad_image", name = a.name)))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(anyhow!(crate::t!("chat.bad_image", name = a.name)));
        }
        let jpeg = fit_jpeg(&bytes).map_err(|_| anyhow!(crate::t!("chat.bad_image", name = a.name)))?;
        let stem = std::path::Path::new(&a.name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let name = crate::chat::attachment_name(&dir, &format!("{stem}.jpg"));
        std::fs::write(dir.join(&name), jpeg)?;
        names.push(name);
    }
    Ok(names)
}

/// An attachment as a `data:` URL, for the card.
pub fn attachment_url(name: &str) -> Result<String> {
    let bytes = std::fs::read(attachment_path(name)?)?;
    Ok(format!("data:image/jpeg;base64,{}", crate::util::b64_encode(&bytes)))
}

pub fn attachment_params() -> Value {
    json!({ "type": "object", "properties": { "name": { "type": "string", "description": "The attachment's name, as the message gives it." } }, "required": ["name"] })
}

/// An image the user attached to a message.
pub fn attachment_view(args: &Value) -> Result<Value> {
    let name = args["name"].as_str().unwrap_or_default();
    let bytes = std::fs::read(attachment_path(name)?)?;
    Ok(image("image/jpeg", &bytes, json!({ "name": name })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_travels_apart_from_the_text() {
        let mut v = image("image/jpeg", b"\xff\xd8jpeg", json!({ "printer": "Atelier U1" }));
        let img = take_image(&mut v).unwrap();
        assert_eq!(img["mime"], "image/jpeg");
        assert_eq!(crate::util::b64_decode(img["data"].as_str().unwrap()).unwrap(), b"\xff\xd8jpeg");
        assert_eq!(v, json!({ "printer": "Atelier U1" }), "the rest stays text");
    }

    #[test]
    fn attachments_are_reached_by_name_only() {
        for bad in ["../MEMORY.md", "/etc/hosts", "a/b.jpg", ".hidden", ""] {
            assert!(attachment_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn accented_and_cjk_names_are_read_back() {
        for name in ["Pièce.jpg", "写真.jpg", "Überhang_2.jpg"] {
            // Named as save_attachments names them, then accepted.
            let saved = crate::chat::attachment_name(&std::env::temp_dir().join("snapstudio-none"), name);
            assert!(saved.ends_with(name), "{saved}");
            assert!(attachment_name_ok(&saved), "{saved}");
        }
        for bad in ["../MEMORY.md", "a/b.jpg", "a\\b.jpg", ".hidden", ""] {
            assert!(!attachment_name_ok(bad), "{bad}");
        }
    }

    #[test]
    fn large_images_are_scaled_down() {
        let big = image::RgbImage::new(4000, 2000);
        let mut png = std::io::Cursor::new(Vec::new());
        big.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let jpeg = fit_jpeg(png.get_ref()).unwrap();
        let back = image::load_from_memory(&jpeg).unwrap();
        assert_eq!((back.width(), back.height()), (MAX_SIDE, MAX_SIDE / 2));
    }
}
