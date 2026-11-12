'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Map as MapIcon,
  RotateCw,
  Scale,
  Search,
  X,
} from 'lucide-react';
import TriagePanel from '@/components/TriagePanel';
import { haversineMeters } from '@/lib/geoMath';
import { analyzeMandadoInput, buildDynamicCertidao } from '@/lib/mandadosEngine';
import { detectExternalCity } from '@/lib/mandadoParser';
import {
  buildHistoryEntry,
  loadSearchHistory,
  saveSearchHistory,
  upsertSearchHistory,
} from '@/lib/searchHistory';
import type {
  AnalysisResult,
  GeoLayers,
  ReverseAddressInfo,
  RodoviasKmDB,
  SearchHistoryEntry,
  StreetAliasesDB,
  StreetEntry,
  StreetsGeomMap,
} from '@/types/mandados';

const MandadosMap = dynamic(() => import('@/components/MandadosMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 text-slate-400 gap-2">
      <Loader2 className="w-7 h-7 animate-spin text-blue-400" />
    </div>
  ),
});

const GoogleMapsSplitView = dynamic(() => import('@/components/GoogleMapsSplitView'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 text-slate-400 gap-2">
      <Loader2 className="w-7 h-7 animate-spin text-blue-400" />
    </div>
  ),
});

const STORAGE_KEY = 'sjp_gmaps_api_key';

async function fetchJsonWithRetry<T>(
  url: string,
  opts?: { timeoutMs?: number; retries?: number; optional?: boolean }
): Promise<T | null> {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const retries = opts?.retries ?? 1;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'force-cache' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ao carregar ${url}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => window.setTimeout(r, 350));
      }
    } finally {
      window.clearTimeout(timer);
    }
  }

  if (opts?.optional) return null;
  throw lastErr instanceof Error ? lastErr : new Error(`Falha ao carregar ${url}`);
}

