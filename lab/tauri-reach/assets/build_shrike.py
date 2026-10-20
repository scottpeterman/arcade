# BR-10 Shrike, the splash-screen model. Rebuilds br10-shrike.glb next to this file.
# pip install trimesh numpy --break-system-packages && python3 build_shrike.py
import numpy as np, trimesh, math, os
from trimesh.transformations import rotation_matrix
scene=trimesh.Scene()
C={'armor':'#727e89','armor2':'#485461','light':'#a6b3bb','dark':'#1b252e','black':'#10171e','glass':'#173c50','edge':'#d3b57e','red':'#cc493b','blue':'#49d9fa','engine':'#e8904d','gold':'#bd9b62'}
counts={}
def add(mesh,mat,name):
 mesh.visual=trimesh.visual.ColorVisuals(mesh,vertex_colors=trimesh.visual.color.hex_to_rgba(C[mat])); k=counts.get(name,0);counts[name]=k+1;scene.add_geometry(mesh,geom_name=f'{name}_{k:03d}')
def box(pos,ext,mat,name,rot=None):
 m=trimesh.creation.box(extents=ext);m.apply_translation(pos) if rot is None else None
 if rot is not None: m.apply_transform(rotation_matrix(rot[0],rot[1]));m.apply_translation(pos)
 add(m,mat,name)
def cyl(a,b,r,mat,name,sections=16,r2=None):
 a=np.array(a);b=np.array(b);d=b-a;L=np.linalg.norm(d)
 m=trimesh.creation.cone(r,L,sections=sections) if r2==0 else trimesh.creation.cylinder(radius=r,height=L,sections=sections)
 m.apply_transform(trimesh.geometry.align_vectors([0,0,1],d));m.apply_translation((a+b)/2);add(m,mat,name)
def sphere(pos,scale,mat,name,sub=2):
 m=trimesh.creation.icosphere(subdivisions=sub,radius=1);m.apply_scale(scale);m.apply_translation(pos);add(m,mat,name)
def prism(points,y0,y1,mat,name):
 # footprint x,z extruded in y
 p=np.array(points,dtype=float);n=len(p);verts=[]
 for y in (y0,y1):
  for x,z in p:verts.append([x,y,z])
 faces=[]
 for i in range(1,n-1):faces.extend([[0,i+1,i],[n,n+i,n+i+1]])
 for i in range(n):j=(i+1)%n;faces.extend([[i,j,n+j],[i,n+j,n+i]])
 add(trimesh.Trimesh(vertices=verts,faces=faces,process=False),mat,name)
def ring(pos,major,minor,mat,name,axis='z'):
 m=trimesh.creation.annulus(r_min=major-minor,r_max=major+minor,height=minor*1.4,sections=28)
 if axis=='z':m.apply_transform(rotation_matrix(math.pi/2,[1,0,0]))
 m.apply_translation(pos);add(m,mat,name)
# 9.3 length, 10.8 wingspan, nose -Z
# stepped, armored fuselage
prism([(-.44,-4.1),(.44,-4.1),(.84,-2.5),(.94,-.5),(.8,2.4),(.44,4.15),(-.44,4.15),(-.8,2.4),(-.94,-.5),(-.84,-2.5)],-.48,.52,'armor','main_hull')
prism([(-.33,-4.48),(.33,-4.48),(.58,-3.7),(-.58,-3.7)],-.22,.22,'light','nose_cap')
prism([(-.72,-2.65),(.72,-2.65),(.82,.6),(-.82,.6)],.52,.73,'armor2','upper_spine')
prism([(-.62,-1.8),(.62,-1.8),(.64,1.5),(-.64,1.5)],-.67,-.49,'dark','ventral_armor')
# armored cheek plates
for s in [-1,1]:
 prism([(s*.7,-3.25),(s*1.05,-2.4),(s*1.07,-.4),(s*.84,.35)],-.35,.2,'armor2','cheek_armor')
 for z in [-2.2,-1.2,0,1.1,2.2]:box((s*.88,-.01,z),(.09,.17,.13),'dark','side_fastener')
# cockpit dark armored canopy and frames
sphere((0,.77,-2.22),(.55,.38,1.06),'glass','canopy',3)
for z in [-2.92,-2.4,-1.83,-1.42]:
 cyl((-.44,.84,z),(.44,.84,z),.027,'light','canopy_rib',8)
