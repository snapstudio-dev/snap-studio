//! Colour changes at a height (HueForge): from a given layer up, the plate
//! prints with another head, or stops for a spool swap.
//!
//! The engine does the work (Snapmaker Orca's `CustomGCode`): a list given
//! with `--load-custom-gcodes` switches the head of every layer from a
//! height up (`ToolChange`), or pauses before a layer (`PausePrint`, the
//! U1's `M600`). It only switches heads when the whole plate prints with a
//! single one (`MultiAsSingle`). A 3MF keeps the list in
//! `Metadata/custom_gcode_per_layer.xml`, which Orca and HueForge's 3MF
//! export write too. Analysis: docs/hueforge/analyse.md.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// What happens at the height: the head changes on its own, or the print
/// pauses for the spool to be swapped by hand.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    #[default]
    Auto,
    Pause,
}

/// A change in a slice request.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct HeightChange {
    /// Top of the first layer printed with the new head, mm.
    pub z: f32,
    /// The head from there on, as in the extruder maps: physical heads from
    /// 0, then the virtual ones (`n + k`). A pause keeps the head: it carries
    /// the one in force (its colour is the one shown).
    pub head: u8,
    #[serde(default)]
    pub kind: ChangeKind,
}

/// A change as a 3MF keeps it: the model extruder from 1 (the slice sheet
/// gives it its head, as for the model's own colours).
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct FileChange {
    pub z: f32,
    pub extruder: u8,
    #[serde(default)]
    pub kind: ChangeKind,
}

/// The layers of a print: the first one's height, then every other one's.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layers {
    pub first: f32,
    pub height: f32,
}

impl Layers {
    /// Top of layer `n` (from 1).
    pub fn top(&self, n: u32) -> f32 {
        self.first + n.saturating_sub(1) as f32 * self.height
    }

    /// The layer whose top is nearest `z`; never the first one, which no
    /// change can start.
    pub fn layer_of(&self, z: f32) -> u32 {
        if self.height <= 0.0 {
            return 2;
        }
        (((z - self.first) / self.height).round().max(0.0) as u32 + 1).max(2)
    }

    /// `z` on the top of a real layer. The engine does not round a height
    /// between two layers the same way for a head change (the next layer)
    /// and for a pause (the nearest one), so every height is set on a
    /// layer first; rounded as Orca writes them.
    pub fn snap(&self, z: f32) -> f32 {
        (self.top(self.layer_of(z)) * 1000.0).round() / 1000.0
    }
}

/// The list the engine reads (`--load-custom-gcodes`), heights on their
/// layers, in order: head `h` is the engine's filament `h + 1` (a virtual
/// head's too: they follow the physical ones); `colors` per head, for the
/// engine's own preview.
pub fn engine_list(changes: &[HeightChange], layers: Layers, colors: &[Option<String>]) -> Value {
    let mut list: Vec<(f32, &HeightChange)> = changes.iter().map(|c| (layers.snap(c.z), c)).collect();
    list.sort_by(|a, b| a.0.total_cmp(&b.0));
    let gcodes: Vec<Value> = list
        .into_iter()
        .map(|(z, c)| {
            json!({
                "type": match c.kind { ChangeKind::Auto => "ToolChange", ChangeKind::Pause => "PausePrint" },
                // In f64 to 3 decimals: an f32 would reach the engine as 1.0399999…
                "print_z": (z as f64 * 1000.0).round() / 1000.0,
                "extruder": c.head as u32 + 1,
                "color": colors.get(c.head as usize).cloned().flatten().unwrap_or_else(|| "#808080".into()),
                "extra": "",
            })
        })
        .collect();
    json!({ "mode": "MultiAsSingle", "gcodes": gcodes })
}

/// The layers a file placed its changes on (its project settings), sent
/// back with them: a profile with other layers would change colour
/// elsewhere.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct FileLayers {
    #[serde(default)]
    pub layer_height: Option<f32>,
    #[serde(default)]
    pub first_layer: Option<f32>,
}

impl FileLayers {
    /// `Err` (a message for the user) when the profile's layers are not
    /// the file's; a value the file does not give is not checked.
    pub fn check(&self, layers: Layers) -> Result<(), String> {
        let differs = |file: Option<f32>, profile: f32| file.is_some_and(|f| (f - profile).abs() > 0.001);
        if differs(self.layer_height, layers.height) || differs(self.first_layer, layers.first) {
            let mm = |h: f32| format!("{h} mm");
            let file = format!(
                "{} / {}",
                self.layer_height.map(mm).unwrap_or_else(|| "?".into()),
                self.first_layer.map(mm).unwrap_or_else(|| "?".into())
            );
            let profile = format!("{} / {}", mm(layers.height), mm(layers.first));
            return Err(crate::t!("slice.heights.layer", file = file, profile = profile));
        }
        Ok(())
    }
}

