// Fair-weather cumulus you can fly past and through: lit impostor clouds for flight games.
//
// Not raymarched (too costly for integrated GPUs). Each cloud is a cluster of soft sphere impostors ("puffs"): one
// instanced quad per puff, camera-facing, with a sphere normal reconstructed per pixel. What makes them read as cumulus
// instead of smoke:
//   - real scale: bases at one condensation level (flat bottoms, cut per pixel), 300 m–1.5 km across, humilis /
//     mediocris / congestus heights
//   - sunlight with self-shadowing: per-puff transmittance toward the sun, precomputed on the CPU by marching through
//     the other puffs (re-baked when the sun moves), plus a per-pixel term for the puff's own far side
//   - grey-blue bases (ambient from the sea below, darker low in the cloud), bright sun-facing cauliflower tops
//   - a silver lining (Henyey–Greenstein forward scatter) on thin edges when you look toward the sun
//   - edges eroded by Long Wind's baked cloud noise (cellular + detail), locked to world space so they don't swim
// Lighting ideas (lit/shade split, silver lining, aerial haze) follow Long Wind's painted clouds (src/world/sky.js,
// github.com/jbang2004/long-wind, MIT). The impostor field itself is new.
//
//   const cu = createCumulus(THREE, { renderer, noise, tile: 24000, seaY: 0, base: 620, quality: 'med', seed: 7 })
//   scene.add(cu.mesh)
//   cu.update(camera, anchor, { sunDir, sunCol, skyTop, skyBot })    — every frame (anchor: where the field centres)
//   cu.clusters[i].op = 0..1                                          — host fade per cloud (storms, tile edges are automatic)
//   cu.inside(pos) → 0..1                                             — how deep pos is inside a cloud (whiteout fog)
//   cu.casters() → [{x, z, y0, y1, rx, rz, op}]                       — world-space cloud bodies (shadow maps)
//   cu.addCluster({x, z, w, h, base?})                                — extra clouds (e.g. over an island ridge), tile space
//   cu.stats() → {clusters, puffs, drawn}
//
// The material includes three's fog chunks after tone mapping (fog blends in display space, as three does for every
// built-in material), so distant clouds melt into the same haze as the terrain and sea.
const Q = { low: { clusters: 70, puffK: 0.55 }, med: { clusters: 105, puffK: 0.75 }, high: { clusters: 150, puffK: 1 } };
const TEXW = 256;

