# Qin Reclamation-class cruiser. Rebuilds qin-reclamation.glb next to this file.
# pip install trimesh numpy --break-system-packages && python3 build_reclamation.py
#
# Scale: 1 unit = 100 m. Nose is -Z, up is +Y, starboard is +X (same frame as br10-shrike.glb).
# 960 m long hull, 310 m drive ring, outboard drive pods.
# Parts are merged by name, so the viewer gets one draw call per part type; the name prefix
# drives the viewer's material choice (window*, *_glow, nav_light, ...).
import numpy as np, trimesh, math, os
from trimesh.transformations import rotation_matrix
from shipkit import Kit

K = Kit(1960)
rng, PARTS = K.rng, K.parts
add, box, cyl, sphere, loft, lathe, disk = K.add, K.box, K.cyl, K.sphere, K.loft, K.lathe, K.disk


# ---------------------------------------------------------------- main hull
# (z, half-width, half-height, chamfer, y-centre); doubled z values make the stepped armour ledges
HULL = [(-4.85, .03, .03, .01, 0), (-4.55, .17, .11, .05, 0), (-3.95, .31, .21, .09, 0),
        (-3.55, .37, .25, .10, 0), (-3.55, .44, .30, .12, 0),
        (-2.45, .53, .37, .15, 0), (-2.45, .59, .42, .16, 0),
        (-1.15, .66, .49, .18, 0), (-1.15, .60, .45, .16, 0),
        (1.05, .60, .45, .16, 0), (1.05, .80, .60, .20, 0),
        (3.70, .84, .62, .20, 0), (3.70, .72, .56, .18, 0), (4.05, .72, .56, .18, 0)]
loft(HULL, 'armor', 'main_hull')


def hull_at(z):
    """half-width, half-height of the hull at z (taking the aft value at a step)."""
    hw = hh = 0
    for i in range(len(HULL) - 1):
        z0, w0, h0 = HULL[i][:3]; z1, w1, h1 = HULL[i + 1][:3]
        if z0 <= z <= z1 and z1 > z0:
            t = (z - z0) / (z1 - z0); hw = w0 + (w1 - w0) * t; hh = h0 + (h1 - h0) * t
    return hw, hh


# forward dorsal spine and ventral keel, stepped like the concept's armour
loft([(-4.1, .07, .04, .02, .22), (-3.3, .2, .08, .04, .32), (-1.2, .3, .1, .05, .52), (-0.95, .3, .1, .05, .52)], 'armor2', 'dorsal_spine')
loft([(-3.6, .06, .04, .02, -.25), (-2.6, .2, .07, .03, -.4), (-1.2, .26, .08, .04, -.53), (-.95, .26, .08, .04, -.53)], 'armor2', 'ventral_keel')
# nose plating and the prow lance
loft([(-4.6, .1, .06, .02, .07), (-3.6, .3, .1, .04, .2), (-3.5, .3, .1, .04, .2)], 'light', 'prow_plate')
cyl((0, 0, -5.25), (0, 0, -4.8), .018, 'light', 'prow_lance', 8)
for s in (-1, 1):
    cyl((s * .07, .03, -5.0), (s * .07, .03, -4.7), .01, 'dark', 'prow_lance', 6)
# cheek armour along the forward hull
for s in (-1, 1):
    for z0, z1, w, y in [(-3.4, -2.6, .05, .0), (-2.3, -1.25, .06, .02)]:
        hw0, _ = hull_at(z0); hw1, _ = hull_at(z1)
        loft([(z0, .04, .14, .02, y), (z1, .05, .18, .02, y)], 'armor2', 'cheek_armor', True, True)
        PARTS['cheek_armor'][-1].apply_translation((s * ((hw0 + hw1) / 2 + .02), 0, 0))