export default function HomePage() {
  const [geoLayers, setGeoLayers] = useState<GeoLayers | null>(null);
  const [streets, setStreets] = useState<StreetEntry[]>([]);
  const [streetsGeom, setStreetsGeom] = useState<StreetsGeomMap | null>(null);
  const [rodoviasKm, setRodoviasKm] = useState<RodoviasKmDB | null>(null);
  const [externalRmc, setExternalRmc] = useState<Record<string, { n: string; c: string }> | null>(
    null
  );
  const [streetAliases, setStreetAliases] = useState<StreetAliasesDB | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const streetsRef = useRef<StreetEntry[]>([]);
  const streetsGeomRef = useRef<StreetsGeomMap | null>(null);
  const externalRmcRef = useRef<Record<string, { n: string; c: string }> | null>(null);
  const streetAliasesRef = useRef<StreetAliasesDB | null>(null);
  const datasetsPromiseRef = useRef<Promise<void> | null>(null);
  const externalRmcPromiseRef = useRef<Promise<Record<string, { n: string; c: string }> | null> | null>(null);

  const [query, setQuery] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [activeResult, setActiveResult] = useState<AnalysisResult | null>(null);
  const [focusRegion, setFocusRegion] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'split' | 'map'>('map');
  const [streetViewTriggerTick, setStreetViewTriggerTick] = useState(0);
  const reverseSeqRef = useRef(0);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>([]);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  // Google Maps API key (env var on Vercel OR user-pasted in browser localStorage)
  const envApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';
  const [customApiKey, setCustomApiKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [gmapsError, setGmapsError] = useState<string | null>(null);

  const activeGoogleKey = (customApiKey || envApiKey).trim();

  useEffect(() => {
    setSearchHistory(loadSearchHistory());
    const timer = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const recordSearchHistory = useCallback(
    (rawQuery: string, res: AnalysisResult, fromMapClick = false) => {
      const entry = buildHistoryEntry(rawQuery, res, fromMapClick);
      setNowTick(entry.timestamp);
      setSearchHistory((prev) => {
        const next = upsertSearchHistory(prev, entry);
        saveSearchHistory(next);
        return next;
      });
    },
    []
  );

  const handleRemoveHistoryItem = useCallback((id: string) => {
    setSearchHistory((prev) => {
      const next = prev.filter((item) => item.id !== id);
      saveSearchHistory(next);
      return next;
    });
  }, []);

  const handleClearHistory = useCallback(() => {
    setSearchHistory([]);
    saveSearchHistory([]);
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) || '';
      if (saved) {
        setCustomApiKey(saved);
        setKeyInput(saved);
      } else if (envApiKey) {
        setKeyInput(envApiKey);
      }
    } catch {
      // Ignore storage access restrictions
    }
  }, [envApiKey]);

  useEffect(() => {
    let mounted = true;
    setLoadError(null);
    const DATA_V = '20261112v7';

    // Stage 2: Load only compact internal search datasets (~764 KB raw / ~160 KB gzip) so SJP searches never block on 1.1 MB external RMC or 1.4 MB polylines
    const coreSearchPromise = Promise.allSettled([
      fetchJsonWithRetry<StreetEntry[]>(`/data/streets_db.json?v=${DATA_V}`, { timeoutMs: 30000, retries: 2 }).then((v) => {
        if (mounted && Array.isArray(v)) {
          streetsRef.current = v;
          setStreets(v);
        }
        return v;
      }),
      fetchJsonWithRetry<StreetAliasesDB>(`/data/street_aliases.json?v=${DATA_V}`, {
        timeoutMs: 25000,
        retries: 1,
        optional: true,
      }).then((v) => {
        if (mounted && v) {
          streetAliasesRef.current = v;
          setStreetAliases(v);
        }
        return v;
      }),
    ]).then(() => {});
    datasetsPromiseRef.current = coreSearchPromise;

    externalRmcPromiseRef.current = fetchJsonWithRetry<Record<string, { n: string; c: string }>>(
      `/data/external_streets_rmc.json?v=${DATA_V}`,
      { timeoutMs: 30000, retries: 1, optional: true }
    ).then((v) => {
      if (mounted && v) {
        externalRmcRef.current = v;
        setExternalRmc(v);
      }
      return v ?? null;
    });

    fetchJsonWithRetry<StreetsGeomMap>(`/data/streets_geom.json?v=${DATA_V}`, { timeoutMs: 35000, retries: 2 })
      .then((gmVal) => {
        if (!mounted || !gmVal) return;
        streetsGeomRef.current = gmVal;
        setStreetsGeom(gmVal);
      })
      .catch(() => {
        // Non-fatal: map polylines fallback gracefully
      });

    // Stage 1: Load compact core geometry + highway index (~205 KB) so map & UI open immediately
    async function loadCore() {
      try {
        const [geo, km] = await Promise.all([
          fetchJsonWithRetry<GeoLayers>(`/data/geo_layers.json?v=${DATA_V}`, { timeoutMs: 25000, retries: 2 }),
          fetchJsonWithRetry<RodoviasKmDB>(`/data/rodovias_km.json?v=${DATA_V}`, {
            timeoutMs: 20000,
            retries: 2,
          }),
        ]);
        if (!mounted || !geo || !km) return;
        setGeoLayers(geo);
        setRodoviasKm(km);
      } catch (err) {
        if (!mounted) return;
        setLoadError(
          err instanceof Error
            ? err.message
            : 'Não foi possível carregar as camadas geográficas do mapa.'
        );
      }
    }

    loadCore();
    return () => {
      mounted = false;
    };
  }, [reloadTick]);

  const handleAnalyze = useCallback(
    async (textOverride?: string) => {
      const input = (textOverride ?? query).trim();
      if (!input || !geoLayers || !rodoviasKm) return;

      const seqId = ++reverseSeqRef.current;
      setIsAnalyzing(true);
      let res: AnalysisResult;
      try {
        if (
          streetsRef.current.length === 0 &&
          datasetsPromiseRef.current &&
          !detectExternalCity(input)
        ) {
          await datasetsPromiseRef.current;
        }
        res = await analyzeMandadoInput(input, {
          geo: geoLayers,
          streets: streetsRef.current.length > 0 ? streetsRef.current : streets,
          streetsGeom: streetsGeomRef.current ?? streetsGeom,
          rodoviasKm,
          externalRmc: externalRmcRef.current ?? externalRmc,
          getExternalRmc: async () => {
            if (externalRmcRef.current) return externalRmcRef.current;
            return (await externalRmcPromiseRef.current) ?? null;
          },
          streetAliases: streetAliasesRef.current ?? streetAliases,
        });
        if (reverseSeqRef.current !== seqId) return;
        setActiveResult(res);
        recordSearchHistory(input, res, false);
      } finally {
        setIsAnalyzing(false);
      }

      // Se já detectamos Fora da Comarca instantaneamente sem pino (ex.: cidade explícita ou external_streets_rmc),
      // busca o pino geográfico em segundo plano sem travar a exibição da certidão.
      if (res.status === 'fora_comarca' && !res.pin && res.signals.extractedAddressLine.length >= 4) {
        const pinBase = res.cepInfo?.logradouro
          ? `${res.cepInfo.logradouro}${res.cepInfo.localidade ? `, ${res.cepInfo.localidade}` : ''}`
          : res.signals.extractedAddressLine;
        const inferredCityMatch = res.titulo.match(/\(([^)]+)\)/);
        const cityHint = res.signals.externalCity || (inferredCityMatch ? inferredCityMatch[1].split(',')[0].trim() : '');
        const pinQuery =
          cityHint &&
          !pinBase.toLowerCase().includes(cityHint.toLowerCase().split('/')[0])
            ? `${pinBase}, ${cityHint}`
            : pinBase;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2800);
        fetch(`/api/geocode-external?q=${encodeURIComponent(pinQuery)}`, { signal: ctrl.signal })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!d?.found || !d.lat || !d.lon || reverseSeqRef.current !== seqId) return;
            const lat = parseFloat(d.lat);
            const lon = parseFloat(d.lon);
            if (Number.isNaN(lat) || Number.isNaN(lon)) return;
            setActiveResult((prev) =>
              prev && prev.status === 'fora_comarca' && !prev.pin
                ? {
                    ...prev,
                    pin: {
                      lat,
                      lon,
                      label: d.road
                        ? `${d.road}${d.city ? ` (${d.city})` : ''}`
                        : res.titulo,
                      fonte: 'Geocodificação Externa',
                      regiao: 'Fora da Comarca',
                    },
                  }
                : prev
            );
          })
          .catch(() => {})
          .finally(() => clearTimeout(timer));
      }
    },
    [query, geoLayers, streets, streetsGeom, rodoviasKm, externalRmc, streetAliases, recordSearchHistory]
  );

  const handleCoordinatePicked = useCallback(
    async (lat: number, lon: number) => {
      if (!geoLayers || !rodoviasKm) return;
      const reqId = ++reverseSeqRef.current;
      const coordText = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      setQuery(coordText);

      const baseRes = await analyzeMandadoInput(coordText, {
        geo: geoLayers,
        streets: streetsRef.current.length > 0 ? streetsRef.current : streets,
        streetsGeom: streetsGeomRef.current ?? streetsGeom,
        rodoviasKm,
        externalRmc: externalRmcRef.current ?? externalRmc,
        streetAliases: streetAliasesRef.current ?? streetAliases,
      });
      if (reverseSeqRef.current !== reqId) return;
      setActiveResult(baseRes);

      let finalResForHistory: AnalysisResult = baseRes;
      try {
        const rvRes = await fetch(`/api/reverse-geocode?lat=${lat}&lon=${lon}`);
        if (!rvRes.ok || reverseSeqRef.current !== reqId) return;
        const rv = await rvRes.json();
        if (reverseSeqRef.current !== reqId) return;

        let suburb = String(rv.suburb || '').trim();
        if (!suburb && baseRes.status !== 'fora_comarca') {
          let bestDist = 2800;
          for (const b of geoLayers.bairros_localidades) {
            const d = haversineMeters(lat, lon, b.lat, b.lon);
            if (d < bestDist) {
              bestDist = d;
              suburb = b.nome;
            }
          }
        }

        const revAddr: ReverseAddressInfo = {
          road: String(rv.road || '').trim(),
          houseNumber: String(rv.houseNumber || '').trim(),
          suburb,
          city: String(rv.city || '').trim() || (baseRes.regiaoFinal === 'Região 7' ? 'Tijucas do Sul' : baseRes.status !== 'fora_comarca' ? 'São José dos Pinhais' : ''),
          state: String(rv.state || 'Paraná').trim(),
          uf: String(rv.uf || 'PR').trim(),
          postcode: String(rv.postcode || '').trim(),
          displayName: rv.displayName ? String(rv.displayName) : undefined,
        };

        const streetTitle = revAddr.road
          ? `${revAddr.road}${revAddr.houseNumber ? `, nº ${revAddr.houseNumber}` : ''}`
          : baseRes.pin?.label || coordText;

        const locParts = [
          revAddr.suburb,
          revAddr.city ? `${revAddr.city}/${revAddr.uf}` : revAddr.state,
          revAddr.postcode ? `CEP ${revAddr.postcode}` : '',
        ].filter(Boolean);

        const enrichedSub = locParts.length
          ? `${streetTitle} · ${locParts.join(' · ')}`
          : baseRes.subtitulo;

        const nextCertidao =
          baseRes.status === 'fora_comarca' && baseRes.certidao
            ? buildDynamicCertidao(
                'fora_comarca',
                `${streetTitle}${locParts.length ? `, ${locParts.join(', ')}` : ''}`,
                revAddr.city
                  ? `${revAddr.city}/${revAddr.uf || 'PR'}`
                  : revAddr.state || 'município diverso'
              )
            : baseRes.certidao;

        finalResForHistory = {
          ...baseRes,
          subtitulo: enrichedSub,
          reverseAddress: revAddr,
          cepInfo: revAddr.postcode
            ? {
                cep: revAddr.postcode,
                logradouro: revAddr.road,
                bairro: revAddr.suburb,
                localidade: revAddr.city || 'São José dos Pinhais',
                uf: revAddr.uf || 'PR',
              }
            : baseRes.cepInfo,
          pin: baseRes.pin
            ? {
                ...baseRes.pin,
                label: streetTitle,
                fonte: locParts.join(' · ') || baseRes.pin.fonte,
              }
            : baseRes.pin,
          certidao: nextCertidao,
        };
        setActiveResult(finalResForHistory);
      } catch {
        // Keep base coordinate result if reverse geocoder fails
      } finally {
        if (reverseSeqRef.current === reqId) {
          recordSearchHistory(coordText, finalResForHistory, true);
        }
      }
    },
    [geoLayers, streets, streetsGeom, rodoviasKm, externalRmc, streetAliases, recordSearchHistory]
  );

  const handleSelectHistoryItem = useCallback(
    async (item: SearchHistoryEntry) => {
      if (item.kind === 'coordenada' && typeof item.lat === 'number' && typeof item.lon === 'number') {
        await handleCoordinatePicked(item.lat, item.lon);
        return;
      }
      setQuery(item.query);
      await handleAnalyze(item.query);
    },
    [handleAnalyze, handleCoordinatePicked]
  );

  const handleSelectRegionFocus = useCallback((reg: string) => {
    setFocusRegion(null);
    requestAnimationFrame(() => setFocusRegion(reg));
    setMobileView('map');
  }, []);

  const handleOpenStreetDirect = useCallback(
    async (street: StreetEntry) => {
      const ctx = [street.b, street.lot].filter(Boolean)[0];
      const munSuffix = street.m === 'TIJ' ? ', Tijucas do Sul' : '';
      const fullTarget = `${street.n}${ctx ? `, ${ctx}` : ''}${munSuffix}`;
      setQuery(fullTarget);
      await handleAnalyze(fullTarget);
    },
    [handleAnalyze]
  );

  const handleOpenStreetView = useCallback(() => {
    setStreetViewTriggerTick((t) => t + 1);
    setMobileView('map');
  }, []);

  const handleSaveApiKey = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = keyInput.trim();
    setGmapsError(null);
    setCustomApiKey(cleaned);
    try {
      if (cleaned) window.localStorage.setItem(STORAGE_KEY, cleaned);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setShowKeyModal(false);
  };

  const handleClearApiKey = () => {
    setGmapsError(null);
    setCustomApiKey('');
    setKeyInput('');
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setShowKeyModal(false);
  };

  if (loadError) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-slate-950 text-slate-200 gap-4 p-6 text-center">
        <div className="w-12 h-12 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center">
          <AlertTriangle className="w-6 h-6 text-rose-400" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-bold text-white">Erro ao carregar dados do mapa</h2>
          <p className="text-xs text-slate-400">{loadError}</p>
        </div>
        <button
          type="button"
          onClick={() => setReloadTick((t) => t + 1)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs font-bold text-white transition"
        >
          <RotateCw className="w-3.5 h-3.5" />
          Tentar novamente
        </button>
      </div>
    );
  }

  if (!geoLayers || !rodoviasKm) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-slate-950 text-slate-300 gap-3">
        <Loader2 className="w-7 h-7 animate-spin text-blue-400" />
        <span className="text-xs font-medium text-slate-400">Carregando mapa...</span>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* Minimal Dark Header */}
      <header className="h-12 shrink-0 bg-slate-950 text-white px-4 flex items-center justify-between border-b border-slate-800/90 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0">
            <Scale className="w-4 h-4 text-blue-400" />
          </div>
          <h1 className="text-sm font-bold tracking-tight text-slate-100 truncate">
            Central de Mandados · São José dos Pinhais
          </h1>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Mobile View Toggle (<540px only; 540px+ shows Consulta & Mapa side by side) */}
          <div className="flex min-[540px]:hidden bg-slate-900 rounded-lg p-0.5 border border-slate-800">
            <button
              onClick={() => setMobileView('map')}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1 ${
                mobileView === 'map' ? 'bg-blue-600 text-white' : 'text-slate-400'
              }`}
            >
              <MapIcon className="w-3 h-3" /> Mapa
            </button>
            <button
              onClick={() => setMobileView('split')}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1 ${
                mobileView === 'split' ? 'bg-blue-600 text-white' : 'text-slate-400'
              }`}
            >
              <Search className="w-3 h-3" /> Consulta
            </button>
          </div>
        </div>
      </header>

      {/* Main Split Command Workspace */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* Left Triage Panel */}
        <div
          className={`${
            mobileView === 'split' ? 'flex' : 'hidden'
          } min-[540px]:flex w-full min-[540px]:w-[270px] sm:w-[330px] md:w-[420px] lg:w-[470px] shrink-0 h-full flex-col`}
        >
          <TriagePanel
            geoLayers={geoLayers}
            streets={streets}
            streetAliases={streetAliases}
            query={query}
            setQuery={setQuery}
            isAnalyzing={isAnalyzing}
            activeResult={activeResult}
            searchHistory={searchHistory}
            nowTick={nowTick}
            onAnalyze={handleAnalyze}
            onSelectRegionFocus={handleSelectRegionFocus}
            onOpenStreetDirect={handleOpenStreetDirect}
            onOpenStreetView={handleOpenStreetView}
            onSelectHistoryItem={handleSelectHistoryItem}
            onRemoveHistoryItem={handleRemoveHistoryItem}
            onClearHistory={handleClearHistory}
          />
        </div>

        {/* Right Interactive Google Map + Split-Screen Street View */}
        <div
          className={`${
            mobileView === 'map' ? 'block' : 'hidden'
          } min-[540px]:block flex-1 h-full relative min-w-0`}
        >
          {activeGoogleKey && !gmapsError ? (
            <GoogleMapsSplitView
              apiKey={activeGoogleKey}
              geoLayers={geoLayers}
              rodoviasKm={rodoviasKm}
              activeResult={activeResult}
              focusRegion={focusRegion}
              streetViewTriggerTick={streetViewTriggerTick}
              onCoordinatePicked={handleCoordinatePicked}
              onSelectRegionFocus={handleSelectRegionFocus}
              onAuthError={(msg) => {
                setGmapsError(msg);
                setShowKeyModal(true);
              }}
              onOpenKeyModal={() => setShowKeyModal(true)}
            />
          ) : (
            <MandadosMap
              geoLayers={geoLayers}
              rodoviasKm={rodoviasKm}
              activeResult={activeResult}
              focusRegion={focusRegion}
              streetViewTriggerTick={streetViewTriggerTick}
              onCoordinatePicked={handleCoordinatePicked}
              onSelectRegionFocus={handleSelectRegionFocus}
              onOpenKeyModal={() => setShowKeyModal(true)}
            />
          )}
        </div>
      </main>

      {/* Google Maps API Key Configuration Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 z-[1000] bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-2xl max-w-lg w-full shadow-2xl border border-slate-800 overflow-hidden text-slate-200">
            <div className="bg-slate-950 text-white px-5 py-4 flex items-center justify-between border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <KeyRound className="w-4 h-4 text-amber-400" />
                <div>
                  <h2 className="text-sm font-bold">Google Maps API Key (opcional)</h2>
                </div>
              </div>
              <button
                onClick={() => setShowKeyModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveApiKey} className="p-5 space-y-4 text-xs text-slate-300">
              {gmapsError && (
                <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 font-medium">
                  <strong>Aviso:</strong> {gmapsError}
                </div>
              )}

              <div className="space-y-1.5">
                <label className="font-semibold text-slate-200 block">
                  Chave da Google Maps JavaScript API
                </label>
                <input
                  type="text"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 placeholder:text-slate-600 font-mono text-xs focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 text-[11px] text-slate-400 space-y-1">
                <div className="font-semibold text-slate-300">Vercel Environment Variable:</div>
                <code className="block text-slate-300 font-mono">
                  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=sua_chave_aqui
                </code>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                {customApiKey ? (
                  <button
                    type="button"
                    onClick={handleClearApiKey}
                    className="px-3 py-2 rounded-xl border border-rose-800/80 text-rose-300 hover:bg-rose-950/50 font-semibold"
                  >
                    Remover Chave
                  </button>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowKeyModal(false)}
                    className="px-3.5 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 font-semibold"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-sm"
                  >
                    Salvar
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
