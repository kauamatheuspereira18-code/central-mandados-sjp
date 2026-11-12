import type { CoordClassification, GeoLayers, StreetSegment } from '@/types/mandados';

const ringBboxCache = new WeakMap<
  [number, number][],
  { minLat: number; maxLat: number; minLon: number; maxLon: number }
>();

function getRingBbox(ring: [number, number][]) {
  let box = ringBboxCache.get(ring);
  if (!box) {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const lat = ring[i][0];
      const lon = ring[i][1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    box = { minLat, maxLat, minLon, maxLon };
    ringBboxCache.set(ring, box);
  }
  return box;
}

export function pointInPolygon(lat: number, lon: number, ring: [number, number][]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  const box = getRingBbox(ring);
  if (lat < box.minLat || lat > box.maxLat || lon < box.minLon || lon > box.maxLon) {
    return false;
  }

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    const denom = yj - yi === 0 ? 1e-18 : yj - yi;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / denom + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Fast O(1)-bbox region label lookup for mousemove HUD (including KML border sliver snap). */
export function quickRegionAt(lat: number, lon: number, geo: GeoLayers): string {
  for (const poly of geo.oficiais_sjp) {
    if (pointInPolygon(lat, lon, poly.coords)) {
      return poly.regiao;
    }
  }
  if (pointInPolygon(lat, lon, geo.tijucas_sul)) {
    return 'Região 7';
  }
  if (pointInPolygon(lat, lon, geo.divisa_sjp)) {
    let bestReg = 'Divisa SJP';
    let bestD = 120;
    for (const poly of geo.oficiais_sjp) {
      const box = getRingBbox(poly.coords);
      if (lat < box.minLat - 0.002 || lat > box.maxLat + 0.002 || lon < box.minLon - 0.002 || lon > box.maxLon + 0.002) {
        continue;
      }
      const d = pointToRingDistanceMeters(lat, lon, poly.coords);
      if (d < bestD) {
        bestD = d;
        bestReg = poly.regiao;
      }
    }
    return bestReg;
  }
  return 'Fora da Comarca';
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointToSegmentDistanceMeters(
  lat: number,
  lon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const scaleLon = 111320 * cosLat;
  const scaleLat = 110540;
  const px = (lon - aLon) * scaleLon;
  const py = (lat - aLat) * scaleLat;
  const bx = (bLon - aLon) * scaleLon;
  const by = (bLat - aLat) * scaleLat;
  const lenSq = bx * bx + by * by;
  let t = lenSq === 0 ? 0 : (px * bx + py * by) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const dx = px - t * bx;
  const dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy);
}

export function pointToRingDistanceMeters(lat: number, lon: number, ring: [number, number][]): number {
  let minDist = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const d = pointToSegmentDistanceMeters(lat, lon, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

export function pointToSegmentsDistanceMeters(lat: number, lon: number, segs: StreetSegment[]): number {
  let minDist = Infinity;
  for (const seg of segs) {
    for (let i = 0; i < seg.p.length - 1; i++) {
      const d = pointToSegmentDistanceMeters(
        lat,
        lon,
        seg.p[i][0],
        seg.p[i][1],
        seg.p[i + 1][0],
        seg.p[i + 1][1]
      );
      if (d < minDist) minDist = d;
    }
  }
  return minDist;
}

export function parseCoordinates(text: string): { lat: number; lon: number; format: string } | null {
  // 1. DMS: 25°32'25.6"S 49°11'45.5"W (or O for Oeste)
  const dmsRegex =
    /(\d{1,2})\s*[°º]\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["″]|'')?\s*([NS])\s*[,;\s/]*(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["″]|'')?\s*([WOE])/i;
  const dms = text.match(dmsRegex);
  if (dms) {
    let lat = parseFloat(dms[1]) + parseFloat(dms[2]) / 60 + parseFloat(dms[3].replace(',', '.')) / 3600;
    if (dms[4].toUpperCase() === 'S') lat = -lat;
    let lon = parseFloat(dms[5]) + parseFloat(dms[6]) / 60 + parseFloat(dms[7].replace(',', '.')) / 3600;
    if (['W', 'O'].includes(dms[8].toUpperCase())) lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), format: 'GMS (Graus/Min/Seg)' };
    }
  }

  // 2. Decimal: -25.54045, -49.19599 OR -25,54045; -49,19599
  const decRegex =
    /(?:lat(?:itude)?\s*[:=]?\s*)?(-?\d{1,2}[.,]\d{3,8})\s*[,;\s/]+\s*(?:lon(?:gitude)?\s*[:=]?\s*)?(-?\d{1,3}[.,]\d{3,8})/i;
  const dec = text.match(decRegex);
  if (dec) {
    const lat = parseFloat(dec[1].replace(',', '.'));
    const lon = parseFloat(dec[2].replace(',', '.'));
    if (!Number.isNaN(lat) && !Number.isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), format: 'Decimal' };
    }
  }

  return null;
}

