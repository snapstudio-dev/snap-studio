//! Snappy against the real Claude Code, one family of tools at a time: the
//! app's MCP server, its cards and questions, the page's side, the printers
//! (simulated). A test plays the interface's part: it answers the cards,
//! the questions and the page's calls. They cost a few cents each (Haiku):
//!
//! `SNAPPY_REAL=1 XDG_CONFIG_HOME=<a folder Claude already trusts> \
//!  cargo test --lib --features sim real_tools -- --ignored --test-threads=1 --nocapture`
//!
//! The printers' test needs the `sim` feature (simulated U1s on this
//! computer, the app's data in a test folder); the others run without it.

use super::*;
use std::time::Instant;

/// One Snappy at a time: they share its conversation.
static ONE: Mutex<()> = Mutex::new(());

const HAIKU: &str = "claude-haiku-4-5-20251001";

fn real() -> bool {
    std::env::var("SNAPPY_REAL").is_ok()
}

/// A new conversation, on Haiku, its card open, no memory.
fn fresh() {
    crate::snappy::set_enabled(true);
    crate::snappy::reset().unwrap();
    crate::snappy::set_model(Some(HAIKU)).unwrap();
    let _ = crate::snappy::clear_memory();
    set_drawer(true);
    emitted().lock().unwrap().clear();
}

/// What one message led to.
#[derive(Debug, Default)]
struct Turn {
    tools: Vec<String>,
    said: String,
    /// The cards shown, in order.
    cards: Vec<String>,
    /// The page's calls: (method, args).
    page: Vec<(String, Value)>,
    /// The tools' results as Claude got them.
    results: String,
}

/// The interface's part for one message.
struct Ui<'a> {
    card: &'a dyn Fn(&str) -> bool,
    question: &'a dyn Fn(&str, &[String]) -> Option<String>,
    page: &'a dyn Fn(&str, &Value) -> Value,
}

const REFUSE: Ui<'static> = Ui { card: &|_| false, question: &|_, _| None, page: &|_, _| json!({ "error": "not in this test" }) };

