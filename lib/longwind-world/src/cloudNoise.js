// Tileable cloud noise, baked once on the GPU. From 长风 Long Wind (github.com/jbang2004/long-wind, MIT, (c) 2026
// jbang2004), src/world/sky.js (bakeCloudNoise), made three-agnostic (pass THREE in) and cached per renderer.
//
//   const tex = bakeCloudNoise(THREE, renderer)     → 512² RGBA8, RepeatWrapping, mipmapped
//     R warped billow fBm (cumulus / stratocumulus masses)   G wind-combed streak fBm (x = along the wind, 5:1)
//     B cellular puffs (inverted Worley, cauliflower tops)    A fine detail fBm (edge erosion, wisps)
// Every octave hashes its lattice modulo its own period, so all four channels tile exactly at the border.
const BAKE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float pn(vec2 p, vec2 P) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  float a = h12(mod(i, P)), b = h12(mod(i + vec2(1.0, 0.0), P)), c = h12(mod(i + vec2(0.0, 1.0), P)), d = h12(mod(i + vec2(1.0, 1.0), P));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 p, vec2 P, int oct, float gain) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * pn(p, P); n += a;
    p = p * 2.0 + vec2(13.0, 7.0); P *= 2.0; a *= gain;
  }
  return s / n;
}
float pworley(vec2 p, vec2 P) {
  vec2 i = floor(p), f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 r = g + h22(mod(i + g, P)) * 0.9 + 0.05 - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
float spread(float v) { return clamp((v - 0.5) * 1.7 + 0.5, 0.0, 1.0); }
void main() {
  vec2 uv = vUv;
  vec2 p = uv * 5.0; vec2 P = vec2(5.0);
  vec2 w = vec2(pfbm(p + vec2(1.7, 9.2), P, 4, 0.5), pfbm(p + vec2(8.3, 2.8), P, 4, 0.5)) - 0.5;
  float r = pfbm(p + w * 2.2, P, 6, 0.52);
  float g = pfbm(uv * vec2(3.0, 15.0) + vec2(0.0, pn(uv * vec2(3.0, 6.0), vec2(3.0, 6.0)) * 2.0), vec2(3.0, 15.0), 5, 0.5);
  float b = (1.0 - pworley(uv * 9.0, vec2(9.0))) * 0.62 + (1.0 - pworley(uv * 21.0, vec2(21.0))) * 0.38;
  float a = pfbm(uv * 26.0, vec2(26.0), 4, 0.55);
  gl_FragColor = vec4(spread(r), spread(g), clamp(b * 1.15 - 0.1, 0.0, 1.0), spread(a));
}
`;

const cache = new WeakMap();

export function bakeCloudNoise(THREE, renderer, size = 512) {
  const hit = cache.get(renderer);
  if (hit && hit.image.width === size) return hit;
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true, depthBuffer: false,
  });
  rt.texture.name = 'lwCloudNoise';
  rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BAKE_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);            // three regenerates the mip chain after rendering into rt
  renderer.setRenderTarget(prev);
  mat.dispose(); quad.geometry.dispose();
  cache.set(renderer, rt.texture);
  return rt.texture;
}
