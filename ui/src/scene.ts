// Three.js renderer: ortho camera in stage pixel space, everything drawn by
// SDF shaders on quads. Grooves/rings/ticks are parametric fields; arcs are
// per-thread meshes with animatable progress uniforms.

import * as THREE from 'three'
import { arcWidth, arcWidthRaw, CENTER_X, CENTER_Y, STAGE_H, STAGE_W, NOTCH_DEG, CENTER, DAY_WIN, hourToAngle, labelStep, labelHours, type ResolvedArc } from './geometry'

// Our shaders write authored sRGB values straight to the framebuffer; keep
// THREE.Color from converting hex → linear or every mid-tone renders darker
// and more saturated than the mock colors we sampled.
THREE.ColorManagement.enabled = false
import type { SkinScene } from './skins'
import type { Thread } from './data'
import { labColor } from './labpal'

const MAX_FIELDS = 4
const MAX_SECTORS = 6
/** concurrency histogram buckets (10-min resolution on a 24h window) */
export const CONC_N = 144

// proper source-over compositing for building up unpremultiplied rgba in-shader
const OVER = /* glsl */ `
  vec4 over(vec4 dst, vec3 rgb, float a) {
    float outA = a + dst.a * (1.0 - a);
    if (outA < 0.0001) return vec4(0.0);
    return vec4((rgb * a + dst.rgb * dst.a * (1.0 - a)) / outA, outA);
  }
`

function c3(hex: string): THREE.Vector3 {
  const c = new THREE.Color(hex)
  return new THREE.Vector3(c.r, c.g, c.b)
}

function haloVec(skin: SkinScene): THREE.Vector4 {
  const c = new THREE.Color(skin.arcHalo)
  return new THREE.Vector4(c.r, c.g, c.b, skin.arcHaloAlpha)
}

// ---------------------------------------------------------------- disc shader