/// Sends `text`, plays the interface until the answer ends, and says what
/// happened.
fn say(text: &str, ui: &Ui) -> Turn {
    let before = crate::snappy::history().len();
    crate::snappy::send(text, &json!({}), &[]).unwrap();
    let mut t = Turn::default();
    let mut seen = emitted().lock().unwrap().len();
    let end = Instant::now() + Duration::from_secs(180);
    loop {
        let fresh: Vec<(String, Value)> = emitted().lock().unwrap()[seen..].to_vec();
        seen += fresh.len();
        for (ev, p) in fresh {
            let id = p["id"].as_str().unwrap_or_default().to_string();
            match ev.as_str() {
                "snappy-approval" => {
                    let text = p["text"].as_str().unwrap_or_default().to_string();
                    t.cards.push(text.clone());
                    answer(&id, (ui.card)(&text));
                }
                "snappy-question" => {
                    let opts: Vec<String> =
                        p["options"].as_array().into_iter().flatten().filter_map(|o| o.as_str().map(String::from)).collect();
                    reply(&id, (ui.question)(p["question"].as_str().unwrap_or_default(), &opts));
                }
                "snappy-ui" => {
                    let method = p["method"].as_str().unwrap_or_default().to_string();
                    t.page.push((method.clone(), p["args"].clone()));
                    ui_reply(&id, (ui.page)(&method, &p["args"]));
                }
                _ => {}
            }
        }
        let h = crate::snappy::history();
        if h[before..].iter().any(|e| e["type"] == "result") || Instant::now() > end {
            for e in &h[before..] {
                for b in e["message"]["content"].as_array().into_iter().flatten() {
                    if let Some(n) = b["name"].as_str() {
                        t.tools.push(n.trim_start_matches("mcp__snap-studio__").to_string());
                    }
                    if e["type"] == "assistant" {
                        if let Some(s) = b["text"].as_str() {
                            t.said.push_str(s);
                        }
                    }
                    if b["type"] == "tool_result" {
                        t.results.push_str(&b["content"].to_string());
                    }
                }
            }
            println!("{text}\n  → tools {:?}\n  → cards {:?}\n  → said {}", t.tools, t.cards, t.said);
            return t;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn done() {
    crate::snappy_tools::refuse_all();
    crate::claude_pty::close(crate::snappy::KEY);
}

/// The page's side: the Files view read, a setting changed through its card.
#[test]
#[ignore]
fn real_tools_page_side() {
    if !real() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    fresh();
    let page = |m: &str, a: &Value| match m {
        "local_files" => json!({ "files": ["benchy.stl", "bracket.3mf"], "total": 2 }),
        "settings_list" => {
            json!({ "settings": [{ "key": "theme", "label": "Theme", "value": "light", "choices": ["light", "dark", "auto"] }] })
        }
        "settings_set_check" => json!({ "card": format!("Set Theme to {}", a["value"].as_str().unwrap_or("?")) }),
        "settings_set" => json!({ "applied": true }),
        _ => json!({ "error": "not in this test" }),
    };
    let ui = Ui { card: &|_| true, question: &|_, _| None, page: &page };
    let t = say("Which files are in my Files view? Just list their names.", &ui);
    assert!(t.tools.iter().any(|n| n == "local_files"), "{t:?}");
    assert!(t.said.contains("benchy"), "{t:?}");
    assert!(t.cards.is_empty(), "a read asks nothing");

    let t = say("Switch the app's theme to dark.", &ui);
    assert!(t.tools.iter().any(|n| n == "settings_set"), "{t:?}");
    assert_eq!(t.cards, ["Set Theme to dark"], "a write asks first");
    let set = t.page.iter().find(|(m, _)| m == "settings_set").expect("applied by the page");
    assert_eq!(set.1["value"], "dark");
    done();
}

/// A refused write changes nothing, and Snappy says so.
#[test]
#[ignore]
fn real_tools_refusal() {
    if !real() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    fresh();
    let page = |m: &str, a: &Value| match m {
        "settings_list" => {
            json!({ "settings": [{ "key": "theme", "label": "Theme", "value": "light", "choices": ["light", "dark", "auto"] }] })
        }
        "settings_set_check" => json!({ "card": format!("Set Theme to {}", a["value"].as_str().unwrap_or("?")) }),
        _ => json!({ "error": "not in this test" }),
    };
    let ui = Ui { page: &page, ..REFUSE };
    let t = say("Switch the app's theme to dark, then tell me in one sentence whether it worked.", &ui);
    assert_eq!(t.cards.len(), 1, "{t:?}");
    assert!(!t.page.iter().any(|(m, _)| m == "settings_set"), "refused: never applied");
    assert!(t.results.contains("did not approve"), "{t:?}");
    done();
}

/// Snappy asks instead of guessing, and uses the answer.
#[test]
#[ignore]
fn real_tools_question() {
    if !real() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    fresh();
    let asked = Mutex::new(Vec::<(String, Vec<String>)>::new());
    let question = |q: &str, o: &[String]| {
        asked.lock().unwrap().push((q.to_string(), o.to_vec()));
        Some("PETG".to_string())
    };
    let ui = Ui { question: &question, ..REFUSE };
    let t = say("Use ask_user to ask me which material I prefer, PLA or PETG. Then say only my answer.", &ui);
    assert!(t.tools.iter().any(|n| n == "ask_user"), "{t:?}");
    assert_eq!(asked.lock().unwrap().len(), 1);
    assert!(t.said.contains("PETG"), "{t:?}");
    done();
}

/// What Snappy is asked to remember lands in its memory.
#[test]
#[ignore]
fn real_tools_memory() {
    if !real() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    fresh();
    let t = say("Remember for our next conversations that my printers sit in the garage.", &REFUSE);
    assert!(t.tools.iter().any(|n| n == "memory_write"), "{t:?}");
    assert!(t.cards.is_empty(), "its own memory asks nothing");
    assert!(crate::snappy::memory_raw().to_lowercase().contains("garage"), "{}", crate::snappy::memory_raw());
    let _ = crate::snappy::clear_memory();
    done();
}

/// The printers, simulated (the farm: Bravo printing, Charlie paused on a
/// runout): read by name (never their address), a print paused once the
/// user says yes, a cancel refused leaving the print as it was.
#[cfg(feature = "sim")]
#[test]
#[ignore]
fn real_tools_printers() {
    if !real() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let _ = crate::sim::tests::data_dir();
    let sim = crate::sim::tests::start("farm");
    let list: Vec<crate::printers::Printer> = (0..sim.farm.printers.len()).map(|i| sim.printer(i)).collect();
    crate::printers::save(&list).unwrap();
    fresh();
    let t = say("Which printers do I have, and which ones are printing? Answer in one short line per printer.", &REFUSE);
    assert!(t.tools.iter().any(|n| n == "printers"), "{t:?}");
    assert!(t.said.contains("Bravo") && t.said.contains("Charlie"), "{t:?}");
    assert!(!t.results.contains("127.0.0.1"), "no address reaches the model");

    let yes = Ui { card: &|_| true, ..REFUSE };
    let t = say("Pause the print on Sim U1 Bravo.", &yes);
    assert!(t.tools.iter().any(|n| n == "print_control"), "{t:?}");
    assert_eq!(t.cards.len(), 1, "{t:?}");
    let state = |i: usize| sim.run(crate::printers::status("127.0.0.1", sim.port(i))).state;
    let end = Instant::now() + Duration::from_secs(10);
    while state(1) != "paused" && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(200));
    }
    assert_eq!(state(1), "paused", "Bravo paused");

    // Charlie's print is paused in the farm (a filament runout): refused,
    // its cancel leaves it as it was.
    let charlie = state(2);
    assert_ne!(charlie, "cancelled");
    let t = say("Cancel the print on Sim U1 Charlie.", &REFUSE);
    assert_eq!(t.cards.len(), 1, "{t:?}");
    assert!(t.results.contains("did not approve"), "{t:?}");
    assert_eq!(state(2), charlie, "Charlie as it was: the user said no");
    done();
}
