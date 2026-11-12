// node test/run.mjs — needs `three` resolvable (npm i three, or NODE_PATH). Covers everything that runs without a GPU:
// chunk patches against the real three.js shader sources, cloud field structure, sorting, culling, wrap, inside(),
// sun transmittance, and the material hooks. Shader compilation is covered by test/browser.mjs.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { installHeightFog, heightFogRatio, createCumulus, createCloudShadow, tuneSky, createSkyOverlay, patchFoliage, patchGroundDetail, createGrass, groundTexture } from '../src/index.js';

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); } };
const assert = (c, m = 'assertion failed') => { if (!c) throw new Error(m); };
const near = (a, b, e) => Math.abs(a - b) <= e;
console.log(`three r${THREE.REVISION}`);

// ---- height fog ----
const ORIG = { v: THREE.ShaderChunk.fog_vertex, f: THREE.ShaderChunk.fog_fragment };
test('installHeightFog patches the fog chunks and is idempotent', () => {
  installHeightFog(THREE, { seaY: -80, scale: 1100 });
  const once = THREE.ShaderChunk.fog_fragment;
  installHeightFog(THREE, { seaY: -80, scale: 1100 });
  assert(THREE.ShaderChunk.fog_fragment === once, 'second install changed the chunk');
  assert(once.includes('lwRatio') && THREE.ShaderChunk.fog_vertex.includes('vFogWorldY'), 'not patched');
  assert(THREE.ShaderChunk.fog_pars_fragment.includes('varying float vFogWorldY'), 'pars');
  installHeightFog(THREE, { seaY: 0, scale: 500 });
  assert(THREE.ShaderChunk.fog_fragment.includes('500.000') && !THREE.ShaderChunk.fog_fragment.includes('1100.000'), 'reinstall should replace params');
  installHeightFog(THREE, { seaY: -80, scale: 1100 });
});
// the GLSL formula, mirrored in JS, against a numeric integral of exp(-h/H) along the ray
const ratioGLSL = (h0, h1, H) => { const e0 = Math.exp(-h0 / H), e1 = Math.exp(-h1 / H), dh = h1 - h0; return Math.abs(dh) > 1 ? H * (e0 - e1) / dh : e0; };
test('height-fog ratio = mean density along the ray (numeric check)', () => {
  for (const [h0, h1] of [[0, 0], [300, 0], [1220, 0], [1220, 1220], [50, 2500], [3000, 10]]) {
    let s = 0; const N = 4000; for (let i = 0; i < N; i++) s += Math.exp(-(h0 + (h1 - h0) * (i + .5) / N) / 1100); s /= N;
    assert(near(ratioGLSL(h0, h1, 1100), s, 2e-3), `${h0}->${h1}: ${ratioGLSL(h0, h1, 1100)} vs ${s}`);
  }
  assert(near(heightFogRatio(-80), 1, 1e-9) && near(heightFogRatio(1020), Math.exp(-1), 1e-9), 'heightFogRatio');
});
test('every stock material that uses fog still has the anchors the patch needs', () => {
  for (const k of ['physical', 'standard', 'basic', 'points', 'sprite', 'lambert', 'phong']) {
    const expand = s => s.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, n) => expand(THREE.ShaderChunk[n] ?? ''));
    const v = expand(THREE.ShaderLib[k].vertexShader), f = expand(THREE.ShaderLib[k].fragmentShader);
    assert(v.includes('vFogWorldY = dot( viewMatrix[ 1 ].xyz, mvPosition.xyz') && /vec4 mvPosition/.test(v), `${k}: fog vertex patch / mvPosition`);
    assert(v.indexOf('vec4 mvPosition') < v.indexOf('vFogWorldY = dot'), `${k}: mvPosition declared after use`);
    assert(f.includes('float lwD = vFogDepth * lwRatio;'), `${k}: fog fragment patch`);
  }
});