const DISC_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vPos; // px from disc center, y down
  uniform float uDiscR, uDiscAlpha, uTilt, uNotch, uDiscHole;
  uniform vec3 uDiscColor;
  uniform vec4 uFields[${MAX_FIELDS}];      // r0, r1, period, duty
  uniform vec4 uFieldColors[${MAX_FIELDS}]; // rgb, alpha
  uniform vec4 uFieldBands[${MAX_FIELDS}];  // bandPeriod, bandWidth, 0, 0
  uniform float uFieldNotch[${MAX_FIELDS}]; // 1 clears the field inside the day notch
  uniform int uFieldCount;
  uniform vec4 uSpokes[14];                 // angleRad, rIn, rOut, alpha
  uniform int uSpokeCount;
  uniform vec3 uSpokeCol;
  uniform vec4 uHands;                      // rIn, rOut, alpha, stroke width px
  uniform vec3 uHandsCol;
  uniform vec4 uSectors[${MAX_SECTORS}];    // a0, a1, wash, 0
  uniform int uSectorCount;
  uniform vec2 uSectorZone;                 // radial band the washes apply to
  uniform vec4 uTicks;    // rInner, minorLen, majorLen, minorPerHour
  uniform vec4 uTickCol;  // rgb, alpha
  uniform vec2 uTickMisc; // jitter, glow
  uniform float uConc[${CONC_N}]; // concurrent agents per day-window bucket
  uniform float uConcMax;  // 0 = no data (mock): hash-jitter whiskers
  uniform vec4 uSeismo;   // bar spacing (px), base radius, min len, max len
  uniform vec3 uDayWin;   // window startH, endH, label step (hours)
  uniform vec4 uBezel;    // r0, r1, 0, hasBezel
  uniform vec3 uBezelIn, uBezelOut;
  uniform vec4 uBezel2;   // second bezel layer (vinyl bright rim)
  uniform vec3 uBezel2In, uBezel2Out;
  uniform vec4 uOuterRing; // r, width, alpha, mode: 0 off, 1 full, 2 notch-clipped
  uniform vec3 uOuterCol;
  uniform vec4 uLabel;    // r, has, 0, 0
  uniform vec3 uLabelCol;
  uniform vec4 uGlass;    // r0, r1, frostAlpha, has
  uniform vec2 uGlassL;   // light angle (rad), rim strength
  uniform float uGlassMode; // 0 = painted matte, 1 = frost (refracting), 2 = liquid lens
  uniform vec4 uVinyl;    // grooveR0, grooveR1, strength, has
  uniform vec4 uVinylB;   // groove pitch (px), flat gloss, light angle (rad), stage px per screen px
  uniform vec4 uVinylC;   // groove relief, track bands, wear, highlight focus
  uniform vec3 uVinylCol; // specular tint

  // procedural copy of the glass skin's CSS backdrop (stage-relative px from
  // disc center) so the glass can sample/refract what's "behind" it
  vec3 glassBg(vec2 p) {
    vec2 s = p + vec2(927.0, 607.0);
    vec2 uv = s / vec2(1842.0, 1197.0);
    float t = clamp(dot(uv, vec2(0.259, 0.966)) * 0.9, 0.0, 1.2);
    vec3 c = mix(vec3(0.788, 0.8, 0.91), vec3(0.682, 0.71, 0.851), smoothstep(0.0, 0.55, t));
    c = mix(c, vec3(0.561, 0.584, 0.769), smoothstep(0.55, 1.1, t));
    // dark vignette lower right
    float dv = 1.0 - smoothstep(0.0, 0.75, length((s - vec2(1621.0, 1101.0)) / vec2(1000.0, 760.0)));
    c = mix(c, vec3(0.345, 0.36, 0.541), dv * 0.4);
    // peach bokeh blobs
    vec3 peach = vec3(0.933, 0.745, 0.686);
    float b1 = 1.0 - smoothstep(0.0, 0.7, length((s - vec2(74.0, 215.0)) / vec2(420.0, 380.0)));
    float b2 = 1.0 - smoothstep(0.0, 0.7, length((s - vec2(1824.0, 359.0)) / vec2(360.0, 340.0)));
    float b3 = 1.0 - smoothstep(0.0, 0.7, length((s - vec2(147.0, 1149.0)) / vec2(500.0, 300.0)));
    float b4 = 1.0 - smoothstep(0.0, 0.7, length((s - vec2(1695.0, 1173.0)) / vec2(460.0, 300.0)));
    c = mix(c, peach, clamp(b1 * 0.65 + b2 * 0.6 + b3 * 0.6 + b4 * 0.55, 0.0, 0.8));
    // white glow behind the dial
    float wg = 1.0 - smoothstep(0.0, 0.7, length((s - vec2(921.0, 383.0)) / vec2(700.0, 520.0)));
    c = mix(c, vec3(1.0), wg * 0.28);
    return c;
  }

  float hash1(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
  ${OVER}

  void main() {
    float r = length(vPos);
    float a = atan(vPos.x, -vPos.y);           // cw from 12 o'clock
    if (a < 0.0) a += 6.28318530718;
    float aT = a - uTilt;                       // tilted field space
    if (aT < 0.0) aT += 6.28318530718;
    float deg = a * 57.29577951;

    vec4 col = vec4(0.0);

    // base disc
    float discM = 1.0 - smoothstep(uDiscR - 1.0, uDiscR + 1.0, r);
    col = over(col, uDiscColor, discM * uDiscAlpha);

    // Vinyl's light field. A record reads the way it does because light
    // scattering off concentric grooves is smeared tangentially, so the
    // highlight is a pair of opposed lobes struck through the center rather
    // than a round hotspot. The narrow term is those lobes; the wide term
    // stops the unlit quadrants going dead flat. Computed up here because it
    // drives the surface, the deadwax and the edge, which are painted at
    // three different points below.
    float vSpec = 0.0;
    if (uVinyl.w > 0.5) {
      float ca = abs(cos(a - uVinylB.z));
      vSpec = pow(ca, uVinylC.w) * 0.92 + pow(ca, 2.0) * 0.26;
    }

    // frosted-glass annulus, lit from one side with bright rims
    if (uGlass.w > 0.5) {
      float band = smoothstep(uGlass.x - 2.0, uGlass.x + 2.0, r) * (1.0 - smoothstep(uGlass.y - 2.0, uGlass.y + 2.0, r));
      float light = 0.62 + 0.38 * cos(a - uGlassL.x);
      float shade = 1.0 - light;
      if (uGlassMode > 0.5) {
        // refracting glass: sample the backdrop, bending it near the rims
        float dO = uGlass.y - r;
        float dI = r - uGlass.x;
        float dEdge = min(dO, dI);
        float edgeW = uGlassMode > 1.5 ? 46.0 : 30.0;
        float curve = pow(1.0 - clamp(dEdge / edgeW, 0.0, 1.0), 2.0);
        float dir = (dO < dI) ? 1.0 : -1.0;
        vec2 n = normalize(vPos + vec2(0.0001));
        float refr = (uGlassMode > 1.5 ? 34.0 : 10.0) * curve * dir;
        vec3 bgc;
        if (uGlassMode > 1.5) {
          // chromatic fringe at the edges (liquid lens)
          float ca = 4.0 * curve;
          bgc = vec3(glassBg(vPos + n * (refr + ca)).r, glassBg(vPos + n * refr).g, glassBg(vPos + n * (refr - ca)).b);
        } else {
          bgc = glassBg(vPos + n * refr);
        }
        float frost = uGlassMode > 1.5 ? 0.16 : 0.48;
        vec3 gcol = mix(bgc, vec3(1.0), frost * light + 0.08);
        gcol = mix(gcol, vec3(0.42, 0.45, 0.62), shade * 0.1);
        col = over(col, gcol, band * 0.96);
      } else {
        col = over(col, vec3(1.0), band * uGlass.z * light);
      }
      float inner = 1.0 - smoothstep(uGlass.x - 2.0, uGlass.x + 2.0, r);
      col = over(col, vec3(1.0), inner * uGlass.z * 0.32 * light);
      // stacked glass layers: bright edge rings at both rims + a mid ledge
      float rimO = exp(-abs(r - uGlass.y) / 2.6);
      float rimI = exp(-abs(r - uGlass.x) / 2.6);
      float ledge = exp(-abs(r - (uGlass.y - 26.0)) / 2.0);
      col = over(col, vec3(1.0), clamp((rimO + rimI * 0.6 + ledge * 0.4) * light * uGlassL.y, 0.0, 1.0));
      // directional depth shadow hugging the inside of the outer rim
      float sh = exp(-abs(r - (uGlass.y - 13.0)) / 8.0) * band;
      col = over(col, vec3(0.4, 0.43, 0.6), sh * (0.08 + 0.16 * shade));
      // contact shadow at the inner rim's base
      float sh2 = exp(-abs(r - (uGlass.x + 9.0)) / 5.0) * band;
      col = over(col, vec3(0.4, 0.43, 0.6), sh2 * 0.07);
    }

    // sector sheen: white-wash (or shadow) wedges, applied inside uSectorZone
    float wash = 0.0;
    for (int i = 0; i < ${MAX_SECTORS}; i++) {
      if (i >= uSectorCount) break;
      if (deg >= uSectors[i].x && deg <= uSectors[i].y) wash = uSectors[i].z;
    }

    // angular distance from the notch centerline at 12 o'clock
    float aDist = min(a, 6.28318530718 - a);
    float notchMask = smoothstep(uNotch - 0.002, uNotch + 0.006, aDist);

    // ring fields (track bands / grooves / orbit rings) — cleared in the notch
    for (int i = 0; i < ${MAX_FIELDS}; i++) {
      if (i >= uFieldCount) break;
      vec4 f = uFields[i];
      if (r < f.x || r > f.y) continue;
      // negative period = "groove" mode: discrete lines centered mid-period
      // (per-agent grooves land exactly on lane radii, no edge phantoms)
      float per = abs(f.z);
      float ph = fract((r - f.x) / per);
      float half_ = f.w * 0.5;
      float d = f.z < 0.0
        ? half_ - abs(ph - 0.5)                  // inside a centered line
        : abs(ph - 0.5) - (0.5 - half_);         // distance into line band
      float aa = max(uFieldBands[i].z, 1.0) / per;
      float line = smoothstep(-aa, aa, d);
      // pigment grain: mottle the band so softness reads as paint, not blur
      if (uFieldBands[i].w > 0.0) {
        vec2 cell = floor(vPos * 0.5);
        float n = hash1(cell.x * 13.17 + cell.y * 7.31);
        float n2 = hash1(cell.x * 3.7 - cell.y * 11.3);
        line *= 1.0 - uFieldBands[i].w * (0.35 * n + 0.35 * n2);
      }
      // optional band grouping: stripes only inside repeating bands
      if (uFieldBands[i].x > 0.0) {
        float bp = fract((r - f.x) / uFieldBands[i].x) * uFieldBands[i].x;
        line *= 1.0 - smoothstep(uFieldBands[i].y - 1.5, uFieldBands[i].y + 0.5, bp);
      }
      // Soften the annulus only by its authored field softness. A fixed 6px
      // fade made Paper's fitted background appear to stop several pixels
      // before the hour dividers, especially on crowded, compressed days.
      // Discrete groove lines still have no radial end fade.
      float endSoft = max(uFieldBands[i].z, 1.0);
      float ends = f.z < 0.0 ? 1.0 : smoothstep(f.x, f.x + endSoft, r) * (1.0 - smoothstep(f.y - endSoft, f.y, r));
      vec4 fc = uFieldColors[i];
      float fieldNotch = uFieldNotch[i] > 0.5 ? notchMask : 1.0;
      float m = clamp(line * fc.a * ends * fieldNotch, 0.0, 1.0);
      col = over(col, fc.rgb, m);
    }

    // apply the sector sheen over base + fields
    if (wash != 0.0) {
      float zone = smoothstep(uSectorZone.x, uSectorZone.x + 5.0, r)
                 * (1.0 - smoothstep(uSectorZone.y - 5.0, uSectorZone.y, r));
      if (wash > 0.0) col = over(col, vec3(1.0), wash * zone);
      else col = over(col, vec3(0.0), -wash * zone);
    }

    // Vinyl surface. Painted after the ring fields so the lane grooves are
    // lit by the same sheen as the rest of the record instead of sitting on
    // top of it as flat ink.
    if (uVinyl.w > 0.5 && r < uDiscR) {
      float band = smoothstep(uVinyl.x - 3.0, uVinyl.x + 3.0, r)
                 * (1.0 - smoothstep(uVinyl.y - 3.0, uVinyl.y + 3.0, r));

      // microgrooves. The pitch drifts a little across the radius so the
      // surface reads as pressed rather than printed from a ruler.
      float pitch = uVinylB.x * (1.0 + 0.11 * sin(r * 0.0115));
      float relief = cos(fract(r / pitch) * 6.28318530718);
      // Fade the relief out as its pitch closes on what one screen pixel can
      // resolve. Without this the ring turns into moire the moment the stage
      // is scaled down to fit a narrow window.
      relief *= 1.0 - smoothstep(pitch * 0.30, pitch * 0.72, uVinylB.w);

      // pressing noise — only ever visible inside the lit sweeps
      float dust = hash1(floor(r * 2.1) * 17.13 + floor(a * 340.0) * 5.71);

      // The sheen is strongest across the middle of the playing surface and
      // falls off toward the label and the rim, the way it does on a record
      // photographed flat.
      float prof = smoothstep(uVinyl.x - 60.0, uVinyl.x + 90.0, r)
                 * (1.0 - 0.4 * smoothstep(uVinyl.y - 90.0, uVinyl.y + 10.0, r));

      // Track gaps: the bands between songs are pressed wider than the groove
      // pitch, so a record carries a handful of brighter rings at irregular
      // radii. Two sines that never line up stand in for that spacing.
      float tg = sin(r * 0.0431) * 0.6 + sin(r * 0.0177 + 2.1) * 0.4;
      float track = smoothstep(0.74, 0.98, tg) * band;

      float lit = vSpec * prof * (uVinylB.y + band * relief * 0.22 * uVinylC.x + track * 0.3 * uVinylC.y)
                * (0.92 + 0.16 * dust);
      col = over(col, uVinylCol, clamp(lit, 0.0, 1.0) * uVinyl.z);
      // Valleys cut below the surface so the relief has depth rather than
      // being alternating light and dark rings. Tied entirely to the light:
      // where the sheen does not reach, a record shows no grooves at all, just
      // smooth black.
      col = over(col, vec3(0.0), clamp(-relief, 0.0, 1.0) * band * vSpec * prof * 0.3);

      // A handled copy picks up sparse dust and fine radial scuffs. They stay
      // subordinate to the light field: on black PVC these marks flare only
      // when they catch the same directional light as the grooves.
      float dustCell = hash1(floor(r * 0.43) * 29.17 + floor(a * 190.0) * 13.71);
      float dustSpot = step(0.9985, dustCell) * (1.0 - smoothstep(0.0, 1.8, abs(fract(r * 0.43) - 0.5) * 3.6));
      float scratchSeed = hash1(floor(a * 92.0) * 41.3);
      float scratch = step(0.965, scratchSeed)
                    * (1.0 - smoothstep(0.18, 0.65, abs(fract(a * 92.0) - 0.5)))
                    * smoothstep(205.0, 245.0, r) * (1.0 - smoothstep(430.0, 465.0, r));
      float wear = (dustSpot * 0.45 + scratch * 0.08) * uVinylC.z * band * clamp(vSpec, 0.0, 1.0);
      col = over(col, uVinylCol, wear);

      // Deadwax: the mirror-smooth ring between the label and the first groove
      // is the brightest surface on a record, because nothing there breaks the
      // reflection up.
      float dead = smoothstep(uLabel.x - 2.0, uLabel.x + 12.0, r)
                 * (1.0 - smoothstep(uVinyl.x - 14.0, uVinyl.x + 2.0, r));
      col = over(col, uVinylCol, dead * vSpec * 0.55 * uVinyl.z);
      // and the label sits slightly proud of it, so its edge casts a step
      col = over(col, vec3(0.0), exp(-abs(r - uLabel.x) / 3.0) * 0.55);
    }

    // radial spokes + start/end hands
    for (int i = 0; i < 14; i++) {
      if (i >= uSpokeCount) break;
      vec4 s = uSpokes[i];
      if (r < s.y || r > s.z) continue;
      float across = abs(aT - s.x) * r;
      // Same one-pixel antialias profile as Paper's 1px Start/End hands.
      float m = 1.0 - smoothstep(0.0, 1.0, across);
      col = over(col, uSpokeCol, m * s.w);
    }
    if (uHands.w > 0.0 && r > uHands.x && r < uHands.y) {
      float d1 = abs(a - uNotch) * r;
      float d2 = abs(a - (6.28318530718 - uNotch)) * r;
      float halfW = uHands.w * 0.5;
      float m = 1.0 - smoothstep(max(0.0, halfW - 0.5), halfW + 0.5, min(d1, d2));
      col = over(col, uHandsCol, m * uHands.z);
    }
    // bezel
    if (uBezel.w > 0.5 && r > uBezel.x && r < uBezel.y) {
      float t = (r - uBezel.x) / (uBezel.y - uBezel.x);
      vec3 bc = mix(uBezelIn, uBezelOut, smoothstep(0.0, 1.0, t));
      float m = smoothstep(uBezel.x, uBezel.x + 1.5, r) * (1.0 - smoothstep(uBezel.y - 1.5, uBezel.y, r));
      col = over(col, bc, m);
    }
    if (uBezel2.w > 0.5 && r > uBezel2.x && r < uBezel2.y) {
      float t = (r - uBezel2.x) / (uBezel2.y - uBezel2.x);
      vec3 bc = mix(uBezel2In, uBezel2Out, smoothstep(0.0, 1.0, t));
      float m = smoothstep(uBezel2.x, uBezel2.x + 1.0, r) * (1.0 - smoothstep(uBezel2.y - 1.2, uBezel2.y, r));
      col = over(col, bc, m);
    }

    // A record's edge is not a silver band all the way round — it is the same
    // black plastic with a rounded lip, so it only lights up where the sheen
    // reaches it and is nearly invisible everywhere else.
    if (uVinyl.w > 0.5 && uBezel.w > 0.5 && r > uBezel.x && r < uBezel2.y) {
      float lip = smoothstep(uBezel.x, uBezel.x + 6.0, r);
      col = over(col, vec3(0.03, 0.029, 0.027), (1.0 - clamp(vSpec, 0.0, 1.0)) * lip * 0.8);
    }

    // outer ring
    if (uOuterRing.w > 0.5) {
      float d = abs(r - uOuterRing.x) - uOuterRing.y * 0.5;
      float m = 1.0 - smoothstep(-1.0, 1.0, d);
      if (uOuterRing.w > 1.5) m *= notchMask;
      col = over(col, uOuterCol, m * uOuterRing.z);
    }

    // ticks — hand-ruled whiskers straddling a base circle (uTicks.x); minors
    // jitter in length AND radial placement, 2-hour majors are long strokes
    // centered on the base reaching up toward the hour labels. Notch kept clear.
    // Real days swap the minors for a seismograph: one bar every uSeismo.x px
    // of arc, rising OUTWARD from a baseline at uSeismo.y, length mapping the
    // concurrent-agent count into uSeismo.z..uSeismo.w.
    float rBase = uTicks.x;
    float tickLo = rBase - uTicks.z - 44.0;
    float tickHi = rBase + uTicks.z + 44.0;
    if (uConcMax > 0.5) {
      tickLo = min(tickLo, uSeismo.y - 6.0);
      tickHi = max(tickHi, uSeismo.y + uSeismo.w + 6.0);
    }
    if (r > tickLo && r < tickHi && aDist > uNotch * 0.7) {
      float span = max(uDayWin.y - uDayWin.x, 0.1);
      float hFrac = uDayWin.x + aT / 6.28318530718 * span; // hours around dial
      float stp = max(uDayWin.z, 0.5);
      if (uConcMax > 0.5) {
        // seismo bars on the pixel lattice — no major strokes on real days,
        // the hour labels alone mark time
        float phi = max(uSeismo.x, 2.0) / max(uSeismo.y, 1.0);
        float sIdx = floor(aT / phi + 0.5);
        float sA = sIdx * phi;
        // linear interp between adjacent buckets — continuous ramps, no stairs
        // hour fraction accounts for the notch reserve at the seam
        float bf = max(clamp((sA - uNotch) / (6.28318530718 - 2.0 * uNotch), 0.0, 0.9999) * ${CONC_N}.0 - 0.5, 0.0);
        int b0 = int(bf);
        int b1 = int(min(bf + 1.0, ${CONC_N}.0 - 1.0));
        float c0 = 0.0;
        float c1 = 0.0;
        for (int i = 0; i < ${CONC_N}; i++) {
          if (i == b0) c0 = uConc[i];
          if (i == b1) c1 = uConc[i];
        }
        float conc = mix(c0, c1, fract(bf));
        float lenS = mix(uSeismo.z, uSeismo.w, conc / uConcMax) * (0.9 + 0.2 * hash1(sIdx * 7.13));
        float acS = abs(aT - sA) * r;
        float drS = abs(r - (uSeismo.y + lenS * 0.5)) - lenS * 0.5;
        float mMin = (1.0 - smoothstep(0.3, 1.2, acS)) * (1.0 - smoothstep(-0.8, 0.8, drS));
        if (lenS < 0.4) mMin = 0.0;
        col = over(col, uTickCol.rgb, mMin * 0.62 * uTickCol.a);
        if (uTickMisc.y > 0.0) {
          float g = exp(-acS / 4.0) * exp(-abs(drS) / 4.0);
          col.rgb += uTickCol.rgb * g * uTickMisc.y * 0.35;
          col.a = max(col.a, g * uTickMisc.y * 0.35);
        }
      } else {
        float per = uTicks.w;
        float idx = floor(hFrac * per + 0.5);
        float tickH = idx / per;
        float tickA = (tickH - uDayWin.x) / span * 6.28318530718;
        float m2 = mod(tickH, stp);
        float m1 = mod(tickH, 1.0);
        float major2 = step(min(m2, stp - m2), 0.002);
        float hourly = step(min(m1, 1.0 - m1), 0.002) * step(1.5, stp);
        float h1 = hash1(idx * 7.13);
        float h2 = hash1(idx * 3.77 + 11.0);
        float len, cen;
        if (major2 > 0.5) {
          // majors grow inward from the whisker baseline — never past it into
          // the hour-label ring (the mock keeps text clear of every stroke)
          len = uTicks.z;
          cen = rBase + 8.0 - len * 0.5;
        } else {
          // outer ends hug the baseline with a small wobble; ticks grow INWARD,
          // long ones are rare (skewed hash) — the hand-ruled look of the mock
          float outerEnd = rBase + 4.0 + (h2 - 0.5) * 8.0;
          len = uTicks.y * (0.7 + (hourly > 0.5 ? 0.7 : 0.0) + uTickMisc.x * 2.6 * pow(h1, 3.5));
          cen = outerEnd - len * 0.5;
        }
        float across = abs(aT - tickA) * r;
        float dr = abs(r - cen) - len * 0.5;
        float w = major2 > 0.5 ? 1.6 : 0.9;
        float m = (1.0 - smoothstep(w - 0.6, w + 0.6, across)) * (1.0 - smoothstep(-0.8, 0.8, dr));
        col = over(col, uTickCol.rgb, m * uTickCol.a * (major2 > 0.5 ? 1.0 : 0.62));
        if (uTickMisc.y > 0.0) {
          float g = exp(-across / 4.0) * exp(-abs(dr) / 4.0);
          col.rgb += uTickCol.rgb * g * uTickMisc.y * 0.35;
          col.a = max(col.a, g * uTickMisc.y * 0.35);
        }
      }
    }

    // center label disc (vinyl record label)
    if (uLabel.y > 0.5) {
      float m = 1.0 - smoothstep(uLabel.x - 1.0, uLabel.x + 1.0, r);
      col = over(col, uLabelCol, m);
    }

    // punched spindle hole — the page shows through like a real record.
    // The center layer punches its own alpha at the same radius.
    if (uDiscHole > 0.0) {
      col.a *= smoothstep(uDiscHole - 0.8, uDiscHole + 0.8, r);
    }

    gl_FragColor = col;
  }
`

// Geometry +y renders downward under our ortho camera, so raw position.xy is
// already screen-space (y down) — matching the TS polar() convention exactly.
const QUAD_VERT = /* glsl */ `
  varying vec2 vPos;
  uniform vec2 uSize;
  void main() {
    vPos = position.xy * uSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy * uSize, 0.0, 1.0);
  }
