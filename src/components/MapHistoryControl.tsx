'use client';

import React, { useMemo, useState } from 'react';
import {
  Clock,
  Crosshair,
  FileText,
  Hash,
  History,
  MapPin,
  Navigation,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { norm } from '@/lib/mandadoParser';
import { getRegionTextColor } from '@/lib/mandadosEngine';
import {
  formatExactDateTimePtBr,
  formatRelativeTimePtBr,
  getHistoryBucketLabel,
  type HistoryBucket,
} from '@/lib/searchHistory';
import type { SearchHistoryEntry, SearchHistoryKind } from '@/types/mandados';

interface MapHistoryControlProps {
  history: SearchHistoryEntry[];
  nowTick: number;
  embedded?: boolean;
  lightTheme?: boolean;
  onBeforeOpen?: () => void;
  onSelectHistoryItem: (item: SearchHistoryEntry) => void;
  onRemoveHistoryItem: (id: string) => void;
  onClearHistory: () => void;
}

type KindFilter = 'all' | 'rua' | 'cep' | 'rodovia' | 'coordenada' | 'mandado';

export function HistoryKindIcon({ kind }: { kind: SearchHistoryKind }) {
  switch (kind) {
    case 'cep':
      return <Hash className="w-3.5 h-3.5 text-amber-300" />;
    case 'rodovia':
      return <Navigation className="w-3.5 h-3.5 text-emerald-300" />;
    case 'coordenada':
      return <Crosshair className="w-3.5 h-3.5 text-sky-300" />;
    case 'mandado':
      return <FileText className="w-3.5 h-3.5 text-violet-300" />;
    case 'bairro':
    case 'rua':
    default:
      return <MapPin className="w-3.5 h-3.5 text-blue-300" />;
  }
}

export function compactRegionBadge(regiao: string): string {
  if (regiao === 'Fora da Comarca') return 'Fora';
  if (regiao === 'Complementação Necessária') return 'Compl.';
  return regiao.replace('Região ', 'R');
}

export default function MapHistoryControl({
  history,
  nowTick,
  embedded = false,
  lightTheme = false,
  onBeforeOpen,
  onSelectHistoryItem,
  onRemoveHistoryItem,
  onClearHistory,
}: MapHistoryControlProps) {
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [confirmClear, setConfirmClear] = useState(false);

  const filteredItems = useMemo(() => {
    const q = norm(filterText);
    return history.filter((item) => {
      if (kindFilter !== 'all') {
        if (kindFilter === 'rua') {
          if (item.kind !== 'rua' && item.kind !== 'bairro') return false;
        } else if (item.kind !== kindFilter) {
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
  }, [history, filterText, kindFilter]);

  const grouped = useMemo(() => {
    const buckets: Array<{ label: HistoryBucket; items: SearchHistoryEntry[] }> = [];
    const byLabel = new Map<HistoryBucket, SearchHistoryEntry[]>();
    const order: HistoryBucket[] = ['Hoje', 'Ontem', 'Últimos 7 dias', 'Mais antigos'];
    for (const item of filteredItems) {
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
  }, [filteredItems, nowTick]);

  return (
    <div
      className={
        embedded
          ? 'relative flex items-center'
          : 'absolute top-3 left-3 z-[500] flex flex-col items-start gap-2'
      }
    >
      {/* Compact History Trigger (fits seamlessly inside top-right map pill when embedded) */}
      <button
        type="button"
        onClick={() => {
          const next = !open;
          if (next) onBeforeOpen?.();
          setOpen(next);
          setConfirmClear(false);
        }}
        className={
          embedded
            ? `p-1.5 rounded-full transition-all relative ${
                open
                  ? 'bg-blue-600 text-white'
                  : lightTheme
                  ? 'text-slate-600 hover:bg-slate-100'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`
            : `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold shadow-xl border backdrop-blur-md transition-all ${
                open
                  ? 'bg-white text-slate-950 border-white'
                  : 'bg-slate-950/90 text-slate-100 border-slate-800 hover:bg-slate-900 hover:border-slate-700'
              }`
        }
        title="Histórico de pesquisas (ruas, CEPs, rodovias e pontos no mapa)"
      >
        <History
          className={
            embedded
              ? 'w-3.5 h-3.5'
              : `w-3.5 h-3.5 ${open ? 'text-blue-600' : 'text-amber-300'}`
          }
        />
        {!embedded && <span>Recentes</span>}
        {!embedded && history.length > 0 && (
          <span
            className={`px-1.5 py-0.2 rounded-full text-[10px] font-extrabold ${
              open ? 'bg-slate-900 text-white' : 'bg-slate-800 text-amber-300'
            }`}
          >
            {history.length}
          </span>
        )}
      </button>

      {/* Google Maps-style Chronological Search History Popover */}
      {open && (
        <div
          className={`${
            embedded ? 'absolute right-0 top-full mt-2 z-[530]' : ''
          } w-[345px] max-w-[calc(100vw-24px)] max-h-[70vh] bg-slate-950/95 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-800 text-slate-100 flex flex-col overflow-hidden`}
        >
          {/* Header */}
          <div className="px-3.5 py-2.5 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Clock className="w-3.5 h-3.5 text-amber-300 shrink-0" />
              <span className="text-xs font-extrabold tracking-tight truncate">
                Histórico de pesquisas
              </span>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {history.length > 0 && (
                confirmClear ? (
                  <button
                    type="button"
                    onClick={() => {
                      onClearHistory();
                      setConfirmClear(false);
                    }}
                    className="px-2 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-bold transition"
                  >
                    Confirmar
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmClear(true)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold text-slate-400 hover:text-rose-300 hover:bg-slate-900 transition"
                    title="Limpar todo o histórico"
                  >
                    <Trash2 className="w-3 h-3" />
                    Limpar
                  </button>
                )
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setConfirmClear(false);
                }}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-900 transition"
                aria-label="Fechar histórico"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Search & Category Filter */}
          {history.length > 0 && (
            <div className="px-3 py-2 border-b border-slate-800/80 space-y-2 shrink-0 bg-slate-900/40">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
                <input
                  type="text"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Filtrar rua, CEP, bairro, região..."
                  className="w-full pl-8 pr-7 py-1.5 rounded-xl bg-slate-950/90 border border-slate-800 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/70"
                />
                {filterText && (
                  <button
                    type="button"
                    onClick={() => setFilterText('')}
                    className="absolute right-2 top-1.5 text-slate-500 hover:text-slate-200"
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
                  ] as Array<[KindFilter, string]>
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setKindFilter(id)}
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap transition ${
                      kindFilter === id
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Scrollable Chronological List */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60">
            {history.length === 0 ? (
              <div className="p-6 text-center space-y-1.5">
                <Clock className="w-6 h-6 text-slate-600 mx-auto" />
                <div className="text-xs font-semibold text-slate-300">
                  Nenhuma pesquisa recente ainda
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Suas ruas, CEPs, rodovias, mandados e cliques no mapa aparecerão aqui com horário e região.
                </p>
              </div>
            ) : grouped.length === 0 ? (
              <div className="p-5 text-center text-xs text-slate-400">
                Nenhum item encontrado para esse filtro.
              </div>
            ) : (
              grouped.map((bucket) => (
                <div key={bucket.label} className="py-1.5">
                  <div className="px-3.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-slate-400 bg-slate-900/50">
                    {bucket.label}
                  </div>
                  <div className="divide-y divide-slate-800/40">
                    {bucket.items.map((item) => (
                      <div
                        key={item.id}
                        className="group flex items-center gap-2.5 px-3 py-2 hover:bg-slate-900/85 transition"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onSelectHistoryItem(item);
                            setOpen(false);
                          }}
                          className="flex-1 min-w-0 flex items-start gap-2.5 text-left"
                          title={`Pesquisado em ${formatExactDateTimePtBr(item.timestamp)}`}
                        >
                          <span className="w-7 h-7 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0 mt-0.5 group-hover:border-slate-700">
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
                              <span title={formatExactDateTimePtBr(item.timestamp)}>
                                {formatRelativeTimePtBr(item.timestamp, nowTick)}
                              </span>
                              {item.count > 1 && (
                                <span className="text-slate-500 font-normal">
                                  · {item.count}x
                                </span>
                              )}
                            </div>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveHistoryItem(item.id);
                          }}
                          className="p-1 rounded-lg text-slate-600 hover:text-rose-400 hover:bg-slate-800/80 opacity-60 group-hover:opacity-100 transition shrink-0"
                          title="Remover do histórico"
                          aria-label="Remover item do histórico"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
