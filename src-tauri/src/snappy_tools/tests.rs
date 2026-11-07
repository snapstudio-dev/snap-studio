//! Tests of Snappy's tools.

use super::*;
#[allow(unused_imports)]
use super::{app::*, approval::*, bridge::*, common::*, create::*, explore::*, files::*, prepare::*, printers::*, queue::*, tasks::*};

mod first_wave {
    use super::*;

    /// The drawer's state is the app's: tests that set it take turns.
    static DRAWER: Mutex<()> = Mutex::new(());

    #[test]
    fn every_tool_is_declared_once() {
        let mut names: Vec<&str> = tools().iter().map(|t| t.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), tools().len());
        for t in tools() {
            let p = (t.params)();
            assert_eq!(p["type"], "object", "{}", t.name);
            for r in p["required"].as_array().into_iter().flatten() {
                assert!(p["properties"].get(r.as_str().unwrap()).is_some(), "{}: {r}", t.name);
            }
        }
    }

    #[test]
    fn only_writes_are_confirmed() {
        // The table goes domain by domain: compared without its order.
        let mut writes: Vec<&str> = tools().iter().filter(|t| t.access == Access::Write).map(|t| t.name).collect();
        writes.sort();
        let mut expected = vec![
            "task_cancel",
            "slice_set",
            "slice_run",
            "start_queued_print",
            "print_printer_file",
            "delete_printer_file",
            "send_slice",
            "delete_local_file",
            "printer_control",
            "print_control",
            "rename_printer_file",
            "download_printer_file",
            "queue_move",
            "queue_remove",
            "queue_edit",
            "create_send",
            "create_new",
            "favorite_add",
            "favorite_remove",
            "plate_edit",
            "plate_add",
            "settings_set",
            "app_action",
            "printer_manage",
            "bed_mesh_action",
            "maintenance",
            "print_history",
            "slice_save_profile",
            "preview_action",
            "local_file_ai",
            "create_manage",
            "explore_site",
            "camera_snapshot",
        ];
        expected.sort();
        assert_eq!(writes, expected);
        for t in tools() {
            assert_eq!(t.ask.is_some(), t.access == Access::Write, "{}: a card for writes only", t.name);
        }
    }

    /// Reads and Snappy's notes run without a card, even with the drawer
    /// closed; a write does not.
    #[test]
    fn reads_run_without_asking() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        for (name, args) in [("print_queue", json!({})), ("memory_read", json!({}))] {
            if let Err(e) = call(name, &args) {
                assert!(!e.to_string().contains("did not approve"), "{name}: {e}");
            }
        }
    }

    /// Anything that is not an explicit yes is a no: the drawer closed, a
    /// refusal, everything refused at once.
    #[test]
    fn approval_is_denied_by_default() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        assert!(!approve("delete_printer_file", "x"), "the drawer is closed: no");
        set_drawer(true);
        let waiting = |n: usize| {
            let end = std::time::Instant::now() + Duration::from_secs(5);
            while approvals().lock().unwrap().len() < n && std::time::Instant::now() < end {
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        let refused = std::thread::spawn(|| approve("delete_printer_file", "x"));
        waiting(1);
        let id = approvals().lock().unwrap().keys().next().cloned().unwrap();
        answer(&id, false);
        assert!(!refused.join().unwrap());
        let yes = std::thread::spawn(|| approve("delete_printer_file", "x"));
        waiting(1);
        let id = approvals().lock().unwrap().keys().next().cloned().unwrap();
        answer(&id, true);
        assert!(yes.join().unwrap(), "only an explicit yes passes");
        let closed = std::thread::spawn(|| approve("delete_printer_file", "x"));
        waiting(1);
        set_drawer(false);
        assert!(!closed.join().unwrap(), "closing the drawer refuses");
        assert!(approvals().lock().unwrap().is_empty());
    }

    /// A write waits for a yes: with the drawer closed it is refused, and
    /// nothing runs; bad arguments are refused before anyone is asked.
    #[test]
    fn a_refused_action_runs_nothing() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        let t = spawn_task("wait".into(), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(json!({}))
        });
        let id = t["task"].as_str().unwrap().to_string();
        let e = call("task_cancel", &json!({ "task": id })).unwrap_err();
        assert!(e.to_string().contains("did not approve"), "{e}");
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["state"], "running");
        assert!(call("task_cancel", &json!({ "task": "task-nope" })).unwrap_err().to_string().contains("unknown task"));
        task_cancel(&json!({ "task": id })).unwrap();
    }

    /// A question needs the conversation open; closing it leaves the
    /// question unanswered.
    #[test]
    fn questions_wait_for_the_user() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        assert!(call("ask_user", &json!({ "question": "PLA or PETG?" })).is_err());
        set_drawer(true);
        let asked = std::thread::spawn(|| call("ask_user", &json!({ "question": "PLA or PETG?", "options": ["PLA", "PETG"] })).unwrap());
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while questions().lock().unwrap().is_empty() && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        let id = questions().lock().unwrap().keys().next().cloned().unwrap();
        reply(&id, Some("PETG".into()));
        assert_eq!(asked.join().unwrap()["answer"], "PETG");
        let skipped = std::thread::spawn(|| call("ask_user", &json!({ "question": "Brim?" })).unwrap());
        while questions().lock().unwrap().is_empty() && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        set_drawer(false);
        assert!(skipped.join().unwrap()["answer"].is_null(), "closing leaves it unanswered");
    }

    #[test]
    fn a_send_needs_every_choice() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        // No printer of that name here: refused before anyone is asked.
        let e = call(
            "send_slice",
            &json!({ "printer": "Nope", "queue": false, "bed_leveling": true, "flow_calibration": false, "timelapse": false }),
        )
        .unwrap_err();
        assert!(e.to_string().contains("no printer named"), "{e}");
        let schema = send_params();
        assert_eq!(schema["required"].as_array().unwrap().len(), 5, "every option is asked");
    }

    /// What the card named runs, even if the source changed meanwhile.
    #[test]
    fn the_approved_file_is_the_one_used() {
        keep_resolved(json!({ "name": "benchy.stl", "path": "/folder-a/benchy.stl" }));
        let v = take_resolved().unwrap();
        assert_eq!(v["path"], "/folder-a/benchy.stl");
        assert!(take_resolved().is_none(), "used once");
    }

    #[test]
    fn tasks_are_followed_and_cancelled() {
        let t = spawn_task("wait".into(), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(json!({}))
        });
        let id = t["task"].as_str().unwrap().to_string();
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["state"], "running");
        assert_eq!(task_cancel(&json!({ "task": id })).unwrap()["state"], "cancelled");
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["state"], "cancelled");
        let done = spawn_task("quick".into(), async { Ok(json!({ "n": 1 })) });
        let id = done["task"].as_str().unwrap().to_string();
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while task_status(&json!({ "task": id })).unwrap()["state"] == "running" && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["result"]["n"], 1);
        assert!(task_status(&json!({ "task": "task-nope" })).is_err());
    }
}

