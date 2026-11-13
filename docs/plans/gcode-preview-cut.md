# Long prints: the G-code preview stops before the top

## The problem

On a long print (a statuette in 0.20 mm, 15 h 47), the sliced preview stops
part way up: the model is cut flat, and at the top of the layer slider the
time reads **11 h 42** while the total says **15 h 47**. The layer count
(609) is also too low, since it is counted on what is shown. It shows up on
prints of about ten hours or more, which are the ones with the most moves.

## Cause

`gcode::parse` (`src-tauri/src/gcode.rs`) keeps at most `MAX_SEGS`
(3 000 000) segments for the preview. Past that, the rest of the file is
read but its segments are dropped:

```rust
if segs.len() >= MAX_SEGS {
    truncated = true;
    continue;
}
```

What follows in the file is lost. A G-code is written layer by layer, so
those are the **top layers**:

- the preview shows the model up to the layer where the limit was reached,
  and stops there (the flat cut);
- `layers` is the highest layer among the **kept** segments (`gcode.rs`, after
  the loop), so the encoded preview, the slider and `stats().layers` (the
  "609 layers" in the panel) all stop at the same layer;
- the times keep being counted after the limit (`times.layer_end` is filled
  before the test), so the total is right, but the slider's last layer is
  the cut layer: its end time is 11 h 42, not 15 h 47.

Travel moves count in the budget too, though the preview hides them by
default (`showTravel: false`), and so do the start G-code's moves.

The only sign of the problem today is a "(truncated)" at the end of the
viewer's technical line (`viewer.truncated`, `#v-stats`), easy to miss.

## Proposal

The order: first make each segment much lighter so the preview holds the
whole file, as Snapmaker Orca does (it has no cap: every move is kept, in
65 536-vertex GPU buffers). Only then, as a last resort for extreme files,
simplify evenly instead of dropping the end.

### 1. Layers and times from the whole file

- Count `layers` during the read, over **every** move, not over the kept
  segments. `stats().layers`, the encoded header and the slider then give
  the file's real count (it can be checked against `; total layer number`,
  `meta.total_layers`, when the slicer writes it).
- The slider then goes to the last layer, and its time matches the total.
- `layerZ` (`ui/viewer.js`) is built from the segments: a layer with no
  kept segment takes the Z of the previous one today. With 2–5 below, every
  layer keeps segments, so this case goes away.

### 2. A much lighter segment

Today an extrusion segment costs about **58 bytes** in the viewer
(`decodeGcode`, `buildPathBuffers`), and as much again on the GPU:

| Data | Today | Proposed | How |
|---|---|---|---|
| Positions (start, end) | 24 B (6 × f32) | 12 B | 16-bit integers in the print's bounding box (`min`/`max` of the header), turned back into mm in the vertex shader. Step: about 4 µm on a 270 mm bed. |
| Color | 24 B (6 × f32) | 0 B | Computed in the shader from feature and tool, with a small palette in a uniform (12 features × 16 tools, `MATERIAL_SHADE` applied there). Changing the color mode becomes a uniform update instead of a buffer rebuild (`setColorMode`, `extrusionColors`). |
| Width, height | 8 B (2 × f32) | 2 B | Kept as the `u8` they already are in `gcode.rs`, read as integer attributes and scaled in the shader. |
| Feature, tool | 2 B | 2 B | Unchanged. |
| **Total** | **~58 B** | **~16 B** | about 3.5× less |

The encoded format (`gcode::encode`, the only producer; `decodeGcode`, the
only reader) moves to **version 4** with these fields; the viewer is the only
consumer, so no compatibility is kept with version 3.

### 3. Fewer copies on the way

Today the same segments exist at once in the `Vec<Seg>` (32 B each), the
encoded buffer, the `ArrayBuffer` received by the page, the split typed
arrays of `decodeGcode` and the GPU buffers.

- Rust: encode straight from the read (or free `segs` as soon as the buffer
  is written) instead of holding both. The other users of `parse`
  (`jobs.rs`, `thumbs.rs`, `sim/print.rs`, `slice.rs`) keep `segs` as today.
- Viewer: the buffer from Rust is laid out so that it is uploaded to the GPU
  as is (one view per attribute, no per-segment JavaScript loop), and the
  typed arrays are released after the upload; only `feat` and `tool` (2 B per
  segment) stay for the legend and the layer bounds.

### 4. Travel loaded on demand

