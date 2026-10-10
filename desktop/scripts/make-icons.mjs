// Render public/logo.svg into the app icons: a 512 px PNG (window/Linux) and a
// multi-size .ico (Windows installer, shortcuts, executable). ICO entries hold
// PNG data directly, which every supported Windows version reads.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const svg = await readFile(path.join(here, '..', '..', 'public', 'logo.svg'));
const out = path.join(here, '..', 'assets');
await mkdir(out, { recursive: true });

const render = (size) =>
  sharp(svg, { density: 384 })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 10, g: 10, b: 15, alpha: 1 },
    })
    .png()
    .toBuffer();

await writeFile(path.join(out, 'icon.png'), await render(512));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(render));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
const directory = Buffer.alloc(16 * images.length);
let offset = header.length + directory.length;
images.forEach((png, index) => {
  const size = sizes[index];
  const entry = index * 16;
  directory.writeUInt8(size === 256 ? 0 : size, entry);
  directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
  directory.writeUInt16LE(1, entry + 4); // color planes
  directory.writeUInt16LE(32, entry + 6); // bits per pixel
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await writeFile(
  path.join(out, 'icon.ico'),
  Buffer.concat([header, directory, ...images]),
);
console.log(`icons written to ${path.relative(process.cwd(), out)}`);
