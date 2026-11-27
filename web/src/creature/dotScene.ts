import {
  AmbientLight, Color, DirectionalLight, Group, Mesh,
  MeshPhysicalMaterial, Object3D, OrthographicCamera, PerspectiveCamera, PCFShadowMap, Quaternion,
  RepeatWrapping, SRGBColorSpace, Scene, ShaderMaterial, SphereGeometry, TextureLoader, UniformsLib, UniformsUtils, Vector3, Vector4, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { typingScreen } from './typingScreen.ts';
import hologramFaceUrl from './hologram-face.webp';
import type { Texture } from 'three';
import feltUrl from './felt-nap.png';
import studioUrl from './sebastian-studio.webp';
import { studioSurface } from './studioSurface.ts';
import modelUrl from './dots.glb?url';
import { typingYaw } from './pose.ts';
export { typingYaw } from './pose.ts';
import typing from './typing.json' with { type: 'json' };
import { orchestratorModel } from './orchestratorModel.ts';
import type { PortraitKind } from './generate.ts';

// The nap is a slice through the Codex felt pile. Project it in model space so
// the fibers turn with the character and stay continuous across mesh seams.
interface FeltPalette {
  shade: number;
  mid: number;
  light: number;
}

// Scale each character in local depth before its turn, keeping the workstation in place.
const portraitDepth = .58;

const violetFelt: FeltPalette = { shade: 0x402686, mid: 0x713ec8, light: 0xb792fc };

// The eye pair (or central patch) and its backing have aligned local axes.
function addFaceContact(receiver: Mesh, material: ShaderMaterial, detail: Mesh, openness = { value: 1 }) {
  detail.geometry.computeBoundingBox();
  const box = detail.geometry.boundingBox!;
  const half = box.getSize(new Vector3()).multiplyScalar(.5);
  const center = box.getCenter(new Vector3()).add(detail.position).sub(receiver.position);
  material.defines.FACE_CONTACT = 1;
  material.uniforms.contactBounds = { value: new Vector4(Math.abs(center.x), center.y, half.x, half.y) };
  material.uniforms.openness = openness;
  receiver.material = material;
}

function felt(color: number | FeltPalette, nap: Texture, options: { shell?: boolean; plush?: boolean } = {}) {
  const { shell = false, plush = true } = options;
  const dyed = typeof color === 'number';
  const mid = new Color(dyed ? color : color.mid);
  const shade = dyed ? mid.clone().multiplyScalar(.28) : new Color(color.shade);
  const light = dyed ? mid.clone().multiplyScalar(1.3) : new Color(color.light);
  if (dyed) mid.multiplyScalar(.72);
  return new ShaderMaterial({
    lights: true,
    uniforms: { ...UniformsUtils.clone(UniformsLib.lights), shade: { value: shade }, mid: { value: mid }, light: { value: light }, nap: { value: nap } },
    defines: { ...(shell && { FIBER_SHELL: 1 }), ...(plush && { PLUSH: 1 }) },
    transparent: shell,
    depthWrite: !shell,
    vertexShader: `
      #include <common>
      #include <shadowmap_pars_vertex>
      varying vec3 surface, localNormal;
      void main() {
        surface = position;
        localNormal = normal;
        vec3 vertex = position;
        #ifdef FIBER_SHELL
          vertex += .009 * normal;
        #endif
        vec4 worldPosition = modelMatrix * vec4(vertex, 1.);
        vec3 transformedNormal = normalMatrix * normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(vertex, 1.);
        #include <shadowmap_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <packing>
      uniform bool receiveShadow;
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>
      uniform vec3 shade, mid, light;
      uniform sampler2D nap;
      #ifdef FACE_CONTACT
        uniform vec4 contactBounds;
        uniform float openness;
      #endif
      uniform mat3 normalMatrix;
      varying vec3 surface, localNormal;
      // Red holds fiber density. Green and blue hold signed height slopes along U and V.
      // Lift each projection's slopes into the same object space before blending.
      vec3 sampleNap(vec2 uv, mat2 grain) {
        vec3 texel = texture2D(nap, grain * uv).rgb;
        return vec3(texel.r, (texel.gb - vec2(128. / 255.)) * grain);
      }
      vec4 pile(vec3 position, vec3 weights, mat2 grain) {
        vec3 x = sampleNap(position.yz, grain);
        vec3 y = sampleNap(position.xz, grain);
        vec3 z = sampleNap(position.xy, grain);
        vec3 slope = weights.x * vec3(0., x.gb)
                   + weights.y * vec3(y.g, 0., y.b)
                   + weights.z * vec3(z.gb, 0.);
        return vec4(slope * 2., dot(weights, vec3(x.r, y.r, z.r)));
      }
      void main() {
        vec3 base = normalize(localNormal);
        vec3 weights = pow(abs(base), vec3(4.));
        weights /= max(dot(weights, vec3(1.)), .001);
        #ifdef PLUSH
          // Broad stuffing under the nap rounds the light across the flat faces.
          vec3 stuffing = surface - base * dot(surface, base);
          base = normalize(base + stuffing * 1.15);
          vec4 tuft = pile(surface * 2.8, weights, mat2(1.));
          vec4 fiber = pile(surface * 5.4, weights, mat2(0., 1., -1., 0.));
          vec3 slope = .085 * tuft.xyz + .105 * fiber.xyz;
        #else
          vec4 tuft = pile(surface * 1.07, weights, mat2(1.));
          vec4 fiber = pile(surface * 2.15, weights, mat2(0., 1., -1., 0.));
          vec3 slope = .09 * tuft.xyz + .16 * fiber.xyz;
        #endif
        vec3 tangentSlope = slope - base * dot(slope, base);
        vec3 n = normalize(normalMatrix * (base - tangentSlope));
        vec3 macroNormal = normalize(normalMatrix * base);
        // Broad, wrapped studio light leaves detail in the unlit side of the pile.
        vec3 keyDir = normalize(vec3(-.65, .77, .22));
        float wrap = clamp(.5 + .5 * dot(n, keyDir), 0., 1.);
        vec3 diffuse = mix(shade, mid, min(2. * wrap, 1.));
        diffuse = mix(diffuse, light, max(2. * wrap - 1., 0.));
        float rim = pow(1. - clamp(macroNormal.z, 0., 1.), 3.);
        float density = .81 + .17 * tuft.w + .21 * fiber.w;
        // The broad fill reaches under accessories, even where they block the key.
        vec3 lit = diffuse * density * mix(.32, 1., getShadowMask()) + .028 * light * rim * wrap;
        #ifdef FACE_CONTACT
          // Diffuse occlusion where the raised detail meets the cloth. The eye
          // footprint follows the blink, in the same local space as the fleece.
          vec2 halfSize = contactBounds.zw * vec2(1., openness);
          float corner = min(halfSize.x, halfSize.y) * .5;
          vec2 delta = vec2(abs(surface.x) - contactBounds.x, surface.y - contactBounds.y);
          vec2 edge = abs(delta) - halfSize + corner;
          float distance = length(max(edge, 0.)) + min(max(edge.x, edge.y), 0.) - corner;
          float contact = exp(-max(0., distance) / .032) * smoothstep(.2, .85, localNormal.z);
          lit *= 1. - .43 * contact;
        #endif
        float alpha = 1.;
        #ifdef FIBER_SHELL
          // Fade the pile out through its silhouette instead of drawing a solid rim.
          float coverage = smoothstep(0., .19, macroNormal.z);
          alpha = rim * coverage * (.47 + .48 * fiber.w);
          lit *= 1.04;
        #endif
        gl_FragColor = vec4(lit, alpha);
        #include <colorspace_fragment>
      }`,
  });
}

export async function loadDotScene() {
  const [{ scene: models }, nap, studioAtlas, hologramFace] = await Promise.all([
    new GLTFLoader().loadAsync(modelUrl), new TextureLoader().loadAsync(feltUrl), new TextureLoader().loadAsync(studioUrl),
    new TextureLoader().loadAsync(hologramFaceUrl),
  ]);
  studioAtlas.colorSpace = SRGBColorSpace;
  const studioTurn = { value: 0 };
  const studioPile = studioSurface(studioAtlas, studioTurn, true);
  const studioInk = studioSurface(studioAtlas, studioTurn, false);
  nap.wrapS = nap.wrapT = RepeatWrapping;
  const scene = new Scene();
  const camera = new OrthographicCamera(-1.2, 1.824, 1.08, -1.08, .1, 30);
  camera.position.set(0, .32, 9);
  camera.lookAt(0, 0, 0);
  const azure = { shade: 0x12446d, mid: 0x2589cf, light: 0x81cbff };
  const terracotta = { shade: 0x8e4237, mid: 0xd67554, light: 0xffb48c };
  const dyes = { codex: felt(violetFelt, nap, { plush: false }), claude: felt(terracotta, nap), orchestrator: felt(azure, nap) };
  const visor = felt(0x172e44, nap);
  const radio = orchestratorModel(dyes.orchestrator, felt(azure, nap, { shell: true }), felt(0x176ba3, nap), visor, felt(0xffeedc, nap));
  scene.add(radio.body);
  const bodies = { codex: models.getObjectByName('Sebastian')!, claude: models.getObjectByName('Clawd')!, orchestrator: radio.body };
  for (const body of Object.values(bodies)) body.scale.z *= portraitDepth;
  // A broad front-left key shapes the matte black pieces and casts their shadows onto the pile.
  const key = new DirectionalLight(0xffffff, 2.4);
  key.position.set(-1.5, 2.1, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(256, 256);
  Object.assign(key.shadow.camera, { left: -1.55, right: 1.55, top: 1.55, bottom: -1.55, near: 2, far: 8 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -.0004;
  key.shadow.normalBias = .008;
  key.shadow.radius = 3;
  key.shadow.intensity = .48;
  scene.add(key, new AmbientLight(0xffffff, .95));
  const ink = new MeshPhysicalMaterial({ color: 0x292523, roughness: .64, specularIntensity: .35 });
  const arms: Object3D[] = [...radio.arms];
  const eyes = radio.eyes.map(mesh => ({ mesh: mesh as Mesh, origin: mesh.position.y, center: 0 }));
  for (const provider of ['codex', 'claude'] as const) {
    const body = bodies[provider];
    scene.add(body);
    body.traverse(part => {
      if (!(part instanceof Mesh)) return;
      const name = part.name.toLowerCase();
      const eye = name.includes('eye');
      const isInk = eye || /lid|bow|monocle/.test(name);
      part.material = isInk ? ink : dyes[provider];
      if (provider === 'codex') part.material = isInk ? studioInk : studioPile;
      part.castShadow = provider === 'claude' || eye;
      part.receiveShadow = true;
      if (name.startsWith('restingarm')) arms.push(part);
      if (eye) {
        part.geometry.computeBoundingBox();
        eyes.push({ mesh: part, origin: part.position.y, center: part.geometry.boundingBox!.getCenter(new Vector3()).y });
      }
    });
  }

  const eyeOpenness = { value: 1 };
  const clawdHead = bodies.claude.getObjectByName('Wide_body') as Mesh;
  const clawdEye = bodies.claude.getObjectByName('Slit_eye') as Mesh;
  addFaceContact(clawdHead, felt(terracotta, nap), clawdEye, eyeOpenness);
  addFaceContact(radio.hood, felt(azure, nap), radio.face);
  addFaceContact(radio.face, visor, radio.eyes[0]!, eyeOpenness);

  const workstation = new Group();
  scene.add(workstation);
  const palm = new SphereGeometry(.17, 16, 12);
  const hands = [new Mesh(palm, dyes.codex), new Mesh(palm, dyes.codex)];
  workstation.add(...hands);
  workstation.rotation.y = typingYaw;
  const { screen, cursorLine, reflection } = typingScreen(hologramFace);
  workstation.add(screen);
  // Convert the sampled world-space hand travel into the workstation's local axes once.
  const cos = Math.cos(typingYaw), sin = Math.sin(typingYaw);
  const keystrokes = typing.map(frame => [0, 3].flatMap(i => {
    const x = frame[i]!, z = frame[i + 2]!;
    const lift = frame[i + 1]! - typing[0]![i + 1]!;
    return [x * cos - z * sin + .25, -.383 + lift * 1.6, x * sin + z * cos - .38];
  }));
  // The hands and projection share the same perspective.
  const deskCamera = new PerspectiveCamera(19.5, 1.4, .1, 30);
  deskCamera.position.set(0, .76, 6.3);
  deskCamera.lookAt(0, 0, 0);
  deskCamera.filmOffset = 1.72;
  deskCamera.updateProjectionMatrix();

  // One WebGL context serves all portraits. Its transparent frame is copied immediately after rendering.
  const renderer = new WebGLRenderer({ alpha: true, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const shadowRotation = new Quaternion();
  let shadowBody: Object3D | undefined;
  let shadowBlink = 1;
  let shadowWorking = false;
  renderer.domElement.addEventListener('webglcontextrestored', () => { shadowBody = undefined; });
  nap.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  studioAtlas.anisotropy = nap.anisotropy;
  renderer.setSize(224, 160, false);
  return {
    canvas: renderer.domElement,
    render(provider: PortraitKind, working: boolean, yaw: number, pitch: number, seconds: number, reflectionPhase = 0) {
      bodies.claude.visible = provider === 'claude';
      bodies.codex.visible = provider === 'codex';
      bodies.orchestrator.visible = provider === 'orchestrator';
      camera.position.y = provider === 'codex' ? 0 : .32;
      camera.lookAt(0, 0, 0);
      const body = bodies[provider];
      const cycle = seconds % 6;
      const tilt = working ? 0 : .055 * Math.sin(Math.PI * Math.min(1, cycle / 2.4) * 2);
      if (provider === 'codex') {
        // The compressed mesh exposes a shallower view of the original studio surfaces.
        const studioYaw = Math.atan2(portraitDepth * Math.sin(yaw), Math.cos(yaw));
        studioTurn.value = Math.max(0, Math.min(2, studioYaw * 9 / Math.PI));
      }
      body.rotation.set(pitch, yaw, tilt, 'YXZ');
      const blink = working ? 1 : 1 - .93 * Math.max(
        Math.exp(-((cycle - 3.1) ** 2) / .003), Math.exp(-((cycle - 3.42) ** 2) / .003),
      );
      eyeOpenness.value = blink;
      for (const { mesh, center, origin } of eyes) {
        mesh.scale.y = blink;
        mesh.position.y = origin + center * (1 - blink);
      }
      for (const arm of arms) arm.visible = !working;
      workstation.visible = working;
      if (working) {
        // Sample the shared typing loop at its original 24 fps.
        reflection.value = reflectionPhase;
        const time = seconds * 24;
        const index = Math.floor(time) % keystrokes.length;
        const a = keystrokes[index]!, b = keystrokes[(index + 1) % keystrokes.length]!;
        const f = time % 1;
        const value = (i: number) => a[i]! + (b[i]! - a[i]!) * f;
        hands.forEach((hand, i) => {
          hand.material = dyes[provider];
          hand.position.set(value(i * 3), value(i * 3 + 1), value(i * 3 + 2));
        });
        const width = .16 + .64 * (Math.floor(seconds * 7) % 9) / 8;
        cursorLine.position.x = .43 - width / 2;
        cursorLine.scale.x = width;
      }
      // The screen and hands never cast onto the face. Reuse its shadow map while only typing advances.
      if (body !== shadowBody || blink !== shadowBlink || working !== shadowWorking || !shadowRotation.equals(body.quaternion)) {
        if (body !== shadowBody) {
          if (provider === 'codex') key.position.set(-1.5, 2.1, 4);
          else key.position.set(-2.3, 3.4, 2.8);
        }
        renderer.shadowMap.needsUpdate = true;
        shadowBody = body;
        shadowBlink = blink;
        shadowWorking = working;
        shadowRotation.copy(body.quaternion);
      }
      renderer.render(scene, working ? deskCamera : camera);
    },
  };
}
