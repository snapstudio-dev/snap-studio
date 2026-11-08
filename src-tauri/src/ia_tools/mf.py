"""3MF files of this workspace: one object made of parts, each part a mesh
with its color and the print head (extruder) that prints it.

    import sys; sys.path.insert(0, "tools")
    import mf

    parts = mf.read("out/current.3mf")          # [Part(name, color, extruder, mesh)]
    body = parts[0].mesh                         # a trimesh.Trimesh, in millimeters
    mf.write("result.3mf", [mf.Part(body, "body", "#E8E8E8", 1),
                            mf.Part(eyes, "eyes", "#101010", 2)])

The layout written is the one Snap Studio and Orca use for a multicolor
model (the app's own writer, `write3mf.rs`): one object, one component per
part, a head per part in `Metadata/model_settings.config`. Written by the
app; do not edit.
"""
import os
import re
import tempfile
import zipfile
import xml.etree.ElementTree as ET

import numpy as np
import trimesh

DEFAULT_COLOR = "#C4CAD6"
# Snapmaker U1 plate, in millimeters: where written objects are placed.
BED = (270.0, 270.0)

NAMES = {
    "white": "#F2F2F2", "black": "#151515", "grey": "#8C8C8C", "gray": "#8C8C8C",
    "red": "#D32F2F", "orange": "#F57C00", "yellow": "#FBC02D", "green": "#388E3C",
    "blue": "#1976D2", "purple": "#7B1FA2", "pink": "#E91E63", "brown": "#6D4C41",
}


def to_color(value):
    """`#RGB`, `#RRGGBB`, `#RRGGBBAA` or a plain color name → `#RRGGBB`."""
    s = str(value).strip().lower()
    if s in NAMES:
        return NAMES[s]
    s = s.lstrip("#")
    if len(s) == 3 and re.fullmatch(r"[0-9a-f]{3}", s):
        s = "".join(c * 2 for c in s)
    if len(s) in (6, 8) and re.fullmatch(r"[0-9a-f]+", s):
        return "#" + s[:6].upper()
    raise ValueError(f"not a color: {value!r} (use #RRGGBB or one of {', '.join(NAMES)})")


class Part:
    def __init__(self, mesh, name="part", color=DEFAULT_COLOR, extruder=1):
        self.mesh = mesh
        self.name = str(name)
        self.color = to_color(color)
        self.extruder = int(extruder)
        if not 1 <= self.extruder <= 16:
            raise ValueError(f"{self.name}: head {self.extruder} out of 1..16")

    def __repr__(self):
        return f"Part({self.name!r}, {self.color}, head {self.extruder}, {len(self.mesh.faces)} faces)"


# ------------------------------------------------------------ reading


def _matrix(text):
    """A 3MF transform ("m00 m01 m02 m10 … m32") as a 4×4 row-vector matrix."""
    h = np.eye(4)
    if text:
        v = [float(x) for x in text.split()]
        if len(v) == 12:
            h[:, :3] = np.array(v).reshape(4, 3)
    return h


def _settings(z):
    """Heads from `model_settings.config`: object id → head, part id → head."""
    objects, parts = {}, {}
    try:
        root = ET.fromstring(z.read("Metadata/model_settings.config"))
    except (KeyError, ET.ParseError):
        return objects, parts
    for o in root.iter("object"):
        for m in o.findall("metadata"):
            if m.get("key") == "extruder":
                objects[o.get("id")] = int(m.get("value", "1") or 1)
        for p in o.iter("part"):
            for m in p.findall("metadata"):
                if m.get("key") == "extruder":
                    parts[p.get("id")] = int(m.get("value", "0") or 0)
    return objects, parts


