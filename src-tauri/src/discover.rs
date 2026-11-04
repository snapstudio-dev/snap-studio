//! Printer discovery on the local network (mDNS / Bonjour).
//!
//! Same method as Snapmaker Orca (`SSWCP.cpp`): each U1 announces itself as
//! `_snapmaker._tcp.local`, with a TXT record (`sn`, `device_name`,
//! `machine_type`, `version`, `ip`…). A wake-up query for
//! `_services._dns-sd._udp` goes first: some Wi-Fi routers only relay
//! multicast after seeing some go by. Other Klipper machines announcing
//! themselves (`_moonraker._tcp`) are searched at the same time.
//!
//! Each resolved printer goes straight to the UI (`printer-found`); the end of
//! the search is signaled by `printer-discover-done`.

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const WAKEUP: &str = "_services._dns-sd._udp.local.";
const SERVICES: &[(&str, &str)] = &[("_snapmaker._tcp.local.", "snapmaker"), ("_moonraker._tcp.local.", "moonraker")];
/// Listening time, as in Orca.
const LISTEN: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Found {
    /// Serial number (U1), otherwise absent.
    pub sn: Option<String>,
    pub name: String,
    pub model: Option<String>,
    pub ip: String,
    /// Announced port: the service's, not necessarily Moonraker's.
    pub port: u16,
    pub firmware: Option<String>,
    /// "snapmaker" or "moonraker".
    pub service: String,
}

/// Search in progress: a flag to stop it.
#[derive(Default)]
pub struct Discovery(Mutex<Option<Arc<AtomicBool>>>);

