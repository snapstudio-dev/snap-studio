//! Faults a simulated printer can be given: from its scenario (at launch or
//! on a timer), from Settings › Developer, from `u1-sim fault`, or through
//! its `/sim/fault` path. Each acts where it really happens: at the socket,
//! in Klipper's state, in an answer.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "fault", rename_all = "snake_case")]
pub enum Fault {
    /// WebSocket closed, new connections refused for `secs` seconds.
    Disconnect {
        #[serde(default = "default_disconnect")]
        secs: f64,
    },
    /// Port closed for `secs` seconds (until cleared when 0).
    Unreachable {
        #[serde(default = "default_unreachable")]
        secs: f64,
    },
    /// Every answer delayed by `ms` milliseconds.
    Slow {
        #[serde(default = "default_slow")]
        ms: u64,
    },
    KlippyShutdown {
        #[serde(default)]
        message: Option<String>,
    },
    KlippyError {
        #[serde(default)]
        message: Option<String>,
    },
    /// The filament of head `head` runs out: a print pauses.
    Runout {
        #[serde(default)]
        head: u8,
    },
    /// Uploads fail once `at` percent of the file is received.
    UploadFail {
        #[serde(default = "default_upload_at")]
        at: f64,
    },
    /// `start_local_print` answers an error.
    StartRefused {
        #[serde(default)]
        message: Option<String>,
    },
    /// A firmware without `start_local_print`: the legacy start route.
    NoStartLocalPrint,
    CameraOff,
    /// The next head pick fails (tool change error).
    HeadPickFail,
    /// The print ends in error.
    PrintError {
        #[serde(default)]
        message: Option<String>,
    },
    /// The disk is full: little free space, uploads refused.
    DiskFull,
}

fn default_disconnect() -> f64 {
    30.0
}
fn default_unreachable() -> f64 {
    60.0
}
fn default_slow() -> u64 {
    3000
}
fn default_upload_at() -> f64 {
    50.0
}

/// The faults' names, as `u1-sim fault` and the Developer section list them.
pub const NAMES: [&str; 13] = [
    "disconnect",
    "unreachable",
    "slow",
    "klippy_shutdown",
    "klippy_error",
    "runout",
    "upload_fail",
    "start_refused",
    "no_start_local_print",
    "camera_off",
    "head_pick_fail",
    "print_error",
    "disk_full",
];

impl Fault {
    pub fn name(&self) -> &'static str {
        match self {
            Fault::Disconnect { .. } => "disconnect",
            Fault::Unreachable { .. } => "unreachable",
            Fault::Slow { .. } => "slow",
            Fault::KlippyShutdown { .. } => "klippy_shutdown",
            Fault::KlippyError { .. } => "klippy_error",
            Fault::Runout { .. } => "runout",
            Fault::UploadFail { .. } => "upload_fail",
            Fault::StartRefused { .. } => "start_refused",
            Fault::NoStartLocalPrint => "no_start_local_print",
            Fault::CameraOff => "camera_off",
            Fault::HeadPickFail => "head_pick_fail",
            Fault::PrintError { .. } => "print_error",
            Fault::DiskFull => "disk_full",
        }
    }

    /// `name key=value…`, as typed after `u1-sim fault <port>`.
    pub fn parse(name: &str, args: &[String]) -> Result<Fault, String> {
        let mut obj = serde_json::Map::new();
        obj.insert("fault".into(), name.into());
        for a in args {
            let (k, v) = a.split_once('=').ok_or_else(|| format!("expected key=value, got {a}"))?;
            let val = v.parse::<f64>().map(serde_json::Value::from).unwrap_or_else(|_| v.into());
            obj.insert(k.to_string(), val);
        }
        let mut v = serde_json::Value::Object(obj);
        // Integers where the fault wants them (`head`, `ms`).
        if let Some(o) = v.as_object_mut() {
            for k in ["head", "ms"] {
                if let Some(n) = o.get(k).and_then(|x| x.as_f64()) {
                    o.insert(k.into(), (n.max(0.0) as u64).into());
                }
            }
        }
        serde_json::from_value(v).map_err(|e| format!("{name}: {e} (faults: {})", NAMES.join(", ")))
    }
}

/// A fault the scenario gives a printer: at `after` real seconds, and
/// again every `every` seconds when set.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Scheduled {
    #[serde(flatten)]
    pub fault: Fault,
    #[serde(default)]
    pub after: f64,
    #[serde(default)]
    pub every: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn faults_read_from_the_command_line_and_json() {
        assert_eq!(Fault::parse("disconnect", &["secs=12".into()]).unwrap(), Fault::Disconnect { secs: 12.0 });
        assert_eq!(Fault::parse("runout", &["head=2".into()]).unwrap(), Fault::Runout { head: 2 });
        assert_eq!(Fault::parse("slow", &[]).unwrap(), Fault::Slow { ms: 3000 });
        assert_eq!(Fault::parse("camera_off", &[]).unwrap(), Fault::CameraOff);
        assert_eq!(
            Fault::parse("start_refused", &["message=Nozzle mismatch".into()]).unwrap(),
            Fault::StartRefused { message: Some("Nozzle mismatch".into()) }
        );
        assert!(Fault::parse("meteor", &[]).is_err());
        assert!(Fault::parse("slow", &["fast".into()]).is_err());
        for n in NAMES {
            assert_eq!(Fault::parse(n, &[]).unwrap().name(), n);
        }
        let s: Scheduled = serde_json::from_str(r#"{"fault":"disconnect","secs":20,"after":180,"every":300}"#).unwrap();
        assert_eq!((s.fault, s.after, s.every), (Fault::Disconnect { secs: 20.0 }, 180.0, Some(300.0)));
    }
}
