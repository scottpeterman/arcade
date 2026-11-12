// Fair-weather cumulus you can fly past and through: lit impostor clouds for flight games.
//
// Not raymarched (too costly for integrated GPUs). Each cloud is a cluster of soft sphere impostors ("puffs"): one
// instanced quad per puff, camera-facing, with a sphere normal reconstructed per pixel. What makes them read as cumulus
// instead of smoke:
//   - real shapes and grouping: each cloud is a long low loaf (mostly 0.25-0.5 as tall as wide) on a flat base, with a
//     few broad humps and cauliflower only along the upper edge; clouds come in families stretched along `streets`
//     (radians): a dominant cloud, a loose row of neighbours that sometimes touch, and ragged scraps; `towers` of them
//     (default 4%) carry a congestus turret
//   - one noise field per cloud: every puff cuts its edge from the same lumps (300 m / 120 m / 45 m), sampled in a
//     camera-facing frame that stays level and is anchored at the cloud's centre, so puffs merge into one surface
//     instead of reading as separate balls; octaves fade once they're under a few pixels
//   - sunlight with self-shadowing: per-puff transmittance toward the sun, precomputed on the CPU by marching through
//     the other puffs (re-baked when the sun moves); shaded sides stay bright (multiple scattering), lumps lighter
//     than the crevices between them
//   - grey-blue bases (ambient from the sea below), bright sun-facing tops
//   - a silver lining (Henyey–Greenstein forward scatter) on thin edges when you look toward the sun
// Lighting ideas (lit/shade split, silver lining, aerial haze) follow Long Wind's painted clouds (src/world/sky.js,
// github.com/jbang2004/long-wind, MIT). The impostor field itself is new.
//
//   const cu = createCumulus(THREE, { renderer, noise, tile: 24000, seaY: 0, base: 620, quality: 'med', seed: 7,
//                                     streets: 0.35, towers: 0.04 })
//   scene.add(cu.mesh)
//   cu.update(camera, anchor, { sunDir, sunCol, skyTop, skyBot })    — every frame (anchor: where the field centres)
//   cu.clusters[i].op = 0..1                                          — host fade per cloud (storms, tile edges are automatic)
//   cu.inside(pos) → 0..1                                             — how deep pos is inside a cloud (whiteout fog)
//   cu.cloudIn(from, to) → 0..1, cu.occluded(from, to, .5) → bool     — cloud in front of `to` (transparent sort)
//   cu.casters() →[{x, z, y0, y1, rx, rz, op}]                       — world-space cloud bodies (shadow maps)
//   cu.addCluster({x, z, w, h, base?})                                — extra clouds (e.g. over an island ridge), tile space
//   cu.stats() → {clusters, puffs, drawn}
//
// The material includes three's fog chunks after tone mapping (fog blends in display space, as three does for every
// built-in material), so distant clouds melt into the same haze as the terrain and sea.
const Q = { low: { clusters: 70, puffK: 0.55, puffs: 2600 }, med: { clusters: 105, puffK: 0.75, puffs: 4300 }, high: { clusters: 150, puffK: 1, puffs: 6700 } };
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
varying vec4 vInfo;       // sun transmittance, ambient occlusion, rag (0 body … 1 scrap), seed
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
  vInfo = vec4(p1.y, p1.z, c1.w, p1.w);
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
  vec3 Nc = (P - vCl.xyz) / max(vExt, vec3(1.0));
  vec3 Ncn = normalize(Nc);
  // ONE field for the whole cloud: every puff cuts its edge from the same lumps, so the cauliflower comes from the noise
  // and not from the puffs (per-puff noise made each one a separately wrapped ball). Impostors have no real surface to
  // project onto (top/side projections streaked and ringed), so the field lives in a frame that faces the camera,
  // stays level with the horizon (banking doesn't drag it) and is anchored at the cloud's centre: overlapping puffs
  // agree exactly, nothing stretches, and the pattern only turns as you fly around the cloud.
  vec3 cdir = normalize(vCl.xyz - cameraPosition);
  vec3 cR = normalize(cross(cdir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec3 cU = cross(cR, cdir);
  vec2 fq = vec2(dot(Qp - vCl.xyz, cR), dot(Qp - vCl.xyz, cU)) + vCl.xz * 0.37 + vec2(uTime * 0.35, 0.0);
  float o1 = texture2D(tNoise, fq / 300.0).b;
  float o2 = texture2D(tNoise, fq / 120.0 + 0.31).b;
  float o3 = texture2D(tNoise, fq / 45.0 + 0.71).a;
  // octaves smaller than ~8 px fade to their mean: far clouds keep the big lumps, lose the sub-pixel sparkle
  float mpp = max(length(dFdx(Qp)), length(dFdy(Qp)));           // metres per pixel (planar: smooth, no noise)
  float w2 = 1.0 - smoothstep(120.0 / 16.0, 120.0 / 6.0, mpp), w3 = 1.0 - smoothstep(45.0 / 24.0, 45.0 / 10.0, mpp);
  float field = o1 * 0.62 + mix(0.5, o2, w2) * 0.3 + mix(0.5, o3, w3) * 0.08;   // smooth bulges: the fine octave only breaks the outline
  float hF = clamp((P.y - vCl.w) / max(2.0 * vExt.y, 1.0), 0.0, 1.0);
  // density = puff kernel + field: edges move by up to ~45% of the radius; crisp on the upper cloud, softer below
  float D = (1.08 - d) + (0.95 + 0.35 * vInfo.z) * (field - 0.5);
  float soft = mix(mix(0.26, 0.09, smoothstep(0.15, 0.6, hF)), 0.4, vInfo.z);   // scraps: soft and ragged all over
  float a = smoothstep(0.0, max(soft, fwidth(D) * 1.5), D);      // never narrower than ~1.5 px: no stair-stepped edges
  // flat base at the condensation level
  a *= smoothstep(vCl.w - 0.02 * vR, vCl.w + 0.2 * vR, min(Qp.y, P.y + 0.15 * vR));
  a *= uDensity * vA;
  if (a < 0.004) discard;

  // surface normal: the whole cloud's shape. The lumps light through the cavity term below, read from the field
  // itself (a screen-space bump from the noise flickered in 2x2 blocks).
  vec3 N = Ncn;
  float cav = mix(0.88, 1.06, smoothstep(0.3, 0.75, field));
  vec3 L = uSunDir;
  float diff = clamp(dot(N, L) * 0.4 + 0.6, 0.0, 1.0);
  float selfS = mix(0.78, 1.0, smoothstep(-0.45, 0.55, dot(N, L)));      // the cloud's side away from the sun, not each puff's
  float sunT = mix(0.55, 1.0, vInfo.x) * selfS;            // light that scattered through still arrives (multiple scattering)
  vec3 col = uSunCol * uSunGain * diff * sunT;
  // light scattered all through the cloud (bases glow grey, not black); weaker and less coloured with a low sun
  vec3 ms = mix(uSunCol, vec3(dot(uSunCol, vec3(0.2126, 0.7152, 0.0722))), 0.55) * clamp(L.y * 2.5, 0.2, 1.0);
  col += ms * uSunGain * 0.24 * mix(0.6, 1.0, vInfo.x);   // cumulus is bright all through: shaded sides ~60-70% of lit
  col += mix(uSkyBot, uSkyTop, clamp(N.y * 0.5 + 0.5, 0.0, 1.0)) * vInfo.y * mix(0.72, 1.0, hF);
  col *= mix(0.86, 1.0, smoothstep(0.0, 0.3, hF));         // grey base
  col *= mix(1.0, cav, smoothstep(0.05, 0.35, hF));          // crevices between lumps darker, lumps catch the light
  // silver lining: forward scatter through thin edges when looking toward the sun
  vec3 V = normalize(P - cameraPosition);
  float mu = dot(V, L), g = 0.7;
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.0796;
  // only the whole cloud's silhouette glows (per-puff rims read as bubble-wrap), even when the body is in its own shadow
  float rim = pow(1.0 - abs(dot(Ncn, V)), 2.0) * (1.0 - smoothstep(0.0, 0.45, D));
  col += uSunCol * hg * rim * mix(0.45, 1.0, vInfo.x) * uSilver;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export function createCumulus(THREE, {
  renderer, noise, tile = 24000, seaY = 0, base = 620, quality = 'med', seed = 7, coverage = 1, streets = 0.35, towers = 0.04,
} = {}) {
  const q = Q[quality] ?? Q.med;
  const rnd = rngOf(seed * 7919 + 13);
  const clusters = [];      // {bx, bz, base, w, h, d, op, x, z, puffs: [first, count]}
  const puffs = [];         // {cl, ox, oy, oz, r, occ, amb, seed}

  // One cloud, built as fair-weather cumulus actually looks: a long low loaf on a flat base, a few broad humps of
  // different heights, and cauliflower only along the upper edge. Built along its own long axis, then turned to `ang`.
  //   w: length along the axis, h: top height, rag: 0 a solid body … 1 a soft ragged scrap, tower: a congestus turret
  function buildCluster(bx, bz, w, h, baseAlt, { ang = 0, rag = 0, tower = false } = {}) {
    const ci = clusters.length, first = puffs.length, k = q.puffK;
    const d = w * (0.38 + rnd() * 0.2);
    const local = [], put = (u, y, v, r) => local.push([u, y, v, r]);
    if (rag > 0.5) {                                                      // fragment: a few low puffs, no structure
      const n = 2 + Math.round(rnd() * 3 * Math.max(0.6, k));
      for (let i = 0; i < n; i++) {
        const r = h * (0.45 + rnd() * 0.35);
        put((rnd() - 0.5) * (w - r), r * (0.5 + rnd() * 0.3), (rnd() - 0.5) * d * 0.5, r);
      }
    } else {
      // base layer: wide flat puffs along the whole length (two rows on fat clouds)
      const rb = h * (0.42 + rnd() * 0.12), step = rb * (1.25 - 0.3 * k), rows = d > rb * 2.2 ? 2 : 1;
      for (let row = 0; row < rows; row++) for (let u = -w / 2 + rb * 0.8; u <= w / 2 - rb * 0.8; u += step * (0.8 + 0.4 * rnd())) {
        const taper = 1 - 0.35 * Math.pow(Math.abs(u) / (w / 2), 2);      // ends lower and thinner
        put(u, rb * 0.55 * taper, (rows > 1 ? (row - 0.5) * d * 0.42 : 0) + (rnd() - 0.5) * d * 0.18, rb * taper);
      }
      // humps: 1-4 broad domes of different heights; the tallest is not always in the middle
      const nh = Math.max(1, Math.min(4, Math.round(w / (h * 2.2) * (0.7 + rnd() * 0.6)))), humps = [];
      for (let i = 0; i < nh; i++) {
        const u = (nh === 1 ? (rnd() - 0.5) * 0.3 : (i / (nh - 1) - 0.5) * 0.75 + (rnd() - 0.5) * 0.15) * w;
        humps.push({ u, top: h * (i === ((rnd() * nh) | 0) ? 1 : 0.55 + rnd() * 0.35), wid: w / nh * (0.45 + rnd() * 0.25) });
      }
      if (!humps.some(m => m.top >= h * 0.99)) humps[(rnd() * nh) | 0].top = h;
      for (const m of humps) {
        const R = Math.min(m.wid, m.top) * 0.55;
        const nl = Math.max(1, Math.round((m.top - R) / (R * 0.8)));
        for (let j = 0; j <= nl; j++) {                                   // a dome: wider low, one crown on top
          const y = R * 0.6 + (m.top - R * 1.55) * (nl ? j / nl : 1), f = 1 - 0.3 * (nl ? j / nl : 1);
          const pair = j < nl && R * f > h * 0.18;
          for (const s of pair ? [-1, 1] : [0]) put(m.u + s * R * 0.45 + (rnd() - 0.5) * R * 0.2, y, (rnd() - 0.5) * d * 0.2, R * f * (0.9 + rnd() * 0.15));
        }
      }
      // cauliflower: small puffs only along the upper envelope
      const env = (u) => Math.max(h * 0.4, ...humps.map(m => m.top * Math.max(0, 1 - Math.pow((u - m.u) / (m.wid * 1.1), 2))));
      const nc = Math.round((3 + w / 140) * k);
      for (let i = 0; i < nc; i++) {
        const u = (rnd() - 0.5) * w * 0.85, r = h * (0.12 + rnd() * 0.1);
        put(u, env(u) - r * (0.55 + rnd() * 0.3), (rnd() - 0.5) * d * 0.35, r);
      }
      if (tower) {                                                        // rare congestus turret over the tallest hump
        const m = humps.reduce((a, b) => (b.top > a.top ? b : a));
        let y = m.top, R = Math.min(m.wid, h) * 0.42;
        for (let j = 0; j < 3; j++, R *= 0.8) { y += R * 0.75; put(m.u + (rnd() - 0.5) * R * 0.3, y, (rnd() - 0.5) * R * 0.3, R); }
      }
    }
    // turn to the family's axis; extents from what was built
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let ex = 1, ez = 1, ey = 1;
    for (const [u, y, v, r] of local) {
      const ox = u * ca - v * sa, oz = u * sa + v * ca;
      puffs.push({ cl: ci, ox, oy: y, oz, r, occ: 1, amb: 1, seed: rnd() });
      ex = Math.max(ex, Math.abs(ox) + r * 0.7); ez = Math.max(ez, Math.abs(oz) + r * 0.7); ey = Math.max(ey, y + r * 0.85);
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
    clusters.push({ bx, bz, base: baseAlt, w: ex * 2, h: ey, d: ez * 2, rag, op: 1, x: bx, z: bz, first, count: puffs.length - first });
  }

  // field: families, as fair-weather cumulus actually sits — a dominant cloud stretched along the wind, a loose row of
  // neighbours that sometimes touch and chain, and scraps around them; a few towers. Fills the tier's puff budget.
  const budget = q.puffs * coverage, nFam = Math.max(4, Math.round(q.clusters * 0.3 * coverage));
  const grid = Math.ceil(Math.sqrt(nFam)), cell = tile / grid, cap = (n) => puffs.length < budget && clusters.length < 1000 - n;
  const mainH = (w, tower) => w * (tower ? 0.5 + rnd() * 0.2 : 0.26 + rnd() * 0.2);
  for (let pass = 0; pass < 3 && cap(8); pass++)
    for (let gz = 0; gz < grid && cap(8); gz++) for (let gx = 0; gx < grid && cap(8); gx++) {
      if (pass > 0 && rnd() < 0.5) continue;                              // later passes: sparser, in the gaps
      const cx = -tile / 2 + (gx + 0.1 + 0.8 * rnd()) * cell, cz = -tile / 2 + (gz + 0.1 + 0.8 * rnd()) * cell;
      const ang = streets + (rnd() - 0.5) * 0.5, ca = Math.cos(ang), sa = Math.sin(ang);
      const W = (450 + 1100 * Math.pow(rnd(), 1.6)) * (pass ? 0.7 : 1), tower = rnd() < towers, b0 = base + (rnd() - 0.5) * 70;
      buildCluster(cx, cz, W, mainH(W, tower), b0, { ang, tower });
      let along = W / 2;                                                  // the row: alternately ahead and behind
      for (let i = 0, nr = (rnd() * 3.2) | 0; i < nr && cap(4); i++) {
        const w = W * (0.3 + rnd() * 0.45), gap = (rnd() < 0.45 ? -0.15 : 0.1 + rnd() * 0.5) * w, s = i % 2 ? -1 : 1;
        const u = s * (along + gap + w / 2), v = (rnd() - 0.5) * W * 0.9;   // a loose row, not a string
        if (s < 0) along += gap + w;
        buildCluster(cx + u * ca - v * sa, cz + u * sa + v * ca, w, mainH(w, false), b0 + (rnd() - 0.5) * 60, { ang: ang + (rnd() - 0.5) * 0.5 });
      }
      for (let i = 0, nf = 2 + ((rnd() * 5) | 0); i < nf && cap(2); i++) {   // scraps, mostly downwind
        const w = 70 + rnd() * 190, r = W * (0.55 + rnd() * 0.9), a = ang + (rnd() < 0.7 ? 0 : Math.PI) + (rnd() - 0.5) * 1.4;
        buildCluster(cx + Math.cos(a) * r, cz + Math.sin(a) * r, w, w * (0.35 + rnd() * 0.25), b0 + (rnd() - 0.3) * 60, { ang: ang + (rnd() - 0.5), rag: 1 });
      }
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
      clusData.set([c.x, seaY + c.base, c.z, c.vis, c.w * 0.5, c.h * 0.5, c.d * 0.5, c.rag ?? 0], i * 8);
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

  // How much cloud is in front of `to`, seen from `from`: 0 clear … 1 solid. The whole field is one transparent mesh,
  // so a host can't rely on three's per-object sort to put a transparent thing (prop disc, canopy) between the clouds
  // behind it and the clouds in front of it. Ask this per object instead: low → draw it after the clouds
  // (renderOrder > 1), high → before them. Each puff counts with the shader's own alpha at the field's mean (kernel
  // 1.08 - d over the soft band, cluster fade, near fade, density): a big puff whose transparent rim merely clips the
  // sight line barely counts; the core of a cloud counts fully. Puffs combine like stacked layers. Call after update().
  function cloudIn(from, to, density = 0.95) {
    let dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return 0;
    dx /= L; dy /= L; dz /= L;
    let clear = 1;
    for (const c of clusters) {
      if (c.vis < 0.004) continue;
      if (c.bR === undefined) {                                             // bounding sphere of the cluster's billboards (puffs never move after build)
        let r = 0;
        for (let i = c.first; i < c.first + c.count; i++) { const p = puffs[i]; r = Math.max(r, Math.hypot(p.ox, p.oy - c.h * 0.5, p.oz) + p.r * 1.2); }
        c.bR = r;
      }
      const cy = seaY + c.base + c.h * 0.5, R = c.bR;
      const qx = c.x - from.x, qy = cy - from.y, qz = c.z - from.z;
      const t = qx * dx + qy * dy + qz * dz;
      if (t < -R || t - R > L) continue;
      if (qx * qx + qy * qy + qz * qz - t * t > R * R) continue;
      const soft = 0.18 + 0.22 * (c.rag ?? 0);                            // shader: 0.26 base … 0.09 tops, 0.4 on scraps
      for (let i = c.first; i < c.first + c.count; i++) {
        const p = puffs[i];
        const px = c.x + p.ox - from.x, py = seaY + c.base + p.oy - from.y, pz = c.z + p.oz - from.z;
        const tp = px * dx + py * dy + pz * dz;
        if (tp <= 0 || tp >= L) continue;                                   // billboard sits at the puff centre's depth
        const p2 = px * px + py * py + pz * pz, off = Math.sqrt(Math.max(0, p2 - tp * tp)) / p.r;
        if (off >= 1.08) continue;
        const a = density * c.vis * smoothstep(p.r * 0.55, p.r * 1.65, Math.sqrt(p2)) * smoothstep(0, soft, 1.08 - off);
        clear *= 1 - Math.min(1, a);
        if (clear < 0.01) return 1;
      }
    }
    return 1 - clear;
  }
  const occluded = (from, to, threshold = 0.5) => cloudIn(from, to) >= threshold;

  function casters() {
    // biggest first: the shadow map takes casters until it's full, and the scraps shouldn't crowd out the bodies
    return clusters.map(c => ({ x: c.x, z: c.z, y0: seaY + c.base, y1: seaY + c.base + c.h, rx: c.w * 0.42, rz: c.d * 0.42, op: c.vis ?? c.op }))
      .sort((a, b) => b.rx * b.rz - a.rx * a.rz);
  }

  function addCluster({ x, z, w = 700, h = 300, base: b = base, ang = streets, rag = 0, tower = false }) {
    if (puffs.length > MAXP - 64 || clusters.length >= MAXC) return -1;
    buildCluster(x, z, w, h, b, { ang, rag, tower });
    sunPrev.set(0, -1, 0);   // force a re-bake of transmittance
    return clusters.length - 1;
  }

  writePuffs();
  return {
    mesh, material, uniforms, clusters, puffs, update, inside, cloudIn, occluded, casters, addCluster,
    stats: () => ({ clusters: clusters.length, puffs: puffs.length, drawn }),
    dispose() { geo.dispose(); material.dispose(); tPuff.dispose(); tClus.dispose(); },
  };
}

function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }