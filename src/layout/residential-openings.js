// Renderer-free residential opening policy. Local +z is south/front, matching
// the village and footprint contracts. This module plans habitable doors and
// windows only: the kitchen hearth remains a separate service opening.
//
// Width multipliers and count limits are product-safe bay constraints, not
// claims about historical frequency or a universal Joseon house distribution.

import {
  giwaFootprintMetrics,
  giwaFootprintPoints,
} from './giwa-footprint.js';
import { normalizeChogaShape } from './choga-shape.js';
import { planGiwaKitchenOpening } from './kitchen-opening-spatial.js';

export const RESIDENTIAL_OPENING_PARAM_KEYS = Object.freeze([
  'doorCount',
  'windowCount',
  'doorWidthK',
  'windowWidthK',
]);

export const RESIDENTIAL_OPENING_DEFAULTS = deepFreeze({
  choga: {
    doorCount: 1,
    windowCount: 3,
    doorWidthK: 0.4,
    windowWidthK: 0.24,
  },
  giwa: {
    doorCount: 2,
    windowCount: 3,
    doorWidthK: 0.9,
    windowWidthK: 0.5,
  },
});

const WIDTH_CAPABILITIES = deepFreeze({
  choga: {
    doorWidthK: { min: 0.32, max: 0.72, step: 0.01 },
    windowWidthK: { min: 0.18, max: 0.62, step: 0.01 },
  },
  giwa: {
    doorWidthK: { min: 0.6, max: 0.94, step: 0.01 },
    windowWidthK: { min: 0.3, max: 0.78, step: 0.01 },
  },
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function residentialKind(kind) {
  if (kind !== 'choga' && kind !== 'giwa') {
    throw new TypeError(`unsupported residential opening kind: ${String(kind)}`);
  }
  return kind;
}

function cleanZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

function bayWidths(count, center, middle, end) {
  const widths = [];
  for (let index = 0; index < count; index++) {
    const fromCenter = Math.abs(index - (count - 1) / 2);
    if (fromCenter < 0.6) widths.push(center);
    else if (index === 0 || index === count - 1) widths.push(end);
    else widths.push(middle);
  }
  return widths;
}

function edgeBaySlots({
  style,
  openingKind,
  facade,
  surface,
  edgeIndex,
  a,
  b,
  widths,
  clearance,
  primaryEligible = false,
}) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  const tangent = { x: cleanZero(dx / length), z: cleanZero(dz / length) };
  // Footprints are clockwise, so the left-hand normal points outside.
  const outward = { x: cleanZero(-tangent.z), z: tangent.x };
  const slots = [];
  let along = 0;
  for (let bayIndex = 0; bayIndex < widths.length; bayIndex++) {
    const bayWidth = widths[bayIndex];
    const centerAlong = along + bayWidth / 2;
    const center = {
      x: cleanZero(a.x + tangent.x * centerAlong),
      z: cleanZero(a.z + tangent.z * centerAlong),
    };
    slots.push({
      id: `${style}:${openingKind}:${facade}:e${edgeIndex}:b${bayIndex}`,
      openingKind,
      facade,
      surface,
      edgeIndex,
      bayIndex,
      bayCount: widths.length,
      center,
      tangent: { ...tangent },
      outward: { ...outward },
      bayWidth,
      availableWidth: Math.max(0.5, bayWidth - clearance),
      edgeCenterOffset: centerAlong - length / 2,
      primaryEligible,
    });
    along += bayWidth;
  }
  return slots;
}

function chogaSlots(building) {
  const shape = normalizeChogaShape(building);
  const { frontBays, sideBays } = shape;
  const frontWidths = bayWidths(
    frontBays,
    shape.centerBayW,
    shape.middleBayW,
    shape.endBayW,
  );
  const sideWidths = bayWidths(
    sideBays,
    shape.centerBayD,
    shape.centerBayD,
    shape.endBayD,
  );
  const width = frontWidths.reduce((sum, value) => sum + value, 0);
  const depth = sideWidths.reduce((sum, value) => sum + value, 0);
  const west = -width / 2;
  const east = width / 2;
  const north = -depth / 2;
  const south = depth / 2;
  const clearance = Math.max(
    0.24,
    shape.columnRadius * 2.2,
  );

  const front = edgeBaySlots({
    style: 'choga', openingKind: 'window', facade: 'front', surface: 'plaster',
    edgeIndex: 0, a: { x: west, z: south }, b: { x: east, z: south },
    widths: frontWidths, clearance,
  });
  const eastSide = edgeBaySlots({
    style: 'choga', openingKind: 'window', facade: 'side-east', surface: 'plaster',
    edgeIndex: 1, a: { x: east, z: south }, b: { x: east, z: north },
    widths: [...sideWidths].reverse(), clearance,
  });
  const rear = edgeBaySlots({
    style: 'choga', openingKind: 'window', facade: 'rear', surface: 'plaster',
    edgeIndex: 2, a: { x: east, z: north }, b: { x: west, z: north },
    widths: [...frontWidths].reverse(), clearance,
  });
  const westSide = edgeBaySlots({
    style: 'choga', openingKind: 'window', facade: 'side-west', surface: 'plaster',
    edgeIndex: 3, a: { x: west, z: north }, b: { x: west, z: south },
    widths: sideWidths, clearance,
  });

  const primaryIndex = Math.floor(front.length / 2);
  const primary = {
    ...front[primaryIndex],
    id: `choga:door:front:e0:b${primaryIndex}`,
    openingKind: 'door',
    primaryEligible: true,
  };
  // A second household door may use the west wall. The east-side center remains
  // reserved for the independent kitchen/service opening owned by #11.
  const secondarySource = westSide[westSide.length - 1];
  const secondary = {
    ...secondarySource,
    id: `choga:door:side-west:e3:b${secondarySource.bayIndex}`,
    openingKind: 'door',
    primaryEligible: false,
  };
  const serviceSlot = eastSide.reduce((best, slot) => (
    Math.abs(slot.center.z + 0.25) < Math.abs(best.center.z + 0.25) ? slot : best
  ), eastSide[0]);
  const windows = [
    ...front.filter((_, index) => index !== primaryIndex),
    ...rear,
    ...westSide.filter((slot) => slot.id !== secondarySource.id),
    ...eastSide.filter((slot) => slot.id !== serviceSlot.id),
  ];
  return { doors: [primary, secondary], windows };
}

function near(a, b) {
  return Math.abs(a - b) < 1e-7;
}

function giwaEdgeSurface(a, b, { planShape, a: halfWidth, b: halfDepth, w, c }) {
  const horizontal = near(a.z, b.z);
  const vertical = near(a.x, b.x);
  if (horizontal && near(a.z, -halfDepth)) return 'plank';
  if (horizontal && near(a.z, halfDepth)) return 'courtyard';
  if (planShape !== 'single' && vertical
    && Math.min(a.z, b.z) >= halfDepth - 1e-7
    && Math.max(a.z, b.z) <= halfDepth + c + 1e-7
    && (near(a.x, halfWidth - w) || near(a.x, -halfWidth + w))) {
    return 'courtyard';
  }
  return 'plaster';
}

function facadeFor(outward, surface, mainFront) {
  if (mainFront) return 'front';
  if (surface === 'courtyard') return 'courtyard';
  if (outward.z > 0.5) return 'front';
  if (outward.z < -0.5) return 'rear';
  return outward.x > 0 ? 'side-east' : 'side-west';
}

function spansOverlap(a, b) {
  return a.min < b.max && b.min < a.max;
}

function giwaSlots(building) {
  const footprint = giwaFootprintMetrics(building);
  const points = giwaFootprintPoints(building);
  const bay = footprint.bay;
  const clearance = Math.max(0.2, footprint.columnRadius * 1.8);
  const doors = [];
  const windows = [];

  for (let edgeIndex = 0; edgeIndex < points.length; edgeIndex++) {
    const a = points[edgeIndex];
    const b = points[(edgeIndex + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const count = Math.max(1, Math.round(length / bay));
    const widths = new Array(count).fill(length / count);
    const surface = giwaEdgeSurface(a, b, footprint);
    const mainFront = surface === 'courtyard' && near(a.z, footprint.b) && near(b.z, footprint.b);
    const provisional = edgeBaySlots({
      style: 'giwa',
      openingKind: surface === 'courtyard' ? 'door' : 'window',
      facade: 'pending',
      surface,
      edgeIndex,
      a,
      b,
      widths,
      clearance,
      primaryEligible: mainFront,
    });
    const facade = facadeFor(provisional[0].outward, surface, mainFront);
    const slots = provisional.map((slot) => ({
      ...slot,
      id: `giwa:${slot.openingKind}:${facade}:e${edgeIndex}:b${slot.bayIndex}`,
      facade,
    }));
    if (surface === 'courtyard') {
      // The main-front center is the open daecheong only when the range has the
      // same three-bay minimum used by the production builder.
      const daecheong = mainFront && slots.length >= 3 ? Math.floor(slots.length / 2) : -1;
      doors.push(...slots.filter((_, index) => index !== daecheong));
    } else {
      windows.push(...slots);
    }
  }

  // The same renderer-free span feeds buildGiwa below. Reserve every east-wall
  // slot whose maximum legal window width would touch the kitchen frame.
  const kitchen = planGiwaKitchenOpening(footprint.a);
  const maxWindowK = WIDTH_CAPABILITIES.giwa.windowWidthK.max;
  return {
    doors,
    windows: windows.filter((slot) => {
      if (slot.facade !== 'side-east') return true;
      const halfWidth = slot.availableWidth * maxWindowK / 2;
      return !spansOverlap(
        { min: slot.center.z - halfWidth, max: slot.center.z + halfWidth },
        kitchen.spanZ,
      );
    }),
  };
}

function rawSlots(kind, building) {
  return kind === 'choga' ? chogaSlots(building) : giwaSlots(building);
}

function normalizedSeed(seed) {
  return Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
}

function seededRank(seed, id) {
  let value = normalizedSeed(seed) ^ 0x9e3779b9;
  for (let index = 0; index < id.length; index++) {
    value ^= id.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function seededOrder(slots, seed) {
  return [...slots].sort((a, b) => (
    seededRank(seed, a.id) - seededRank(seed, b.id) || compareIds(a, b)
  ));
}

function compareIds(a, b) {
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

function orderedDoorSlots(slots, seed) {
  const eligible = slots.filter((slot) => slot.primaryEligible);
  const pool = eligible.length ? eligible : slots;
  const primary = [...pool].sort((a, b) => (
    Math.abs(a.edgeCenterOffset) - Math.abs(b.edgeCenterOffset)
    || seededRank(seed, a.id) - seededRank(seed, b.id)
    || compareIds(a, b)
  ))[0];
  return [primary, ...seededOrder(slots.filter((slot) => slot.id !== primary.id), seed)];
}

function frozenSlots(style, source) {
  const slots = rawSlots(style, source);
  if (!slots.doors.length || !slots.windows.length) {
    throw new RangeError(`${style} shape has no usable residential opening slots`);
  }
  return deepFreeze({
    kind: style,
    doors: slots.doors,
    windows: slots.windows,
  });
}

export function residentialOpeningSlots(kind, building = {}) {
  const style = residentialKind(kind);
  const source = building && typeof building === 'object' ? building : {};
  return frozenSlots(style, source);
}

function countCapability(max, fallback) {
  return {
    min: 1,
    max,
    step: 1,
    default: Math.max(1, Math.min(max, fallback)),
  };
}

function capabilitiesFor(style, slots) {
  const defaults = RESIDENTIAL_OPENING_DEFAULTS[style];
  return deepFreeze({
    kind: style,
    doorCount: countCapability(slots.doors.length, defaults.doorCount),
    windowCount: countCapability(slots.windows.length, defaults.windowCount),
    doorWidthK: { ...WIDTH_CAPABILITIES[style].doorWidthK, default: defaults.doorWidthK },
    windowWidthK: { ...WIDTH_CAPABILITIES[style].windowWidthK, default: defaults.windowWidthK },
  });
}

export function residentialOpeningCapabilities(kind, building = {}) {
  const style = residentialKind(kind);
  const source = building && typeof building === 'object' ? building : {};
  return capabilitiesFor(style, frozenSlots(style, source));
}

function normalizedField(value, capability, integer = false) {
  const candidate = Number.isFinite(value) ? value : capability.default;
  const normalized = integer ? Math.round(candidate) : candidate;
  return Math.max(capability.min, Math.min(capability.max, normalized));
}

function normalizeWithCapabilities(source, capabilities) {
  return deepFreeze({
    doorCount: normalizedField(source.doorCount, capabilities.doorCount, true),
    windowCount: normalizedField(source.windowCount, capabilities.windowCount, true),
    doorWidthK: normalizedField(source.doorWidthK, capabilities.doorWidthK),
    windowWidthK: normalizedField(source.windowWidthK, capabilities.windowWidthK),
  });
}

export function normalizeResidentialOpenings(kind, building = {}) {
  const style = residentialKind(kind);
  const source = building && typeof building === 'object' ? building : {};
  return normalizeWithCapabilities(source, capabilitiesFor(style, frozenSlots(style, source)));
}

function plannedOpening(slot, style, widthK, primary) {
  return {
    id: slot.id,
    kind: slot.openingKind,
    style,
    facade: slot.facade,
    surface: slot.surface,
    edgeIndex: slot.edgeIndex,
    bayIndex: slot.bayIndex,
    bayCount: slot.bayCount,
    center: { ...slot.center },
    tangent: { ...slot.tangent },
    outward: { ...slot.outward },
    availableWidth: slot.availableWidth,
    widthK,
    width: slot.availableWidth * widthK,
    verticalBand: slot.openingKind === 'door' ? 'floor-to-lintel' : 'sill-to-lintel',
    primary,
  };
}

export function planResidentialOpenings(kind, building = {}, seed = building?.seed) {
  const style = residentialKind(kind);
  const source = building && typeof building === 'object' ? building : {};
  const stableSeed = normalizedSeed(seed);
  const slots = frozenSlots(style, source);
  const capabilities = capabilitiesFor(style, slots);
  const params = normalizeWithCapabilities(source, capabilities);
  const doorSlots = orderedDoorSlots(slots.doors, stableSeed).slice(0, params.doorCount);
  const windowSlots = seededOrder(slots.windows, stableSeed).slice(0, params.windowCount);
  const openings = [
    ...doorSlots.map((slot, index) => plannedOpening(slot, style, params.doorWidthK, index === 0)),
    ...windowSlots.map((slot) => plannedOpening(slot, style, params.windowWidthK, false)),
  ];
  return deepFreeze({
    kind: style,
    seed: stableSeed,
    params,
    capabilities,
    slots,
    openings,
  });
}
