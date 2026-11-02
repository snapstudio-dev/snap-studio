//! The bed's shape: a tilt, a bowl and a little noise, seeded per printer
//! and per measurement, so meshes differ between printers and runs.

/// The configured mesh (fixtures' `bed_mesh`): 13 × 13 points over the bed.
pub const MIN: [f64; 2] = [3.0, 3.0];
pub const MAX: [f64; 2] = [267.0, 267.0];
pub const COUNT: usize = 13;

/// A small deterministic generator (SplitMix64).
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }

    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [-1, 1).
    pub fn signed(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 52) as f64 - 1.0
    }
}

/// Heights (mm) of the mesh measured on printer `seed`'s `run`-th time:
/// the printer's own shape, the same each run, plus a run's small noise.
pub fn surface(seed: u64, run: u64) -> Vec<Vec<f64>> {
    let mut shape = Rng::new(seed);
    let (tx, ty) = (shape.signed() * 0.12, shape.signed() * 0.12);
    let bowl = shape.signed() * 0.10;
    let (wx, wy) = (shape.signed() * 0.03, shape.signed() * 0.03);
    let mut noise = Rng::new(seed.wrapping_mul(31).wrapping_add(run));
    (0..COUNT)
        .map(|j| {
            let v = j as f64 / (COUNT - 1) as f64 * 2.0 - 1.0;
            (0..COUNT)
                .map(|i| {
                    let u = i as f64 / (COUNT - 1) as f64 * 2.0 - 1.0;
                    let h = tx * u + ty * v + bowl * (u * u + v * v - 0.66) + wx * (3.0 * u).sin() + wy * (2.0 * v).cos();
                    ((h + noise.signed() * 0.008) * 10_000.0).round() / 10_000.0
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_printer_its_own_bed() {
        let a = surface(1, 0);
        assert_eq!((a.len(), a[0].len()), (COUNT, COUNT));
        assert!(a.iter().flatten().all(|h| h.abs() < 0.5));
        assert_eq!(a, surface(1, 0), "deterministic");
        assert_ne!(a, surface(1, 1), "another run differs a little");
        let close = a.iter().flatten().zip(surface(1, 1).iter().flatten()).all(|(x, y)| (x - y).abs() < 0.02);
        assert!(close, "but keeps the printer's shape");
        assert_ne!(a, surface(2, 0));
    }
}