`

// ----------------------------------------------------------------- arc shader

const ARC_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vPos;
  uniform float uR, uA0, uA1, uW, uProgress, uGlow, uGloss, uGlassLine, uDim, uHi, uLinearFade;
  // connector: the faint thin bridge across an idle gap between two stretches
  // of one session — reads as continuity, never as work
  uniform float uConn;
  uniform vec3 uColor;
  ${OVER}
  uniform vec4 uDots;   // dotted body: f0, f1, spacingPx, dotR (fractions of arc)
  uniform vec4 uHatch[4];  // per blocked span: f0, f1, active, 0
  uniform vec3 uHatchCol;
  uniform float uHatchStyle; // see HATCH_STYLES in overlay.ts
  uniform float uHatchVisible;
  float hhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  uniform vec4 uHalo;   // rgb, alpha
  uniform vec4 uTail;   // f0, has, 0, 0 — trailing portion recolored
  uniform vec3 uTailCol;
  // x: subagent rail alpha. y: the frame's convention — the arc bloom is
  // white rather than tinted (hatch styling moved to uHatchStyle)
  uniform vec2 uSpecial;
  // per-end cap style: 1 squares the [start, end] face instead of the pill
  // cap — stretch ends that meet a connector read ] [ across the gap
  uniform vec2 uSqCaps;

  void main() {
    float r = length(vPos);
    float a = atan(vPos.x, -vPos.y);
    if (a < 0.0) a += 6.28318530718;
    float span = (uA1 - uA0) * uProgress;
    if (span <= 0.0) discard;
    float rel = a - uA0;
    if (rel < -3.14159265) rel += 6.28318530718;
    if (rel > 3.14159265 * 2.0 - (6.28318530718 - span) * 0.5) rel -= 6.28318530718;
    float relC = clamp(rel, 0.0, span);
    vec2 P = vec2(sin(uA0 + relC), -cos(uA0 + relC)) * uR;
    float d = distance(vPos, P);
    float frac = span > 0.0 ? relC / span : 0.0;

    float body = 1.0 - smoothstep(uW - 0.8, uW + 0.8, d);

    // dotted body replaces the solid arc (tail/base color applies)
    if (uDots.z > 0.0 && frac > uDots.x && frac < uDots.y) {
      float u = relC * uR;
      float nearest = floor(u / uDots.z + 0.5) * uDots.z;
      vec2 Pd = vec2(sin(uA0 + nearest / uR), -cos(uA0 + nearest / uR)) * uR;
      float dd = distance(vPos, Pd);
      float bead = 1.0 - smoothstep(uDots.w - 0.7, uDots.w + 0.7, dd);
      // the master frame draws subagents as a dim continuous rail carrying
      // bright beads, not as a bare row of dots on empty track
      body = max(body * uSpecial.x, bead);
    }

    // squared caps: clip the protruding pill at the end angle, leaving an
    // anti-aliased flat face exactly on a0/a1
    if (uSqCaps.x > 0.5) body *= smoothstep(-0.8, 0.8, rel * uR);
    if (uSqCaps.y > 0.5) body *= smoothstep(-0.8, 0.8, (span - rel) * uR);

    vec3 color = uColor;
    if (uTail.y > 0.5 && frac > uTail.x) color = uTailCol;
    // blocked hatching overlays the body — a thread can stall more than once
    float inHatch = 0.0;
    for (int i = 0; i < 4; i++) {
      if (uHatch[i].z > 0.5 && frac > uHatch[i].x && frac < uHatch[i].y) inHatch = 1.0;
    }
    if (inHatch > 0.5 && uHatchVisible > 0.5) {
      float u = relC * uR;   // arc-length px along the thread
      float v = r - uR;      // radial px off the groove centerline
      int hst = int(uHatchStyle + 0.5);
      float stripe = 0.0;    // where the delay color paints
      float keep = 1.0;      // body multiplier — 0 reads through to the platter
      if (hst == 0) {
        // Unwrap the curved stroke into its local frame: u travels forward
        // along the arc and v travels radially outward. Constant u-v lines are
        // the same forward slash at every angle, so the hatch rotates with the
        // groove instead of changing orientation around the screen.
        // Distance to the nearest repeated line, instead of a one-sided
        // threshold on fract(). The old wrap jumped directly from 1 to 0 at
        // one edge of every diagonal, leaving that side visibly stair-stepped.
        float phase = abs(fract((u - v) / 4.95 + 0.5) - 0.5);
        float halfW = 0.6 / 4.95;
        float aa = 0.45 / 4.95;
        stripe = 1.0 - smoothstep(halfW - aa, halfW + aa, phase);
        keep = stripe;
      } else if (hst == 1) {
        // candy: wide stripes along the arc on a cream backing
        stripe = step(0.5, fract((u + v) / 5.0));
      } else if (hst == 2) {
        // beads: the body dissolves into a row of dots
        float nearest = floor(u / 7.0 + 0.5) * 7.0;
        vec2 Pb = vec2(sin(uA0 + nearest / uR), -cos(uA0 + nearest / uR)) * uR;
        keep = 1.0 - smoothstep(2.3, 3.0, distance(vPos, Pb));
        stripe = keep;
      } else if (hst == 3) {
        // dashes: perforation chunks with clear gaps
        keep = step(0.45, fract(u / 10.0));
        stripe = keep;
      } else if (hst == 4) {
        // crosshatch: both 45-degree diagonals, gaps clear
        float lw = 1.1 / 5.5;
        float t1 = fract((vPos.x + vPos.y) / 5.5);
        float t2 = fract((vPos.x - vPos.y) / 5.5);
        stripe = max(1.0 - smoothstep(lw - 0.1, lw + 0.1, t1),
                     1.0 - smoothstep(lw - 0.1, lw + 0.1, t2));
        keep = stripe;
      } else if (hst == 5) {
        // chevron: stripes fold at the centerline so they read as arrows
        float t = fract((u + abs(v) * 1.6) / 6.5);
        float lw = 1.4 / 6.5;
        stripe = 1.0 - smoothstep(lw - 0.12, lw + 0.12, t);
        keep = stripe;
      } else if (hst == 6) {
        // solid: the whole span floods coral, slightly darker at the rim
        stripe = 1.0 - 0.18 * smoothstep(uW - 2.0, uW, abs(v));
      } else if (hst == 7) {
        // rails: hollow body, only the two edges survive in coral
        keep = smoothstep(uW - 2.6, uW - 1.2, abs(v));
        stripe = keep;
      } else if (hst == 8) {
        // break: the arc snaps to a coral hairline, like a cut in the groove
        keep = 1.0 - smoothstep(0.9, 1.6, abs(v));
        stripe = keep;
      } else if (hst == 9) {
        // crossties: coral ticks across the arc, base color between them
        float t = fract(u / 7.0);
        float lw = 1.5 / 7.0;
        stripe = 1.0 - smoothstep(lw - 0.1, lw + 0.1, t);
      } else if (hst == 10) {
        // sparkle: coral static — a granular stipple over the base color,
        // denser than beads, softer than solid
        float n = hhash(vec2(floor(u / 3.0), floor(v / 3.0)));
        stripe = step(0.62, n);
        color = mix(mix(color, uHatchCol, 0.35), mix(uHatchCol, vec3(1.0), 0.3), stripe);
        stripe = -1.0;
      } else if (hst == 11) {
        // ember: a warm coral-to-gold ripple along the span — reads hot
        // without moving
        float f = 0.5 + 0.5 * sin(u * 0.55) * sin(u * 0.23 + 1.7);
        color = mix(uHatchCol, vec3(1.0, 0.78, 0.42), 0.35 * f) * (0.9 + 0.25 * f);
        stripe = -1.0;
      } else {
        // coil: the thread winds into a tight coral spring — energy stored,
        // going nowhere
        float cy = sin(u / 2.6) * (uW - 1.8);
        keep = 1.0 - smoothstep(1.0, 1.9, abs(v - cy));
        stripe = keep;
      }
      // candy/barber back their gaps with cream; styles that set stripe to -1
      // have already painted; the rest tint toward the delay color (or clear
      // to the platter where keep dropped the body)
      if (hst == 1) color = mix(vec3(0.933, 0.867, 0.843), uHatchCol, stripe);
      else if (stripe >= 0.0) color = mix(color, uHatchCol, stripe);
      body *= keep;
    }

    // glossy 3D-tube shading: darker toward edges, highlight along the top
    if (uGloss > 0.0 && body > 0.0) {
      float t = clamp((r - uR) / uW, -1.5, 1.5);
      color *= 1.0 - 0.28 * uGloss * clamp(abs(t), 0.0, 1.0);
      color += vec3(1.0) * uGloss * 0.45 * exp(-pow((t + 0.5) * 2.6, 2.0));
    }

    // halo separates the arc from disc artwork underneath
    float halo = (1.0 - smoothstep(uW * 2.4 - 1.2, uW * 2.4 + 1.2, d)) * uHalo.w;
    float alpha = max(body, halo);
    color = mix(uHalo.rgb, color, clamp(body / max(alpha, 0.0001), 0.0, 1.0));
    if (uGlow > 0.0) {
      // spill outside the body only — never oversaturate the core
      float g = exp(-max(d - uW, 0.0) / (uW * 3.5)) * uGlow;
      color += mix(uColor, vec3(1.0), uSpecial.y * 0.65) * g * 0.8 * (1.0 - body);
      alpha = max(alpha, g);
    }

    // glassmorphic line: frosted translucent stroke with a bright hairline
    // rim and a soft lift shadow — replaces the opaque body entirely
    if (uGlassLine > 0.5) {
      float dsh = distance(vPos - vec2(1.5, 2.5), P);
      vec4 g = vec4(vec3(0.24, 0.26, 0.4), (1.0 - smoothstep(uW * 0.7, uW + 4.0, dsh)) * 0.1);
      vec3 bodyC = mix(color, vec3(1.0), 0.3);
      float t = clamp((r - uR) / uW, -1.2, 1.2);
      bodyC += vec3(1.0) * 0.24 * exp(-pow((t + 0.55) * 2.4, 2.0));
      g = over(g, bodyC, body * 0.55);
      color = g.rgb;
      alpha = g.a;
    }

    // hover highlight: ~2px darker self-colored rim hugging the stroke (SDF
    // distance, so end caps get it too) — makes the lit arcs pop while the
    // rest of the dial dims
    if (uHi > 0.0) {
      float rim = (1.0 - smoothstep(uW + 1.4, uW + 2.4, d)) * smoothstep(uW - 0.6, uW + 0.5, d);
      // squared self-color: darker but hue-true (scaling read as near-black)
      color = mix(color, uColor * uColor, rim * uHi);
      alpha = max(alpha, rim * uHi);
    }

    // Electric visually fades from full category color toward a 50% look, but
    // the painted body stays opaque. Encoding that fade in alpha exposed the
    // orbit line beneath the arc; blend the color toward Electric's dark halo
    // instead so the directional gradient remains without background bleed.
    // Hidden waits are visually indistinguishable from working time. Only
    // suspend Electric's directional fade where the hatch is actually shown;
    // otherwise blocked ranges become full-color rectangular seams.
    color = mix(color, uHalo.rgb, 0.5 * frac * uLinearFade * (1.0 - inHatch * uHatchVisible));
    alpha *= uDim * mix(1.0, 0.3, uConn);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`

