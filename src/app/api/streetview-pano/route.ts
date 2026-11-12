import { NextRequest, NextResponse } from 'next/server';

const RPC_URL =
  'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch';
const EMBED_API_KEY = 'AIzaSyCmL18misQw9KdwqGaw3zHkitj8vG6QF2Y';

function calcBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return Number(((toDeg(Math.atan2(y, x)) + 360) % 360).toFixed(1));
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const ABBR_MAP: Record<string, string> = {
  r: 'rua',
  av: 'avenida',
  estr: 'estrada',
  tv: 'travessa',
  trav: 'travessa',
  rod: 'rodovia',
  al: 'alameda',
  pc: 'praca',
  pca: 'praca',
  pref: 'prefeito',
  dr: 'doutor',
  dra: 'doutora',
  prof: 'professor',
  profa: 'professora',
  ver: 'vereador',
  dep: 'deputado',
  sen: 'senador',
  pres: 'presidente',
  cel: 'coronel',
  mal: 'marechal',
  ten: 'tenente',
  cap: 'capitao',
  gen: 'general',
  pe: 'padre',
  des: 'desembargador',
  eng: 'engenheiro',
  gov: 'governador',
  com: 'comendador',
  exp: 'expedicionario',
  alm: 'almirante',
  brig: 'brigadeiro',
  maj: 'major',
  sgt: 'sargento',
  sarg: 'sargento',
  min: 'ministro',
  visc: 'visconde',
  cons: 'conselheiro',
  card: 'cardeal',
  mons: 'monsenhor',
  marq: 'marques',
  sta: 'santa',
  sto: 'santo',
};

const STREET_TYPES = new Set([
  'rua',
  'avenida',
  'travessa',
  'estrada',
  'rodovia',
  'alameda',
  'praca',
  'largo',
]);

const SKIP_TOKENS = new Set([
  ...STREET_TYPES,
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'prefeito',
  'vereador',
  'doutor',
  'doutora',
  'professor',
  'professora',
  'sao',
  'santa',
  'santo',
]);

function expandStreetTokens(raw: string): string[] {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBR_MAP[t] || t);
}

function panoAddressMatchesStreet(panoAddr: string, targetStreet: string): boolean {
  if (!targetStreet || !panoAddr) return false;
  const streetPart = panoAddr.split('·')[0] || panoAddr;
  const pTokens = expandStreetTokens(streetPart).filter((t) => !/^\d+$/.test(t));
  const tTokens = expandStreetTokens(targetStreet).filter((t) => !/^\d+$/.test(t));

  const pType = pTokens.find((t) => STREET_TYPES.has(t));
  const tType = tTokens.find((t) => STREET_TYPES.has(t));
  if (pType && tType && pType !== tType) return false;

  const pCore = new Set(pTokens.filter((t) => !SKIP_TOKENS.has(t)));
  const tCore = tTokens.filter((t) => !SKIP_TOKENS.has(t));
  if (tCore.length === 0) return false;

  let hits = 0;
  for (const tk of tCore) {
    if (pCore.has(tk)) hits++;
  }
  return tCore.length <= 2 ? hits === tCore.length : hits / tCore.length >= 0.75;
}

interface ParsedPano {
  isOfficialCar: boolean;
  panoId: string;
  panoLat: number;
  panoLon: number;
  address: string;
  captureDate: string | null;
}

