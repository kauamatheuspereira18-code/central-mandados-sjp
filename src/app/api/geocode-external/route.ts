import { NextRequest, NextResponse } from 'next/server';

interface GeocodeExternalResult {
  found: boolean;
  lat?: string;
  lon?: string;
  road?: string;
  suburb?: string;
  city?: string;
  state?: string;
  display_name?: string;
}

const MAX_CACHE = 500;
const geoCache = new Map<string, GeocodeExternalResult>();

function setCache(key: string, val: GeocodeExternalResult) {
  if (geoCache.size >= MAX_CACHE) {
    const first = geoCache.keys().next().value;
    if (first !== undefined) geoCache.delete(first);
  }
  geoCache.set(key, val);
}

function normSimple(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_ROAD = new Set([
  'rua', 'r', 'avenida', 'av', 'estrada', 'estr', 'travessa', 'tv', 'rodovia', 'rod',
  'alameda', 'al', 'praca', 'pc', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'dr',
  'prof', 'pref', 'ver', 'sao', 'santa', 'santo', 'pr', 'sc', 'sp', 'rs', 'mg', 'brasil',
]);

function extractCoreTokens(q: string): string[] {
  const streetPart = q.split(',')[0].replace(/\s+\d{1,5}[a-z]?\b.*$/i, '').trim();
  return normSimple(streetPart)
    .split(' ')
    .filter((t) => t.length >= 2 && !STOP_ROAD.has(t));
}

function matchesRoad(targetTokens: string[], candidateText: string): boolean {
  if (targetTokens.length === 0) return true;
  const candSet = new Set(normSimple(candidateText).split(' '));
  let hits = 0;
  for (const t of targetTokens) {
    if (candSet.has(t)) hits++;
  }
  return targetTokens.length <= 2 ? hits === targetTokens.length : hits / targetTokens.length >= 0.7;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 2200): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(id);
  }
}

async function queryGoogleTbmMap(q: string, targetTokens: string[]): Promise<GeocodeExternalResult | null> {
  try {
    const hasLocationHint =
      /\b(?:pr|sc|sp|rs|mg|rj|df|go|ba|ms|mt|es|pe|ce|brasil|parana|santa catarina|sao paulo|rio de janeiro|belo horizonte|porto alegre|florianopolis|joinville|itajai|blumenau|curitiba|londrina|maringa|cascavel|ponta grossa|pinhais|araucaria|colombo|fazenda rio grande|piraquara)\b/i.test(
        normSimple(q)
      ) || q.includes(',');
    const gUrl = new URL('https://www.google.com/search');
    gUrl.searchParams.set('tbm', 'map');
    gUrl.searchParams.set('q', /\bbrasil\b/i.test(q) ? q : hasLocationHint ? `${q}, Brasil` : `${q}, Paraná, Brasil`);
    gUrl.searchParams.set('hl', 'pt-BR');

    const gRes = await fetchWithTimeout(
      gUrl.toString(),
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      },
      2200
    );
    if (!gRes.ok) return null;

    let body = await gRes.text();
    if (body.startsWith(")]}'")) body = body.slice(4);
    const parsed = JSON.parse(body);
    const items = parsed?.[0]?.[1];
    if (!Array.isArray(items)) return null;

    for (const it of items.slice(0, 6)) {
      const p = Array.isArray(it) ? it[14] : null;
      if (!Array.isArray(p)) continue;
      const title = String(p[11] || '');
      const addr = String(p[39] || p[18] || '');
      const coord = p[9];
      if (!Array.isArray(coord) || typeof coord[2] !== 'number' || typeof coord[3] !== 'number') {
        continue;
      }

      // Garante que o logradouro retornado corresponde à rua buscada (evita estabelecimentos homônimos tipo "Bar do Bahia")
      const addrRoadPart = addr.split(' - ').find((seg) =>
        /^(?:r\.|rua|av\.|avenida|tv\.|travessa|estr\.|estrada|rod\.|rodovia|al\.|alameda|praça|praca)\b/i.test(
          seg.trim()
        )
      ) || title;

      if (!matchesRoad(targetTokens, `${title} ${addrRoadPart}`)) continue;

      // Extrai cidade e UF da string formatada do Google: "... - Bairro, Cidade - UF, CEP, Brasil"
      let city = '';
      let state = 'Paraná';
      let suburb = '';
      const cityUfMatch = addr.match(/,\s*([^,-]+?)\s*-\s*([A-Z]{2})(?:,\s*\d{5}-\d{3}|,\s*Brasil|$)/);
      if (cityUfMatch) {
        city = cityUfMatch[1].trim();
        state = cityUfMatch[2].trim();
      }
      const dashParts = addr.split(/\s+-\s+/);
      if (dashParts.length >= 2) {
        const candBairro = dashParts[dashParts.length - 2]?.split(',')[0]?.trim() || '';
        if (candBairro && !candBairro.includes(city)) suburb = candBairro;
      }

      return {
        found: true,
        lat: String(coord[2]),
        lon: String(coord[3]),
        road: addrRoadPart.split(',')[0].trim() || title,
        suburb,
        city,
        state,
        display_name: addr || title,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function queryNominatim(q: string, targetTokens: string[]): Promise<GeocodeExternalResult | null> {
  try {
    const hasLocationHint =
      /\b(?:pr|sc|sp|rs|mg|rj|df|go|ba|ms|mt|es|pe|ce|brasil|parana|santa catarina|sao paulo|rio de janeiro|belo horizonte|porto alegre|florianopolis|joinville|itajai|blumenau|curitiba|londrina|maringa|cascavel|ponta grossa|pinhais|araucaria|colombo|fazenda rio grande|piraquara)\b/i.test(
        normSimple(q)
      ) || q.includes(',');
    const queryStr = /\bbrasil\b/i.test(q) ? q : hasLocationHint ? `${q}, Brasil` : `${q}, Paraná, Brasil`;
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', queryStr);
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '5');
    url.searchParams.set('countrycodes', 'br');

    const res = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          'User-Agent': 'SJP-Central-Mandados-TJPR/2.0 (triagem-territorial)',
          Accept: 'application/json',
        },
      },
      2200
    );
    if (!res.ok) return null;

    const items = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      address?: Record<string, string>;
    }>;

    const hit = items.find(
      (item) =>
        item.address?.road && matchesRoad(targetTokens, `${item.address.road} ${item.display_name}`)
    );

    if (!hit) return null;
    const addr = hit.address || {};
    const city = addr.city || addr.town || addr.municipality || addr.village || addr.county || '';
    return {
      found: true,
      lat: hit.lat,
      lon: hit.lon,
      road: addr.road || '',
      suburb: addr.suburb || addr.neighbourhood || '',
      city,
      state: addr.state || '',
      display_name: hit.display_name,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q || q.length < 3) {
    return NextResponse.json({ found: false }, { status: 400 });
  }

  const cacheKey = normSimple(q);
  const cached = geoCache.get(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  const targetTokens = extractCoreTokens(q);

  // Executa Google tbm=map e Nominatim em paralelo (ambos com timeout rígido de 2.2s, sem Photon morto)
  const [gSettled, nSettled] = await Promise.allSettled([
    queryGoogleTbmMap(q, targetTokens),
    queryNominatim(q, targetTokens),
  ]);

  const gHit = gSettled.status === 'fulfilled' ? gSettled.value : null;
  const nHit = nSettled.status === 'fulfilled' ? nSettled.value : null;

  const best = gHit?.found ? gHit : nHit?.found ? nHit : { found: false };
  setCache(cacheKey, best);
  return NextResponse.json(best, { status: 200 });
}
