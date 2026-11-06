# Shared parts kit for the Shipyard build scripts.
# Frame: 1 unit = 100 m, nose -Z, up +Y, starboard +X (same as lab/tauri-reach/assets/br10-shrike.glb).
# Parts are merged by name at export: one mesh (one draw call) per part type. The page picks materials by
# name prefix (window*, engine_glow*, aux_glow, hangar_glow, nav_light*, *stripe, ...); see ../README.md.
import math, os, random
import numpy as np, trimesh
from trimesh.transformations import rotation_matrix

PALETTE = {'armor': '#7a7269', 'armor2': '#57514a', 'light': '#a89e90', 'dark': '#1f2227', 'black': '#121417',
           'glass': '#173c50', 'window': '#7cc8ff', 'amber': '#ffb45e', 'engine': '#7fd0ff', 'red': '#cc493b',
           'blue': '#49d9fa', 'edge': '#c9a46a', 'hangar': '#5fb8ff', 'accent': '#9a2f27'}


class Kit:
    def __init__(self, seed, colors=None):
        self.rng = random.Random(seed)
        self.C = dict(PALETTE, **(colors or {}))
        self.mat = {}     # part name -> colour key
        self.parts = {}   # part name -> [meshes]

    # ------------------------------------------------------------ primitives
    def add(self, mesh, mat, name):
        self.mat.setdefault(name, mat)
        self.parts.setdefault(name, []).append(mesh)
        return mesh

    def box(self, pos, ext, mat, name, rot=None):
        m = trimesh.creation.box(extents=ext)
        if rot is not None:
            m.apply_transform(rotation_matrix(rot[0], rot[1]))
        m.apply_translation(pos)
        return self.add(m, mat, name)

    def cyl(self, a, b, r, mat, name, sections=16):
        a = np.array(a, float); b = np.array(b, float); d = b - a; L = np.linalg.norm(d)
        m = trimesh.creation.cylinder(radius=r, height=L, sections=sections)
        m.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], d)); m.apply_translation((a + b) / 2)
        return self.add(m, mat, name)

    def sphere(self, pos, scale, mat, name, sub=2):
        m = trimesh.creation.icosphere(subdivisions=sub, radius=1); m.apply_scale(scale); m.apply_translation(pos)
        return self.add(m, mat, name)

    def _tube(self, rings, mat, name, cap0, cap1):
        n = len(rings[0]); verts = [v for r in rings for v in r]; faces = []
        for s in range(len(rings) - 1):
            a = s * n; b = (s + 1) * n
            for i in range(n):
                j = (i + 1) % n
                faces += [[a + i, b + i, b + j], [a + i, b + j, a + j]]
        if cap0:
            for i in range(1, n - 1): faces.append([0, i + 1, i])
        if cap1:
            o = (len(rings) - 1) * n
            for i in range(1, n - 1): faces.append([o, o + i, o + i + 1])
        m = trimesh.Trimesh(vertices=verts, faces=faces, process=False); m.fix_normals()
        return self.add(m, mat, name)

    def loft(self, sections, mat, name, cap0=True, cap1=True):
        """sections: [(z, half-width, half-height, chamfer, y-centre)] -> chamfered octagon tube along z."""
        rings = []
        for z, hw, hh, ch, yc in sections:
            rings.append([[x, y + yc, z] for x, y in [(hw - ch, hh), (hw, hh - ch), (hw, -hh + ch), (hw - ch, -hh),
                                                      (-hw + ch, -hh), (-hw, -hh + ch), (-hw, hh - ch), (-hw + ch, hh)]])
        return self._tube(rings, mat, name, cap0, cap1)

    def loft_shape(self, shape, sections, mat, name, cap0=True, cap1=True, x0=0.0):
        """shape: closed [(x, y)] in -1..1, counter-clockwise from +x; sections: [(z, half-width, half-height, y-centre)]."""
        rings = [[[x0 + x * hw, y * hh + yc, z] for x, y in shape] for z, hw, hh, yc in sections]
        return self._tube(rings, mat, name, cap0, cap1)

    def lathe(self, profile, center, mat, name, sections=28, axis='z'):
        """profile: [(r, d)] revolved about the axis (z: d along +z; y: d along +y), placed at center."""
        cx, cy, cz = center; n = sections; verts = []
        for r, d in profile:
            for i in range(n):
                a = 2 * math.pi * i / n; u, v = r * math.cos(a), r * math.sin(a)
                verts.append([cx + u, cy + v, cz + d] if axis == 'z' else [cx + u, cy + d, cz + v])
        faces = []
        for s in range(len(profile) - 1):
            a = s * n; b = (s + 1) * n
            for i in range(n):
                j = (i + 1) % n
                faces += [[a + i, a + j, b + j], [a + i, b + j, b + i]]
        m = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
        if profile[0][0] == 0 and profile[-1][0] == 0:
            if m.volume < 0:          # closed solid: wind it outward whichever way the profile runs
                m.invert()
        elif axis == 'y':             # open surface (dish, skirt): give it both sides
            m2 = m.copy(); m2.invert(); self.add(m2, mat, name)
        return self.add(m, mat, name)

    def disk(self, center, r, mat, name, sections=28):
        cx, cy, cz = center
        verts = [[cx, cy, cz]] + [[cx + r * math.cos(2 * math.pi * i / sections), cy + r * math.sin(2 * math.pi * i / sections), cz] for i in range(sections)]
        faces = [[0, 1 + i, 1 + (i + 1) % sections] for i in range(sections)]
        m = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
        self.add(m, mat, name)
        m2 = m.copy(); m2.invert(); self.add(m2, mat, name)

    def fin(self, x, yz, thick, mat, name):
        """a flat plate: polygon yz [(y, z)] extruded thick along x, centred on x."""
        verts = [[xx, y, z] for xx in (x - thick / 2, x + thick / 2) for y, z in yz]
        n = len(yz); faces = []
        for i in range(1, n - 1): faces += [[0, i + 1, i], [n, n + i, n + i + 1]]
        for i in range(n):
            j = (i + 1) % n; faces += [[i, j, n + j], [i, n + j, n + i]]
        m = trimesh.Trimesh(vertices=verts, faces=faces, process=False); m.fix_normals()
        return self.add(m, mat, name)

    # ------------------------------------------------------------ export
    def export(self, path):
        scene = trimesh.Scene(); tris = 0
        for name, meshes in self.parts.items():
            m = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
            m.visual = trimesh.visual.ColorVisuals(m, vertex_colors=trimesh.visual.color.hex_to_rgba(self.C[self.mat[name]]))
            scene.add_geometry(m, geom_name=f'{name}_000'); tris += len(m.faces)
        scene.export(path)
        print('parts', sum(len(v) for v in self.parts.values()), 'meshes', len(self.parts), 'triangles', tris)
        print('bounds', np.round(scene.bounds, 2).tolist(), 'bytes', os.path.getsize(path))
