'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  Compass,
  Crosshair,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  Loader2,
  Map as MapIcon,
  Maximize2,
  Navigation,
  RotateCw,
  SplitSquareVertical,
  X,
} from 'lucide-react';
import { classifyCoordinates, quickRegionAt } from '@/lib/geoMath';
import { loadGoogleMapsApi } from '@/lib/googleMapsLoader';
import {
  REGION_COLORS,
  REGION_FILL_OPACITY,
  getRegionTextColor,
  isLightRegionColor,
} from '@/lib/mandadosEngine';
import type { AnalysisResult, GeoLayers, RodoviasKmDB } from '@/types/mandados';

interface GoogleMapsSplitViewProps {
  apiKey: string;
  geoLayers: GeoLayers;
  rodoviasKm: RodoviasKmDB;
  activeResult: AnalysisResult | null;
  focusRegion: string | null;
  streetViewTriggerTick: number;
  onCoordinatePicked: (lat: number, lon: number) => void;
  onSelectRegionFocus: (reg: string) => void;
  onAuthError: (msg: string) => void;
  onOpenKeyModal: () => void;
}

type GMapType = 'roadmap' | 'hybrid' | 'terrain' | 'satellite' | '3d';

export default function GoogleMapsSplitView({
  apiKey,
  geoLayers,
  rodoviasKm,
  activeResult,
  focusRegion,
  streetViewTriggerTick,
  onCoordinatePicked,
  onSelectRegionFocus,
  onAuthError,
  onOpenKeyModal,
}: GoogleMapsSplitViewProps) {
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const panoDivRef = useRef<HTMLDivElement | null>(null);

  const mapRef = useRef<google.maps.Map | null>(null);
  const panoRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const coverageRef = useRef<google.maps.StreetViewCoverageLayer | null>(null);

  const polygonOverlaysRef = useRef<google.maps.Polygon[]>([]);
  const tijucasOverlaysRef = useRef<Array<google.maps.Polygon | google.maps.Circle>>([]);
  const divisaOverlayRef = useRef<google.maps.Polygon | null>(null);
  const criticosMarkersRef = useRef<google.maps.Marker[]>([]);
  const highwayMarkersRef = useRef<google.maps.Circle[]>([]);
  const resultOverlaysRef = useRef<Array<google.maps.Polyline | google.maps.Marker>>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);

  const [sdkReady, setSdkReady] = useState(false);
  const [mapType, setMapType] = useState<GMapType>('roadmap');
  const [splitOpen, setSplitOpen] = useState(false);
  const [svImmersive, setSvImmersive] = useState(true);
  const [showCoverage, setShowCoverage] = useState(true);
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [panoInfo, setPanoInfo] = useState<{ lat: number; lon: number; reg: string; desc: string } | null>(null);
  const hudWrapRef = useRef<HTMLDivElement | null>(null);
  const hudRegRef = useRef<HTMLSpanElement | null>(null);
  const hudCoordRef = useRef<HTMLSpanElement | null>(null);
  const lastFlyPinKeyRef = useRef<string>('');
  const [visibleLayers, setVisibleLayers] = useState({
    polygons: true,
    tijucas: true,
    divisa: true,
    criticos: false,
    highways: false,
  });

  const onCoordRef = useRef(onCoordinatePicked);
  onCoordRef.current = onCoordinatePicked;

  // Initialize official Google Maps + StreetViewPanorama
  useEffect(() => {
    let cancelled = false;
    loadGoogleMapsApi(apiKey)
      .then((g) => {
        if (cancelled || !mapDivRef.current || !panoDivRef.current) return;

        const map = new g.maps.Map(mapDivRef.current, {
          center: { lat: -25.59, lng: -49.14 },
          zoom: 12,
          mapTypeId: g.maps.MapTypeId.ROADMAP,
          streetViewControl: true,
          mapTypeControl: false,
          fullscreenControl: false,
          zoomControl: true,
          gestureHandling: 'greedy',
        });

        const pano = new g.maps.StreetViewPanorama(panoDivRef.current, {
          position: { lat: -25.54045, lng: -49.19599 },
          pov: { heading: 0, pitch: 0 },
          addressControl: true,
          linksControl: true,
          panControl: true,
          enableCloseButton: false,
        });

        map.setStreetView(pano);
        const coverage = new g.maps.StreetViewCoverageLayer();
        coverage.setMap(map);

        const iw = new g.maps.InfoWindow();
        infoWindowRef.current = iw;
        mapRef.current = map;
        panoRef.current = pano;
        coverageRef.current = coverage;

        // Open split screen whenever user drops Pegman or moves into Street View
        pano.addListener('visible_changed', () => {
          if (pano.getVisible()) {
            setSplitOpen(true);
          }
        });

        pano.addListener('position_changed', () => {
          const pos = pano.getPosition();
          if (!pos) return;
          const lat = pos.lat();
          const lon = pos.lng();
          const cls = classifyCoordinates(lat, lon, geoLayers);
          setPanoInfo({ lat, lon, reg: cls.regiao, desc: cls.subtitulo });
          map.panTo(pos);
        });

        // Click anywhere on map -> classify coordinate
        map.addListener('click', (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          const lat = Number(e.latLng.lat().toFixed(6));
          const lon = Number(e.latLng.lng().toFixed(6));
          onCoordRef.current(lat, lon);
        });

        let lastGmHudTs = 0;
        map.addListener('mousemove', (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          const now = performance.now();
          if (now - lastGmHudTs < 120) return;
          lastGmHudTs = now;
          const lat = e.latLng.lat();
          const lon = e.latLng.lng();
          const reg = quickRegionAt(lat, lon, geoLayers);
          if (hudWrapRef.current) hudWrapRef.current.style.opacity = '1';
          if (hudRegRef.current) hudRegRef.current.textContent = reg;
          if (hudCoordRef.current) hudCoordRef.current.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        });

        // Draw Divisa SJP
        divisaOverlayRef.current = new g.maps.Polygon({
          paths: geoLayers.divisa_sjp.map(([lat, lng]) => ({ lat, lng })),
          strokeColor: '#0F172A',
          strokeOpacity: 0.85,
          strokeWeight: 2,
          fillOpacity: 0,
          clickable: false,
          map,
        });

        // Draw Official SJP Polygons (1..6)
        polygonOverlaysRef.current = geoLayers.oficiais_sjp.map((poly) => {
          const regCol = REGION_COLORS[poly.regiao] || poly.cor;
          const p = new g.maps.Polygon({
            paths: poly.coords.map(([lat, lng]) => ({ lat, lng })),
            strokeColor: isLightRegionColor(regCol) ? '#C69200' : regCol,
            strokeOpacity: 0.92,
            strokeWeight: 2,
            fillColor: regCol,
            fillOpacity: REGION_FILL_OPACITY[poly.regiao] ?? 0.24,
            clickable: true,
            map,
          });
          p.addListener('click', (e: google.maps.PolyMouseEvent) => {
            if (!e.latLng) return;
            onCoordRef.current(Number(e.latLng.lat().toFixed(6)), Number(e.latLng.lng().toFixed(6)));
          });
          return p;
        });

        // Draw Tijucas do Sul + Castelhanos (Região 7)
        const tijPoly = new g.maps.Polygon({
          paths: geoLayers.tijucas_sul.map(([lat, lng]) => ({ lat, lng })),
          strokeColor: REGION_COLORS['Região 7'],
          strokeOpacity: 0.9,
          strokeWeight: 2,
          fillColor: REGION_COLORS['Região 7'],
          fillOpacity: 0.14,
          map,
        });
        tijPoly.addListener('click', (e: google.maps.PolyMouseEvent) => {
          if (!e.latLng) return;
          onCoordRef.current(Number(e.latLng.lat().toFixed(6)), Number(e.latLng.lng().toFixed(6)));
        });
        const castCircle = new g.maps.Circle({
          center: { lat: -25.7997, lng: -48.90974 },
          radius: 2300,
          strokeColor: REGION_COLORS['Região 7'],
          strokeWeight: 2,
          fillColor: REGION_COLORS['Região 7'],
          fillOpacity: 0.22,
          map,
        });
        castCircle.addListener('click', (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          onCoordRef.current(Number(e.latLng.lat().toFixed(6)), Number(e.latLng.lng().toFixed(6)));
        });
        tijucasOverlaysRef.current = [tijPoly, castCircle];

        // Draw Critical Points (R9, Forum, Pegadinhas)
        criticosMarkersRef.current = geoLayers.pontos_criticos.map((pt) => {
          const col = REGION_COLORS[pt.regiao] || '#0F172A';
          const m = new g.maps.Marker({
            position: { lat: pt.lat, lng: pt.lon },
            title: `${pt.nome} (${pt.regiao})`,
            icon: {
              path: g.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: pt.regiao === 'Região 9' ? '#DC2626' : pt.categoria.includes('Pegadinha') ? '#DB2777' : '#0F172A',
              fillOpacity: 1,
              strokeColor: '#FFFFFF',
              strokeWeight: 2.5,
            },
          });
          m.addListener('click', () => {
            iw.setContent(
              `<div style="max-width:240px;font-family:Inter,sans-serif">
                <div style="display:inline-block;background:${col};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-bottom:4px">${pt.regiao} · ${pt.categoria}</div>
                <div style="font-weight:700;font-size:13px;color:#0F172A">${pt.nome}</div>
                <div style="font-size:11px;color:#475569;margin:2px 0 4px">${pt.endereco}</div>
                <div style="font-size:11px;color:#1E293B;background:#F8FAFC;padding:4px 6px;border-left:3px solid ${col}">${pt.nota}</div>
              </div>`
            );
            iw.open(map, m);
          });
          return m;
        });

        // Draw Highway KM dots
        const kmCircles: google.maps.Circle[] = [];
        (['BR-277', 'BR-376', 'BR-116'] as const).forEach((rod) => {
          Object.values(rodoviasKm[rod] || {}).forEach((entry) => {
            const isBorder = entry.regioes.some((r) => r.toLowerCase().includes('divisa') || r.toLowerCase().includes('fora'));
            if (!isBorder && entry.km % 2 !== 0) return;
            const primaryR = entry.regioes[0].match(/Região\s*\d+A?/)?.[0] || entry.regioes[0];
            const col = entry.regioes[0].includes('Fora') ? '#E11D48' : REGION_COLORS[primaryR] || '#0D9488';
            const c = new g.maps.Circle({
              center: { lat: entry.lat, lng: entry.lon },
              radius: isBorder ? 110 : 75,
              strokeColor: '#FFFFFF',
              strokeWeight: 1.5,
              fillColor: col,
              fillOpacity: 0.95,
            });
            c.addListener('click', () => {
              iw.setPosition({ lat: entry.lat, lng: entry.lon });
              iw.setContent(
                `<div style="font-family:Inter,sans-serif">
                  <div style="font-weight:800;font-size:12px">${rod} — km ${entry.km}</div>
                  <div style="font-weight:700;color:${col};font-size:12px;margin:2px 0">${entry.regioes.join(' / ')}</div>
                  <div style="font-size:11px;color:#64748B">${entry.fonte}</div>
                </div>`
              );
              iw.open(map);
            });
            kmCircles.push(c);
          });
        });
        highwayMarkersRef.current = kmCircles;

        setSdkReady(true);
      })
      .catch((err) => {
        if (!cancelled) {
          onAuthError(err instanceof Error ? err.message : 'Erro ao carregar Google Maps API');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, geoLayers, rodoviasKm, onAuthError]);

  // Update mapTypeId & 45° 3D tilt
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    const g = window.google.maps;
    if (mapType === '3d') {
      map.setMapTypeId(g.MapTypeId.HYBRID);
      map.setTilt(45);
      if ((map.getZoom() || 12) < 17) map.setZoom(18);
      return;
    }
    map.setTilt(0);
    const mapping: Record<Exclude<GMapType, '3d'>, google.maps.MapTypeId> = {
      roadmap: g.MapTypeId.ROADMAP,
      hybrid: g.MapTypeId.HYBRID,
      terrain: g.MapTypeId.TERRAIN,
      satellite: g.MapTypeId.SATELLITE,
    };
    map.setMapTypeId(mapping[mapType]);
  }, [mapType]);

  // Toggle StreetView coverage layer
  useEffect(() => {
    if (coverageRef.current) {
      coverageRef.current.setMap(showCoverage ? mapRef.current : null);
    }
  }, [showCoverage]);

  // Toggle data layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    polygonOverlaysRef.current.forEach((p) => p.setMap(visibleLayers.polygons ? map : null));
    tijucasOverlaysRef.current.forEach((p) => p.setMap(visibleLayers.tijucas ? map : null));
    divisaOverlayRef.current?.setMap(visibleLayers.divisa ? map : null);
    criticosMarkersRef.current.forEach((m) => m.setMap(visibleLayers.criticos ? map : null));
    highwayMarkersRef.current.forEach((c) => c.setMap(visibleLayers.highways ? map : null));
  }, [visibleLayers]);

  // Focus region
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusRegion || !window.google?.maps) return;
    const bounds = new window.google.maps.LatLngBounds();
    if (focusRegion === 'Região 7') {
      geoLayers.tijucas_sul.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
      bounds.extend({ lat: -25.7997, lng: -48.90974 });
      map.fitBounds(bounds);
      return;
    }
    const polys = geoLayers.oficiais_sjp.filter((p) => p.regiao === focusRegion);
    if (polys.length) {
      polys.forEach((p) => p.coords.forEach(([lat, lng]) => bounds.extend({ lat, lng })));
      map.fitBounds(bounds);
    }
  }, [focusRegion, geoLayers]);

  // Render activeResult street polylines & pin + open Street View if requested
  useEffect(() => {
    const map = mapRef.current;
    const g = window.google?.maps;
    if (!map || !g) return;

    resultOverlaysRef.current.forEach((o) => o.setMap(null));
    resultOverlaysRef.current = [];
    if (!activeResult) return;

    const bounds = new g.LatLngBounds();

    activeResult.highlightPolylines?.forEach((seg) => {
      const path = seg.p.map(([lat, lng]) => ({ lat, lng }));
      path.forEach((pt) => bounds.extend(pt));
      const col = REGION_COLORS[seg.r] || activeResult.cor || '#2563EB';
      const halo = new g.Polyline({
        path,
        strokeColor: '#FFFFFF',
        strokeWeight: 9,
        strokeOpacity: 0.9,
        map,
        zIndex: 40,
      });
      const line = new g.Polyline({
        path,
        strokeColor: col,
        strokeWeight: 5,
        strokeOpacity: 1,
        map,
        zIndex: 41,
      });
      resultOverlaysRef.current.push(halo, line);
    });

    if (activeResult.pin) {
      const { lat, lon, label, fonte, regiao } = activeResult.pin;
      const col = activeResult.cor || REGION_COLORS[regiao] || '#2563EB';
      bounds.extend({ lat, lng: lon });
      const marker = new g.Marker({
        position: { lat, lng: lon },
        map,
        zIndex: 60,
        icon: {
          url: '/mascot/full.png',
          scaledSize: new g.Size(18, 52),
          anchor: new g.Point(9, 50),
        },
      });
      const rv = activeResult.reverseAddress;
      const iwHtml = rv
        ? `<div style="font-family:Inter,sans-serif;min-width:225px">
            <div style="display:inline-block;background:${col};color:#fff;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;margin-bottom:6px">${regiao}</div>
            <div style="font-size:12px;color:#0F172A;line-height:1.45">
              <div><strong style="color:#64748B;font-size:10px">RUA:</strong> <strong>${rv.road || label}${rv.houseNumber ? `, nº ${rv.houseNumber}` : ''}</strong></div>
              <div><strong style="color:#64748B;font-size:10px">BAIRRO:</strong> ${rv.suburb || 'Não informado'}</div>
              <div><strong style="color:#64748B;font-size:10px">ESTADO:</strong> ${[rv.city, rv.state || rv.uf].filter(Boolean).join(' – ') || 'Paraná'}</div>
              <div><strong style="color:#64748B;font-size:10px">CEP:</strong> <span style="font-family:monospace;font-weight:700">${rv.postcode || 'Não informado'}</span></div>
            </div>
          </div>`
        : `<div style="font-family:Inter,sans-serif;min-width:200px">
            <div style="display:inline-block;background:${col};color:#fff;font-size:11px;font-weight:800;padding:2px 9px;border-radius:999px;margin-bottom:4px">${regiao}</div>
            <div style="font-weight:700;font-size:13px;color:#0F172A">${label}</div>
            <div style="font-size:11px;color:#475569">${fonte}</div>
          </div>`;
      marker.addListener('click', () => {
        infoWindowRef.current?.setContent(iwHtml);
        infoWindowRef.current?.open(map, marker);
      });
      if (activeResult.signals.coords) {
        infoWindowRef.current?.setContent(iwHtml);
        infoWindowRef.current?.open(map, marker);
      }
      resultOverlaysRef.current.push(marker);
    }

    if (!bounds.isEmpty()) {
      const pinKey = activeResult.pin
        ? `${activeResult.pin.lat.toFixed(5)},${activeResult.pin.lon.toFixed(5)}`
        : '';
      if (!pinKey || lastFlyPinKeyRef.current !== pinKey) {
        if (pinKey) lastFlyPinKeyRef.current = pinKey;
        map.fitBounds(bounds, 60);
      }
    }
  }, [activeResult]);

  // Open Split-Screen Street View whenever user clicks "Ver Street View" button
  useEffect(() => {
    if (streetViewTriggerTick === 0 || !panoRef.current || !window.google?.maps) return;
    const targetLat = activeResult?.pin?.lat ?? -25.54045;
    const targetLon = activeResult?.pin?.lon ?? -49.19599;
    setSplitOpen(true);

    const svService = new window.google.maps.StreetViewService();
    svService.getPanorama(
      { location: { lat: targetLat, lng: targetLon }, radius: 150 },
      (data, status) => {
        if (status === window.google.maps.StreetViewStatus.OK && data?.location?.latLng) {
          panoRef.current?.setPosition(data.location.latLng);
          panoRef.current?.setVisible(true);
        } else {
          panoRef.current?.setPosition({ lat: targetLat, lng: targetLon });
          panoRef.current?.setVisible(true);
        }
      }
    );
  }, [streetViewTriggerTick, activeResult]);

  // Trigger map resize when split view opens/closes or layout toggles
  useEffect(() => {
    const timer = setTimeout(() => {
      if (mapRef.current && window.google?.maps) {
        window.google.maps.event.trigger(mapRef.current, 'resize');
      }
      if (panoRef.current && window.google?.maps) {
        window.google.maps.event.trigger(panoRef.current, 'resize');
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [splitOpen, svImmersive]);

  const currentSvLat = panoInfo?.lat ?? activeResult?.pin?.lat ?? -25.54045;
  const currentSvLon = panoInfo?.lon ?? activeResult?.pin?.lon ?? -49.19599;

  return (
    <div className="relative w-full h-full flex flex-col bg-slate-200 overflow-hidden">
      {/* TOP / IMMERSIVE PANE: NATIVE GOOGLE STREET VIEW 360° */}
      <div
        className={`relative w-full transition-all duration-300 bg-slate-950 ${
          !splitOpen
            ? 'h-0 min-h-0 overflow-hidden border-b-0'
            : svImmersive
            ? 'h-full z-10'
            : 'h-[58%] min-h-[280px] border-b-2 border-slate-800'
        }`}
      >
        <div ref={panoDivRef} className="w-full h-full" />

        {splitOpen && (
          <div className="absolute top-2.5 left-3 right-3 z-20 flex items-center justify-between gap-2 pointer-events-none">
            <div className="pointer-events-auto flex items-center gap-2 bg-slate-950/90 text-white backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-700 shadow-lg text-xs">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
              <span className="font-bold">Google Street View 360°</span>
              {panoInfo && (
                <>
                  <span className="text-slate-500">·</span>
                  <span
                    className="px-2 py-0.5 rounded-full text-[10px] font-extrabold"
                    style={{
                      backgroundColor: REGION_COLORS[panoInfo.reg] || '#FFD600',
                      color: getRegionTextColor(panoInfo.reg),
                    }}
                  >
                    {panoInfo.reg}
                  </span>
                </>
              )}
            </div>

            <div className="pointer-events-auto flex items-center gap-1.5">
              <button
                onClick={() => setSvImmersive((v) => !v)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold shadow-lg transition"
              >
                {svImmersive ? (
                  <>
                    <SplitSquareVertical className="w-3.5 h-3.5" />
                    Tela Dividida
                  </>
                ) : (
                  <>
                    <Maximize2 className="w-3.5 h-3.5" />
                    Tela Cheia + Mini-Mapa
                  </>
                )}
              </button>
              <a
                href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${currentSvLat},${currentSvLon}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white/95 hover:bg-white text-slate-900 text-[11px] font-bold shadow-lg transition"
              >
                <ExternalLink className="w-3.5 h-3.5 text-blue-600" />
                Maps ↗
              </a>
              <button
                onClick={() => {
                  panoRef.current?.setVisible(false);
                  setSplitOpen(false);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-bold shadow-lg transition"
              >
                <X className="w-3.5 h-3.5" />
                Fechar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* BOTTOM / MINI-MAP PANE: OFFICIAL GOOGLE MAPS */}
      <div
        className={
          splitOpen && svImmersive
            ? 'absolute bottom-4 left-4 w-[240px] h-[152px] z-30 rounded-xl border-2 border-white shadow-2xl overflow-hidden'
            : 'relative flex-1 w-full'
        }
      >
        {!sdkReady && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-100 text-slate-600 gap-2">
            <Loader2 className="w-7 h-7 animate-spin text-blue-600" />
            <span className="text-xs font-semibold">Conectando Google Maps & Street View 360°...</span>
          </div>
        )}

        <div ref={mapDivRef} className="w-full h-full" />

        {/* Subtle Bottom-Center Live Coordinate Pill */}
        <div
          ref={hudWrapRef}
          style={{ opacity: 0 }}
          className="hidden sm:flex absolute bottom-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none items-center gap-1.5 bg-slate-950/75 text-white backdrop-blur-md px-2.5 py-1 rounded-full text-[10px] font-mono shadow-sm transition-opacity duration-150"
        >
          <span ref={hudRegRef} className="font-sans font-bold text-emerald-300" />
          <span className="opacity-40">·</span>
          <span ref={hudCoordRef} />
        </div>

        {/* Top-Right Minimalist Google Map Controls */}
        <div className="absolute top-3 right-3 z-20 max-w-[calc(100%-24px)] flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-0.5 bg-white/92 backdrop-blur-md p-1 rounded-full shadow-lg border border-slate-200/80">
            {(
              [
                ['roadmap', 'Mapa'],
                ['hybrid', 'Satélite'],
                ['terrain', 'Terreno'],
              ] as Array<[Exclude<GMapType, '3d'>, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setMapType(id)}
                className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition ${
                  mapType === id ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {label}
              </button>
            ))}

            <button
              onClick={() => setMapType('3d')}
              className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition inline-flex items-center gap-1 ${
                mapType === '3d' ? 'bg-sky-600 text-white shadow-sm' : 'text-sky-700 hover:bg-sky-50'
              }`}
              title="Visão Aérea 3D (45° Google Maps)"
            >
              <Box className="w-3.5 h-3.5" />
              3D
            </button>

            {mapType === '3d' && (
              <button
                onClick={() => {
                  const m = mapRef.current;
                  if (m) m.setHeading(((m.getHeading() || 0) + 90) % 360);
                }}
                className="p-1.5 rounded-full text-sky-700 hover:bg-sky-50 transition"
                title="Girar câmera 3D 90°"
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            )}

            <div className="w-px h-4 bg-slate-200 mx-1" />

            <button
              onClick={() => setSplitOpen((s) => !s)}
              className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition flex items-center gap-1.5 ${
                splitOpen ? 'bg-amber-400 text-slate-950 shadow-sm' : 'bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200'
              }`}
              title="Alternar tela dividida do Street View 360°"
            >
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500 border border-slate-900" />
              Street View
            </button>

            <button
              onClick={() => setShowLayerMenu((s) => !s)}
              className={`p-1.5 rounded-full transition ${
                showLayerMenu ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Camadas no Google Maps"
            >
              <Layers className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={onOpenKeyModal}
              className="p-1.5 rounded-full text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition"
              title="Configurar Google Maps API Key"
            >
              <KeyRound className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => {
                mapRef.current?.setCenter({ lat: -25.59, lng: -49.14 });
                mapRef.current?.setZoom(11);
              }}
              className="p-1.5 rounded-full text-slate-600 hover:bg-slate-100 transition"
              title="Centralizar Comarca"
            >
              <Navigation className="w-3.5 h-3.5" />
            </button>
          </div>

          {showLayerMenu && (
            <div className="w-64 bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-slate-200 p-3 text-xs space-y-1.5">
              <div className="font-bold text-slate-800 pb-1 border-b border-slate-100">
                Camadas no Google Maps
              </div>
              <button
                onClick={() => setShowCoverage((v) => !v)}
                className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-slate-50 text-left"
              >
                <span className={showCoverage ? 'text-blue-700 font-semibold' : 'text-slate-400'}>
                  Cobertura Azul Street View
                </span>
                {showCoverage ? <Eye className="w-3.5 h-3.5 text-blue-600" /> : <EyeOff className="w-3.5 h-3.5 text-slate-300" />}
              </button>
              {(
                [
                  ['polygons', 'Polígonos Oficiais SJP (1–6)'],
                  ['tijucas', 'Região 7 (Tijucas + Castelhanos)'],
                  ['divisa', 'Divisa Municipal SJP'],
                  ['criticos', 'Pontos R9, Fórum & Pegadinhas'],
                  ['highways', 'Marcos KM (BR-277 / 376 / 116)'],
                ] as Array<[keyof typeof visibleLayers, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setVisibleLayers((v) => ({ ...v, [key]: !v[key] }))}
                  className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-slate-50 text-left"
                >
                  <span className={visibleLayers[key] ? 'text-slate-800 font-medium' : 'text-slate-400'}>
                    {label}
                  </span>
                  {visibleLayers[key] ? <Eye className="w-3.5 h-3.5 text-blue-600" /> : <EyeOff className="w-3.5 h-3.5 text-slate-300" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Bottom-Left Interactive Region Legend */}
        <div className="hidden md:block absolute bottom-6 left-3 z-20 bg-white/95 backdrop-blur-md rounded-xl shadow-lg border border-slate-200/90 p-2.5 max-w-[330px]">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
            <Compass className="w-3 h-3 text-slate-700" />
            Legenda Interativa (clique para dar zoom)
          </div>
          <div className="flex flex-wrap gap-1">
            {['Região 1', 'Região 1A', 'Região 2', 'Região 3', 'Região 4', 'Região 4A', 'Região 5', 'Região 6', 'Região 7', 'Região 9'].map(
              (reg) => {
                const col = REGION_COLORS[reg];
                return (
                  <button
                    key={reg}
                    onClick={() => onSelectRegionFocus(reg)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold border border-slate-200 hover:border-slate-400 bg-white transition"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{
                        backgroundColor: col,
                        border: isLightRegionColor(col) ? '1px solid #9A7B00' : 'none',
                      }}
                    />
                    <span className="text-slate-700">{reg.replace('Região ', 'R')}</span>
                  </button>
                );
              }
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
