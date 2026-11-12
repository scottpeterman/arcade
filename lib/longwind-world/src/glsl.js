// GLSL helpers shared by the longwind-world shaders. From 长风 Long Wind (github.com/jbang2004/long-wind, MIT,
// (c) 2026 jbang2004): src/core/noise.js (GLSL_NOISE) and wx_fbm3v from src/core/atmosphere.js. Guarded, so any
// number of chunks can include it in one shader.
export const LW_NOISE_GLSL = /* glsl */`
#ifndef WX_NOISE
#define WX_NOISE
float wx_hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 wx_hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float wx_hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float wx_vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = wx_hash12(i), b = wx_hash12(i + vec2(1, 0)), c = wx_hash12(i + vec2(0, 1)), d = wx_hash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// value noise with its analytic gradient in one evaluation: (value, d/dx, d/dy)
vec3 wx_vnoised(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = wx_hash12(i), b = wx_hash12(i + vec2(1, 0)), c = wx_hash12(i + vec2(0, 1)), d = wx_hash12(i + vec2(1, 1));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * vec2(b - a + k * u.y, c - a + k * u.x));
}
float wx_vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = wx_hash13(i), n100 = wx_hash13(i + vec3(1,0,0)), n010 = wx_hash13(i + vec3(0,1,0)), n110 = wx_hash13(i + vec3(1,1,0));
  float n001 = wx_hash13(i + vec3(0,0,1)), n101 = wx_hash13(i + vec3(1,0,1)), n011 = wx_hash13(i + vec3(0,1,1)), n111 = wx_hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float wx_fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { s += a * wx_vnoise(p); p = r * p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
float wx_fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * wx_vnoise3(p); p = p * 2.02 + 11.7; a *= 0.5; }
  return s;
}
// 2D simplex (Ashima / Ian McEwan, MIT)
vec3 wx_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 wx_mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 wx_permute(vec3 x) { return wx_mod289(((x * 34.0) + 10.0) * x); }
float wx_snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
  i = wx_mod289(i);
  vec3 p = wx_permute(wx_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g; g.x = a0.x * x0.x + h.x * x0.y; g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
#endif
#ifndef WX_FBM3V
#define WX_FBM3V
// 3-octave value fBm (weights .55/.28/.17): blobby, soft, no lattice artefacts
float wx_fbm3v(vec2 p) {
  const mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
  float s = 0.55 * wx_vnoise(p);
  p = R * p * 2.02 + 3.17; s += 0.28 * wx_vnoise(p);
  p = R * p * 2.03 + 7.71; s += 0.17 * wx_vnoise(p);
  return s;
}
#endif
`;
