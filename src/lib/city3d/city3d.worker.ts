import { PMTiles } from 'pmtiles';
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';

const OVERTURE_PMTILES_URL = 'https://tiles.overturemaps.org/2026-10-21.0/buildings.pmtiles';
const EARTH_CIRCUMFERENCE = 40075016.68557849;
const SAT_CANVAS_SIZE = 1536; // 4 x 384px tiles
const SAT_TILE_PX = 384;
const TREE_GRID = 128;

const pm = new PMTiles(OVERTURE_PMTILES_URL);
const mvtCache = new Map<string, Uint8Array>();
const demCache = new Map<string, Uint8ClampedArray>();

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse, transfer?: Transferable[]) => void;
};

interface WorkerRequest {
  reqId: number;
  x15: number;
  y15: number;
}

interface WorkerResponse {
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
  treeData: Float32Array; // stride 8: [x, elev, z, scale, rotY, r, g, b]
  satBitmap: ImageBitmap | null;
  buildingCount: number;
  error?: string;
}

function lruSet<K, V>(map: Map<K, V>, key: K, val: V, max: number) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > max) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
}

async function getOvertureMvt(x14: number, y14: number): Promise<Uint8Array | null> {
  const key = `${x14}/${y14}`;
  const cached = mvtCache.get(key);
  if (cached) return cached;

  const tile = await pm.getZxy(14, x14, y14);
  if (!tile || !tile.data) return null;
  const bytes = new Uint8Array(tile.data);
  lruSet(mvtCache, key, bytes, 12);
  return bytes;
}

async function getTerrariumPixels(x12: number, y12: number): Promise<Uint8ClampedArray | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return null;
  }
  const key = `${x12}/${y12}`;
  const cached = demCache.get(key);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/${x12}/${y12}.png`,
      { mode: 'cors' }
    );
    if (!res.ok) return null;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(256, 256);
    const c2d = canvas.getContext('2d')!;
    c2d.drawImage(bmp, 0, 0, 256, 256);
    bmp.close();
    const pixels = c2d.getImageData(0, 0, 256, 256).data;
    lruSet(demCache, key, pixels, 8);
    return pixels;
  } catch {
    return null;
  }
}

function sampleTerrarium(pixels: Uint8ClampedArray | null, u: number, v: number): number {
  if (!pixels) return 0;
  const px = Math.max(0, Math.min(254.999, u * 255));
  const py = Math.max(0, Math.min(254.999, v * 255));
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;

  const read = (x: number, y: number) => {
    const i = (y * 256 + x) * 4;
    return pixels[i] * 256 + pixels[i + 1] + pixels[i + 2] / 256 - 32768;
  };
  const h00 = read(ix, iy);
  const h10 = read(ix + 1, iy);
  const h01 = read(ix, iy + 1);
  const h11 = read(ix + 1, iy + 1);
  const h0 = h00 + (h10 - h00) * fx;
  const h1 = h01 + (h11 - h01) * fx;
  return h0 + (h1 - h0) * fy;
}

async function fetchSatelliteMosaic(
  x15: number,
  y15: number
): Promise<{ bitmap: ImageBitmap | null; treeRgb: Uint8ClampedArray | null }> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { bitmap: null, treeRgb: null };
  }

  const canvas = new OffscreenCanvas(SAT_CANVAS_SIZE, SAT_CANVAS_SIZE);
  const c2d = canvas.getContext('2d')!;
  c2d.fillStyle = '#2a332b';
  c2d.fillRect(0, 0, SAT_CANVAS_SIZE, SAT_CANVAS_SIZE);

  const gx0 = x15 * 4;
  const gy0 = y15 * 4;
  const jobs: Promise<void>[] = [];

  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 4; dx++) {
      const gx = gx0 + dx;
      const gy = gy0 + dy;
      const sub = (gx + gy) & 3;
      const url = `https://mt${sub}.google.com/vt/lyrs=s&hl=pt-BR&scale=2&x=${gx}&y=${gy}&z=17`;
      jobs.push(
        fetch(url, { mode: 'cors' })
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => (blob ? createImageBitmap(blob) : null))
          .then((bmp) => {
            if (bmp) {
              c2d.drawImage(bmp, dx * SAT_TILE_PX, dy * SAT_TILE_PX, SAT_TILE_PX, SAT_TILE_PX);
              bmp.close();
            }
          })
          .catch(() => {})
      );
    }
  }

  await Promise.all(jobs);

  const small = new OffscreenCanvas(TREE_GRID, TREE_GRID);
  const s2d = small.getContext('2d')!;
  s2d.drawImage(canvas, 0, 0, TREE_GRID, TREE_GRID);
  const treeRgb = s2d.getImageData(0, 0, TREE_GRID, TREE_GRID).data;

  const bitmap = canvas.transferToImageBitmap();
  return { bitmap, treeRgb };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function signedAreaXZ(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % pts.length];
    a += p0[0] * p1[1] - p1[0] * p0[1];
  }
  return a * 0.5;
}

