import * as THREE from 'three';
import { ROOF_SHELL_THICKNESS } from '../core/surface-clearance.js';
import { ROOF_STRUCTURE_LAYER } from '../builder/ceiling-plan.js';

// Physical tile shell: zero-thickness DoubleSide put the outer tile and the
// structural gaepan underside on one plane → z-fighting (esp. during assembly).
// Authored thickness is the 개판/산자 layer of the roof stack, NOT room 반자.
// See docs/ceiling.md.

/**
 * Offset a surface along its vertex normals to form the structural underside
 * (개판). Returns a new geometry (caller owns it). Winding is flipped so
 * FrontSide faces the interior / eave void.
 */
export function makeRoofUndersideGeometry(sourceGeo, thickness = ROOF_SHELL_THICKNESS) {
  const geo = sourceGeo.clone();
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    // Step toward the interior void. Face winding can leave some slopes with
    // ny < 0 (paljak side/rear); flip so we always sink below the outer tile.
    let nx = nrm.getX(i);
    let ny = nrm.getY(i);
    let nz = nrm.getZ(i);
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    pos.setXYZ(
      i,
      pos.getX(i) - nx * thickness,
      pos.getY(i) - ny * thickness,
      pos.getZ(i) - nz * thickness,
    );
  }
  const idx = geo.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      const c = idx.getX(i + 2);
      idx.setX(i + 1, c);
      idx.setX(i + 2, b);
    }
  } else {
    const swapAttr = (attr) => {
      if (!attr) return;
      const item = attr.itemSize;
      const arr = attr.array;
      for (let t = 0; t + 2 < attr.count; t += 3) {
        for (let k = 0; k < item; k++) {
          const i1 = (t + 1) * item + k;
          const i2 = (t + 2) * item + k;
          const tmp = arr[i1];
          arr[i1] = arr[i2];
          arr[i2] = tmp;
        }
      }
      attr.needsUpdate = true;
    };
    swapAttr(pos);
    swapAttr(geo.attributes.uv);
    swapAttr(nrm);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Add outer tile (FrontSide) + structural gaepan underside (FrontSide).
 * Room 반자 is a separate planned finish (docs/ceiling.md) — never this mesh.
 */
export function addRoofTileShell(group, geometry, outerMat, underMat, thickness = ROOF_SHELL_THICKNESS) {
  outerMat.side = THREE.FrontSide;
  const outer = new THREE.Mesh(geometry, outerMat);
  outer.castShadow = outer.receiveShadow = true;
  outer.name = 'roof-tile-outer';
  outer.userData.roofLayer = ROOF_STRUCTURE_LAYER.TILE;
  group.add(outer);

  const underGeo = makeRoofUndersideGeometry(geometry, thickness);
  const under = new THREE.Mesh(underGeo, underMat);
  under.castShadow = false;
  under.receiveShadow = true;
  under.name = 'roof-gaepan';
  under.userData.roofLayer = ROOF_STRUCTURE_LAYER.GAEPAN;
  under.userData.isRoomBanja = false;
  // Same assembly body chunk as the outer tile so rigid roof motion keeps them locked.
  if (outer.userData?.asmGroup) under.userData.asmGroup = outer.userData.asmGroup;
  group.add(under);
  return { outer, under };
}
