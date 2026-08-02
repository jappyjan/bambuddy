/**
 * "Dragging a gizmo must not also orbit the camera" (#25, step-8.1).
 *
 * Asserted against the two *real* controllers rather than stubs: the whole
 * failure mode is that three.js's own `TransformControls` and `OrbitControls`
 * both listen on the same canvas, so a test that invented its own event
 * source would pass while the real pair still fought. Neither controller
 * needs a WebGL context to construct — only a camera and a DOM element — so
 * jsdom is enough to hold them both.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { linkGizmoToOrbit } from '../../components/slicer/gizmoOrbit';

function controllers() {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  const element = document.createElement('div');
  document.body.appendChild(element);
  const orbit = new OrbitControls(camera, element);
  const gizmo = new TransformControls(camera, element);
  return { orbit, gizmo, element };
}

describe('linkGizmoToOrbit', () => {
  it('disables orbit for the duration of a gizmo drag', () => {
    const { orbit, gizmo } = controllers();
    linkGizmoToOrbit(gizmo, orbit);

    expect(orbit.enabled).toBe(true);

    // `dragging` is a defined property on TransformControls: assigning it is
    // exactly what the controller does internally on pointer-down, and it
    // dispatches the `dragging-changed` event as a side effect.
    gizmo.dragging = true;
    expect(orbit.enabled).toBe(false);

    gizmo.dragging = false;
    expect(orbit.enabled).toBe(true);

    gizmo.dispose();
    orbit.dispose();
  });

  it('leaves orbit alone when the gizmo is merely hovered', () => {
    const { orbit, gizmo } = controllers();
    linkGizmoToOrbit(gizmo, orbit);

    gizmo.axis = 'X';
    expect(orbit.enabled).toBe(true);

    gizmo.dispose();
    orbit.dispose();
  });

  it('stops listening, and hands orbit back, when unbound mid-drag', () => {
    // A viewport unmounted or switched to read-only while a drag is in flight
    // must not leave the camera permanently frozen.
    const { orbit, gizmo } = controllers();
    const unbind = linkGizmoToOrbit(gizmo, orbit);

    gizmo.dragging = true;
    expect(orbit.enabled).toBe(false);

    unbind();
    expect(orbit.enabled).toBe(true);

    gizmo.dragging = false;
    gizmo.dragging = true;
    expect(orbit.enabled).toBe(true);

    gizmo.dispose();
    orbit.dispose();
  });
});