# panel seams on the forward hull
for z in np.arange(-4.2, -1.2, .3):
    hw, hh = hull_at(z)
    box((0, hh + .003, z), (hw * 1.2, .006, .012), 'dark', 'panel_seam')
    for s in (-1, 1):
        box((s * (hw + .003), 0, z), (.006, hh * 1.1, .012), 'dark', 'panel_seam')

# ---------------------------------------------------------------- windows (blue decks, a few amber)
for s in (-1, 1):
    for z in np.arange(-4.0, -1.2, .075):
        hw, hh = hull_at(z)
        for y in (-.12, .0, .12):
            if abs(y) > hh - .17 or rng.random() < .28: continue
            box((s * (hw + .004), y, z), (.008, .022, .045), 'amber' if rng.random() < .1 else 'window', 'window')
    for z in np.arange(-1.0, 1.0, .07):
        for y in (-.2, -.05, .1, .25):
            if rng.random() < .35: continue
            box((s * .604, y, z), (.008, .022, .04), 'window', 'window')

# ---------------------------------------------------------------- bridge tower
bz = -1.55
box((0, .66, bz), (.34, .14, .5), 'armor2', 'bridge')
box((0, .78, bz - .03), (.26, .12, .34), 'armor', 'bridge')
box((0, .87, bz - .06), (.2, .07, .2), 'light', 'bridge')
box((0, .81, bz - .205), (.22, .025, .006), 'amber', 'window_amber')
box((0, .69, bz - .255), (.3, .02, .006), 'window', 'window')
for s in (-1, 1):
    box((s * .132, .78, bz - .03), (.006, .022, .28), 'window', 'window')
cyl((0, .9, bz), (0, 1.35, bz), .012, 'light', 'antenna', 6)
cyl((.06, .9, bz + .05), (.06, 1.18, bz + .05), .008, 'light', 'antenna', 6)
cyl((-.07, .9, bz - .02), (-.07, 1.08, bz - .02), .008, 'light', 'antenna', 6)
sphere((0, 1.36, bz), (.018, .018, .018), 'red', 'nav_light_top', 1)
for y in (1.0, 1.12, 1.24):
    box((0, y, bz), (.09, .006, .006), 'light', 'antenna')

# ---------------------------------------------------------------- weapons
def rail_turret(x, y, z, up=1, twin=True, scale=1.0):
    k = scale
    cyl((x, y, z), (x, y + up * .035 * k, z), .085 * k, 'dark', 'turret_base', 14)
    box((x, y + up * .07 * k, z + .01 * k), (.15 * k, .06 * k, .17 * k), 'armor2', 'turret_housing')
    box((x, y + up * .1 * k, z + .03 * k), (.1 * k, .02 * k, .09 * k), 'light', 'turret_housing')
    for dx in ((-.035, .035) if twin else (0,)):
        cyl((x + dx * k, y + up * .07 * k, z - .08 * k), (x + dx * k, y + up * .07 * k, z - .42 * k), .014 * k, 'black', 'rail_barrel', 8)
        cyl((x + dx * k, y + up * .07 * k, z - .2 * k), (x + dx * k, y + up * .07 * k, z - .26 * k), .022 * k, 'dark', 'rail_barrel', 8)


def spine_top(z):
    if -3.3 <= z <= -1.2:
        t = (z + 3.3) / 2.1; return .32 + .2 * t + .08 + .02 * t
    return hull_at(z)[1]


for z in (-3.05, -2.55):
    rail_turret(0, spine_top(z), z)
for s in (-1, 1):
    for z in (-2.15, -1.8):
        hw, hh = hull_at(z); rail_turret(s * .36, hh, z, scale=.85)
for z in (-2.9, -2.1):
    rail_turret(0, -.41 - (z + 3.6) * .12, z, up=-1)
# aft dorsal battery
for s in (-1, 1):
    rail_turret(s * .42, .62, 1.55, scale=1.05)
rail_turret(0, .62, 2.25, scale=1.1)

