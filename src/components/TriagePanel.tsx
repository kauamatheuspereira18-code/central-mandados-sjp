'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Clock,
  Compass,
  FileText,
  History,
  Layers,
  Loader2,
  Scale,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { HistoryKindIcon, compactRegionBadge } from '@/components/MapHistoryControl';
import { canonicalizeNumberedStreetText, norm } from '@/lib/mandadoParser';
import {
  CERTIDAO_COMPLEMENTACAO,
  CERTIDAO_FORA_COMARCA,
  REGION_COLORS,
  getRegionTextColor,
  isLightRegionColor,
} from '@/lib/mandadosEngine';
import {
  formatExactDateTimePtBr,
  formatRelativeTimePtBr,
  getHistoryBucketLabel,
  type HistoryBucket,
} from '@/lib/searchHistory';
import type {
  AnalysisResult,
  GeoLayers,
  SearchHistoryEntry,
  StreetAliasesDB,
  StreetEntry,
} from '@/types/mandados';

interface TriagePanelProps {
  geoLayers: GeoLayers;
  streets: StreetEntry[];
  streetAliases?: StreetAliasesDB | null;
  query: string;
  setQuery: (val: string) => void;
  isAnalyzing: boolean;
  activeResult: AnalysisResult | null;
  searchHistory?: SearchHistoryEntry[];
  nowTick?: number;
  onAnalyze: (textOverride?: string) => void;
  onSelectRegionFocus: (reg: string) => void;
  onOpenStreetDirect: (street: StreetEntry) => void;
  onOpenStreetView: () => void;
  onSelectHistoryItem?: (item: SearchHistoryEntry) => void;
  onRemoveHistoryItem?: (id: string) => void;
  onClearHistory?: () => void;
}

type TabId = 'triagem' | 'historico' | 'regioes' | 'normas';
type HistoryKindFilter = 'all' | 'rua' | 'cep' | 'rodovia' | 'coordenada' | 'mandado';

