import { Group, Mesh, SphereGeometry, type BufferGeometry, type Material } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** A stuffed radio operator. The dark face patch and three little feet echo the project chat's original mark. */
export function orchestratorModel(fleece: Material, fringe: Material, trim: Material, visor: Material, stitch: Material) {
  const body = new Group();
  function piece(name: string, geometry: BufferGeometry, material: Material, x: number, y: number, z: number) {
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(x, y, z);
    body.add(mesh);
    return mesh;
  }
  const hood = piece('Hood', new RoundedBoxGeometry(1.58, 1.13, 1.04, 6, .36), fleece, 0, .12, 0);
  const nap = new Mesh(hood.geometry, fringe);
  nap.receiveShadow = true;
  hood.add(nap);
  const face = piece('Face patch', new RoundedBoxGeometry(1.13, .56, .22, 6, .17), visor, 0, .15, .48);
  const eyeShape = new RoundedBoxGeometry(.145, .195, .075, 4, .047);
  const eyes = [-.275, .275].map(x => piece('Eye', eyeShape, stitch, x, face.position.y + .02, .59));
  const tummy = piece('Body', new SphereGeometry(.55, 32, 24), fleece, 0, -.40, -.14);
  tummy.scale.set(1.04, .72, .82);
  const foot = new RoundedBoxGeometry(.32, .40, .43, 4, .14);
  for (const x of [-.41, 0, .41]) {
    piece('Foot', foot, trim, x, -.70, x === 0 ? .18 : .045).rotation.z = x * .2;
  }
  const mitten = new SphereGeometry(.20, 24, 16);
  const arms = [-1, 1].map(side => {
    const arm = piece('Mitten', mitten, fleece, side * .62, -.40, .06);
    arm.scale.set(.85, 1.2, .92);
    arm.rotation.z = side * .38;
    return arm;
  });
  const aerial = piece('Antenna', new RoundedBoxGeometry(.095, .29, .11, 3, .04), trim, -.35, .72, -.10);
  aerial.rotation.z = .32;
  piece('Pompom', new SphereGeometry(.155, 24, 16), fleece, -.40, .87, -.10);
  return { body, hood, face, eyes, arms };
}
