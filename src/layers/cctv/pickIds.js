/**
 * Entity ids of a camera's coverage and projection geometry:
 * `cctv-<cameraId>-<role>`. The first group is the camera id.
 */
export const CCTV_HELPER_PICK_ID =
  /^cctv-(.+)-(?:ray-tl|ray-tr|ray-br|ray-bl|cap|plane|plane-label)$/;
