// Exponential height fog for every fogged material, keeping three's FogExp2 semantics.
//
// Long Wind integrates exponential height fog exactly along each view ray (src/core/atmosphere.js,
// wx_applyAtmosphereT, github.com/jbang2004/long-wind, MIT). This brings the same integral to stock three.js: the
// global fog chunks are patched so FogExp2 uses an *effective* distance, the view depth times the mean of
// exp(-h / H) along the ray. At sea level nothing changes. From altitude, looking down or across, the air is
// thinner, so the sea under a climbing aircraft clears up and the horizon haze thins with height, as real
// boundary-layer haze does.
//
//   installHeightFog(THREE, { seaY: -80, scale: 1100 })   — call once, BEFORE anything compiles (first lines of the app)
//   heightFogRatio(y) → exp(-(y - seaY) / scale)          — the fog density ratio at height y. Hosts that add a
//                                                          uniform local fog (e.g. a whiteout inside a cloud) divide
//                                                          that extra density by this ratio at the camera to keep it
//                                                          full strength.
// Works on any material that includes three's fog chunks (built-ins, Sprites, Points, and ShaderMaterials that
// include <fog_pars_vertex>/<fog_vertex> with a `mvPosition`). Linear Fog (THREE.Fog) is left untouched.
// The chunks are identical in three r161 and r186; install throws if the anchors aren't found.
let state = null;

export function installHeightFog(THREE, { seaY = 0, scale = 1000 } = {}) {
  const C = THREE.ShaderChunk;
  if (!state) state = { pv: C.fog_pars_vertex, v: C.fog_vertex, pf: C.fog_pars_fragment, f: C.fog_fragment };
  const need = (src, anchor, name) => { if (!src.includes(anchor)) throw new Error(`installHeightFog: ${name} chunk not recognised`); };
  need(state.v, 'vFogDepth = - mvPosition.z;', 'fog_vertex');
  need(state.f, 'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );', 'fog_fragment');
  const S = Number(seaY).toFixed(3), H = Math.max(1, Number(scale)).toFixed(3);
  C.fog_pars_vertex = state.pv.replace('varying float vFogDepth;', 'varying float vFogDepth;\n\tvarying float vFogWorldY;');
  C.fog_vertex = state.v.replace('vFogDepth = - mvPosition.z;',
    'vFogDepth = - mvPosition.z;\n\tvFogWorldY = dot( viewMatrix[ 1 ].xyz, mvPosition.xyz - viewMatrix[ 3 ].xyz );');
  C.fog_pars_fragment = state.pf.replace('varying float vFogDepth;', 'varying float vFogDepth;\n\tvarying float vFogWorldY;');
  C.fog_fragment = state.f.replace(
    'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
    `float lwH0 = max( cameraPosition.y - ${S}, 0.0 ), lwH1 = max( vFogWorldY - ${S}, 0.0 );
		float lwE0 = exp( - lwH0 / ${H} ), lwE1 = exp( - lwH1 / ${H} ), lwDh = lwH1 - lwH0;
		float lwRatio = abs( lwDh ) > 1.0 ? ${H} * ( lwE0 - lwE1 ) / lwDh : lwE0;
		float lwD = vFogDepth * lwRatio;
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * lwD * lwD );`);
  state.seaY = seaY; state.scale = Math.max(1, scale);
  return { seaY, scale: state.scale };
}

export function heightFogRatio(y) {
  if (!state || state.scale === undefined) return 1;
  return Math.exp(-Math.max(y - state.seaY, 0) / state.scale);
}
