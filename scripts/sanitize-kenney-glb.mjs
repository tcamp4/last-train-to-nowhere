import fs from 'node:fs/promises';

const path = new URL('../public/assets/weapons/k12-sidearm.glb', import.meta.url);
const source = await fs.readFile(path);
if (source.readUInt32LE(0) !== 0x46546c67) throw new Error('Expected a binary glTF asset.');

let offset = 12;
let json;
const binaryChunks = [];
while (offset < source.length) {
  const length = source.readUInt32LE(offset);
  const type = source.readUInt32LE(offset + 4);
  const data = source.subarray(offset + 8, offset + 8 + length);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8').trim());
  else binaryChunks.push({ type, data });
  offset += 8 + length;
}
if (!json) throw new Error('Missing glTF JSON chunk.');

// Kenney's source GLB points at a pack-level palette that is not part of the
// individual model. The game supplies its own gunmetal PBR treatment, so strip
// the dead texture reference instead of issuing a browser error on every load.
delete json.images;
delete json.textures;
delete json.samplers;
delete json.extensionsUsed;
for (const material of json.materials ?? []) {
  if (material.pbrMetallicRoughness) delete material.pbrMetallicRoughness.baseColorTexture;
}

let jsonData = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPadding = (4 - (jsonData.length % 4)) % 4;
if (jsonPadding) jsonData = Buffer.concat([jsonData, Buffer.alloc(jsonPadding, 0x20)]);
const chunks = [{ type: 0x4e4f534a, data: jsonData }, ...binaryChunks];
const totalLength = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0);
const output = Buffer.alloc(totalLength);
output.writeUInt32LE(0x46546c67, 0);
output.writeUInt32LE(2, 4);
output.writeUInt32LE(totalLength, 8);
offset = 12;
for (const chunk of chunks) {
  output.writeUInt32LE(chunk.data.length, offset);
  output.writeUInt32LE(chunk.type, offset + 4);
  chunk.data.copy(output, offset + 8);
  offset += 8 + chunk.data.length;
}
await fs.writeFile(path, output);
