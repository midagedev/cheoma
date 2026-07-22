import { OPENING_FACE_CLEARANCE } from '../core/surface-clearance.js';

// Renderer-free changho detail grammar. Coordinates are local to one opening:
// +u runs along the facade, +y is up from the opening sill, and +outward points
// out of the building. Builders provide only that basis; interaction and props
// can later consume the same pivot/entrance anchors without importing Three.

export const OPENING_DETAIL_KINDS = Object.freeze(['door', 'window']);
export const OPENING_DETAIL_STYLES = Object.freeze(['palace', 'temple', 'giwa', 'choga']);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function seedHash(value) {
  const text = String(value ?? 0);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableSeedText(value, stack = new Set()) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return `string:${value}`;
  if (type === 'number') return `number:${Number.isFinite(value) ? value : String(value)}`;
  if (type === 'bigint') return `bigint:${value.toString()}`;
  if (type === 'boolean') return `boolean:${value}`;
  if (type === 'undefined') return 'undefined';
  if (type !== 'object') return `${type}:${String(value)}`;
  if (stack.has(value)) return '[circular]';
  stack.add(value);
  const text = Array.isArray(value)
    ? `[${value.map((child) => stableSeedText(child, stack)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => (
      `${stableSeedText(key, stack)}:${stableSeedText(value[key], stack)}`
    )).join(',')}}`;
  stack.delete(value);
  return text;
}

