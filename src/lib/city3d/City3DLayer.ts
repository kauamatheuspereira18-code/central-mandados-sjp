import * as THREE from 'three';
import * as maplibregl from 'maplibre-gl';
import type { CustomLayerInterface, CustomRenderMethodInput } from 'maplibre-gl';
import { createFacadeAtlasTexture, createTreePrototypeGeometry } from './facadeAtlas';

const EARTH_CIRCUMFERENCE = 40075016.68557849;
const ORIGIN_LON = -49.19599;
const ORIGIN_LAT = -25.54045;
const MAX_CACHED_CHUNKS = 14;
const MAX_IN_FLIGHT = 2;
const MIN_BUILDINGS_ZOOM = 14.3;

interface WorkerChunkResult {
  reqId: number;
  x15: number;
  y15: number;
  tileSizeMeters: number;
  roofPos: Float32Array;
  roofNorm: Float32Array;
  roofUv: Float32Array;
  roofCol: Float32Array;
  roofElev: Float32Array;
  wallPos: Float32Array;
  wallNorm: Float32Array;
  wallUv: Float32Array;
  wallCol: Float32Array;
  wallElev: Float32Array;
  treeData: Float32Array;
  satBitmap: ImageBitmap | null;
  buildingCount: number;
  error?: string;
}

interface BuiltChunk {
  key: string;
  x15: number;
  y15: number;
  group: THREE.Group;
  roofMat: THREE.MeshLambertMaterial | null;
  satTex: THREE.Texture | null;
  geometries: THREE.BufferGeometry[];
  lastUsed: number;
}

function lngLatToTile15(lon: number, lat: number): [number, number] {
  const n = 32768;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

function patchTerrainElevationShader(
  mat: THREE.Material,
  uTerrainExag: { value: number },
  isInstanced: boolean
) {
  mat.customProgramCacheKey = () => (isInstanced ? 'city3d-tree-v1' : 'city3d-bldg-v1');
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrainExag = uTerrainExag;
    if (isInstanced) {
      shader.vertexShader =
        `attribute float aInstElev;\nuniform float uTerrainExag;\n` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          mvPosition = batchingMatrix * mvPosition;
        #endif
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          mvPosition.y += aInstElev * uTerrainExag;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`
      );
    } else {
      shader.vertexShader =
        `attribute float aGroundElev;\nuniform float uTerrainExag;\n` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\ntransformed.y += aGroundElev * uTerrainExag;`
      );
    }
  };
}

export class City3DCustomLayer implements CustomLayerInterface {
  id = 'city-real-3d-mesh';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  private map: maplibregl.Map | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private worldOriginMatrix = new THREE.Matrix4();
  private originMercX = 0;
  private originMercY = 0;
  private originScale = 1;

  private worker: Worker | null = null;
  private reqSeq = 1;
  private inFlight = new Map<string, number>();
  private queued: Array<{ key: string; x15: number; y15: number; dist: number }> = [];
  private chunks = new Map<string, BuiltChunk>();
  private failedKeys = new Set<string>();

  private facadeTex: THREE.CanvasTexture | null = null;
  private wallMat: THREE.MeshLambertMaterial | null = null;
  private treeGeo: THREE.BufferGeometry | null = null;
  private treeMat: THREE.MeshLambertMaterial | null = null;

  private uTerrainExag = { value: 1.35 };
  private visible = true;
  private syncTimer: number | null = null;
  private useCounter = 0;
  private onLoadingChange?: (loading: boolean) => void;

