/**
 * The vessel icons the layer draws, as it last drew them: the shared icon
 * book (`render/motion/iconBook.js`). The layer reads its own icons back from
 * there (focus emphasis, ownership of a pick), never from the renderer.
 */
export { createIconBook as createVesselIconBook } from '../../render/motion/iconBook.js';
