//! The simulators' clock, in real seconds since the start: the wall clock,
//! or a virtual one the tests move by hand (deterministic, no sleeps). Each
//! printer turns real seconds into simulated ones with its time factor.

use std::sync::Mutex;
use std::time::Instant;

pub enum Clock {
    Real(Instant),
    Manual(Mutex<f64>),
}

impl Clock {
    pub fn real() -> Self {
        Clock::Real(Instant::now())
    }

    pub fn manual() -> Self {
        Clock::Manual(Mutex::new(0.0))
    }

    pub fn now(&self) -> f64 {
        match self {
            Clock::Real(t0) => t0.elapsed().as_secs_f64(),
            Clock::Manual(t) => *t.lock().unwrap_or_else(|e| e.into_inner()),
        }
    }

    /// Moves a manual clock on; the wall clock moves by itself.
    pub fn advance(&self, secs: f64) {
        if let Clock::Manual(t) = self {
            *t.lock().unwrap_or_else(|e| e.into_inner()) += secs.max(0.0);
        }
    }

    pub fn is_manual(&self) -> bool {
        matches!(self, Clock::Manual(_))
    }
}

/// The time factors offered (decision 6).
pub const FACTORS: [f64; 4] = [1.0, 10.0, 60.0, 600.0];

/// A print never lasts less than this in real time, whatever the factor:
/// the app's queue monitor polls every 8 s and leaves a print alone for
/// 90 s after its launch (`jobs.rs`), it must see it running, then ending.
pub const MIN_PRINT_REAL_S: f64 = 120.0;

/// A factor among the ones offered (the nearest below, ×1 at least).
pub fn factor(f: f64) -> f64 {
    FACTORS.iter().copied().filter(|x| *x <= f).fold(1.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_clock_moves_by_hand_only() {
        let c = Clock::manual();
        assert_eq!(c.now(), 0.0);
        c.advance(12.5);
        c.advance(-3.0);
        assert_eq!(c.now(), 12.5);
        assert!(c.is_manual() && !Clock::real().is_manual());
        assert_eq!((factor(0.5), factor(10.0), factor(59.0), factor(1e6)), (1.0, 10.0, 10.0, 600.0));
    }
}