def read(path):
    """The parts of a 3MF (or a single part for an STL), placements applied."""
    if str(path).lower().endswith(".stl"):
        mesh = trimesh.load(path, force="mesh")
        return [Part(mesh, os.path.splitext(os.path.basename(path))[0])]
    with zipfile.ZipFile(path) as z:
        model = next((n for n in z.namelist() if n.lower() == "3d/3dmodel.model"), None)
        if model is None:
            raise ValueError(f"{path}: no 3D/3dmodel.model")
        root = ET.fromstring(z.read(model))
        obj_heads, part_heads = _settings(z)
    ns = root.tag[: root.tag.index("}") + 1] if root.tag.startswith("{") else ""
    resources = root.find(ns + "resources")
    palettes = {}
    for bm in resources.findall(ns + "basematerials"):
        palettes[bm.get("id")] = [b.get("displaycolor", DEFAULT_COLOR)[:7] for b in bm.findall(ns + "base")]
    for cg in resources.findall(ns + "colorgroup"):
        palettes[cg.get("id")] = [c.get("color", DEFAULT_COLOR)[:7] for c in cg.findall(ns + "color")]
    objects = {o.get("id"): o for o in resources.findall(ns + "object")}

    def paint(pid, index):
        try:
            return to_color(palettes[pid][int(index)])
        except (KeyError, IndexError, ValueError, TypeError):
            return None

    parts = []

    def walk(oid, h, top, depth=0):
        o = objects.get(oid)
        if o is None or depth > 16:
            return
        mesh_el = o.find(ns + "mesh")
        if mesh_el is not None:
            verts = np.array(
                [[float(v.get("x")), float(v.get("y")), float(v.get("z"))] for v in mesh_el.find(ns + "vertices")],
                dtype=np.float64,
            )
            tris = list(mesh_el.find(ns + "triangles"))
            if len(verts) and tris:
                faces = np.array([[int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))] for t in tris], dtype=np.int64)
                verts = verts @ h[:3, :3] + h[3, :3]
                base = paint(o.get("pid"), o.get("pindex", 0))
                colors = [paint(t.get("pid", o.get("pid")), t.get("p1")) if t.get("p1") is not None else base for t in tris]
                found = [c for c in colors if c]
                main = max(set(found), key=found.count) if found else DEFAULT_COLOR
                mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
                if len(set(found)) > 1:
                    mesh.visual.face_colors = [_rgba(c or main) for c in colors]
                head = part_heads.get(oid) or obj_heads.get(top) or obj_heads.get(oid) or 1
                parts.append(Part(mesh, o.get("name") or f"part-{len(parts) + 1}", main, head))
        comps = o.find(ns + "components")
        if comps is not None:
            for c in comps.findall(ns + "component"):
                walk(c.get("objectid"), _matrix(c.get("transform")) @ h, top, depth + 1)

    build = root.find(ns + "build")
    items = build.findall(ns + "item") if build is not None else []
    if items:
        for it in items:
            walk(it.get("objectid"), _matrix(it.get("transform")), it.get("objectid"))
    else:
        for oid in objects:
            walk(oid, np.eye(4), oid)
    return parts


def _rgba(c):
    c = to_color(c)
    return [int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255]


# ------------------------------------------------------------ writing


def _esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _face_colors(part):
    """Per-face colors when the mesh carries several, otherwise None."""
    visual = getattr(part.mesh, "visual", None)
    if visual is None or getattr(visual, "kind", None) != "face":
        return None
    fc = np.asarray(visual.face_colors)[:, :3]
    names = ["#%02X%02X%02X" % tuple(int(v) for v in c) for c in fc]
    return names if len(set(names)) > 1 else None


