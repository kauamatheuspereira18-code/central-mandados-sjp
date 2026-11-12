import { NextRequest, NextResponse } from 'next/server';
import {
  canonicalizeNumberedStreetText,
  splitLeadingStreetIdentifier,
} from '@/lib/mandadoParser';

function normText(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandPtAbbr(s: string): string {
  const map: Record<string, string> = {
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
  return normText(s)
    .split(' ')
    .map((t) => map[t] || t)
    .join(' ');
}

const IGNORED_TOKENS = new Set([
  'rua',
  'avenida',
  'estrada',
  'travessa',
  'rodovia',
  'alameda',
  'praca',
  'largo',
  'beco',
  'servidao',
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

function haversineMetersSimple(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
}

function extractRoadSegmentOnly(text: string): string {
  const beforeDash = text.split(/\s+-\s+/)[0] || text;
  const { streetHead, tail } = splitLeadingStreetIdentifier(beforeDash.replace(/^Rua:\s*/i, 'Rua '));
  if (streetHead) return streetHead;
  return tail.split(',')[0].replace(/\s+\d{1,5}\s*$/, '').trim();
}

const ROAD_PREFIX_RE =
  /^(?:r\.?|rua|av\.?|avenida|rod\.?|rodovia|br|pr|sc|estr\.?|estrada|trav\.?|travessa|al\.?|alameda|p[çc]\.?|pra[çc]a|largo|via|servid[aã]o|marginal|rodoanel|contorno)\b/i;

function pickCleanRoadName(title: string, addr: string, fallbackRoad: string): string {
  const tSeg = extractRoadSegmentOnly(title);
  if (ROAD_PREFIX_RE.test(tSeg.trim())) return tSeg.trim();
  if (addr) {
    const firstPart = (addr.split(/\s+-\s+/)[0] || '').split(',')[0].trim();
    const aSeg = extractRoadSegmentOnly(firstPart);
    if (ROAD_PREFIX_RE.test(aSeg.trim())) return aSeg.trim();
  }
  return fallbackRoad;
}

function extractHighwayCode(s: string): string | null {
  const m = normText(s).match(/\b(br|pr)\s*0*(\d{2,3})\b/);
  return m ? `${m[1]}${m[2]}` : null;
}

function streetMatchesReturnedAddress(
  targetStreet: string,
  returnedText: string,
  allowedCity: string,
  returnedRoadName?: string
): boolean {
  const retNorm = expandPtAbbr(returnedText);
  const cityNorm = normText(allowedCity);
  if (!retNorm.includes(cityNorm)) return false;

  const targetHw = extractHighwayCode(targetStreet);
  const retHw = extractHighwayCode(returnedRoadName || returnedText);
  if (targetHw && retHw) {
    return targetHw === retHw;
  }

  const targetCanon = canonicalizeNumberedStreetText(targetStreet, true);
  const nonPrefixAll = targetCanon
    .split(' ')
    .filter((t) => t && !IGNORED_TOKENS.has(t) && t !== 'numero');

  const isNumberedOrLettered =
    nonPrefixAll.length > 0 && nonPrefixAll.every((t) => /^\d{1,3}[a-z]?$|^[a-z]$/.test(t));

  if (isNumberedOrLettered) {
    const roadOnly = extractRoadSegmentOnly(returnedRoadName || returnedText);
    const roadCanon = canonicalizeNumberedStreetText(roadOnly, true);
    const roadTokens = new Set(roadCanon.split(' ').filter((t) => t && !IGNORED_TOKENS.has(t)));
    return nonPrefixAll.every((tk) => roadTokens.has(tk));
  }

  const targetTokens = nonPrefixAll.filter((t) => !/^\d+$/.test(t));
  if (targetTokens.length === 0) return true;

  const retTokens = new Set(canonicalizeNumberedStreetText(returnedText, true).split(' '));
  let hits = 0;
  for (const tk of targetTokens) {
    if (retTokens.has(tk)) hits++;
  }
  const ratio = hits / targetTokens.length;
  return targetTokens.length <= 2 ? hits === targetTokens.length : ratio >= 0.75;
}

function extractBairroAndCep(addr: string): { bairro: string; postcode: string } {
  const cepMatch = addr.match(/\b(\d{5}-\d{3})\b/);
  const postcode = cepMatch ? cepMatch[1] : '';
  let bairro = '';
  const beforeCity = addr.split(/,\s*(?:São José dos Pinhais|Tijucas do Sul)\b/i)[0] || '';
  const dashParts = beforeCity.split(/\s+-\s+/);
  if (dashParts.length >= 2) {
    bairro = dashParts[dashParts.length - 1].trim();
  }
  return { bairro, postcode };
}

interface SourceHit {
  sourceKey: 'google_maps' | 'geosjp' | 'osm';
  sourceLabel: string;
  lat: number;
  lon: number;
  display_name: string;
  road: string;
  bairro: string;
  postcode: string;
  hasExactNumber: boolean;
  approximateMatch: boolean;
  bairroFallback: boolean;
  priority: number;
}

interface CachedPayload {
  ts: number;
  body: Record<string, unknown>;
}
const geocodeCache = new Map<string, CachedPayload>();
const CACHE_TTL_MS = 30 * 60 * 1000;

async function queryGoogleMaps(
  searchQ: string,
  allowedCity: string,
  targetStreetForCheck: string,
  houseNumStr: string | null,
  allowApprox: boolean,
  bairroHint = ''
): Promise<SourceHit | null> {
  const gUrl = new URL('https://www.google.com/search');
  gUrl.searchParams.set('tbm', 'map');
  gUrl.searchParams.set('q', searchQ);
  gUrl.searchParams.set('hl', 'pt-BR');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2400);
  try {
    const gRes = await fetch(gUrl.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!gRes.ok) return null;
    let body = await gRes.text();
    if (body.startsWith(")]}'")) body = body.slice(4);
    const parsed = JSON.parse(body);
    const items = parsed?.[0]?.[1];
    if (!Array.isArray(items)) return null;

    let approxFallback: SourceHit | null = null;
    let bestExact: SourceHit | null = null;
    const cityNorm = normText(allowedCity);
    const bairroNorm = normText(bairroHint);
    const targetCoreTokens = canonicalizeNumberedStreetText(targetStreetForCheck, true)
      .split(' ')
      .filter((t) => t.length >= 4 && !IGNORED_TOKENS.has(t) && !/^\d+$/.test(t));

    for (const it of items) {
      const p = Array.isArray(it) ? it[14] : null;
      if (!Array.isArray(p)) continue;
      const title = String(p[11] || '');
      const addr = String(p[39] || '');
      const coord = p[9];
      if (!Array.isArray(coord) || typeof coord[2] !== 'number' || typeof coord[3] !== 'number') {
        continue;
      }
      const combined = `${title} ${addr}`;
      const { bairro, postcode } = extractBairroAndCep(addr || title);

      if (streetMatchesReturnedAddress(targetStreetForCheck, combined, allowedCity, title)) {
        const cleanRoad = pickCleanRoadName(title, addr, targetStreetForCheck);
        const isPoiHijack = !ROAD_PREFIX_RE.test(title.trim());
        const headSeg = (addr || title).split(' - ')[0] || '';
        const roadHasNum = Boolean(
          houseNumStr &&
            new RegExp(`(?:^|\\D)${houseNumStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\D|$)`).test(
              headSeg
            )
        );
        const bairroMatchesHint = Boolean(
          bairroNorm &&
            (normText(bairro).includes(bairroNorm) || normText(addr).includes(bairroNorm))
        );
        const prio =
          (roadHasNum ? 95 : 80) +
          (bairroMatchesHint ? 12 : 0) -
          (isPoiHijack ? 6 : 0);

        const hit: SourceHit = {
          sourceKey: 'google_maps',
          sourceLabel: 'Google Maps',
          lat: coord[2],
          lon: coord[3],
          display_name: addr || title,
          road: cleanRoad,
          bairro: bairroMatchesHint && bairroHint ? bairroHint : bairro,
          postcode,
          hasExactNumber: roadHasNum,
          approximateMatch: false,
          bairroFallback: false,
          priority: prio,
        };
        if (!bestExact || hit.priority > bestExact.priority) {
          bestExact = hit;
        }
        if (bairroMatchesHint || (!isPoiHijack && !bairroNorm)) {
          return hit;
        }
        continue;
      }

      if (allowApprox && !approxFallback && normText(combined).includes(cityNorm)) {
        const roadSeg = pickCleanRoadName(title, addr, '');
        const retTokens = new Set(canonicalizeNumberedStreetText(roadSeg, true).split(' '));
        const surnameMatch = targetCoreTokens.some((tk) => tk.length >= 5 && retTokens.has(tk));
        const looksLikeStreet = ROAD_PREFIX_RE.test(title.trim());
        if (surnameMatch && looksLikeStreet) {
          approxFallback = {
            sourceKey: 'google_maps',
            sourceLabel: 'Google Maps (Correspondência Provável)',
            lat: coord[2],
            lon: coord[3],
            display_name: addr || title,
            road: roadSeg,
            bairro,
            postcode,
            hasExactNumber: Boolean(
              houseNumStr &&
                new RegExp(`(?:^|\\D)${houseNumStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\D|$)`).test(
                  title.split(' - ')[0] || ''
                )
            ),
            approximateMatch: true,
            bairroFallback: false,
            priority: 62,
          };
        }
      }
    }
    return bestExact || approxFallback;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function queryGeoSjp(
  targetStreetForCheck: string,
  houseNumber: string | null,
  bairroHint: string
): Promise<SourceHit | null> {
  const hwCode = extractHighwayCode(targetStreetForCheck);
  const origTokens = targetStreetForCheck
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[,.;:]/g, ''))
    .filter((t) => t.length >= 4 && !/[^\x00-\x7f]/.test(t) && !IGNORED_TOKENS.has(t.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  const coreTokens = canonicalizeNumberedStreetText(targetStreetForCheck, true)
    .split(' ')
    .filter((t) => t && !IGNORED_TOKENS.has(t) && t !== 'numero')
    .sort((a, b) => b.length - a.length);

  const anchorToken = origTokens[0] || coreTokens[0] || '';
  const safeAnchor = anchorToken.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const tasks: Array<Promise<SourceHit | null>> = [];

  // 2A. Número_Predial/MapServer/91 (76.326 imóveis numerados oficiais)
  if (houseNumber && (safeAnchor || hwCode)) {
    tasks.push(
      (async () => {
        const whereClause = hwCode
          ? `textstring='${houseNumber}' AND (UPPER(logradouro) LIKE '%${hwCode.slice(0, 2).toUpperCase()} ${hwCode.slice(2)}%' OR UPPER(logradouro) LIKE '%${hwCode.slice(0, 2).toUpperCase()}-${hwCode.slice(2)}%')`
          : /^\d+$/.test(safeAnchor)
          ? `textstring='${houseNumber}' AND (UPPER(logradouro) LIKE '% ${safeAnchor}' OR UPPER(logradouro) LIKE '% ${safeAnchor} %')`
          : `textstring='${houseNumber}' AND UPPER(logradouro) LIKE '%${safeAnchor}%'`;
        const gsUrl = new URL(
          'https://geo.sjp.pr.gov.br/server/rest/services/Numero_Predial/N%C3%BAmero_Predial/MapServer/91/query'
        );
        gsUrl.searchParams.set('where', whereClause);
        gsUrl.searchParams.set('outFields', 'logradouro,textstring,indfisc');
        gsUrl.searchParams.set('outSR', '4326');
        gsUrl.searchParams.set('resultRecordCount', '8');
        gsUrl.searchParams.set('f', 'json');

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        try {
          const res = await fetch(gsUrl.toString(), { signal: ctrl.signal, cache: 'no-store' });
          if (!res.ok) return null;
          const data = await res.json();
          const feats = (data?.features || []) as Array<{
            attributes?: Record<string, string>;
            geometry?: { x?: number; y?: number };
          }>;
          const matchFeat = feats.find((ft) => {
            const logra = String(ft.attributes?.logradouro || '');
            return (
              ft.geometry?.y &&
              ft.geometry?.x &&
              streetMatchesReturnedAddress(
                targetStreetForCheck,
                `${logra} São José dos Pinhais`,
                'São José dos Pinhais',
                logra
              )
            );
          });
          if (!matchFeat?.geometry?.y || !matchFeat?.geometry?.x) return null;
          const a = matchFeat.attributes || {};
          return {
            sourceKey: 'geosjp',
            sourceLabel: 'GeoSJP Número Predial Oficial',
            lat: matchFeat.geometry.y,
            lon: matchFeat.geometry.x,
            display_name: `${a.logradouro}, ${a.textstring || houseNumber}, São José dos Pinhais - PR`,
            road: a.logradouro || targetStreetForCheck,
            bairro: '',
            postcode: '',
            hasExactNumber: true,
            approximateMatch: false,
            bairroFallback: false,
            priority: 100,
          };
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      })()
    );
  }

  // 2B. Eixos_Viários Totais (FeatureServer/1897 — inclui BR, PR, EM rurais, R NÃO OFICIAL)
  if (safeAnchor.length >= 3 || hwCode) {
    tasks.push(
      (async () => {
        const whereClause = hwCode
          ? `UPPER(nomecplt) LIKE '%${hwCode.slice(0, 2).toUpperCase()} ${hwCode.slice(2)}%' OR UPPER(nomecplt) LIKE '%${hwCode.slice(0, 2).toUpperCase()}-${hwCode.slice(2)}%'`
          : `UPPER(nomecplt) LIKE '%${safeAnchor}%'`;
        const eUrl = new URL(
          'https://geo.sjp.pr.gov.br/server/rest/services/Sistema_Vi%C3%A1rio/Sistema_Vi%C3%A1rio/FeatureServer/1897/query'
        );
        eUrl.searchParams.set('where', whereClause);
        eUrl.searchParams.set('outFields', 'tipos,nomecplt');
        eUrl.searchParams.set('outSR', '4326');
        eUrl.searchParams.set('resultRecordCount', '8');
        eUrl.searchParams.set('f', 'json');

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        try {
          const res = await fetch(eUrl.toString(), { signal: ctrl.signal, cache: 'no-store' });
          if (!res.ok) return null;
          const data = await res.json();
          const feats = (data?.features || []) as Array<{
            attributes?: Record<string, string>;
            geometry?: { paths?: number[][][] };
          }>;
          const matchFeat = feats.find((ft) => {
            const nc = String(ft.attributes?.nomecplt || '');
            return (
              Array.isArray(ft.geometry?.paths?.[0]) &&
              ft.geometry.paths[0].length > 0 &&
              streetMatchesReturnedAddress(
                targetStreetForCheck,
                `${nc} São José dos Pinhais`,
                'São José dos Pinhais',
                nc
              )
            );
          });
          const path = matchFeat?.geometry?.paths?.[0];
          if (!path || path.length === 0) return null;
          const mid = path[Math.floor(path.length / 2)];
          const nc = String(matchFeat?.attributes?.nomecplt || targetStreetForCheck);
          return {
            sourceKey: 'geosjp',
            sourceLabel: 'GeoSJP Sistema Viário (1897)',
            lat: Number(mid[1]),
            lon: Number(mid[0]),
            display_name: `${nc}, São José dos Pinhais - PR`,
            road: nc,
            bairro: '',
            postcode: '',
            hasExactNumber: false,
            approximateMatch: Boolean(houseNumber),
            bairroFallback: false,
            priority: houseNumber ? 70 : 84,
          };
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      })()
    );
  }

  // 2C. Localidades Rurais / Bairros Oficiais GeoSJP (quando informado bairro/colônia)
  if (bairroHint && bairroHint.length >= 4) {
    const safeB = bairroHint
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/^COLONIA\s+/, '')
      .replace(/[^A-Z0-9\s]/g, '')
      .trim();
    if (safeB.length >= 4) {
      tasks.push(
        (async () => {
          const lUrl = new URL(
            'https://geo.sjp.pr.gov.br/server/rest/services/Localidades/Localidades/MapServer/0/query'
          );
          lUrl.searchParams.set('where', `UPPER(nome) LIKE '%${safeB}%'`);
          lUrl.searchParams.set('outFields', 'nome,tipo');
          lUrl.searchParams.set('outSR', '4326');
          lUrl.searchParams.set('resultRecordCount', '3');
          lUrl.searchParams.set('f', 'json');
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 2600);
          try {
            const res = await fetch(lUrl.toString(), { signal: ctrl.signal, cache: 'no-store' });
            if (!res.ok) return null;
            const data = await res.json();
            const ft = data?.features?.[0];
            if (!ft?.geometry?.y || !ft?.geometry?.x) return null;
            return {
              sourceKey: 'geosjp',
              sourceLabel: 'GeoSJP Localidades Rurais',
              lat: Number(ft.geometry.y),
              lon: Number(ft.geometry.x),
              display_name: `${ft.attributes?.tipo || 'Localidade'} ${ft.attributes?.nome || bairroHint}, São José dos Pinhais - PR`,
              road: '',
              bairro: String(ft.attributes?.nome || bairroHint),
              postcode: '',
              hasExactNumber: false,
              approximateMatch: false,
              bairroFallback: true,
              priority: 30,
            };
          } catch {
            return null;
          } finally {
            clearTimeout(timer);
          }
        })()
      );
    }
  }

  const settled = await Promise.allSettled(tasks);
  const hits = settled
    .filter((r): r is PromiseFulfilledResult<SourceHit | null> => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value as SourceHit)
    .sort((a, b) => b.priority - a.priority);
  return hits[0] || null;
}

async function queryOsmNominatim(
  queryFull: string,
  allowedCity: string,
  targetStreetForCheck: string,
  houseNumStr: string | null
): Promise<SourceHit | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', queryFull);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '5');
  url.searchParams.set('countrycodes', 'br');
  url.searchParams.set('bounded', '1');
  url.searchParams.set('viewbox', '-49.42,-25.43,-48.78,-26.08');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1800);
  try {
    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'SJP-Central-Mandados-TJPR/2.0 (triagem-territorial)',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const items = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      address?: Record<string, string>;
    }>;
    const valid = items.find((item) => {
      const addr = item.address || {};
      const mun = (addr.city || addr.town || addr.municipality || addr.village || '').toLowerCase();
      return (
        (mun.includes('são josé dos pinhais') ||
          mun.includes('sao jose dos pinhais') ||
          mun.includes('tijucas do sul')) &&
        streetMatchesReturnedAddress(
          targetStreetForCheck,
          item.display_name,
          allowedCity,
          addr.road || item.display_name
        )
      );
    });
    if (!valid) return null;
    const roadHasNum = Boolean(
      houseNumStr &&
        (String(valid.address?.house_number || '').includes(houseNumStr) ||
          new RegExp(`(?:^|\\D)${houseNumStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\D|$)`).test(
            valid.display_name.split(',')[0] || ''
          ))
    );
    return {
      sourceKey: 'osm',
      sourceLabel: 'OpenStreetMap (Nominatim)',
      lat: parseFloat(valid.lat),
      lon: parseFloat(valid.lon),
      display_name: valid.display_name,
      road: valid.address?.road || targetStreetForCheck,
      bairro: valid.address?.suburb || valid.address?.neighbourhood || '',
      postcode: valid.address?.postcode || '',
      hasExactNumber: roadHasNum,
      approximateMatch: Boolean(houseNumStr && !roadHasNum),
      bairroFallback: false,
      priority: roadHasNum ? 90 : 75,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  const city = (req.nextUrl.searchParams.get('city') || 'São José dos Pinhais').trim();
  const streetHint = (req.nextUrl.searchParams.get('street') || '').trim();
  const bairroHint = (req.nextUrl.searchParams.get('bairro') || '').trim();

  if (!q) {
    return NextResponse.json({ error: 'Parâmetro q obrigatório' }, { status: 400 });
  }

  const allowedCity = city.toLowerCase().includes('tijucas')
    ? 'Tijucas do Sul'
    : 'São José dos Pinhais';

  const cacheKey = `${q.toLowerCase()}|${allowedCity}|${streetHint.toLowerCase()}|${bairroHint.toLowerCase()}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.body);
  }

  const { streetHead, tail } = splitLeadingStreetIdentifier(q);
  const targetStreetForCheck =
    streetHint ||
    (streetHead ? streetHead : tail.replace(/,\s*\d+.*$/, '').replace(/\s+\d+$/, '').trim());

  const mNum = q.match(/,\s*(\d{1,5})\b/) || (!streetHead ? q.match(/\s(\d{1,5})\b/) : null);
  const houseNumber = mNum ? mNum[1] : null;

  const queryFull = `${q}, ${allowedCity}, Paraná, Brasil`;
  const strippedConnectorStreet = targetStreetForCheck.replace(/\b(?:de|da|do|das|dos)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const googleStreetTerm =
    /^(?:r\.?|rua|av\.?|avenida|estr\.?|estrada|tv\.?|travessa|rod\.?|rodovia|al\.?|alameda|br|pr)\b/i.test(
      strippedConnectorStreet
    )
      ? strippedConnectorStreet
      : `Rua ${strippedConnectorStreet}`;
  const cleanGoogleQ =
    houseNumber && googleStreetTerm
      ? `${googleStreetTerm}, ${houseNumber}, ${allowedCity}, PR`
      : `${q}, ${allowedCity}, PR`;

  // Executa Tripla Verificação em paralelo: Google Maps + GeoSJP Oficial + OpenStreetMap
  const primaryGoogleQ = `${q}, ${allowedCity}, PR`;
  const googlePrimaryTask = queryGoogleMaps(
    primaryGoogleQ,
    allowedCity,
    targetStreetForCheck,
    houseNumber,
    cleanGoogleQ === primaryGoogleQ,
    bairroHint
  );
  const googleCityCleanTask =
    cleanGoogleQ !== primaryGoogleQ
      ? queryGoogleMaps(cleanGoogleQ, allowedCity, targetStreetForCheck, houseNumber, true, bairroHint)
      : Promise.resolve(null);

  const geoSjpTask =
    allowedCity === 'São José dos Pinhais'
      ? queryGeoSjp(targetStreetForCheck, houseNumber, bairroHint)
      : Promise.resolve(null);

  const osmTask = queryOsmNominatim(
    queryFull,
    allowedCity,
    targetStreetForCheck,
    houseNumber
  );

  // Soft-deadline inteligente: se uma fonte exata (GeoSJP Predial / Google / OSM) já respondeu,
  // dá no máximo +550 ms às demais para completar a Tripla Verificação em vez de esperar 1.8–2.4s pelo retardatário.
  const hitsBox: {
    g1: SourceHit | null;
    g2: SourceHit | null;
    gs: SourceHit | null;
    osm: SourceHit | null;
  } = { g1: null, g2: null, gs: null, osm: null };

  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let softResolved = false;
  const softWait = new Promise<void>((resolve) => {
    const finish = () => {
      if (softResolved) return;
      softResolved = true;
      if (softTimer) clearTimeout(softTimer);
      resolve();
    };
    const maybeTriggerSoftDeadline = (hit: SourceHit | null) => {
      if (hit && !hit.bairroFallback && !hit.approximateMatch && !softTimer) {
        softTimer = setTimeout(finish, 550);
      }
    };
    Promise.allSettled([
      googlePrimaryTask.then((v) => { hitsBox.g1 = v; maybeTriggerSoftDeadline(v); }),
      googleCityCleanTask.then((v) => { hitsBox.g2 = v; maybeTriggerSoftDeadline(v); }),
      geoSjpTask.then((v) => { hitsBox.gs = v; maybeTriggerSoftDeadline(v); }),
      osmTask.then((v) => { hitsBox.osm = v; maybeTriggerSoftDeadline(v); }),
    ]).then(finish);
  });
  await softWait;

  const googleHit = hitsBox.g1 && !hitsBox.g1.approximateMatch ? hitsBox.g1 : hitsBox.g2 || hitsBox.g1;
  const geoSjpHit = hitsBox.gs;
  const osmHit = hitsBox.osm;

  const allHits = [googleHit, geoSjpHit, osmHit].filter((h): h is SourceHit => Boolean(h));

  if (allHits.length === 0) {
    const missBody = {
      found: false,
      verification: {
        sourcesFound: [],
        agreedCount: 0,
        details: {},
      },
    };
    return NextResponse.json(missBody, { status: 200 });
  }

  // Prioriza hits não-aproximados / não-bairroFallback sobre aproximações; dentro disso, maior priority
  allHits.sort((a, b) => {
    const tierA = a.bairroFallback ? 0 : a.approximateMatch ? 1 : 2;
    const tierB = b.bairroFallback ? 0 : b.approximateMatch ? 1 : 2;
    if (tierA !== tierB) return tierB - tierA;
    return b.priority - a.priority;
  });

  const best = allHits[0];

  // Calcula concordância espacial entre as fontes independentes
  const nonFallbackHits = allHits.filter((h) => !h.bairroFallback);
  const refForDist = nonFallbackHits[0] || best;
  const maxAgreeM = extractHighwayCode(targetStreetForCheck) ? 1500 : 450;
  let agreedCount = 0;
  const details: Record<string, { lat: number; lon: number; label: string; road: string; bairro: string }> =
    {};

  for (const h of allHits) {
    details[h.sourceKey] = {
      lat: h.lat,
      lon: h.lon,
      label: h.sourceLabel,
      road: h.road,
      bairro: h.bairro,
    };
    if (!h.bairroFallback && haversineMetersSimple(refForDist.lat, refForDist.lon, h.lat, h.lon) <= maxAgreeM) {
      agreedCount++;
    }
  }

  const resolvedBairro =
    best.bairro &&
    bairroHint &&
    normText(best.bairro) === 'braga' &&
    normText(bairroHint) !== 'braga'
      ? osmHit?.bairro || geoSjpHit?.bairro || bairroHint
      : best.bairro || geoSjpHit?.bairro || googleHit?.bairro || osmHit?.bairro || '';

  const outBody = {
    found: true,
    lat: String(best.lat),
    lon: String(best.lon),
    display_name: best.display_name,
    road: best.road,
    bairro: resolvedBairro,
    postcode: best.postcode || googleHit?.postcode || osmHit?.postcode || '',
    source: best.sourceKey === 'geosjp' && best.hasExactNumber ? 'geosjp_predial' : best.sourceKey,
    hasExactNumber: Boolean(best.hasExactNumber),
    approximateMatch: best.approximateMatch,
    bairroFallback: best.bairroFallback,
    address: {
      road: best.road,
      suburb: resolvedBairro,
      city: allowedCity,
      state: 'Paraná',
      postcode: best.postcode,
    },
    verification: {
      sourcesFound: allHits.map((h) => h.sourceLabel),
      agreedCount: Math.max(agreedCount, nonFallbackHits.length > 0 ? 1 : 0),
      details,
    },
  };

  if (geocodeCache.size > 500) {
    const firstKey = geocodeCache.keys().next().value;
    if (firstKey) geocodeCache.delete(firstKey);
  }
  geocodeCache.set(cacheKey, { ts: Date.now(), body: outBody });

  return NextResponse.json(outBody);
}