// ---- cumulus ----
const fakeNoise = new THREE.Texture();
const mk = (o = {}) => createCumulus(THREE, { noise: fakeNoise, tile: 24000, seaY: -80, base: 610, quality: 'med', seed: 11, ...o });
test('field is deterministic per seed and sized by quality tier', () => {
  const a = mk(), b = mk(), c = mk({ seed: 12 }), lo = mk({ quality: 'low' }), hi = mk({ quality: 'high' });
  assert(JSON.stringify(a.puffs.slice(0, 50)) === JSON.stringify(b.puffs.slice(0, 50)), 'same seed differs');
  assert(JSON.stringify(a.puffs.slice(0, 50)) !== JSON.stringify(c.puffs.slice(0, 50)), 'seeds identical');
  console.log(`       puffs low/med/high: ${lo.puffs.length} / ${a.puffs.length} / ${hi.puffs.length}, clusters ${lo.clusters.length}/${a.clusters.length}/${hi.clusters.length}`);
  assert(lo.puffs.length < a.puffs.length && a.puffs.length < hi.puffs.length, 'tiers not ordered');
  assert(hi.puffs.length < 8192, 'over the puff capacity');
});
test('no floating puffs: every puff above the base layer overlaps a lower puff of its cloud', () => {
  const f = mk({ quality: 'high' });
  let bad = 0;
  for (const c of f.clusters) for (let i = c.first; i < c.first + c.count; i++) {
    const p = f.puffs[i];
    if (p.oy - p.r <= 0.05 * c.w) continue;                            // touches the base level
    const ok = f.puffs.slice(c.first, c.first + c.count).some(q => q !== p && q.oy < p.oy && Math.hypot(q.ox - p.ox, q.oy - p.oy, q.oz - p.oz) < (q.r + p.r) * 0.98);
    if (!ok) bad++;
  }
  assert(bad === 0, `${bad} floating puffs`);
});
test('bases sit on the condensation level, tops within the cloud height', () => {
  const f = mk();
  for (const c of f.clusters) for (let i = c.first; i < c.first + c.count; i++) {
    const p = f.puffs[i];
    assert(p.oy >= 0, 'puff centre below the base');
    assert(p.oy + p.r <= c.h * 1.25 + 60, `puff top ${p.oy + p.r} over cloud height ${c.h}`);
  }
});
const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 40000);
test('update: far-to-near order, nothing behind the camera, wrap around the anchor', () => {
  const f = mk(); const anchor = new THREE.Vector3(5000, 300, -3000);
  cam.position.copy(anchor); cam.lookAt(anchor.x + 1000, anchor.y, anchor.z); cam.updateMatrixWorld();
  f.update(cam, anchor, { sunDir: new THREE.Vector3(0.3, 0.8, 0.5).normalize() });
  const n = f.stats().drawn; assert(n > 100, `drawn ${n}`);
  const idx = f.mesh.geometry.getAttribute('aIdx').array, F = new THREE.Vector3(); cam.getWorldDirection(F);
  let prev = Infinity;
  for (let k = 0; k < n; k++) {
    const p = f.puffs[idx[k]], c = f.clusters[p.cl];
    const d = (c.x + p.ox - cam.position.x) * F.x + (-80 + c.base + p.oy - cam.position.y) * F.y + (c.z + p.oz - cam.position.z) * F.z;
    assert(d <= prev + 0.3, `order broken at ${k}`); prev = d;
    assert(d >= -p.r * 1.3, 'behind camera drawn');
  }
  for (const c of f.clusters) assert(Math.abs(c.x - anchor.x) <= 12000 + 1 && Math.abs(c.z - anchor.z) <= 12000 + 1, 'cluster outside the tile');
});
test('host fade: op = 0 removes a cloud from the draw', () => {
  const f = mk(); const a = new THREE.Vector3(0, 300, 0);
  cam.position.copy(a); cam.lookAt(0, 300, -1); cam.updateMatrixWorld();
  f.update(cam, a, {}); const n0 = f.stats().drawn;
  f.clusters.forEach(c => c.op = 0); f.update(cam, a, {});
  assert(n0 > 0 && f.stats().drawn === 0, `${n0} -> ${f.stats().drawn}`);
});
test('inside(): deep in a puff ~1, in clear air 0', () => {
  const f = mk(); const a = new THREE.Vector3(0, 300, 0); cam.position.copy(a); cam.updateMatrixWorld(); f.update(cam, a, {});
  const c = f.clusters.find(cl => cl.vis > 0.99), p = f.puffs[c.first + 1];
  const inPuff = new THREE.Vector3(c.x + p.ox, -80 + c.base + p.oy, c.z + p.oz);
  assert(f.inside(inPuff) > 0.9, `inside ${f.inside(inPuff)}`);
  assert(f.inside(new THREE.Vector3(c.x, -80 + c.base + c.h + 900, c.z)) === 0, 'above the cloud');
});
test('sun transmittance: with the sun overhead, top puffs are brighter than base puffs', () => {
  const f = mk({ quality: 'high' }); const a = new THREE.Vector3(); cam.position.set(0, 0, 0); cam.updateMatrixWorld();
  f.update(cam, a, { sunDir: new THREE.Vector3(0, 1, 0) });
  let top = 0, nt = 0, bot = 0, nb = 0;
  for (const c of f.clusters) for (let i = c.first; i < c.first + c.count; i++) {
    const p = f.puffs[i];
    if (p.oy > c.h * 0.7) { top += p.occ; nt++; } else if (p.oy < c.h * 0.25) { bot += p.occ; nb++; }
  }
  assert(top / nt > bot / nb + 0.15, `top ${top / nt} vs base ${bot / nb}`);
});
test('casters() covers every cloud with its world position', () => {
  const f = mk(); const a = new THREE.Vector3(1e5, 0, -2e5); cam.position.copy(a); cam.updateMatrixWorld(); f.update(cam, a, {});
  const cs = f.casters(); assert(cs.length === f.clusters.length && cs.every(c => c.y1 > c.y0 && c.rx > 0), 'casters');
});

