// Leaf lighting for stock three.js materials: back-lit translucency and wrap light from the *shadowed* sun.
//
// From 长风 Long Wind (github.com/jbang2004/long-wind, MIT, (c) 2026 jbang2004): src/world/foliage.js (sunTermsSetup,
// FOLIAGE_NORMAL_BEGIN) and the leaf shader in src/world/trees.js. The brightest directional light is captured inside
// three's light loop right before RE_Direct, after its shadow map (and the cloud shadow, if cloudShadow.js patched the
// same material) has been applied. So leaves only glow where sunlight actually reaches them. Then:
//   sunBack — looking toward the sun through the leaf: pow(dot(-view, sun), 4), warm and saturated (transmitted light)
//   sunWrap — light from behind the leaf surface wraps through it (no hard terminator on thin foliage)
//   glow    — a little constant self-light, so deep canopy never goes black
// and both faces use the authored normal (no back-face flip, so undersides aren't black).
//
//   patchFoliage(THREE, material, { back: 2.6, wrap: 0.4, trans: 1.3, glow: 0.06, tint: [1.08, 0.94, 0.7] })
// Works on MeshStandard/Physical/Lambert/Phong, chains any existing onBeforeCompile (wind sway, cloud shadows) in
// either order, and is idempotent per material. Same three r161 and r186 light loop.
import { expandLights } from './cloudShadow.js';

const DIR_BLOCK = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const CAP = '{ float lwL = dot( directionalLights[ i ].color, vec3( 0.2126, 0.7152, 0.0722 ) ); ' +
  'if ( lwL > lwSunBest ) { lwSunBest = lwL; lwSunC = directLight.color; lwSunD = directLight.direction; } }\n\t\t';
export const FOLIAGE_NORMAL_BEGIN = /* glsl */`
float faceDirection = 1.0;
#ifdef FLAT_SHADED
	vec3 normal = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );   // three >= r17x flat-shades geometry without normals
#else
	vec3 normal = normalize( vNormal );
#endif
vec3 nonPerturbedNormal = normal;
`;

/** Insert the shadowed-sun capture into an expanded light loop. Returns null if the layout isn't recognised. */
export function captureSun(src) {
  const at = src.indexOf(DIR_BLOCK);
  const re = at >= 0 ? src.indexOf('RE_Direct( directLight', at) : -1;
  if (re < 0) return null;
  return src.slice(0, at) + 'vec3 lwSunC = vec3( 0.0 ); vec3 lwSunD = vec3( 0.0, 1.0, 0.0 ); float lwSunBest = -1.0;\n' +
    src.slice(at, re) + CAP + src.slice(re);
}

export function patchFoliage(THREE, material, { back = 2.6, wrap = 0.4, trans = 1.3, glow = 0.06, tint = [1.08, 0.94, 0.7], normals = true } = {}) {
  if (!material || material.userData.lwFoliage) return false;
  material.userData.lwFoliage = true;
  const f = (x) => Number(x).toFixed(3);
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
    // three's default key is onBeforeCompile.toString(), which is this wrapper for every patched material: keep the
    // wrapped hook's own source in the key, or materials whose original hooks differ would share one program
    const prevSrc = prev ? String(prev) : '';
  material.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    let fs = expandLights(THREE, sh.fragmentShader);
    const cap = captureSun(fs);
    if (!cap) { console.warn('patchFoliage: light loop not recognised; leaves keep stock lighting'); return; }
    fs = cap;
    if (normals && fs.includes('#include <normal_fragment_begin>')) fs = fs.replace('#include <normal_fragment_begin>', FOLIAGE_NORMAL_BEGIN);
    const add = `
	{
		float lwBack = pow( saturate( dot( - geometryViewDir, lwSunD ) ), 4.0 );
		float lwWrap = saturate( dot( - normal, lwSunD ) * 0.6 + 0.4 );
		vec3 lwAlb = diffuseColor.rgb;
		vec3 lwT = lwAlb * mix( vec3( 1.0 ), vec3( ${f(tint[0])}, ${f(tint[1])}, ${f(tint[2])} ), 0.6 );   // transmitted light is warmer
		reflectedLight.directDiffuse += lwSunC * lwT * ( lwBack * ${f(back)} + lwWrap * ${f(wrap)} ) * ${f(trans)};
		reflectedLight.indirectDiffuse += lwAlb * ${f(glow)};
	}
	#include <lights_fragment_maps>`;
    if (!fs.includes('#include <lights_fragment_maps>')) { console.warn('patchFoliage: no lights_fragment_maps anchor'); return; }
    sh.fragmentShader = fs.replace('#include <lights_fragment_maps>', add);
  };
  material.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + prevSrc + `|lwleaf${back},${wrap},${trans},${glow},${tint.join(",")},${normals}`; };
  material.needsUpdate = true;
  return true;
}
