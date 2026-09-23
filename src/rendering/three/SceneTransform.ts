import type { SceneCoordinateReference } from "@haneoka/vega/renderer-kit";
import { Matrix4, Quaternion, Vector3 } from "three";
import { unityEulerDegrees, unityVector3 } from "./UnityTransform";

const basis = new Matrix4(),
  inverse = new Matrix4(),
  rotation = new Quaternion();
const position = new Vector3(),
  scale = new Vector3(1, 1, 1),
  pivot = new Vector3();

/** Compose a scene-space affine transform; no live camera or projection is involved. */
export function sceneTransformMatrix(
  values: Readonly<Record<string, number>>,
  reference: SceneCoordinateReference,
  depth: number,
  result: Matrix4,
  worldPivot?: Readonly<Vector3>,
): Matrix4 {
  unityVector3(reference.position, position);
  unityEulerDegrees(reference.rotation ?? { x: 0, y: 0, z: 0 }, rotation);
  basis.compose(position, rotation, scale);
  inverse.copy(basis).invert();
  const sx = values.scaleX ?? 1,
    sy = values.scaleY ?? 1;
  const c = Math.cos(values.rotation ?? 0),
    s = Math.sin(values.rotation ?? 0);
  const a = c * sx,
    b = -s * sy,
    d = s * sx,
    e = c * sy;
  if (worldPivot) {
    pivot.copy(worldPivot).applyMatrix4(inverse);
    result.set(
      a,
      b,
      0,
      pivot.x + (values.x ?? 0) - a * pivot.x - b * pivot.y,
      d,
      e,
      0,
      pivot.y + (values.y ?? 0) - d * pivot.x - e * pivot.y,
      0,
      0,
      1,
      values.z ?? 0,
      0,
      0,
      0,
      1,
    );
  } else {
    result.set(
      a,
      b,
      -(values.x ?? 0) / depth,
      0,
      d,
      e,
      -(values.y ?? 0) / depth,
      0,
      0,
      0,
      1,
      values.z ?? 0,
      0,
      0,
      0,
      1,
    );
  }
  return result.premultiply(basis).multiply(inverse);
}