// ---- material hooks against the real three sources ----
test('cloud shadow hook: patches standard/physical, chains an existing hook, adds a cache key', () => {
  const cs = createCloudShadow(THREE, { renderer: null, noise: fakeNoise });
  const m = new THREE.MeshStandardMaterial(); let chained = false;
  m.onBeforeCompile = sh => { chained = true; sh.vertexShader = sh.vertexShader; };
  assert(cs.patch(m) && !cs.patch(m), 'patch twice');
  for (const [mat, lib] of [[m, 'standard'], [new THREE.MeshPhysicalMaterial(), 'physical']]) {
    if (mat !== m) cs.patch(mat);
    const sh = { uniforms: {}, vertexShader: THREE.ShaderLib[lib].vertexShader, fragmentShader: THREE.ShaderLib[lib].fragmentShader };   // raw, as three hands it over
    mat.onBeforeCompile(sh, null);
    assert(sh.vertexShader.includes('vLwCsW = transpose'), `${lib}: vertex`);
    assert(sh.fragmentShader.includes('directLight.color *= lwCloudShadow();'), `${lib}: light hook`);
    assert(sh.uniforms.tLwCloudShadow && sh.uniforms.uLwCSRect, `${lib}: uniforms`);
  }
  assert(chained, 'existing onBeforeCompile not called');
  assert(m.customProgramCacheKey().includes('lwcs'), 'cache key');
  assert(!cs.patch(new THREE.MeshBasicMaterial()), 'unlit materials are skipped');
  const w = new THREE.MeshPhysicalMaterial(); cs.patch(w, { indirect: 0.35 });
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  w.onBeforeCompile(sh, null);
  assert(sh.fragmentShader.includes('mix( 1.0, lwCloudShadow(), 0.350 )'), 'indirect option');
  assert(w.customProgramCacheKey() !== m.customProgramCacheKey(), 'indirect in the cache key');
});
test('tuneSky patches three\'s Sky; overlay builds', () => {
  const s = new Sky(); const t = tuneSky(s);
  assert(s.material.fragmentShader.includes('uLwSat') && t.sat.value === 1, 'tuneSky');
  const o = createSkyOverlay(THREE, { noise: fakeNoise });
  assert(o.material.fragmentShader.includes('wx_cirrus') && o.material.fragmentShader.includes('wx_nightSky') && o.mesh.renderOrder === -2, 'overlay');
});
test('foliage: shadowed-sun capture + translucency, chains with cloud shadows in either order', () => {
  for (const order of ['leafFirst', 'shadowFirst']) {
    const cs = createCloudShadow(THREE, { renderer: null, noise: fakeNoise });
    const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    let own = false; m.onBeforeCompile = () => { own = true; };
    if (order === 'leafFirst') { patchFoliage(THREE, m); cs.patch(m); } else { cs.patch(m); patchFoliage(THREE, m); }
    assert(!patchFoliage(THREE, m), 'idempotent');
    const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    m.onBeforeCompile(sh, null);
    const f = sh.fragmentShader;
    assert(own, `${order}: existing hook not called`);
    assert(f.includes('lwSunC = directLight.color') && f.includes('lwBack * 2.600'), `${order}: capture/translucency`);
    assert(f.includes('directLight.color *= lwCloudShadow();'), `${order}: cloud shadow lost`);
    // the capture must come after the cloud shadow and before RE_Direct in the directional block
    const blk = f.slice(f.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'));
    const iShadow = blk.indexOf('lwCloudShadow()'), iCap = blk.indexOf('lwSunC = directLight.color'), iRe = blk.indexOf('RE_Direct( directLight');
    assert(iShadow < iCap && iCap < iRe, `${order}: order shadow ${iShadow} cap ${iCap} RE ${iRe}`);
    assert(f.includes('float faceDirection = 1.0;'), `${order}: two-sided normal`);
    assert((f.match(/#include <lights_fragment_begin>/g) || []).length === 0, `${order}: light loop left unexpanded`);
  }
});
test('ground detail + grass hooks find their anchors in the real shaders', () => {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true });
  patchGroundDetail(THREE, m, { noise: fakeNoise });
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  m.onBeforeCompile(sh, null);
  assert(sh.vertexShader.includes('vLwGround = aGround;') && sh.vertexShader.includes('vLwGW = ( modelMatrix'), 'ground vertex');
  assert(sh.fragmentShader.includes('diffuseColor.rgb *= mix( vec3( 1.0 ), lwMul, lwNear );') && sh.fragmentShader.includes('normal = normalize( normal - mat3( viewMatrix ) * lwGrad'), 'ground fragment');
  const gt = groundTexture(THREE, new Float32Array(9), new Float32Array(9).fill(1), 2);
  const g = createGrass(THREE, { ground: gt, rect: { x0: 0, z0: 0, size: 10 }, n: 8 });
  const gs = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  g.material.onBeforeCompile(gs, null);
  assert(gs.vertexShader.includes('gl_InstanceID') && !gs.vertexShader.includes('#include <begin_vertex>') && !gs.vertexShader.includes('#include <beginnormal_vertex>'), 'grass vertex');
  assert(g.mesh.geometry.instanceCount === 64 && gt.image.width === 3, 'grass sizing');
  g.update({ position: new THREE.Vector3(7.4, 0, -3.1) }, { time: 1 });
  assert(g.uniforms.uLwCam.value.x === 5 && g.uniforms.uLwCam.value.y === -5, `snap ${g.uniforms.uLwCam.value.x},${g.uniforms.uLwCam.value.y}`);
});
test('patched materials with different original hooks get different program keys', () => {
  const cs = createCloudShadow(THREE, { renderer: { getRenderTarget: () => null, setRenderTarget() {}, getClearColor: c => c, getClearAlpha: () => 1, setClearColor() {}, clear() {}, render() {} }, noise: null });
  const mk = (src) => { const m = new THREE.MeshStandardMaterial(); m.onBeforeCompile = new Function('sh', src); return m; };
  const a = mk('sh.fragmentShader += "// a";'), b = mk('sh.fragmentShader += "// b";');
  for (const m of [a, b]) { cs.patch(m); patchFoliage(THREE, m); patchGroundDetail(THREE, m, { noise: null }); }
  assert(a.customProgramCacheKey() !== b.customProgramCacheKey(), 'keys collide');
  const c = mk('sh.fragmentShader += "// a";'); cs.patch(c); patchFoliage(THREE, c); patchGroundDetail(THREE, c, { noise: null });
  assert(a.customProgramCacheKey() === c.customProgramCacheKey(), 'identical hooks should share');
});
THREE.ShaderChunk.fog_vertex = ORIG.v; THREE.ShaderChunk.fog_fragment = ORIG.f;
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
