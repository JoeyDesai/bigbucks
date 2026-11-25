// Renders the Big Bucks mark (scripts/buckets-mark.mjs) to public/icons/mark.svg and the PNG sizes
// the manifest and iOS need.
// Usage: pnpm --filter @homebase/web icons
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bucketsMark as mark } from "./buckets-mark.mjs";

const dir = fileURLToPath(new URL("../public/icons/", import.meta.url));
const pub = fileURLToPath(new URL("../public/", import.meta.url));

await writeFile(`${dir}mark.svg`, mark());
await writeFile(`${pub}icon.svg`, mark());

const outputs = [
  { file: `${dir}icon-192.png`, size: 192, svg: mark() },
  { file: `${dir}icon-512.png`, size: 512, svg: mark() },
  { file: `${dir}maskable-512.png`, size: 512, svg: mark({ rounded: false, scale: 0.8 }) },
  { file: `${dir}maskable-192.png`, size: 192, svg: mark({ rounded: false, scale: 0.8 }) },
  { file: `${pub}apple-touch-icon.png`, size: 180, svg: mark({ rounded: false, scale: 0.92 }) },
  { file: `${dir}favicon-32.png`, size: 32, svg: mark({ scale: 1.08 }) },
];
for (const o of outputs) {
  await sharp(Buffer.from(o.svg), { density: 300 }).resize(o.size, o.size).png({ compressionLevel: 9 }).toFile(o.file);
}
console.log("icons written:", outputs.map((o) => o.file.replace(pub, "public/")).join(", "));
