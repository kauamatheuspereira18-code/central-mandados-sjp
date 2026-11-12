import { norm } from '@/lib/mandadoParser';
import type {
  AnalysisResult,
  SearchHistoryEntry,
  SearchHistoryKind,
} from '@/types/mandados';

export const SEARCH_HISTORY_STORAGE_KEY = 'sjp_mandados_search_history_v1';
const MAX_HISTORY_ITEMS = 100;

export function loadSearchHistory(): SearchHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is SearchHistoryEntry =>
          Boolean(item) &&
          typeof item.id === 'string' &&
          typeof item.query === 'string' &&
          typeof item.title === 'string' &&
          typeof item.timestamp === 'number'
      )
      .slice(0, MAX_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

export function saveSearchHistory(items: SearchHistoryEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      SEARCH_HISTORY_STORAGE_KEY,
      JSON.stringify(items.slice(0, MAX_HISTORY_ITEMS))
    );
  } catch {
    // Ignora quota/storage bloqueado
  }
}

export function classifyHistoryKind(
  query: string,
  res: AnalysisResult,
  fromMapClick = false
): SearchHistoryKind {
  if (fromMapClick) return 'coordenada';
  const trimmed = query.trim();
  const hasLineBreaks = trimmed.includes('\n');
  const hasCnj = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/.test(trimmed);
  if (hasLineBreaks || hasCnj || trimmed.length > 95 || res.signals.r9Trigger || res.signals.r8Trigger) {
    return 'mandado';
  }
  if (res.signals.highwayKm) return 'rodovia';
  if (res.signals.coords) return 'coordenada';

  const strippedCep = trimmed
    .replace(/^(?:cep|c\.?\s*e\.?\s*p\.?)\s*[:\-]?\s*/i, '')
    .replace(/\D/g, '');
  if (res.signals.cep && strippedCep === res.signals.cep && trimmed.length <= 20) {
    return 'cep';
  }
  if (!res.bestMatch && res.cepInfo?.cep && trimmed.replace(/\D/g, '').length === 8) {
    return 'cep';
  }
  if (
    !res.bestMatch &&
    ((res.signals.bairrosDetectados?.length || 0) > 0 ||
      (res.signals.loteamentosDetectados?.length || 0) > 0)
  ) {
    return 'bairro';
  }
  return 'rua';
}

function formatCepDisplay(digits: string): string {
  const d = digits.replace(/\D/g, '');
  if (d.length === 8) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return digits;
}

export function buildHistoryEntry(
  rawQuery: string,
  res: AnalysisResult,
  fromMapClick = false
): SearchHistoryEntry {
  const query = rawQuery.trim();
  const kind = classifyHistoryKind(query, res, fromMapClick);
  const houseNum = res.reverseAddress?.houseNumber || res.signals.houseNumber || '';
  const bestStreet = res.bestMatch?.street;

  let title = query;
  let subtitle = '';

  if (kind === 'cep') {
    const cepDigits = res.cepInfo?.cep || res.signals.cep || query;
    const cepFmt = formatCepDisplay(cepDigits);
    title = `CEP ${cepFmt}`;
    const cepRoad = res.cepInfo?.logradouro?.trim();
    const cepBairro = res.cepInfo?.bairro?.trim();
    const cepCity = res.cepInfo?.localidade?.trim();
    subtitle = [cepRoad, cepBairro, cepCity].filter(Boolean).join(' · ') || res.subtitulo;
  } else if (kind === 'coordenada') {
    if (res.reverseAddress?.road) {
      title = `${res.reverseAddress.road}${houseNum ? `, nº ${houseNum}` : ''}`;
      const loc = [
        res.reverseAddress.suburb,
        res.reverseAddress.city,
        res.reverseAddress.postcode ? `CEP ${res.reverseAddress.postcode}` : '',
      ].filter(Boolean);
      subtitle = loc.join(' · ') || res.subtitulo;
    } else if (res.pin) {
      title = res.pin.label || query;
      subtitle = res.subtitulo || `${res.pin.lat.toFixed(5)}, ${res.pin.lon.toFixed(5)}`;
    }
  } else if (kind === 'rodovia') {
    const hw = res.signals.highwayKm;
    title = hw ? `${hw.rodovia}, km ${hw.km}` : res.pin?.label || query;
    subtitle = res.subtitulo;
  } else if (kind === 'mandado') {
    if (bestStreet) {
      title = `${bestStreet.n}${houseNum ? `, nº ${houseNum}` : ''}`;
    } else {
      const firstLine = query.split('\n').map((l) => l.trim()).find(Boolean) || query;
      title = firstLine.length > 56 ? `${firstLine.slice(0, 54).trim()}…` : firstLine;
    }
    subtitle = res.subtitulo || res.titulo;
  } else if (kind === 'bairro') {
    title =
      res.signals.loteamentosDetectados?.[0]?.nome ||
      res.signals.bairrosDetectados?.[0]?.nome ||
      query;
    subtitle = res.subtitulo;
  } else {
    // 'rua'
    if (bestStreet) {
      title = `${bestStreet.n}${houseNum ? `, nº ${houseNum}` : ''}`;
      const b = res.reverseAddress?.suburb || res.cepInfo?.bairro || bestStreet.b || '';
      const lot = bestStreet.lot && !b.includes(bestStreet.lot) ? bestStreet.lot : '';
      const cepRaw = res.reverseAddress?.postcode || res.cepInfo?.cep || bestStreet.cep || '';
      const mun = bestStreet.m === 'TIJ' ? 'Tijucas do Sul' : 'SJP';
      subtitle = [b, lot, mun, cepRaw ? `CEP ${formatCepDisplay(cepRaw)}` : '']
        .filter(Boolean)
        .join(' · ');
    } else if (res.reverseAddress?.road) {
      title = `${res.reverseAddress.road}${houseNum ? `, nº ${houseNum}` : ''}`;
      subtitle = [res.reverseAddress.suburb, res.reverseAddress.city, res.reverseAddress.postcode]
        .filter(Boolean)
        .join(' · ');
    } else {
      title = query.length > 64 ? `${query.slice(0, 62).trim()}…` : query;
      subtitle = res.subtitulo || res.titulo;
    }
  }

  // Para cliques no mapa com endereço resolvido, guardar a query legível para rebusca precisa
  const replayQuery =
    fromMapClick && res.pin
      ? `${res.pin.lat.toFixed(6)}, ${res.pin.lon.toFixed(6)}`
      : query;

  const now = Date.now();
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
    query: replayQuery,
    kind,
    title,
    subtitle: subtitle || res.regiaoFinal,
    regiao: res.regiaoFinal,
    cor: res.cor,
    status: res.status,
    lat: res.pin?.lat,
    lon: res.pin?.lon,
    timestamp: now,
    count: 1,
  };
}

