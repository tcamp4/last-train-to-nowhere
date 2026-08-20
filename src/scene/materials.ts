import * as THREE from 'three';

export interface TrainMaterials {
  steel: THREE.MeshStandardMaterial;
  darkSteel: THREE.MeshStandardMaterial;
  armor: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  copper: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  leather: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  lamp: THREE.MeshStandardMaterial;
  warning: THREE.MeshStandardMaterial;
  screen: THREE.MeshStandardMaterial;
  bone: THREE.MeshStandardMaterial;
  enemyHide: THREE.MeshStandardMaterial;
  parasite: THREE.MeshStandardMaterial;
  ground: THREE.MeshStandardMaterial;
  rail: THREE.MeshStandardMaterial;
  sleeper: THREE.MeshStandardMaterial;
  dispose(): void;
}

function seededNoise(size: number, seed: number, contrast = 1): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  let state = seed >>> 0;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const broad = Math.sin(x * 0.19) * 0.16 + Math.cos(y * 0.13) * 0.13;
      const scratch = random() > 0.995 ? random() * 0.34 : 0;
      const fine = (random() - 0.5) * 0.14;
      const value = THREE.MathUtils.clamp(0.5 + (fine + broad - scratch) * contrast, 0, 1) * 255;
      const i = (y * size + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return data;
}

function dataTexture(data: Uint8Array, size: number, colorSpace: THREE.ColorSpace = THREE.NoColorSpace): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createSurfaceMaps(seed: number, repeat: [number, number], tint: THREE.ColorRepresentation) {
  // 512² is the minimum authored resolution for hero train/character surfaces.
  // The maps combine broad oxidization, directional scuffs, pits, and fine grain
  // instead of magnifying a tiny generic noise tile.
  const size = 512;
  const noise = seededNoise(size, seed, 0.66);
  const color = new THREE.Color(tint);
  const albedo = new Uint8Array(noise.length);
  const roughness = new Uint8Array(noise.length);
  const normal = new Uint8Array(noise.length);
  const metalness = new Uint8Array(noise.length);
  for (let i = 0; i < noise.length; i += 4) {
    const pixel = i / 4;
    const x = pixel % size;
    const y = Math.floor(pixel / size);
    const n = noise[i] / 255;
    const longScuff = Math.pow(Math.max(0, Math.sin(y * .031 + Math.sin(x * .013) * 2.4)), 18) * .16;
    const edgeWear = Math.pow(Math.abs(Math.sin(x * .0064) * Math.cos(y * .0048)), 7) * .09;
    const oil = Math.pow(Math.max(0, Math.sin(x * .019 + y * .004 + seed)), 24) * .12;
    const shade = THREE.MathUtils.clamp(.84 + n * .25 + edgeWear - oil - longScuff, .58, 1.08);
    albedo[i] = 255 * color.r * shade;
    albedo[i + 1] = 255 * color.g * shade;
    albedo[i + 2] = 255 * color.b * shade;
    albedo[i + 3] = 255;
    roughness[i] = roughness[i + 1] = roughness[i + 2] = THREE.MathUtils.clamp(118 + n * 112 + oil * 150 - edgeWear * 90, 40, 245);
    roughness[i + 3] = 255;
    const left = noise[(i - 4 + noise.length) % noise.length] / 255;
    const up = noise[(i - size * 4 + noise.length) % noise.length] / 255;
    normal[i] = 128 + (left - n) * 96 + longScuff * 70;
    normal[i + 1] = 128 + (up - n) * 96 - longScuff * 34;
    normal[i + 2] = 232;
    normal[i + 3] = 255;
    const metal = THREE.MathUtils.clamp(205 + edgeWear * 210 - oil * 120 - longScuff * 80 + (n - .5) * 24, 78, 255);
    metalness[i] = metalness[i + 1] = metalness[i + 2] = metal;
    metalness[i + 3] = 255;
  }
  const map = dataTexture(albedo, size, THREE.SRGBColorSpace);
  const roughnessMap = dataTexture(roughness, size);
  const normalMap = dataTexture(normal, size);
  const metalnessMap = dataTexture(metalness, size);
  for (const texture of [map, roughnessMap, normalMap, metalnessMap]) texture.repeat.set(...repeat);
  return { map, roughnessMap, normalMap, metalnessMap };
}

