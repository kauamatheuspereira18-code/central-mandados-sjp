import { NextRequest, NextResponse } from 'next/server';

interface CepNormalized {
  cep: string;
  logradouro: string;
  bairro: string;
  localidade: string;
  uf: string;
  ibge?: string;
  fonte: string;
}

const MAX_CACHE = 500;
const cepCache = new Map<string, CepNormalized>();

async function fetchWithTimeout(url: string, ms = 2200): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'SJP-Central-Mandados-TJPR/2.0' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(id);
  }
}

async function fromViaCep(digits: string): Promise<CepNormalized> {
  const res = await fetchWithTimeout(`https://viacep.com.br/ws/${digits}/json/`, 2200);
  if (!res.ok) throw new Error('ViaCEP HTTP ' + res.status);
  const data = await res.json();
  if (!data || data.erro || !data.localidade) throw new Error('ViaCEP miss');
  return {
    cep: data.cep || digits,
    logradouro: data.logradouro || '',
    bairro: data.bairro || '',
    localidade: data.localidade || '',
    uf: data.uf || '',
    ibge: data.ibge,
    fonte: 'ViaCEP',
  };
}

async function fromBrasilApi(digits: string): Promise<CepNormalized> {
  const res = await fetchWithTimeout(`https://brasilapi.com.br/api/cep/v2/${digits}`, 2200);
  if (!res.ok) throw new Error('BrasilAPI HTTP ' + res.status);
  const data = await res.json();
  if (!data || !data.city) throw new Error('BrasilAPI miss');
  return {
    cep: data.cep || digits,
    logradouro: data.street || '',
    bairro: data.neighborhood || '',
    localidade: data.city || '',
    uf: data.state || '',
    ibge: data.ibge?.city ? String(data.ibge.city) : undefined,
    fonte: 'BrasilAPI',
  };
}

async function fromOpenCep(digits: string): Promise<CepNormalized> {
  const res = await fetchWithTimeout(`https://opencep.com/v1/${digits}`, 2200);
  if (!res.ok) throw new Error('OpenCEP HTTP ' + res.status);
  const data = await res.json();
  if (!data || !data.localidade) throw new Error('OpenCEP miss');
  return {
    cep: data.cep || digits,
    logradouro: data.logradouro || '',
    bairro: data.bairro || '',
    localidade: data.localidade || '',
    uf: data.uf || '',
    ibge: data.ibge,
    fonte: 'OpenCEP',
  };
}

export async function GET(req: NextRequest) {
  const rawCep = req.nextUrl.searchParams.get('cep') || '';
  const digits = rawCep.replace(/\D/g, '');
  if (digits.length !== 8) {
    return NextResponse.json({ erro: true, message: 'CEP inválido' }, { status: 400 });
  }

  const cached = cepCache.get(digits);
  if (cached) {
    return NextResponse.json(cached);
  }

  // Corrida paralela entre ViaCEP, BrasilAPI v2 e OpenCEP (máx. ~2.2s no pior cenário; ~0.25-0.4s típico)
  try {
    const winner = await Promise.any([
      fromViaCep(digits),
      fromBrasilApi(digits),
      fromOpenCep(digits),
    ]);
    if (cepCache.size >= MAX_CACHE) {
      const first = cepCache.keys().next().value;
      if (first !== undefined) cepCache.delete(first);
    }
    cepCache.set(digits, winner);
    return NextResponse.json(winner);
  } catch {
    return NextResponse.json({ erro: true, message: 'CEP não encontrado nas bases' }, { status: 404 });
  }
}
