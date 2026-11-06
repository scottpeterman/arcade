# Qin Sovereign-class cruiser. Rebuilds qin-sovereign.glb next to this file.
# pip install trimesh numpy --break-system-packages && python3 build_sovereign.py
#
# Scale: 1 unit = 100 m. Nose is -Z, up is +Y, starboard is +X.
# 1,200 m arrowhead hull with a V keel and three stepped armour tiers, the saucer command tower on a pylon,
# heavy ion cannon turrets, flank casemates, carrier bays, two outboard drive nacelles and twin dorsal fins.
import numpy as np, trimesh, math, os
from trimesh.transformations import rotation_matrix
from shipkit import Kit

K = Kit(1200)
rng, PARTS = K.rng, K.parts
box, cyl, sphere, loft, lathe, disk, fin = K.box, K.cyl, K.sphere, K.loft, K.lathe, K.disk, K.fin
PLATE = ['armor', 'armor2', 'armor2', 'light', 'dark']

# ---------------------------------------------------------------- main hull: flat deck, shoulders, V keel
SHAPE = [(1.0, .25), (.62, 1.0), (-.62, 1.0), (-1.0, .25), (-.78, -.38), (-.14, -1.0), (.14, -1.0), (.78, -.38)]
HULL = [(-6.1, .03, .02, 0), (-5.6, .16, .09, 0), (-4.6, .38, .22, 0), (-4.6, .43, .25, 0),
        (-2.6, .68, .38, 0), (-2.6, .73, .42, 0), (-.2, .9, .5, 0), (-.2, .95, .54, 0),
        (3.8, 1.0, .56, 0), (4.9, .96, .54, 0), (4.9, .82, .48, 0), (5.25, .8, .46, 0)]
K.loft_shape(SHAPE, HULL, 'armor', 'main_hull')


def hull_at(z):
    hw = hh = 0
    for (z0, w0, h0, _), (z1, w1, h1, _) in zip(HULL, HULL[1:]):
        if z0 <= z <= z1 and z1 > z0:
            t = (z - z0) / (z1 - z0); hw = w0 + (w1 - w0) * t; hh = h0 + (h1 - h0) * t
    return hw, hh


def side_x(z, y):
    """x of the starboard side wall (shoulder to keel corner) at height y."""
    hw, hh = hull_at(z); u = min(1, max(0, (y / hh + .38) / .63))
    return hw * (.78 + .22 * u)


# tier 2: the armoured upper deck; tier 3: the command spine
def tier(z):  # half-width and top of tier 2 at z
    hw, hh = hull_at(z)
    w = .12 + .4 * min(1, (z + 4.3) / 3.6) if z < -.7 else .52 - .1 * max(0, (z - .7) / 2.9)
    return w, hh + .17


T2 = []
for z in (-4.3, -3.4, -2.6, -1.6, -.7, .7, 2.0, 3.6):
    w, top = tier(z); T2.append((z, w, .09, .04, top - .085))
loft(T2, 'armor2', 'upper_deck')
loft([(-1.9, .08, .05, .02, tier(-1.9)[1] + .03), (-1.2, .26, .07, .03, tier(-1.2)[1] + .06),
      (2.4, .26, .07, .03, tier(2.4)[1] + .06), (2.8, .12, .05, .02, tier(2.8)[1] + .03)], 'armor', 'command_spine')
# prow: a bright armour cap and a twin lance
K.loft_shape(SHAPE, [(-5.9, .07, .045, .003), (-4.7, .36, .21, .01), (-4.6, .36, .21, .01)], 'light', 'prow_plate')
for s in (-1, 1):
    cyl((s * .05, .02, -6.45), (s * .05, .02, -5.8), .012, 'light', 'prow_lance', 6)

# panel seams and raised plating
for z in np.arange(-5.2, 4.8, .26):
    hw, hh = hull_at(z)
    K.box((0, -hh - .004, z), (.24 * hw, .008, .012), 'dark', 'panel_seam')
    for s in (-1, 1):
        K.box((s * (hw * .62 + .004), hh * .98, z), (.012, .03, .012), 'dark', 'panel_seam')
