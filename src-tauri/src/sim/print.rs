//! A simulated print follows its G-code, read by the app's own reader
//! (`gcode.rs`): total time, when each layer ends, the tool changes in
//! order, the filament. The printer's clock (the time factor, the 2 min
//! floor) then runs through it.

use super::clock::MIN_PRINT_REAL_S;
use anyhow::{anyhow, Result};

/// What a print file makes the printer do, in simulated seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    /// From the first move to the end.
    pub total: f64,
    /// Elapsed time at the end of each layer (layer 0: the start G-code).
    pub layer_end: Vec<f64>,
    pub layers: u32,
    pub filament_mm: f64,
    /// G-code tools that extrude.
    pub tools: Vec<u8>,
    /// (time, tool): each tool change, the first pick included.
    pub changes: Vec<(f64, u8)>,
    pub bed_temp: f64,
    pub nozzle_temp: f64,
}

impl Plan {
    pub fn from_gcode(read: impl std::io::Read) -> Result<Plan> {
        let d = crate::gcode::parse_with(read, crate::gcode::Keep::Extrusions)?;
        let st = crate::gcode::stats(&d);
        let total = st.print_time_s.unwrap_or(0) as f64;
        if total <= 0.0 {
            return Err(anyhow!("File has no printable moves"));
        }
        let layer_end: Vec<f64> = st.layer_end_s.iter().map(|t| *t as f64).collect();
        // Each change dated by its place in its layer.
        let mut changes: Vec<(f64, u8)> = Vec::new();
        let mut by_layer: Vec<Vec<usize>> = vec![Vec::new(); d.layers as usize + 1];
        for (i, s) in d.segs.iter().enumerate() {
            if !s.travel {
                by_layer[s.layer as usize].push(i);
            }
        }
        let mut cur: Option<u8> = None;
        for (l, idx) in by_layer.iter().enumerate() {
            let start = if l == 0 { 0.0 } else { layer_end.get(l - 1).copied().unwrap_or(0.0) };
            let end = layer_end.get(l).copied().unwrap_or(start).max(start);
            for (k, i) in idx.iter().enumerate() {
                let t = d.segs[*i].tool;
                if cur != Some(t) {
                    cur = Some(t);
                    changes.push((start + (end - start) * k as f64 / idx.len().max(1) as f64, t));
                }
            }
        }
        let filament_mm = if st.per_tool_m.is_empty() { 0.0 } else { st.per_tool_m.iter().map(|m| *m as f64 * 1000.0).sum() };
        let petg = st.filament_types.iter().any(|t| t.to_ascii_uppercase().contains("PETG"));
        Ok(Plan {
            total,
            layers: st.layers.max(1),
            layer_end,
            filament_mm,
            tools: if st.tools.is_empty() { vec![0] } else { st.tools.clone() },
            changes,
            bed_temp: if petg { 70.0 } else { 60.0 },
            nozzle_temp: if petg { 240.0 } else { 220.0 },
        })
    }

    /// The layer printing at `t` seconds into the file (1-based, at most
    /// the last). Layer 0 is the start G-code.
    pub fn layer_at(&self, t: f64) -> u32 {
        let done = self.layer_end.iter().skip(1).filter(|e| **e <= t).count() as u32;
        (done + 1).min(self.total_layers())
    }

    /// Layers of the part, the start G-code's layer 0 aside.
    pub fn total_layers(&self) -> u32 {
        self.layers.saturating_sub(1).max(1)
    }
}

/// Simulated seconds spent before the first layer: heating, then the
/// leveling and the flow calibration the start asked for.
pub fn preamble(bed_leveling: bool, flow_calibration: bool) -> f64 {
    60.0 + if bed_leveling { 180.0 } else { 0.0 } + if flow_calibration { 90.0 } else { 0.0 }
}

/// How fast a print of `duration` simulated seconds runs: the time factor,
/// slowed so that it lasts at least the 2 min floor in real time.
pub fn rate(factor: f64, duration: f64) -> f64 {
    factor.min(duration / MIN_PRINT_REAL_S).max(1e-3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::fixtures::sample_gcode;
    use crate::sim::scenario::{default_spools, SampleFile};

    fn plan(tools: Vec<u8>, minutes: u32, layers: u32) -> Plan {
        let f = SampleFile { name: "x.gcode".into(), tools, minutes, layers, materials: vec![], colors: vec![] };
        Plan::from_gcode(sample_gcode(&f, &default_spools()).as_bytes()).unwrap()
    }

    #[test]
    fn a_plan_follows_the_file() {
        let p = plan(vec![0, 2], 60, 10);
        assert_eq!(p.total, 3600.0);
        assert_eq!((p.layers, p.total_layers()), (11, 10));
        assert_eq!(p.tools, vec![0, 2]);
        // T0 then T2 on each of the ten layers, in time order.
        assert_eq!(p.changes.len(), 20);
        assert!(p.changes.windows(2).all(|w| w[0].0 <= w[1].0 && w[0].1 != w[1].1));
        assert_eq!(p.changes[0].1, 0);
        assert!(p.filament_mm > 0.0);
        assert_eq!(p.layer_at(0.0), 1);
        assert_eq!(p.layer_at(p.total + 1.0), 10);
        let mid = p.layer_at(p.total / 2.0);
        assert!((4..=6).contains(&mid), "{mid}");
        assert!(Plan::from_gcode("; nothing\n".as_bytes()).is_err(), "a file without moves fails");
    }

    #[test]
    fn the_two_minute_floor() {
        // A 2 h print: ×1 stays ×1, ×600 would last 12 s, slowed to 2 min.
        assert_eq!(rate(1.0, 7200.0), 1.0);
        assert_eq!(rate(600.0, 7200.0), 60.0);
        assert_eq!(7200.0 / rate(600.0, 7200.0), MIN_PRINT_REAL_S);
        // A 1 min print at ×1 is stretched too.
        assert_eq!(60.0 / rate(1.0, 60.0), MIN_PRINT_REAL_S);
        assert_eq!(preamble(true, true), 330.0);
    }
}