function cleanRing(raw: [number, number][], wantCCW: boolean): [number, number][] {
  if (raw.length < 3) return [];
  const pts: [number, number][] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 0.25) {
      pts.push(p);
    }
  }
  if (pts.length >= 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.25) {
    pts.pop();
  }
  if (pts.length < 3) return [];

  const area = signedAreaXZ(pts);
  // In (X=East, Z=South), negative signedAreaXZ = CCW when viewed from +Y (sky)
  if (wantCCW && area > 0) pts.reverse();
  if (!wantCCW && area < 0) pts.reverse();
  return pts;
}

function pointInPolyXZ(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const zi = ring[i][1];
    const xj = ring[j][0];
    const zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

class FloatGrow {
  arr: Float32Array;
  len = 0;
  constructor(cap = 8192) {
    this.arr = new Float32Array(cap);
  }
  ensure(add: number) {
    if (this.len + add <= this.arr.length) return;
    let nextCap = this.arr.length * 2;
    while (nextCap < this.len + add) nextCap *= 2;
    const next = new Float32Array(nextCap);
    next.set(this.arr.subarray(0, this.len));
    this.arr = next;
  }
  push3(a: number, b: number, c: number) {
    this.ensure(3);
    this.arr[this.len++] = a;
    this.arr[this.len++] = b;
    this.arr[this.len++] = c;
  }
  push2(a: number, b: number) {
    this.ensure(2);
    this.arr[this.len++] = a;
    this.arr[this.len++] = b;
  }
  push1(a: number) {
    this.ensure(1);
    this.arr[this.len++] = a;
  }
  finish(): Float32Array {
    return this.arr.slice(0, this.len);
  }
}

const WALL_PALETTES: Array<[number, number, number]> = [
  [0.98, 0.96, 0.92], // Crisp warm white
  [0.96, 0.91, 0.82], // Sand / cream
  [0.92, 0.94, 0.96], // Architectural cool light grey
  [0.95, 0.88, 0.81], // Warm terracotta plaster
  [0.88, 0.91, 0.88], // Pale sage plaster
  [0.93, 0.92, 0.89], // Sandstone
];

async function buildChunk(req: WorkerRequest): Promise<WorkerResponse> {
  const { reqId, x15, y15 } = req;
  const x14 = x15 >> 1;
  const y14 = y15 >> 1;
  const qx = x15 & 1;
  const qy = y15 & 1;

  const tyCenter = (y15 + 0.5) / 32768;
  const centerLat = (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * tyCenter))) - Math.PI / 2) * (180 / Math.PI);
  const mercScale = Math.cos((centerLat * Math.PI) / 180) / EARTH_CIRCUMFERENCE;
  const tileSizeMeters = 1 / 32768 / mercScale;

  const x12 = x15 >> 3;
  const y12 = y15 >> 3;
  const demSubX = (x15 & 7) / 8;
  const demSubY = (y15 & 7) / 8;

  const [mvtBuf, demPixels, satRes] = await Promise.all([
    getOvertureMvt(x14, y14).catch(() => null),
    getTerrariumPixels(x12, y12),
    fetchSatelliteMosaic(x15, y15),
  ]);

  const roofPos = new FloatGrow(16384);
  const roofNorm = new FloatGrow(16384);
  const roofUv = new FloatGrow(12288);
  const roofCol = new FloatGrow(16384);
  const roofElev = new FloatGrow(6144);

  const wallPos = new FloatGrow(24576);
  const wallNorm = new FloatGrow(24576);
  const wallUv = new FloatGrow(16384);
  const wallCol = new FloatGrow(24576);
  const wallElev = new FloatGrow(8192);

  const treeMask = new Uint8Array(TREE_GRID * TREE_GRID);
  let buildingCount = 0;

  const clampUv = (val: number) => Math.max(0.002, Math.min(0.998, val));

  const pushRoofTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    elev: number,
    centroidU: number,
    centroidV: number,
    insetFactor: number,
    tint = 1.0
  ) => {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-5) return;

    // Enforce upward normal (+Y)
    let flip = false;
    if (ny < 0) flip = true;

    const p = flip
      ? [[ax, ay, az], [cx, cy, cz], [bx, by, bz]]
      : [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
    const sgn = flip ? -1 : 1;
    const unx = (nx / nl) * sgn;
    const uny = (ny / nl) * sgn;
    const unz = (nz / nl) * sgn;

    for (let k = 0; k < 3; k++) {
      const vx = p[k][0], vy = p[k][1], vz = p[k][2];
      roofPos.push3(vx, vy, vz);
      roofNorm.push3(unx, uny, unz);
      const rawU = vx / tileSizeMeters;
      const rawV = vz / tileSizeMeters;
      const u = clampUv(rawU + (centroidU - rawU) * insetFactor);
      const v = clampUv(rawV + (centroidV - rawV) * insetFactor);
      roofUv.push2(u, v);
      roofCol.push3(tint, tint, tint);
      roofElev.push1(elev);
    }
  };

  const pushWallQuad = (
    ax: number, az: number,
    bx: number, bz: number,
    yBot: number, yTop: number,
    elev: number,
    band: number,
    vSpan: number,
    tintR: number, tintG: number, tintB: number,
    uStart: number, uEnd: number
  ) => {
    const dx = bx - ax;
    const dz = bz - az;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 0.15) return;

    // Outward normal for CCW loop in (East, South)
    const nx = -dz / segLen;
    const nz = dx / segLen;

    const bandTop = band * 0.25 + 0.004;
    const bandHeight = 0.242 * vSpan;
    const vTop = bandTop;
    const vBot = bandTop + bandHeight;

    // Baked vertical AO: slightly darker at ground base, shadow under eaves
    const botAo = 0.68;
    const topAo = 0.92;

    // Triangle 1: A_bot, B_bot, B_top
    wallPos.push3(ax, yBot, az); wallPos.push3(bx, yBot, bz); wallPos.push3(bx, yTop, bz);
    wallNorm.push3(nx, 0, nz); wallNorm.push3(nx, 0, nz); wallNorm.push3(nx, 0, nz);
    wallUv.push2(uStart, vBot); wallUv.push2(uEnd, vBot); wallUv.push2(uEnd, vTop);
    wallCol.push3(tintR * botAo, tintG * botAo, tintB * botAo);
    wallCol.push3(tintR * botAo, tintG * botAo, tintB * botAo);
    wallCol.push3(tintR * topAo, tintG * topAo, tintB * topAo);
    wallElev.push1(elev); wallElev.push1(elev); wallElev.push1(elev);

    // Triangle 2: A_bot, B_top, A_top
    wallPos.push3(ax, yBot, az); wallPos.push3(bx, yTop, bz); wallPos.push3(ax, yTop, az);
    wallNorm.push3(nx, 0, nz); wallNorm.push3(nx, 0, nz); wallNorm.push3(nx, 0, nz);
    wallUv.push2(uStart, vBot); wallUv.push2(uEnd, vTop); wallUv.push2(uStart, vTop);
    wallCol.push3(tintR * botAo, tintG * botAo, tintB * botAo);
    wallCol.push3(tintR * topAo, tintG * topAo, tintB * topAo);
    wallCol.push3(tintR * topAo, tintG * topAo, tintB * topAo);
    wallElev.push1(elev); wallElev.push1(elev); wallElev.push1(elev);
  };

  if (mvtBuf) {
    const vt = new VectorTile(new PbfReader(mvtBuf));
    const layer = vt.layers.building;
    if (layer) {
      const mvtMinX = qx * 2048;
      const mvtMaxX = (qx + 1) * 2048;
      const mvtMinY = qy * 2048;
      const mvtMaxY = (qy + 1) * 2048;
      const mvtToMeters = tileSizeMeters / 2048;

      for (let fi = 0; fi < layer.length; fi++) {
        const feat = layer.feature(fi);
        const props = feat.properties;
        if (props.is_underground === true) continue;

        const rawRings = feat.loadGeometry();
        if (!rawRings || rawRings.length === 0) continue;

        const polygons = classifyRings(rawRings);
        for (const poly of polygons) {
          if (poly.length === 0 || poly[0].length < 3) continue;

          // Compute MVT centroid of outer ring to assign cleanly to one z=15 quadrant
          const outerRaw = poly[0];
          let sumPx = 0, sumPy = 0;
          for (let i = 0; i < outerRaw.length; i++) {
            sumPx += outerRaw[i].x;
            sumPy += outerRaw[i].y;
          }
          const cPx = sumPx / outerRaw.length;
          const cPy = sumPy / outerRaw.length;
          if (cPx < mvtMinX || cPx >= mvtMaxX || cPy < mvtMinY || cPy >= mvtMaxY) {
            continue;
          }

          const outer = cleanRing(
            outerRaw.map((p) => [(p.x - mvtMinX) * mvtToMeters, (p.y - mvtMinY) * mvtToMeters]),
            true
          );
          if (outer.length < 3) continue;

          const holes: [number, number][][] = [];
          for (let hi = 1; hi < poly.length; hi++) {
            const hRing = cleanRing(
              poly[hi].map((p) => [(p.x - mvtMinX) * mvtToMeters, (p.y - mvtMinY) * mvtToMeters]),
              false
            );
            if (hRing.length >= 3) holes.push(hRing);
          }

          const areaM2 = Math.abs(signedAreaXZ(outer));
          if (areaM2 < 9) continue;
          buildingCount++;

          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          let cx = 0, cz = 0;
          for (const [vx, vz] of outer) {
            if (vx < minX) minX = vx;
            if (vx > maxX) maxX = vx;
            if (vz < minZ) minZ = vz;
            if (vz > maxZ) maxZ = vz;
            cx += vx;
            cz += vz;
          }
          cx /= outer.length;
          cz /= outer.length;

          // Mark building footprint on treeMask so trees never sprout inside houses
          // For larger buildings, test exact polygon containment so plaza/street trees next to L-shapes stay intact
          const gx0 = Math.max(0, Math.floor((minX / tileSizeMeters) * TREE_GRID));
          const gx1 = Math.min(TREE_GRID - 1, Math.floor((maxX / tileSizeMeters) * TREE_GRID));
          const gz0 = Math.max(0, Math.floor((minZ / tileSizeMeters) * TREE_GRID));
          const gz1 = Math.min(TREE_GRID - 1, Math.floor((maxZ / tileSizeMeters) * TREE_GRID));
          const useExactMask = (gx1 - gx0 + 1) * (gz1 - gz0 + 1) > 6;
          const cellM = tileSizeMeters / TREE_GRID;
          for (let gz = gz0; gz <= gz1; gz++) {
            for (let gx = gx0; gx <= gx1; gx++) {
              if (!useExactMask || pointInPolyXZ((gx + 0.5) * cellM, (gz + 0.5) * cellM, outer)) {
                treeMask[gz * TREE_GRID + gx] = 1;
              }
            }
          }

          // Sample terrain height at building centroid
          const demU = demSubX + (cx / tileSizeMeters) / 8;
          const demV = demSubY + (cz / tileSizeMeters) / 8;
          const groundElev = sampleTerrarium(demPixels, demU, demV);

          const hId = hashStr(String(props.id || `${fi}_${Math.round(cx)}_${Math.round(cz)}`));
          const cls = String(props.class || props.subtype || '');
          const propHeight = Number(props.height) || 0;
          const propFloors = Number(props.num_floors) || 0;
          const baseMinH = Number(props.min_height) || 0;

          const isTower =
            propHeight >= 9.5 ||
            propFloors >= 3 ||
            cls === 'apartments' ||
            cls === 'hotel' ||
            cls === 'office';
          const isIndustrial =
            cls === 'industrial' || cls === 'warehouse' || cls === 'hangar';
          const isCommercial =
            !isTower &&
            !isIndustrial &&
            (areaM2 >= 420 ||
              cls === 'commercial' ||
              cls === 'retail' ||
              cls === 'supermarket' ||
              cls === 'school' ||
              cls === 'hospital' ||
              cls === 'civic');

          let wallH = 3.5;
          let band = 0;
          let vSpan = 1.0;

          if (isTower) {
            band = 1;
            wallH = propHeight > 0 ? propHeight : propFloors > 0 ? propFloors * 3.1 : 14.5 + (hId % 4) * 3.1;
            const estFloors = Math.max(2, Math.round(wallH / 3.1));
            vSpan = Math.min(1.0, Math.max(0.5, estFloors / 4));
          } else if (isIndustrial) {
            band = 3;
            wallH = propHeight > 0 ? propHeight : propFloors > 0 ? propFloors * 3.5 : 6.2;
          } else if (isCommercial) {
            band = 2;
            wallH = propHeight > 0 ? propHeight : propFloors > 0 ? propFloors * 3.4 : areaM2 > 1600 ? 7.6 : 5.2;
            vSpan = wallH < 5 ? 0.55 : 1.0;
          } else if (areaM2 < 28 && propHeight <= 0) {
            band = 0;
            wallH = 2.6;
          } else {
            band = 0;
            const twoStory = propFloors === 2 || (propHeight >= 5.2 && propHeight < 9.5) || (areaM2 > 175 && hId % 4 === 0);
            wallH = propHeight > 0 ? propHeight : twoStory ? 5.6 : 3.2 + (hId % 3) * 0.35;
            if (twoStory) {
              band = 1;
              vSpan = 0.5;
            }
          }

          const yBot = baseMinH > 0 ? baseMinH : -1.5; // -1.5m foundation skirt into sloped terrain
          const yTop = (baseMinH > 0 ? baseMinH : 0) + wallH;

          const pal = WALL_PALETTES[hId % WALL_PALETTES.length];
          const [tintR, tintG, tintB] = isTower
            ? [0.95, 0.96, 0.98]
            : isIndustrial
              ? [0.9, 0.92, 0.94]
              : pal;

          // Emit outer walls + hole walls
          let uCursor = 0;
          const emitWalls = (ring: [number, number][]) => {
            for (let i = 0; i < ring.length; i++) {
              const [ax, az] = ring[i];
              const [bx, bz] = ring[(i + 1) % ring.length];
              const segLen = Math.hypot(bx - ax, bz - az);
              const uNext = uCursor + segLen / 6.0;
              pushWallQuad(ax, az, bx, bz, yBot, yTop, groundElev, band, vSpan, tintR, tintG, tintB, uCursor, uNext);
              uCursor = uNext;
            }
          };
          emitWalls(outer);
          for (const h of holes) emitWalls(h);

          const centroidU = cx / tileSizeMeters;
          const centroidV = cz / tileSizeMeters;

          // Check if residential house gets a real 4-slope pitched/hipped 3D roof
          let pitchedBuilt = false;
          if (!isTower && !isIndustrial && !isCommercial && holes.length === 0 && outer.length <= 8 && areaM2 >= 26 && areaM2 < 360) {
            // Longest-edge OBB
            let bestLen = 0;
            let bestUx = 1, bestUz = 0;
            for (let i = 0; i < outer.length; i++) {
              const [ax, az] = outer[i];
              const [bx, bz] = outer[(i + 1) % outer.length];
              const d = Math.hypot(bx - ax, bz - az);
              if (d > bestLen) {
                bestLen = d;
                bestUx = (bx - ax) / d;
                bestUz = (bz - az) / d;
              }
            }
            const bestVx = -bestUz;
            const bestVz = bestUx;

            let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
            for (const [px, pz] of outer) {
              const u = (px - cx) * bestUx + (pz - cz) * bestUz;
              const v = (px - cx) * bestVx + (pz - cz) * bestVz;
              if (u < uMin) uMin = u;
              if (u > uMax) uMax = u;
              if (v < vMin) vMin = v;
              if (v > vMax) vMax = v;
            }
            const obbL = uMax - uMin;
            const obbW = vMax - vMin;
            const rectRatio = areaM2 / Math.max(1, obbL * obbW);

            if (rectRatio >= 0.78 && obbW >= 3.2 && obbL >= 3.5) {
              const uMid = (uMin + uMax) * 0.5;
              const vMid = (vMin + vMax) * 0.5;
              const inset = Math.min(obbW * 0.44, obbL * 0.38);
              const halfRidge = Math.max(0.15, obbL * 0.5 - inset);
              const r0x = cx + bestUx * (uMid - halfRidge) + bestVx * vMid;
              const r0z = cz + bestUz * (uMid - halfRidge) + bestVz * vMid;
              const r1x = cx + bestUx * (uMid + halfRidge) + bestVx * vMid;
              const r1z = cz + bestUz * (uMid + halfRidge) + bestVz * vMid;
              const roofH = yTop + Math.min(2.3, Math.max(1.05, obbW * 0.21));

              if (pointInPolyXZ(r0x, r0z, outer) && pointInPolyXZ(r1x, r1z, outer)) {
                const sideIdx = outer.map(([px, pz]) =>
                  (px - cx) * bestUx + (pz - cz) * bestUz < uMid ? 0 : 1
                );

                // Verify all candidate triangles have positive outward CCW area in (X, Z) before emitting
                let allValid = true;
                const checkArea = (ax: number, az: number, bx: number, bz: number, rx: number, rz: number) =>
                  (bx - ax) * (rz - az) - (bz - az) * (rx - ax) < -0.04;

                for (let i = 0; i < outer.length; i++) {
                  const [ax, az] = outer[i];
                  const [bx, bz] = outer[(i + 1) % outer.length];
                  const sa = sideIdx[i];
                  const sb = sideIdx[(i + 1) % outer.length];
                  if (sa === sb) {
                    const rx = sa === 0 ? r0x : r1x;
                    const rz = sa === 0 ? r0z : r1z;
                    if (!checkArea(ax, az, bx, bz, rx, rz)) {
                      allValid = false;
                      break;
                    }
                  } else if (sa === 0 && sb === 1) {
                    if (!checkArea(ax, az, bx, bz, r1x, r1z) || !checkArea(ax, az, r1x, r1z, r0x, r0z)) {
                      allValid = false;
                      break;
                    }
                  } else {
                    if (!checkArea(ax, az, bx, bz, r0x, r0z) || !checkArea(ax, az, r0x, r0z, r1x, r1z)) {
                      allValid = false;
                      break;
                    }
                  }
                }

                if (allValid) {
                  for (let i = 0; i < outer.length; i++) {
                    const [ax, az] = outer[i];
                    const [bx, bz] = outer[(i + 1) % outer.length];
                    const sa = sideIdx[i];
                    const sb = sideIdx[(i + 1) % outer.length];
                    if (sa === sb) {
                      const rx = sa === 0 ? r0x : r1x;
                      const rz = sa === 0 ? r0z : r1z;
                      pushRoofTri(ax, yTop, az, bx, yTop, bz, rx, roofH, rz, groundElev, centroidU, centroidV, 0.14, 1.06);
                    } else if (sa === 0 && sb === 1) {
                      pushRoofTri(ax, yTop, az, bx, yTop, bz, r1x, roofH, r1z, groundElev, centroidU, centroidV, 0.14, 1.06);
                      pushRoofTri(ax, yTop, az, r1x, roofH, r1z, r0x, roofH, r0z, groundElev, centroidU, centroidV, 0.14, 1.06);
                    } else {
                      pushRoofTri(ax, yTop, az, bx, yTop, bz, r0x, roofH, r0z, groundElev, centroidU, centroidV, 0.14, 1.06);
                      pushRoofTri(ax, yTop, az, r0x, roofH, r0z, r1x, roofH, r1z, groundElev, centroidU, centroidV, 0.14, 1.06);
                    }
                  }
                  pitchedBuilt = true;
                }
              }
            }
          }

          if (!pitchedBuilt) {
            // Flat / Parapet Roof mapped with exact Google Satellite tile imagery
            const flatCoords: number[] = [];
            const holeIndices: number[] = [];
            for (const [vx, vz] of outer) flatCoords.push(vx, vz);
            for (const h of holes) {
              holeIndices.push(flatCoords.length / 2);
              for (const [vx, vz] of h) flatCoords.push(vx, vz);
            }
            const tris = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : undefined, 2);
            const insetF = areaM2 < 260 ? 0.12 : 0.03;
            for (let t = 0; t < tris.length; t += 3) {
              const i0 = tris[t] * 2;
              const i1 = tris[t + 1] * 2;
              const i2 = tris[t + 2] * 2;
              pushRoofTri(
                flatCoords[i0], yTop, flatCoords[i0 + 1],
                flatCoords[i1], yTop, flatCoords[i1 + 1],
                flatCoords[i2], yTop, flatCoords[i2 + 1],
                groundElev, centroidU, centroidV, insetF, 1.04
              );
            }

            // Architectural rooftop penthouse / water-tank box on tall condos
            if (isTower && areaM2 >= 80 && pointInPolyXZ(cx, cz, outer)) {
              const pw = Math.min(5.2, Math.sqrt(areaM2) * 0.24);
              const ph = 2.6;
              const p0x = cx - pw * 0.5, p1x = cx + pw * 0.5;
              const p0z = cz - pw * 0.5, p1z = cz + pw * 0.5;
              const py0 = yTop, py1 = yTop + ph;
              pushWallQuad(p0x, p0z, p0x, p1z, py0, py1, groundElev, 3, 0.35, 0.85, 0.87, 0.9, 0, 0.5);
              pushWallQuad(p0x, p1z, p1x, p1z, py0, py1, groundElev, 3, 0.35, 0.85, 0.87, 0.9, 0, 0.5);
              pushWallQuad(p1x, p1z, p1x, p0z, py0, py1, groundElev, 3, 0.35, 0.85, 0.87, 0.9, 0, 0.5);
              pushWallQuad(p1x, p0z, p0x, p0z, py0, py1, groundElev, 3, 0.35, 0.85, 0.87, 0.9, 0, 0.5);
              pushRoofTri(p0x, py1, p0z, p0x, py1, p1z, p1x, py1, p1z, groundElev, centroidU, centroidV, 0.05, 0.92);
              pushRoofTri(p0x, py1, p0z, p1x, py1, p1z, p1x, py1, p0z, groundElev, centroidU, centroidV, 0.05, 0.92);
            }
          }
        }
      }
    }
  }

  // Extract 3D green tree canopy points from Google Satellite outside building footprints
  const treeList: number[] = [];
  if (satRes.treeRgb) {
    const rgb = satRes.treeRgb;
    for (let gy = 2; gy < TREE_GRID - 2; gy += 2) {
      for (let gx = 2; gx < TREE_GRID - 2; gx += 2) {
        if (treeMask[gy * TREE_GRID + gx]) continue;
        // Require a 3x3 non-building cushion so trees don't clip house eaves
        if (
          treeMask[(gy - 1) * TREE_GRID + gx] ||
          treeMask[(gy + 1) * TREE_GRID + gx] ||
          treeMask[gy * TREE_GRID + (gx - 1)] ||
          treeMask[gy * TREE_GRID + (gx + 1)]
        ) {
          continue;
        }
        const pi = (gy * TREE_GRID + gx) * 4;
        const r = rgb[pi];
        const g = rgb[pi + 1];
        const b = rgb[pi + 2];
        if (g >= 40 && g <= 152 && g > r * 1.1 && g > b * 1.18 && g - Math.max(r, b) >= 8) {
          const seed = (gx * 73856093) ^ (gy * 19349663) ^ (x15 * 83492791);
          const jx = ((seed & 255) / 255 - 0.5) * 1.1;
          const jz = (((seed >> 8) & 255) / 255 - 0.5) * 1.1;
          const cellM = tileSizeMeters / TREE_GRID;
          const tx = (gx + 0.5 + jx) * cellM;
          const tz = (gy + 0.5 + jz) * cellM;
          const elev = sampleTerrarium(demPixels, demSubX + tx / tileSizeMeters / 8, demSubY + tz / tileSizeMeters / 8);
          const scale = 1.25 + (((seed >> 16) & 255) / 255) * 1.25;
          const rotY = (((seed >> 20) & 255) / 255) * Math.PI * 2;
          const cr = Math.min(1.0, (r / 255) * 1.38 + 0.1);
          const cg = Math.min(1.0, (g / 255) * 1.42 + 0.14);
          const cb = Math.min(1.0, (b / 255) * 1.32 + 0.08);
          treeList.push(tx, elev, tz, scale, rotY, cr, cg, cb);
        }
      }
    }
  }

  const roofPosArr = roofPos.finish();
  const roofNormArr = roofNorm.finish();
  const roofUvArr = roofUv.finish();
  const roofColArr = roofCol.finish();
  const roofElevArr = roofElev.finish();
  const wallPosArr = wallPos.finish();
  const wallNormArr = wallNorm.finish();
  const wallUvArr = wallUv.finish();
  const wallColArr = wallCol.finish();
  const wallElevArr = wallElev.finish();
  const treeArr = new Float32Array(treeList);

  return {
    reqId,
    x15,
    y15,
    tileSizeMeters,
    roofPos: roofPosArr,
    roofNorm: roofNormArr,
    roofUv: roofUvArr,
    roofCol: roofColArr,
    roofElev: roofElevArr,
    wallPos: wallPosArr,
    wallNorm: wallNormArr,
    wallUv: wallUvArr,
    wallCol: wallColArr,
    wallElev: wallElevArr,
    treeData: treeArr,
    satBitmap: satRes.bitmap,
    buildingCount,
  };
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  buildChunk(req)
    .then((res) => {
      const transfers: Transferable[] = [
        res.roofPos.buffer,
        res.roofNorm.buffer,
        res.roofUv.buffer,
        res.roofCol.buffer,
        res.roofElev.buffer,
        res.wallPos.buffer,
        res.wallNorm.buffer,
        res.wallUv.buffer,
        res.wallCol.buffer,
        res.wallElev.buffer,
        res.treeData.buffer,
      ];
      if (res.satBitmap) transfers.push(res.satBitmap);
      ctx.postMessage(res, transfers);
    })
    .catch((err) => {
      ctx.postMessage({
        reqId: req.reqId,
        x15: req.x15,
        y15: req.y15,
        tileSizeMeters: 1100,
        roofPos: new Float32Array(0),
        roofNorm: new Float32Array(0),
        roofUv: new Float32Array(0),
        roofCol: new Float32Array(0),
        roofElev: new Float32Array(0),
        wallPos: new Float32Array(0),
        wallNorm: new Float32Array(0),
        wallUv: new Float32Array(0),
        wallCol: new Float32Array(0),
        wallElev: new Float32Array(0),
        treeData: new Float32Array(0),
        satBitmap: null,
        buildingCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    });
};