async function querySingleImageSearch(lat: number, lon: number, radius: number): Promise<ParsedPano | null> {
  const payload = JSON.stringify([
    ['apiv3'],
    [[null, null, lat, lon], radius],
    [null, ['pt-BR', 'BR'], null, [null, null, 1], null, null, null, null, null, null, []],
    [[1, 2, 3, 4, 6, 8]],
  ]);

  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 4500);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Referer: 'https://www.google.com/',
        Origin: 'https://www.google.com',
        'Content-Type': 'application/json+protobuf',
        'X-Goog-Api-Key': EMBED_API_KEY,
      },
      body: payload,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const info = data?.[1];
    if (!info || !Array.isArray(info) || !info[1]) return null;

    const panoType = info[1]?.[0];
    const panoId = info[1]?.[1];
    const locBlock = info[5]?.[0]?.[1];
    const panoLat = locBlock?.[0]?.[2];
    const panoLon = locBlock?.[0]?.[3];
    if (!panoId || typeof panoLat !== 'number' || typeof panoLon !== 'number') return null;

    const addrParts: string[] = [];
    const rawAddr = info[3]?.[2];
    if (Array.isArray(rawAddr)) {
      for (const item of rawAddr) {
        if (Array.isArray(item) && typeof item[0] === 'string') {
          addrParts.push(item[0]);
        }
      }
    }

    const rawDate = info[6]?.[7];
    let captureDate: string | null = null;
    if (Array.isArray(rawDate) && rawDate.length >= 2) {
      captureDate = `${String(rawDate[1]).padStart(2, '0')}/${rawDate[0]}`;
    }

    return {
      isOfficialCar: panoType === 2,
      panoId: String(panoId),
      panoLat,
      panoLon,
      address: addrParts.join(' · '),
      captureDate,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

function pickBestCandidate(
  pool: Array<ParsedPano | null>,
  targetLat: number,
  targetLon: number,
  targetStreet: string
): ParsedPano | null {
  let bestMatchedCar: ParsedPano | null = null;
  let bestMatchedCarDist = Infinity;
  let bestAnyCar: ParsedPano | null = null;
  let bestAnyCarDist = Infinity;
  let bestFallback: ParsedPano | null = null;
  let bestFallbackDist = Infinity;

  for (const cand of pool) {
    if (!cand) continue;
    const d = haversineM(targetLat, targetLon, cand.panoLat, cand.panoLon);
    const matchesStreet = targetStreet ? panoAddressMatchesStreet(cand.address, targetStreet) : false;

    if (cand.isOfficialCar) {
      if (matchesStreet && d < bestMatchedCarDist) {
        bestMatchedCarDist = d;
        bestMatchedCar = cand;
      }
      if (d < bestAnyCarDist) {
        bestAnyCarDist = d;
        bestAnyCar = cand;
      }
    } else if (d < bestFallbackDist) {
      bestFallbackDist = d;
      bestFallback = cand;
    }
  }

  return bestMatchedCar || bestAnyCar || bestFallback;
}

const PANO_CACHE_MAX = 600;
const PANO_CACHE_TTL_MS = 30 * 60 * 1000;
const panoCache = new Map<string, { ts: number; body: Record<string, unknown> }>();

export async function GET(req: NextRequest) {
  const latStr = req.nextUrl.searchParams.get('lat');
  const lonStr = req.nextUrl.searchParams.get('lon');
  const targetStreet = (req.nextUrl.searchParams.get('street') || '').trim();
  const targetLat = parseFloat(latStr || '');
  const targetLon = parseFloat(lonStr || '');

  if (Number.isNaN(targetLat) || Number.isNaN(targetLon)) {
    return NextResponse.json({ found: false, error: 'Coordenadas inválidas' }, { status: 400 });
  }

  const cacheKey = `${targetLat.toFixed(5)},${targetLon.toFixed(5)}|${targetStreet.toLowerCase()}`;
  const cached = panoCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PANO_CACHE_TTL_MS) {
    return NextResponse.json(cached.body);
  }

  // 1. Tenta primeiro raios curtos (16m e 28m) em paralelo para evitar desvio para travessas de esquina
  const nearResults = await Promise.all([
    querySingleImageSearch(targetLat, targetLon, 16),
    querySingleImageSearch(targetLat, targetLon, 28),
  ]);
  const pool: Array<ParsedPano | null> = [...nearResults];
  let best = pickBestCandidate(pool, targetLat, targetLon, targetStreet);

  const needsStreetRing =
    !best ||
    !best.isOfficialCar ||
    (targetStreet && !panoAddressMatchesStreet(best.address, targetStreet));

  // 2. Se caiu em foto interna (type=10) ou em rua transversal de esquina, sonda anel ao redor (18m e 36m) para ficar exatamente na rua alvo
  if (needsStreetRing) {
    const offsets = [
      [0.00016, 0],
      [-0.00016, 0],
      [0, 0.00018],
      [0, -0.00018],
      [0.00034, 0],
      [-0.00034, 0],
      [0, 0.00038],
      [0, -0.00038],
    ];
    const ringCandidates = await Promise.all(
      offsets.map(([dLat, dLon]) => querySingleImageSearch(targetLat + dLat, targetLon + dLon, 24))
    );
    pool.push(...ringCandidates);
    best = pickBestCandidate(pool, targetLat, targetLon, targetStreet);
  }

  // 3. Fallback rural / rodovias (140m, 350m, 700m) apenas se não achou carro oficial próximo
  if (!best || !best.isOfficialCar) {
    const wider = await Promise.all(
      [140, 350, 700].map((rad) => querySingleImageSearch(targetLat, targetLon, rad))
    );
    pool.push(...wider);
    best = pickBestCandidate(pool, targetLat, targetLon, targetStreet);
  }

  if (!best) {
    return NextResponse.json({ found: false });
  }

  const distM = Math.round(haversineM(targetLat, targetLon, best.panoLat, best.panoLon));
  const heading =
    distM > 3 ? calcBearing(best.panoLat, best.panoLon, targetLat, targetLon) : 0;

  const out = {
    found: true,
    isOfficialCar: best.isOfficialCar,
    streetMatched: targetStreet ? panoAddressMatchesStreet(best.address, targetStreet) : true,
    panoId: best.panoId,
    panoLat: best.panoLat,
    panoLon: best.panoLon,
    heading,
    distanceMeters: distM,
    address: best.address,
    captureDate: best.captureDate,
  };
  if (panoCache.size >= PANO_CACHE_MAX) {
    const oldest = panoCache.keys().next().value;
    if (oldest !== undefined) panoCache.delete(oldest);
  }
  panoCache.set(cacheKey, { ts: Date.now(), body: out });

  return NextResponse.json(out);
}
