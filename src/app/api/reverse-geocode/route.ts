import { NextRequest, NextResponse } from 'next/server';

export interface ReverseGeocodePayload {
  found: boolean;
  road: string;
  houseNumber: string;
  suburb: string;
  city: string;
  state: string;
  uf: string;
  postcode: string;
  displayName?: string;
}

const STATE_UF: Record<string, string> = {
  Paraná: 'PR',
  'Santa Catarina': 'SC',
  'São Paulo': 'SP',
  'Rio Grande do Sul': 'RS',
  'Minas Gerais': 'MG',
  'Rio de Janeiro': 'RJ',
};

const MAX_CACHE = 800;
const cache = new Map<string, ReverseGeocodePayload>();

function formatCep(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 8) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return raw.trim();
}

async function fetchGeoSjpBairroAt(lat: number, lon: number): Promise<string> {
  if (lat < -25.88 || lat > -25.43 || lon < -49.33 || lon > -48.83) return '';
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 1400);
  try {
    const u = new URL(
      'https://geo.sjp.pr.gov.br/server/rest/services/Bairros/Bairros/MapServer/1/query'
    );
    u.searchParams.set('geometry', `${lon},${lat}`);
    u.searchParams.set('geometryType', 'esriGeometryPoint');
    u.searchParams.set('inSR', '4326');
    u.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
    u.searchParams.set('outFields', 'nome');
    u.searchParams.set('returnGeometry', 'false');
    u.searchParams.set('f', 'json');
    const r = await fetch(u.toString(), { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) return '';
    const d = await r.json();
    const nm = String(d?.features?.[0]?.attributes?.nome || '').trim();
    return nm;
  } catch {
    return '';
  } finally {
    clearTimeout(id);
  }
}

async function fetchViaCepByStreet(
  uf: string,
  city: string,
  road: string
): Promise<{ cep?: string; bairro?: string } | null> {
  if (!uf || !city || !road || road.length < 3) return null;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 2000);
  try {
    const cleanRoad = road
      .replace(/^(Rua|Avenida|Av\.?|Travessa|Alameda|Estrada|Rodovia)\s+/i, '')
      .trim();
    const qRoad = cleanRoad.length >= 3 ? cleanRoad : road;
    const url = `https://viacep.com.br/ws/${encodeURIComponent(uf)}/${encodeURIComponent(city)}/${encodeURIComponent(qRoad)}/json/`;
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const exact =
      arr.find((x) => x.logradouro?.toLowerCase() === road.toLowerCase()) || arr[0];
    return {
      cep: exact?.cep ? formatCep(String(exact.cep)) : undefined,
      bairro: exact?.bairro ? String(exact.bairro) : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

export async function GET(req: NextRequest) {
  const latStr = req.nextUrl.searchParams.get('lat');
  const lonStr = req.nextUrl.searchParams.get('lon');
  const lat = parseFloat(latStr || '');
  const lon = parseFloat(lonStr || '');

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return NextResponse.json({ found: false, error: 'Coordenadas inválidas' }, { status: 400 });
  }

  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2400);

  try {
    const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1&zoom=18&accept-language=pt-BR`;
    const [res, geoSjpBairro] = await Promise.all([
      fetch(nomUrl, {
        headers: {
          'User-Agent': 'CentralMandadosSJP/1.0 (tjpr-triage)',
        },
        signal: ctrl.signal,
        cache: 'no-store',
      }),
      fetchGeoSjpBairroAt(lat, lon),
    ]);

    if (!res.ok) {
      return NextResponse.json({
        found: Boolean(geoSjpBairro),
        road: '',
        houseNumber: '',
        suburb: geoSjpBairro,
        city: geoSjpBairro ? 'São José dos Pinhais' : '',
        state: 'Paraná',
        uf: 'PR',
        postcode: '',
      });
    }

    const data = await res.json();
    const addr = data?.address || {};

    const road = String(
      addr.road ||
        addr.pedestrian ||
        addr.highway ||
        addr.footway ||
        addr.residential ||
        addr.path ||
        addr.amenity ||
        ''
    ).trim();
    const houseNumber = String(addr.house_number || '').trim();
    let suburb = String(
      addr.suburb ||
        addr.neighbourhood ||
        addr.quarter ||
        addr.city_district ||
        addr.village ||
        addr.hamlet ||
        geoSjpBairro ||
        ''
    ).trim();
    if (!suburb && geoSjpBairro) suburb = geoSjpBairro;
    const city = String(
      addr.city || addr.town || addr.municipality || addr.village || (geoSjpBairro ? 'São José dos Pinhais' : '')
    ).trim();
    const state = String(addr.state || 'Paraná').trim();
    const iso = String(addr['ISO3166-2-lvl4'] || '');
    const uf = iso.startsWith('BR-') ? iso.slice(3) : STATE_UF[state] || 'PR';
    let postcode = addr.postcode ? formatCep(String(addr.postcode)) : '';

    // Enrich missing CEP or Bairro via ViaCEP when street & city are known
    if ((!postcode || !suburb) && road && city) {
      const vc = await fetchViaCepByStreet(uf, city, road);
      if (vc) {
        if (!postcode && vc.cep) postcode = vc.cep;
        if (!suburb && vc.bairro) suburb = vc.bairro;
      }
    }

    // Tijucas do Sul general CEP fallback when postal district isn't split by street
    if (!postcode && city.toLowerCase().includes('tijucas do sul')) {
      postcode = '83190-000';
    }

    const payload: ReverseGeocodePayload = {
      found: Boolean(road || suburb || city || postcode),
      road,
      houseNumber,
      suburb,
      city,
      state,
      uf,
      postcode,
      displayName: data?.display_name ? String(data.display_name) : undefined,
    };

    if (payload.found) {
      if (cache.size >= MAX_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(cacheKey, payload);
    }

    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({
      found: false,
      road: '',
      houseNumber: '',
      suburb: '',
      city: '',
      state: 'Paraná',
      uf: 'PR',
      postcode: '',
    });
  } finally {
    clearTimeout(timer);
  }
}