  constructor(opts?: { terrainExag?: number; visible?: boolean; onLoadingChange?: (loading: boolean) => void }) {
    if (opts?.terrainExag !== undefined) this.uTerrainExag.value = opts.terrainExag;
    if (opts?.visible !== undefined) this.visible = opts.visible;
    this.onLoadingChange = opts?.onLoadingChange;

    const originMerc = maplibregl.MercatorCoordinate.fromLngLat([ORIGIN_LON, ORIGIN_LAT], 0);
    this.originMercX = originMerc.x;
    this.originMercY = originMerc.y;
    this.originScale = originMerc.meterInMercatorCoordinateUnits();
    this.worldOriginMatrix = new THREE.Matrix4()
      .makeTranslation(originMerc.x, originMerc.y, 0)
      .scale(new THREE.Vector3(this.originScale, -this.originScale, this.originScale))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));

    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorld.identity();
    this.camera.matrixWorldInverse.identity();

    const hemi = new THREE.HemisphereLight(0xf8fafc, 0x475569, 1.15);
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.32);
    sun.position.set(0.65, 1.0, 0.42);
    const fill = new THREE.DirectionalLight(0xcbd5e1, 0.44);
    fill.position.set(-0.7, 0.48, -0.5);
    this.scene.add(hemi, sun, fill);
  }

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext) {
    this.map = map;

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: false,
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.facadeTex = createFacadeAtlasTexture(maxAniso);

    this.wallMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: this.facadeTex,
      vertexColors: true,
      side: THREE.FrontSide,
    });
    patchTerrainElevationShader(this.wallMat, this.uTerrainExag, false);

    this.treeGeo = createTreePrototypeGeometry();
    this.treeMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      side: THREE.FrontSide,
    });
    patchTerrainElevationShader(this.treeMat, this.uTerrainExag, true);

    if (typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('./city3d.worker.ts', import.meta.url));
      this.worker.onmessage = (ev: MessageEvent<WorkerChunkResult>) => this.handleWorkerResult(ev.data);
      this.worker.onerror = () => {
        this.inFlight.clear();
        this.notifyLoading();
      };
    }

    map.on('moveend', this.scheduleSync);
    map.on('zoomend', this.scheduleSync);
    this.scheduleSync();
  }

  onRemove(map: maplibregl.Map) {
    map.off('moveend', this.scheduleSync);
    map.off('zoomend', this.scheduleSync);
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.inFlight.clear();
    this.queued = [];

    for (const chunk of this.chunks.values()) {
      this.disposeChunk(chunk);
    }
    this.chunks.clear();

    this.facadeTex?.dispose();
    this.wallMat?.dispose();
    this.treeGeo?.dispose();
    this.treeMat?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  setVisible(vis: boolean) {
    if (this.visible === vis) return;
    this.visible = vis;
    if (vis) this.scheduleSync();
    this.map?.triggerRepaint();
  }

  setTerrainExaggeration(exag: number) {
    if (Math.abs(this.uTerrainExag.value - exag) < 1e-4) return;
    this.uTerrainExag.value = exag;
    this.map?.triggerRepaint();
  }

  private notifyLoading() {
    this.onLoadingChange?.(this.inFlight.size > 0 || this.queued.length > 0);
  }

  private scheduleSync = () => {
    if (!this.map || !this.visible) return;
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.syncViewport();
    }, 55);
  };

  private syncViewport() {
    const map = this.map;
    if (!map || !this.worker || !this.visible) return;

    const zoom = map.getZoom();
    if (zoom < MIN_BUILDINGS_ZOOM) {
      this.queued = [];
      this.notifyLoading();
      return;
    }

    const center = map.getCenter();
    const bounds = map.getBounds();
    const [cx, cy] = lngLatToTile15(center.lng, center.lat);
    const [minX, maxY] = lngLatToTile15(bounds.getWest(), bounds.getSouth());
    const [maxX, minY] = lngLatToTile15(bounds.getEast(), bounds.getNorth());

    // Cap viewport scan to a tight 3x3..4x4 neighborhood around camera center for ultra-low RAM/VRAM
    const xStart = Math.max(minX, cx - 2);
    const xEnd = Math.min(maxX, cx + 2);
    const yStart = Math.max(minY, cy - 2);
    const yEnd = Math.min(maxY, cy + 2);

    const needed = new Set<string>();
    const pending: Array<{ key: string; x15: number; y15: number; dist: number }> = [];

    for (let y15 = yStart; y15 <= yEnd; y15++) {
      for (let x15 = xStart; x15 <= xEnd; x15++) {
        const dist = Math.hypot(x15 - cx, y15 - cy);
        if (dist > 2.35) continue;
        const key = `${x15}/${y15}`;
        needed.add(key);
        const existing = this.chunks.get(key);
        if (existing) {
          existing.lastUsed = ++this.useCounter;
        } else if (!this.inFlight.has(key) && !this.failedKeys.has(key)) {
          pending.push({ key, x15, y15, dist });
        }
      }
    }

    pending.sort((a, b) => a.dist - b.dist);
    this.queued = pending;
    this.pumpQueue();
  }

  private pumpQueue() {
    if (!this.worker) return;
    while (this.inFlight.size < MAX_IN_FLIGHT && this.queued.length > 0) {
      const next = this.queued.shift()!;
      if (this.chunks.has(next.key) || this.inFlight.has(next.key)) continue;
      const reqId = this.reqSeq++;
      this.inFlight.set(next.key, reqId);
      this.worker.postMessage({ reqId, x15: next.x15, y15: next.y15 });
    }
    this.notifyLoading();
  }

  private handleWorkerResult(res: WorkerChunkResult) {
    const key = `${res.x15}/${res.y15}`;
    this.inFlight.delete(key);

    if (res.error) {
      this.failedKeys.add(key);
      if (res.satBitmap) res.satBitmap.close();
      this.pumpQueue();
      return;
    }

    if (!this.map || !this.wallMat || !this.treeGeo || !this.treeMat) {
      if (res.satBitmap) res.satBitmap.close();
      return;
    }

    if (this.chunks.has(key)) {
      if (res.satBitmap) res.satBitmap.close();
      this.pumpQueue();
      return;
    }

    const group = new THREE.Group();
    const nwMercX = res.x15 / 32768;
    const nwMercY = res.y15 / 32768;
    const tyCenter = (res.y15 + 0.5) / 32768;
    const centerLat = (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * tyCenter))) - Math.PI / 2) * (180 / Math.PI);
    const chunkScale = Math.cos((centerLat * Math.PI) / 180) / EARTH_CIRCUMFERENCE;
    const ratio = chunkScale / this.originScale;
    const dx = (nwMercX - this.originMercX) / this.originScale;
    const dz = (nwMercY - this.originMercY) / this.originScale;

    group.position.set(dx, 0, dz);
    group.scale.set(ratio, ratio, ratio);
    group.updateMatrix();
    group.updateMatrixWorld(true);

    const geometries: THREE.BufferGeometry[] = [];
    let satTex: THREE.Texture | null = null;
    let roofMat: THREE.MeshLambertMaterial | null = null;

    // 1. Satellite-Textured Roof Mesh
    if (res.roofPos.length > 0 && res.satBitmap) {
      satTex = new THREE.Texture(res.satBitmap);
      satTex.flipY = false;
      satTex.colorSpace = THREE.SRGBColorSpace;
      satTex.minFilter = THREE.LinearMipmapLinearFilter;
      satTex.magFilter = THREE.LinearFilter;
      satTex.generateMipmaps = true;
      if (this.renderer) {
        satTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      }
      satTex.needsUpdate = true;

      roofMat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        map: satTex,
        emissive: 0xffffff,
        emissiveMap: satTex,
        emissiveIntensity: 0.34,
        vertexColors: true,
        side: THREE.FrontSide,
      });
      patchTerrainElevationShader(roofMat, this.uTerrainExag, false);

      const roofGeo = new THREE.BufferGeometry();
      roofGeo.setAttribute('position', new THREE.BufferAttribute(res.roofPos, 3));
      roofGeo.setAttribute('normal', new THREE.BufferAttribute(res.roofNorm, 3));
      roofGeo.setAttribute('uv', new THREE.BufferAttribute(res.roofUv, 2));
      roofGeo.setAttribute('color', new THREE.BufferAttribute(res.roofCol, 3));
      roofGeo.setAttribute('aGroundElev', new THREE.BufferAttribute(res.roofElev, 1));
      geometries.push(roofGeo);

      const roofMesh = new THREE.Mesh(roofGeo, roofMat);
      roofMesh.frustumCulled = false;
      group.add(roofMesh);
    } else if (res.satBitmap) {
      res.satBitmap.close();
    }

    // 2. Architectural Textured Wall Mesh
    if (res.wallPos.length > 0) {
      const wallGeo = new THREE.BufferGeometry();
      wallGeo.setAttribute('position', new THREE.BufferAttribute(res.wallPos, 3));
      wallGeo.setAttribute('normal', new THREE.BufferAttribute(res.wallNorm, 3));
      wallGeo.setAttribute('uv', new THREE.BufferAttribute(res.wallUv, 2));
      wallGeo.setAttribute('color', new THREE.BufferAttribute(res.wallCol, 3));
      wallGeo.setAttribute('aGroundElev', new THREE.BufferAttribute(res.wallElev, 1));
      geometries.push(wallGeo);

      const wallMesh = new THREE.Mesh(wallGeo, this.wallMat);
      wallMesh.frustumCulled = false;
      group.add(wallMesh);
    }

    // 3. Instanced Volumetric 3D Trees extracted from Google Satellite
    const treeCount = Math.floor(res.treeData.length / 8);
    if (treeCount > 0) {
      const treeGeoClone = this.treeGeo.clone();
      const instElev = new Float32Array(treeCount);
      treeGeoClone.setAttribute('aInstElev', new THREE.InstancedBufferAttribute(instElev, 1));
      geometries.push(treeGeoClone);

      const trees = new THREE.InstancedMesh(treeGeoClone, this.treeMat, treeCount);
      trees.frustumCulled = false;

      const dummy = new THREE.Object3D();
      const col = new THREE.Color();
      for (let i = 0; i < treeCount; i++) {
        const b = i * 8;
        const tx = res.treeData[b];
        const elev = res.treeData[b + 1];
        const tz = res.treeData[b + 2];
        const sc = res.treeData[b + 3];
        const ry = res.treeData[b + 4];
        dummy.position.set(tx, -0.3, tz);
        dummy.rotation.set(0, ry, 0);
        dummy.scale.set(sc, sc, sc);
        dummy.updateMatrix();
        trees.setMatrixAt(i, dummy.matrix);
        instElev[i] = elev;
        col.setRGB(res.treeData[b + 5], res.treeData[b + 6], res.treeData[b + 7]);
        trees.setColorAt(i, col);
      }
      trees.instanceMatrix.needsUpdate = true;
      if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
      group.add(trees);
    }

    this.scene.add(group);
    this.chunks.set(key, {
      key,
      x15: res.x15,
      y15: res.y15,
      group,
      roofMat,
      satTex,
      geometries,
      lastUsed: ++this.useCounter,
    });

    // Evict oldest distant chunks above LRU cap
    if (this.chunks.size > MAX_CACHED_CHUNKS) {
      let oldest: BuiltChunk | null = null;
      for (const ch of this.chunks.values()) {
        if (!oldest || ch.lastUsed < oldest.lastUsed) oldest = ch;
      }
      if (oldest && oldest.key !== key) {
        this.chunks.delete(oldest.key);
        this.disposeChunk(oldest);
      }
    }

    this.map.triggerRepaint();
    this.pumpQueue();
  }

  private disposeChunk(chunk: BuiltChunk) {
    this.scene.remove(chunk.group);
    chunk.geometries.forEach((g) => g.dispose());
    chunk.roofMat?.dispose();
    chunk.satTex?.dispose();
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.renderer || !this.map || !this.visible) return;
    if (this.map.getZoom() < MIN_BUILDINGS_ZOOM || this.chunks.size === 0) return;

    const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as ArrayLike<number>);
    this.camera.projectionMatrix.copy(m).multiply(this.worldOriginMatrix);

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }
}