for z in np.arange(-5.0, 4.8, .1):
    hw, hh = hull_at(z)
    for s in (-1, 1):
        w = tier(z)[0] if -4.3 < z < 3.6 else 0
        x0 = max(w + .04, .05); x1 = hw * .6 - .04
        for _ in range(2):  # deck plating outboard of tier 2
            if x1 > x0 and rng.random() < .7:
                box((s * rng.uniform(x0, x1), hh + .008, z), (rng.uniform(.04, .12), .016, rng.uniform(.05, .16)), rng.choice(PLATE), 'hull_plate')
        if rng.random() < .4:  # sparse, low-contrast plating on the shoulder slope
            u = rng.uniform(.15, .85); x = hw * (.62 + .38 * u); y = hh * (1 - .75 * u)
            box((s * x, y + .006, z), (rng.uniform(.05, .09), .012, rng.uniform(.1, .26)), rng.choice(['armor2', 'armor2', 'armor2', 'dark']), 'hull_plate',
                rot=(s * -.84, [0, 0, 1]))
        if rng.random() < .5:  # belly plating along the keel faces
            y = -hh * rng.uniform(.5, .85)
            x = hw * (.14 + (.78 - .14) * (1 + y / hh) / .62) * .98
            box((s * x, y, z), (.02, rng.uniform(.04, .1), rng.uniform(.06, .18)), rng.choice(PLATE), 'hull_plate',
                rot=(s * -.9, [0, 0, 1]))
for z in np.arange(-4.1, 3.5, .12):
    w, top = tier(z)
    if rng.random() < .5:
        box((rng.uniform(-w + .06, w - .06), top + .008, z), (rng.uniform(.04, .1), .016, rng.uniform(.04, .1)), rng.choice(PLATE), 'greeble')

# side wall belts: armour strakes and window decks
for s in (-1, 1):
    for y, z0, z1 in ((.05, -4.4, 4.7), (-.12, -2.4, 4.7)):
        zs = np.linspace(z0, z1, 30)
        for a, b in zip(zs[:-1], zs[1:]):
            hw, hh = hull_at((a + b) / 2)
            box((s * (side_x((a + b) / 2, y * hh / .5) + .012), y * hh / .5, (a + b) / 2), (.024, .03, b - a + .003), 'dark', 'strake')
    for z in np.arange(-4.4, 4.8, .065):
        hw, hh = hull_at(z)
        for fy in (.15, -.02, -.2):
            if rng.random() < .3: continue
            y = fy * hh / .5 * 1.2
            if 1.15 < z < 3.55 and fy < .1: continue  # hangar bays
            box((s * (side_x(z, y) + .004), y, z), (.008, .02, .04), 'amber' if rng.random() < .1 else 'window', 'window')
# red accent panels (Qin fleet marking)
for s in (-1, 1):
    hw, hh = hull_at(3.9)
    box((s * (side_x(3.9, .2) + .01), .2, 3.9), (.012, .14, .9), 'accent', 'accent_stripe')
    box((s * (side_x(-3.4, .05) + .01), .03, -3.3), (.012, .04, .7), 'accent', 'accent_stripe')

# ---------------------------------------------------------------- the saucer command tower
SZ, SY = 1.05, 1.44
w, top = tier(SZ)
neck = trimesh.convex.convex_hull(np.array(
    [[x, top - .02, SZ + z] for x in (-.3, .3) for z in (-.75, .65)] + [[x, SY - .1, SZ + z] for x in (-.16, .16) for z in (-.32, .28)]))
K.add(neck, 'armor2', 'tower_pylon')
for y in np.arange(top + .08, SY - .3, .1):
    t = (y - top) / (SY - .1 - top); hx = .3 - .14 * t; hz0 = -.75 + .43 * t
    box((0, y, SZ + hz0 - .004), (hx * 1.6, .02, .008), 'window', 'window')
# three stacked armour tiers with recessed window slots between them (a battle bridge, not a dome)
lathe([(0, .32), (.78, .32), (.92, .27), (.95, .2), (.95, .13), (.9, .11), (0, .11)], (0, SY, SZ), 'armor2', 'saucer', 56, axis='y')
lathe([(0, .07), (1.06, .07), (1.14, .03), (1.14, -.06), (1.06, -.1), (0, -.1)], (0, SY, SZ), 'armor', 'saucer', 64, axis='y')
lathe([(0, -.14), (.98, -.14), (.9, -.2), (.55, -.25), (.3, -.29), (0, -.3)], (0, SY, SZ), 'armor2', 'saucer', 56, axis='y')
cyl((0, SY + .068, SZ), (0, SY + .112, SZ), .885, 'dark', 'saucer_slot', 56)
cyl((0, SY - .142, SZ), (0, SY - .098, SZ), 1.0, 'dark', 'saucer_slot', 56)


