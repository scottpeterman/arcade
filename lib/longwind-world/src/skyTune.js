// Saturation and zenith depth for three's Sky (Preetham) addon.
//
// Preetham's sky ends in a gamma lift (pow(c, 1/(1.2 + 1.2 * sunfade))) that, after ACES at a low exposure, leaves the
// open sky pale grey-blue whatever the turbidity. Long Wind hit the same thing with its grade and pre-saturates the
// open-sky gradient stops (wx_skySat in src/world/sky.js, github.com/jbang2004/long-wind, MIT). Same idea here,
// applied to the Preetham output: open sky gets the saturation, the horizon band (which must keep matching the fog)
// stays as it is, and the zenith can be deepened.
//
//   const tune = tuneSky(sky)          — call before the sky first renders
//   tune.sat.value = 2.4               — 1 = unchanged; ~2–2.6 for clear tropical air at midday
//   tune.zen.value = 0.8               — zenith brightness multiplier (deep blue overhead)
//   tune.from.value / tune.to.value    — direction.y range over which the saturation fades in (default 0.02 → 0.35)
export function tuneSky(sky) {
  const m = sky.material, U = m.uniforms;
  // r161: `gl_FragColor = vec4( retColor, 1.0 );` (after the gamma lift) · r18x: `gl_FragColor = vec4( texColor, 1.0 );`
  const hit = m.fragmentShader.match(/gl_FragColor = vec4\( (\w+), 1\.0 \);/);
  if (!hit || !/vec3 direction\b/.test(m.fragmentShader)) throw new Error('tuneSky: Sky shader not recognised');
  const [anchor, c] = hit;
  U.uLwSat = { value: 1 }; U.uLwZen = { value: 1 }; U.uLwFrom = { value: 0.02 }; U.uLwTo = { value: 0.35 };
  m.fragmentShader = 'uniform float uLwSat, uLwZen, uLwFrom, uLwTo;\n' + m.fragmentShader.replace(anchor, `{
			float lwL = dot( ${c}, vec3( 0.2126, 0.7152, 0.0722 ) );
			${c} = max( vec3( lwL ) + ( ${c} - lwL ) * mix( 1.0, uLwSat, smoothstep( uLwFrom, uLwTo, direction.y ) ), 0.0 );
			${c} *= mix( 1.0, uLwZen, smoothstep( 0.2, 0.9, direction.y ) );
			}
			${anchor}`);
  m.needsUpdate = true;
  return { sat: U.uLwSat, zen: U.uLwZen, from: U.uLwFrom, to: U.uLwTo };
}
