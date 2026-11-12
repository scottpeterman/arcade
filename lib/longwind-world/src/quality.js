// Quality tier from the GPU, overridable with ?q=low|med|high. Integrated GPUs (Intel UHD/Iris, ARM Mali/PowerVR/Adreno,
// Apple's lowest tiers) start at 'low'/'med'; software renderers at 'low'.
export function pickQuality(renderer, { param = 'q', fallback = 'med' } = {}) {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '').get(param);
    if (q === 'low' || q === 'med' || q === 'high') return { tier: q, gpu: gpuName(renderer), forced: true };
  } catch { /* no location */ }
  const gpu = gpuName(renderer);
  let tier = fallback;
  if (/swiftshader|llvmpipe|software|basic render/i.test(gpu)) tier = 'low';
  else if (/mali|powervr|adreno|intel.*(hd|uhd) graphics [0-9]{3}\b|intel\(r\) hd/i.test(gpu)) tier = 'low';
  else if (/intel|iris|uhd/i.test(gpu)) tier = 'med';
  else if (/nvidia|geforce|rtx|radeon|amd|apple m[1-9]/i.test(gpu)) tier = 'high';
  return { tier, gpu, forced: false };
}
export function gpuName(renderer) {
  try {
    const gl = renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info');
    return String(e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return 'unknown'; }
}
