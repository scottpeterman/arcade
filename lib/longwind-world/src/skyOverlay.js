// Sky overlay: high cirrus, a painted band of distant cumulus at the horizon, and the night sky (two star layers,
// the Milky Way, the moon). Drawn over any base sky (three's Sky/Preetham, a gradient, a cube map) as a transparent
// dome at infinite distance.
//
// The GLSL for the clouds, cirrus and night is Long Wind's painted sky (src/world/sky.js,
// github.com/jbang2004/long-wind, MIT, (c) 2026 jbang2004), unchanged apart from the uniforms. Differences for a
// flying camera: the painted cumulus is limited to a band just above the horizon (the 3D cumulus field covers
// everything nearer), it fades as the eye climbs through the cumulus layer, and the haze at the horizon is blended in
// display space (after tone mapping), the way three applies fog, so it matches the sea's fog edge.
//
//   const sky2 = createSkyOverlay(THREE, { noise })         — noise from bakeCloudNoise()
//   scene.add(sky2.mesh)                                     — renderOrder -2: after the opaque sky, before other transparents
//   sky2.uniforms.*                                          — see U below; set them every frame or when they change
import { LW_NOISE_GLSL } from './glsl.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);   // rotation only: infinitely far
  gl_Position = p.xyww;                                                  // depth 1: behind everything opaque
}`;

const FRAG = /* glsl */`
uniform vec3 uSunDir, uSunCol, uMoonDir, uCloudLit, uCloudShade, uHorizonGlow, uHaze, uHazeD;
uniform float uNight, uStorm, uTime, uSunVis, uHazeH;
uniform vec4 uWind, uCloudCover, uEye;
uniform sampler2D tCloudNoise;
varying vec3 vDir;
${LW_NOISE_GLSL}
// ---- night: two jittered star layers on cube-face grids, Milky Way band, moon with maria ----
// One jittered star per cell for the brightest ~(1-thr) of cells; magnitude ramps linearly above the threshold so
// the field has a few bright stars and many faint ones. Colour temperature varies (blue-white … warm).
vec3 wx_starLayer(vec2 uv, float cells, float thr, float seed) {
  vec2 g = uv * cells, id = floor(g), f = g - id;
  float px = max(fwidth(g.x) + fwidth(g.y), 1e-4) * 0.5;   // ~1 px wide whatever the resolution (uniform flow)
  float hsh = wx_hash12(id * 1.37 + seed * 0.71);
  if (hsh < thr) return vec3(0.0);
  float m = (hsh - thr) / (1.0 - thr);
  m *= m;
  vec2 j = wx_hash22(id + seed) * 0.8 + 0.1;
  vec2 d = (f - j) / px;
  float tw = 0.7 + 0.3 * sin(uTime * (1.5 + 4.0 * wx_hash12(id + 3.1)) + 6.2832 * wx_hash12(id + 9.7));
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.86, 0.7), wx_hash12(id + 5.3));
  return tint * m * tw * exp(-dot(d, d));
}
vec3 wx_nightSky(vec3 rd, float h) {
  vec3 a = abs(rd); vec2 uv; float face;
  if (a.x >= a.y && a.x >= a.z) { uv = rd.yz / a.x; face = rd.x > 0.0 ? 1.0 : 2.0; }
  else if (a.y >= a.z) { uv = rd.xz / a.y; face = rd.y > 0.0 ? 3.0 : 4.0; }
  else { uv = rd.xy / a.z; face = rd.z > 0.0 ? 5.0 : 6.0; }
  // bright stars appear first (blue hour), the faint field only in full night
  float nb = smoothstep(0.3, 0.75, uNight), nf = smoothstep(0.6, 1.0, uNight);
  vec3 st = wx_starLayer(uv, 55.0, 0.985, face * 17.0) * 0.9 * nb + wx_starLayer(uv, 150.0, 0.988, face * 31.0 + 5.0) * 0.28 * nf;
  vec3 col = st * smoothstep(0.0, 0.2, h);
  // Milky Way: a great-circle band broken by dust lanes (baked noise: cheap)
  vec3 ax = normalize(vec3(0.55, 0.35, 0.76));
  float bd = dot(rd, ax);
  float mw = exp(-(bd * 3.2) * (bd * 3.2));
  vec2 mp = vec2(atan(rd.z, rd.x) * 0.31831, bd * 0.45);          // x spans exactly 2 tiles: seamless
  float dust = textureLod(tCloudNoise, mp * 2.0 + 0.3, 1.5).r;
  float glow = textureLod(tCloudNoise, mp + 0.7, 2.5).a;
  col += vec3(0.05, 0.06, 0.09) * 0.55 * mw * (0.45 + 1.2 * glow) * (1.0 - 0.75 * smoothstep(0.45, 0.68, dust)) * smoothstep(0.0, 0.3, h) * nf;
  return col;
}
vec3 wx_moon(vec3 rd) {
  float mu = dot(rd, uMoonDir);
  vec3 col = vec3(0.5, 0.58, 0.72) * (pow(max(mu, 0.0), 60.0) * 0.06 + pow(max(mu, 0.0), 900.0) * 0.18);
  if (mu > 0.9998) {
    vec3 t = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 b = cross(t, uMoonDir);
    vec3 q = rd - uMoonDir * mu;
    vec2 p = vec2(dot(q, t), dot(q, b)) / 0.0155;                 // disc radius ~0.9 deg
    float r2 = dot(p, p);
    float maria = smoothstep(0.42, 0.68, wx_fbm3v(p * 1.6 + 3.0)) * 0.34 + wx_vnoise(p * 7.0) * 0.08;
    float limb = sqrt(max(1.0 - r2, 0.0));
    col += vec3(1.9, 2.0, 2.15) * (1.0 - maria) * (0.55 + 0.45 * limb) * smoothstep(1.0, 0.93, sqrt(r2));
  }
  return col * smoothstep(-0.02, 0.03, uMoonDir.y);
}