# point defence: small domes along the chines
for z in np.arange(-3.9, -1.2, .45):
    hw, hh = hull_at(z)
    for s in (-1, 1):
        for sy in (-1, 1):
            p = (s * (hw - .05), sy * (hh - .05), z)
            sphere(p, (.035, .035, .035), 'light', 'pd_dome', 1)
            cyl(p, (p[0] + s * .02, p[1] + sy * .03, p[2] - .07), .006, 'black', 'pd_barrel', 6)

# missile bays: hatch grids either side of the spine
for s in (-1, 1):
    for z in np.arange(-3.25, -2.7, .1):
        hw, hh = hull_at(z)
        for x in (.2, .27):
            box((s * x * (hw / .5), hh + .004, z), (.05, .008, .065), 'dark', 'missile_hatch')
    for z in np.arange(-1.45, -1.2, .09):
        for x in (.24, .32, .4):
            box((s * x, .49 + .004, z), (.06, .008, .06), 'dark', 'missile_hatch')

# torpedo tubes on the forward step ledge
for s in (-1, 1):
    for sy in (-1, 1):
        cyl((s * .34, sy * .2, -3.56), (s * .34, sy * .2, -3.5), .03, 'black', 'torpedo_tube', 10)
        cyl((s * .34, sy * .2, -3.565), (s * .34, sy * .2, -3.555), .036, 'edge', 'torpedo_ring', 10)

# ---------------------------------------------------------------- drive ring and hub
RZ = .05; R = 1.55; NSEG = 40
cyl((0, 0, RZ - .42), (0, 0, RZ + .42), .74, 'armor2', 'hub_collar', 32)
for z in (RZ - .36, RZ - .12, RZ + .12, RZ + .36):
    cyl((0, 0, z - .02), (0, 0, z + .02), .77, 'dark', 'hub_band', 32)
for i in range(NSEG):
    a = 2 * math.pi * (i + .5) / NSEG
    L = 2 * math.pi * R / NSEG * 1.03
    heavy = i % 5 == 0
    pos = (R * math.cos(a), R * math.sin(a), RZ)
    m = trimesh.creation.box(extents=(.24 if heavy else .18, L, .5 if heavy else .4))
    m.apply_transform(rotation_matrix(a, [0, 0, 1])); m.apply_translation(pos)
    add(m, 'armor' if heavy else 'armor2', 'ring_segment')
    # running lights on both faces of the ring
    for f in (-1, 1):
        if heavy: continue
        for k in (-.25, .25):
            aa = a + k * 2 * math.pi / NSEG
            wz = RZ + f * .202
            box((R * math.cos(aa), R * math.sin(aa), wz), (.03, .03, .006), 'window', 'window_ring',
                rot=(aa, [0, 0, 1]))
    if heavy:
        m = trimesh.creation.box(extents=(.06, L * .7, .3))
        m.apply_transform(rotation_matrix(a, [0, 0, 1]))
        m.apply_translation(((R + .13) * math.cos(a), (R + .13) * math.sin(a), RZ))
        add(m, 'light', 'ring_rib')
# inner rail
ann = trimesh.creation.annulus(r_min=R - .2, r_max=R - .13, height=.12, sections=72)
ann.apply_translation((0, 0, RZ)); add(ann, 'dark', 'ring_rail')
for z in (RZ - .1, RZ + .1):
    a2 = trimesh.creation.annulus(r_min=R - .16, r_max=R - .07, height=.02, sections=72)
    a2.apply_translation((0, 0, z)); add(a2, 'edge', 'ring_trim')