for s in [-1,1]:cyl((s*.43,.7,-2.96),(s*.48,.72,-1.4),.035,'light','canopy_rail')
box((0,.98,-1.35),(.84,.14,.35),'armor2','cockpit_armor')
# broad forward swept? A10 straight thick trapezoid wings
for s in [-1,1]:
 prism([(s*.72,-1.65),(s*2.3,-1.6),(s*4.85,-1.05),(s*5.12,-.45),(s*5.0,.18),(s*2.1,.85),(s*.78,.7)],-.32,-.06,'armor','main_wing')
 prism([(s*.9,-1.38),(s*2.4,-1.37),(s*4.62,-.88),(s*4.5,-.65),(s*2.25,-.98)],-.055,-.015,'light','wing_leading_plate')
 prism([(s*1.45,.38),(s*4.4,-.15),(s*4.66,.02),(s*1.5,.65)],-.055,-.012,'armor2','wing_trailing_plate')
 for x in [1.65,2.85,4.0]:
  box((s*x,-.012,-.55),(.035,.015,.64),'dark','wing_panel_seam')
 for x in [2.0,3.4]:
  prism([(s*(x-.35),-.16),(s*(x+.35),-.16),(s*(x+.25),.24),(s*(x-.25),.24)],-.36,-.31,'dark','underwing_hardpoint')
  cyl((s*x,-.49,-.9),(s*x,-.49,.35),.16,'armor2','weapon_pod')
  cyl((s*x,-.49,-1.05),(s*x,-.49,-.9),.08,'dark','weapon_pod_tip')
 # wingtip maneuvering pod
 prism([(s*4.85,-1.06),(s*5.43,-.83),(s*5.46,-.08),(s*4.98,.19)],-.33,.02,'armor2','wingtip_pod')
 box((s*5.39,-.12,-.37),(.09,.1,.45),'red' if s<0 else 'blue','nav_light')
 # stabilizer
 prism([(s*.65,2.55),(s*2.1,2.65),(s*2.5,3.65),(s*.65,3.65)],.06,.21,'armor','tailplane')
 # twin vertical tails: custom yz polygon extruded x
 x=s*2.22
 yz=[(0.2,2.7),(1.52,3.18),(1.42,3.86),(.18,3.74)]
 vertices=[]
 for xx in [x-.07,x+.07]:
  for y,z in yz:vertices.append([xx,y,z])
 faces=[[0,2,1],[0,3,2],[4,5,6],[4,6,7]]
 for i in range(4):j=(i+1)%4;faces.extend([[i,j,4+j],[i,4+j,4+i]])
 add(trimesh.Trimesh(vertices=vertices,faces=faces,process=False),'armor2','vertical_tail')
 box((x,1.07,3.58),(.17,.11,.36),'edge','tail_marking')
# elevated twin engine nacelles
for s in [-1,1]:
 x=s*1.38;y=.86
 box((x,.46,1.55),(.27,.62,1.75),'armor2','engine_pylon')
 cyl((x,y,.32),(x,y,3.42),.53,'armor','engine_nacelle',24)
 cyl((x,y,.12),(x,y,.5),.45,'dark','engine_front',24)
 ring((x,y,.1),.48,.065,'light','intake_lip')
 cyl((x,y,3.32),(x,y,3.77),.46,'dark','exhaust_housing',24)
 ring((x,y,3.75),.42,.055,'edge','exhaust_ring')
 cyl((x,y,3.76),(x,y,3.8),.31,'engine','engine_glow',24)
 for i in range(12):
  a=2*math.pi*i/12
  cyl((x+.42*math.cos(a),y+.42*math.sin(a),.18),(x+.15*math.cos(a),y+.15*math.sin(a),.32),.024,'dark','intake_fan',6)
 for z in [.72,1.4,2.15,2.8]:ring((x,y,z),.54,.023,'armor2','nacelle_band')
 for a in [-.75,.75]:
  cyl((x+.49*math.cos(a),y+.49*math.sin(a),.7),(x+.49*math.cos(a),y+.49*math.sin(a),3.0),.036,'light','engine_cooling_line',8)
# huge multi-barrel chin cannon, offset slightly right
cx=.19;cy=-.36
cyl((cx,cy,-5.16),(cx,cy,-3.8),.26,'dark','cannon_shroud',20)
ring((cx,cy,-5.1),.29,.05,'edge','cannon_muzzle_ring')
for i in range(7):
 a=2*math.pi*i/7;x=cx+.17*math.cos(a);y=cy+.17*math.sin(a)
 cyl((x,y,-5.7),(x,y,-4.55),.055,'black','rotary_barrel',10)
 ring((x,y,-5.68),.063,.014,'light','barrel_tip')
for z in [-5.1,-4.7]:ring((cx,cy,z),.21,.045,'armor2','cannon_brace')
# panel striping and tactical markings
for s in [-1,1]:
 box((s*2.35,-.005,-.55),(.5,.012,.09),'edge','wing_stripe')
 box((s*2.35,-.005,-.35),(.5,.012,.04),'edge','wing_stripe')
 for z in [-.5,.0,.5]:box((s*.68,.74,z),(.05,.018,.22),'dark','spine_vent')
# underside maneuver thrusters
for s in [-1,1]:
 for z in [-2.5,2.55]:
  cyl((s*.76,-.58,z),(s*.76,-.76,z),.14,'dark','rcs_socket',12)
  sphere((s*.76,-.77,z),(.105,.045,.105),'blue','rcs_emitter',1)
# small recessed access panels
for s in [-1,1]:
 for z in [-.5,.3,1.1,1.9]:box((s*.51,.745,z),(.28,.014,.33),'armor2','dorsal_access_panel')
# details on rear center
for x in [-.45,0,.45]:
 cyl((x,.14,3.5),(x,.14,4.05),.12,'dark','aft_aux_thruster')
 cyl((x,.14,4.06),(x,.14,4.09),.085,'blue','aft_aux_glow')
scene.export(os.path.join(os.path.dirname(os.path.abspath(__file__)),'br10-shrike.glb'))
print('meshes',sum(counts.values()),'triangles',sum(len(g.faces) for g in scene.geometry.values()))
