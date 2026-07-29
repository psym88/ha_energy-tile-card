import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(root, "src/energy-tile-card.js"), "utf8");
const banner = `/**
 * HA Energy Tile Card
 * https://github.com/psym88/ha_energy-tile-card
 * Generated from src/energy-tile-card.js. Do not edit directly.
 */
`;

await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/ha_energy-tile-card.js"), `${banner}\n${source}`, "utf8");

console.log("Built dist/ha_energy-tile-card.js");