# the cross: vertical and horizontal pylons through the hub, running past the ring
for ax in ('x', 'y'):
    ext = (3.5, .24, .32) if ax == 'x' else (.24, 3.5, .32)
    box((0, 0, RZ), ext, 'armor', 'cross_pylon')
    ext2 = (3.5, .3, .14) if ax == 'x' else (.3, 3.5, .14)
    box((0, 0, RZ), ext2, 'armor2', 'cross_pylon')
    for s in (-1, 1):
        p = (s * 1.76, 0, RZ) if ax == 'x' else (0, s * 1.76, RZ)
        box(p, (.16, .34, .44) if ax == 'x' else (.34, .16, .44), 'light', 'pylon_cap')
        for k in np.arange(.85, 1.4, .14):
            q = (s * k, 0, RZ) if ax == 'x' else (0, s * k, RZ)
            for f in (-1, 1):
                box((q[0], q[1], RZ + f * .163), (.04, .03, .006) if ax == 'x' else (.03, .04, .006), 'window', 'window_ring')
# masts at the top and bottom of the cross, like the concept's views
for s in (-1, 1):
    for dz, h in ((-.1, .55), (.1, .38)):
        cyl((0, s * 1.84, RZ + dz), (0, s * (1.84 + h), RZ + dz), .014, 'light', 'antenna', 6)
    sphere((0, s * 2.4, RZ - .1), (.02, .02, .02), 'red' if s > 0 else 'blue', 'nav_light', 1)
for s in (-1, 1):
    sphere((s * 1.85, 0, RZ), (.025, .025, .025), 'red' if s < 0 else 'blue', 'nav_light', 1)

# ---------------------------------------------------------------- aft section: blocky processing / cargo modules
def module(x, y, z, w, h, d, mat='armor'):
    box((x, y, z), (w, h, d), mat, 'aft_module')
    # greebles on the outward faces
    for _ in range(3):
        gx = x + rng.uniform(-w / 2.6, w / 2.6); gz = z + rng.uniform(-d / 2.6, d / 2.6)
        box((gx, y + h / 2 + .015, gz), (rng.uniform(.05, .14), .03, rng.uniform(.05, .16)), rng.choice(['armor2', 'dark', 'light']), 'greeble')


for s in (-1, 1):
    # side bays, stepped outward
    module(s * .98, .18, 1.5, .36, .5, .7)
    module(s * 1.02, -.28, 1.65, .44, .32, .55, 'armor2')
    module(s * 1.0, .15, 2.35, .4, .62, .6, 'armor2')
    module(s * 1.08, -.26, 2.55, .52, .36, .7)
    module(s * .98, .1, 3.25, .36, .7, .55)
    # dorsal boxes
    module(s * .42, .72, 2.85, .34, .2, .5, 'armor2')
    module(s * .5, .7, 1.4, .26, .16, .3)
    # ventral blocks
    module(s * .45, -.7, 3.0, .4, .18, .6, 'armor2')
    # windows on the side bays
    for z in np.arange(1.25, 3.5, .07):
        for y in (-.05, .12, .28):
            if rng.random() < .45: continue
            x = s * 1.205 if 2.1 < z < 2.6 else s * (1.165 if z < 1.85 else 1.165)
            if 1.85 <= z <= 2.05 or 2.85 <= z <= 2.97: continue
            box((x + s * .0, y, z), (.008, .022, .04), 'amber' if rng.random() < .12 else 'window', 'window')
    # conduits running aft along the hull
    for y in (.38, -.42):
        cyl((s * .83, y, 1.1), (s * .83, y, 3.65), .035, 'dark', 'conduit', 8)
box((0, .72, 3.45), (.5, .2, .4), 'armor', 'aft_module')
box((0, -.68, 1.9), (.5, .14, .9), 'armor2', 'aft_module')

# drone hangar (12 drones): ventral bay with a lit interior
box((0, -.62 - .004, 2.6), (.62, .01, .9), 'black', 'hangar_well')
box((0, -.62 - .006, 2.6), (.5, .01, .78), 'hangar', 'hangar_glow')
for z in np.arange(2.25, 3.0, .16):
    box((0, -.62 - .009, z), (.52, .012, .02), 'dark', 'hangar_rib')