// ---- clouds: painted, analytic (not raymarched) ----
// Cloud-plane coordinates: rd.xz/(h+0.06) compresses the deck toward the horizon (perspective), rotated so the
// texture's streak axis (x) runs downwind; the deck drifts downwind.
vec2 wx_cloudUV(vec3 rd, float h, out vec2 sunUV) {
  vec2 W = normalize(uWind.xy + vec2(1e-4, 0.0));
  vec2 P = vec2(-W.y, W.x);
  vec2 uv = rd.xz / (h + 0.06) * 0.9;
  vec2 sxz = normalize(uSunDir.xz + vec2(1e-4, 0.0));
  sunUV = vec2(dot(sxz, W), dot(sxz, P));
  return vec2(dot(uv, W), dot(uv, P)) - vec2(uTime * (0.0042 + 0.012 * uStorm) * uWind.z, 0.0);
}
// Coverage field from the baked noise (3 taps). Returns (coverage, thickness proxy).
vec2 wx_cloudField(vec2 uv) {
  vec4 a = texture2D(tCloudNoise, uv * 0.075);                        // masses, ~13 units per tile
  vec4 b = texture2D(tCloudNoise, uv * 0.23 + vec2(0.37, 0.61));        // puffs + detail
  float st = texture2D(tCloudNoise, uv * vec2(0.035, 0.06) + 0.13).g;   // long wind-combed bands
  float cov = a.r * 0.78 + st * 0.42 + (b.b - 0.5) * 0.22 + (b.a - 0.5) * 0.12 - 0.17;
  return vec2(cov, a.r * 0.7 + b.b * 0.3);
}
// Returns the cloud colour (rgb) and coverage (a). s = dot(rd, sun), band = horizon band, bg = sky behind.
vec4 wx_clouds(vec3 rd, float h, float s, float band, vec3 bg) {
  float clear = 1.0 - uStorm;
  vec2 sunUV;
  vec2 uv = wx_cloudUV(rd, h, sunUV);
  vec2 f = wx_cloudField(uv);
  float cov = f.x + uCloudCover.x + uStorm * 0.55 - uNight * 0.08 * clear;
  float d = smoothstep(0.52 - 0.3 * uStorm, 0.74 - 0.1 * uStorm, cov);
  d *= smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.26, 0.62, h) * 0.9 * clear);   // mass lives 3–30 deg up
  if (d < 0.003) return vec4(0.0);
  float thick = clamp(smoothstep(0.58, 0.95, cov) * 0.85 + (f.y - 0.5) * 0.3 + 0.6 * uStorm, 0.0, 1.0);
  // self-shadow tap toward the sun (bible §3.1): sun-facing edges light up, far sides and cores deepen
  vec2 fS = wx_cloudField(uv + sunUV * 0.09);
  float edge = clamp((f.x - fS.x) * 3.5, -1.0, 1.0);
  thick = clamp(thick + 0.4 * max(-edge, 0.0), 0.0, 1.0);
  // front-lit (sun behind the viewer / to the side): gold-cream sun-facing sides, cool violet shade in the cores
  float litK = clamp(0.62 + 0.55 * edge - 0.75 * thick, 0.0, 1.0);
  vec3 front = mix(uCloudShade, uCloudLit * (1.0 + 0.25 * max(edge, 0.0)), litK);
  front += uHorizonGlow * 0.16 * band * (1.0 - thick) * clear;                  // the low sun warms the undersides
  // backlit (looking toward the sun): thin veils glow a little brighter than the sky behind, thick bodies stand
  // dark against the glow, every thin edge gets a silver-gold lining
  float fwd = smoothstep(0.55, 0.98, s);
  vec3 back = mix(bg * 1.12, uCloudShade * 0.85 + bg * 0.12, smoothstep(0.12, 0.65, thick));
  back += uSunCol * vec3(1.0, 0.8, 0.55) * pow(s, 10.0) * pow(1.0 - thick, 3.0) * 0.45 * clear;
  vec3 cc = mix(front, back, fwd * clear);
  // aerial perspective: the low deck is kilometres away, it melts into the horizon haze
  cc = mix(cc, bg, smoothstep(0.1, 0.0, h) * 0.55);
  return vec4(cc, d * (0.92 + 0.06 * uStorm) * uCloudCover.y);
}
// High cirrus: thin wind-combed streaks, lit gold near the sun, above the low deck. Finer texture scale than the deck
// (it stays crisp overhead, where the flatter projection magnifies it).
vec4 wx_cirrus(vec3 rd, float h, float s) {
  vec2 W = normalize(uWind.xy + vec2(1e-4, 0.0));
  vec2 uv = rd.xz / (h + 0.25) * 0.35;
  uv = vec2(dot(uv, W), dot(uv, vec2(-W.y, W.x))) - vec2(uTime * 0.0012, 0.0);
  float g = texture2D(tCloudNoise, uv * vec2(0.45, 1.6) + 0.51).g;
  float a = texture2D(tCloudNoise, uv * vec2(1.8, 3.6) + 0.17).a;
  float m = texture2D(tCloudNoise, uv * 0.12 + 0.77).r;                  // patchiness: cirrus comes in fields
  float ci = smoothstep(0.55, 0.85, g * 0.8 + a * 0.35) * smoothstep(0.45, 0.7, m) * 0.32;
  ci *= smoothstep(0.04, 0.3, h) * (1.0 - uStorm) * (1.0 - 0.6 * uNight) * uCloudCover.y;
  vec3 c = mix(uCloudLit * 0.9, uSunCol * vec3(1.0, 0.8, 0.6) * 0.35, pow(s, 3.0));
  return vec4(c, ci);
}