export default function TriagePanel({
  geoLayers,
  streets,
  streetAliases,
  query,
  setQuery,
  isAnalyzing,
  activeResult,
  searchHistory = [],
  nowTick = Date.now(),
  onAnalyze,
  onSelectRegionFocus,
  onOpenStreetDirect,
  onOpenStreetView,
  onSelectHistoryItem,
  onRemoveHistoryItem,
  onClearHistory,
}: TriagePanelProps) {
  const [tab, setTab] = useState<TabId>('triagem');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [regionFilter, setRegionFilter] = useState<string>('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [historyFilterText, setHistoryFilterText] = useState('');
  const [historyKindFilter, setHistoryKindFilter] = useState<HistoryKindFilter>('all');
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);

  const parseCertidaoParts = (texto: string) => {
    const rawBlocks = texto
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter(Boolean);
    const hasHeading = rawBlocks[0]?.toUpperCase() === 'CERTIDÃO';
    const blocks = hasHeading ? rawBlocks.slice(1) : rawBlocks;
    const lastBlock = blocks[blocks.length - 1] || '';
    const hasDateFooter = /^S[aã]o Jos[eé] dos Pinhais\/PR,/i.test(lastBlock);
    const bodyParagraphs = hasDateFooter ? blocks.slice(0, -1) : blocks;
    return { bodyParagraphs };
  };

  const escapeHtml = (str: string) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const copyCertidao = async (text: string, id: string) => {
    const { bodyParagraphs } = parseCertidaoParts(text);
    const plainText = ['CERTIDÃO', ...bodyParagraphs].join('\n\n');
    const htmlBody = bodyParagraphs
      .map(
        (p) =>
          `<p style="text-align:justify;text-indent:2em;font-size:12pt;line-height:1.5;margin:0 0 8pt 0;">${escapeHtml(p)}</p>`
      )
      .join('');
    const htmlText = `<div style="font-family:'Times New Roman',Georgia,serif;color:#000000;">\n<p style="text-align:center;font-size:14pt;font-weight:bold;letter-spacing:1.5px;margin:0 0 12pt 0;">CERTIDÃO</p>\n${htmlBody}\n</div>`;

    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([plainText], { type: 'text/plain' }),
            'text/html': new Blob([htmlText], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(plainText);
      }
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2200);
    } catch {
      try {
        await navigator.clipboard.writeText(plainText);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2200);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = plainText;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2200);
      }
    }
  };

  const renderCertidaoDocument = (texto: string) => {
    const { bodyParagraphs } = parseCertidaoParts(texto);
    return (
      <div className="rounded-xl border border-slate-700/80 bg-slate-950/90 px-4 py-3.5 space-y-2.5 select-text shadow-inner">
        <div className="text-center text-base sm:text-[17px] font-extrabold tracking-[0.2em] uppercase text-white pb-2 border-b border-slate-800">
          CERTIDÃO
        </div>
        <div className="space-y-2">
          {bodyParagraphs.map((p, idx) => (
            <p
              key={idx}
              className="text-xs leading-[1.65] text-slate-100 text-justify indent-5 font-serif"
            >
              {p}
            </p>
          ))}
        </div>
      </div>
    );
  };

  // Fast autocomplete suggestions (includes numbered streets, homonyms, and old/alias names)
  const autocompleteMatches = useMemo(() => {
    const q = query.trim();
    if (!showSuggestions || q.length < 3 || q.includes('\n') || /\d{5}/.test(q) || /\bkm\b/i.test(q)) {
      return [];
    }
    const qHead = q.split(',')[0].trim();
    const qNorm = norm(qHead);
    const qCanon = canonicalizeNumberedStreetText(qHead, true);
    if (qNorm.length < 3) return [];

    type SugItem =
      | { kind: 'street'; key: string; street: StreetEntry }
      | {
          kind: 'alias';
          key: string;
          label: string;
          target: string;
          rp: string;
          b?: string;
          lot?: string;
          mun: 'SJP' | 'TIJ';
          queryVal: string;
        };

    const hits: SugItem[] = [];
    const seenKeys = new Set<string>();

    for (const s of streets) {
      const sn = norm(s.n);
      const sc = canonicalizeNumberedStreetText(s.n, true);
      if (sn.includes(qNorm) || (qCanon.length >= 4 && sc.includes(qCanon))) {
        const key = s.gid || `${s.m}|${s.n}|${s.rp}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          hits.push({ kind: 'street', key, street: s });
          if (hits.length >= 6) break;
        }
      }
    }

    if (hits.length < 8 && streetAliases?.aliases) {
      const targetRegionMap = new Map<string, string>();
      for (const s of streets) {
        const tk = `${s.m}|${norm(s.n)}`;
        if (!targetRegionMap.has(tk)) targetRegionMap.set(tk, s.rp);
      }
      for (const al of streetAliases.aliases) {
        const an = norm(al.a);
        const ac = canonicalizeNumberedStreetText(al.a, true);
        if (an.includes(qNorm) || (qCanon.length >= 4 && ac.includes(qCanon))) {
          const rp = targetRegionMap.get(`${al.m}|${norm(al.t)}`) || 'Região 1';
          const ctx = al.lot || al.b || '';
          const queryVal = ctx ? `${al.a}, ${ctx}` : al.a;
          const key = `al|${al.m}|${al.a}|${al.t}|${ctx}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            hits.push({
              kind: 'alias',
              key,
              label: al.a,
              target: al.t,
              rp,
              b: al.b,
              lot: al.lot,
              mun: al.m,
              queryVal,
            });
            if (hits.length >= 8) break;
          }
        }
      }
    }

    return hits;
  }, [query, streets, streetAliases, showSuggestions]);

  const groupedHistory = useMemo(() => {
    const q = norm(historyFilterText);
    const filtered = searchHistory.filter((item) => {
      if (historyKindFilter !== 'all') {
        if (historyKindFilter === 'rua') {
          if (item.kind !== 'rua' && item.kind !== 'bairro') return false;
        } else if (item.kind !== historyKindFilter) {
          return false;
        }
      }
      if (!q) return true;
      return (
        norm(item.title).includes(q) ||
        norm(item.subtitle).includes(q) ||
        norm(item.query).includes(q) ||
        norm(item.regiao).includes(q)
      );
    });

    const buckets: Array<{ label: HistoryBucket; items: SearchHistoryEntry[] }> = [];
    const byLabel = new Map<HistoryBucket, SearchHistoryEntry[]>();
    const order: HistoryBucket[] = ['Hoje', 'Ontem', 'Últimos 7 dias', 'Mais antigos'];
    for (const item of filtered) {
      const b = getHistoryBucketLabel(item.timestamp, nowTick);
      const arr = byLabel.get(b) || [];
      arr.push(item);
      byLabel.set(b, arr);
    }
    for (const label of order) {
      const arr = byLabel.get(label);
      if (arr && arr.length > 0) buckets.push({ label, items: arr });
    }
    return buckets;
  }, [searchHistory, historyFilterText, historyKindFilter, nowTick]);

  const filteredRegions = useMemo(() => {
    const f = norm(regionFilter);
    if (!f) return geoLayers.regioes_info;
    return geoLayers.regioes_info.filter(
      (r) =>
        norm(r.codigo).includes(f) ||
        norm(r.descricao_sistema).includes(f) ||
        norm(r.observacoes_operacionais).includes(f)
    );
  }, [geoLayers.regioes_info, regionFilter]);

  return (
    <aside className="flex flex-col h-full bg-[#0B1120] text-slate-100 border-r border-slate-800/90 z-10 overflow-hidden">
      {/* Dark Navigation Tabs */}
      <div className="flex items-center border-b border-slate-800/90 bg-slate-950/70 p-1.5 gap-1 shrink-0">
        {[
          { id: 'triagem', label: 'Consulta', shortLabel: 'Consulta', icon: Search },
          { id: 'historico', label: 'Histórico', shortLabel: 'Histórico', icon: History },
          { id: 'regioes', label: 'Regiões (1–9)', shortLabel: 'Regiões', icon: Compass },
          { id: 'normas', label: 'Normas TJPR', shortLabel: 'Normas', icon: Scale },
        ].map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                setTab(item.id as TabId);
                setConfirmClearHistory(false);
              }}
              className={`flex-1 min-w-0 flex items-center justify-center gap-1 py-2 px-1.5 rounded-lg text-[11px] font-semibold transition-all ${
                active
                  ? 'bg-slate-800 text-white shadow-sm border border-slate-700/80'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
              title={item.label}
            >
              <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-blue-400' : ''}`} />
              <span className="truncate md:hidden">{item.shortLabel}</span>
              <span className="truncate hidden md:inline">{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: CONSULTA */}
      {tab === 'triagem' && (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5">
          {/* Minimal Dark Search Input */}
          <div className="relative bg-slate-900/90 border border-slate-800 rounded-2xl p-2.5 focus-within:border-blue-500/70 focus-within:ring-2 focus-within:ring-blue-500/15 transition-all">
            <textarea
              value={query}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => {
                window.setTimeout(() => setShowSuggestions(false), 180);
              }}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowSuggestions(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  setShowSuggestions(false);
                  onAnalyze();
                }
              }}
              rows={2}
              placeholder="Endereço, CEP, rodovia ou mandado..."
              className="w-full bg-slate-950/80 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-slate-700 resize-y min-h-[58px]"
            />

            {/* Autocomplete dropdown for street & alias suggestions */}
            {autocompleteMatches.length > 0 && (
              <div className="mt-1.5 bg-slate-950 border border-slate-800 rounded-xl shadow-2xl overflow-hidden divide-y divide-slate-800/80 max-h-60 overflow-y-auto">
                {autocompleteMatches.map((item) => {
                  if (item.kind === 'street') {
                    const s = item.street;
                    const localCtx = [s.b, s.lot].filter(Boolean).join(' · ');
                    return (
                      <button
                        key={item.key}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setShowSuggestions(false);
                          onOpenStreetDirect(s);
                        }}
                        className="w-full px-3 py-2 text-left hover:bg-slate-900 flex items-center justify-between gap-2 transition"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-100 truncate">{s.n}</div>
                          <div className="text-[10px] text-slate-400 truncate">
                            {localCtx ? `${localCtx} · ` : ''}
                            {s.m === 'TIJ' ? 'Tijucas do Sul' : 'SJP'} · {(s.len / 1000).toFixed(2)} km
                          </div>
                        </div>
                        <span
                          className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold"
                          style={{
                            backgroundColor: REGION_COLORS[s.rp] || '#FFD600',
                            color: getRegionTextColor(s.rp),
                          }}
                        >
                          {s.mr ? `${s.r.length} regiões` : s.rp}
                        </span>
                      </button>
                    );
                  }
                  const localCtx = [item.b, item.lot].filter(Boolean).join(' · ');
                  return (
                    <button
                      key={item.key}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setShowSuggestions(false);
                        setQuery(item.queryVal);
                        onAnalyze(item.queryVal);
                      }}
                      className="w-full px-3 py-2 text-left hover:bg-slate-900 flex items-center justify-between gap-2 transition"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-amber-200 truncate">
                          {item.label}{' '}
                          <span className="text-slate-400 font-normal">→ {item.target}</span>
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          {localCtx ? `${localCtx} · ` : ''}
                          {item.mun === 'TIJ' ? 'Tijucas do Sul' : 'SJP'} · nome anterior/popular
                        </div>
                      </div>
                      <span
                        className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold"
                        style={{
                          backgroundColor: REGION_COLORS[item.rp] || '#FFD600',
                          color: getRegionTextColor(item.rp),
                        }}
                      >
                        {item.rp}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-2 flex items-center justify-between gap-2">
              {query ? (
                <button
                  onClick={() => {
                    setQuery('');
                    setShowSuggestions(false);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
                >
                  <X className="w-3 h-3" /> Limpar
                </button>
              ) : (
                <span />
              )}
              <button
                onClick={() => {
                  setShowSuggestions(false);
                  onAnalyze();
                }}
                disabled={isAnalyzing || !query.trim()}
                className="ml-auto inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-bold shadow-sm transition-all"
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Buscando...
                  </>
                ) : (
                  <>
                    <Search className="w-3.5 h-3.5" />
                    Buscar
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Active Result Card */}
          {activeResult && (
            <div className="space-y-3 animate-in fade-in duration-200">
              {/* Primary Verdict Banner */}
              {(() => {
                const lightCard = isLightRegionColor(activeResult.cor);
                return (
                  <div
                    className={`rounded-2xl p-4 shadow-lg relative overflow-hidden ${
                      lightCard ? 'text-slate-950 border border-amber-500/50' : 'text-white'
                    }`}
                    style={{
                      background: `linear-gradient(135deg, ${activeResult.cor}, ${activeResult.cor}dd)`,
                    }}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span
                        className={`inline-flex items-center gap-1 backdrop-blur-sm px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          lightCard ? 'bg-slate-950/12 text-slate-950' : 'bg-white/20 text-white'
                        }`}
                      >
                        {activeResult.certezaLabel}
                      </span>
                    </div>
                    <h2 className="text-2xl font-extrabold tracking-tight leading-tight">
                      {activeResult.titulo}
                    </h2>
                    <p
                      className={`text-xs mt-1 font-medium leading-snug ${
                        lightCard ? 'text-slate-900/90' : 'text-white/90'
                      }`}
                    >
                      {activeResult.subtitulo}
                    </p>

                    {/* Detected signal pills */}
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {activeResult.cepInfo && (
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-mono ${
                            lightCard ? 'bg-slate-950/12 text-slate-950' : 'bg-black/20 text-white'
                          }`}
                        >
                          CEP {activeResult.cepInfo.cep} · {activeResult.cepInfo.localidade}/{activeResult.cepInfo.uf}
                        </span>
                      )}
                      {activeResult.signals.houseNumber && (
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-mono ${
                            lightCard ? 'bg-slate-950/12 text-slate-950' : 'bg-black/20 text-white'
                          }`}
                        >
                          Nº {activeResult.signals.houseNumber}
                        </span>
                      )}
                      {activeResult.signals.highwayKm && (
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-mono ${
                            lightCard ? 'bg-slate-950/12 text-slate-950' : 'bg-black/20 text-white'
                          }`}
                        >
                          {activeResult.signals.highwayKm.rodovia} km {activeResult.signals.highwayKm.km}
                        </span>
                      )}
                      {activeResult.signals.coords && (
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-mono ${
                            lightCard ? 'bg-slate-950/12 text-slate-950' : 'bg-black/20 text-white'
                          }`}
                        >
                          {activeResult.signals.coords.lat.toFixed(5)}, {activeResult.signals.coords.lon.toFixed(5)}
                        </span>
                      )}
                      {activeResult.verificacao && activeResult.verificacao.fontes.length > 0 && (
                        <span
                          title={activeResult.verificacao.detalhe}
                          className={`px-2 py-0.5 rounded-md text-[10px] font-semibold ${
                            lightCard ? 'bg-slate-950/15 text-slate-950' : 'bg-black/25 text-emerald-200'
                          }`}
                        >
                          ✓ {activeResult.verificacao.fontes.length >= 3 ? 'Tripla Verificação' : `${activeResult.verificacao.fontes.length} Fontes`}: {activeResult.verificacao.fontes.join(' · ')}
                        </span>
                      )}
                    </div>

                    {activeResult.reverseAddress && (
                      <div
                        className={`mt-2.5 rounded-xl px-3 py-2 text-[11px] space-y-0.5 border ${
                          lightCard
                            ? 'bg-slate-950/10 border-slate-950/15 text-slate-950'
                            : 'bg-black/20 border-white/15 text-white'
                        }`}
                      >
                        <div>
                          <span className={lightCard ? 'text-slate-800 font-semibold' : 'text-white/70 font-semibold'}>
                            Rua:
                          </span>{' '}
                          <span className="font-bold">
                            {activeResult.reverseAddress.road || 'Via não nomeada'}
                            {activeResult.reverseAddress.houseNumber
                              ? `, nº ${activeResult.reverseAddress.houseNumber}`
                              : ''}
                          </span>
                        </div>
                        <div>
                          <span className={lightCard ? 'text-slate-800 font-semibold' : 'text-white/70 font-semibold'}>
                            Bairro:
                          </span>{' '}
                          <span className="font-semibold">
                            {activeResult.reverseAddress.suburb || 'Não informado'}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>
                            <span className={lightCard ? 'text-slate-800 font-semibold' : 'text-white/70 font-semibold'}>
                              Cidade/Estado:
                            </span>{' '}
                            <span className="font-semibold">
                              {[activeResult.reverseAddress.city, activeResult.reverseAddress.state || activeResult.reverseAddress.uf]
                                .filter(Boolean)
                                .join(' – ')}
                            </span>
                          </span>
                          <span>
                            <span className={lightCard ? 'text-slate-800 font-semibold' : 'text-white/70 font-semibold'}>
                              CEP:
                            </span>{' '}
                            <span className={`font-mono font-bold ${lightCard ? 'text-slate-950' : 'text-amber-200'}`}>
                              {activeResult.reverseAddress.postcode || 'Não informado'}
                            </span>
                          </span>
                        </div>
                      </div>
                    )}

                    {activeResult.pin && (
                      <div
                        className={`mt-3 pt-2.5 border-t flex items-center justify-between gap-2 ${
                          lightCard ? 'border-slate-950/15' : 'border-white/20'
                        }`}
                      >
                        <button
                          onClick={onOpenStreetView}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-extrabold shadow-sm transition ${
                            lightCard
                              ? 'bg-slate-950 hover:bg-slate-900 text-amber-300'
                              : 'bg-amber-400 hover:bg-amber-300 text-slate-950'
                          }`}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="3.3" />
                            <path d="M8.5 10.5C8.5 9.67 9.17 9 10 9h4c.83 0 1.5.67 1.5 1.5v5h-1.8v6h-3.4v-6H8.5v-5z" />
                          </svg>
                          Street View 360°
                        </button>
                        <a
                          href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${activeResult.pin.lat},${activeResult.pin.lon}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`text-[11px] font-bold underline underline-offset-2 ${
                            lightCard ? 'text-slate-900 hover:text-slate-950' : 'text-white/90 hover:text-white'
                          }`}
                        >
                          Maps ↗
                        </a>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Alerts / Traps Stack */}
              {activeResult.alertas.length > 0 && (
                <div className="space-y-2">
                  {activeResult.alertas.map((al, i) => {
                    const isCritical =
                      al.includes('ARMADILHA') ||
                      al.includes('PEGADINHA') ||
                      al.includes('FALTA DE COMPLEMENTO') ||
                      al.includes('ATENÇÃO');
                    return (
                      <div
                        key={i}
                        className={`rounded-xl p-3 border text-xs flex items-start gap-2.5 ${
                          isCritical
                            ? 'bg-amber-950/45 border-amber-700/50 text-amber-200'
                            : 'bg-slate-900/90 border-slate-800 text-slate-300'
                        }`}
                      >
                        <AlertTriangle
                          className={`w-4 h-4 shrink-0 mt-0.5 ${
                            isCritical ? 'text-amber-400' : 'text-slate-400'
                          }`}
                        />
                        <span className="leading-relaxed font-medium">{al}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Ready-to-Copy Certidão (Normas TJPR / DEV) */}
              {activeResult.certidao && (
                <div className="rounded-2xl border border-rose-800/70 bg-rose-950/35 p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-rose-200">
                      <FileText className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>{activeResult.certidao.titulo}</span>
                    </div>
                    <button
                      onClick={() => copyCertidao(activeResult.certidao!.texto, 'active-cert')}
                      className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold transition ${
                        copiedId === 'active-cert'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-rose-600 hover:bg-rose-500 text-white'
                      }`}
                    >
                      {copiedId === 'active-cert' ? (
                        <>
                          <Check className="w-3.5 h-3.5" /> Copiado
                        </>
                      ) : (
                        <>
                          <ClipboardCopy className="w-3.5 h-3.5" /> Copiar
                        </>
                      )}
                    </button>
                  </div>
                  {renderCertidaoDocument(activeResult.certidao.texto)}
                </div>
              )}

              {/* Deterministic Justification */}
              {activeResult.explicacao.length > 0 && (
                <div className="rounded-2xl border border-slate-800 bg-slate-900/75 p-3.5 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Fundamentação
                  </div>
                  <ul className="space-y-1.5">
                    {activeResult.explicacao.map((exp, i) => (
                      <li key={i} className="text-xs text-slate-300 flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                        <span className="leading-relaxed">{exp}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Multi-Region Street Extension Breakdown */}
              {activeResult.bestMatch?.street.mr && (
                <div className="rounded-2xl border border-slate-800 bg-slate-900/75 p-3.5 space-y-2">
                  <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    <span>Trechos por Região</span>
                    <span>{(activeResult.bestMatch.street.len / 1000).toFixed(2)} km</span>
                  </div>
                  <div className="h-2.5 w-full rounded-full overflow-hidden flex bg-slate-800">
                    {Object.entries(activeResult.bestMatch.street.er)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reg, meters]) => {
                        const pct = (meters / activeResult.bestMatch!.street.len) * 100;
                        return (
                          <div
                            key={reg}
                            style={{
                              width: `${pct}%`,
                              backgroundColor: REGION_COLORS[reg] || '#64748B',
                            }}
                            title={`${reg}: ${Math.round(meters)} m (${pct.toFixed(0)}%)`}
                          />
                        );
                      })}
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {Object.entries(activeResult.bestMatch.street.er)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reg, meters]) => (
                        <span
                          key={reg}
                          className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-slate-950/90 border border-slate-800 px-2 py-0.5 rounded-md text-slate-200"
                        >
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: REGION_COLORS[reg] || '#64748B' }}
                          />
                          {reg}: {(meters / 1000).toFixed(2)} km
                        </span>
                      ))}
                  </div>
                </div>
              )}

              {/* Lookalike / Similar Streets */}
              {activeResult.lookalikes.length > 0 && (
                <div className="rounded-2xl border border-slate-800 bg-slate-900/75 p-3.5 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Vias Parecidas
                  </div>
                  <div className="space-y-1.5">
                    {activeResult.lookalikes.map((alt) => {
                      const localCtx = [alt.street.b, alt.street.lot].filter(Boolean).join(' · ');
                      return (
                        <button
                          key={alt.street.gid || `${alt.street.m}-${alt.street.n}`}
                          onClick={() => {
                            onOpenStreetDirect(alt.street);
                          }}
                          className="w-full text-left px-2.5 py-2 rounded-xl border border-slate-800/80 bg-slate-950/60 hover:border-blue-500/50 hover:bg-slate-900 transition flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-100 truncate">
                              {alt.street.n}
                            </div>
                            <div className="text-[10px] text-slate-400 truncate">
                              {localCtx ? `${localCtx} · ` : ''}
                              {alt.street.m === 'TIJ' ? 'Tijucas do Sul' : 'SJP'} · {Math.round(alt.score * 100)}%
                            </div>
                          </div>
                          <span
                            className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold"
                            style={{
                              backgroundColor: REGION_COLORS[alt.street.rp] || '#475569',
                              color: getRegionTextColor(alt.street.rp),
                            }}
                          >
                            {alt.street.mr ? alt.street.r.join(' / ') : alt.street.rp}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: HISTÓRICO (ENTRE CONSULTA E REGIÕES) */}
      {tab === 'historico' && (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
              <Clock className="w-4 h-4 text-amber-300 shrink-0" />
              <span>Histórico de pesquisas</span>
              {searchHistory.length > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-slate-800 text-[10px] font-bold text-slate-300">
                  {searchHistory.length}
                </span>
              )}
            </div>
            {searchHistory.length > 0 && onClearHistory && (
              confirmClearHistory ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onClearHistory();
                      setConfirmClearHistory(false);
                    }}
                    className="px-2 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-bold transition"
                  >
                    Confirmar
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearHistory(false)}
                    className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-semibold transition"
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClearHistory(true)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-slate-400 hover:text-rose-300 hover:bg-slate-900 transition"
                  title="Limpar todo o histórico"
                >
                  <Trash2 className="w-3 h-3" />
                  Limpar
                </button>
              )
            )}
          </div>

          {searchHistory.length > 0 && (
            <div className="space-y-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={historyFilterText}
                  onChange={(e) => setHistoryFilterText(e.target.value)}
                  placeholder="Filtrar rua, CEP, bairro, região..."
                  className="w-full pl-8 pr-7 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                />
                {historyFilterText && (
                  <button
                    type="button"
                    onClick={() => setHistoryFilterText('')}
                    className="absolute right-2.5 top-2 text-slate-500 hover:text-slate-200"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
                {(
                  [
                    ['all', 'Tudo'],
                    ['rua', 'Ruas'],
                    ['cep', 'CEPs'],
                    ['rodovia', 'Rodovias'],
                    ['coordenada', 'Cliques'],
                    ['mandado', 'Mandados'],
                  ] as Array<[HistoryKindFilter, string]>
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setHistoryKindFilter(id)}
                    className={`px-2.5 py-1 rounded-full text-[10px] font-bold whitespace-nowrap transition ${
                      historyKindFilter === id
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {searchHistory.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center space-y-2 mt-2">
              <Clock className="w-7 h-7 text-slate-600 mx-auto" />
              <div className="text-xs font-semibold text-slate-300">
                Nenhuma pesquisa recente ainda
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Suas ruas, CEPs, rodovias, mandados e cliques no mapa ficarão salvos aqui com o tempo decorrido (minutos, horas e dias).
              </p>
            </div>
          ) : groupedHistory.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 text-center text-xs text-slate-400">
              Nenhum item encontrado para esse filtro.
            </div>
          ) : (
            <div className="space-y-3">
              {groupedHistory.map((bucket) => (
                <div
                  key={bucket.label}
                  className="rounded-2xl border border-slate-800 bg-slate-900/75 overflow-hidden"
                >
                  <div className="px-3.5 py-1.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-400 bg-slate-950/60 border-b border-slate-800/80">
                    {bucket.label}
                  </div>
                  <div className="divide-y divide-slate-800/60">
                    {bucket.items.map((item) => (
                      <div
                        key={item.id}
                        className="group flex items-center gap-2 px-3 py-2.5 hover:bg-slate-900 transition"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onSelectHistoryItem?.(item);
                            setTab('triagem');
                          }}
                          className="flex-1 min-w-0 flex items-start gap-2.5 text-left"
                          title={`Pesquisado em ${formatExactDateTimePtBr(item.timestamp)}`}
                        >
                          <span className="w-7 h-7 rounded-full bg-slate-950 border border-slate-800 flex items-center justify-center shrink-0 mt-0.5">
                            <HistoryKindIcon kind={item.kind} />
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-slate-100 truncate">
                                {item.title}
                              </span>
                              <span
                                className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-extrabold"
                                style={{
                                  backgroundColor: item.cor || '#475569',
                                  color: getRegionTextColor(item.cor || item.regiao),
                                }}
                              >
                                {compactRegionBadge(item.regiao)}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400 truncate mt-0.5">
                              {item.subtitle}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-amber-300/85 font-medium">
                              <Clock className="w-2.5 h-2.5 shrink-0 opacity-80" />
                              <span>{formatRelativeTimePtBr(item.timestamp, nowTick)}</span>
                              {item.count > 1 && (
                                <span className="text-slate-500 font-normal">
                                  · {item.count}x
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                        {onRemoveHistoryItem && (
                          <button
                            type="button"
                            onClick={() => onRemoveHistoryItem(item.id)}
                            className="p-1 rounded-lg text-slate-600 hover:text-rose-400 hover:bg-slate-800 opacity-60 group-hover:opacity-100 transition shrink-0"
                            title="Remover do histórico"
                            aria-label="Remover item do histórico"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: REGIÕES 1 A 9 */}
      {tab === 'regioes' && (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              value={regionFilter}
              onChange={(e) => setRegionFilter(e.target.value)}
              placeholder="Filtrar região ou bairro..."
              className="w-full pl-8 pr-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="space-y-2.5">
            {filteredRegions.map((r) => (
              <div
                key={r.codigo}
                className="rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5 hover:border-slate-700 transition space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{
                        backgroundColor: r.cor,
                        border: isLightRegionColor(r.cor) ? '1px solid #9A7B00' : 'none',
                      }}
                    />
                    <span className="text-sm font-extrabold text-white">{r.codigo}</span>
                    {r.area_km2 && (
                      <span className="text-[10px] font-mono text-slate-400">
                        {r.area_km2} km²
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {r.qtd_ruas > 0 && (
                      <span className="px-2 py-0.5 rounded-md bg-slate-800 text-[10px] font-semibold text-slate-300">
                        {r.qtd_ruas} vias
                      </span>
                    )}
                    {!['Região 8', 'Região 9'].includes(r.codigo) && (
                      <button
                        onClick={() => onSelectRegionFocus(r.codigo)}
                        className="px-2.5 py-0.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold transition"
                      >
                        Focar
                      </button>
                    )}
                  </div>
                </div>
                <div className="text-[11px] font-semibold text-slate-400">{r.tipo}</div>
                <p className="text-xs text-slate-300 leading-relaxed">{r.descricao_sistema}</p>
                {r.observacoes_operacionais && (
                  <div className="text-[11px] text-amber-200 bg-amber-950/40 border border-amber-800/50 rounded-lg px-2.5 py-1.5">
                    {r.observacoes_operacionais}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: NORMAS TJPR & CERTIDÕES */}
      {tab === 'normas' && (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
          {/* Certidões Prontas Atualizadas */}
          <div className="space-y-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-rose-400" />
              Certidões Prontas — Devolução sem Distribuição (DEV)
            </div>

            {[
              { id: 'c1', data: CERTIDAO_FORA_COMARCA },
              { id: 'c2', data: CERTIDAO_COMPLEMENTACAO },
            ].map(({ id, data }) => (
              <div key={id} className="rounded-2xl border border-slate-800 bg-slate-900/80 p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-100">{data.titulo}</span>
                  <button
                    onClick={() => copyCertidao(data.texto, id)}
                    className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold transition ${
                      copiedId === id
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-800 hover:bg-blue-600 text-slate-100'
                    }`}
                  >
                    {copiedId === id ? (
                      <>
                        <Check className="w-3 h-3" /> Copiado
                      </>
                    ) : (
                      <>
                        <ClipboardCopy className="w-3 h-3" /> Copiar
                      </>
                    )}
                  </button>
                </div>
                {renderCertidaoDocument(data.texto)}
              </div>
            ))}
          </div>

          {/* 7 Pegadinhas */}
          <div className="space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              Pontos de Atenção
            </div>
            {geoLayers.pegadinhas.map((p, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-slate-800 bg-slate-900/80 p-2.5 space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-100">{p.local}</span>
                  <span
                    className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold"
                    style={{
                      backgroundColor: REGION_COLORS[p.regiao_correta] || '#0F172A',
                      color: getRegionTextColor(p.regiao_correta),
                    }}
                  >
                    {p.regiao_correta}
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">{p.motivo}</p>
              </div>
            ))}
          </div>

          {/* Normas TJPR */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5 space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-blue-400" />
              Normas TJPR Vigentes (2026)
            </div>
            <ul className="text-[11px] text-slate-300 space-y-2 leading-relaxed">
              <li>
                <strong className="text-slate-100">INC nº 25/2020–P-GP/CGJPR (compilada até a INC nº 262/2026):</strong> substituiu o termo &ldquo;mandado regionalizado&rdquo; por <strong className="text-slate-200">Mandado Compartilhado</strong> (1º e 2º Graus). Pelos arts. 3º, 7º (parágrafo único) e 11, mandado para outra comarca do PR deve ir direto da Unidade Expedidora à Central destinatária (devolve-se à origem quando remetido a SJP; a INC nº 75/2021 dispensou registro no Distribuidor e a INC nº 262/2026 regulou o Oficial de Apoio).
              </li>
              <li>
                <strong className="text-slate-100">CNFJ — Provimento nº 316/2022–CGJ (até Provimento nº 359/2026):</strong> art. 325 (Central de Mandados e atos normativos locais) e Capítulo VII, Seção I (arts. 326–331 — Mandado Compartilhado e hipótese de comarca limítrofe no art. 324, parágrafo único).
              </li>
              <li>
                <strong className="text-slate-100">Resolução nº 139/2015–OE/TJPR (alterada pela Res. nº 517/2025–OE):</strong> art. 15 impõe devolução em até 24h dos mandados sem requisitos mínimos ao cumprimento; art. 22, § 1º trata das portarias locais da Direção do Fórum.
              </li>
              <li>
                <strong className="text-slate-100">Ofício-Circular nº 17/2026–CGJ (c/c Res. nº 443/2024–OE e OC nº 15/2025–CGJ):</strong> classifica como <strong className="text-slate-200">DEV — Mandado Devolvido</strong> no Projudi o retorno sem diligência presencial por incompetência territorial ou endereço insuficiente.
              </li>
              <li>
                <strong className="text-slate-100">Ofício-Circular nº 16/2026–GCJ (DJE 4077, 23/02/2026):</strong> revogou a IN nº 61/2021, o OC nº 227/2021 e a Decisão 6791928, cancelando a antiga janela de antecedência de 30–60 dias para audiências (dos OCs 15/2024 e 25/2024), salvo regra específica de Portaria local.
              </li>
              <li>
                <strong className="text-slate-100">Ofício-Circular nº 79/2026–GCJ &amp; INC nº 297/2026:</strong> desentranhamento para região diversa distribui por sorteio sem vinculação obrigatória (OC 79/2026), e a Central de Comunicação Virtual devolve direto à origem quando o endereço físico não é domicílio real (INC 297/2026, art. 5º, § 3º).
              </li>
            </ul>
          </div>
        </div>
      )}
    </aside>
  );
}