def ring_of(n, r, y, ext, mat, name, skip=0.0, phase=0.0):
    for i in range(n):
        if rng.random() < skip: continue
        a = 2 * math.pi * (i + phase) / n
        box((r * math.cos(a), SY + y, SZ + r * math.sin(a)), ext, mat, name, rot=(-a, [0, 1, 0]))


# lit window slots: mostly blue, some amber
for i in range(72):
    a = 2 * math.pi * i / 72
    if i % 9 == 0: continue
    box((.888 * math.cos(a), SY + .09, SZ + .888 * math.sin(a)), (.008, .018, .045),
        'amber' if rng.random() < .15 else 'window', 'window', rot=(-a, [0, 1, 0]))
for i in range(84):
    a = 2 * math.pi * (i + .5) / 84
    if i % 7 == 0: continue
    box((1.003 * math.cos(a), SY - .12, SZ + 1.003 * math.sin(a)), (.008, .018, .045),
        'amber' if rng.random() < .1 else 'window', 'window', rot=(-a, [0, 1, 0]))
# armour panels around both rims, and plating on the upper deck
ring_of(48, 1.148, -.015, (.016, .07, .1), 'armor2', 'saucer_plate')
ring_of(16, 1.152, -.015, (.02, .08, .05), 'light', 'saucer_plate', phase=.5)
ring_of(36, .958, .165, (.014, .06, .1), 'armor', 'saucer_plate', skip=.2)
for i in range(30):
    a = 2 * math.pi * (i + .5) / 30
    for r in (.5, .66):
        if rng.random() < .4: continue
        box((r * math.cos(a), SY + .328, SZ + r * math.sin(a)), (rng.uniform(.05, .12), .016, rng.uniform(.04, .08)),
            rng.choice(PLATE), 'saucer_plate', rot=(-a, [0, 1, 0]))
for i in range(8):  # radial deck seams
    a = 2 * math.pi * (i + .5) / 8
    box((.6 * math.cos(a), SY + .322, SZ + .6 * math.sin(a)), (.36, .006, .012), 'dark', 'panel_seam', rot=(-a, [0, 1, 0]))
# angular command block with a forward bridge slit
box((0, SY + .36, SZ + .02), (.52, .08, .6), 'armor', 'command_block')
box((0, SY + .43, SZ + .05), (.36, .07, .4), 'armor2', 'command_block')
box((0, SY + .49, SZ + .1), (.2, .05, .22), 'light', 'command_block')
for zf, w, y in ((-.281, .44, .37), (-.151, .3, .44)):
    box((0, SY + y, SZ + zf), (w, .016, .006), 'amber', 'window_amber')
for s in (-1, 1):
    box((s * .261, SY + .37, SZ + .02), (.006, .016, .44), 'window', 'window')
# point defence around the rim
for i in range(8):
    a = 2 * math.pi * (i + .25) / 8
    sphere((1.02 * math.cos(a), SY + .1, SZ + 1.02 * math.sin(a)), (.04, .03, .04), 'light', 'pd_dome', 1)
# masts and sensor dish on the command block
cyl((0, SY + .52, SZ + .12), (0, SY + .95, SZ + .12), .014, 'light', 'antenna', 6)
cyl((.07, SY + .52, SZ + .17), (.07, SY + .72, SZ + .17), .009, 'light', 'antenna', 6)
cyl((-.07, SY + .52, SZ + .05), (-.07, SY + .66, SZ + .05), .009, 'light', 'antenna', 6)
sphere((0, SY + .96, SZ + .12), (.02, .02, .02), 'red', 'nav_light_top', 1)
lathe([(0, 0), (.09, .03), (.1, .045)], (.17, SY + .47, SZ + .22), 'light', 'sensor_dish', 16, axis='y')
cyl((.17, SY + .46, SZ + .22), (.17, SY + .48, SZ + .22), .015, 'dark', 'sensor_dish', 8)


