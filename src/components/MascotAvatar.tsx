'use client';

import React, { useEffect, useRef } from 'react';

export type MascotPoseState = 'idle' | 'dragging' | 'hover' | 'dropping' | 'pointing' | 'dance';
export type MascotFacing = 'right' | 'left';
export type HeadExpression =
  | 'neutral'
  | 'smile'
  | 'look_l'
  | 'look_r'
  | 'blink'
  | 'enthusiastic'
  | 'look_spot';

// Canonical sprite coordinate space (all PNGs in /public/mascot/ share 245x725 canvas)
export const MASCOT_SPRITE_ASPECT = 245 / 725;

// Tighter fingertip anchor so the mascot stands directly next to the searched house/commerce coordinate
export const MASCOT_POINTING_TIP_FRACTION = {
  x: 295 / 245,
  y: 404 / 725,
};

export function getPointingAnchorPx(heightPx: number, facing: MascotFacing): {
  widthPx: number;
  anchorX: number;
  anchorY: number;
  popupX: number;
  popupY: number;
} {
  const widthPx = Math.max(10, Math.round(heightPx * MASCOT_SPRITE_ASPECT));
  const tipRightX = Math.round(widthPx * MASCOT_POINTING_TIP_FRACTION.x);
  const anchorY = Math.round(heightPx * MASCOT_POINTING_TIP_FRACTION.y);
  const anchorX = facing === 'right' ? tipRightX : widthPx - tipRightX;
  const headCenterX =
    facing === 'right' ? Math.round(widthPx * 0.54) : widthPx - Math.round(widthPx * 0.54);
  const popupX = headCenterX - anchorX;
  const popupY = -anchorY - 6;
  return { widthPx, anchorX, anchorY, popupX, popupY };
}

/**
 * Determines whether the target location lies to the left or right of the figurine on screen
 * so she stands beside the street and turns directly toward the searched house.
 */
export function resolvePointingFacing(params: {
  pinLat: number;
  pinLon: number;
  polylines?: Array<{ p: [number, number][] }>;
  bearingDeg?: number;
  fallbackViewportFractionX?: number;
}): MascotFacing {
  const { pinLat, pinLon, polylines, bearingDeg = 0, fallbackViewportFractionX } = params;

  const cosLat = Math.cos((pinLat * Math.PI) / 180);
  const radB = (bearingDeg * Math.PI) / 180;
  const cosB = Math.cos(radB);
  const sinB = Math.sin(radB);

  const toScreenDeltaX = (dLat: number, dLon: number): number => {
    const east = dLon * cosLat;
    const north = dLat;
    return east * cosB - north * sinB;
  };

  if (polylines && polylines.length > 0) {
    let bestDistSq = Infinity;
    let bestRoadLat = pinLat;
    let bestRoadLon = pinLon;
    let sumLat = 0;
    let sumLon = 0;
    let count = 0;

    for (const seg of polylines) {
      const pts = seg.p;
      for (let i = 0; i < pts.length; i++) {
        sumLat += pts[i][0];
        sumLon += pts[i][1];
        count++;

        if (i + 1 < pts.length) {
          const ax = pts[i][1] * cosLat;
          const ay = pts[i][0];
          const bx = pts[i + 1][1] * cosLat;
          const by = pts[i + 1][0];
          const px = pinLon * cosLat;
          const py = pinLat;
          const vx = bx - ax;
          const vy = by - ay;
          const lenSq = vx * vx + vy * vy;
          const t =
            lenSq > 1e-16
              ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq))
              : 0;
          const projLon = (ax + t * vx) / cosLat;
          const projLat = ay + t * vy;
          const dx = (pinLon - projLon) * cosLat;
          const dy = pinLat - projLat;
          const dSq = dx * dx + dy * dy;
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestRoadLat = projLat;
            bestRoadLon = projLon;
          }
        }
      }
    }

    const lateralScreenDx = toScreenDeltaX(pinLat - bestRoadLat, pinLon - bestRoadLon);
    if (Math.abs(lateralScreenDx) > 0.000018) {
      return lateralScreenDx < 0 ? 'left' : 'right';
    }

    if (count > 0) {
      const meanLat = sumLat / count;
      const meanLon = sumLon / count;
      const streetSpanDx = toScreenDeltaX(pinLat - meanLat, pinLon - meanLon);
      if (Math.abs(streetSpanDx) > 0.00004) {
        return streetSpanDx < 0 ? 'left' : 'right';
      }
    }
  }

  if (typeof fallbackViewportFractionX === 'number') {
    return fallbackViewportFractionX < 0.48 ? 'left' : 'right';
  }
  return 'right';
}

const HEAD_EXPRESSION_SRCS: Record<HeadExpression, string> = {
  neutral: '/mascot/head.png',
  smile: '/mascot/head_smile.png',
  look_l: '/mascot/head_look_l.png',
  look_r: '/mascot/head_look_r.png',
  blink: '/mascot/head_blink.png',
  enthusiastic: '/mascot/head_enthusiastic.png',
  look_spot: '/mascot/head_look_spot.png',
};

const ALL_MASCOT_SRCS = [
  '/mascot/thigh_r.png',
  '/mascot/shin_r.png',
  '/mascot/thigh_l.png',
  '/mascot/shin_l.png',
  '/mascot/torso.png',
  '/mascot/upper_arm_l.png',
  '/mascot/forearm_l.png',
  '/mascot/forearm_point_l.png',
  '/mascot/upper_arm_r.png',
  '/mascot/forearm_r.png',
  ...Object.values(HEAD_EXPRESSION_SRCS),
];

let preloaded = false;
export function preloadMascotSprites(): void {
  if (preloaded || typeof window === 'undefined') return;
  preloaded = true;
  for (const src of ALL_MASCOT_SRCS) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
  }
}

