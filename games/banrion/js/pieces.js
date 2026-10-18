// banrion/js/pieces.js
//
// Banrion — 3D wireframe chess.  Copyright (C) 2026 Scott Peterman
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.  It is distributed WITHOUT ANY WARRANTY; without even
// the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
// PURPOSE.  See the GNU General Public License for more details.
// You should have received a copy of the GPL along with this program; if not,
// see <https://www.gnu.org/licenses/>.  Vendored components keep their own
// licences — see THIRD-PARTY-NOTICES.md.
//
// Piece geometry, lifted from piece_lab.html. This is the SHIPPING copy: the
// lab stays the tuning tool, and its EXPORT output is baked in here as data.
// Nothing in this file reads the DOM or knows about the game.
//
// Every piece except the knight is a surface of revolution -- a [radius,height]
// profile lathed around Y. The knight is a flat plate with rounded edges: the
// silhouette carries the shape, a quarter-round bevel sweeps out to each face,
// and faceRings() meshes the flat sides.
//
//   Pieces.build()            -> rebuild all six meshes at the current density
//   Pieces.geo[name]          -> Float array of segments, 6 numbers per segment
//   Pieces.lo[name]           -> low-detail mesh, for reflections
//   Pieces.DENSITY            -> { meridians, ringSegs, ringEvery }
//   Pieces.DENSITY_BY[name]   -> per-piece overrides (the knight needs far less)