# ---------------------------------------------------------------- heavy ion cannons
def ion_turret(x, y, z, k=1.0, yaw=0.0):
    cyl((x, y, z), (x, y + .04 * k, z), .15 * k, 'dark', 'turret_base', 16)
    rot = (yaw, [0, 1, 0])
    m = trimesh.creation.box(extents=(.27 * k, .1 * k, .3 * k)); m.apply_transform(rotation_matrix(*rot))
    m.apply_translation((x, y + .09 * k, z + .02 * k)); K.add(m, 'armor2', 'turret_housing')
    m = trimesh.creation.box(extents=(.18 * k, .04 * k, .16 * k)); m.apply_transform(rotation_matrix(*rot))
    m.apply_translation((x, y + .155 * k, z + .05 * k)); K.add(m, 'light', 'turret_housing')
    d = np.array([-math.sin(yaw), 0, -math.cos(yaw)]); side = np.array([math.cos(yaw), 0, -math.sin(yaw)])
    for dx in (-.055, .055):
        o = np.array([x, y + .09 * k, z]) + side * dx * k
        cyl(o + d * .12 * k, o + d * .78 * k, .022 * k, 'black', 'ion_barrel', 10)
        cyl(o + d * .3 * k, o + d * .4 * k, .034 * k, 'dark', 'ion_barrel', 10)
        cyl(o + d * .74 * k, o + d * .79 * k, .03 * k, 'edge', 'ion_muzzle_ring', 10)


ion_turret(0, tier(-3.65)[1], -3.65, .9)
ion_turret(0, tier(-2.85)[1] + .1, -2.85, 1.0)
box((0, tier(-2.85)[1] + .05, -2.85), (.3, .1, .32), 'armor', 'turret_barbette')
for s in (-1, 1):
    for z in (-1.6, -.5):
        ion_turret(s * .62, hull_at(z)[1], z, .85, yaw=s * -.12)
    ion_turret(s * .5, tier(3.05)[1], 3.05, .9, yaw=s * -.35)
ion_turret(0, tier(-1.6)[1] + .1, -1.55, .7)
for s in (-1, 1):  # saucer deck guns
    ion_turret(s * .5, SY + .32, SZ - .35, .6, yaw=s * -.3)

# flank casemates: the row of guns along each side
for s in (-1, 1):
    for z in np.arange(-3.9, -.4, .32):
        y = .14
        x = side_x(z, y)
        box((s * (x + .03), y, z), (.07, .07, .14), 'armor2', 'casemate')
        cyl((s * (x + .05), y, z - .05), (s * (x + .1), y, z - .38), .012, 'black', 'casemate_barrel', 8)

# missile bays on the upper deck
for s in (-1, 1):
    for z in np.arange(-3.3, -2.05, .1):
        for x in (.16, .25):
            if x < tier(z)[0] - .05:
                box((s * x, tier(z)[1] + .004, z), (.06, .008, .07), 'dark', 'missile_hatch')
    for z in np.arange(-.3, .5, .09):
        for x in (.36, .45):
            box((s * x, tier(z)[1] + .004, z), (.06, .008, .06), 'dark', 'missile_hatch')

# point defence along the shoulders
for z in np.arange(-4.4, 4.6, .5):
    hw, hh = hull_at(z)
    for s in (-1, 1):
        p = (s * (hw - .02), hh * .25 + .04, z)
        sphere(p, (.035, .035, .035), 'light', 'pd_dome', 1)
        cyl(p, (p[0] + s * .03, p[1] + .03, p[2] - .07), .006, 'black', 'pd_barrel', 6)

# ---------------------------------------------------------------- carrier bays
for s in (-1, 1):
    for z0, z1 in ((1.2, 2.2), (2.5, 3.5)):
        zc = (z0 + z1) / 2; y = -.06; x = side_x(zc, y)
        box((s * (x + .004), y, zc), (.01, .2, z1 - z0), 'black', 'hangar_well')
        box((s * (x + .008), y, zc), (.01, .15, z1 - z0 - .08), 'hangar', 'hangar_glow')
        for zz in np.arange(z0 + .1, z1 - .05, .14):
            box((s * (x + .011), y, zz), (.012, .16, .015), 'dark', 'hangar_rib')
        box((s * (x + .014), y + .11, zc), (.02, .02, z1 - z0 + .04), 'edge', 'hangar_frame')
        box((s * (x + .014), y - .11, zc), (.02, .02, z1 - z0 + .04), 'edge', 'hangar_frame')