export interface MascotPoseAngles {
  bodyX: number;
  bodyAngle: number;
  bodyY: number;
  scaleX: number;
  scaleY: number;
  headAngle: number;
  torsoY: number;
  armRUpper: number;
  armRFore: number;
  takeLHand: boolean;
  armLUpper: number;
  armLFore: number;
  pointingHand: boolean;
  legR: number;
  shinR: number;
  legL: number;
  shinL: number;
  legRScaleY: number;
  legLScaleY: number;
  expression: HeadExpression;
}

function easeInOutSine(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return -(Math.cos(Math.PI * c) - 1) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface DanceKeyframe {
  t: number; // normalized 0..1 inside 3.5s seamless loop
  bx: number; // px horizontal slide (for ~56px marker height)
  by: number; // px vertical bounce/crouch
  ba: number; // body tilt deg
  ha: number; // head tilt deg
  ru: number; // right upper arm deg
  rf: number; // right forearm deg
  lu: number; // left upper arm deg
  lf: number; // left forearm deg
  tr: number; // right thigh deg
  sr: number; // right shin/knee bend deg
  tl: number; // left thigh deg
  sl: number; // left shin/knee bend deg
  expr: 'smile' | 'enthusiastic';
}

// Authentic Passinho do Jamal choreography grounded in Recife brega-funk tutorials (Derick, Eo Chapa/Jamal, @sorvetedanny, @fnxzk_):
// Two full 130+ BPM phrases ("1 - 2" alternating same-side knee+hand, then "1, 2, 3" triple pulse + lateral glide "anda pro lado")
// with opposite hip sway to the stepping/lifted leg and elastic two-knee brega-funk bounce.
const JAMAL_LOOP_MS = 4800;
const JAMAL_KEYFRAMES: DanceKeyframe[] = [
  { t: 0.000, bx:  0.0, by:  2.2, ba:  0.0, ha:  0.0, ru:  -8, rf: -104, lu:   8, lf:  104, tr: 10, sr: -18, tl: -10, sl: 18, expr: 'smile' },

  // Phrase 1 ("1 - 2"): Right knee+hand -> elastic plant -> Left knee+hand -> elastic plant
  { t: 0.055, bx:  2.4, by: -2.2, ba:  2.8, ha: -4.5, ru: -16, rf: -150, lu: -11, lf:  -12, tr: 34, sr: -56, tl: -11, sl: 19, expr: 'enthusiastic' },
  { t: 0.115, bx:  0.2, by:  2.4, ba:  0.0, ha:  0.0, ru:  -9, rf: -108, lu:   9, lf:  108, tr: 12, sr: -22, tl: -12, sl: 22, expr: 'smile' },
  { t: 0.170, bx: -2.4, by: -2.2, ba: -2.8, ha:  4.5, ru:  11, rf:   12, lu:  15, lf:  158, tr: 11, sr: -19, tl: -34, sl: 56, expr: 'enthusiastic' },
  { t: 0.225, bx:  0.0, by:  2.4, ba:  0.0, ha:  0.0, ru:  -9, rf: -110, lu:   9, lf:  110, tr: 12, sr: -22, tl: -12, sl: 22, expr: 'smile' },

  // Phrase 2 ("1, 2, 3 ... anda pro lado!"): Triple right beat + lateral glide left
  { t: 0.270, bx:  2.5, by: -2.0, ba:  2.8, ha: -4.5, ru: -16, rf: -150, lu: -12, lf:  -12, tr: 32, sr: -52, tl: -10, sl: 18, expr: 'enthusiastic' },
  { t: 0.315, bx:  0.7, by:  2.2, ba:  0.5, ha: -1.0, ru: -10, rf: -102, lu:  -9, lf:   -8, tr: 11, sr: -18, tl: -10, sl: 18, expr: 'smile' },
  { t: 0.360, bx:  2.6, by: -2.1, ba:  3.0, ha: -4.8, ru: -16, rf: -150, lu: -12, lf:  -12, tr: 33, sr: -54, tl: -10, sl: 18, expr: 'enthusiastic' },
  { t: 0.405, bx:  0.7, by:  2.2, ba:  0.5, ha: -1.0, ru: -10, rf: -102, lu:  -9, lf:   -8, tr: 11, sr: -18, tl: -10, sl: 18, expr: 'smile' },
  { t: 0.445, bx:  2.4, by: -1.8, ba:  2.5, ha: -4.0, ru: -16, rf: -148, lu: -12, lf:  -12, tr: 30, sr: -48, tl: -11, sl: 20, expr: 'enthusiastic' },
  { t: 0.490, bx: -1.6, by:  2.8, ba: -2.8, ha:  3.2, ru:  -9, rf: -112, lu:  10, lf:  112, tr: 16, sr: -24, tl: -26, sl: 32, expr: 'smile' },
  { t: 0.530, bx: -3.2, by:  2.3, ba: -1.0, ha:  1.5, ru:  -9, rf: -108, lu:   9, lf:  108, tr: 12, sr: -20, tl: -12, sl: 20, expr: 'smile' },

  // Mirror Phrase 3 ("1 - 2"): Left knee+hand -> plant -> Right knee+hand -> plant
  { t: 0.580, bx: -4.2, by: -2.2, ba: -2.8, ha:  4.5, ru:  11, rf:   12, lu:  15, lf:  158, tr: 11, sr: -19, tl: -34, sl: 56, expr: 'enthusiastic' },
  { t: 0.640, bx: -1.8, by:  2.4, ba:  0.0, ha:  0.0, ru:  -9, rf: -108, lu:   9, lf:  108, tr: 12, sr: -22, tl: -12, sl: 22, expr: 'smile' },
  { t: 0.695, bx:  1.4, by: -2.2, ba:  2.8, ha: -4.5, ru: -16, rf: -150, lu: -11, lf:  -12, tr: 34, sr: -56, tl: -11, sl: 19, expr: 'enthusiastic' },
  { t: 0.750, bx: -1.0, by:  2.4, ba:  0.0, ha:  0.0, ru:  -9, rf: -110, lu:   9, lf:  110, tr: 12, sr: -22, tl: -12, sl: 22, expr: 'smile' },

  // Mirror Phrase 4 ("1, 2, 3 ... anda de volta!"): Triple left beat + lateral glide back to center
  { t: 0.795, bx: -3.2, by: -2.0, ba: -2.8, ha:  4.5, ru:  12, rf:   12, lu:  15, lf:  158, tr: 10, sr: -18, tl: -32, sl: 52, expr: 'enthusiastic' },
  { t: 0.840, bx: -1.6, by:  2.2, ba: -0.5, ha:  1.0, ru:   9, rf:    8, lu:  10, lf:  102, tr: 10, sr: -18, tl: -11, sl: 18, expr: 'smile' },
  { t: 0.885, bx: -3.4, by: -2.1, ba: -3.0, ha:  4.8, ru:  12, rf:   12, lu:  15, lf:  158, tr: 10, sr: -18, tl: -33, sl: 54, expr: 'enthusiastic' },
  { t: 0.925, bx: -1.6, by:  2.2, ba: -0.5, ha:  1.0, ru:   9, rf:    8, lu:  10, lf:  102, tr: 10, sr: -18, tl: -11, sl: 18, expr: 'smile' },
  { t: 0.960, bx: -2.8, by: -1.8, ba: -2.5, ha:  4.0, ru:  12, rf:   12, lu:  15, lf:  156, tr: 11, sr: -20, tl: -30, sl: 48, expr: 'enthusiastic' },
  { t: 0.985, bx: -0.6, by:  2.6, ba:  2.2, ha: -2.5, ru: -10, rf: -110, lu:   9, lf:  110, tr: 22, sr: -30, tl: -14, sl: 22, expr: 'smile' },
  { t: 1.000, bx:  0.0, by:  2.2, ba:  0.0, ha:  0.0, ru:  -8, rf: -104, lu:   8, lf:  104, tr: 10, sr: -18, tl: -10, sl: 18, expr: 'smile' },
];

/**
 * Computes exact 60fps articulated figurine kinematics:
 * - 'idle' / 'hover': Every 20s cycle alternates every 10s between:
 *   [1.2s .. 5.4s] Warm bigger smile + look left + look right + back to center
 *   [11.2s .. 15.4s] Raise right arm & cheerfully wave to the user
 * - 'dragging': Velocity-driven Google Maps Pegman pendulum tilt + articulated kicking legs + open arms
 * - 'pointing': Turned toward the searched location, repeats every 3s:
 *   [0.0s .. 3.0s] Wait standing turned & smiling warmly toward the spot (arm down)
 *   [3.0s .. 3.42s] Raise arm toward the spot with pointing finger
 *   [3.42s .. 4.26s] Point TWICE clearly while smiling & looking at the spot
 *   [4.26s .. 5.12s] Turn gaze to look directly at US smiling enthusiastically & point a THIRD time
 *   [5.12s .. 5.70s] Lower arm smoothly back to rest -> wait 3s -> repeat
 * - 'dance': Passinho do Jamal (based directly on TikTok @fnxzk_/video/7573394013374385429):
 *   Articulated hip + knee footwork ("um, dois, três" foot taps, knee pops & lateral lunge slide)
 *   synchronized with alternating hand-across-mouth sweeps and double-chest transitions.
 */
export function computeMascotKinematics(
  nowMs: number,
  state: MascotPoseState,
  dragTiltDeg = 0,
  phaseOffsetMs = 0
): MascotPoseAngles {
  const tSec = nowMs / 1000;

  if (state === 'dance') {
    const u = ((nowMs + phaseOffsetMs) % JAMAL_LOOP_MS) / JAMAL_LOOP_MS;
    let i = 0;
    while (i < JAMAL_KEYFRAMES.length - 2 && u > JAMAL_KEYFRAMES[i + 1].t) {
      i++;
    }
    const a = JAMAL_KEYFRAMES[i];
    const b = JAMAL_KEYFRAMES[i + 1];
    const span = Math.max(1e-5, b.t - a.t);
    const k = easeInOutSine((u - a.t) / span);
    const by = lerp(a.by, b.by, k);
    const squash = Math.max(0, by) * 0.007;
    const blinkPhase = (nowMs + phaseOffsetMs) % 4300;
    const isBlinking = blinkPhase > 4070 && blinkPhase < 4200;

    return {
      bodyX: lerp(a.bx, b.bx, k),
      bodyAngle: lerp(a.ba, b.ba, k),
      bodyY: by,
      scaleX: 1 + squash,
      scaleY: 1 - squash * 1.15,
      headAngle: lerp(a.ha, b.ha, k),
      torsoY: by * 0.14,
      armRUpper: lerp(a.ru, b.ru, k),
      armRFore: lerp(a.rf, b.rf, k),
      takeLHand: false,
      armLUpper: lerp(a.lu, b.lu, k),
      armLFore: lerp(a.lf, b.lf, k),
      pointingHand: false,
      legR: lerp(a.tr, b.tr, k),
      shinR: lerp(a.sr, b.sr, k),
      legL: lerp(a.tl, b.tl, k),
      shinL: lerp(a.sl, b.sl, k),
      legRScaleY: 1,
      legLScaleY: 1,
      expression: isBlinking ? 'blink' : k > 0.5 ? b.expr : a.expr,
    };
  }

  if (state === 'dragging') {
    const kick = Math.sin(tSec * 14);
    const armFlap = Math.sin(tSec * 10);
    return {
      bodyX: 0,
      bodyAngle: dragTiltDeg,
      bodyY: -2,
      scaleX: 1,
      scaleY: 1,
      headAngle: Math.max(-10, Math.min(10, -dragTiltDeg * 0.35)),
      torsoY: 0,
      armRUpper: 26 + armFlap * 8,
      armRFore: 18 + Math.cos(tSec * 10) * 10,
      takeLHand: false,
      armLUpper: -26 + armFlap * 8,
      armLFore: -12,
      pointingHand: false,
      legR: kick * 18,
      shinR: -kick * 22,
      legL: -kick * 18,
      shinL: kick * 22,
      legRScaleY: 1,
      legLScaleY: 1,
      expression: 'smile',
    };
  }

  if (state === 'dropping') {
    return {
      bodyX: 0,
      bodyAngle: 0,
      bodyY: 2,
      scaleX: 1.05,
      scaleY: 0.94,
      headAngle: 4,
      torsoY: 0.5,
      armRUpper: 32,
      armRFore: 118,
      takeLHand: false,
      armLUpper: -12,
      armLFore: 0,
      pointingHand: false,
      legR: 8,
      shinR: -12,
      legL: -8,
      shinL: 12,
      legRScaleY: 1,
      legLScaleY: 1,
      expression: 'smile',
    };
  }

  if (state === 'pointing') {
    // Cycle = 3000ms wait + 2700ms choreography = 5700ms
    const p = (nowMs + phaseOffsetMs) % 5700;
    const breath = Math.sin(tSec * 2.1);
    const blinkPhase = (nowMs + phaseOffsetMs) % 4800;
    const isBlinking = blinkPhase > 4600 && blinkPhase < 4730;

    if (p < 3000) {
      // Standing turned toward the searched house with arm relaxed at side for 3 seconds
      return {
        bodyX: 0,
        bodyAngle: 1.8,
        bodyY: 0,
        scaleX: 1,
        scaleY: 1,
        headAngle: 9 + breath * 0.6,
        torsoY: -breath * 0.4,
        armRUpper: -breath * 0.9,
        armRFore: 0,
        takeLHand: false,
        armLUpper: breath * 0.9,
        armLFore: 0,
        pointingHand: false,
        legR: -1,
        shinR: 0,
        legL: 1,
        shinL: 0,
        legRScaleY: 1,
        legLScaleY: 1,
        expression: isBlinking ? 'blink' : 'look_spot',
      };
    }

    if (p < 3420) {
      // Raise pointing arm toward the location
      const k = easeInOutSine((p - 3000) / 420);
      return {
        bodyX: 0,
        bodyAngle: lerp(1.8, 3.2, k),
        bodyY: -k * 1.0,
        scaleX: 1,
        scaleY: 1 + k * 0.01,
        headAngle: lerp(9, 11.5, k),
        torsoY: -k * 0.4,
        armRUpper: lerp(0, 4, k),
        armRFore: lerp(0, 4, k),
        takeLHand: false,
        armLUpper: lerp(0, -23, k),
        armLFore: lerp(0, -34, k),
        pointingHand: k > 0.3,
        legR: -1.5,
        shinR: 0,
        legL: 1.5,
        shinL: 0,
        legRScaleY: 1,
        legLScaleY: 1,
        expression: 'look_spot',
      };
    }

    if (p < 4260) {
      // Point TWICE clearly while smiling at the location
      const pulsePhase = (p - 3420) / 840; // 0..1 -> two smooth symmetric peaks at 0.25 & 0.75
      const bump = Math.pow(Math.sin(pulsePhase * Math.PI * 2), 2);
      return {
        bodyX: 0,
        bodyAngle: 3.2 + bump * 1.4,
        bodyY: -bump * 2.4,
        scaleX: 1 - bump * 0.012,
        scaleY: 1 + bump * 0.018,
        headAngle: 11.5 + bump * 2.2,
        torsoY: -bump * 0.6,
        armRUpper: 4 + bump * 1.5,
        armRFore: 4 + bump * 3,
        takeLHand: false,
        armLUpper: -23 - bump * 4.5,
        armLFore: -34 - bump * 11,
        pointingHand: true,
        legR: -1.5,
        shinR: 0,
        legL: 1.5,
        shinL: 0,
        legRScaleY: 1,
        legLScaleY: 1,
        expression: 'look_spot',
      };
    }

    if (p < 5120) {
      // Turn to look enthusiastically at US and point a THIRD time!
      const q = (p - 4260) / 860;
      const headTurn = easeInOutSine(Math.min(1, q / 0.28));
      const pt3 = q < 0.2 || q > 0.92 ? 0 : Math.sin(((q - 0.2) / 0.72) * Math.PI);
      return {
        bodyX: 0,
        bodyAngle: lerp(3.2, 1.0, headTurn) + pt3 * 1.2,
        bodyY: -pt3 * 2.8,
        scaleX: 1 - pt3 * 0.014,
        scaleY: 1 + pt3 * 0.022,
        headAngle: lerp(11.5, -3, headTurn),
        torsoY: -pt3 * 0.7,
        armRUpper: 4 + pt3 * 2,
        armRFore: 5 + pt3 * 4,
        takeLHand: false,
        armLUpper: -23 - pt3 * 5,
        armLFore: -34 - pt3 * 12,
        pointingHand: true,
        legR: -1.5,
        shinR: 0,
        legL: 1.5,
        shinL: 0,
        legRScaleY: 1,
        legLScaleY: 1,
        expression: headTurn > 0.4 ? 'enthusiastic' : 'look_spot',
      };
    }

    // Smoothly lower arm back to rest side of body
    const k = easeInOutSine((p - 5120) / 580);
    return {
      bodyX: 0,
      bodyAngle: lerp(1.0, 1.8, k),
      bodyY: 0,
      scaleX: 1,
      scaleY: 1,
      headAngle: lerp(-3, 9, k),
      torsoY: 0,
      armRUpper: lerp(4, 0, k),
      armRFore: lerp(5, 0, k),
      takeLHand: false,
      armLUpper: lerp(-23, 0, k),
      armLFore: lerp(-34, 0, k),
      pointingHand: k < 0.55,
      legR: -1,
      shinR: 0,
      legL: 1,
      shinL: 0,
      legRScaleY: 1,
      legLScaleY: 1,
      expression: k > 0.55 ? 'look_spot' : 'enthusiastic',
    };
  }

  // Subtle idle breathing & spontaneous blinks
  const breath = Math.sin(tSec * 1.9);
  const blinkPhase = (nowMs + phaseOffsetMs) % 4300;
  const isBlinking = blinkPhase > 3950 && blinkPhase < 4110;

  let headAngle = breath * 0.8;
  let armRUpper = breath * 1.2;
  let armRFore = 0;
  let armLUpper = -breath * 1.2;
  let expression: HeadExpression = isBlinking ? 'blink' : 'neutral';

  if (state === 'hover') {
    expression = isBlinking ? 'blink' : 'smile';
    headAngle = 3.5;
  }

  // 20s alternating choreography for corner Pegman:
  //   0s..10s beat (active 1.2s..5.4s): smiles warmly & looks to both sides
  //  10s..20s beat (active 11.2s..15.4s): waves cheerfully at the user
  const cycleMs = (nowMs + phaseOffsetMs) % 20000;

  if (cycleMs >= 1200 && cycleMs < 5400) {
    const p = cycleMs - 1200;
    expression = 'smile';
    if (p < 450) {
      const k = easeInOutSine(p / 450);
      headAngle = lerp(0, -8.5, k);
      if (k > 0.45) expression = 'look_l';
    } else if (p < 1450) {
      headAngle = -8.5;
      expression = 'look_l';
    } else if (p < 2250) {
      const k = easeInOutSine((p - 1450) / 800);
      headAngle = lerp(-8.5, 8.5, k);
      expression = k < 0.35 ? 'look_l' : k < 0.65 ? 'smile' : 'look_r';
    } else if (p < 3250) {
      headAngle = 8.5;
      expression = 'look_r';
    } else if (p < 3850) {
      const k = easeInOutSine((p - 3250) / 600);
      headAngle = lerp(8.5, 0, k);
      expression = k < 0.35 ? 'look_r' : 'smile';
    } else {
      headAngle = 0;
      expression = 'smile';
    }
    armRUpper = 2.5;
    armLUpper = -2.5;
  } else if (cycleMs >= 11200 && cycleMs < 15400) {
    const p = cycleMs - 11200;
    expression = isBlinking ? 'blink' : 'smile';
    if (p < 550) {
      const k = easeInOutSine(p / 550);
      armRUpper = lerp(0, 35, k);
      armRFore = lerp(0, 122, k);
      headAngle = lerp(0, 5, k);
      armLUpper = lerp(0, -4, k);
    } else if (p < 3500) {
      const wp = (p - 550) / 2950;
      const waveOsc = Math.sin(wp * Math.PI * 6);
      armRUpper = 35 + waveOsc * 3.5;
      armRFore = 122 + waveOsc * 13;
      headAngle = 5 + waveOsc * 1.5;
      armLUpper = -4;
    } else {
      const k = easeInOutSine((p - 3500) / 700);
      armRUpper = lerp(35, 0, k);
      armRFore = lerp(122, 0, k);
      headAngle = lerp(5, 0, k);
      armLUpper = lerp(-4, 0, k);
    }
  }

  return {
    bodyX: 0,
    bodyAngle: 0,
    bodyY: 0,
    scaleX: 1,
    scaleY: 1,
    headAngle,
    torsoY: -breath * 0.45,
    armRUpper,
    armRFore,
    takeLHand: false,
    armLUpper,
    armLFore: 0,
    pointingHand: false,
    legR: 0,
    shinR: 0,
    legL: 0,
    shinL: 0,
    legRScaleY: 1,
    legLScaleY: 1,
    expression,
  };
}

interface MascotRigDomRefs {
  root: HTMLDivElement;
  shadow?: HTMLDivElement | null;
  legR: HTMLDivElement;
  shinR: HTMLImageElement;
  legL: HTMLDivElement;
  shinL: HTMLImageElement;
  headWrap: HTMLDivElement;
  headLayers: Record<HeadExpression, HTMLImageElement>;
  torso: HTMLImageElement;
  armLUpper: HTMLDivElement;
  armLFore: HTMLDivElement;
  armLNormalHand: HTMLImageElement;
  armLPointHand: HTMLImageElement;
  armRUpper: HTMLDivElement;
  armRFore: HTMLDivElement;
  armRNormalHand: HTMLImageElement;
  armRTakeLHand: HTMLImageElement;
}

function applyKinematicsToDom(refs: MascotRigDomRefs, k: MascotPoseAngles): void {
  refs.root.style.transform = `translate3d(${k.bodyX.toFixed(2)}px, ${k.bodyY.toFixed(2)}px, 0) rotate(${k.bodyAngle.toFixed(2)}deg) scale(${k.scaleX.toFixed(3)}, ${k.scaleY.toFixed(3)})`;
  if (refs.shadow) {
    const shScale = Math.max(0.75, Math.min(1.25, 1 + k.bodyY * 0.035));
    refs.shadow.style.transform = `translate3d(${k.bodyX.toFixed(2)}px, 0, 0) scale(${shScale.toFixed(3)}, 1)`;
  }
  refs.legR.style.transform = `rotate(${k.legR.toFixed(2)}deg) scaleY(${k.legRScaleY.toFixed(3)})`;
  refs.shinR.style.transform = `rotate(${k.shinR.toFixed(2)}deg)`;
  refs.legL.style.transform = `rotate(${k.legL.toFixed(2)}deg) scaleY(${k.legLScaleY.toFixed(3)})`;
  refs.shinL.style.transform = `rotate(${k.shinL.toFixed(2)}deg)`;
  refs.headWrap.style.transform = `rotate(${k.headAngle.toFixed(2)}deg)`;
  refs.torso.style.transform = `translate3d(0, ${k.torsoY.toFixed(2)}px, 0)`;
  refs.armLUpper.style.transform = `rotate(${k.armLUpper.toFixed(2)}deg)`;
  refs.armLFore.style.transform = `rotate(${k.armLFore.toFixed(2)}deg)`;
  refs.armLNormalHand.style.opacity = k.pointingHand ? '0' : '1';
  refs.armLPointHand.style.opacity = k.pointingHand ? '1' : '0';
  refs.armRUpper.style.transform = `rotate(${k.armRUpper.toFixed(2)}deg)`;
  refs.armRFore.style.transform = `rotate(${k.armRFore.toFixed(2)}deg)`;
  refs.armRNormalHand.style.opacity = k.takeLHand ? '0' : '1';
  refs.armRTakeLHand.style.opacity = k.takeLHand ? '1' : '0';

  for (const expr of Object.keys(refs.headLayers) as HeadExpression[]) {
    refs.headLayers[expr].style.opacity = expr === k.expression ? '1' : '0';
  }
}

/**
 * Pure imperative DOM mount + smooth animator for Leaflet / MapLibre custom HTML markers.
 * Returns a cleanup callback to stop requestAnimationFrame on marker removal.
 */
export function mountAnimatedMascotElement(
  host: HTMLElement,
  options: {
    heightPx?: number;
    mode?: MascotPoseState;
    facing?: MascotFacing;
    auraColor?: string;
    showPulse?: boolean;
    hideGroundDot?: boolean;
    headingConeDeg?: number;
    phaseOffsetMs?: number;
  } = {}
): () => void {
  preloadMascotSprites();

  const heightPx = options.heightPx ?? 48;
  const widthPx = Math.max(10, Math.round(heightPx * MASCOT_SPRITE_ASPECT));
  const mode = options.mode ?? 'idle';
  const facing = options.facing ?? 'right';
  // For pointing pins, advance start so her first 2+1 point sequence begins ~0.4s after appearing!
  const mountStartMs = performance.now();
  const phaseOffsetMs = options.phaseOffsetMs ?? (mode === 'pointing' ? 2600 : 0);

  host.style.position = 'relative';
  host.style.width = `${widthPx}px`;
  host.style.height = `${heightPx}px`;
  host.style.overflow = 'visible';
  host.style.pointerEvents = 'auto';

  let shadowEl: HTMLDivElement | null = null;
  const flipWrap = document.createElement('div');
  flipWrap.style.cssText = `position:relative;width:100%;height:100%;overflow:visible;transform-origin:50% 50%;${
    facing === 'left' ? 'transform:scaleX(-1);' : ''
  }`;

  if (options.auraColor && !options.hideGroundDot) {
    if (options.showPulse) {
      const pulse = document.createElement('div');
      pulse.className = 'pin-pulse-ring';
      pulse.style.cssText = `position:absolute;left:50%;bottom:-3px;width:18px;height:8px;margin-left:-9px;border-radius:999px;background:${options.auraColor};opacity:0.5;pointer-events:none;`;
      host.appendChild(pulse);
    }
    const baseRing = document.createElement('div');
    baseRing.style.cssText = `position:absolute;left:50%;bottom:-2px;width:14px;height:6px;margin-left:-7px;border-radius:999px;background:${options.auraColor};border:1.5px solid #FFFFFF;box-shadow:0 3px 8px rgba(15,23,42,0.5);pointer-events:none;`;
    host.appendChild(baseRing);
  } else {
    shadowEl = document.createElement('div');
    const sw = Math.max(12, Math.round(widthPx * 0.85));
    shadowEl.style.cssText = `position:absolute;left:50%;bottom:-1px;width:${sw}px;height:4px;margin-left:-${Math.round(sw / 2)}px;border-radius:999px;background:rgba(2,6,23,0.44);filter:blur(1.5px);pointer-events:none;will-change:transform;`;
    flipWrap.appendChild(shadowEl);
  }

  if (typeof options.headingConeDeg === 'number') {
    const coneWrap = document.createElement('div');
    coneWrap.dataset.svCone = '1';
    coneWrap.style.cssText = `position:absolute;left:50%;bottom:-14px;width:34px;height:34px;margin-left:-17px;transform:rotate(${options.headingConeDeg}deg);transition:transform 0.15s ease;pointer-events:none;`;
    coneWrap.innerHTML = `<svg width="34" height="34" viewBox="0 0 44 44"><path d="M22 22 L11 2 A21 21 0 0 1 33 2 Z" fill="rgba(245, 158, 11, 0.42)" stroke="#F59E0B" stroke-width="1.2"/></svg>`;
    host.appendChild(coneWrap);
  }

  const root = document.createElement('div');
  root.style.cssText =
    'position:relative;width:100%;height:100%;overflow:visible;transform-origin:53.88% 22.07%;will-change:transform;filter:drop-shadow(0 3px 6px rgba(2,6,23,0.55));';

  const makeImg = (src: string, style: string): HTMLImageElement => {
    const im = document.createElement('img');
    im.src = src;
    im.alt = '';
    im.draggable = false;
    im.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none;user-select:none;${style}`;
    return im;
  };

  const legR = document.createElement('div');
  legR.style.cssText =
    'position:absolute;inset:0;overflow:visible;z-index:1;transform-origin:39.18% 61.79%;will-change:transform;';
  legR.appendChild(makeImg('/mascot/thigh_r.png', ''));
  const shinR = makeImg(
    '/mascot/shin_r.png',
    'transform-origin:36.33% 78.34%;will-change:transform;'
  );
  legR.appendChild(shinR);

  const legL = document.createElement('div');
  legL.style.cssText =
    'position:absolute;inset:0;overflow:visible;z-index:2;transform-origin:64.49% 61.79%;will-change:transform;';
  legL.appendChild(makeImg('/mascot/thigh_l.png', ''));
  const shinL = makeImg(
    '/mascot/shin_l.png',
    'transform-origin:66.12% 78.34%;will-change:transform;'
  );
  legL.appendChild(shinL);

  const headWrap = document.createElement('div');
  headWrap.style.cssText =
    'position:absolute;inset:0;overflow:visible;z-index:3;transform-origin:53.88% 30.62%;will-change:transform;';

  const headLayers: Record<HeadExpression, HTMLImageElement> = {
    neutral: makeImg(HEAD_EXPRESSION_SRCS.neutral, 'opacity:1;'),
    smile: makeImg(HEAD_EXPRESSION_SRCS.smile, 'opacity:0;'),
    look_l: makeImg(HEAD_EXPRESSION_SRCS.look_l, 'opacity:0;'),
    look_r: makeImg(HEAD_EXPRESSION_SRCS.look_r, 'opacity:0;'),
    blink: makeImg(HEAD_EXPRESSION_SRCS.blink, 'opacity:0;'),
    enthusiastic: makeImg(HEAD_EXPRESSION_SRCS.enthusiastic, 'opacity:0;'),
    look_spot: makeImg(HEAD_EXPRESSION_SRCS.look_spot, 'opacity:0;'),
  };
  (Object.keys(headLayers) as HeadExpression[]).forEach((k) => headWrap.appendChild(headLayers[k]));

  const torso = makeImg('/mascot/torso.png', 'z-index:4;will-change:transform;');

  const armLUpper = document.createElement('div');
  armLUpper.style.cssText =
    'position:absolute;inset:0;overflow:visible;z-index:5;transform-origin:77.96% 35.59%;will-change:transform;';
  armLUpper.appendChild(makeImg('/mascot/upper_arm_l.png', ''));

  const armLFore = document.createElement('div');
  armLFore.style.cssText =
    'position:absolute;inset:0;overflow:visible;transform-origin:85.10% 49.10%;will-change:transform;';
  const armLNormalHand = makeImg('/mascot/forearm_l.png', 'opacity:1;');
  const armLPointHand = makeImg('/mascot/forearm_point_l.png', 'opacity:0;');
  armLFore.append(armLNormalHand, armLPointHand);
  armLUpper.appendChild(armLFore);

  const armRUpper = document.createElement('div');
  armRUpper.style.cssText =
    'position:absolute;inset:0;overflow:visible;z-index:6;transform-origin:20.41% 35.03%;will-change:transform;';
  armRUpper.appendChild(makeImg('/mascot/upper_arm_r.png', ''));

  const armRFore = document.createElement('div');
  armRFore.style.cssText =
    'position:absolute;inset:0;overflow:visible;transform-origin:11.84% 49.10%;will-change:transform;';
  const armRNormalHand = makeImg('/mascot/forearm_r.png', 'opacity:1;');
  const armRTakeLHand = makeImg('/mascot/forearm_take_l_r.png', 'opacity:0;');
  armRFore.append(armRNormalHand, armRTakeLHand);
  armRUpper.appendChild(armRFore);

  root.append(legR, legL, headWrap, torso, armLUpper, armRUpper);
  flipWrap.appendChild(root);
  host.appendChild(flipWrap);

  const refs: MascotRigDomRefs = {
    root,
    shadow: shadowEl,
    legR,
    shinR,
    legL,
    shinL,
    headWrap,
    headLayers,
    torso,
    armLUpper,
    armLFore,
    armLNormalHand,
    armLPointHand,
    armRUpper,
    armRFore,
    armRNormalHand,
    armRTakeLHand,
  };

  let rafId = 0;
  let lastDraw = 0;
  const tick = (now: number) => {
    if (now - lastDraw >= 22) {
      lastDraw = now;
      const clock = mode === 'pointing' ? performance.now() - mountStartMs : performance.now();
      applyKinematicsToDom(refs, computeMascotKinematics(clock, mode, 0, phaseOffsetMs));
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return () => {
    if (rafId) cancelAnimationFrame(rafId);
  };
}

interface MascotAvatarProps {
  heightPx?: number;
  state?: MascotPoseState;
  facing?: MascotFacing;
  dragTiltDeg?: number;
  dragTiltRef?: React.MutableRefObject<number>;
  phaseOffsetMs?: number;
  className?: string;
}

export default function MascotAvatar({
  heightPx = 48,
  state = 'idle',
  facing = 'right',
  dragTiltDeg = 0,
  dragTiltRef,
  phaseOffsetMs = 0,
  className = '',
}: MascotAvatarProps) {
  const widthPx = Math.max(10, Math.round(heightPx * MASCOT_SPRITE_ASPECT));

  const rootRef = useRef<HTMLDivElement | null>(null);
  const legRRef = useRef<HTMLDivElement | null>(null);
  const shinRRef = useRef<HTMLImageElement | null>(null);
  const legLRef = useRef<HTMLDivElement | null>(null);
  const shinLRef = useRef<HTMLImageElement | null>(null);
  const headWrapRef = useRef<HTMLDivElement | null>(null);
  const neutralRef = useRef<HTMLImageElement | null>(null);
  const smileRef = useRef<HTMLImageElement | null>(null);
  const lookLRef = useRef<HTMLImageElement | null>(null);
  const lookRRef = useRef<HTMLImageElement | null>(null);
  const blinkRef = useRef<HTMLImageElement | null>(null);
  const enthusiasticRef = useRef<HTMLImageElement | null>(null);
  const lookSpotRef = useRef<HTMLImageElement | null>(null);
  const torsoRef = useRef<HTMLImageElement | null>(null);
  const armLUpperRef = useRef<HTMLDivElement | null>(null);
  const armLForeRef = useRef<HTMLDivElement | null>(null);
  const armLNormalHandRef = useRef<HTMLImageElement | null>(null);
  const armLPointHandRef = useRef<HTMLImageElement | null>(null);
  const armRUpperRef = useRef<HTMLDivElement | null>(null);
  const armRForeRef = useRef<HTMLDivElement | null>(null);
  const armRNormalHandRef = useRef<HTMLImageElement | null>(null);
  const armRTakeLHandRef = useRef<HTMLImageElement | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  const tiltPropRef = useRef(dragTiltDeg);
  tiltPropRef.current = dragTiltDeg;

  useEffect(() => {
    preloadMascotSprites();
    const mountStartMs = performance.now();

    let rafId = 0;
    const loop = () => {
      if (
        rootRef.current &&
        legRRef.current &&
        shinRRef.current &&
        legLRef.current &&
        shinLRef.current &&
        headWrapRef.current &&
        neutralRef.current &&
        smileRef.current &&
        lookLRef.current &&
        lookRRef.current &&
        blinkRef.current &&
        enthusiasticRef.current &&
        lookSpotRef.current &&
        torsoRef.current &&
        armLUpperRef.current &&
        armLForeRef.current &&
        armLNormalHandRef.current &&
        armLPointHandRef.current &&
        armRUpperRef.current &&
        armRForeRef.current &&
        armRNormalHandRef.current &&
        armRTakeLHandRef.current
      ) {
        const refs: MascotRigDomRefs = {
          root: rootRef.current,
          legR: legRRef.current,
          shinR: shinRRef.current,
          legL: legLRef.current,
          shinL: shinLRef.current,
          headWrap: headWrapRef.current,
          headLayers: {
            neutral: neutralRef.current,
            smile: smileRef.current,
            look_l: lookLRef.current,
            look_r: lookRRef.current,
            blink: blinkRef.current,
            enthusiastic: enthusiasticRef.current,
            look_spot: lookSpotRef.current,
          },
          torso: torsoRef.current,
          armLUpper: armLUpperRef.current,
          armLFore: armLForeRef.current,
          armLNormalHand: armLNormalHandRef.current,
          armLPointHand: armLPointHandRef.current,
          armRUpper: armRUpperRef.current,
          armRFore: armRForeRef.current,
          armRNormalHand: armRNormalHandRef.current,
          armRTakeLHand: armRTakeLHandRef.current,
        };
        const liveTilt = dragTiltRef ? dragTiltRef.current : tiltPropRef.current;
        const clock =
          stateRef.current === 'pointing'
            ? performance.now() - mountStartMs
            : performance.now();
        applyKinematicsToDom(
          refs,
          computeMascotKinematics(clock, stateRef.current, liveTilt, phaseOffsetMs)
        );
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [phaseOffsetMs, dragTiltRef]);

  return (
    <div
      className={`relative select-none pointer-events-none ${className}`}
      style={{ width: `${widthPx}px`, height: `${heightPx}px`, overflow: 'visible' }}
    >
      <div
        className="relative w-full h-full"
        style={{
          overflow: 'visible',
          transformOrigin: '50% 50%',
          transform: facing === 'left' ? 'scaleX(-1)' : undefined,
        }}
      >
        <div
          ref={rootRef}
          className="relative w-full h-full will-change-transform"
          style={{
            overflow: 'visible',
            transformOrigin: '53.88% 22.07%',
            filter: 'drop-shadow(0 3px 6px rgba(2, 6, 23, 0.56))',
          }}
        >
          <div
            ref={legRRef}
            className="absolute inset-0 will-change-transform"
            style={{ overflow: 'visible', zIndex: 1, transformOrigin: '39.18% 61.79%' }}
          >
            <img
              src="/mascot/thigh_r.png"
              alt=""
              draggable={false}
              className="absolute inset-0 w-full h-full object-fill"
            />
            <img
              ref={shinRRef}
              src="/mascot/shin_r.png"
              alt=""
              draggable={false}
              className="absolute inset-0 w-full h-full object-fill will-change-transform"
              style={{ transformOrigin: '36.33% 78.34%' }}
            />
          </div>
          <div
            ref={legLRef}
            className="absolute inset-0 will-change-transform"
            style={{ overflow: 'visible', zIndex: 2, transformOrigin: '64.49% 61.79%' }}
          >
            <img
              src="/mascot/thigh_l.png"
              alt=""
              draggable={false}
              className="absolute inset-0 w-full h-full object-fill"
            />
            <img
              ref={shinLRef}
              src="/mascot/shin_l.png"
              alt=""
              draggable={false}
              className="absolute inset-0 w-full h-full object-fill will-change-transform"
              style={{ transformOrigin: '66.12% 78.34%' }}
            />
          </div>

          <div
            ref={headWrapRef}
            className="absolute inset-0 will-change-transform"
            style={{ overflow: 'visible', zIndex: 3, transformOrigin: '53.88% 30.62%' }}
          >
            <img ref={neutralRef} src={HEAD_EXPRESSION_SRCS.neutral} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 1 }} />
            <img ref={smileRef} src={HEAD_EXPRESSION_SRCS.smile} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 0 }} />
            <img ref={lookLRef} src={HEAD_EXPRESSION_SRCS.look_l} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 0 }} />
            <img ref={lookRRef} src={HEAD_EXPRESSION_SRCS.look_r} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 0 }} />
            <img ref={blinkRef} src={HEAD_EXPRESSION_SRCS.blink} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 0 }} />
            <img ref={enthusiasticRef} src={HEAD_EXPRESSION_SRCS.enthusiastic} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 0 }} />
            <img ref={lookSpotRef} src={HEAD_EXPRESSION_SRCS.look_spot} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 0 }} />
          </div>

          <img
            ref={torsoRef}
            src="/mascot/torso.png"
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full object-fill will-change-transform"
            style={{ zIndex: 4 }}
          />

          <div
            ref={armLUpperRef}
            className="absolute inset-0 will-change-transform"
            style={{ overflow: 'visible', zIndex: 5, transformOrigin: '77.96% 35.59%' }}
          >
            <img src="/mascot/upper_arm_l.png" alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" />
            <div
              ref={armLForeRef}
              className="absolute inset-0 will-change-transform"
              style={{ overflow: 'visible', transformOrigin: '85.10% 49.10%' }}
            >
              <img ref={armLNormalHandRef} src="/mascot/forearm_l.png" alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 1 }} />
              <img ref={armLPointHandRef} src="/mascot/forearm_point_l.png" alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 0 }} />
            </div>
          </div>

          <div
            ref={armRUpperRef}
            className="absolute inset-0 will-change-transform"
            style={{ overflow: 'visible', zIndex: 6, transformOrigin: '20.41% 35.03%' }}
          >
            <img src="/mascot/upper_arm_r.png" alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" />
            <div
              ref={armRForeRef}
              className="absolute inset-0 will-change-transform"
              style={{ overflow: 'visible', transformOrigin: '11.84% 49.10%' }}
            >
              <img ref={armRNormalHandRef} src="/mascot/forearm_r.png" alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 1 }} />
              <img ref={armRTakeLHandRef} src="/mascot/forearm_take_l_r.png" alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" style={{ opacity: 0 }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
