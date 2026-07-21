// 카메라 드라이브·드론 패스·1인칭 보행의 공개 API.
export { setupCinematic } from '../camera/cinematic.js';
export {
  VILLAGE_LENS,
  dollyDistanceForFov,
  dollyScaleForFov,
  equivalentDistanceAtFov,
  lensScaleForCamera,
  referenceFovForCamera,
  referenceVillageFov,
  villageScreenDistance,
  villageScreenDistanceForCamera,
} from '../camera/optics.js';
export {
  createDirectionController,
  createHeadingController,
  shortestAngleDelta,
} from '../camera/heading.js';
export {
  buildObstacles,
  createDronePaths,
  mainRoad,
  roofTopAt,
} from '../cinematic/dronepath.js';
export { createWalker } from '../cinematic/walker.js';