def write(path, parts, name="object"):
    """Writes the parts as one object, atomically (the app watches the file)."""
    if not parts:
        raise ValueError("no part to write")
    palette = []

    def index(c):
        if c not in palette:
            palette.append(c)
        return palette.index(c)

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
        ' <metadata name="Application">Snap Studio</metadata>',
        " <resources>",
    ]
    bodies = []
    for i, p in enumerate(parts):
        verts = np.asarray(p.mesh.vertices, dtype=np.float64)
        faces = np.asarray(p.mesh.faces, dtype=np.int64)
        keep = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
        if not keep.any():
            raise ValueError(f"{p.name}: empty mesh")
        fcolors = _face_colors(p)
        if fcolors is not None:
            fcolors = [c for c, k in zip(fcolors, keep) if k]
            for c in fcolors:
                index(c)
        bodies.append((i + 2, p, verts, faces[keep], fcolors, index(p.color)))
    lines.append('  <basematerials id="1">')
    for k, c in enumerate(palette):
        lines.append(f'   <base name="Color {k + 1}" displaycolor="{c}FF"/>')
    lines.append("  </basematerials>")
    for oid, p, verts, faces, fcolors, pindex in bodies:
        lines.append(f'  <object id="{oid}" type="model" name="{_esc(p.name)}" pid="1" pindex="{pindex}">')
        lines.append("   <mesh>")
        lines.append("    <vertices>")
        lines.extend(f'     <vertex x="{x:.6f}" y="{y:.6f}" z="{z:.6f}"/>' for x, y, z in verts)
        lines.append("    </vertices>")
        lines.append("    <triangles>")
        if fcolors is None:
            lines.extend(f'     <triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in faces)
        else:
            lines.extend(
                f'     <triangle v1="{a}" v2="{b}" v3="{c}" pid="1" p1="{palette.index(col)}"/>'
                for (a, b, c), col in zip(faces, fcolors)
            )
        lines.append("    </triangles>")
        lines.append("   </mesh>")
        lines.append("  </object>")
    whole = len(parts) + 2
    lines.append(f'  <object id="{whole}" type="model" name="{_esc(name)}">')
    lines.append("   <components>")
    lines.extend(f'    <component objectid="{b[0]}"/>' for b in bodies)
    lines.append("   </components>")
    lines.append("  </object>")
    lines.append(" </resources>")
    # Centered on the plate and resting on it, through the placement: the
    # meshes stay as modeled (often around the origin, the plate's corner).
    allv = np.vstack([b[2] for b in bodies])
    lo, hi = allv.min(axis=0), allv.max(axis=0)
    tx, ty, tz = BED[0] / 2 - (lo[0] + hi[0]) / 2, BED[1] / 2 - (lo[1] + hi[1]) / 2, -lo[2]
    lines.append(" <build>")
    lines.append(f'  <item objectid="{whole}" transform="1 0 0 0 1 0 0 0 1 {tx:.6f} {ty:.6f} {tz:.6f}"/>')
    lines.append(" </build>")
    lines.append("</model>")

    cfg = ['<?xml version="1.0" encoding="UTF-8"?>', "<config>", f'  <object id="{whole}">']
    cfg.append(f'    <metadata key="name" value="{_esc(name)}"/>')
    cfg.append(f'    <metadata key="extruder" value="{parts[0].extruder}"/>')
    for oid, p, *_ in bodies:
        cfg.append(f'    <part id="{oid}" subtype="normal_part">')
        cfg.append(f'      <metadata key="name" value="{_esc(p.name)}"/>')
        cfg.append(f'      <metadata key="extruder" value="{p.extruder}"/>')
        cfg.append("    </part>")
    cfg += ["  </object>", "</config>"]

    folder = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".writing-", suffix=".3mf", dir=folder)
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("[Content_Types].xml", CONTENT_TYPES)
            z.writestr("_rels/.rels", RELS)
            z.writestr("3D/3dmodel.model", "\n".join(lines) + "\n")
            z.writestr("Metadata/model_settings.config", "\n".join(cfg) + "\n")
        # mkstemp makes the file private; give it the usual rights.
        mask = os.umask(0)
        os.umask(mask)
        os.chmod(tmp, 0o666 & ~mask)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""


def merged(parts):
    """All the parts as one mesh, for measurements."""
    return trimesh.util.concatenate([p.mesh for p in parts])
