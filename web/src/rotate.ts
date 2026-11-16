// Free rotate (Dalton 2026-11-16): the angle the rotate handle's drag means. No DOM, so Node tests load it.

/** Free rotate angle (+ is counter-clockwise, like the Rotate box) from the pointer's turn about the middle,
 *  `a0` to `a1` (atan2 on the bed, whose y points down). Whole degrees; within 3° of a quarter turn it snaps
 *  to it (quarter turns keep text as text); Shift snaps to 15°. */
export function rotateAngle(a0: number, a1: number, shift: boolean): number {
  let d = (-(a1 - a0) * 180) / Math.PI; // y points down, so a growing screen angle is clockwise
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  if (shift) return Math.round(d / 15) * 15 || 0;
  const q = Math.round(d / 90) * 90;
  return Math.abs(d - q) <= 3 ? q || 0 : Math.round(d) || 0;
}
