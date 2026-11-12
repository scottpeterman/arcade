// Camera-following GPU grass: one instanced draw of blade clumps on a grid snapped around the camera.
//
// After Long Wind's GPU-procedural grass tiers and TileRing (src/world/grass.js, src/world/foliage.js,
// github.com/jbang2004/long-wind, MIT): nothing is scattered on the CPU. Each instance finds its own cell from
// gl_InstanceID and the snapped camera position, jitters inside it with a hash, reads ground height and a grass
// weight from a texture, and scales itself to nothing where there's no grass or near the ring's edge. Much smaller
// than Long Wind's (no tiers, no actor push, no trample), sized for an integrated GPU and a camera that's usually
// flying, not walking.
//
//   const g = createGrass(THREE, { ground, rect: { x0, z0, size }, seaY, n: 80, spacing: 2.5, height: 0.75 })
//     ground: DataTexture RG32F/RGBA32F, R = height above seaY, G = grass weight 0..1 (row j = z ascending)
//   scene.add(g.mesh)
//   g.update(camera, { time, wind: Vector2, gust: 0..2, visible })   — every frame
//   g.material                                                         — MeshStandardMaterial (patch it: foliage, cloud shadows)
const PARS = /* glsl */`
uniform sampler2D tLwGround;
uniform vec4 uLwRect;     // x0, z0, size, texels per side - 1
uniform vec4 uLwCam;      // camera xz (snapped), spacing, ring radius
uniform vec4 uLwWind;     // xy dir * strength, time, blade height
uniform float uLwSeaY;
varying float vLwHash;
float lwH12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 lwGround(vec2 xz) {
  float N = uLwRect.w;
  vec2 u = clamp((xz - uLwRect.xy) / uLwRect.z, 0.0, 1.0) * N;
  ivec2 i0 = ivec2(floor(u)); vec2 f = u - floor(u); int M = int(N);
  vec2 a = texelFetch(tLwGround, clamp(i0, ivec2(0), ivec2(M)), 0).rg, b = texelFetch(tLwGround, clamp(i0 + ivec2(1, 0), ivec2(0), ivec2(M)), 0).rg;
  vec2 c = texelFetch(tLwGround, clamp(i0 + ivec2(0, 1), ivec2(0), ivec2(M)), 0).rg, d = texelFetch(tLwGround, clamp(i0 + ivec2(1, 1), ivec2(0), ivec2(M)), 0).rg;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

export function createGrass(THREE, { ground, rect, seaY = 0, n = 80, spacing = 2.5, height = 0.75, color = 0x6f7d3a } = {}) {
  // one clump: 7 tapered blades leaning out from the centre, root dark → tip light (vertex colour)
  const pos = [], col = [];
  for (let k = 0; k < 7; k++) {
    const a = k / 7 * Math.PI * 2 + 0.4 * Math.sin(k * 3.1), r0 = 0.12 + 0.05 * (k % 3), w = 0.045, lean = 0.28 + 0.1 * (k % 2);
    const cx = Math.cos(a), cz = Math.sin(a), px = -cz * w, pz = cx * w, h = 0.75 + 0.25 * ((k * 7) % 5) / 4;
    pos.push(cx * r0 + px, 0, cz * r0 + pz, cx * r0 - px, 0, cz * r0 - pz, cx * (r0 + lean), h, cz * (r0 + lean));
    col.push(0.42, 0.42, 0.4, 0.42, 0.42, 0.4, 1, 1, 0.92);
  }
  const blade = new THREE.BufferGeometry();
  blade.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  blade.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const geo = new THREE.InstancedBufferGeometry();
  // a normal attribute even though the shader overrides it: newer three flat-shades (no vNormal) geometry without one
  blade.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('position', blade.attributes.position); geo.setAttribute('color', blade.attributes.color); geo.setAttribute('normal', blade.attributes.normal);
  geo.instanceCount = n * n;

  const N = ground.image.width - 1;
  const uniforms = {
    tLwGround: { value: ground },
    uLwRect: { value: new THREE.Vector4(rect.x0, rect.z0, rect.size, N) },
    uLwCam: { value: new THREE.Vector4(0, 0, spacing, n * spacing * 0.5) },
    uLwWind: { value: new THREE.Vector4(0.5, 0.2, 0, height) },
    uLwSeaY: { value: seaY },
  };
  const material = new THREE.MeshStandardMaterial({ color, vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = PARS + sh.vertexShader
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );   // soft, sky-facing: grass reads as a surface')
      .replace('#include <begin_vertex>', `
  int lwN = ${n};
  int lwId = gl_InstanceID;
  vec2 lwCell = vec2(float(lwId % lwN - lwN / 2), float(lwId / lwN - lwN / 2)) * uLwCam.z + uLwCam.xy;
  float lwHa = lwH12(lwCell * 0.731), lwHb = lwH12(lwCell * 1.317 + 7.1);
  vec2 lwXZ = lwCell + (vec2(lwHa, lwHb) - 0.5) * uLwCam.z;
  vec2 lwG = lwGround(lwXZ);
  float lwFade = 1.0 - smoothstep(uLwCam.w * 0.62, uLwCam.w, length(lwXZ - uLwCam.xy));
  float lwS = smoothstep(0.15, 0.6, lwG.g) * lwFade * (0.65 + 0.7 * lwHb);
  vLwHash = lwHa;
  float lwA = lwHa * 6.2832, lwC = cos(lwA), lwSn = sin(lwA);
  vec3 transformed = vec3(lwC * position.x - lwSn * position.z, position.y * uLwWind.w, lwSn * position.x + lwC * position.z) * lwS;
  float lwSway = position.y * position.y * (0.5 + 0.5 * sin(uLwWind.z * 1.7 + dot(lwXZ, vec2(0.21, 0.17))));
  transformed.xz += uLwWind.xy * lwSway * lwS;
  transformed += vec3(lwXZ.x, uLwSeaY + lwG.r - 0.03, lwXZ.y);
  if (lwS < 0.02) transformed = vec3(0.0, -1e5, 0.0);   // no grass here: collapse off-screen`);
    sh.fragmentShader = 'varying float vLwHash;\n' + sh.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\n\tdiffuseColor.rgb *= mix( vec3( 0.86, 0.92, 0.82 ), vec3( 1.12, 1.06, 0.84 ), vLwHash );   // clump-to-clump hue');
  };
  material.customProgramCacheKey = () => `lwgrass${n}`;
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'lwGrass'; mesh.frustumCulled = false; mesh.receiveShadow = true;

  function update(camera, { time = 0, wind = null, gust = 1, visible = true } = {}) {
    mesh.visible = visible;
    if (!visible) return;
    const s = spacing;
    uniforms.uLwCam.value.set(Math.floor(camera.position.x / s) * s, Math.floor(camera.position.z / s) * s, s, n * s * 0.5);
    if (wind) uniforms.uLwWind.value.set(wind.x * 0.18 * gust, wind.y * 0.18 * gust, time, height);
    else uniforms.uLwWind.value.z = time;
  }
  return { mesh, material, uniforms, update, dispose() { geo.dispose(); blade.dispose(); material.dispose(); } };
}

/** Build the ground texture from a PlaneGeometry-style grid: heights[(j * (seg+1)) + i], weights likewise (0..1). */
export function groundTexture(THREE, heights, weights, seg) {
  const M = seg + 1, data = new Float32Array(M * M * 4);
  for (let k = 0; k < M * M; k++) { data[k * 4] = heights[k]; data[k * 4 + 1] = weights[k]; }
  const t = new THREE.DataTexture(data, M, M, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