// -------------------------------------------------------------- marker shader

const MARKER_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vPos;
  uniform float uRad, uBorder, uDashed, uGloss, uDim;
  uniform vec3 uFill, uStroke;
  uniform float uFillA;
  void main() {
    float r = length(vPos);
    float body = 1.0 - smoothstep(uRad - 0.8, uRad + 0.8, r);
    float ring = (1.0 - smoothstep(uRad, uRad + 1.2, r)) * smoothstep(uRad - uBorder - 1.2, uRad - uBorder, r);
    if (uDashed > 0.5) {
      float a = atan(vPos.x, -vPos.y);
      ring *= step(0.5, fract(a * 2.2));
    }
    vec4 col = vec4(uFill, body * uFillA);
    col = mix(col, vec4(uStroke, 1.0), ring);
    // 3D ball shading: shaded toward the rim, specular up-left
    if (uGloss > 0.0) {
      float t = clamp(r / max(uRad, 0.001), 0.0, 1.2);
      col.rgb *= 1.0 - 0.4 * uGloss * t * t;
      float hl = exp(-length(vPos - vec2(-uRad * 0.32, -uRad * 0.38)) / (uRad * 0.45));
      col.rgb += vec3(1.0) * hl * uGloss * 0.55;
    }
    col.a *= uDim;
    if (col.a < 0.004) discard;
    gl_FragColor = col;
  }
