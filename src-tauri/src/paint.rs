//! Multicolor painting of a triangle, as Bambu Studio and Orca store it.
//!
//! The `paint_color` attribute (PrusaSlicer: `slic3rpe:mmu_segmentation`)
//! holds a small tree per triangle, written by Orca's `TriangleSelector`:
//! a hex string read from its **last** character to its first, one nibble
//! per character, depth-first.
//!
//! - `code & 0b11` is the number of split sides: 0 is a leaf, otherwise the
//!   node has `sides + 1` children, which follow.
//! - A leaf's state is `code >> 2` below 3; `0b1100` means "3 or more", the
//!   next nibbles giving `state - 3`, each `0b1111` adding 15.
//! - State 0 is the volume's own extruder, state `n` is filament `n`.
//!
//! How a triangle is split depends on its vertex order: the tree only means
//! something on the triangle it was painted on.

#[derive(Clone, Copy, Debug, PartialEq)]
enum Node {
    /// The split code as read: split sides and special side.
    Split(u8),
    Leaf(u8),
}

fn nibbles(s: &str) -> Option<Vec<u8>> {
    s.chars().rev().map(|c| c.to_digit(16).map(|d| d as u8)).collect()
}

fn read(nibs: &[u8], i: &mut usize, out: &mut Vec<Node>, depth: u32) -> Option<()> {
    // Far deeper than a fine brush on a large triangle goes; a corrupt
    // string must not recurse forever.
    if depth > 64 {
        return None;
    }
    let code = *nibs.get(*i)?;
    *i += 1;
    let sides = code & 0b11;
    if sides > 0 {
        out.push(Node::Split(code));
        for _ in 0..=sides {
            read(nibs, i, out, depth + 1)?;
        }
    } else if code & 0b1100 == 0b1100 {
        let mut state = 3u32;
        loop {
            let next = *nibs.get(*i)?;
            *i += 1;
            state += next as u32;
            if next != 0b1111 {
                break;
            }
        }
        out.push(Node::Leaf(state.min(u8::MAX as u32) as u8));
    } else {
        out.push(Node::Leaf(code >> 2));
    }
    Some(())
}

fn decode(s: &str) -> Option<Vec<Node>> {
    let nibs = nibbles(s.trim())?;
    let mut out = Vec::new();
    read(&nibs, &mut 0, &mut out, 0)?;
    Some(out)
}

fn encode(nodes: &[Node]) -> String {
    let mut nibs: Vec<u8> = Vec::with_capacity(nodes.len() + 2);
    for n in nodes {
        match *n {
            Node::Split(code) => nibs.push(code),
            Node::Leaf(s) if s < 3 => nibs.push(s << 2),
            Node::Leaf(s) => {
                nibs.push(0b1100);
                let mut rest = s as u32 - 3;
                while rest >= 15 {
                    nibs.push(0b1111);
                    rest -= 15;
                }
                nibs.push(rest as u8);
            }
        }
    }
    nibs.iter().rev().map(|n| char::from_digit(*n as u32, 16).unwrap().to_ascii_uppercase()).collect()
}

