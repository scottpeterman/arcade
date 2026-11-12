// Cloud shadows on the ground and sea, cast by the actual cumulus field.
//
// Long Wind darkens the sun under a procedural noise deck (src/core/atmosphere.js, wx_cloudShadow,
// github.com/jbang2004/long-wind, MIT). Here the shadows come from the clouds themselves: each cloud body is
// projected along the sun onto the ground as a soft, noise-eroded ellipse in a small top-down map. Lit materials then
// scale the sun's direct light by it. Only the key light is shadowed; sky light (hemisphere, IBL) still fills in, so
// shadowed sea and jungle go cooler and darker without going black.
//
//   const cs = createCloudShadow(THREE, { renderer, noise, size: 512, extent: 16000, strength: 0.6 })
//   cs.patch(material, { indirect }) / cs.patchScene(scene)   — once, before first render; chains existing hooks.
//     indirect 0..1 also dims the material's indirect light under a shadow. Use ~0.3 for water lit mostly by
//     sky reflection: on real ocean a cloud shadow reads as darker water because the sunlit glow from below goes.
//   cs.update(casters, anchor, sunDir, groundY) — casters from cumulus.casters(); cheap, call every frame or every few
//   cs.strength = 0..1                          — e.g. lower it under a full overcast (there's no direct sun anyway)
// The sun must be the first directional light that casts shadows (three sorts shadow casters first), or the only
// directional light; `lightIndex` overrides.
const FOOT_VERT = /* glsl */`
attribute vec4 aFoot;      // centre x, z (ground plane, already sun-projected), radius x, radius z
attribute vec2 aFoot2;     // opacity, seed
varying vec2 vQ; varying vec2 vW; varying vec2 vF;
void main() {
  vQ = position.xy;
  vec2 w = aFoot.xy + position.xy * aFoot.zw * 1.35;
  vW = w; vF = aFoot2;
  gl_Position = projectionMatrix * viewMatrix * vec4(w.x, 0.0, w.y, 1.0);
}`;
const FOOT_FRAG = /* glsl */`
uniform sampler2D tNoise;
varying vec2 vQ; varying vec2 vW; varying vec2 vF;
void main() {
  float d = length(vQ * 1.35);
  float n = texture2D(tNoise, vW * 0.0011 + vF.y * 5.3).r * 0.6 + texture2D(tNoise, vW * 0.0037 + vF.y * 2.1).b * 0.4;
  float s = 1.0 - smoothstep(0.45 + 0.35 * n, 1.15, d);
  gl_FragColor = vec4(s * vF.x, 0.0, 0.0, 1.0);
}`;