function normalizeSeed(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return `seed-${seedHash(stableSeedText(value)).toString(16)}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function defaultLeafCount(kind, width) {
  if (kind === 'window') return width >= 0.95 ? 2 : 1;
  if (width > 3.2) return 4;
  if (width > 1.9) return 3;
  return width > 1.05 ? 2 : 1;
}

function box(kind, u, y, width, height, depth, outward) {
  return { kind, shape: 'box', u, y, width, height, depth, outward };
}

/**
 * Return an immutable, JSON-safe opening specification. `footwear` is an
 * authored landing point relative to the opening sill; this pass records it
 * but deliberately does not render footwear or own interaction state.
 */
export function planOpeningDetail(input = {}) {
  const kind = input.kind || 'window';
  const style = input.style || 'giwa';
  if (!OPENING_DETAIL_KINDS.includes(kind)) throw new Error(`Unknown opening kind: ${kind}`);
  if (!OPENING_DETAIL_STYLES.includes(style)) throw new Error(`Unknown opening style: ${style}`);

  const width = clamp(finite(input.width, kind === 'door' ? 1.0 : 0.6), 0.36, 6.4);
  const height = clamp(finite(input.height, kind === 'door' ? 1.8 : 0.6), 0.32, 4.8);
  const wallThickness = clamp(finite(input.wallThickness, 0.12), 0.04, 0.4);
  const leafCount = clamp(
    Math.round(finite(input.leafCount, defaultLeafCount(kind, width))),
    1,
    kind === 'door' ? 4 : 2,
  );
  const primary = kind === 'door' && input.primary === true;
  const seed = normalizeSeed(input.seed);
  if (kind === 'door' && input.meoreumHeight != null) {
    throw new Error('meoreumHeight belongs to a window; use lowerPanelHeight for a door leaf');
  }
  if (kind === 'window' && input.lowerPanelHeight != null) {
    throw new Error('lowerPanelHeight belongs to a door leaf; use meoreumHeight for a window');
  }
  const defaultMeoreum = { palace: 0.28, temple: 0.24, giwa: 0.22, choga: 0.12 }[style];
  const meoreumHeight = kind === 'window'
    ? clamp(finite(input.meoreumHeight, defaultMeoreum), 0, Math.min(1.2, height * 1.2))
    : 0;
  const lowerPanelHeight = kind === 'door'
    ? clamp(
      finite(input.lowerPanelHeight, style === 'choga' ? height * 0.12 : height * 0.2),
      0,
      height * 0.38,
    )
    : 0;

  const frameWidth = clamp(Math.min(width, height) * 0.055, 0.045, 0.085);
  const frameDepth = style === 'choga' ? 0.035 : 0.045;
  const face = wallThickness * 0.5 + OPENING_FACE_CLEARANCE;
  const frameOutward = face + frameDepth * 0.5;
  const leafBottom = frameWidth;
  const leafTop = height - frameWidth;
  const leafHeight = Math.max(frameWidth, leafTop - leafBottom);
  const assemblyBottom = kind === 'window' ? -meoreumHeight : 0;
  const assemblyHeight = height - assemblyBottom;

  const frameParts = [
    box('jamb-left', -width * 0.5 + frameWidth * 0.5, assemblyBottom + assemblyHeight * 0.5,
      frameWidth, assemblyHeight, frameDepth, frameOutward),
    box('jamb-right', width * 0.5 - frameWidth * 0.5, assemblyBottom + assemblyHeight * 0.5,
      frameWidth, assemblyHeight, frameDepth, frameOutward),
    box('head', 0, height - frameWidth * 0.5,
      width, frameWidth, frameDepth, frameOutward),
  ];
  if (kind === 'window') {
    if (meoreumHeight > frameWidth * 0.5) {
      const apronHeight = meoreumHeight - frameWidth * 0.5;
      frameParts.push(box(
        'meoreum-apron', 0, -(meoreumHeight + frameWidth * 0.5) * 0.5,
        Math.max(frameWidth, width - frameWidth * 2), apronHeight,
        frameDepth * 0.72, frameOutward - frameDepth * 0.08,
      ));
      frameParts.push(box('meoreum-rail', 0, 0,
        width, frameWidth, frameDepth, frameOutward));
    } else {
      frameParts.push(box('sill', 0, frameWidth * 0.5,
        width, frameWidth, frameDepth, frameOutward));
    }
  } else if (lowerPanelHeight > frameWidth * 0.5) {
    frameParts.push(box('lower-panel-rail', 0, lowerPanelHeight,
      width, frameWidth, frameDepth, frameOutward));
  }
  for (let leaf = 1; leaf < leafCount; leaf++) {
    frameParts.push(box(
      'leaf-seam',
      -width * 0.5 + width * leaf / leafCount,
      leafBottom + leafHeight * 0.5,
      frameWidth * 0.58,
      leafHeight,
      frameDepth * 0.72,
      frameOutward + frameDepth * 0.14,
    ));
  }

  const thresholdDepth = kind === 'door' ? (style === 'choga' ? 0.16 : 0.2) : 0;
  const threshold = kind === 'door' ? box(
    'threshold', 0, frameWidth * 0.42,
    width + frameWidth * 0.8, frameWidth * 0.84, thresholdDepth,
    face + thresholdDepth * 0.5,
  ) : null;

  const hardware = [];
  const hash = seedHash(`${seed}|${style}|${kind}|${width.toFixed(3)}|${height.toFixed(3)}`);
  const hingeSide = (hash & 1) === 0 ? -1 : 1;
  let pivot = null;
  let footwearAnchor = null;
  if (primary) {
    const leafWidth = width / leafCount;
    const pivotU = hingeSide * (width * 0.5 - frameWidth * 0.55);
    const strapLength = clamp(leafWidth * 0.27, 0.11, style === 'palace' ? 0.25 : 0.18);
    const strapU = hingeSide * (width * 0.5 - frameWidth - strapLength * 0.5);
    const hardwareDepth = 0.018;
    const hardwareOutward = face + frameDepth + hardwareDepth * 0.5 + 0.004;
    for (const ratio of [0.25, 0.76]) {
      hardware.push(box(
        'hinge-strap', strapU, leafBottom + leafHeight * ratio,
        strapLength, 0.035, hardwareDepth, hardwareOutward,
      ));
    }
    // The measured source is a palace door. Civilian and temple styles keep a
    // quieter product-level subset (two small straps + one ring) rather than
    // inheriting the visible palace pivot-cap vocabulary as if it were evidence.
    if (style === 'palace') {
      for (const ratio of [0.08, 0.92]) {
        hardware.push({
          kind: 'pivot-cap',
          shape: 'cylinder',
          u: pivotU,
          y: leafBottom + leafHeight * ratio,
          radius: 0.025,
          depth: 0.036,
          outward: hardwareOutward,
        });
      }
    }
    const meetingU = hingeSide < 0
      ? -width * 0.5 + leafWidth
      : width * 0.5 - leafWidth;
    hardware.push({
      kind: 'ring-handle',
      shape: 'torus',
      u: meetingU + hingeSide * 0.08,
      y: leafBottom + leafHeight * 0.54,
      radius: clamp(leafWidth * 0.09, 0.045, 0.075),
      tube: 0.009,
      outward: hardwareOutward + 0.016,
    });
    pivot = {
      u: pivotU,
      y: leafBottom,
      axis: { u: 0, y: 1, outward: 0 },
      hingeSide,
      leafWidth,
      leafHeight,
      maxAngle: Math.PI * 0.52,
    };
    const footwear = input.footwear || {};
    footwearAnchor = {
      u: clamp(finite(footwear.u, 0), -width * 0.4, width * 0.4),
      y: finite(footwear.y, 0),
      outward: Math.max(
        thresholdDepth + 0.12,
        finite(footwear.outward, thresholdDepth + 0.28),
      ),
      surface: typeof footwear.surface === 'string' && footwear.surface
        ? footwear.surface
        : 'threshold',
    };
  }

  return deepFreeze({
    version: 2,
    id: `opening-${seedHash(`${seed}|${kind}|${style}`).toString(16)}`,
    seed,
    kind,
    style,
    primary,
    width,
    height,
    wallThickness,
    leafCount,
    meoreum: {
      height: meoreumHeight,
      apertureSillY: 0,
      apronBottomY: -meoreumHeight,
    },
    lowerPanel: { height: lowerPanelHeight, railY: lowerPanelHeight },
    reveal: {
      depth: wallThickness * 0.5,
      faceClearance: OPENING_FACE_CLEARANCE,
      face,
    },
    frame: { width: frameWidth, depth: frameDepth, parts: frameParts },
    threshold,
    hardware,
    anchors: { pivot, footwear: footwearAnchor },
  });
}
