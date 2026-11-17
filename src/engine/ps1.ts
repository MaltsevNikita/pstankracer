import * as THREE from 'three';

THREE.ColorManagement.enabled = false;

export const SKY_COLOR = 0x8fa4ad;

/** How many screen pixels the internal framebuffer is wide. */
export const INTERNAL_WIDTH = 640;

const SNAP_VERTEX_CHUNK = `
  vec2 ps1Grid = uSnapResolution * 0.5;
  float ps1W = abs(gl_Position.w) < 0.0001 ? 0.0001 : gl_Position.w;
  gl_Position.xy = floor(gl_Position.xy * ps1Grid / ps1W + 0.5) / ps1Grid * ps1W;
`;

export class Ps1Materials {
  private readonly resolution = new THREE.Vector2(INTERNAL_WIDTH, 360);

  setResolution(width: number, height: number): void {
    this.resolution.set(width * 0.5, height * 0.5);
  }

  private patch<T extends THREE.Material>(material: T): T {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uSnapResolution = { value: this.resolution };
      shader.vertexShader = `uniform vec2 uSnapResolution;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        `#include <project_vertex>\n${SNAP_VERTEX_CHUNK}`,
      );
    };
    material.customProgramCacheKey = () => 'ps1-snap';
    return material;
  }

  lambert(params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
    return this.patch(new THREE.MeshLambertMaterial(params));
  }

  basic(params: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
    return this.patch(new THREE.MeshBasicMaterial(params));
  }
}

const POST_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const POST_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  varying vec2 vUv;

  float bayer2(vec2 a) {
    a = floor(a);
    return fract(a.x / 2.0 + a.y * a.y * 0.75);
  }

  float bayer4(vec2 a) {
    return bayer2(0.5 * a) * 0.25 + bayer2(a);
  }

  void main() {
    vec3 color = texture2D(tDiffuse, vUv).rgb;

    // 5-bit per channel with ordered dithering.
    float dither = bayer4(gl_FragCoord.xy) - 0.5;
    color = floor(color * 31.0 + dither + 0.5) / 31.0;

    // Very light scanlines, the CSS overlay adds the rest.
    color *= 0.97 + 0.03 * step(0.5, fract(gl_FragCoord.y * 0.5));

    // Soft vignette.
    vec2 p = vUv - 0.5;
    color *= 1.0 - dot(p, p) * 0.28;

    gl_FragColor = vec4(color, 1.0);
  }
`;

export class Ps1Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly materials: Ps1Materials;
  readonly target: THREE.WebGLRenderTarget;

  private readonly postScene: THREE.Scene;
  private readonly postCamera: THREE.OrthographicCamera;
  private readonly postMaterial: THREE.ShaderMaterial;
  private readonly postQuad: THREE.Mesh;
  private internalWidth = INTERNAL_WIDTH;
  private internalHeight = 360;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(SKY_COLOR, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(SKY_COLOR, 150, 520);

    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.4, 1000);

    this.materials = new Ps1Materials();
    this.materials.setResolution(this.internalWidth, this.internalHeight);

    // A 16-bit depth buffer is not precise enough for the flat ribbons lying a
    // few centimetres above the ground plane, so ask for a real 24-bit depth
    // texture.
    const depthTexture = new THREE.DepthTexture(this.internalWidth, this.internalHeight);
    depthTexture.format = THREE.DepthFormat;
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;

    this.target = new THREE.WebGLRenderTarget(this.internalWidth, this.internalHeight, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
    });
    this.target.texture.colorSpace = THREE.NoColorSpace;

    const hemi = new THREE.HemisphereLight(0xd8e8f2, 0x333422, 1.25);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2cc, 1.75);
    sun.position.set(-140, 190, -110);
    this.scene.add(sun);

    const rim = new THREE.DirectionalLight(0x7f9fb5, 0.45);
    rim.position.set(120, 60, 160);
    this.scene.add(rim);

    this.postMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.target.texture } },
      vertexShader: POST_VERTEX,
      fragmentShader: POST_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    this.postQuad.frustumCulled = false;

    this.postScene = new THREE.Scene();
    this.postScene.add(this.postQuad);
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.postCamera.position.z = 1;
  }

  resize(width: number, height: number): void {
    const w = Math.max(320, Math.floor(width));
    const h = Math.max(200, Math.floor(height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    const scale = Math.min(1, w / INTERNAL_WIDTH);
    this.internalWidth = Math.max(320, Math.round(INTERNAL_WIDTH * scale));
    this.internalHeight = Math.max(180, Math.round((this.internalWidth * h) / w));
    this.target.setSize(this.internalWidth, this.internalHeight);
    this.materials.setResolution(this.internalWidth, this.internalHeight);
  }

  render(): void {
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
  }

  dispose(): void {
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = (mesh as THREE.Mesh).material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else if (material) (material as THREE.Material).dispose();
    });
    this.target.dispose();
    this.postQuad.geometry.dispose();
    this.postMaterial.dispose();
    this.renderer.dispose();
  }
}