for s in (-1, 1):
    box((s * .33, -.63, 2.6), (.03, .03, .94), 'edge', 'hangar_frame')
# starboard-side launch bay too
box((.84 + .004, -.08, 2.0), (.01, .3, .5), 'black', 'hangar_well')
box((.84 + .007, -.08, 2.0), (.01, .22, .42), 'hangar', 'hangar_glow')
box((-.84 - .004, -.08, 2.0), (.01, .3, .5), 'black', 'hangar_well')
box((-.84 - .007, -.08, 2.0), (.01, .22, .42), 'hangar', 'hangar_glow')

# ---------------------------------------------------------------- drives
def engine(x, y, z0, z1, r, glow_name='engine_glow'):
    cyl((x, y, z0), (x, y, z1), r, 'armor2', 'engine_housing', 28)
    for zz in np.linspace(z0 + .1, z1 - .1, 3):
        cyl((x, y, zz - .015), (x, y, zz + .015), r * 1.05, 'dark', 'engine_band', 28)
    # bell
    lathe([(r * .96, 0), (r * 1.02, .12), (r * 1.1, .26), (r * .92, .26), (r * .8, .1)], (x, y, z1), 'dark', 'engine_bell')
    lathe([(r * 1.1, .26), (r * 1.13, .27)], (x, y, z1), 'edge', 'engine_lip')
    disk((x, y, z1 + .12), r * .82, 'engine', glow_name)
    disk((x, y, z1 + .02), r * .5, 'engine', glow_name + '_core')


# main drive and the vertical pair (side view shows three stacked)
engine(0, 0, 3.75, 4.3, .4)
for sy in (-1, 1):
    box((0, sy * .5, 3.95), (.4, .28, .6), 'armor', 'drive_mount')
    engine(0, sy * .62, 3.9, 4.25, .25)
# outboard pods on pylons (top and front views)
for s in (-1, 1):
    x = s * 1.42
    loft([(2.75, .06, .06, .02, 0), (3.0, .26, .26, .08, 0), (3.6, .3, .3, .09, 0)], 'armor', 'pod_nose')
    PARTS['pod_nose'][-1].apply_translation((x, 0, 0))
    engine(x, 0, 3.6, 4.2, .3)
    box((s * 1.2, 0, 3.45), (.5, .1, .6), 'armor2', 'pod_pylon')
    box((s * 1.2, .07, 3.5), (.46, .03, .4), 'dark', 'pod_pylon')
    for z in np.arange(3.05, 4.15, .1):
        box((x + s * .305, .1, z), (.008, .02, .04), 'window', 'window')
    sphere((x + s * .32, 0, 3.0), (.025, .025, .025), 'red' if s < 0 else 'blue', 'nav_light', 1)
    cyl((x, .3, 3.2), (x, .55, 3.25), .01, 'light', 'antenna', 6)

# stern face detail around the drives
for s in (-1, 1):
    for sy in (-1, 1):
        cyl((s * .52, sy * .38, 4.05), (s * .52, sy * .38, 4.18), .09, 'dark', 'aux_thruster', 12)
        disk((s * .52, sy * .38, 4.181), .065, 'engine', 'aux_glow')


# ---------------------------------------------------------------- surface detail: raised plating and greebles
PLATE = ['armor', 'armor2', 'armor2', 'light', 'dark']
for z in np.arange(-4.1, -1.25, .11):
    hw, hh = hull_at(z)
    for s in (-1, 1):
        # side plating in two bands
        for y0 in (-hh * .45, hh * .35):
            if rng.random() < .45:
                box((s * (hw + .008), y0 + rng.uniform(-.04, .04), z), (.016, rng.uniform(.05, .14), rng.uniform(.06, .2)), rng.choice(PLATE), 'hull_plate')
        # top shoulders
        if rng.random() < .6:
            box((s * rng.uniform(.12, hw - .12), hh + .008, z), (rng.uniform(.05, .14), .016, rng.uniform(.06, .18)), rng.choice(PLATE), 'hull_plate')
        # belly
        if rng.random() < .5:
            box((s * rng.uniform(.08, hw - .12), -hh - .008, z), (rng.uniform(.05, .16), .016, rng.uniform(.06, .2)), rng.choice(PLATE), 'hull_plate')
    if rng.random() < .35:
        box((rng.uniform(-.1, .1), spine_top(z) + .012, z), (.04, .024, .05), 'dark', 'greeble')
