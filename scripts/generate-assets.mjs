import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

globalThis.FileReader = class {
  result = null;
  onloadend = null;
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((value) => { this.result = value; this.onloadend?.(); });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((value) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(value).toString('base64')}`;
      this.onloadend?.();
    });
  }
};

const root = new THREE.Group();
root.name = 'original-black-canister-auxiliary-reactor';
const steel = new THREE.MeshStandardMaterial({ color: '#172024', metalness: 0.88, roughness: 0.31 });
const brass = new THREE.MeshStandardMaterial({ color: '#a56d28', metalness: 0.91, roughness: 0.24 });
const copper = new THREE.MeshStandardMaterial({ color: '#8f3f21', metalness: 0.83, roughness: 0.3 });
const glow = new THREE.MeshStandardMaterial({ color: '#28150b', emissive: '#ff692e', emissiveIntensity: 3.4, metalness: 0.45, roughness: 0.32 });

const add = (geometry, material, position, rotation = [0, 0, 0], scale = [1, 1, 1]) => {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
};

add(new THREE.CapsuleGeometry(0.72, 1.65, 12, 32), steel, [0, 1.45, 0]);
for (const y of [0.55, 1.25, 1.95, 2.55]) add(new THREE.TorusGeometry(0.76, 0.075, 12, 42), brass, [0, y, 0], [Math.PI / 2, 0, 0]);
for (let index = 0; index < 3; index += 1) {
  const angle = (index / 3) * Math.PI * 2;
  add(new THREE.TorusKnotGeometry(0.27, 0.052, 96, 10, 2, 7), copper, [Math.cos(angle) * 0.83, 1.5, Math.sin(angle) * 0.83], [Math.PI / 2, angle, 0], [0.75, 1.4, 0.75]);
  add(new THREE.CylinderGeometry(0.065, 0.065, 1.8, 16), brass, [Math.cos(angle) * 1.1, 1.45, Math.sin(angle) * 1.1]);
}
add(new THREE.CylinderGeometry(0.5, 0.72, 0.42, 32), brass, [0, 3.0, 0]);
add(new THREE.SphereGeometry(0.42, 32, 20), glow, [0, 3.32, 0]);
for (let index = 0; index < 8; index += 1) {
  const angle = (index / 8) * Math.PI * 2;
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.74, 10), glow, [Math.cos(angle) * 0.44, 3.32, Math.sin(angle) * 0.44], [0, 0, angle]);
}
const base = add(new THREE.CylinderGeometry(1.08, 1.22, 0.34, 36), steel, [0, 0.2, 0]);
base.name = 'armored-reactor-base';
for (const x of [-0.56, 0.56]) for (const z of [-0.56, 0.56]) add(new THREE.CylinderGeometry(0.1, 0.13, 0.38, 14), brass, [x, 0, z]);

await fs.mkdir(new URL('../public/assets/', import.meta.url), { recursive: true });
const exporter = new GLTFExporter();
const gltf = await exporter.parseAsync(root, { binary: false, onlyVisible: true });
await fs.writeFile(new URL('../public/assets/black-canister-reactor.gltf', import.meta.url), JSON.stringify(gltf));
console.log('Generated public/assets/black-canister-reactor.gltf');