export function classifyCoordinates(lat: number, lon: number, geo: GeoLayers): CoordClassification {
  const alertas: string[] = [];

  // 1. Check critical R9 facility proximity (<= 140 m)
  const r9Pins = geo.pontos_criticos.filter((p) => p.regiao === 'Região 9');
  for (const pin of r9Pins) {
    const d = haversineMeters(lat, lon, pin.lat, pin.lon);
    if (d <= 140) {
      let basePoly = 'Região urbana SJP';
      for (const poly of geo.oficiais_sjp) {
        if (pointInPolygon(lat, lon, poly.coords)) {
          basePoly = poly.regiao;
          break;
        }
      }
      alertas.push(
        `Localizado a ${Math.round(d)} m de ${pin.nome}. No polígono físico do mapa cai em ${basePoly}, mas pela regra oficial da Central de Mandados vai para Região 9!`
      );
      return {
        lat,
        lon,
        regiao: 'Região 9',
        subtitulo: `${pin.nome} (Prioridade Oficial > ${basePoly})`,
        dentroComarca: true,
        municipioProvavel: 'São José dos Pinhais',
        camadaBase: basePoly,
        sliverAjustado: false,
        alertas,
      };
    }
  }

  // 2. Check municipal boundary of SJP and Tijucas do Sul
  const insideDivisaSJP = pointInPolygon(lat, lon, geo.divisa_sjp);
  const insideTijucas = pointInPolygon(lat, lon, geo.tijucas_sul);

  // 3. Check Colônia Castelhanos override (inside SJP SE valley -> Região 7!)
  const distCastelhanos = haversineMeters(lat, lon, geo.castelhanos_zona.center[0], geo.castelhanos_zona.center[1]);
  const inCastelhanosZone =
    insideDivisaSJP && (pointInPolygon(lat, lon, geo.castelhanos_zona.coords) || distCastelhanos <= 2500);
  if (inCastelhanosZone) {
    alertas.push(
      'PEGADINHA DO MAPA: No My Maps este ponto cai dentro da mancha da Área Rural (5), mas Colônia Castelhanos pertence oficialmente à Região 7!'
    );
    return {
      lat,
      lon,
      regiao: 'Região 7',
      subtitulo: 'Colônia Castelhanos (Regra Oficial > Polígono 5)',
      dentroComarca: true,
      municipioProvavel: 'São José dos Pinhais',
      camadaBase: 'Região 5 (KML) -> Override Região 7',
      sliverAjustado: false,
      alertas,
    };
  }

  // 4. Check Roseira de Campo Largo rural border rule (Região 6)
  const roseiraPin = geo.pontos_criticos.find((p) => p.id === 'roseira_cl');
  if (roseiraPin && haversineMeters(lat, lon, roseiraPin.lat, roseiraPin.lon) <= 1300) {
    alertas.push(
      'Roseira de Campo Largo (< 30 km do Fórum): listada explicitamente na Região 6 pelo sistema oficial.'
    );
    return {
      lat,
      lon,
      regiao: 'Região 6',
      subtitulo: 'Roseira de Campo Largo (< 30 km do Fórum)',
      dentroComarca: true,
      municipioProvavel: 'São José dos Pinhais',
      camadaBase: 'Região 6 (Regra Rural < 30 km)',
      sliverAjustado: false,
      alertas,
    };
  }

  // 5. Check Butiazinho / São Judas Tadeu trap proximity (Região 2)
  const butiazinhoPin = geo.pontos_criticos.find((p) => p.id === 'butiazinho');
  if (butiazinhoPin && haversineMeters(lat, lon, butiazinhoPin.lat, butiazinhoPin.lon) <= 750) {
    alertas.push(
      'ARMADILHA CORREIOS (Butiazinho / São Judas Tadeu): Mesmo que o CEP indique Parque da Fonte (R3), este ponto ao norte da BR-277 pertence à Região 2.'
    );
  }

  // 6. Check the 9 official KML polygons
  for (const poly of geo.oficiais_sjp) {
    if (pointInPolygon(lat, lon, poly.coords)) {
      const setorTxt = poly.setor ? ` — Setor ${poly.setor} (não existe 6A)` : '';
      return {
        lat,
        lon,
        regiao: poly.regiao,
        subtitulo: `Polígono oficial ${poly.regiao}${setorTxt}`,
        dentroComarca: true,
        municipioProvavel: 'São José dos Pinhais',
        camadaBase: `${poly.regiao}${poly.setor ? ` (${poly.setor})` : ''}`,
        sliverAjustado: false,
        alertas,
      };
    }
  }

  // 7. Check Tijucas do Sul polygon (Região 7)
  if (insideTijucas) {
    return {
      lat,
      lon,
      regiao: 'Região 7',
      subtitulo: 'Município de Tijucas do Sul (Comarca de SJP)',
      dentroComarca: true,
      municipioProvavel: 'Tijucas do Sul',
      camadaBase: 'Tijucas do Sul -> Região 7',
      sliverAjustado: false,
      alertas,
    };
  }

  // 8. If inside Divisa SJP municipal border yet missed the 9 KML polygons -> 3.27% KML border sliver!
  if (insideDivisaSJP) {
    let nearestPoly = geo.oficiais_sjp[0];
    let nearestDist = Infinity;
    for (const poly of geo.oficiais_sjp) {
      const d = pointToRingDistanceMeters(lat, lon, poly.coords);
      if (d < nearestDist) {
        nearestDist = d;
        nearestPoly = poly;
      }
    }
    alertas.push(
      `Ponto dentro da divisa municipal oficial de SJP em microfaixa de borda (${Math.round(nearestDist)} m do polígono ${nearestPoly.regiao}). Ajustado automaticamente pela divisa.`
    );
    return {
      lat,
      lon,
      regiao: nearestPoly.regiao,
      subtitulo: `Borda SJP ajustada -> ${nearestPoly.regiao} (${Math.round(nearestDist)} m)`,
      dentroComarca: true,
      municipioProvavel: 'São José dos Pinhais',
      camadaBase: `Divisa SJP / Borda ${nearestPoly.regiao}`,
      sliverAjustado: true,
      distanciaBordaM: Math.round(nearestDist),
      alertas,
    };
  }

  // 9. Outside SJP & outside Tijucas do Sul! Compute distance to nearest Comarca border
  const distSJP = pointToRingDistanceMeters(lat, lon, geo.divisa_sjp);
  const distTij = pointToRingDistanceMeters(lat, lon, geo.tijucas_sul);
  const minOutDist = Math.round(Math.min(distSJP, distTij));
  alertas.push(
    `Coordenada localizada fora dos limites oficiais de São José dos Pinhais e Tijucas do Sul (a ~${(minOutDist / 1000).toFixed(2)} km da divisa da Comarca).`
  );
  return {
    lat,
    lon,
    regiao: 'Fora da Comarca',
    subtitulo: `Fora dos limites de SJP e Tijucas do Sul (~${(minOutDist / 1000).toFixed(2)} km da divisa)`,
    dentroComarca: false,
    municipioProvavel: 'Fora da Comarca',
    camadaBase: 'Fora da Comarca',
    sliverAjustado: false,
    distanciaBordaM: minOutDist,
    alertas,
  };
}
