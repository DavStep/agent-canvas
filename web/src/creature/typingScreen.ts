import { BoxGeometry, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial, Shape, SRGBColorSpace, type Texture } from 'three';

export function typingScreen(face: Texture) {
  const screen = new Group();
  screen.position.set(0, -.57, 1.40);
  screen.rotation.x = .18;

  // Round the silhouette independently of the shallow bevel around the glass.
  const halfWidth = .565, halfHeight = .31, radius = .10;
  const x = halfWidth - radius, y = halfHeight - radius;
  const outline = new Shape();
  outline.moveTo(-x, -halfHeight);
  outline.lineTo(x, -halfHeight);
  outline.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -y);
  outline.lineTo(halfWidth, y);
  outline.quadraticCurveTo(halfWidth, halfHeight, x, halfHeight);
  outline.lineTo(-x, halfHeight);
  outline.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, y);
  outline.lineTo(-halfWidth, -y);
  outline.quadraticCurveTo(-halfWidth, -halfHeight, -x, -halfHeight);

  const geometry = new ExtrudeGeometry(outline, {
    depth: .019, bevelThickness: .009, bevelSize: .009, bevelSegments: 3, curveSegments: 10,
  });
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, .5 + position.getX(i) / (2 * halfWidth), .5 + position.getY(i) / (2 * halfHeight));
  }

  face.colorSpace = SRGBColorSpace;
  const glass = new MeshBasicMaterial({ map: face, transparent: true, depthWrite: false });
  const reflection = { value: 0 };
  glass.onBeforeCompile = shader => {
    shader.uniforms.reflectionPhase = reflection;
    shader.fragmentShader = 'uniform float reflectionPhase;\n' + shader.fragmentShader.replace('#include <map_fragment>', `
      #include <map_fragment>
      float offset = vMapUv.x + .25 * vMapUv.y - mix(-.40, 1.65, reflectionPhase);
      float sheen = exp(-58. * offset * offset);
      diffuseColor.rgb += vec3(.035, .14, .16) * sheen;
      diffuseColor.a += .08 * sheen;
    `);
  };
  const edge = new MeshBasicMaterial({ color: 0x87cffa, transparent: true, opacity: .44, depthWrite: false });
  const display = new Mesh(geometry, [glass, edge]);
  display.position.set(0, .35, -.018);
  // Composite the projection over the hands and the translucent felt fringe.
  display.renderOrder = 1;
  screen.add(display);

  const lineGeometry = new BoxGeometry(1, .029, .005);
  const phosphor = new MeshBasicMaterial({ color: 0xc7faff });
  const lines = [.73, .48, .18].map((width, row) => {
    const line = new Mesh(lineGeometry, phosphor);
    // The character reads left to right from the character-facing side.
    line.position.set(.43 - width / 2, .51 - row * .068, -.012);
    line.scale.x = width;
    screen.add(line);
    return line;
  });
  return { screen, reflection, cursorLine: lines[2]! };
}
