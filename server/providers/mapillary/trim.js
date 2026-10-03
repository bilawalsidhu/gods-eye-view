import { PbfReader, PbfWriter } from 'pbf';

/** Field number of `layers` in a Mapbox Vector Tile, and of `name` in a layer. */
const TILE_LAYER_FIELD = 3;
const LAYER_NAME_FIELD = 1;

/** Read a layer's name without touching its features. */
function layerName(layerBytes) {
  const pbf = new PbfReader(layerBytes);
  let name = '';
  pbf.readFields((tag, _result, reader) => {
    if (tag !== LAYER_NAME_FIELD) return;
    name = reader.readString();
    reader.pos = reader.length; // the name is all we need
  }, null);
  return name;
}

/**
 * Drop whole layers from a vector tile at the protobuf level. Nothing inside
 * a kept layer is decoded or re-encoded, so a 12 MB tile whose bulk is an
 * unused layer trims in a few milliseconds. Returns the input when nothing
 * was dropped.
 * @param {Buffer|Uint8Array} bytes
 * @param {Iterable<string>} dropNames
 */
export function stripTileLayers(bytes, dropNames) {
  const drop = new Set(dropNames || []);
  if (!bytes?.length || !drop.size) return bytes;
  const reader = new PbfReader(bytes);
  const writer = new PbfWriter();
  let dropped = false;
  reader.readFields((tag, _result, pbf) => {
    if (tag !== TILE_LAYER_FIELD) return; // pbf skips what we leave alone
    const end = pbf.readVarint() + pbf.pos;
    const layerBytes = bytes.subarray(pbf.pos, end);
    pbf.pos = end;
    if (drop.has(layerName(layerBytes))) {
      dropped = true;
      return;
    }
    writer.writeBytesField(TILE_LAYER_FIELD, layerBytes);
  }, null);
  return dropped ? Buffer.from(writer.finish()) : bytes;
}

/** Names of the layers inside a vector tile, in order. */
export function listTileLayers(bytes) {
  const names = [];
  if (!bytes?.length) return names;
  new PbfReader(bytes).readFields((tag, _result, pbf) => {
    if (tag !== TILE_LAYER_FIELD) return;
    const end = pbf.readVarint() + pbf.pos;
    names.push(layerName(bytes.subarray(pbf.pos, end)));
    pbf.pos = end;
  }, null);
  return names;
}