void main() {
  vec3 rd = normalize(vDir);
  float h = rd.y;
  vec3 hd = normalize(vec3(rd.x, max(h, 0.0), rd.z));
  vec3 gd = h > 0.0 ? rd : hd;
  float s = max(dot(gd, uSunDir), 0.0);
  float band = exp(-max(h, 0.0) * 7.0);
  vec3 acc = vec3(0.0); float a = 0.0;
  if (h > -0.01) {
    vec4 ci = wx_cirrus(gd, max(h, 0.0), s);
    ci.a *= uCloudCover.w;
    acc = ci.rgb * ci.a; a = ci.a;
    // painted distant cumulus: a band above the horizon, gone once the eye is above the cumulus tops
    vec4 cl = wx_clouds(gd, max(h, 0.0), s, band, uHaze);
    cl.a *= uEye.w * (1.0 - smoothstep(uCloudCover.z * 0.45, uCloudCover.z, h)) * (1.0 - smoothstep(uEye.y, uEye.z, uEye.x));
    acc = cl.rgb * cl.a + acc * (1.0 - cl.a); a = cl.a + a * (1.0 - cl.a);
  }
  if (uNight > 0.001) {
    vec3 n = (wx_nightSky(gd, h) + wx_moon(gd) * smoothstep(0.05, 0.45, uNight)) * (1.0 - 0.85 * uStorm) * (1.0 - a);
    acc += n; a = clamp(a + dot(n, vec3(0.33)) * 1.5, 0.0, 1.0);
  }
  if (a < 0.002) discard;
  gl_FragColor = vec4(acc / max(a, 1e-4), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // horizon haze, in display space like three's fog: the far band melts into the same colour as the sea's fog edge
  gl_FragColor.rgb = mix(uHazeD, gl_FragColor.rgb, smoothstep(0.0, uHazeH, h));
}`;

export function createSkyOverlay(THREE, { noise, radius = 3000 } = {}) {
  const U = {
    tCloudNoise: { value: noise },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },     // key light direction (toward the sun)
    uSunCol: { value: new THREE.Vector3(3, 2.6, 2.2) }, // HDR sun radiance (linear), drives cirrus glints and silver linings
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uCloudLit: { value: new THREE.Vector3(1.2, 1.15, 1.1) },   // lit cloud colour (linear)
    uCloudShade: { value: new THREE.Vector3(0.45, 0.5, 0.6) }, // cloud shade colour (linear)
    uHorizonGlow: { value: new THREE.Vector3(0, 0, 0) },       // low-sun warmth on undersides
    uHaze: { value: new THREE.Vector3(0.6, 0.7, 0.8) },        // horizon sky colour, linear (backlit thin cloud, aerial)
    uHazeD: { value: new THREE.Vector3(0.8, 0.85, 0.9) },      // the same, display space (= the fog colour)
    uHazeH: { value: 0.035 },                                  // haze band height (rd.y)
    uNight: { value: 0 }, uStorm: { value: 0 }, uTime: { value: 0 }, uSunVis: { value: 1 },
    uWind: { value: new THREE.Vector4(1, 0, 1, 0) },           // xy direction, z strength
    uCloudCover: { value: new THREE.Vector4(0, 1, 0.07, 1) },  // x coverage offset, y overall opacity, z band top (rd.y), w cirrus
    uEye: { value: new THREE.Vector4(0, 600, 1600, 1) },       // x eye altitude, y cumulus base, z cumulus tops (same units), w painted-band opacity
  };
  const material = new THREE.ShaderMaterial({
    name: 'lwSkyOverlay', uniforms: U, vertexShader: VERT, fragmentShader: FRAG,
    side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
  mesh.name = 'lwSkyOverlay'; mesh.frustumCulled = false; mesh.renderOrder = -2;
  return { mesh, material, uniforms: U };
}