export function createCloudShadow(THREE, { renderer, noise, size = 512, extent = 16000, strength = 0.6, lightIndex = 0, maxCasters = 1024 } = {}) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  rt.texture.name = 'lwCloudShadow';
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  geo.index = quad.index; geo.setAttribute('position', quad.attributes.position);
  const foot = new Float32Array(maxCasters * 4), foot2 = new Float32Array(maxCasters * 2);
  const aFoot = new THREE.InstancedBufferAttribute(foot, 4), aFoot2 = new THREE.InstancedBufferAttribute(foot2, 2);
  aFoot.setUsage(THREE.DynamicDrawUsage); aFoot2.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aFoot', aFoot); geo.setAttribute('aFoot2', aFoot2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { tNoise: { value: noise } }, vertexShader: FOOT_VERT, fragmentShader: FOOT_FRAG,
    depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,   // quads are laid face-down on the ground plane
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-extent / 2, extent / 2, extent / 2, -extent / 2, 1, 4000);
  cam.up.set(0, 0, -1);

  const uniforms = {
    tLwCloudShadow: { value: rt.texture },
    uLwCSRect: { value: new THREE.Vector4(-extent / 2, -extent / 2, 1 / extent, strength) },
  };
  const clear = new THREE.Color(0, 0, 0);
  const prevClear = new THREE.Color();

  function update(casters, anchor, sunDir, groundY = 0) {
    const texel = extent / size;
    const ax = Math.round(anchor.x / texel) * texel, az = Math.round(anchor.z / texel) * texel;   // snap: no swimming
    const sy = Math.max(sunDir.y, 0.08), kx = sunDir.x / sy, kz = sunDir.z / sy;
    let n = 0;
    for (const c of casters) {
      if (c.op < 0.01 || n >= maxCasters) continue;
      const ym = (c.y0 + c.y1) * 0.5 - groundY, hy = (c.y1 - c.y0) * 0.5;
      const x = c.x - kx * ym, z = c.z - kz * ym;                      // shadow lands down-sun of the cloud
      if (Math.abs(x - ax) > extent * 0.6 || Math.abs(z - az) > extent * 0.6) continue;
      foot.set([x, z, c.rx + Math.abs(kx) * hy * 0.5, c.rz + Math.abs(kz) * hy * 0.5], n * 4);
      foot2.set([c.op, (c.x * 0.0013 + c.z * 0.0007) % 1], n * 2);
      n++;
    }
    geo.instanceCount = n; aFoot.needsUpdate = aFoot2.needsUpdate = true;
    cam.position.set(ax, 2000, az); cam.lookAt(ax, 0, az); cam.updateMatrixWorld();
    uniforms.uLwCSRect.value.set(ax - extent / 2, az - extent / 2, 1 / extent, api.strength);
    const prevRT = renderer.getRenderTarget(), prevA = renderer.getClearAlpha();
    renderer.getClearColor(prevClear);
    renderer.setRenderTarget(rt); renderer.setClearColor(clear, 1); renderer.clear(true, false, false);
    if (n) renderer.render(scene, cam);
    renderer.setRenderTarget(prevRT); renderer.setClearColor(prevClear, prevA);
  }

  const HOOK = 'lwCloudShadow';
  function patch(material, { indirect = 0 } = {}) {
    if (!material || material.userData[HOOK] || !(material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial)) return false;
    material.userData[HOOK] = true;
    const ind = Math.min(1, Math.max(0, indirect));
    const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
    material.onBeforeCompile = function (sh, r) {
      if (prev) prev.call(this, sh, r);
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = 'varying vec3 vLwCsW;\n' + sh.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\n\tvLwCsW = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tLwCloudShadow; uniform vec4 uLwCSRect; varying vec3 vLwCsW;
float lwCloudShadow() {
  vec2 uv = ( vLwCsW.xz - uLwCSRect.xy ) * uLwCSRect.z;
  if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) return 1.0;
  return 1.0 - uLwCSRect.w * texture2D( tLwCloudShadow, vec2( uv.x, 1.0 - uv.y ) ).r;
}`)
        .replace('getDirectionalLightInfo( directionalLight, directLight );',
          `getDirectionalLightInfo( directionalLight, directLight );\n\t\t#if UNROLLED_LOOP_INDEX == ${lightIndex}\n\t\tdirectLight.color *= lwCloudShadow();\n\t\t#endif`);
      if (ind > 0) sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>',
        `#include <lights_fragment_end>\n\t{ float lwCsI = mix( 1.0, lwCloudShadow(), ${ind.toFixed(3)} ); reflectedLight.indirectDiffuse *= lwCsI; reflectedLight.indirectSpecular *= lwCsI; }`);
    };
    material.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|lwcs' + ind; };
    material.needsUpdate = true;
    return true;
  }
  function patchScene(root, filter = () => true) {
    let k = 0;
    root.traverse(o => {
      if (!o.isMesh || !filter(o)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (patch(m)) k++;
    });
    return k;
  }
  // debugging/tests: fraction of the map in shadow (> 0.1) and the mean shadow value; reads the GPU target (slow)
  function coverage() {
    const px = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
    let n = 0, s = 0; for (let i = 0; i < px.length; i += 4) { s += px[i]; if (px[i] > 25) n++; }
    return { shadowedPct: +(100 * n / (size * size)).toFixed(1), mean: +(s / (size * size) / 255).toFixed(3), casters: geo.instanceCount };
  }
  // debugging/tests: the shadow value (0..1) a patched material would read at world (x, z), via the same uv mapping
  function sampleAt(x, z) {
    const R = uniforms.uLwCSRect.value, u = (x - R.x) * R.z, v = (z - R.y) * R.z;
    if (u < 0 || v < 0 || u > 1 || v > 1) return 0;
    const px = new Uint8Array(4);
    renderer.readRenderTargetPixels(rt, Math.min(size - 1, Math.floor(u * size)), Math.min(size - 1, Math.floor((1 - v) * size)), 1, 1, px);
    return px[0] / 255;
  }
  const api = { texture: rt.texture, uniforms, strength, update, patch, patchScene, coverage, sampleAt, dispose() { rt.dispose(); geo.dispose(); mat.dispose(); } };
  return api;
}
