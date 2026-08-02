/**
 * Keeping `TransformControls` and `OrbitControls` out of each other's way
 * (#25, step-8.1).
 *
 * Both listen on the same canvas, so without this a drag on a gizmo arrow
 * spins the camera at the same time: the pointer delta is consumed twice, the
 * object appears to shoot away from the handle, and the arrangement the user
 * ends up with is not the one they aimed for.
 *
 * Its own module, and exported rather than inlined into the viewport's effect,
 * because this is one of the three behaviours #25 has to prove and there is no
 * way to prove it through a render: jsdom has no WebGL context, so the
 * viewport never reaches the point of standing either controller up. Given the
 * two real controllers, this is directly assertable.
 */

import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

/**
 * Disable `orbit` for the duration of a gizmo drag.
 *
 * @returns an unbind function for the effect's cleanup. It also re-enables
 * orbit, so tearing the gizmo down mid-drag cannot leave the camera frozen.
 */
export function linkGizmoToOrbit(
  gizmo: Pick<TransformControls, 'addEventListener' | 'removeEventListener'>,
  orbit: { enabled: boolean },
): () => void {
  const onDraggingChanged = (event: { value: unknown }) => {
    orbit.enabled = !event.value;
  };
  gizmo.addEventListener('dragging-changed', onDraggingChanged);
  return () => {
    gizmo.removeEventListener('dragging-changed', onDraggingChanged);
    orbit.enabled = true;
  };
}