# ventral launch slot along the keel
box((0, -.555, 2.4), (.08, .01, 2.0), 'hangar', 'hangar_glow')

# ---------------------------------------------------------------- drives
def engine(x, y, z0, z1, r):
    cyl((x, y, z0), (x, y, z1), r, 'armor2', 'engine_housing', 28)
    for zz in np.linspace(z0 + .08, z1 - .08, 3):
        cyl((x, y, zz - .015), (x, y, zz + .015), r * 1.05, 'dark', 'engine_band', 28)
    lathe([(r * .96, 0), (r * 1.02, .12), (r * 1.1, .26), (r * .92, .26), (r * .8, .1)], (x, y, z1), 'dark', 'engine_bell')
    lathe([(r * 1.1, .26), (r * 1.13, .27)], (x, y, z1), 'edge', 'engine_lip')
    disk((x, y, z1 + .12), r * .82, 'engine', 'engine_glow')
    disk((x, y, z1 + .02), r * .5, 'engine', 'engine_glow_core')


for y, r in ((.2, .27), (-.15, .24)):
    engine(0, y, 5.0, 5.45, r)
box((0, .02, 5.2), (.75, .7, .4), 'armor2', 'drive_mount')
for s in (-1, 1):
    x = s * 1.45
    loft([(2.3, .08, .08, .03, -.05), (2.7, .3, .3, .1, -.05), (3.2, .38, .38, .12, -.05), (5.2, .38, .38, .12, -.05)], 'armor', 'nacelle')
    PARTS['nacelle'][-1].apply_translation((x, 0, 0))
    lathe([(.25, 0), (.3, .02)], (x, -.05, 2.62), 'edge', 'intake_ring')
    engine(x, -.05, 5.15, 5.5, .34)
    # pylon wing and sweep strut
    K.loft_shape([(1, 0), (0, 1), (-1, 0), (0, -1)], [(2.9, .32, .06, -.04), (4.7, .32, .06, -.04)], 'armor2', 'nacelle_pylon', x0=s * 1.12)
    box((s * 1.12, .03, 3.8), (.5, .02, 1.6), 'dark', 'nacelle_pylon')
    for z in np.arange(3.3, 5.1, .1):
        box((x + s * .384, .05, z), (.008, .02, .04), 'window', 'window')
    box((x + s * .385, -.15, 4.2), (.012, .1, 1.4), 'accent', 'accent_stripe')
    sphere((x + s * .4, -.05, 2.9), (.025, .025, .025), 'red' if s < 0 else 'blue', 'nav_light', 1)
    for zz in (3.0, 3.8, 4.6):
        cyl((x, .33, zz), (x, .41, zz), .05, 'dark', 'nacelle_vent', 10)

# twin dorsal fins
for s in (-1, 1):
    x = s * .42; y0 = hull_at(4.0)[1]
    fin(x, [(y0, 3.5), (y0 + .72, 4.35), (y0 + .78, 4.75), (y0, 4.95)], .05, 'armor', 'dorsal_fin')
    fin(x, [(y0 + .45, 4.08), (y0 + .62, 4.3), (y0 + .62, 4.55), (y0 + .45, 4.42)], .06, 'accent', 'fin_stripe')
    sphere((x, y0 + .8, 4.72), (.02, .02, .02), 'red' if s < 0 else 'blue', 'nav_light', 1)
    cyl((x, y0 + .76, 4.6), (x, y0 + 1.05, 4.75), .008, 'light', 'antenna', 6)

# stern detail
for s in (-1, 1):
    for sy in (-1, 1):
        cyl((s * .55, sy * .25, 4.95), (s * .55, sy * .25, 5.3), .08, 'dark', 'aux_thruster', 12)
        disk((s * .55, sy * .25, 5.301), .06, 'engine', 'aux_glow')

K.export(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'qin-sovereign.glb'))