(function (global) {
'use strict';

// Baked from the lab's EXPORT. Re-export from piece_lab.html and paste here to
// change the pieces; do not hand-edit numbers in two places.
//
// DENSITY is mutable at runtime (Pieces.setDensity, driven by the VISUALS
// panel). Three constants doing three different jobs — collapsing them is what
// makes this confusing later:
//
//   DENSITY  the live value. Ships at 8 meridians: judged on screen, not
//            derived. Past that the extra lines fill the piece in and it reads
//            as a solid blob at board scale, which is the opposite of what a
//            wireframe is for. Costing fewer segments is a side effect.
//   BASE     what RESET goes back to — the shipped default.
//   TUNED    what the per-piece overrides were measured AGAINST, and the
//            denominator of the ratio that scales them. Never a target and
//            never reset to. The knight's 8-against-18 was not an absolute
//            preference, it was "a plate needs a bit under half what a lathe
//            needs", so the override rides the global instead of pinning one
//            piece while the other five move around it.
const DENSITY    = { meridians:8, ringSegs:26, ringEvery:1 };
const DENSITY_BY = { knight:{ meridians:8 } };
const TUNED      = { meridians:18, ringSegs:26, ringEvery:1 };
const BASE       = Object.assign({}, DENSITY);

// Degrees the knight is turned from the file axis toward the opponent.
// See EXTRAS.knight for why this is a dial and not a constant.
// 35 is a judged value, not a derived one: a flat plate turned much past 60
// presents its edge to the player and stops reading as a horse at all, which
// costs more than the piece gains by pointing dead ahead.
let KNIGHT_YAW   = 35;
const BASE_YAW   = KNIGHT_YAW;
const BASE_BY    = JSON.parse(JSON.stringify(DENSITY_BY));

/* ============================================================
   PROFILE BUILDERS
   A profile is an ordered list of [radius, height] from the base
   up. Rotate it around Y and you have the piece.
   ============================================================ */
function ln(p,r1,y1,n){ const [r0,y0]=p[p.length-1];
  for(let i=1;i<=n;i++){ const t=i/n; p.push([r0+(r1-r0)*t, y0+(y1-y0)*t]); } return p; }
function arc(p,cr,cy,rad,a0,a1,n){
  for(let i=1;i<=n;i++){ const t=i/n,a=a0+(a1-a0)*t;
    p.push([cr+Math.cos(a)*rad, cy+Math.sin(a)*rad]); } return p; }
const D=Math.PI/180;

function baseFlare(r){ // shared plinth every piece stands on
  const p=[[0,0]];
  ln(p,r,0,2); ln(p,r,0.045,1); ln(p,r*0.87,0.075,1); ln(p,r*0.70,0.115,2);
  return p;
}

const DEFAULTS = {
  pawn(){ const p=baseFlare(0.27);
    ln(p,0.115,0.235,3); ln(p,0.098,0.40,3);
    ln(p,0.175,0.445,1); ln(p,0.175,0.475,1); ln(p,0.115,0.515,1);
    arc(p,0,0.645,0.145,-72*D,90*D,7); return p; },

  rook(){ const p=baseFlare(0.30);
    ln(p,0.185,0.20,2); ln(p,0.175,0.60,4);
    ln(p,0.235,0.665,1); ln(p,0.255,0.70,1); ln(p,0.255,0.90,2);
    ln(p,0.185,0.90,1); ln(p,0.185,0.74,1); ln(p,0,0.74,1); return p; },

  knight(){ const p=[[0,0]];
    ln(p,0.305,0.000,2); ln(p,0.305,0.046,1); ln(p,0.280,0.070,1);
    ln(p,0.218,0.118,2); ln(p,0.202,0.162,1);
    ln(p,0.232,0.205,1); ln(p,0.264,0.238,1); ln(p,0.275,0.256,1);
    return p; },   // collar sized to the plate's flared foot — head is in EXTRAS

  bishop(){ const p=baseFlare(0.275);
    ln(p,0.145,0.24,3); ln(p,0.115,0.50,3);
    ln(p,0.185,0.545,1); ln(p,0.185,0.575,1); ln(p,0.12,0.615,1);
    arc(p,0,0.78,0.165,-70*D,62*D,7);
    ln(p,0.055,0.945,1); arc(p,0,0.985,0.062,-60*D,90*D,4); return p; },

  queen(){ const p=baseFlare(0.315);
    ln(p,0.20,0.235,3); ln(p,0.135,0.60,4);
    ln(p,0.215,0.66,1); ln(p,0.215,0.695,1); ln(p,0.155,0.735,1);
    ln(p,0.255,0.98,4); ln(p,0.255,1.03,1); ln(p,0.205,1.055,1);
    ln(p,0.075,1.075,1); arc(p,0,1.125,0.072,-60*D,90*D,4); return p; },

  king(){ const p=baseFlare(0.325);
    ln(p,0.21,0.245,3); ln(p,0.14,0.66,4);
    ln(p,0.225,0.725,1); ln(p,0.225,0.765,1); ln(p,0.16,0.805,1);
    ln(p,0.245,1.06,4); ln(p,0.245,1.115,1); ln(p,0.185,1.145,1);
    ln(p,0.085,1.165,1); ln(p,0.05,1.20,1); return p; }   // cross is in EXTRAS
};

const PIECES=['pawn','knight','bishop','rook','queen','king'];
let PROFILES={}; PIECES.forEach(k=>PROFILES[k]=DEFAULTS[k]());

/* ---------- plate primitives (used by the knight) ----------
   A Staunton knight is not an anatomical horse — it is a flat plate with rounded
   edges. The silhouette carries all the shape; thickness is added by sweeping a
   quarter-round bevel from the mid-plane out to each flat face. Ears are part of
   the outline, not separate appendages. */

// Split any outline edge longer than maxLen. Keeps corners sharp (they stay
// vertices) while adding density along the long smooth runs.
function densify(pts, maxLen){
  const out=[];
  for(let i=0;i<pts.length;i++){
    const a=pts[i], b=pts[(i+1)%pts.length];
    out.push(a.slice());
    const n=Math.ceil(Math.hypot(b[0]-a[0], b[1]-a[1])/maxLen);
    for(let k=1;k<n;k++){
      const t=k/n, row=[];
      for(let c=0;c<a.length;c++) row.push(a[c]+(b[c]-a[c])*t);
      out.push(row);
    }
  }
  return out;
}

// Outward normal at each outline vertex, orientation derived from signed area
// so the bevel always insets rather than flaring.
function outlineNormals(pts){
  const n=pts.length; let area=0;
  for(let i=0;i<n;i++){ const a=pts[i], b=pts[(i+1)%n]; area += a[0]*b[1]-b[0]*a[1]; }
  const sgn = area>0 ? 1 : -1;
  const N=[];
  for(let i=0;i<n;i++){
    const p=pts[(i-1+n)%n], c=pts[i], q=pts[(i+1)%n];
    const e1x=c[0]-p[0], e1y=c[1]-p[1], m1=Math.hypot(e1x,e1y)||1;
    const e2x=q[0]-c[0], e2y=q[1]-c[1], m2=Math.hypot(e2x,e2y)||1;
    let vx=(e1y/m1+e2y/m2)*sgn, vy=(-e1x/m1-e2x/m2)*sgn;
    const m=Math.hypot(vx,vy)||1;
    N.push([vx/m, vy/m]);
  }
  return N;
}

// outline row: [x, y, halfThickness, bevelRadius]
// At phi=0 the loop sits on the silhouette; at phi=+-90 it is on the flat face,
// inset by the bevel radius. Sweeping phi gives the rounded edge.
function plateLoops(pts, PHI, P){
  const N=outlineNormals(pts), loops=[];
  for(const phi of PHI){
    const si=Math.sin(phi), co=Math.cos(phi), loop=[];
    for(let i=0;i<pts.length;i++){
      const c=pts[i], nrm=N[i], inset=c[3]*(1-co);
      loop.push(P(c[0]-nrm[0]*inset, c[1]-nrm[1]*inset, c[2]*si));
    }
    loops.push(loop);
  }
  return loops;
}

function segOK(a,b){
  const dx=a[0]-b[0], dy=a[1]-b[1], dz=a[2]-b[2];
  return dx*dx+dy*dy+dz*dz > 1e-7;      // drop hairs where a mesh converges
}
function emitLoops(loops, out, seg, closed){
  for(const L of loops){
    const n = closed===false ? L.length-1 : L.length;
    for(let i=0;i<n;i++){ const a=L[i], b=L[(i+1)%L.length]; if(segOK(a,b)) seg(out,...a,...b); }
  }
  for(let j=0;j<loops.length-1;j++)
    for(let i=0;i<loops[j].length;i++){
      const a=loops[j][i], b=loops[j+1][i]; if(segOK(a,b)) seg(out,...a,...b);
    }
}

/* ---------- flat-face mesh ----------
   The bevel only wraps the rim; without this the two flat sides are empty and
   the piece reads as a hollow ribbon. These are contour rings marching inward
   from the rim toward the medial axis, plus the rungs between them — the same
   ladder pattern as the bevel, continued across the face. */

function ptInPoly(poly,x,y){
  let c=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const yi=poly[i][1], yj=poly[j][1];
    if((yi>y)!==(yj>y) && x < (poly[j][0]-poly[i][0])*(y-yi)/(yj-yi+1e-12)+poly[i][0]) c=!c;
  }
  return c;
}

// Distance from vertex i, along (nx,ny), to the first edge on the far side.
function rayWidth(poly,i,nx,ny){
  const n=poly.length, px=poly[i][0], py=poly[i][1];
  let best=Infinity;
  for(let j=0;j<n;j++){
    const k=(j+1)%n;
    if(j===i || j===(i-1+n)%n || k===i) continue;
    const ax=poly[j][0], ay=poly[j][1], ex=poly[k][0]-ax, ey=poly[k][1]-ay;
    const den=nx*ey-ny*ex; if(Math.abs(den)<1e-12) continue;
    const t=((ax-px)*ey-(ay-py)*ex)/den;
    const u=((ax-px)*ny-(ay-py)*nx)/den;
    if(t>1e-4 && u>=-1e-6 && u<=1+1e-6 && t<best) best=t;
  }
  return isFinite(best)?best:0;
}

function smoothLoop(loop,iters,k){
  const n=loop.length;
  for(let it=0;it<iters;it++){
    const nl=[];
    for(let i=0;i<n;i++){
      const a=loop[(i-1+n)%n], b=loop[i], c=loop[(i+1)%n];
      nl.push([b[0]*(1-k)+(a[0]+c[0])*0.5*k, b[1]*(1-k)+(a[1]+c[1])*0.5*k]);
    }
    loop=nl;
  }
  return loop;
}

// Every vertex travels the same FRACTION of its own local half-width, so the
// rings stay evenly graded and the innermost one settles near the middle
// instead of overshooting into a tangle. Vertex count is preserved, which is
// what makes the rungs a straight index pairing.
function faceRings(outline,count){
  const N=outlineNormals(outline), n=outline.length;
  let W=new Array(n);
  for(let i=0;i<n;i++){
    const nx=-N[i][0], ny=-N[i][1];
    // at a reflex vertex the inward normal points into open air; a ray from
    // there would leap the notch and drag a ring across it.
    W[i]= ptInPoly(outline, outline[i][0]+nx*1e-3, outline[i][1]+ny*1e-3)
        ? rayWidth(outline,i,nx,ny)*0.5 : 0;
  }
  for(let p=0;p<4;p++){            // smooth the width field, not the points
    const V=new Array(n);
    for(let i=0;i<n;i++)
      V[i]=Math.min(W[(i-1+n)%n],W[i],W[(i+1)%n])*0.34 + W[i]*0.66;
    W=V;
  }
  const rings=[];
  for(let r=1;r<=count;r++){
    const f=r/(count+1);
    const ring=[];
    for(let i=0;i<n;i++)
      ring.push([outline[i][0]-N[i][0]*W[i]*f, outline[i][1]-N[i][1]*W[i]*f]);
    rings.push(smoothLoop(ring,1+r,0.4));
  }
  return rings;
}

/* ---------- non-lathe details ---------- */
const EXTRAS = {
  rook(out,seg){ // crenellations: alternating merlons around the rim
    const n=8, rOut=0.255, rIn=0.185, y0=0.74, y1=0.90;
    for(let i=0;i<n;i++){
      const a=(i/n)*Math.PI*2, a2=((i+0.5)/n)*Math.PI*2;
      if(i%2===0){
        seg(out, rOut*Math.cos(a),y0,rOut*Math.sin(a), rOut*Math.cos(a),y1,rOut*Math.sin(a));
        seg(out, rIn*Math.cos(a),y0,rIn*Math.sin(a), rIn*Math.cos(a),y1,rIn*Math.sin(a));
        seg(out, rOut*Math.cos(a),y1,rOut*Math.sin(a), rIn*Math.cos(a),y1,rIn*Math.sin(a));
      }
      seg(out, rOut*Math.cos(a2),y0,rOut*Math.sin(a2), rIn*Math.cos(a2),y0,rIn*Math.sin(a2));
    }
  },
  king(out,seg){ // the cross
    const y=1.20, h=0.19, w=0.085, t=0.030;
    const bar=(ax,az)=>{
      seg(out,-w*ax,y+h*0.58,-w*az,  w*ax,y+h*0.58, w*az);
      seg(out,-w*ax,y+h*0.58+t,-w*az, w*ax,y+h*0.58+t, w*az);
      seg(out,-w*ax,y+h*0.58,-w*az, -w*ax,y+h*0.58+t,-w*az);
      seg(out, w*ax,y+h*0.58, w*az,  w*ax,y+h*0.58+t, w*az);
    };
    for(const [ax,az] of [[1,0],[0,1]]){
      seg(out,-t*ax*0.6,y,-t*az*0.6, -t*ax*0.6,y+h,-t*az*0.6);
      seg(out, t*ax*0.6,y, t*az*0.6,  t*ax*0.6,y+h, t*az*0.6);
      seg(out,-t*ax*0.6,y+h,-t*az*0.6, t*ax*0.6,y+h, t*az*0.6);
      bar(ax,az);
    }
  },
  bishop(out,seg){ // the mitre slit
    const pts=[];
    for(let i=0;i<=10;i++){ const t=i/10, a=(-58+116*t)*D;
      pts.push([Math.cos(a)*0.166*0.62, 0.78+Math.sin(a)*0.166, 0]); }
    for(let i=1;i<pts.length;i++)
      seg(out,pts[i-1][0],pts[i-1][1],pts[i-1][2],pts[i][0],pts[i][1],pts[i][2]);
  },
  queen(out,seg){ // crown points
    const n=8, r=0.255, y0=1.03, y1=1.115;
    for(let i=0;i<n;i++){
      const a=(i/n)*Math.PI*2;
      seg(out, r*Math.cos(a),y0,r*Math.sin(a), r*0.62*Math.cos(a),y1,r*0.62*Math.sin(a));
      const a2=((i+1)/n)*Math.PI*2;
      seg(out, r*0.62*Math.cos(a),y1,r*0.62*Math.sin(a), r*0.62*Math.cos(a2),y1,r*0.62*Math.sin(a2));
    }
  },
  knight(out,seg,opt){
    // Silhouette traced off the reference render: long muzzle that drops
    // forward and down, deep open throat, near-vertical crest, stubby ears.
    const s=0.720, x0=0.002, y0=0.232;   // x0 centres the FOOT on the axis, not
                                         // the whole silhouette — otherwise the
                                         // piece sits off-centre in its collar
    // The silhouette is traced in a flat x/y plane with the muzzle at +x, and
    // the plate is quartered out to +-z. That is the natural way to DRAW it and
    // the wrong way to STAND it on a board: files run +x, so a knight built in
    // the tracing frame faces sideways across the board.
    //
    // KNIGHT_YAW turns the tracing frame about Y on the way out, measured from
    // the file axis: 0 leaves the full profile facing sideways, 90 points the
    // muzzle straight down the ranks at the opponent. Both extremes cost
    // something on a FLAT plate — at 0 the piece is aimed at nobody, at 90 it
    // is edge-on to the player and stops reading as a horse at all — so this is
    // a taste dial, not a constant. Rotate here, at the one place every knight
    // vertex passes through, rather than teaching the silhouette table about
    // the board. White then faces +z toward Black, and the z-mirror that
    // setPosition already applies to Black turns its knights around to face
    // back.
    const a=KNIGHT_YAW*Math.PI/180, ca=Math.cos(a), sa=Math.sin(a);
    const P=(x,y,z)=>{ const u=x0+x*s, t=z*s;
      return [u*ca - t*sa, y0+y*s, u*sa + t*ca]; };

    // [x, y, halfThickness, bevel] — +x is the muzzle direction, y up from the
    // collar. Wound rear-ear -> crest -> foot -> chest -> throat -> jaw ->
    // muzzle -> face -> front-ear.
    const SIL=[
      [ 0.142, 1.010, 0.026, 0.012], // rear ear, tip
      [ 0.130, 1.008, 0.026, 0.012],
      [ 0.110, 0.981, 0.046, 0.020], // rear ear, base
      [ 0.069, 0.897, 0.086, 0.036], // poll
      [-0.054, 0.856, 0.112, 0.044],
      [-0.127, 0.812, 0.126, 0.046], // crest, upper
      [-0.171, 0.775, 0.134, 0.048],
      [-0.233, 0.707, 0.142, 0.050], // crest, mid
      [-0.286, 0.616, 0.148, 0.050],
      [-0.326, 0.513, 0.152, 0.052], // crest, lower
      [-0.345, 0.425, 0.155, 0.052],
      [-0.348, 0.263, 0.157, 0.052], // back
      [-0.338, 0.163, 0.158, 0.052],
      [-0.308, 0.028, 0.166, 0.052], // foot, back shoulder
      [-0.340,-0.045, 0.185, 0.040], // foot, back — flares into the collar
      [ 0.335,-0.045, 0.185, 0.040], // foot, front
      [ 0.318,-0.008, 0.172, 0.048],
      [ 0.296, 0.046, 0.162, 0.050], // foot, front shoulder
      [ 0.245, 0.124, 0.150, 0.048], // chest, lower
      [ 0.228, 0.151, 0.146, 0.048],
      [ 0.147, 0.281, 0.132, 0.046], // chest, mid
      [ 0.100, 0.388, 0.120, 0.044], // throat
      [ 0.095, 0.437, 0.112, 0.042], // throat notch
      [ 0.127, 0.440, 0.108, 0.040],
      [ 0.157, 0.427, 0.104, 0.040],
      [ 0.223, 0.418, 0.098, 0.038], // jaw, back
      [ 0.301, 0.374, 0.088, 0.034], // jaw, mid
      [ 0.330, 0.312, 0.082, 0.032], // jowl
      [ 0.377, 0.288, 0.076, 0.030], // chin
      [ 0.419, 0.293, 0.072, 0.030],
      [ 0.460, 0.310, 0.068, 0.028], // lip
      [ 0.482, 0.330, 0.064, 0.026],
      [ 0.507, 0.391, 0.060, 0.024], // nose, front
      [ 0.507, 0.423, 0.060, 0.024],
      [ 0.485, 0.467, 0.064, 0.026], // nose, top corner
      [ 0.345, 0.667, 0.082, 0.034], // bridge, lower
      [ 0.335, 0.724, 0.086, 0.036], // bridge, upper
      [ 0.272, 0.778, 0.092, 0.038], // brow
      [ 0.235, 0.836, 0.096, 0.038], // forehead
      [ 0.237, 0.917, 0.056, 0.024], // front ear, leading edge
      [ 0.225, 0.981, 0.028, 0.012], // front ear, tip
      [ 0.208, 0.988, 0.026, 0.012],
      [ 0.191, 0.968, 0.040, 0.018],
      [ 0.162, 0.968, 0.046, 0.020]  // notch between the ears
    ];

    // The knight is not a lathe, so wire it to the same sliders by hand:
    // RING SEGS drives outline density, MERIDIANS drives how many bands wrap
    // the rim and how many rings cross each flat face.
    // opt is always supplied by buildPiece; DENSITY is the fallback because
    // there is no TUNE in this file (the lab's name for it survived the lift
    // and would have thrown a ReferenceError the first time opt was omitted).
    const M  = opt?opt.meridians:DENSITY.meridians;
    const RS = opt?opt.ringSegs :DENSITY.ringSegs;
    const cl=(v,a,b)=>v<a?a:v>b?b:v;
    const NB = cl(Math.round(M*0.5)+1, 4, 12);   // bevel bands, rim to face
    const NF = cl(Math.round(M*0.35),  2,  8);   // contour rings per face
    const OUT=densify(SIL, 1.45/RS);

    const PHI=[]; for(let i=0;i<NB;i++) PHI.push(-Math.PI/2 + i*Math.PI/(NB-1));
    emitLoops(plateLoops(OUT, PHI, P), out, seg);

    // flat faces: rim outline (the phi=+-90 loop) then rings inward
    const N=outlineNormals(OUT), flat=[];
    for(let i=0;i<OUT.length;i++)
      flat.push([OUT[i][0]-N[i][0]*OUT[i][3], OUT[i][1]-N[i][1]*OUT[i][3]]);
    const rings=faceRings(flat, NF);
    for(const sd of [1,-1]){
      const chain=[flat.map((p,i)=>P(p[0],p[1],sd*OUT[i][2]))];
      for(const r of rings)
        chain.push(r.map((p,i)=>P(p[0],p[1],sd*OUT[i][2]*0.985)));
      emitLoops(chain, out, seg);
    }

    // the few marks the mesh can't imply. Thickness looked up from the nearest
    // outline vertex so a line never floats off the surface it belongs to.
    const wAt=(x,y)=>{ let best=1e9, w=0.1;
      for(const c of SIL){ const d=(c[0]-x)**2+(c[1]-y)**2; if(d<best){ best=d; w=c[2]; } }
      return w*0.7; };
    const fline=(a,b,sd)=>{ const w=Math.min(wAt(a[0],a[1]), wAt(b[0],b[1]))*sd;
      seg(out,...P(a[0],a[1],w),...P(b[0],b[1],w)); };
    const fring=(cx,cy,rx,ry,n,sd)=>{ const w=wAt(cx,cy)*sd, p=[];
      for(let i=0;i<n;i++){ const a=(i/n)*Math.PI*2;
        p.push(P(cx+Math.cos(a)*rx, cy+Math.sin(a)*ry, w)); }
      for(let i=0;i<n;i++) seg(out,...p[i],...p[(i+1)%n]);
    };
    for(const sd of [1,-1]){
      fring(0.300,0.700,0.032,0.026,8, sd);     // eye
      fring(0.470,0.415,0.020,0.024,6, sd);     // nostril
      fline([0.487,0.360],[0.402,0.330], sd);   // mouth
      fline([0.272,0.778],[0.223,0.418], sd);   // cheek, back edge
    }
  }
};

/* ============================================================
   GEOMETRY
   ============================================================ */
function pushSeg(a,x0,y0,z0,x1,y1,z1){ a.push(x0,y0,z0,x1,y1,z1); }

function buildPiece(name, opt){
  const prof=PROFILES[name], out=[];
  const M=opt.meridians, RS=opt.ringSegs, RE=opt.ringEvery;

  // meridians: the profile itself, repeated around the axis
  for(let m=0;m<M;m++){
    const a=(m/M)*Math.PI*2, ca=Math.cos(a), sa=Math.sin(a);
    for(let i=1;i<prof.length;i++){
      const [r0,y0]=prof[i-1], [r1,y1]=prof[i];
      pushSeg(out, r0*ca,y0,r0*sa, r1*ca,y1,r1*sa);
    }
  }
  // latitude rings
  for(let i=0;i<prof.length;i+=RE){
    const [r,y]=prof[i]; if(r<0.012) continue;
    for(let s=0;s<RS;s++){
      const a0=(s/RS)*Math.PI*2, a1=((s+1)/RS)*Math.PI*2;
      pushSeg(out, r*Math.cos(a0),y,r*Math.sin(a0), r*Math.cos(a1),y,r*Math.sin(a1));
    }
  }
  if(EXTRAS[name]) EXTRAS[name](out,pushSeg,opt);
  return out;
}

function geoFor(name){
  const o = DENSITY_BY[name];
  return o ? Object.assign({}, DENSITY, o) : DENSITY;
}
function loFor(name, detail){
  const g = geoFor(name), d = Math.max(0.12, detail);
  return { meridians : Math.max(4, Math.round(g.meridians*d)),
           ringSegs  : Math.max(6, Math.round(g.ringSegs *d)),
           ringEvery : Math.max(1, Math.round(g.ringEvery/d)) };
}

const Pieces = {
  PIECES, DENSITY, DENSITY_BY,
  geo: {}, lo: {},
  // chess.js piece letters -> our profile names
  NAME: { p:'pawn', n:'knight', b:'bishop', r:'rook', q:'queen', k:'king' },

  BASE, BASE_YAW,
  get knightYaw(){ return KNIGHT_YAW; },
  setKnightYaw(deg){ KNIGHT_YAW = Math.min(90, Math.max(0, +deg||0)); return KNIGHT_YAW; },

  // Change the global density. Per-piece overrides are scaled by the same
  // factor so a tuned relationship survives the slider. Does NOT rebuild --
  // the caller decides when to pay for that (and, on GL, when to re-upload).
  setDensity(next){
    for (const k of ['meridians','ringSegs','ringEvery'])
      if (next && next[k] !== undefined) DENSITY[k] = next[k];
    for (const name in BASE_BY){
      const base = BASE_BY[name], cur = DENSITY_BY[name];
      for (const k in base)
        cur[k] = Math.max(4, Math.round(base[k] * DENSITY[k] / TUNED[k]));
    }
    return DENSITY;
  },

  build(detail){
    for (const k of PIECES){
      this.geo[k] = buildPiece(k, geoFor(k));
      this.lo[k]  = buildPiece(k, loFor(k, detail === undefined ? 0.45 : detail));
    }
    return this;
  },
  segCount(){
    let n = 0; for (const k of PIECES) n += this.geo[k].length / 6; return n;
  }
};

// Run the override scaling once at load. Without this the boot state and the
// state after touching the slider differ: the knight would ship at its raw
// tuned 8 and drop to 4 the first time the global was nudged and put back.
Pieces.setDensity({});

global.Pieces = Pieces;
})(window);