function rngOf(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const VERT = /* glsl */`
uniform sampler2D tPuff, tClus;
attribute float aIdx;
varying vec2 vUv;
varying vec3 vC;          // puff centre (world)
varying float vR;         // puff radius
varying vec4 vCl;         // cluster centre at mid-height (xyz), base altitude (w)
varying vec3 vExt;        // cluster half extents
varying vec4 vInfo;       // sun transmittance, ambient occlusion, -, seed
varying float vA;         // opacity after fades
#include <fog_pars_vertex>
ivec2 lwTc(float i, int k) { int n = int(i + 0.5) * 2 + k; return ivec2(n % ${TEXW}, n / ${TEXW}); }
void main() {
  vec4 p0 = texelFetch(tPuff, lwTc(aIdx, 0), 0), p1 = texelFetch(tPuff, lwTc(aIdx, 1), 0);
  vec4 c0 = texelFetch(tClus, lwTc(p1.x, 0), 0), c1 = texelFetch(tClus, lwTc(p1.x, 1), 0);
  vec3 center = c0.xyz + p0.xyz;
  float r = p0.w;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float dist = distance(center, cameraPosition);
  // near fade: puffs the camera is inside (or about to be) dissolve; the host's whiteout fog takes over
  vA = c0.w * smoothstep(r * 0.55, r * 1.65, dist);
  vec3 wp = center + (right * position.x + up * position.y) * r * 1.2;
  vUv = position.xy * 1.2;
  vC = center; vR = r;
  vCl = vec4(c0.x, c0.y + c1.y, c0.z, c0.y);
  vExt = c1.xyz;
  vInfo = vec4(p1.y, p1.z, 0.0, p1.w);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  if (vA < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);    // culled: off the raster
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform sampler2D tNoise;
uniform vec3 uSunDir, uSunCol, uSkyTop, uSkyBot;
uniform float uSilver, uDensity, uTime, uSunGain;
varying vec2 vUv;
varying vec3 vC;
varying float vR;
varying vec4 vCl;
varying vec3 vExt;
varying vec4 vInfo;
varying float vA;
#include <fog_pars_fragment>
void main() {
  float d2 = dot(vUv, vUv);
  if (d2 > 1.44) discard;
  float d = sqrt(d2);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 toCam = normalize(cameraPosition - vC);
  float nz = sqrt(max(1.0 - min(d2, 1.0), 0.0));
  vec3 Ns = normalize(right * vUv.x + up * vUv.y + toCam * (nz + 0.05));
  vec3 P = vC + Ns * vR;                                   // sphere surface point
  vec3 Qp = vC + (right * vUv.x + up * vUv.y) * vR;        // point on the impostor plane
  // edge erosion: world-locked cellular + detail noise, so the cauliflower doesn't swim as you fly past
  // lobes scale with the puff; the fine detail is fixed in metres so a cloud stays crisp when you're close to it
  vec2 wq = P.xz + vec2(P.y * 0.61, -P.y * 0.43);
  float lobe = texture2D(tNoise, wq / (vR * 3.4) + vInfo.w * 7.13 + vec2(uTime * 0.0004, 0.0)).b;
  float fine = mix(texture2D(tNoise, wq / 140.0 + 0.37).a,                       // tops: horizontal projection
                   texture2D(tNoise, vec2(P.x * 0.8 - P.z * 0.6, P.y) / 140.0 + 0.71).a,   // sides: vertical (no streaks)
                   smoothstep(0.35, 0.75, 1.0 - abs(Ns.y)));
  float ero = lobe * 0.65 + fine * 0.35;
  float e0 = 0.5 + 0.38 * (ero - 0.5);
  float a = 1.0 - smoothstep(e0, e0 + 0.32, d);
  // flat base at the condensation level
  a *= smoothstep(vCl.w - 0.02 * vR, vCl.w + 0.2 * vR, min(Qp.y, P.y + 0.15 * vR));
  a *= uDensity * vA;
  if (a < 0.004) discard;

  vec3 Nc = (P - vCl.xyz) / max(vExt, vec3(1.0));
  vec3 N = normalize(normalize(Nc) * 0.7 + Ns * 0.3);       // mostly the whole cloud's shape: no bubble-wrap
  vec3 L = uSunDir;
  float hF = clamp((P.y - vCl.w) / max(2.0 * vExt.y, 1.0), 0.0, 1.0);
  float diff = clamp(dot(N, L) * 0.55 + 0.45, 0.0, 1.0);
  float selfS = mix(0.62, 1.0, smoothstep(-0.45, 0.55, dot(Ns, L)));
  float sunT = mix(0.4, 1.0, vInfo.x) * selfS;            // light that scattered through still arrives (multiple scattering)
  vec3 col = uSunCol * uSunGain * diff * sunT;
  // light scattered all through the cloud (bases glow grey, not black); weaker and less coloured with a low sun
  vec3 ms = mix(uSunCol, vec3(dot(uSunCol, vec3(0.2126, 0.7152, 0.0722))), 0.55) * clamp(L.y * 2.5, 0.2, 1.0);
  col += ms * uSunGain * 0.17 * mix(0.55, 1.0, vInfo.x);
  col += mix(uSkyBot, uSkyTop, clamp(N.y * 0.5 + 0.5, 0.0, 1.0)) * vInfo.y * mix(0.72, 1.0, hF);
  col *= mix(0.86, 1.0, smoothstep(0.0, 0.3, hF));         // grey base
  // silver lining: forward scatter through thin edges when looking toward the sun
  vec3 V = normalize(P - cameraPosition);
  float mu = dot(V, L), g = 0.7;
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.0796;
  // only the whole cloud's silhouette glows (per-puff rims read as bubble-wrap), even when the body is in its own shadow
  float rim = pow(1.0 - abs(dot(normalize(Nc), V)), 2.0) * smoothstep(0.3, 1.05, d);
  col += uSunCol * hg * rim * mix(0.45, 1.0, vInfo.x) * uSilver;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export function createCumulus(THREE, {
  renderer, noise, tile = 24000, seaY = 0, base = 620, quality = 'med', seed = 7, coverage = 1,
} = {}) {
  const q = Q[quality] ?? Q.med;
  const rnd = rngOf(seed * 7919 + 13);
  const clusters = [];      // {bx, bz, base, w, h, d, op, x, z, puffs: [first, count]}
  const puffs = [];         // {cl, ox, oy, oz, r, occ, amb, seed}

  function buildCluster(bx, bz, w, h, baseAlt) {
    const ci = clusters.length, d = w * (0.6 + rnd() * 0.3), first = puffs.length;
    const k = q.puffK, put = (ox, oy, oz, r) => puffs.push({ cl: ci, ox, oy, oz, r, occ: 1, amb: 1, seed: rnd() });
    // base ring: wide flat puffs sitting on the condensation level
    const nb = Math.max(3, Math.round((5 + rnd() * 4) * k));
    for (let i = 0; i < nb; i++) {
      const a = (i + rnd() * 0.6) / nb * Math.PI * 2, f = 0.45 + 0.5 * rnd(), r = w * (0.15 + 0.07 * rnd());
      put(Math.cos(a) * w * 0.33 * f, r * 0.62, Math.sin(a) * d * 0.33 * f, r);
    }
    put(0, w * 0.17, 0, w * 0.25);                                           // core
    // body: rising, narrowing
    const nm = Math.max(2, Math.round((3 + rnd() * 4) * k * (0.6 + h / w)));
    for (let i = 0; i < nm; i++) {
      const a = rnd() * Math.PI * 2, f = rnd() * 0.24, r = w * (0.12 + 0.08 * rnd());
      put(Math.cos(a) * w * f, h * (0.3 + 0.32 * rnd()), Math.sin(a) * d * f, r);
    }
    // tower: a broad column, two or three puffs per level, shrinking upward (single-puff columns read as snowmen)
    let ty = h * 0.3, tx = 0, tz = 0, guard = 0;
    while (ty < h - w * 0.08 && guard++ < 12) {
      const R = w * (0.2 + 0.05 * rnd()) * (1 - 0.38 * ty / h);
      ty = Math.min(ty + R * 0.55, h - R * 0.85);
      const nl = R > w * 0.15 ? 2 + (rnd() < 0.4 ? 1 : 0) : 1, a0 = rnd() * Math.PI * 2;
      for (let j = 0; j < nl; j++) {
        const aj = a0 + j / nl * Math.PI * 2, off = nl > 1 ? R * 0.5 : 0;
        put(tx + Math.cos(aj) * off, ty - rnd() * R * 0.15, tz + Math.sin(aj) * off, R * (0.82 + 0.18 * rnd()));
      }
      tx += (rnd() - 0.5) * R * 0.35; tz += (rnd() - 0.5) * R * 0.35;
    }
    // cauliflower detail: small puffs on the upper surface
    const nd = Math.round((2 + rnd() * 4) * k);
    for (let i = 0; i < nd; i++) {
      const a = rnd() * Math.PI * 2, f = 0.12 + rnd() * 0.2, r = w * (0.06 + 0.04 * rnd());
      put(Math.cos(a) * w * f, h * (0.35 + 0.4 * rnd()), Math.sin(a) * d * f, r);
    }
    // settle: any puff not resting on a lower one slides toward the nearest lower puff until they overlap
    const mine = puffs.slice(first).sort((a, b) => a.oy - b.oy);
    for (const p of mine) {
      if (p.oy - p.r <= 0.05 * w) continue;
      let best = null, bd = Infinity;
      for (const q of mine) {
        if (q === p || q.oy >= p.oy) continue;
        const dd = Math.hypot(q.ox - p.ox, q.oy - p.oy, q.oz - p.oz);
        if (dd < (q.r + p.r) * 0.9) { best = null; bd = -1; break; }
        if (dd - q.r < bd) { bd = dd - q.r; best = q; }
      }
      if (best) {
        const dx = p.ox - best.ox, dy = p.oy - best.oy, dz = p.oz - best.oz, dd = Math.hypot(dx, dy, dz), want = (best.r + p.r) * 0.75;
        p.ox = best.ox + dx / dd * want; p.oy = best.oy + dy / dd * want; p.oz = best.oz + dz / dd * want;
      }
    }
    clusters.push({ bx, bz, base: baseAlt, w, h, d, op: 1, x: bx, z: bz, first, count: puffs.length - first });
  }

  // field: humilis (flat), mediocris, a few congestus; jittered grid so clouds never pile up
  const n = Math.round(q.clusters * coverage), grid = Math.ceil(Math.sqrt(n)), cell = tile / grid;
  for (let gz = 0, made = 0; gz < grid; gz++) for (let gx = 0; gx < grid && made < n; gx++, made++) {
    const bx = -tile / 2 + (gx + 0.15 + 0.7 * rnd()) * cell, bz = -tile / 2 + (gz + 0.15 + 0.7 * rnd()) * cell;
    const kind = rnd();
    const w = kind < 0.6 ? 320 + rnd() * 520 : kind < 0.94 ? 550 + rnd() * 700 : 700 + rnd() * 600;
    const h = w * (kind < 0.6 ? 0.38 + rnd() * 0.2 : kind < 0.94 ? 0.62 + rnd() * 0.3 : 1.0 + rnd() * 0.35);
    buildCluster(bx, bz, w, h, base + (rnd() - 0.5) * 80);
  }

  // GPU data: puffs (2 texels each), clusters (2 texels each), sorted index attribute
  const MAXP = 8192, MAXC = 1024;
  const puffData = new Float32Array(TEXW * Math.ceil(MAXP * 2 / TEXW) * 4);
  const clusData = new Float32Array(TEXW * Math.ceil(MAXC * 2 / TEXW) * 4);
  const mkTex = (data) => {
    const t = new THREE.DataTexture(data, TEXW, data.length / 4 / TEXW, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  };
  const tPuff = mkTex(puffData), tClus = mkTex(clusData);
  function writePuffs() {
    puffs.forEach((p, i) => {
      puffData.set([p.ox, p.oy, p.oz, p.r, p.cl, p.occ, p.amb, p.seed], i * 8);
    });
    tPuff.needsUpdate = true;
  }

  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  geo.index = quad.index; geo.setAttribute('position', quad.attributes.position);
  const idx = new Float32Array(MAXP);
  const aIdx = new THREE.InstancedBufferAttribute(idx, 1); aIdx.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aIdx', aIdx);
  geo.instanceCount = 0;

  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    tNoise: { value: null }, tPuff: { value: null }, tClus: { value: null },   // set after the merge (it clones textures)
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) },
    uSkyTop: { value: new THREE.Color(0.4, 0.5, 0.6) }, uSkyBot: { value: new THREE.Color(0.2, 0.25, 0.3) },
    uSilver: { value: 1.0 }, uDensity: { value: 0.95 }, uTime: { value: 0 }, uSunGain: { value: 2.0 },
  }]);
  uniforms.tNoise.value = noise; uniforms.tPuff.value = tPuff; uniforms.tClus.value = tClus;
  const material = new THREE.ShaderMaterial({
    name: 'lwCumulus', uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, fog: true,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'lwCumulus'; mesh.frustumCulled = false; mesh.renderOrder = 1;

  // ---- sun transmittance per puff: march toward the sun through the cluster's other puffs ----
  const sunPrev = new THREE.Vector3(0, -1, 0);
  function bakeSun(L) {
    for (const c of clusters) {
      const sig = 1 / (0.8 * c.w);
      for (let i = c.first; i < c.first + c.count; i++) {
        const p = puffs[i];
        const ox = p.ox + L.x * p.r * 0.35, oy = p.oy + L.y * p.r * 0.35, oz = p.oz + L.z * p.r * 0.35;
        let tau = 0, above = 0;
        for (let j = c.first; j < c.first + c.count; j++) {
          if (j === i) continue;
          const s = puffs[j], rr = s.r * 0.85;
          const wx = s.ox - ox, wy = s.oy - oy, wz = s.oz - oz;
          const t = wx * L.x + wy * L.y + wz * L.z;
          if (t > 0) {
            const dd = wx * wx + wy * wy + wz * wz - t * t;
            if (dd < rr * rr) tau += 2 * Math.sqrt(rr * rr - dd);
          }
          if (s.oy > p.oy + p.r * 0.3 && Math.hypot(s.ox - p.ox, s.oz - p.oz) < s.r + p.r * 0.5) above++;
        }
        p.occ = Math.exp(-tau * sig);
        p.amb = Math.max(0.55, 1 - 0.1 * above - 0.18 * (1 - Math.min(1, p.oy / Math.max(c.h, 1))));
      }
    }
    writePuffs();
  }

  // ---- per frame ----
  const camF = new THREE.Vector3(), keys = new Float64Array(MAXP);
  let drawn = 0, elapsed = 0;
  const wrap = (v) => v - tile * Math.round(v / tile);
  function update(camera, anchor, { sunDir, sunCol, skyTop, skyBot, silver = 1, density = 0.95, sunGain = 2, dt = 0 } = {}) {
    elapsed += dt; uniforms.uTime.value = elapsed;
    if (sunDir) {
      uniforms.uSunDir.value.copy(sunDir);
      if (sunDir.angleTo(sunPrev) > 0.03) { sunPrev.copy(sunDir); bakeSun(sunDir); }
    }
    if (sunCol) uniforms.uSunCol.value.copy(sunCol);
    if (skyTop) uniforms.uSkyTop.value.copy(skyTop);
    if (skyBot) uniforms.uSkyBot.value.copy(skyBot);
    uniforms.uSilver.value = silver; uniforms.uDensity.value = density; uniforms.uSunGain.value = sunGain;
    // wrap clusters around the anchor and fade them at the tile edge
    clusters.forEach((c, i) => {
      const dx = wrap(c.bx - anchor.x), dz = wrap(c.bz - anchor.z);
      c.x = anchor.x + dx; c.z = anchor.z + dz;
      const edge = 1 - smoothstep(0.8, 0.98, Math.max(Math.abs(dx), Math.abs(dz)) / (tile / 2));
      c.vis = c.op * edge;
      clusData.set([c.x, seaY + c.base, c.z, c.vis, c.w * 0.5, c.h * 0.5, c.d * 0.5, 0], i * 8);
    });
    tClus.needsUpdate = true;
    // visible puffs, sorted far to near
    camera.getWorldDirection(camF);
    const cp = camera.position;
    let m = 0;
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i], c = clusters[p.cl];
      if (c.vis < 0.004) continue;
      const x = c.x + p.ox - cp.x, y = seaY + c.base + p.oy - cp.y, z = c.z + p.oz - cp.z;
      const depth = x * camF.x + y * camF.y + z * camF.z;
      if (depth < -p.r * 1.3) continue;                    // behind the camera
      keys[m++] = Math.floor(Math.max(0, 200000 - depth) * 4) * 8192 + i;   // ascending key = far first (0.25 m steps)
    }
    const view = keys.subarray(0, m);
    view.sort();
    for (let k = 0; k < m; k++) idx[k] = view[k] % 8192;
    aIdx.needsUpdate = true;
    geo.instanceCount = drawn = m;
  }

  function inside(pos) {
    let best = 0;
    for (const c of clusters) {
      if (c.vis < 0.05) continue;
      const dx = pos.x - c.x, dz = pos.z - c.z;
      if (Math.abs(dx) > c.w || Math.abs(dz) > c.w) continue;
      for (let i = c.first; i < c.first + c.count; i++) {
        const p = puffs[i];
        const r = Math.hypot(dx - p.ox, pos.y - (seaY + c.base + p.oy), dz - p.oz) / (p.r * 0.95);
        if (pos.y < seaY + c.base) continue;
        best = Math.max(best, (1 - smoothstep(0.55, 1, r)) * c.vis);
      }
    }
    return best;
  }

  function casters() {
    return clusters.map(c => ({ x: c.x, z: c.z, y0: seaY + c.base, y1: seaY + c.base + c.h, rx: c.w * 0.42, rz: c.d * 0.42, op: c.vis ?? c.op }));
  }

  function addCluster({ x, z, w = 700, h = 600, base: b = base }) {
    if (puffs.length > MAXP - 64 || clusters.length >= MAXC) return -1;
    buildCluster(x, z, w, h, b);
    sunPrev.set(0, -1, 0);   // force a re-bake of transmittance
    return clusters.length - 1;
  }

  writePuffs();
  return {
    mesh, material, uniforms, clusters, puffs, update, inside, casters, addCluster,
    stats: () => ({ clusters: clusters.length, puffs: puffs.length, drawn }),
    dispose() { geo.dispose(); material.dispose(); tPuff.dispose(); tClus.dispose(); },
  };
}

function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