`

// ------------------------------------------------------------- center shader

const CENTER_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vPos;
  uniform float uRingR, uRingW, uInnerR, uHoleR, uSpindleA, uSpindleR, uInnerMode, uOrb, uHoleA, uPearl, uCGlow;
  uniform sampler2D uSpindleTex;
  uniform float uSpindleTexA;
  uniform vec2 uWave;                      // horizon px above center, wobble amp
  uniform vec3 uWhite, uGauge, uInnerTop, uInnerBottom, uSpindle;
  uniform vec2 uSplit;
  uniform float uRingGauge;   // 1 = bold ring mirrors the provider split
  uniform float uRoundCaps;   // Paper center-chip corner radius in pixels
  uniform vec4 uSegs[6];      // a0, a1, 0, 0
  uniform vec3 uSegCols[6];
  uniform int uSegCount;
  uniform float uDim;
  // center hover: which element the pointer is on and how to show it.
  // uHovKind 0 = none, 1 = ring segment (uHovIdx), 2 = provider field
  // (uHovProv 0 = top/openai, 1 = bottom/claude). uHovAmt animates 0..1;
  // uHovFx picks the treatment (0 outline, 1 pop, 2 sonar, 3 spotlight);
  // uHovTime runs only while sonar needs to animate.
  uniform float uHovKind, uHovIdx, uHovProv, uHovAmt, uHovFx, uHovTime;
  ${OVER}

  // Ring piece with skin-selectable end corners. Paper's Figma layer uses a
  // literal 2px corner radius, not a pill/fully-rounded cap.
  float arcMask(vec2 p, float R, float a0, float a1, float w) {
    float r = length(p);
    float a = atan(p.x, -p.y);
    if (a < 0.0) a += 6.28318530718;
    float rel = a - a0;
    if (rel < 0.0) rel += 6.28318530718;
    float span = a1 - a0;
    if (span < 0.0) span += 6.28318530718;
    float e = 1.2 / max(R, 1.0);
    float angM = smoothstep(0.0, e, rel) * (1.0 - smoothstep(span - e, span, rel));
    float radM = smoothstep(R - w - 0.8, R - w + 0.8, r) * (1.0 - smoothstep(R + w - 0.8, R + w + 0.8, r));
    // A lone project is a true closed annulus. Running it through either end
    // mask creates a one-pixel seam where 0 and 2pi meet.
    if (span > 6.28) return radM;
    float flatM = angM * radM;
    float inside = 1.0 - smoothstep(span, span + e, rel);
    float edgeIn = min(rel, span - rel) * R;
    float corner = max(uRoundCaps, 0.001);
    float cx = max(corner - edgeIn, 0.0);
    float cy = max(abs(r - R) - (w - corner), 0.0);
    float rounded = inside * (1.0 - smoothstep(corner - 0.8, corner + 0.8, length(vec2(cx, cy))));
    return mix(flatM, rounded, step(0.01, uRoundCaps));
  }

  void main() {
    vec4 col = vec4(0.0);
    float r = length(vPos);
    float a = atan(vPos.x, -vPos.y);
    if (a < 0.0) a += 6.28318530718;
    float deg = a * 57.29577951;

    // inner disc: provider split — pie (paper) or wave hemisphere (vinyl/electric).
    // The guard runs a few px past the disc edge so pop's growth, its shadow,
    // and sonar's ripples have room to paint outside the resting radius.
    if (r < uInnerR + 34.0) {
      vec3 c;
      float regTop = 0.0; // 1 where the pixel sits in the top/openai field
      float bDist = 1e3;  // px to the split boundary, for outline's ink line
      if (uSplit.x < 0.0) {
        c = uInnerTop;
        regTop = 1.0;
      } else if (uSplit.x > 360.0) {
        c = uInnerBottom;
        regTop = 0.0;
      } else if (uInnerMode < 0.5) {
        // pie split: gray openai wedge uSplit.x°..uSplit.y° (cw, wrapping 0),
        // warm salmon the rest — real days size it by actual agent-hours
        float inGray = 0.0;
        if (deg >= uSplit.x || deg <= uSplit.y) inGray = 1.0;
        float e1 = min(abs(deg - uSplit.x), 360.0 - abs(deg - uSplit.x)) * r * 0.01745;
        float e2 = min(abs(deg - uSplit.y), 360.0 - abs(deg - uSplit.y)) * r * 0.01745;
        float soft = clamp(min(e1, e2) / 1.5, 0.0, 1.0) * 0.5 + 0.5;
        c = mix(uInnerBottom, uInnerTop, inGray * soft + inGray * (1.0 - soft) * 0.5);
        regTop = inGray;
        bDist = min(e1, e2);
      } else {
        float yUp2 = -vPos.y;
        // horizon domes gently upward at center like the mock
        float horizon = uWave.x + cos(vPos.x * 3.14159 / max(uInnerR, 1.0)) * uWave.y;
        float t = smoothstep(horizon - 3.0, horizon + 3.0, yUp2);
        c = mix(uInnerBottom, uInnerTop, t);
        regTop = t;
        bDist = abs(yUp2 - horizon);
        if (uOrb > 0.5) {
          c += uInnerBottom * exp(-abs(yUp2 - horizon) / 1.8) * 0.5;
          // dark core, luminous rim: silver up top, orange below
          c *= 0.3 + 0.7 * pow(r / uInnerR, 1.9);
          float rim = exp(-distance(vPos, vec2(0.0, uInnerR * 0.85)) / (uInnerR * 0.45));
          c += uInnerBottom * rim * 0.9 * (1.0 - t);
        }
      }
      // hover treatment on the provider fields (kind 2); when a ring chip is
      // hovered instead, spotlight recedes the whole disc so the chip carries.
      // hm: 1 where this pixel belongs to the hovered field (regTop is
      // angle/height-based, so it stays valid past the disc edge — pop's
      // growth and sonar's ripples rely on that)
      float hm = (uHovKind > 1.5) ? mix(regTop, 1.0 - regTop, uHovProv) : 0.0;
      int cfx = int(uHovFx + 0.5);
      float rEff = uInnerR;
      if (uHovAmt > 0.001) {
        if (cfx == 0 && uHovKind > 1.5) {
          // outline: ink the hovered field's border — its slice of the disc
          // rim plus the split boundary — in its own darker color
          float rim = smoothstep(uInnerR - 2.6, uInnerR - 1.0, r);
          float edge = 1.0 - smoothstep(0.7, 2.1, bDist);
          // squaring darkens but keeps the hue — the ink stays recognizably
          // the field's own color instead of crushing toward black
          c = mix(c, c * c, clamp(max(rim, edge), 0.0, 1.0) * hm * uHovAmt);
        } else if (cfx == 1 && uHovKind > 1.5) {
          // pop: the hovered field lifts — it grows past the resting edge and
          // casts a soft paper shadow down-right
          rEff = uInnerR + 3.0 * uHovAmt * hm;
          float shm = (1.0 - smoothstep(rEff - 1.0, rEff + 4.5, length(vPos - vec2(1.8, 2.8)))) * hm * uHovAmt;
          col = over(col, vec3(0.23, 0.19, 0.15), shm * 0.26);
          c = mix(c, vec3(1.0), 0.07 * uHovAmt * hm);
        } else if (cfx == 3) {
          // spotlight: everything not hovered washes toward paper (never a
          // darken — dimming the warm fields muddies them toward brown)
          float rest = (uHovKind > 1.5) ? (1.0 - hm) : 1.0;
          c = mix(c, vec3(0.96, 0.94, 0.92), 0.35 * uHovAmt * rest);
          c = mix(c, vec3(1.0), 0.05 * uHovAmt * hm);
        }
      }
      float m = 1.0 - smoothstep(rEff - 1.0, rEff + 1.0, r);
      col = over(col, c, m);
      // sonar: rings of the field's own color ripple out from its edge
      if (cfx == 2 && uHovKind > 1.5 && uHovAmt > 0.001) {
        float ph1 = fract(uHovTime / 1.5);
        float ph2 = fract(uHovTime / 1.5 + 0.5);
        float rr1 = uInnerR + 2.0 + ph1 * 26.0;
        float rr2 = uInnerR + 2.0 + ph2 * 26.0;
        float ring = (1.0 - smoothstep(1.2, 2.4, abs(r - rr1))) * (1.0 - ph1)
                   + (1.0 - smoothstep(1.2, 2.4, abs(r - rr2))) * (1.0 - ph2);
        col = over(col, c * 0.85, ring * 0.5 * hm * uHovAmt * step(uInnerR + 1.0, r));
      }
    }

    // bold ring — mock art only: white sweep 246.5°..40°, gauge 123°..245°.
    // real days (uRingGauge) skip these: the project chips below tile the
    // whole ring, and the provider split lives in the pie alone
    float half_ = uRingW * 0.5;
    if (uRingGauge < 0.5) {
      float wm = arcMask(vPos, uRingR, 4.302, 0.698, half_);
      col = over(col, uWhite, wm);
      float gm = arcMask(vPos, uRingR, 2.151, 4.273, half_);
      col = over(col, uGauge, gm);
    }
    for (int i = 0; i < 6; i++) {
      if (i >= uSegCount) break;
      float mine = (uHovKind > 0.5 && uHovKind < 1.5 && abs(float(i) - uHovIdx) < 0.5) ? 1.0 : 0.0;
      float hov = mine * uHovAmt;
      // "rest": some other center element owns the hover right now
      float rest = uHovAmt * (uHovKind > 1.5 ? 1.0 : (uHovKind > 0.5 ? 1.0 - mine : 0.0));
      int fx = int(uHovFx + 0.5);
      float segR = uRingR;
      float segW = half_;
      vec3 sc = uSegCols[i];
      if (fx == 1) {
        // pop: the chip lifts like a paper cutout — swells, brightens a touch,
        // and casts a soft shadow down-right onto the ring underneath
        segR += 3.0 * hov;
        segW = half_ * (1.0 + 0.4 * hov);
        sc = mix(sc, vec3(1.0), 0.08 * hov);
        if (hov > 0.0) {
          float shm = arcMask(vPos - vec2(2.0, 3.0) * hov, segR, uSegs[i].x, uSegs[i].y, segW + 1.0);
          col = over(col, vec3(0.23, 0.19, 0.15), shm * 0.28 * hov);
        }
      } else if (fx == 2 && hov > 0.0) {
        // sonar: two staggered rings of the chip's color ripple outward,
        // confined to the chip's own angular span
        float ph1 = fract(uHovTime / 1.5);
        float ph2 = fract(uHovTime / 1.5 + 0.5);
        float p1 = arcMask(vPos, uRingR + half_ + 2.0 + ph1 * 28.0, uSegs[i].x, uSegs[i].y, 1.6) * (1.0 - ph1);
        float p2 = arcMask(vPos, uRingR + half_ + 2.0 + ph2 * 28.0, uSegs[i].x, uSegs[i].y, 1.6) * (1.0 - ph2);
        col = over(col, sc, (p1 + p2) * 0.55 * hov);
      }
      float m = arcMask(vPos, segR, uSegs[i].x, uSegs[i].y, segW);
      // spotlight recedes the non-hovered chips by translucency (paper shows through)
      float fade = (fx == 3) ? 1.0 - 0.45 * rest : 1.0;
      col = over(col, sc, m * fade);
      if (fx == 0 && hov > 0.0) {
        // outline: an inked rim in the chip's own darker color, matching the
        // rim the associated dial arcs draw (uHi in the arc shader)
        // the outer mask grows angularly too (dA ≈ stroke width in radians),
        // so the frame closes around the chip's flat end faces, not just the
        // curved edges
        float dA = 1.8 / max(segR, 1.0);
        float outer = arcMask(vPos, segR, uSegs[i].x - dA, uSegs[i].y + dA, segW + 1.8);
        float inner = arcMask(vPos, segR, uSegs[i].x, uSegs[i].y, segW - 0.6);
        // squared, not scaled: darker but still unmistakably the chip's color
        col = over(col, sc * sc, clamp(outer - inner, 0.0, 1.0) * hov);
      }
    }

    // Vinyl uses the exported Figma artwork directly. The source ellipse is
    // 41px with a 2.5px outside stroke, so the exported bitmap is 46x46px.
    if (uSpindleTexA > 0.5) {
      vec2 spindleUv = vPos / 46.0 + 0.5;
      float inSpindleTex = step(max(abs(vPos.x), abs(vPos.y)), 23.0);
      vec4 spindleTexel = texture2D(uSpindleTex, spindleUv);
      col = over(col, spindleTexel.rgb, spindleTexel.a * inSpindleTex);
    } else if (uSpindleA > 0.0) {
      if (uPearl > 0.5) {
        float sp = 1.0 - smoothstep(uSpindleR - 0.8, uSpindleR + 0.8, r);
        vec3 ball = uSpindle;
        float t = clamp(r / uSpindleR, 0.0, 1.2);
        ball *= 1.0 - 0.35 * t * t;
        ball += vec3(1.0) * exp(-length(vPos - vec2(-uSpindleR * 0.3, -uSpindleR * 0.38)) / (uSpindleR * 0.42)) * 0.6;
        col = over(col, ball, sp * uSpindleA);
      } else {
        float sp = 1.0 - smoothstep(uSpindleR - 0.8, uSpindleR + 0.8, r);
        col = over(col, uSpindle, sp * uSpindleA);
      }
    }
    // soft white halo breathing out from the puck (glass)
    if (uCGlow > 0.0) {
      float g = exp(-max(r - (uRingR + uRingW * 0.5), 0.0) / 22.0) * step(uRingR, r);
      col = over(col, vec3(1.0), g * uCGlow * 0.4);
    }
    // glowing ring rim (electric)
    if (uOrb > 0.5) {
      col.rgb += uGauge * (1.0 - smoothstep(0.0, uRingW * 3.0, abs(r - uRingR))) * 0.22;
    }
    // punch the center hole
    if (uHoleA > 0.0) {
      float hole = 1.0 - smoothstep(uHoleR - 0.8, uHoleR + 0.8, r);
      col.a *= 1.0 - hole * uHoleA;
    }

    col.a *= uDim;
    if (col.a < 0.004) discard;
    gl_FragColor = col;
  }
`