Travel moves are hidden by default (`showTravel: false`) and are often 20 to
30 % of the segments. They are left out of the first load and fetched (a
second request on the G-code protocol, with a `travel` flag) the first time
travel is shown. They no longer count against the extrusions' budget.

### 5. Merge in-line tiny segments, always

A statuette's surface is made of many segments a fraction of a millimetre
long. Next to each other in the same layer, with the same feature, tool,
width and height, and within **0.01 mm** of a straight line, they are merged
into one segment (same start, last end). At that tolerance the difference is
invisible at any zoom the viewer allows, so it is on for every file, not only
over budget. It also shortens the read for the other users of `parse` that
only need the shape (thumbnails).

The times are not affected: they are accumulated per move before the merge.

### 6. A higher cap, and even simplification as the last resort

With 2–5, the same memory holds about 3.5 times more segments and fewer are
produced. `MAX_SEGS` goes from 3 M to about **10 M** extrusion segments
(about 160 MB in the viewer and as much on the GPU, below today's 3 M at
~58 B). In practice no realistic file should reach it.

If a file still goes over it, the end is **never** dropped: the file is read
again with a larger merge tolerance (the size of the file and the count of
the first read give the right one), so the whole height is shown with less
detail on the curves.

### 7. Say it discreetly when the preview is simplified

Only in the last-resort case of 6. The model is never cut, so no note under
the slider (decided):

- `truncated` becomes `simplified` in the meaning (the header bit keeps its
  place).
- The viewer's technical line (`#v-stats`) says "simplified" instead of
  "(truncated)", with a tooltip: the layers, times and filament are exact,
  only the curves have less detail.

## Where it is used

`gcode::parse` serves the viewer (`lib.rs`, G-code protocol), Prepare after
slicing (`slice.rs`), the Prints tab and the job's layer times (`jobs.rs`,
`ui/prints.js`), the printer simulator (`sim/print.rs`) and thumbnails
(`thumbs.rs`); `gcode::encode` and `decodeGcode` only the viewer. Points 1,
5 and 6 fix them all at once: today a long job's layer times and layer count
are wrong in the Prints tab too. Points 2–4 concern the viewer only.

## Texts

`viewer.truncated` is replaced, in the 9 languages, by:

- `viewer.simplified`: "simplified"
- `viewer.simplified_tip`: "Very long print: all layers are shown with
  less detail. Layers, times and filament are exact."

## Steps

One PR with all of it (decided): the fix (1, 5, 6) and the lighter viewer
(2, 3, 4), with memory measured before and after on the same file.

## Tests

- Rust (`gcode.rs`): a generated G-code with many tiny segments over many
  layers:
  - `layers` equals the number of layers in the file;
  - the last layer's segments are in the preview (its Z is the top);
  - `layer_end_s.last()` equals the total time;
  - merged paths stay within 0.01 mm of the original points; a corner is
    never merged; different feature, tool, width or height never merge;
  - over the cap, the second pass keeps every layer and sets `simplified`.
- Format v4: `encode` then a decode in Rust gives back positions within the
  quantization step, and the same feature, tool, width, height.
- Viewer (`ui` logic tests): decode of a v4 buffer, palette lookup per color
  mode, layer bounds.
- By hand, on the statuette from the report (15 h 47 in 0.20 mm): the model
  is whole, the slider ends at the real layer count at about 15 h 47; showing travel loads it; color modes switch instantly; memory of the
  app (system monitor) before and after on the same file. A small print
  shows the same preview as today.

## Decisions

1. **Note**: no note under the slider, since the model is never cut; only
   the discreet "simplified" mark in the technical line.
2. **Delivery**: one PR for the fix and the lighter viewer.
3. **Last resort**: past the largest tolerance, one segment in two is kept
   on a single rhythm over the file. A file alternating strictly between
   two path types could lose one of them in that mode; no real G-code does
   that, so it stays as is.
4. **Thumbnails**: rendered from at most 2 M segments, as a folder scan
   gains nothing from the preview's 10 M.
5. **Prime tower**: its box (Prepare, print card) comes from its points
   gathered during the read, whatever segments are kept.

## CHANGELOG

At implementation, under *Unreleased › Fixed*: "**Preview**: on long prints
the sliced preview no longer stops part way up; all layers are shown, with
the right layer count and time on the slider. The preview uses about three
times less memory, and travel moves load only when shown."