/// Orca's `CustomGCode::Type`, as the XML numbers it.
const TYPE_COLOR_CHANGE: u8 = 0;
const TYPE_PAUSE: u8 = 1;
const TYPE_TOOL_CHANGE: u8 = 2;

/// The first plate's changes in `custom_gcode_per_layer.xml`. A file
/// without `<plate>` is the first plate's; the older format without `type`
/// says it with its G-code. A colour change (`M600`: the spool of the head
/// in use swapped by hand) is taken as a pause; custom G-code and
/// templates are left out.
pub fn read_xml(data: &[u8]) -> Vec<FileChange> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(data);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut out = Vec::new();
    // Inside a <plate>: which one (the first until its <plate_info> says
    // otherwise); outside, the first.
    let mut plate: Option<u32> = None;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                "plate" => plate = Some(1),
                "plate_info" => {
                    if plate.is_some() {
                        plate = Some(crate::model3mf::attr_str(&e, "id").and_then(|v| v.parse().ok()).unwrap_or(1));
                    }
                }
                "layer" if plate.is_none_or(|p| p == 1) => out.extend(layer(&e)),
                _ => {}
            },
            Ok(Event::End(e)) if e.local_name().as_ref() == "plate" => plate = None,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out.sort_by(|a, b| a.z.total_cmp(&b.z));
    out
}

/// One `<layer>`: a head change or a pause; anything else is `None`.
fn layer(e: &quick_xml::events::BytesStart) -> Option<FileChange> {
    let attr = |k: &str| crate::model3mf::attr_str(e, k);
    let z = attr("top_z").and_then(|v| v.parse::<f32>().ok()).filter(|z| z.is_finite() && *z > 0.0)?;
    let ty = attr("type").and_then(|v| v.parse::<u8>().ok()).or_else(|| match attr("gcode").as_deref() {
        Some("M600") => Some(TYPE_COLOR_CHANGE),
        Some("M601") => Some(TYPE_PAUSE),
        Some("tool_change") => Some(TYPE_TOOL_CHANGE),
        _ => None,
    });
    let kind = match ty? {
        TYPE_TOOL_CHANGE => ChangeKind::Auto,
        TYPE_PAUSE | TYPE_COLOR_CHANGE => ChangeKind::Pause,
        _ => return None,
    };
    let extruder = attr("extruder").and_then(|v| v.parse::<u8>().ok()).unwrap_or(1).clamp(1, 16);
    Some(FileChange { z, extruder, kind })
}

/// The XML Orca writes for the first plate: `colors` per model extruder
/// (from 1), for Orca's own preview.
pub fn write_xml(changes: &[FileChange], colors: &[Option<String>]) -> String {
    let mut s = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<custom_gcodes_per_layer>\n<plate>\n<plate_info id=\"1\"/>\n");
    for c in changes {
        let (ty, gcode) = match c.kind {
            ChangeKind::Auto => (TYPE_TOOL_CHANGE, "tool_change"),
            ChangeKind::Pause => (TYPE_PAUSE, "M601"),
        };
        let color = colors.get(c.extruder.saturating_sub(1) as usize).cloned().flatten().unwrap_or_default();
        let color: String = color.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '#').collect();
        s.push_str(&format!(
            "<layer top_z=\"{}\" type=\"{ty}\" extruder=\"{}\" color=\"{color}\" extra=\"\" gcode=\"{gcode}\"/>\n",
            (c.z * 1000.0).round() / 1000.0,
            c.extruder
        ));
    }
    s.push_str("<mode value=\"MultiAsSingle\"/>\n</plate>\n</custom_gcodes_per_layer>\n");
    s
}

/// The changes a saved plate keeps, with each model extruder's colour (from
/// 1: entry `i` is extruder `i + 1`'s).
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Saved {
    pub changes: Vec<FileChange>,
    #[serde(default)]
    pub colors: Vec<Option<String>>,
}

/// Where a 3MF keeps its changes.
pub const XML_ENTRY: &str = "Metadata/custom_gcode_per_layer.xml";

