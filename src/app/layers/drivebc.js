import { createDriveBcLayer } from '../../layers/drivebc/index.js';

/** Bind the public DriveBC snapshot source to the application layer catalog. */
export function createApplicationDriveBC(options) {
  return createDriveBcLayer(options);
}