# longitudinal strakes on the forward hull
for s in (-1, 1):
    for y, z0, z1 in ((.18, -3.9, -1.3), (-.2, -3.3, -1.3)):
        n = 12; zs = np.linspace(z0, z1, n)
        for a, b in zip(zs[:-1], zs[1:]):
            hw = (hull_at(a)[0] + hull_at(b)[0]) / 2
            box((s * (hw + .02), y, (a + b) / 2), (.03, .025, b - a + .002), 'dark', 'strake')
# mid-hull (between the step and the ring) machinery
for z in np.arange(-.95, .95, .1):
    if -.45 < z < .5: continue
    for s in (-1, 1):
        if rng.random() < .7:
            box((s * .61, rng.uniform(-.3, .3), z), (.02, rng.uniform(.06, .16), .08), rng.choice(PLATE), 'hull_plate')
    box((0, .45 + .01, z), (rng.uniform(.15, .4), .02, .07), rng.choice(PLATE), 'hull_plate')
    box((0, -.45 - .01, z), (rng.uniform(.15, .4), .02, .07), rng.choice(PLATE), 'hull_plate')
# aft hull: plating on the exposed faces and pipe runs
for z in np.arange(1.15, 3.65, .09):
    for s in (-1, 1):
        if rng.random() < .5:
            box((s * rng.uniform(.1, .7), .62 + .008, z), (rng.uniform(.05, .18), .016, rng.uniform(.05, .12)), rng.choice(PLATE), 'hull_plate')
        if rng.random() < .5:
            box((s * rng.uniform(.1, .7), -.62 - .008, z), (rng.uniform(.05, .18), .016, rng.uniform(.05, .12)), rng.choice(PLATE), 'hull_plate')
for s in (-1, 1):
    for y in (.5, .56):
        cyl((s * .3, y + .1, 1.1), (s * .3, y + .1, 3.6), .018, 'light', 'conduit', 6)
# ring surface: panels on both faces and the outer rim
for i in range(NSEG * 2):
    a = 2 * math.pi * (i + .25) / (NSEG * 2)
    if rng.random() < .5: continue
    rr = R + rng.uniform(-.05, .05)
    for f in (-1, 1):
        if rng.random() < .5:
            box((rr * math.cos(a), rr * math.sin(a), RZ + f * .206), (rng.uniform(.04, .1), rng.uniform(.06, .14), .012), rng.choice(PLATE), 'ring_plate', rot=(a, [0, 0, 1]))
    m = trimesh.creation.box(extents=(.02, rng.uniform(.06, .14), rng.uniform(.08, .3)))
    m.apply_transform(rotation_matrix(a, [0, 0, 1])); m.apply_translation(((R + .1) * math.cos(a), (R + .1) * math.sin(a), RZ))
    add(m, rng.choice(PLATE), 'ring_plate')

# ---------------------------------------------------------------- markings
for s in (-1, 1):
    box((s * .63, .2, -1.6), (.006, .05, .55), 'edge', 'hull_stripe')
    box((s * .63, .12, -1.6), (.006, .02, .55), 'edge', 'hull_stripe')
box((0, .62 + .004, 3.0), (.08, .006, .9), 'edge', 'hull_stripe')

# ---------------------------------------------------------------- export
K.export(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'qin-reclamation.glb'))