mod actions {
    use super::*;

    /// Every action Snappy may take is one of Control's, worded for its
    /// card; the emergency stop and the firmware restart stay the user's.
    #[test]
    fn control_actions_are_worded_and_bounded() {
        let samples = [
            json!({ "kind": "home", "axes": "xyz" }),
            json!({ "kind": "jog", "axis": "x", "dist": 10.0 }),
            json!({ "kind": "tool", "n": 1 }),
            json!({ "kind": "nozzle_temp", "n": 0, "temp": 210.0 }),
            json!({ "kind": "bed_temp", "temp": 60.0 }),
            json!({ "kind": "heaters_off" }),
            json!({ "kind": "load", "n": 0 }),
            json!({ "kind": "unload", "n": 0 }),
            json!({ "kind": "extrude", "n": 0 }),
            json!({ "kind": "retract", "n": 0 }),
            json!({ "kind": "clean" }),
            json!({ "kind": "purge_position" }),
            json!({ "kind": "part_fan", "pct": 50.0 }),
            json!({ "kind": "chamber_fan", "pct": 50.0 }),
            json!({ "kind": "purifier", "on": true }),
            json!({ "kind": "light", "on": false }),
            json!({ "kind": "motors_off" }),
            json!({ "kind": "filament", "n": 2, "vendor": "Generic", "material": "PLA", "sub_type": "", "color": "#ff0000" }),
        ];
        assert_eq!(samples.len(), CONTROL_KINDS.len());
        for s in samples {
            assert!(CONTROL_KINDS.contains(&s["kind"].as_str().unwrap()));
            let a: crate::control::Action = serde_json::from_value(s.clone()).unwrap();
            assert!(!control_words(&a).is_empty(), "{s}");
        }
        for kind in ["emergency_stop", "firmware_restart"] {
            assert!(!CONTROL_KINDS.contains(&kind));
        }
        assert!(control_words(&crate::control::Action::NozzleTemp { n: 1, temp: 215.0 }).contains("T1"));
    }

    #[test]
    fn days_are_worded() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(1_762_387_200), "2025-11-06");
        assert_eq!(ymd(951_782_400), "2000-02-29");
    }
}