function historyDedupKey(item: Pick<SearchHistoryEntry, 'kind' | 'query' | 'title'>): string {
  return `${item.kind}|${norm(item.title)}|${norm(item.query).slice(0, 80)}`;
}

export function upsertSearchHistory(
  prev: SearchHistoryEntry[],
  next: SearchHistoryEntry
): SearchHistoryEntry[] {
  const nextKey = historyDedupKey(next);
  const existingIdx = prev.findIndex((item) => {
    if (historyDedupKey(item) === nextKey) return true;
    if (
      item.kind === next.kind &&
      norm(item.query) === norm(next.query) &&
      item.regiao === next.regiao
    ) {
      return true;
    }
    return false;
  });

  if (existingIdx >= 0) {
    const existing = prev[existingIdx];
    const updated: SearchHistoryEntry = {
      ...next,
      id: existing.id,
      count: (existing.count || 1) + 1,
    };
    const rest = prev.filter((_, i) => i !== existingIdx);
    return [updated, ...rest].slice(0, MAX_HISTORY_ITEMS);
  }

  return [next, ...prev].slice(0, MAX_HISTORY_ITEMS);
}

export function formatRelativeTimePtBr(ts: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - ts);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 45) return 'agora mesmo';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;

  const diffHours = Math.floor(diffMin / 60);
  const dNow = new Date(now);
  const dTs = new Date(ts);
  const startToday = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate()).getTime();
  const startYesterday = startToday - 86_400_000;

  if (ts >= startToday && diffHours < 24) {
    return `há ${diffHours} h`;
  }

  const hhmm = dTs.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (ts >= startYesterday && ts < startToday) {
    return `ontem · ${hhmm}`;
  }

  const diffDays = Math.max(1, Math.floor((startToday - new Date(dTs.getFullYear(), dTs.getMonth(), dTs.getDate()).getTime()) / 86_400_000));
  if (diffDays === 1) return `ontem · ${hhmm}`;
  if (diffDays < 7) return `há ${diffDays} dias`;

  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return `há ${diffWeeks} ${diffWeeks === 1 ? 'sem' : 'sem'}`;

  if (dTs.getFullYear() === dNow.getFullYear()) {
    return dTs.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  }
  return dTs.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function formatExactDateTimePtBr(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export type HistoryBucket = 'Hoje' | 'Ontem' | 'Últimos 7 dias' | 'Mais antigos';

export function getHistoryBucketLabel(ts: number, now = Date.now()): HistoryBucket {
  const dNow = new Date(now);
  const startToday = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate()).getTime();
  const startYesterday = startToday - 86_400_000;
  const start7Days = startToday - 6 * 86_400_000;

  if (ts >= startToday) return 'Hoje';
  if (ts >= startYesterday) return 'Ontem';
  if (ts >= start7Days) return 'Últimos 7 dias';
  return 'Mais antigos';
}