/// Weight of each leaf: a child is worth `1 / children` of its parent.
fn weights(nodes: &[Node]) -> Vec<(u8, f32)> {
    fn walk(nodes: &[Node], i: &mut usize, w: f32, out: &mut Vec<(u8, f32)>) {
        let Some(n) = nodes.get(*i) else { return };
        *i += 1;
        match *n {
            Node::Leaf(s) => out.push((s, w)),
            Node::Split(code) => {
                let children = (code & 0b11) + 1;
                for _ in 0..children {
                    walk(nodes, i, w / children as f32, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(nodes, &mut 0, 1.0, &mut out);
    out
}

/// Every state the painting uses, 0 included, sorted.
pub fn states(s: &str) -> Vec<u8> {
    let mut v: Vec<u8> = decode(s)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|n| match n {
            Node::Leaf(s) => Some(s),
            Node::Split(_) => None,
        })
        .collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// The state covering most of the triangle; `None` for an unreadable string.
pub fn dominant(s: &str) -> Option<u8> {
    let mut acc: Vec<(u8, f32)> = Vec::new();
    for (state, w) in weights(&decode(s)?) {
        match acc.iter_mut().find(|(s, _)| *s == state) {
            Some(e) => e.1 += w,
            None => acc.push((state, w)),
        }
    }
    acc.into_iter().max_by(|a, b| a.1.total_cmp(&b.1).then(b.0.cmp(&a.0))).map(|(s, _)| s)
}

/// True when the triangle is split into differently painted pieces.
pub fn is_split(s: &str) -> bool {
    decode(s).is_some_and(|n| n.len() > 1)
}

/// The same painting with each state replaced; `None` for an unreadable
/// string.
pub fn renumber(s: &str, f: impl Fn(u8) -> u8) -> Option<String> {
    let nodes: Vec<Node> = decode(s)?
        .into_iter()
        .map(|n| match n {
            Node::Leaf(s) => Node::Leaf(f(s)),
            split => split,
        })
        .collect();
    Some(encode(&nodes))
}

/// The painting of a triangle whose vertices are about to be reordered:
/// unchanged when whole, otherwise its dominant state over the whole
/// triangle — the pieces of a split follow the vertex order. `None` for an
/// unreadable string.
pub fn reordered(s: &str) -> Option<String> {
    if is_split(s) {
        dominant(s).map(whole)
    } else {
        decode(s).map(|n| encode(&n))
    }
}

/// A whole triangle painted with one state.
pub fn whole(state: u8) -> String {
    encode(&[Node::Leaf(state)])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The strings of a real Bambu Studio file (MakerWorld's dumpling):
    /// filaments 2, 3, 4 and 5 painted on whole triangles.
    #[test]
    fn whole_triangles_from_bambu() {
        assert_eq!(states("8"), vec![2]);
        assert_eq!(states("0C"), vec![3]);
        assert_eq!(states("1C"), vec![4]);
        assert_eq!(states("2C"), vec![5]);
        assert_eq!(dominant("2C"), Some(5));
        assert!(!is_split("2C"));
        assert_eq!(whole(5), "2C");
        assert_eq!(whole(2), "8");
        assert_eq!(whole(0), "0");
    }

    #[test]
    fn high_states_chain_fifteens() {
        // 18 = 3 + 15: "3 or more", then 15, then 0.
        let s = whole(18);
        assert_eq!(s, "0FC");
        assert_eq!(states(&s), vec![18]);
        assert_eq!(states(&whole(40)), vec![40]);
    }

    #[test]
    fn split_triangle() {
        // Three split sides: four children, 1 1 2 and 7.
        let nodes = [Node::Split(0b11), Node::Leaf(1), Node::Leaf(1), Node::Leaf(2), Node::Leaf(7)];
        let s = encode(&nodes);
        assert_eq!(decode(&s).unwrap(), nodes);
        assert!(is_split(&s));
        assert_eq!(states(&s), vec![1, 2, 7]);
        assert_eq!(dominant(&s), Some(1));
        // A deeper level weighs less: 3 covers 1/2, 4 and 5 a quarter each.
        let deep = encode(&[Node::Split(0b01), Node::Leaf(3), Node::Split(0b01), Node::Leaf(4), Node::Leaf(5)]);
        assert_eq!(dominant(&deep), Some(3));
        assert_eq!(states(&deep), vec![3, 4, 5]);
    }

    #[test]
    fn renumbering_keeps_the_tree() {
        let nodes = [Node::Split(0b0110), Node::Leaf(0), Node::Leaf(5), Node::Leaf(2)];
        let s = encode(&nodes);
        let r = renumber(&s, |st| if st == 0 { 0 } else { st + 10 }).unwrap();
        assert_eq!(decode(&r).unwrap(), vec![Node::Split(0b0110), Node::Leaf(0), Node::Leaf(15), Node::Leaf(12)]);
        assert_eq!(renumber("2C", |_| 1).unwrap(), "4");
    }

    #[test]
    fn reordering_flattens_splits_only() {
        assert_eq!(reordered("2C").as_deref(), Some("2C"));
        let split = encode(&[Node::Split(0b11), Node::Leaf(1), Node::Leaf(1), Node::Leaf(2), Node::Leaf(7)]);
        assert_eq!(reordered(&split), Some(whole(1)));
        assert_eq!(reordered("zz"), None);
    }

    #[test]
    fn garbage_is_rejected() {
        assert_eq!(dominant("zz"), None);
        assert_eq!(states(""), Vec::<u8>::new());
        // A split announcing children that are not there.
        assert_eq!(dominant("3"), None);
        assert_eq!(renumber("C", |s| s), None);
    }
}
