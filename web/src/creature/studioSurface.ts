import { ShaderMaterial, UniformsLib, UniformsUtils, type Texture } from 'three';

// The mesh carries UVs for three individually lit views of each surface.
// The eyes have their own maps so their lid shadows follow them through a blink.
export function studioSurface(atlas: Texture, turn: { value: number }, pile: boolean) {
  return new ShaderMaterial({
    defines: pile ? { STUDIO_PILE: 1 } : {},
    lights: pile,
    transparent: pile,
    uniforms: {
      ...(pile ? UniformsUtils.clone(UniformsLib.lights) : {}),
      atlas: { value: atlas }, turn,
    },
    vertexShader: `
      #include <common>
      #include <shadowmap_pars_vertex>
      attribute vec2 _studio_0, _studio_20, _studio_40;
      varying vec2 frontUV, middleUV, sideUV;
      varying vec3 viewNormal;
      void main() {
        frontUV = _studio_0;
        middleUV = _studio_20;
        sideUV = _studio_40;
        vec4 vertex = modelViewMatrix * vec4(position, 1.);
        vec3 transformedNormal = normalMatrix * normal;
        viewNormal = transformedNormal;
        #ifdef STUDIO_PILE
          // The wool extends past the core mesh, with a softly fading contour.
          vertex.xy += .019 * (mat3(modelViewMatrix) * normal).xy;
        #endif
        gl_Position = projectionMatrix * vertex;
        vec4 worldPosition = modelMatrix * vec4(position, 1.);
        #include <shadowmap_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <packing>
      uniform bool receiveShadow;
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>
      uniform sampler2D atlas;
      uniform float turn;
      varying vec2 frontUV, middleUV, sideUV;
      varying vec3 viewNormal;
      void main() {
        vec4 a = texture2D(atlas, turn < 1. ? frontUV : middleUV);
        vec4 b = texture2D(atlas, turn < 1. ? middleUV : sideUV);
        float blend = turn < 1. ? turn : turn - 1.;
        vec4 surface = mix(a, b, blend);
        #ifdef STUDIO_PILE
          // Derive coverage from the visible contour as it turns. A projected
          // silhouette from another angle would leave a dark stripe across the wool.
          float contour = smoothstep(0., .27, normalize(viewNormal).z);
          float betweenViews = smoothstep(0., .3, min(blend, 1. - blend));
          surface.a = mix(surface.a, contour, betweenViews);
          if (surface.a < .025) discard;
          // Only the moving eyes cast a live shadow. Fixed accessories are baked.
          surface.rgb *= mix(.55, 1., getShadowMask());
        #endif
        gl_FragColor = surface;
        #include <colorspace_fragment>
      }`,
  });
}