// ---------------------------------------------------------------------- scene

export interface ArcHandle {
  thread: Thread
  mesh: THREE.Mesh
  uniforms: Record<string, THREE.IUniform>
  /** gap bridge between stretches of one session — not a hover target */
  connector?: boolean
  /** authored segment joins may be square in technical skins; Paper keeps
   * every visible piece pill-ended like the Figma frame */
  sqCaps?: [boolean, boolean]
}

export class AgentScene {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera: THREE.OrthographicCamera
  discUniforms: Record<string, THREE.IUniform> = {}
  centerUniforms: Record<string, THREE.IUniform> = {}
  arcs: ArcHandle[] = []
  markers: THREE.Mesh[] = []
  /** delay-hatch treatment — remembered so rebuilt arcs keep the pick */
  hatchStyle = 0
  /** off means blocked spans render as untouched original-color arc body */
  hatchVisible = false
  /** center hover treatment — remembered so a rebuilt center keeps the pick */
  centerHoverFx = 0
  private dirty = true
  /** stage px covered by one screen pixel — the vinyl grooves fade out below
   *  this pitch rather than alias, and it changes with both the display's
   *  device ratio and how far CSS has scaled the stage down to fit */
  private stagePx = 1

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(STAGE_W, STAGE_H, false)
    this.camera = new THREE.OrthographicCamera(0, STAGE_W, 0, STAGE_H, -10, 10)
    // y-down pixel space
    this.camera.projectionMatrix.makeOrthographic(0, STAGE_W, 0, STAGE_H, -10, 10)
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert()
  }

  invalidate() { this.dirty = true }

  /** glass finish: 0 = painted matte, 1 = frost (refracting), 2 = liquid lens */
  setGlassMode(mode: number) {
    if (this.discUniforms.uGlassMode) this.discUniforms.uGlassMode.value = mode
    this.invalidate()
  }

  /** keep the backing store dense enough when the stage is CSS-upscaled */
  setViewScale(stageScale: number) {
    const pr = Math.min(window.devicePixelRatio * Math.max(1, stageScale), 3)
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(STAGE_W, STAGE_H, false)
    // whichever is coarser: one rendered texel, or one physical pixel of the
    // CSS-scaled stage the browser resamples that texel down into
    const onScreen = 1 / Math.max(0.05, window.devicePixelRatio * stageScale)
    this.stagePx = Math.max(1 / pr, onScreen)
    const vb = this.discUniforms.uVinylB
    if (vb) (vb.value as THREE.Vector4).w = this.stagePx
    this.invalidate()
  }

  renderIfNeeded() {
    if (!this.dirty) return
    this.dirty = false
    this.renderer.render(this.scene, this.camera)
  }

  private quad(size: number, frag: string, uniforms: Record<string, THREE.IUniform>, z = 0): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(2, 2)
    const mat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: frag,
      uniforms: { uSize: { value: new THREE.Vector2(size, size) }, ...uniforms },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(CENTER_X, CENTER_Y, z)
    mesh.renderOrder = z
    this.scene.add(mesh)
    return mesh
  }

  buildDisc(skin: SkinScene) {
    const fields = Array.from({ length: MAX_FIELDS }, () => new THREE.Vector4())
    const fieldCols = Array.from({ length: MAX_FIELDS }, () => new THREE.Vector4())
    const sectors = Array.from({ length: MAX_SECTORS }, () => new THREE.Vector4())
    this.discUniforms = {
      uDiscR: { value: skin.discR },
      uDiscAlpha: { value: skin.discAlpha },
      uDiscColor: { value: c3(skin.discColor) },
      uTilt: { value: (skin.tilt * Math.PI) / 180 },
      uNotch: { value: (NOTCH_DEG * Math.PI) / 180 },
      uFields: { value: fields },
      uFieldColors: { value: fieldCols },
      uFieldBands: { value: Array.from({ length: MAX_FIELDS }, () => new THREE.Vector4()) },
      uFieldNotch: { value: new Float32Array(MAX_FIELDS).fill(1) },
      uFieldCount: { value: 0 },
      uSpokes: { value: Array.from({ length: 14 }, () => new THREE.Vector4()) },
      uSpokeCount: { value: 0 },
      uSpokeCol: { value: new THREE.Vector3() },
      uHands: { value: new THREE.Vector4() },
      uHandsCol: { value: new THREE.Vector3() },
      uSectors: { value: sectors },
      uSectorCount: { value: 0 },
      uSectorZone: { value: new THREE.Vector2(0, 1000) },
      uTicks: { value: new THREE.Vector4() },
      uTickCol: { value: new THREE.Vector4() },
      uTickMisc: { value: new THREE.Vector2() },
      uConc: { value: new Float32Array(CONC_N) },
      uConcMax: { value: 0 },
      uSeismo: { value: new THREE.Vector4(10, 468, 3, 55) },
      uDayWin: { value: new THREE.Vector3(0, 24, 2) },
      uBezel: { value: new THREE.Vector4() },
      uBezelIn: { value: new THREE.Vector3() },
      uBezelOut: { value: new THREE.Vector3() },
      uBezel2: { value: new THREE.Vector4() },
      uBezel2In: { value: new THREE.Vector3() },
      uBezel2Out: { value: new THREE.Vector3() },
      uOuterRing: { value: new THREE.Vector4() },
      uOuterCol: { value: new THREE.Vector3() },
      uLabel: { value: new THREE.Vector4() },
      uLabelCol: { value: new THREE.Vector3() },
      uGlass: { value: new THREE.Vector4() },
      uGlassL: { value: new THREE.Vector2() },
      uGlassMode: { value: 1 },
      uVinyl: { value: new THREE.Vector4() },
      uVinylB: { value: new THREE.Vector4(3, 0.16, 0, this.stagePx) },
      uVinylC: { value: new THREE.Vector4(1, 1, 0, 7) },
      uVinylCol: { value: new THREE.Vector3() },
      uDiscHole: { value: 0 },
    }
    this.quad(620, DISC_FRAG, this.discUniforms, 0)
    this.applySkinToDisc(skin)
  }

  /** seismograph tuning: bar spacing (px of arc), baseline radius, min/max bar length */
  setSeismo(spacing: number, baseR: number, minLen: number, maxLen: number) {
    ;(this.discUniforms.uSeismo.value as THREE.Vector4).set(spacing, baseR, minLen, maxLen)
    this.invalidate()
  }

  /** minor whiskers scale with concurrent-agent count per bucket; null = mock jitter */
  setConcurrency(hist: number[] | null) {
    const arr = this.discUniforms.uConc.value as Float32Array
    arr.fill(0)
    hist?.slice(0, arr.length).forEach((v, i) => { arr[i] = v })
    // floor of 1 keeps a real all-zero day on the data path (flat minimum
    // rim) instead of tripping the uConcMax==0 mock-jitter fallback
    this.discUniforms.uConcMax.value = hist ? Math.max(...hist, 1) : 0
    this.invalidate()
  }

  applySkinToDisc(skin: SkinScene) {
    const u = this.discUniforms
    u.uDiscR.value = skin.discR
    u.uDiscAlpha.value = skin.discAlpha
    ;(u.uDiscColor.value as THREE.Vector3).copy(c3(skin.discColor))
    u.uTilt.value = (skin.tilt * Math.PI) / 180
    skin.ringFields.forEach((f, i) => {
      ;(u.uFields.value as THREE.Vector4[])[i].set(f.r0, f.r1, f.period, f.duty)
      const c = new THREE.Color(f.color)
      ;(u.uFieldColors.value as THREE.Vector4[])[i].set(c.r, c.g, c.b, f.alpha)
      ;(u.uFieldBands.value as THREE.Vector4[])[i].set(f.bandPeriod ?? 0, f.bandWidth ?? 0, f.soft ?? 1, f.grain ?? 0)
      ;(u.uFieldNotch.value as Float32Array)[i] = f.notch === false ? 0 : 1
    })
    u.uFieldCount.value = skin.ringFields.length
    // sectors compare in degrees in the shader
    skin.sectors.forEach((s, i) => {
      ;(u.uSectors.value as THREE.Vector4[])[i].set(s.a0, s.a1, s.wash, 0)
    })
    u.uSectorCount.value = skin.sectors.length
    ;(u.uSectorZone.value as THREE.Vector2).set(skin.sectorZone[0], skin.sectorZone[1])
    // spokes track the hour-label marks of the current day window
    const spokeTpl = skin.spokes[0]
    const spokeHours = spokeTpl ? labelHours() : []
    spokeHours.slice(0, 14).forEach((h, i) => {
      ;(u.uSpokes.value as THREE.Vector4[])[i].set(hourToAngle(h), spokeTpl.rIn, spokeTpl.rOut, spokeTpl.alpha)
    })
    u.uSpokeCount.value = Math.min(spokeHours.length, 14)
    ;(u.uDayWin.value as THREE.Vector3).set(DAY_WIN.start, DAY_WIN.end, labelStep())
    ;(u.uSpokeCol.value as THREE.Vector3).copy(c3(skin.spokeColor))
    if (skin.hands) {
      ;(u.uHands.value as THREE.Vector4).set(skin.hands.rIn, skin.hands.rOut, skin.hands.alpha, skin.hands.width ?? 1.8)
      ;(u.uHandsCol.value as THREE.Vector3).copy(c3(skin.hands.color))
    } else {
      ;(u.uHands.value as THREE.Vector4).set(0, 0, 0, 0)
    }
    ;(u.uTicks.value as THREE.Vector4).set(skin.ticks.rInner, skin.ticks.minorLen, skin.ticks.majorLen, skin.ticks.minorPerHour)
    const tc = new THREE.Color(skin.ticks.color)
    ;(u.uTickCol.value as THREE.Vector4).set(tc.r, tc.g, tc.b, skin.ticks.alpha)
    ;(u.uTickMisc.value as THREE.Vector2).set(skin.ticks.jitter, skin.ticks.glow)
    if (skin.bezel) {
      ;(u.uBezel.value as THREE.Vector4).set(skin.bezel.r0, skin.bezel.r1, 0, 1)
      ;(u.uBezelIn.value as THREE.Vector3).copy(c3(skin.bezel.inner))
      ;(u.uBezelOut.value as THREE.Vector3).copy(c3(skin.bezel.outer))
    } else {
      ;(u.uBezel.value as THREE.Vector4).set(0, 0, 0, 0)
    }
    if (skin.bezel2) {
      ;(u.uBezel2.value as THREE.Vector4).set(skin.bezel2.r0, skin.bezel2.r1, 0, 1)
      ;(u.uBezel2In.value as THREE.Vector3).copy(c3(skin.bezel2.inner))
      ;(u.uBezel2Out.value as THREE.Vector3).copy(c3(skin.bezel2.outer))
    } else {
      ;(u.uBezel2.value as THREE.Vector4).set(0, 0, 0, 0)
    }
    if (skin.outerRing) {
      ;(u.uOuterRing.value as THREE.Vector4).set(
        skin.outerRing.r,
        skin.outerRing.width,
        skin.outerRing.alpha,
        skin.outerRing.notch ? 2 : 1,
      )
      ;(u.uOuterCol.value as THREE.Vector3).copy(c3(skin.outerRing.color))
    } else {
      ;(u.uOuterRing.value as THREE.Vector4).set(0, 0, 0, 0)
    }
    if (skin.labelDisc) {
      ;(u.uLabel.value as THREE.Vector4).set(skin.labelDisc.r, 1, 0, 0)
      ;(u.uLabelCol.value as THREE.Vector3).copy(c3(skin.labelDisc.color))
    } else {
      ;(u.uLabel.value as THREE.Vector4).set(0, 0, 0, 0)
    }
    if (skin.vinylMat) {
      const v = skin.vinylMat
      ;(u.uVinyl.value as THREE.Vector4).set(v.r0, v.r1, v.strength, 1)
      ;(u.uVinylB.value as THREE.Vector4).set(v.pitch, v.gloss, (v.lightDeg * Math.PI) / 180, this.stagePx)
      ;(u.uVinylC.value as THREE.Vector4).set(v.grooveDepth ?? 1, v.trackBands ?? 1, v.wear ?? 0, v.focus ?? 7)
      ;(u.uVinylCol.value as THREE.Vector3).copy(c3(v.color))
    } else {
      ;(u.uVinyl.value as THREE.Vector4).set(0, 0, 0, 0)
    }
    if (skin.glass) {
      ;(u.uGlass.value as THREE.Vector4).set(skin.glass.r0, skin.glass.r1, skin.glass.alpha, 1)
      ;(u.uGlassL.value as THREE.Vector2).set((skin.glass.lightDeg * Math.PI) / 180, skin.glass.rim)
    } else {
      ;(u.uGlass.value as THREE.Vector4).set(0, 0, 0, 0)
    }
    // the center layer's punched hole continues through the platter, so a
    // skin that declares one is transparent to the page all the way down
    u.uDiscHole.value = skin.center?.holeA ? (skin.center.holeR ?? CENTER.spindleR) : 0
    this.invalidate()
  }

  buildArcs(arcs: ResolvedArc[], skin: SkinScene) {
    for (const [ai, a] of arcs.entries()) {
      const bodyW = Math.min(skin.arcWidth ?? a.width, arcWidthRaw())
      // A pill cap extends half a stroke beyond its centerline endpoint. When
      // that endpoint is the Start/End notch boundary, inset the center by the
      // exact angular cap radius so the rounded paint kisses the line without
      // entering the notch.
      // Include the shader's antialias fringe; a mathematically tangent SDF
      // still paints its outer transition pixels across the line otherwise.
      const capRadius = bodyW / 2 + 1.2
      const capAngle = Math.asin(Math.min(1, capRadius / Math.max(a.radius, 0.001)))
      // Clamp against the visible notch by rendered extent, not timestamp
      // equality. Aug 23's first activity begins at 4.001 while the window
      // begins at 4.000: semantically distinct, but still close enough for its
      // rounded cap to cross the Start line unless geometry catches it here.
      const notchAngle = (DAY_WIN.notch * Math.PI) / 180
      let drawA0 = notchAngle > 0 ? Math.max(a.a0, notchAngle + capAngle) : a.a0
      let drawA1 = notchAngle > 0 ? Math.min(a.a1, Math.PI * 2 - notchAngle - capAngle) : a.a1
      if (drawA1 < drawA0) {
        const mid = (drawA0 + drawA1) / 2
        drawA0 = mid
        drawA1 = mid
      }
      const uniforms: Record<string, THREE.IUniform> = {
        uR: { value: a.radius },
        uA0: { value: drawA0 },
        uA1: { value: drawA1 },
        // the skin's authored width is a ceiling, not an override: crowded
        // days thin the arcs below it, roomy days let it show at full size;
        // connectors run at a hairline fraction of the body stroke
        uW: { value: (a.connector ? Math.max(1.4, bodyW * 0.3) : bodyW) / 2 },
        uProgress: { value: 1 },
        uGlow: { value: a.connector ? 0 : skin.arcGlow },
        uGloss: { value: skin.gloss ?? 0 },
        uGlassLine: { value: skin.glassLine ? 1 : 0 },
        uDim: { value: 1 },
        uHi: { value: 0 },
        uLinearFade: { value: skin.id === 'electric' && !a.connector ? 1 : 0 },
        uConn: { value: a.connector ? 1 : 0 },
        uColor: { value: c3(labColor(ai, skin.arcPalette[a.thread.category])) },
        uDots: { value: new THREE.Vector4(0, 0, 0, 0) },
        uHatch: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, 0)) },
        uHatchCol: { value: c3('#ff6c52') },
        uHatchStyle: { value: this.hatchStyle },
        uHatchVisible: { value: this.hatchVisible ? 1 : 0 },
        uHalo: { value: a.connector ? new THREE.Vector4(0, 0, 0, 0) : haloVec(skin) },
        // uTail stays zero: the frame leaves an unfinished thread in its own
        // colour and says so with the coral burst on its end instead of
        // bleaching the tail
        uTail: { value: new THREE.Vector4(0, 0, 0, 0) },
        uTailCol: { value: c3('#f2a08e') },
        uSpecial: { value: new THREE.Vector2(0.5, 1) },
        uSqCaps: { value: new THREE.Vector2(
          skin.id !== 'paper' && a.sqCaps?.[0] ? 1 : 0,
          skin.id !== 'paper' && a.sqCaps?.[1] ? 1 : 0,
        ) },
      }
      if (a.thread.dotted && !a.connector) {
        // the frame's beads are 7px across on an 18.6px pitch
        ;(uniforms.uDots.value as THREE.Vector4).set(0, 1, 18.6, 3.5)
      }
      if (a.blocked) {
        // the shader carries four slots; a thread that stalled more often
        // than that keeps its four longest waits (fractions of THIS arc —
        // segmented threads arrive pre-remapped per stretch)
        const spans = [...a.blocked].sort((p, q) => (q[1] - q[0]) - (p[1] - p[0])).slice(0, 4)
        spans.forEach(([f0, f1], i) => {
          ;((uniforms.uHatch.value as THREE.Vector4[])[i]).set(f0, f1, 1, 0)
        })
      }
      const mesh = this.quad(a.radius + 20, ARC_FRAG, uniforms, 2)
      this.arcs.push({
        thread: a.thread, mesh, uniforms,
        ...(a.connector ? { connector: true } : {}),
        ...(a.sqCaps ? { sqCaps: a.sqCaps } : {}),
      })
    }
  }

  setHatchStyle(style: number) {
    this.hatchStyle = style
    for (const h of this.arcs) h.uniforms.uHatchStyle.value = style
    this.invalidate()
  }

  setHatchVisible(visible: boolean) {
    this.hatchVisible = visible
    for (const h of this.arcs) h.uniforms.uHatchVisible.value = visible ? 1 : 0
    this.invalidate()
  }

  applySkinToArcs(skin: SkinScene) {
    for (const [hi, h] of this.arcs.entries()) {
      const bodyW = Math.min(skin.arcWidth ?? arcWidth(), arcWidthRaw())
      ;(h.uniforms.uColor.value as THREE.Vector3).copy(c3(labColor(hi, skin.arcPalette[h.thread.category])))
      h.uniforms.uGlow.value = h.connector ? 0 : skin.arcGlow
      h.uniforms.uLinearFade.value = skin.id === 'electric' && !h.connector ? 1 : 0
      h.uniforms.uGloss.value = skin.gloss ?? 0
      h.uniforms.uGlassLine.value = skin.glassLine ? 1 : 0
      h.uniforms.uW.value = (h.connector ? Math.max(1.4, bodyW * 0.3) : bodyW) / 2
      ;(h.uniforms.uHalo.value as THREE.Vector4).copy(h.connector ? new THREE.Vector4(0, 0, 0, 0) : haloVec(skin))
      ;(h.uniforms.uSqCaps.value as THREE.Vector2).set(
        skin.id !== 'paper' && h.sqCaps?.[0] ? 1 : 0,
        skin.id !== 'paper' && h.sqCaps?.[1] ? 1 : 0,
      )
    }
    this.invalidate()
  }

  addMarker(x: number, y: number, opts: { rad: number; fill: string; fillA: number; stroke: string; border: number; dashed?: boolean; gloss?: number; showAt?: number }) {
    const uniforms: Record<string, THREE.IUniform> = {
      uRad: { value: opts.rad },
      uBorder: { value: opts.border },
      uDashed: { value: opts.dashed ? 1 : 0 },
      uGloss: { value: opts.gloss ?? 0 },
      uDim: { value: 1 },
      uFill: { value: c3(opts.fill) },
      uStroke: { value: c3(opts.stroke) },
      uFillA: { value: opts.fillA },
    }
    const mesh = this.quad(opts.rad + 4, MARKER_FRAG, uniforms, 3)
    mesh.position.set(x, y, 3)
    mesh.userData.showAt = opts.showAt ?? 0
    this.markers.push(mesh)
    return mesh
  }

  applyClock(h: number) {
    for (const m of this.markers) m.visible = h >= (m.userData.showAt as number)
    this.invalidate()
  }

  clearMarkers() {
    for (const m of this.markers) {
      this.scene.remove(m)
      ;(m.material as THREE.Material).dispose()
    }
    this.markers = []
  }

  clearArcs() {
    for (const h of this.arcs) {
      this.scene.remove(h.mesh)
      ;(h.mesh.material as THREE.Material).dispose()
    }
    this.arcs = []
    this.invalidate()
  }

  /** swap the center donut's segments (day navigation) */
  setDonut(segs: { a0: number; a1: number; category: string }[], skin: SkinScene) {
    this.segAngles = segs
    const vecs = this.centerUniforms.uSegs.value as THREE.Vector4[]
    const cols = this.centerUniforms.uSegCols.value as THREE.Vector3[]
    segs.slice(0, 6).forEach((s, i) => {
      const tau = Math.PI * 2
      const a0 = ((s.a0 % tau) + tau) % tau
      const a1 = s.a1 - s.a0 >= tau - 1e-6 ? a0 + tau : ((s.a1 % tau) + tau) % tau
      vecs[i].set(a0, a1, 0, 0)
      cols[i].copy(c3(skin.donutPalette[s.category as keyof typeof skin.donutPalette] ?? '#cccccc'))
    })
    this.centerUniforms.uSegCount.value = Math.min(segs.length, 6)
    this.invalidate()
  }

  private segAngles: { a0: number; a1: number; category: string }[] = []

  buildCenter(skin: SkinScene, segs: { a0: number; a1: number; category: string }[]) {
    this.segAngles = segs
    const segVecs = Array.from({ length: 6 }, () => new THREE.Vector4())
    const segCols = Array.from({ length: 6 }, () => new THREE.Vector3())
    segs.forEach((s, i) => {
      const tau = Math.PI * 2
      const a0 = ((s.a0 % tau) + tau) % tau
      const a1 = s.a1 - s.a0 >= tau - 1e-6 ? a0 + tau : ((s.a1 % tau) + tau) % tau
      segVecs[i].set(a0, a1, 0, 0)
      segCols[i].copy(c3(skin.donutPalette[s.category as keyof typeof skin.donutPalette]))
    })
    const spindleTex = new THREE.TextureLoader().load('/assets/vinyl-center-hole.png', () => this.invalidate())
    spindleTex.minFilter = THREE.LinearFilter
    spindleTex.magFilter = THREE.LinearFilter
    spindleTex.generateMipmaps = false
    this.centerUniforms = {
      uRingR: { value: skin.center?.ringR ?? CENTER.gaugeR },
      uRingW: { value: skin.center?.ringW ?? CENTER.gaugeW },
      uInnerR: { value: skin.center?.innerR ?? CENTER.innerR },
      uHoleA: { value: skin.center?.holeA ?? 1 },
      uHoleR: { value: skin.center?.holeR ?? CENTER.spindleR },
      uSpindleA: { value: skin.spindleAlpha },
      uSpindleR: { value: skin.spindleR },
      uSpindleTex: { value: spindleTex },
      uSpindleTexA: { value: skin.id === 'vinyl' ? 1 : 0 },
      uPearl: { value: skin.pearl ? 1 : 0 },
      uCGlow: { value: skin.centerGlow ?? 0 },
      uWave: { value: new THREE.Vector2(skin.wave?.y ?? 8, skin.wave?.amp ?? 6) },
      uInnerMode: { value: skin.innerMode === 'wave' ? 1 : 0 },
      uOrb: { value: skin.orb ? 1 : 0 },
      uWhite: { value: c3(skin.gaugeTop) },
      uGauge: { value: c3(skin.gaugeBottom) },
      uInnerTop: { value: c3(skin.innerTop) },
      uInnerBottom: { value: c3(skin.innerBottom) },
      uSpindle: { value: c3(skin.spindle) },
      uSegs: { value: segVecs },
      uSegCols: { value: segCols },
      uSegCount: { value: segs.length },
      uSplit: { value: new THREE.Vector2(329, 94) },
      uRingGauge: { value: 0 },
      uRoundCaps: { value: ['paper', 'vinyl', 'electric'].includes(skin.id) ? 2 : 0 },
      uDim: { value: 1 },
      uHovKind: { value: 0 },
      uHovIdx: { value: -1 },
      uHovProv: { value: 0 },
      uHovAmt: { value: 0 },
      uHovFx: { value: this.centerHoverFx },
      uHovTime: { value: 0 },
    }
    this.quad(CENTER.labelR + 40, CENTER_FRAG, this.centerUniforms, 4)
  }

  /** center hover treatment: 0 outline, 1 pop, 2 sonar, 3 spotlight (else off) */
  setCenterHoverFx(i: number) {
    this.centerHoverFx = i
    if (this.centerUniforms.uHovFx) this.centerUniforms.uHovFx.value = i
    this.invalidate()
  }

  /** aim the center hover at a ring segment (kind 1, idx) or a provider field
   *  (kind 2, prov 0 = top/openai, 1 = bottom); intensity animates via uHovAmt */
  setCenterHoverTarget(kind: number, idx: number, prov: number) {
    const u = this.centerUniforms
    if (!u.uHovKind) return
    u.uHovKind.value = kind
    u.uHovIdx.value = idx
    u.uHovProv.value = prov
    this.invalidate()
  }

  /** provider wedge boundaries in degrees cw from 12 o'clock (mock art: 329/94);
      gauge re-shapes the bold ring into a split-driven provider gauge, and
      waveY moves the wave skins' horizon (px above center) to the real share */
  setProviderSplit(a: number, b: number, gauge = false, waveY: number | null = null) {
    ;(this.centerUniforms.uSplit.value as THREE.Vector2).set(a, b)
    this.centerUniforms.uRingGauge.value = gauge ? 1 : 0
    if (waveY !== null) (this.centerUniforms.uWave.value as THREE.Vector2).x = waveY
    this.invalidate()
  }

  applySkinToCenter(skin: SkinScene) {
    const u = this.centerUniforms
    ;(u.uWhite.value as THREE.Vector3).copy(c3(skin.gaugeTop))
    ;(u.uGauge.value as THREE.Vector3).copy(c3(skin.gaugeBottom))
    ;(u.uInnerTop.value as THREE.Vector3).copy(c3(skin.innerTop))
    ;(u.uInnerBottom.value as THREE.Vector3).copy(c3(skin.innerBottom))
    ;(u.uSpindle.value as THREE.Vector3).copy(c3(skin.spindle))
    u.uSpindleA.value = skin.spindleAlpha
    u.uSpindleR.value = skin.spindleR
    u.uSpindleTexA.value = skin.id === 'vinyl' ? 1 : 0
    u.uPearl.value = skin.pearl ? 1 : 0
    u.uCGlow.value = skin.centerGlow ?? 0
    ;(u.uWave.value as THREE.Vector2).set(skin.wave?.y ?? 8, skin.wave?.amp ?? 6)
    u.uInnerMode.value = skin.innerMode === 'wave' ? 1 : 0
    u.uOrb.value = skin.orb ? 1 : 0
    u.uRingR.value = skin.center?.ringR ?? CENTER.gaugeR
    u.uRingW.value = skin.center?.ringW ?? CENTER.gaugeW
    u.uRoundCaps.value = ['paper', 'vinyl', 'electric'].includes(skin.id) ? 2 : 0
    u.uInnerR.value = skin.center?.innerR ?? CENTER.innerR
    u.uHoleA.value = skin.center?.holeA ?? 1
    u.uHoleR.value = skin.center?.holeR ?? CENTER.spindleR
    this.segAngles.forEach((s, i) => {
      ;(u.uSegCols.value as THREE.Vector3[])[i].copy(c3(skin.donutPalette[s.category as keyof typeof skin.donutPalette]))
    })
    this.invalidate()
  }
}
