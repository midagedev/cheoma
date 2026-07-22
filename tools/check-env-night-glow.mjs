import assert from 'node:assert/strict';
import * as THREE from '../app/node_modules/three/build/three.module.js';
import { setupNightGlow } from '../src/env/night-glow.js';

function makeBuilding(label, glow) {
  const root = new THREE.Group();
  root.name = label;

  const map = new THREE.Texture();
  map.name = `${label}-map`;
  const originalEmissiveMap = new THREE.Texture();
  originalEmissiveMap.name = `${label}-original-emissive-map`;

  const tagged = new THREE.MeshStandardMaterial({
    color: 0xf2ead5,
    emissive: 0x123456,
    emissiveIntensity: 0.37,
    map,
    emissiveMap: originalEmissiveMap,
  });
  tagged.name = `${label}-hanji`;
  tagged.userData.hanjiGlow = glow;

  const untagged = new THREE.MeshStandardMaterial({
    color: 0x5a3b25,
    emissive: 0x221100,
    emissiveIntensity: 0.19,
  });
  untagged.name = `${label}-wood`;

  const geometry = new THREE.PlaneGeometry(1, 1);
  root.add(
    new THREE.Mesh(geometry, tagged),
    new THREE.Mesh(geometry, untagged),
  );

  const original = {
    emissive: tagged.emissive.getHex(),
    intensity: tagged.emissiveIntensity,
    emissiveMap: tagged.emissiveMap,
    untaggedEmissive: untagged.emissive.getHex(),
    untaggedIntensity: untagged.emissiveIntensity,
  };

  return { root, geometry, map, originalEmissiveMap, tagged, untagged, original };
}

function objectIds(root) {
  const ids = [];
  root.traverse((object) => ids.push(object.uuid));
  return ids;
}

function pointLightCount(root) {
  let count = 0;
  root.traverse((object) => { if (object.isPointLight) count += 1; });
  return count;
}

function assertOriginal(fixture, label) {
  assert.equal(fixture.tagged.emissive.getHex(), fixture.original.emissive, `${label}: emissive color was not restored`);
  assert.equal(fixture.tagged.emissiveIntensity, fixture.original.intensity, `${label}: emissive intensity was not restored`);
  assert.equal(fixture.tagged.emissiveMap, fixture.original.emissiveMap, `${label}: emissive map was not restored`);
  assert.equal(fixture.untagged.emissive.getHex(), fixture.original.untaggedEmissive, `${label}: untagged color changed`);
  assert.equal(fixture.untagged.emissiveIntensity, fixture.original.untaggedIntensity, `${label}: untagged intensity changed`);
}

function assertNoSceneObjects(fixture, ids, label) {
  assert.deepEqual(objectIds(fixture.root), ids, `${label}: night glow changed the building Object3D graph`);
  assert.equal(pointLightCount(fixture.root), 0, `${label}: night glow attached a PointLight`);
}

const first = makeBuilding('first', 0.26);
const second = makeBuilding('second', 0.18);
const firstIds = objectIds(first.root);
const secondIds = objectIds(second.root);
let building = first.root;

const glow = setupNightGlow({ getBuilding: () => building });
assert.deepEqual(Object.keys(glow).sort(), ['dispose', 'onBuildingChanged', 'setEnabled', 'setTime', 'update'], 'public API changed');
assertNoSceneObjects(first, firstIds, 'setup');

glow.setEnabled(true);
glow.setTime('night');
assert.equal(first.tagged.emissive.getHex(), 0xffb35c, 'night did not apply the warm hanji emissive');
assert.equal(first.tagged.emissiveMap, first.map, 'night did not constrain emissive to the visible hanji map');
assert.ok(first.tagged.emissiveIntensity > 0, 'night left the tagged hanji dark');
assertNoSceneObjects(first, firstIds, 'night activation');

glow.update(0.25);
const flickered = first.tagged.emissiveIntensity;
assert.ok(flickered > 0, 'flicker extinguished the active hanji material');

glow.setTime('day');
assert.equal(first.tagged.emissive.getHex(), 0xffb35c, 'day transition skipped the existing crossfade');
assert.ok(first.tagged.emissiveIntensity > 0, 'day transition cut the emissive before its crossfade');
for (let i = 0; i < 300; i += 1) glow.update(1 / 60);
assertOriginal(first, 'day crossfade');
assertNoSceneObjects(first, firstIds, 'day crossfade');

glow.setTime('night');
glow.update(1);
assert.equal(first.tagged.emissive.getHex(), 0xffb35c, 'night re-entry did not repatch the hanji material');

building = second.root;
glow.onBuildingChanged();
assertOriginal(first, 'rebuild old building');
assert.equal(second.tagged.emissive.getHex(), 0xffb35c, 'rebuild did not patch the replacement building');
assert.equal(second.tagged.emissiveMap, second.map, 'rebuild lost the replacement hanji map');
assert.ok(second.tagged.emissiveIntensity > 0, 'rebuild left the replacement hanji dark');
assertNoSceneObjects(first, firstIds, 'rebuild old building');
assertNoSceneObjects(second, secondIds, 'rebuild replacement building');

glow.dispose();
assertOriginal(second, 'dispose replacement building');
assertNoSceneObjects(second, secondIds, 'dispose replacement building');

glow.setTime('night');
glow.setEnabled(true);
glow.onBuildingChanged();
glow.update(1);
assertOriginal(second, 'disposed API');
assertNoSceneObjects(second, secondIds, 'disposed API');

for (const fixture of [first, second]) {
  fixture.geometry.dispose();
  fixture.tagged.dispose();
  fixture.untagged.dispose();
  fixture.map.dispose();
  fixture.originalEmissiveMap.dispose();
}

console.log('env night glow: emissive-only activation, crossfade, rebuild, and restore OK');
