// Ground detail for vertex-coloured terrain: macro variation, anti-tiled detail and detail normals per surface type.
//
// Long Wind's terrain blends baked ground-texture layers by a splat map with anti-tiling, macro variation and detail
// normals (src/world/terrain-material.js, github.com/jbang2004/long-wind, MIT). This is the light version for a
// terrain whose colour already lives in its vertices (and for an integrated-GPU budget): no texture arrays. Detail
// comes from Long Wind's baked cloud noise (cloudNoise.js), sampled at two rotated scales so it never tiles visibly,
// and is weighted per vertex by four surface weights you supply in a vec4 attribute:
//   x sand / beach     fine speckle, almost flat
//   y grass / clearing clumps and dry patches, soft tufted relief
//   z dirt / mud       patchy, moderate relief
//   w rock             high contrast, strong relief
// (whatever is left of 1 - sum is "other": gets macro variation only). Detail fades out with distance; the macro
// variation (a ~1 km scale brightness/hue drift) stays at every distance, which is what breaks up flat colour from
// altitude.
//
//   patchGroundDetail(THREE, material, { noise, attribute: 'aGround', strength: 1, near: 250, far: 1400 })
// Chains existing onBeforeCompile hooks; MeshStandard/Physical/Lambert/Phong with vertexColors.
const GROUND_PARS_V = /* glsl */`
attribute vec4 aGround;
varying vec4 vLwGround;
varying vec3 vLwGW;
`;
const GROUND_PARS_F = /* glsl */`
uniform sampler2D tLwGN;
uniform vec4 uLwGParams;   // x strength, y near, z far, w macro strength
varying vec4 vLwGround;
varying vec3 vLwGW;
const mat2 LW_GR = mat2(0.8, -0.6, 0.6, 0.8);
// one detail sample: two rotated, differently scaled taps averaged (anti-tiling)
vec4 lwGDet(vec2 p) { return 0.5 * (texture2D(tLwGN, p * 0.031 + 0.17) + texture2D(tLwGN, LW_GR * p * 0.083 + 0.53)); }
float lwGHeight(vec2 p) {
  vec4 d = lwGDet(p);
  return vLwGround.x * d.a * 0.15 + vLwGround.y * (d.b * 0.7 + d.a * 0.3) * 0.4 + vLwGround.z * d.r * 0.35 + vLwGround.w * (d.a * 0.6 + d.b * 0.4) * 0.8;
}
`;

export function patchGroundDetail(THREE, material, { noise, attribute = 'aGround', strength = 1, near = 250, far = 1400, macro = 1 } = {}) {
  if (!material || material.userData.lwGround) return false;
  material.userData.lwGround = true;
  const uniforms = { tLwGN: { value: noise }, uLwGParams: { value: new THREE.Vector4(strength, near, far, macro) } };
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
    // three's default key is onBeforeCompile.toString(), which is this wrapper for every patched material: keep the
    // wrapped hook's own source in the key, or materials whose original hooks differ would share one program
    const prevSrc = prev ? String(prev) : '';
  material.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = GROUND_PARS_V.replace('aGround', attribute) + sh.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n\tvLwGround = ${attribute};`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n\tvLwGW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = GROUND_PARS_F + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
	{
		float lwDist = length( vLwGW - cameraPosition );
		float lwNear = ( 1.0 - smoothstep( uLwGParams.y, uLwGParams.z, lwDist ) ) * uLwGParams.x;
		vec2 lwP = vLwGW.xz;
		float lwMacro = texture2D( tLwGN, lwP * 0.0011 + 0.31 ).r;
		vec3 lwDrift = mix( vec3( 0.92, 0.94, 0.9 ), vec3( 1.08, 1.05, 0.96 ), lwMacro );       // ~1 km brightness / dryness drift
		diffuseColor.rgb *= mix( vec3( 1.0 ), lwDrift, uLwGParams.w );
		vec4 lwD = lwGDet( lwP ), lwF = texture2D( tLwGN, LW_GR * lwP * 0.29 + 0.77 );
		vec4 g = vLwGround;
		float lwSand = mix( 0.94, 1.06, lwF.a * 0.7 + lwD.a * 0.3 );
		float lwGrass = mix( 0.76, 1.16, lwD.b * 0.6 + lwF.a * 0.4 );
		vec3 lwGrassHue = mix( vec3( 1.0 ), vec3( 1.12, 1.06, 0.8 ), smoothstep( 0.55, 0.8, lwD.r ) );   // dry patches
		float lwDirt = mix( 0.8, 1.14, lwD.r * 0.6 + lwF.b * 0.4 );
		float lwRock = mix( 0.62, 1.25, lwD.a * 0.5 + lwF.a * 0.5 );
		vec3 lwMul = vec3( 1.0 ) + g.x * ( lwSand - 1.0 ) + g.y * ( lwGrass * lwGrassHue - 1.0 ) + g.z * ( lwDirt - 1.0 ) + g.w * ( lwRock - 1.0 );
		diffuseColor.rgb *= mix( vec3( 1.0 ), lwMul, lwNear );
	}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
	{
		float lwNearN = ( 1.0 - smoothstep( uLwGParams.y * 0.6, uLwGParams.z * 0.6, length( vLwGW - cameraPosition ) ) ) * uLwGParams.x;
		if ( lwNearN > 0.001 ) {
			float e = 1.5, h0 = lwGHeight( vLwGW.xz );
			vec3 lwGrad = vec3( lwGHeight( vLwGW.xz + vec2( e, 0.0 ) ) - h0, 0.0, lwGHeight( vLwGW.xz + vec2( 0.0, e ) ) - h0 ) / e;
			normal = normalize( normal - mat3( viewMatrix ) * lwGrad * 6.0 * lwNearN );
		}
	}`);
  };
  material.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + prevSrc + '|lwground' + attribute; };
  material.needsUpdate = true;
  return { uniforms };
}