export function createTrainMaterials(maxAnisotropy = 4): TrainMaterials {
  const textures: THREE.Texture[] = [];
  const surface = (seed: number, repeat: [number, number], tint: THREE.ColorRepresentation) => {
    const maps = createSurfaceMaps(seed, repeat, tint);
    Object.values(maps).forEach((texture) => {
      texture.anisotropy = maxAnisotropy;
      textures.push(texture);
    });
    return maps;
  };
  const steelMaps = surface(221, [3, 8], '#62645e');
  const darkMaps = surface(415, [4, 5], '#202829');
  const armorMaps = surface(777, [5, 10], '#384f4b');
  const brassMaps = surface(902, [3, 4], '#9b6931');
  const leatherMaps = surface(122, [2, 3], '#542b1e');
  const groundMaps = surface(991, [30, 60], '#50483d');

  const steel = new THREE.MeshStandardMaterial({ ...steelMaps, metalness: 0.72, roughness: 0.48, normalScale: new THREE.Vector2(0.24, 0.24) });
  const darkSteel = new THREE.MeshStandardMaterial({ ...darkMaps, metalness: 0.76, roughness: 0.4, normalScale: new THREE.Vector2(0.3, 0.3) });
  const armor = new THREE.MeshStandardMaterial({ ...armorMaps, metalness: 0.66, roughness: 0.54, normalScale: new THREE.Vector2(0.36, 0.36) });
  const brass = new THREE.MeshStandardMaterial({ ...brassMaps, metalness: 0.9, roughness: 0.31, normalScale: new THREE.Vector2(0.22, 0.22) });
  const copper = new THREE.MeshStandardMaterial({ color: '#8c462b', metalness: 0.86, roughness: 0.38 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#111516', metalness: 0.05, roughness: 0.86 });
  const leather = new THREE.MeshStandardMaterial({ ...leatherMaps, metalness: 0.03, roughness: 0.72, normalScale: new THREE.Vector2(0.55, 0.55) });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#91b3ad', roughness: 0.16, metalness: 0.08, transmission: 0.32, thickness: 0.12, transparent: true, opacity: 0.66 });
  const lamp = new THREE.MeshStandardMaterial({ color: '#f3c16f', emissive: '#ff9e36', emissiveIntensity: 3.2, roughness: 0.26 });
  const warning = new THREE.MeshStandardMaterial({ color: '#8d180b', emissive: '#ff240c', emissiveIntensity: 0.2, roughness: 0.32 });
  const screen = new THREE.MeshStandardMaterial({ color: '#182a24', emissive: '#62d9a8', emissiveIntensity: 1.5, roughness: 0.29 });
  const bone = new THREE.MeshStandardMaterial({ color: '#aba18b', roughness: 0.76, metalness: 0.03 });
  const enemyHide = new THREE.MeshStandardMaterial({ color: '#35222a', roughness: 0.67, metalness: 0.12 });
  const parasite = new THREE.MeshStandardMaterial({ color: '#213b3f', emissive: '#42c9ba', emissiveIntensity: 0.48, roughness: 0.43, metalness: 0.36 });
  const ground = new THREE.MeshStandardMaterial({ ...groundMaps, roughness: 0.96, metalness: 0.06, normalScale: new THREE.Vector2(1.2, 1.2) });
  const rail = new THREE.MeshStandardMaterial({ color: '#363330', metalness: 0.93, roughness: 0.38 });
  const sleeper = new THREE.MeshStandardMaterial({ color: '#302a24', metalness: 0.08, roughness: 0.91 });
  const materials = [steel, darkSteel, armor, brass, copper, rubber, leather, glass, lamp, warning, screen, bone, enemyHide, parasite, ground, rail, sleeper];
  return {
    steel, darkSteel, armor, brass, copper, rubber, leather, glass, lamp, warning, screen, bone, enemyHide, parasite, ground, rail, sleeper,
    dispose: () => {
      textures.forEach((texture) => texture.dispose());
      materials.forEach((material) => material.dispose());
    },
  };
}

export function roundedBox(width: number, height: number, depth: number, radius = 0.16, segments = 3): THREE.ExtrudeGeometry {
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSegments: segments, steps: 1, bevelSize: radius * 0.34, bevelThickness: radius * 0.34, curveSegments: segments * 2 });
  geometry.center();
  return geometry;
}

export function makeMesh(geometry: THREE.BufferGeometry, material: THREE.Material, cast = true, receive = true): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}