/// What a 3MF says about colour changes: the first plate's list and the
/// layers it was made for (`project_settings.config`), if it says.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct FileHeights {
    pub changes: Vec<FileChange>,
    pub layer_height: Option<f32>,
    pub first_layer: Option<f32>,
    /// The file changes the layer height over a range of heights (HueForge's
    /// thicker base, `layer_config_ranges.xml`): not taken over, the file's
    /// fine layer is printed everywhere.
    #[serde(default)]
    pub ranges: bool,
}

pub fn of_file(path: &std::path::Path) -> FileHeights {
    if crate::scan::kind_of(path) != Some("3mf") {
        return FileHeights::default();
    }
    let Ok(mut zip) = crate::model3mf::open(path) else {
        return FileHeights::default();
    };
    let changes = crate::model3mf::read_entry(&mut zip, XML_ENTRY).map(|d| read_xml(&d)).unwrap_or_default();
    if changes.is_empty() {
        return FileHeights::default();
    }
    let settings: Value = crate::model3mf::read_entry(&mut zip, "Metadata/project_settings.config")
        .and_then(|d| serde_json::from_slice(&d).ok())
        .unwrap_or(Value::Null);
    let ranges = crate::model3mf::read_entry(&mut zip, "Metadata/layer_config_ranges.xml").is_some_and(|d| has_ranges(&d));
    FileHeights {
        changes,
        layer_height: setting(&settings, "layer_height"),
        first_layer: setting(&settings, "initial_layer_print_height"),
        ranges,
    }
}

/// Whether Orca's `layer_config_ranges.xml` sets at least one range.
fn has_ranges(xml: &[u8]) -> bool {
    String::from_utf8_lossy(xml).contains("<range")
}