impl Discovery {
    fn stop(&self) {
        if let Some(flag) = self.0.lock().unwrap().take() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Starts a search; a previous search is stopped. `search` is the number
/// the UI gave this search: every event carries it, so that a stopped
/// search still winding down (it answers its stop flag within 100 ms, and
/// may resolve a printer meanwhile) is told from the one that replaced it.
#[tauri::command]
pub fn printer_discover_start(app: AppHandle, state: State<'_, Discovery>, search: u64) -> Result<(), String> {
    state.stop();
    // Simulation: the simulated printers, and nothing is asked of the network.
    #[cfg(feature = "sim")]
    if let Some(found) = crate::sim::discovered() {
        std::thread::spawn(move || {
            for f in found {
                std::thread::sleep(Duration::from_millis(400));
                let _ = app.emit("printer-found", serde_json::json!({ "search": search, "printer": f }));
            }
            let _ = app.emit("printer-discover-done", serde_json::json!({ "search": search }));
        });
        return Ok(());
    }
    let daemon = ServiceDaemon::new().map_err(|e| crate::t!("err.discovery", err = e))?;
    let stop = Arc::new(AtomicBool::new(false));
    *state.0.lock().unwrap() = Some(stop.clone());
    std::thread::spawn(move || {
        run(&daemon, &stop, |f| {
            log(&format!("{} — {} ({}, {})", f.service, f.name, f.ip, f.sn.as_deref().unwrap_or("no serial number")));
            let _ = app.emit("printer-found", serde_json::json!({ "search": search, "printer": f }));
        });
        let _ = daemon.shutdown();
        let _ = app.emit("printer-discover-done", serde_json::json!({ "search": search }));
    });
    Ok(())
}

#[tauri::command]
pub fn printer_discover_stop(state: State<'_, Discovery>) {
    state.stop();
}

/// Listens until the timeout or a stop request.
fn run(daemon: &ServiceDaemon, stop: &AtomicBool, mut on_found: impl FnMut(Found)) {
    // The answer to the wake-up does not interest us: only the traffic it
    // triggers matters. It must still be read: the daemon waits on a full
    // listener (10 events), and a home network answers with dozens of service
    // types — the search froze before the printers had answered.
    let wake = daemon.browse(WAKEUP).ok();
    let receivers: Vec<_> = SERVICES
        .iter()
        .filter_map(|(ty, kind)| match daemon.browse(ty) {
            Ok(rx) => Some((rx, *kind)),
            Err(e) => {
                log(&format!("{ty} : {e}"));
                None
            }
        })
        .collect();
    let end = Instant::now() + LISTEN;
    while Instant::now() < end && !stop.load(Ordering::Relaxed) {
        let mut idle = true;
        if let Some(rx) = &wake {
            while rx.try_recv().is_ok() {}
        }
        for (rx, kind) in &receivers {
            while let Ok(ev) = rx.try_recv() {
                idle = false;
                if let ServiceEvent::ServiceResolved(s) = ev {
                    let txt = |k: &str| s.txt_properties.get_property_val_str(k).map(str::trim).filter(|v| !v.is_empty()).map(String::from);
                    let ips: Vec<_> = s.get_addresses_v4().into_iter().collect();
                    if let Some(f) = found(kind, &s.fullname, &s.host, s.port, &ips, txt) {
                        on_found(f);
                    }
                }
            }
        }
        if idle {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = daemon.stop_browse(WAKEUP);
    for (ty, _) in SERVICES {
        let _ = daemon.stop_browse(ty);
    }
}

/// A printer's record from an mDNS response; IPv4 only.
fn found(
    kind: &str,
    fullname: &str,
    host: &str,
    port: u16,
    ips: &[std::net::Ipv4Addr],
    txt: impl Fn(&str) -> Option<String>,
) -> Option<Found> {
    // The address announced in the TXT record comes before the record's own:
    // it is the one the printer says it uses.
    let ip = txt("ip").filter(|v| v.parse::<std::net::Ipv4Addr>().is_ok()).or_else(|| {
        let mut v: Vec<_> = ips.iter().filter(|a| !a.is_loopback() && !a.is_link_local()).collect();
        v.sort();
        v.first().map(|a| a.to_string())
    })?;
    let instance = fullname.split("._").next().unwrap_or("").trim();
    let hostname = host.trim_end_matches('.').trim_end_matches(".local");
    let name = txt("device_name")
        .or_else(|| (!instance.is_empty()).then(|| instance.to_string()))
        .or_else(|| (!hostname.is_empty()).then(|| hostname.to_string()))
        .unwrap_or_else(|| ip.clone());
    Some(Found { sn: txt("sn"), name, model: txt("machine_type"), ip, port, firmware: txt("version"), service: kind.to_string() })
}

fn log(msg: &str) {
    eprintln!("[discover] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::Ipv4Addr;

    fn txt(map: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = map.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn u1_from_txt_record() {
        let f = found(
            "snapmaker",
            "U1-4F2A._snapmaker._tcp.local.",
            "u1-4f2a.local.",
            8883,
            &[Ipv4Addr::new(192, 168, 1, 50)],
            txt(&[("sn", "SN123"), ("device_name", "Atelier"), ("machine_type", "Snapmaker U1"), ("version", "1.3.0")]),
        )
        .unwrap();
        assert_eq!(f.name, "Atelier");
        assert_eq!(f.ip, "192.168.1.50");
        assert_eq!(f.sn.as_deref(), Some("SN123"));
        assert_eq!(f.model.as_deref(), Some("Snapmaker U1"));
        assert_eq!(f.firmware.as_deref(), Some("1.3.0"));
    }

    #[test]
    fn falls_back_to_instance_and_skips_link_local() {
        let f = found(
            "moonraker",
            "voron._moonraker._tcp.local.",
            "voron.local.",
            7125,
            &[Ipv4Addr::new(169, 254, 3, 4), Ipv4Addr::new(10, 0, 0, 9)],
            txt(&[]),
        )
        .unwrap();
        assert_eq!(f.name, "voron");
        assert_eq!(f.ip, "10.0.0.9");
        assert_eq!(f.sn, None);
    }

    #[test]
    fn no_ipv4_no_printer() {
        assert!(found("snapmaker", "x._snapmaker._tcp.local.", "x.local.", 1, &[], txt(&[])).is_none());
    }

    /// End to end on the machine: a fake U1 announces itself, the search must
    /// find it. Depends on the network (multicast): run by hand.
    #[test]
    #[ignore]
    fn finds_an_announced_u1() {
        use mdns_sd::ServiceInfo;
        let host = ServiceDaemon::new().unwrap();
        let ip = local_ip();
        let info = ServiceInfo::new(
            "_snapmaker._tcp.local.",
            "U1-TEST",
            "u1-test.local.",
            ip.as_str(),
            8883,
            &[("sn", "SNTEST"), ("device_name", "Test U1"), ("machine_type", "Snapmaker U1")][..],
        )
        .unwrap();
        host.register(info).unwrap();

        let daemon = ServiceDaemon::new().unwrap();
        let stop = AtomicBool::new(false);
        let mut hits = Vec::new();
        let t = std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_secs(6));
                stop.store(true, Ordering::Relaxed);
            });
            run(&daemon, &stop, |f| hits.push(f));
        });
        let _ = t;
        println!("{hits:?}");
        assert!(hits.iter().any(|f| f.sn.as_deref() == Some("SNTEST") && f.name == "Test U1"));
    }

    /// The wake-up answers must not freeze the search: more service types
    /// than a listener holds (10) announce themselves first, the U1 two
    /// seconds later, as on a home network. Depends on the network: run by
    /// hand.
    #[test]
    #[ignore]
    fn busy_network_does_not_freeze_the_search() {
        use mdns_sd::ServiceInfo;
        let host = ServiceDaemon::new().unwrap();
        let ip = local_ip();
        for i in 0..15 {
            let ty = format!("_busy{i}._tcp.local.");
            let info = ServiceInfo::new(&ty, "busy", "busy-test.local.", ip.as_str(), 9000 + i, None::<HashMap<String, String>>).unwrap();
            host.register(info).unwrap();
        }

        let daemon = ServiceDaemon::new().unwrap();
        let stop = AtomicBool::new(false);
        let mut hits = Vec::new();
        std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_secs(2));
                let info =
                    ServiceInfo::new("_snapmaker._tcp.local.", "U1-BUSY", "u1-busy.local.", ip.as_str(), 8883, &[("sn", "SNBUSY")][..])
                        .unwrap();
                host.register(info).unwrap();
                std::thread::sleep(Duration::from_secs(6));
                stop.store(true, Ordering::Relaxed);
            });
            run(&daemon, &stop, |f| hits.push(f));
        });
        assert!(hits.iter().any(|f| f.sn.as_deref() == Some("SNBUSY")), "{hits:?}");
    }

    fn local_ip() -> String {
        let s = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        s.connect("192.0.2.1:9").unwrap();
        s.local_addr().unwrap().ip().to_string()
    }
}