/// A number of a profile or project setting: a string, or a list's first.
pub fn setting(v: &Value, key: &str) -> Option<f32> {
    let x = v.get(key)?;
    let x = x.as_array().and_then(|a| a.first()).unwrap_or(x);
    x.as_str().and_then(|s| s.trim().parse().ok()).or_else(|| x.as_f64().map(|f| f as f32)).filter(|f: &f32| f.is_finite() && *f > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HUEFORGE: Layers = Layers { first: 0.16, height: 0.08 };

    #[test]
    fn heights_land_on_layers() {
        // HueForge's "At layer #11 (0.96mm)": the top of layer 11.
        assert_eq!(HUEFORGE.layer_of(0.96), 11);
        assert_eq!(HUEFORGE.snap(0.96), 0.96);
        // Between two layers: the nearest top (0.48 and 0.56 around 0.50).
        assert_eq!(HUEFORGE.snap(0.50), 0.48);
        assert_eq!(HUEFORGE.snap(0.53), 0.56);
        // Never the first layer.
        assert_eq!(HUEFORGE.layer_of(0.0), 2);
        assert_eq!(HUEFORGE.snap(0.1), 0.24);
    }

    #[test]
    fn layer_ranges_are_seen() {
        assert!(has_ranges(br#"<objects><object id="1"><range min_z="0" max_z="0.4"><option opt_key="layer_height">0.16</option></range></object></objects>"#));
        assert!(!has_ranges(br#"<objects><object id="1"></object></objects>"#));
    }

    #[test]
    fn engine_list_numbers_filaments_from_one() {
        let changes = [
            HeightChange { z: 1.12, head: 4, kind: ChangeKind::Auto },
            HeightChange { z: 0.5, head: 1, kind: ChangeKind::Auto },
            HeightChange { z: 1.04, head: 2, kind: ChangeKind::Pause },
        ];
        let colors = vec![Some("#000000".into()), Some("#ff0000".into()), None, None, Some("#808000".into())];
        let v = engine_list(&changes, HUEFORGE, &colors);
        assert_eq!(v["mode"], "MultiAsSingle");
        let g = v["gcodes"].as_array().unwrap();
        // In order, on their layers; a virtual head (4 with 4 physical
        // heads) is filament 5.
        assert_eq!(g[0]["type"], "ToolChange");
        assert_eq!(g[0]["print_z"].as_f64().unwrap() as f32, 0.48);
        assert_eq!(g[0]["extruder"], 2);
        assert_eq!(g[0]["color"], "#ff0000");
        assert_eq!(g[1]["type"], "PausePrint");
        assert_eq!(g[1]["color"], "#808080");
        assert_eq!(g[2]["extruder"], 5);
        assert_eq!(g[2]["print_z"].as_f64().unwrap() as f32, 1.12);
    }

    #[test]
    fn reads_the_first_plate() {
        let xml = br##"<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
<plate><plate_info id="2"/><layer top_z="0.4" type="2" extruder="3" color="#00ff00" extra="" gcode="tool_change"/><mode value="MultiAsSingle"/></plate>
<plate><plate_info id="1"/>
<layer top_z="1.04" type="1" extruder="1" color="" extra="" gcode="M601"/>
<layer top_z="0.48" type="2" extruder="2" color="#ff0000" extra="" gcode="tool_change"/>
<layer top_z="0.8" type="4" extruder="1" color="" extra="G4 S1" gcode="custom"/>
<mode value="MultiAsSingle"/></plate>
</custom_gcodes_per_layer>"##;
        let c = read_xml(xml);
        assert_eq!(
            c,
            vec![FileChange { z: 0.48, extruder: 2, kind: ChangeKind::Auto }, FileChange { z: 1.04, extruder: 1, kind: ChangeKind::Pause },]
        );
    }

    #[test]
    fn reads_the_older_format() {
        let xml = br##"<custom_gcodes_per_layer><code print_z="0" /><layer top_z="0.6" extruder="2" color="#fff" gcode="tool_change"/><layer top_z="0.9" extruder="1" gcode="M601"/><layer top_z="1.2" extruder="2" color="#000" gcode="M600"/></custom_gcodes_per_layer>"##;
        let c = read_xml(xml);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0], FileChange { z: 0.6, extruder: 2, kind: ChangeKind::Auto });
        assert_eq!(c[1].kind, ChangeKind::Pause);
        // A colour change swaps the spool by hand: a pause.
        assert_eq!(c[2].kind, ChangeKind::Pause);
    }

    #[test]
    fn a_colour_change_is_a_pause() {
        let xml = br##"<custom_gcodes_per_layer><plate><plate_info id="1"/><layer top_z="0.8" type="0" extruder="1" color="#ff0000" extra="" gcode="M600"/></plate></custom_gcodes_per_layer>"##;
        assert_eq!(read_xml(xml), vec![FileChange { z: 0.8, extruder: 1, kind: ChangeKind::Pause }]);
    }

    #[test]
    fn a_plate_without_info_is_the_first() {
        let xml = br##"<custom_gcodes_per_layer><plate><layer top_z="0.4" type="2" extruder="2" color="" extra="" gcode="tool_change"/></plate><plate><plate_info id="2"/><layer top_z="0.6" type="2" extruder="3" color="" extra="" gcode="tool_change"/></plate></custom_gcodes_per_layer>"##;
        assert_eq!(read_xml(xml), vec![FileChange { z: 0.4, extruder: 2, kind: ChangeKind::Auto }]);
    }

    #[test]
    fn file_layers_must_be_the_profile_s() {
        let file = FileLayers { layer_height: Some(0.08), first_layer: Some(0.16) };
        assert!(file.check(HUEFORGE).is_ok());
        assert!(file.check(Layers { first: 0.2, height: 0.08 }).is_err());
        assert!(file.check(Layers { first: 0.16, height: 0.12 }).is_err());
        // What the file does not say is not checked.
        assert!(FileLayers { layer_height: Some(0.08), first_layer: None }.check(Layers { first: 0.3, height: 0.08 }).is_ok());
        assert!(FileLayers::default().check(Layers { first: 0.3, height: 0.2 }).is_ok());
    }

    #[test]
    fn written_xml_reads_back() {
        let changes =
            vec![FileChange { z: 0.48, extruder: 2, kind: ChangeKind::Auto }, FileChange { z: 1.04, extruder: 3, kind: ChangeKind::Pause }];
        let xml = write_xml(&changes, &[None, Some("#ff0000".into())]);
        assert!(xml.contains(r##"<layer top_z="0.48" type="2" extruder="2" color="#ff0000" extra="" gcode="tool_change"/>"##));
        assert_eq!(read_xml(xml.as_bytes()), changes);
    }

    #[test]
    fn settings_read_as_numbers() {
        let v = json!({ "layer_height": "0.08", "initial_layer_print_height": ["0.16"], "x": "abc" });
        assert_eq!(setting(&v, "layer_height"), Some(0.08));
        assert_eq!(setting(&v, "initial_layer_print_height"), Some(0.16));
        assert_eq!(setting(&v, "x"), None);
    }
}
