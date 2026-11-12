'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Box,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  Loader2,
  LocateFixed,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  RotateCw,
  SplitSquareVertical,
  X,
} from 'lucide-react';
import MascotAvatar, {
  MASCOT_SPRITE_ASPECT,
  type MascotFacing,
  type MascotPoseState,
  getPointingAnchorPx,
  mountAnimatedMascotElement,
  preloadMascotSprites,
  resolvePointingFacing,
} from '@/components/MascotAvatar';
import OpenFreeMapView from '@/components/OpenFreeMapView';
import { classifyCoordinates, quickRegionAt } from '@/lib/geoMath';
import {
  REGION_COLORS,
  REGION_FILL_OPACITY,
  getRegionAccentTextColor,
  getRegionTextColor,
  isLightRegionColor,
} from '@/lib/mandadosEngine';
import type { AnalysisResult, GeoLayers, RodoviasKmDB } from '@/types/mandados';

interface MandadosMapProps {
  geoLayers: GeoLayers;
  rodoviasKm: RodoviasKmDB;
  activeResult: AnalysisResult | null;
  focusRegion: string | null;
  streetViewTriggerTick: number;
  onCoordinatePicked: (lat: number, lon: number) => void;
  onSelectRegionFocus: (reg: string) => void;
  onOpenKeyModal: () => void;
}

type BasemapId = 'google_roads' | 'google_hybrid' | 'google_terrain' | 'openfreemap';
type SvLayoutMode = 'split' | 'immersive';

interface PanoLookupResult {
  found: boolean;
  isOfficialCar?: boolean;
  panoId?: string;
  panoLat?: number;
  panoLon?: number;
  heading?: number;
  distanceMeters?: number;
  address?: string;
  captureDate?: string | null;
}

const BASEMAPS: Record<
  Exclude<BasemapId, 'openfreemap'>,
  { label: string; url: string; subdomains: string[]; attribution: string; maxNativeZoom: number }
> = {
  google_roads: {
    label: 'Mapa',
    url: 'https://{s}.google.com/vt/lyrs=m&hl=pt-BR&x={x}&y={y}&z={z}',
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '&copy; Google Maps',
    maxNativeZoom: 20,
  },
  google_hybrid: {
    label: 'Satélite',
    url: 'https://{s}.google.com/vt/lyrs=y&hl=pt-BR&x={x}&y={y}&z={z}',
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '&copy; Google Satélite',
    maxNativeZoom: 20,
  },
  google_terrain: {
    label: 'Terreno',
    url: 'https://{s}.google.com/vt/lyrs=p&hl=pt-BR&x={x}&y={y}&z={z}',
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '&copy; Google Terreno',
    maxNativeZoom: 15,
  },
};

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function createMascotDivIcon(
  hostClass: string,
  heightPx: number,
  popupAnchorY = 0,
  pointing = false,
  facing: MascotFacing = 'right'
): L.DivIcon {
  if (pointing) {
    const pt = getPointingAnchorPx(heightPx, facing);
    return L.divIcon({
      className: '',
      iconSize: [pt.widthPx, heightPx],
      iconAnchor: [pt.anchorX, pt.anchorY],
      popupAnchor: [pt.popupX, pt.popupY],
      html: `<div class="${hostClass}" style="width:${pt.widthPx}px;height:${heightPx}px;overflow:visible"></div>`,
    });
  }
  const widthPx = Math.max(10, Math.round(heightPx * MASCOT_SPRITE_ASPECT));
  return L.divIcon({
    className: '',
    iconSize: [widthPx, heightPx],
    iconAnchor: [Math.round(widthPx / 2), heightPx - 2],
    popupAnchor: [0, popupAnchorY],
    html: `<div class="${hostClass}" style="width:${widthPx}px;height:${heightPx}px;overflow:visible"></div>`,
  });
}

function attachMascotLifecycle(
  marker: L.Marker,
  hostClass: string,
  options: {
    heightPx: number;
    mode?: MascotPoseState;
    facing?: MascotFacing;
    auraColor?: string;
    showPulse?: boolean;
    hideGroundDot?: boolean;
    headingConeDeg?: number;
    phaseOffsetMs?: number;
  },
  cleanupSlot?: React.MutableRefObject<(() => void) | null>
): void {
  let localCleanup: (() => void) | null = null;
  const mount = () => {
    localCleanup?.();
    if (cleanupSlot) cleanupSlot.current?.();
    const el = marker.getElement()?.querySelector(`.${hostClass}`) as HTMLElement | null;
    if (!el) return;
    el.innerHTML = '';
    localCleanup = mountAnimatedMascotElement(el, options);
    if (cleanupSlot) cleanupSlot.current = localCleanup;
  };
  marker.on('add', mount);
  marker.on('remove', () => {
    localCleanup?.();
    localCleanup = null;
    if (cleanupSlot) {
      cleanupSlot.current?.();
      cleanupSlot.current = null;
    }
  });
}

export default function MandadosMap({
  geoLayers,
  rodoviasKm,
  activeResult,
  focusRegion,
  streetViewTriggerTick,
  onCoordinatePicked,
  onSelectRegionFocus,
  onOpenKeyModal,
}: MandadosMapProps) {
  const mapAreaRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const miniMapContainerRef = useRef<HTMLDivElement | null>(null);

  const mapRef = useRef<L.Map | null>(null);
  const miniMapRef = useRef<L.Map | null>(null);
  const miniPegmanRef = useRef<L.Marker | null>(null);
  const mainPegmanRef = useRef<L.Marker | null>(null);
  const mainPegmanCleanupRef = useRef<(() => void) | null>(null);
  const miniPegmanCleanupRef = useRef<(() => void) | null>(null);
  const resultMascotCleanupRef = useRef<(() => void) | null>(null);

  const ofmProjectorRef = useRef<
    ((clientX: number, clientY: number) => { lat: number; lon: number } | null) | null
  >(null);

  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const baseTileLayersRef = useRef<
    Partial<Record<Exclude<BasemapId, 'openfreemap'>, L.TileLayer>>
  >({});
  const prevBasemapRef = useRef<BasemapId>('google_roads');

  const layersRef = useRef<{
    polygons: L.LayerGroup;
    tijucas: L.LayerGroup;
    divisa: L.LayerGroup;
    criticos: L.LayerGroup;
    bairros: L.LayerGroup;
    highways: L.LayerGroup;
    result: L.LayerGroup;
  } | null>(null);

  const [basemap, setBasemap] = useState<BasemapId>('google_roads');
  const basemapRef = useRef<BasemapId>('google_roads');
  basemapRef.current = basemap;
  const [showPanel, setShowPanel] = useState(false);

  const hudWrapRef = useRef<HTMLDivElement | null>(null);
  const hudRegRef = useRef<HTMLSpanElement | null>(null);
  const hudCoordRef = useRef<HTMLSpanElement | null>(null);
  const isMapMovingRef = useRef(false);

  // Google Maps style Pegman dock + velocity pendulum drag-and-drop
  const [dockHovered, setDockHovered] = useState(false);
  const [pegmanDragging, setPegmanDragging] = useState(false);
  const [dropSplash, setDropSplash] = useState<{ x: number; y: number; key: number } | null>(null);
  const [dockPos, setDockPos] = useState<{ bottom: number; right: number }>({ bottom: 75, right: 8 });
  const pegmanGhostRef = useRef<HTMLDivElement | null>(null);
  const pegmanHoverLabelRef = useRef<HTMLSpanElement | null>(null);
  const pegmanTiltRef = useRef<number>(0);

  const [svOpen, setSvOpen] = useState(false);
  const [svLayout, setSvLayout] = useState<SvLayoutMode>('immersive');
  const [miniExpanded, setMiniExpanded] = useState(false);
  const [pegmanMode, setPegmanMode] = useState(false);
  const [heading, setHeading] = useState(0);
  const [svTarget, setSvTarget] = useState<{ lat: number; lon: number; street?: string }>({
    lat: -25.54045,
    lon: -49.19599,
  });

  const [svLoading, setSvLoading] = useState(false);
  const [panoInfo, setPanoInfo] = useState<PanoLookupResult | null>(null);

  const [visibleLayers, setVisibleLayers] = useState({
    polygons: true,
    tijucas: true,
    divisa: true,
    criticos: false,
    bairros: false,
    highways: false,
  });

  const onCoordinatePickedRef = useRef(onCoordinatePicked);
  onCoordinatePickedRef.current = onCoordinatePicked;

  const pegmanModeRef = useRef(pegmanMode);
  pegmanModeRef.current = pegmanMode;

  const svOpenRef = useRef(svOpen);
  svOpenRef.current = svOpen;

  const svLayoutRef = useRef(svLayout);
  svLayoutRef.current = svLayout;

  const lastFlyPinKeyRef = useRef<string>('');
  const panoAbortRef = useRef<AbortController | null>(null);

  const svClassification = classifyCoordinates(svTarget.lat, svTarget.lon, geoLayers);

  // Resolve real walkable Google Street View panorama nearest to target coordinates (respeitando o nome da rua!)
  const resolveStreetViewPano = useCallback(
    async (lat: number, lon: number, streetName?: string) => {
      if (panoAbortRef.current) panoAbortRef.current.abort();
      const ctrl = new AbortController();
      panoAbortRef.current = ctrl;

      setSvLoading(true);
      try {
        const qs = new URLSearchParams({
          lat: String(lat),
          lon: String(lon),
        });
        if (streetName) qs.set('street', streetName);
        const res = await fetch(`/api/streetview-pano?${qs.toString()}`, {
          signal: ctrl.signal,
        });
        if (res.ok) {
          const data: PanoLookupResult = await res.json();
          setPanoInfo(data);
          if (data.found && typeof data.heading === 'number') {
            setHeading(data.heading);
          }
        } else {
          setPanoInfo({ found: false });
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          setPanoInfo({ found: false });
        }
      } finally {
        if (panoAbortRef.current === ctrl) {
          setSvLoading(false);
        }
      }
    },
    []
  );

  const openStreetViewAt = useCallback(
    (lat: number, lon: number, mode?: SvLayoutMode, streetName?: string) => {
      setSvTarget({ lat, lon, street: streetName });
      if (mode) setSvLayout(mode);
      setSvOpen(true);
      resolveStreetViewPano(lat, lon, streetName);
    },
    [resolveStreetViewPano]
  );

  // Preload all custom realistic mascot sprites once
  useEffect(() => {
    preloadMascotSprites();
  }, []);

  // Measure exact bottom-right + / - zoom controls so Pegman dock sits directly above them in 2D and 3D!
  useEffect(() => {
    const area = mapAreaRef.current;
    if (!area) return;

    const DOCK_WIDTH = 36;
    const syncDockPos = () => {
      const areaRect = area.getBoundingClientRect();
      if (areaRect.width <= 0 || areaRect.height <= 0) return;

      if (basemap === 'openfreemap') {
        const ctrls = area.querySelectorAll('.maplibregl-ctrl-bottom-right .maplibregl-ctrl-group');
        let minTop = Infinity;
        let refRect: DOMRect | null = null;
        ctrls.forEach((node) => {
          const r = node.getBoundingClientRect();
          if (r.height > 0 && r.top < minTop) {
            minTop = r.top;
            refRect = r;
          }
        });
        if (refRect) {
          const r = refRect as DOMRect;
          const bottomPx = Math.max(84, Math.round(areaRect.bottom - r.top + 8));
          const ctrlCenterFromRight = areaRect.right - (r.left + r.width / 2);
          const rightPx = Math.max(4, Math.round(ctrlCenterFromRight - DOCK_WIDTH / 2));
          setDockPos((prev) =>
            prev.bottom === bottomPx && prev.right === rightPx
              ? prev
              : { bottom: bottomPx, right: rightPx }
          );
          return;
        }
        setDockPos((prev) =>
          prev.bottom === 156 && prev.right === 8 ? prev : { bottom: 156, right: 8 }
        );
        return;
      }

      const zoomEl = area.querySelector('.leaflet-control-zoom') as HTMLElement | null;
      if (zoomEl) {
        const r = zoomEl.getBoundingClientRect();
        if (r.height > 0) {
          const bottomPx = Math.max(70, Math.round(areaRect.bottom - r.top + 8));
          const ctrlCenterFromRight = areaRect.right - (r.left + r.width / 2);
          const rightPx = Math.max(4, Math.round(ctrlCenterFromRight - DOCK_WIDTH / 2));
          setDockPos((prev) =>
            prev.bottom === bottomPx && prev.right === rightPx
              ? prev
              : { bottom: bottomPx, right: rightPx }
          );
          return;
        }
      }
      setDockPos((prev) =>
        prev.bottom === 75 && prev.right === 8 ? prev : { bottom: 75, right: 8 }
      );
    };

    syncDockPos();
    const rafDock = requestAnimationFrame(syncDockPos);
    const t1 = window.setTimeout(syncDockPos, 150);
    const t2 = window.setTimeout(syncDockPos, 550);
    const t3 = window.setTimeout(syncDockPos, 1200);
    const ro = new ResizeObserver(syncDockPos);
    ro.observe(area);

    return () => {
      cancelAnimationFrame(rafDock);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      ro.disconnect();
    };
  }, [basemap, svOpen, svLayout]);

  // Convert viewport pointer coords to map lat/lon across 2D Leaflet and 3D MapLibre
  const screenPointToLatLon = useCallback(
    (clientX: number, clientY: number): { lat: number; lon: number } | null => {
      if (basemapRef.current === 'openfreemap') {
        return ofmProjectorRef.current ? ofmProjectorRef.current(clientX, clientY) : null;
      }
      const map = mapRef.current;
      if (!map) return null;
      const rect = map.getContainer().getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }
      const ll = map.containerPointToLatLng(L.point(clientX - rect.left, clientY - rect.top));
      return { lat: Number(ll.lat.toFixed(6)), lon: Number(ll.lng.toFixed(6)) };
    },
    []
  );

  // Authentic Google Maps Pegman grab, velocity pendulum swing & street drop!
  const handlePegmanPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      let lastX = e.clientX;
      let curX = e.clientX;
      let curY = e.clientY;
      let moved = false;
      let targetTilt = 0;
      let tiltRaf = 0;
      let splashTimer = 0;

      const updateGhost = (x: number, y: number) => {
        if (pegmanGhostRef.current) {
          pegmanGhostRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        }
        const pt = screenPointToLatLon(x, y);
        if (pegmanHoverLabelRef.current) {
          if (pt) {
            const reg = quickRegionAt(pt.lat, pt.lon, geoLayers);
            pegmanHoverLabelRef.current.textContent = `Soltar · ${reg}`;
          } else {
            pegmanHoverLabelRef.current.textContent = 'Solte em uma rua do mapa';
          }
        }
      };

      const stepTilt = () => {
        // Damped spring pendulum toward targetTilt (copies Google Maps Pegman inertia!)
        pegmanTiltRef.current += (targetTilt - pegmanTiltRef.current) * 0.24;
        targetTilt *= 0.84;
        tiltRaf = requestAnimationFrame(stepTilt);
      };

      const onMove = (ev: PointerEvent) => {
        curX = ev.clientX;
        curY = ev.clientY;
        const dxTotal = curX - startX;
        const dyTotal = curY - startY;
        if (!moved && Math.hypot(dxTotal, dyTotal) > 5) {
          moved = true;
          setPegmanMode(false);
          setPegmanDragging(true);
          tiltRaf = requestAnimationFrame(stepTilt);
          requestAnimationFrame(() => updateGhost(curX, curY));
        }
        if (moved) {
          const vx = curX - lastX;
          targetTilt = Math.max(-38, Math.min(38, vx * 1.65));
          lastX = curX;
          updateGhost(curX, curY);
        }
      };

      const cleanupListeners = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (tiltRaf) cancelAnimationFrame(tiltRaf);
        pegmanTiltRef.current = 0;
        setPegmanDragging(false);
      };

      const onUp = (ev: PointerEvent) => {
        const dropX = ev.clientX;
        const dropY = ev.clientY;
        cleanupListeners();

        if (!moved) {
          setPegmanMode((p) => !p);
          return;
        }

        const pt = screenPointToLatLon(dropX, dropY);
        const areaRect = mapAreaRef.current?.getBoundingClientRect();
        if (
          pt &&
          areaRect &&
          dropX >= areaRect.left &&
          dropX <= areaRect.right &&
          dropY >= areaRect.top &&
          dropY <= areaRect.bottom
        ) {
          const localX = dropX - areaRect.left;
          const localY = dropY - areaRect.top;
          setDropSplash({ x: localX, y: localY, key: Date.now() });
          if (splashTimer) window.clearTimeout(splashTimer);
          splashTimer = window.setTimeout(() => setDropSplash(null), 580);

          openStreetViewAt(pt.lat, pt.lon);
          onCoordinatePickedRef.current(pt.lat, pt.lon);
        }
      };

      const onCancel = () => {
        cleanupListeners();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [geoLayers, openStreetViewAt, screenPointToLatLon]
  );

  // Listen for custom popup button clicks inside Leaflet tooltips/popups
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ lat: number; lon: number; street?: string }>).detail;
      if (detail && typeof detail.lat === 'number' && typeof detail.lon === 'number') {
        openStreetViewAt(detail.lat, detail.lon, undefined, detail.street);
      }
    };
    window.addEventListener('sjp-open-sv', handler);
    return () => window.removeEventListener('sjp-open-sv', handler);
  }, [openStreetViewAt]);

  // Initialize Main Map (Google Maps Base)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [-25.58, -49.14],
      zoom: 12,
      zoomControl: false,
      preferCanvas: true,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

    const groups = {
      divisa: L.layerGroup().addTo(map),
      polygons: L.layerGroup().addTo(map),
      tijucas: L.layerGroup().addTo(map),
      highways: L.layerGroup(),
      bairros: L.layerGroup(),
      criticos: L.layerGroup(),
      result: L.layerGroup().addTo(map),
    };

    layersRef.current = groups;
    mapRef.current = map;

    map.on('click', (e: L.LeafletMouseEvent) => {
      const lat = Number(e.latlng.lat.toFixed(6));
      const lon = Number(e.latlng.lng.toFixed(6));
      if (pegmanModeRef.current) {
        setPegmanMode(false);
        openStreetViewAt(lat, lon);
      } else {
        setSvTarget({ lat, lon });
      }
      onCoordinatePickedRef.current(lat, lon);
    });

    map.on('movestart', () => {
      isMapMovingRef.current = true;
    });
    map.on('moveend', () => {
      isMapMovingRef.current = false;
    });

    let lastLeafletHudTs = 0;
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      if (isMapMovingRef.current) return;
      const now = performance.now();
      if (now - lastLeafletHudTs < 120) return;
      lastLeafletHudTs = now;
      const reg = quickRegionAt(e.latlng.lat, e.latlng.lng, geoLayers);
      if (hudWrapRef.current) hudWrapRef.current.style.opacity = '1';
      if (hudRegRef.current) hudRegRef.current.textContent = reg;
      if (hudCoordRef.current) {
        hudCoordRef.current.textContent = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
      }
    });

    // 1. Divisa municipal SJP (smoothFactor reduz vértices em Canvas para 60fps ao trocar camadas)
    L.polygon(geoLayers.divisa_sjp, {
      color: '#0F172A',
      weight: 2.2,
      dashArray: '6 5',
      fill: false,
      interactive: false,
      smoothFactor: 2.5,
    }).addTo(groups.divisa);

    // 2. Official SJP KML Polygons (1..6)
    geoLayers.oficiais_sjp.forEach((poly) => {
      const regCol = REGION_COLORS[poly.regiao] || poly.cor;
      const fillOp = REGION_FILL_OPACITY[poly.regiao] ?? 0.24;
      const isLight = isLightRegionColor(regCol);
      const borderCol = isLight ? '#C69200' : regCol;

      const p = L.polygon(poly.coords, {
        color: borderCol,
        weight: 2,
        opacity: 0.92,
        fillColor: regCol,
        fillOpacity: fillOp,
        smoothFactor: 1.5,
      });

      const info = geoLayers.regioes_info.find((r) => r.codigo === poly.regiao);
      const setorLabel = poly.setor
        ? `<div style="font-size:11px;color:#78350F;font-weight:600;margin-top:2px">Setor: ${poly.setor} (não existe 6A)</div>`
        : '';
      p.bindTooltip(
        `<div style="font-weight:700;color:${getRegionAccentTextColor(regCol)}">${poly.regiao}</div>${setorLabel}<div style="font-size:11px;color:#475569">${info?.qtd_ruas || 0} logradouros · ${info?.area_km2 || '—'} km²</div>`,
        { sticky: true, direction: 'top' }
      );
      p.addTo(groups.polygons);
    });

    // 3. Tijucas do Sul + Castelhanos (Região 7)
    L.polygon(geoLayers.tijucas_sul, {
      color: REGION_COLORS['Região 7'],
      weight: 2.2,
      fillColor: REGION_COLORS['Região 7'],
      fillOpacity: 0.14,
      smoothFactor: 2.5,
    })
      .bindTooltip(
        `<div style="font-weight:700;color:${REGION_COLORS['Região 7']}">Região 7 — Tijucas do Sul</div><div style="font-size:11px;color:#475569">Comarca de SJP (224 logradouros)</div>`,
        { sticky: true }
      )
      .addTo(groups.tijucas);

    L.circle([-25.7997, -48.90974], {
      radius: 2300,
      color: REGION_COLORS['Região 7'],
      weight: 2,
      dashArray: '5 4',
      fillColor: REGION_COLORS['Região 7'],
      fillOpacity: 0.2,
    })
      .bindTooltip(
        `<div style="font-weight:700;color:${REGION_COLORS['Região 7']}">Colônia Castelhanos -> Região 7</div><div style="font-size:11px;color:#475569">No My Maps aparece dentro da Região 5, mas vai para Região 7!</div>`
      )
      .addTo(groups.tijucas);

    // 4. Critical Points & Traps
    geoLayers.pontos_criticos.forEach((pt) => {
      const col = REGION_COLORS[pt.regiao] || '#0F172A';
      const isR9 = pt.regiao === 'Região 9';
      const isTrap = pt.categoria.includes('Pegadinha');
      const badgeBg = isR9 ? '#DC2626' : isTrap ? '#DB2777' : '#0F172A';
      const glyph = isR9 ? 'R9' : pt.id === 'foro' ? '⚖' : isTrap ? '!' : '★';

      const marker = L.marker([pt.lat, pt.lon], {
        icon: L.divIcon({
          className: '',
          iconSize: [26, 26],
          iconAnchor: [13, 13],
          html: `<div style="width:26px;height:26px;border-radius:999px;background:${badgeBg};color:white;border:2.5px solid white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:10px;box-shadow:0 3px 10px rgba(0,0,0,0.32)">${glyph}</div>`,
        }),
      });
      marker.bindPopup(`
        <div style="min-width:225px;font-family:Inter,sans-serif">
          <div style="display:inline-block;background:${col};color:${getRegionTextColor(col)};font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-bottom:4px">${pt.regiao} · ${pt.categoria}</div>
          <div style="font-weight:700;font-size:13px;color:#0F172A;margin-bottom:2px">${pt.nome}</div>
          <div style="font-size:11px;color:#475569;margin-bottom:6px">${pt.endereco}</div>
          <div style="font-size:11px;background:#F8FAFC;border-left:3px solid ${isLightRegionColor(col) ? '#C69200' : col};padding:5px 7px;color:#1E293B;border-radius:4px;margin-bottom:8px">${pt.nota}</div>
          <button onclick="window.dispatchEvent(new CustomEvent('sjp-open-sv',{detail:{lat:${pt.lat},lon:${pt.lon}}}))" style="display:inline-flex;align-items:center;gap:5px;background:#FACC15;color:#0F172A;border:1px solid #CA8A04;font-size:11px;font-weight:800;padding:5px 10px;border-radius:8px;cursor:pointer">Entrar no Street View 360°</button>
        </div>
      `);
      marker.addTo(groups.criticos);
    });

    // 5. Bairros & Localidades
    geoLayers.bairros_localidades.forEach((b) => {
      const col = REGION_COLORS[b.regiao] || '#475569';
      L.circleMarker([b.lat, b.lon], {
        radius: 4,
        color: '#fff',
        weight: 1.5,
        fillColor: col,
        fillOpacity: 0.9,
      })
        .bindTooltip(`<b>${b.nome}</b> · ${b.regiao}`, { direction: 'top' })
        .addTo(groups.bairros);
    });

    // 6. Highway KM markers
    (['BR-277', 'BR-376', 'BR-116'] as const).forEach((rod) => {
      Object.values(rodoviasKm[rod] || {}).forEach((e) => {
        const isBorder = e.regioes.some((r) => r.toLowerCase().includes('divisa') || r.toLowerCase().includes('fora'));
        if (!isBorder && e.km % 2 !== 0) return;
        const primaryR = e.regioes[0].match(/Região\s*\d+A?/)?.[0] || e.regioes[0];
        const col = e.regioes[0].includes('Fora') ? '#E11D48' : REGION_COLORS[primaryR] || '#0D9488';

        L.circleMarker([e.lat, e.lon], {
          radius: isBorder ? 5.5 : 4,
          color: '#FFFFFF',
          weight: 1.5,
          fillColor: col,
          fillOpacity: 0.95,
        })
          .bindPopup(
            `<div style="font-family:Inter,sans-serif">
               <div style="font-weight:800;font-size:12px;color:#0F172A">${rod} — km ${e.km}</div>
               <div style="font-weight:700;color:${col};font-size:12px;margin:3px 0">${e.regioes.join(' / ')}</div>
               <div style="font-size:11px;color:#64748B;margin-bottom:6px">${e.fonte}</div>
               <button onclick="window.dispatchEvent(new CustomEvent('sjp-open-sv',{detail:{lat:${e.lat},lon:${e.lon}}}))" style="display:inline-flex;align-items:center;gap:4px;background:#FACC15;color:#0F172A;border:1px solid #CA8A04;font-size:11px;font-weight:800;padding:4px 9px;border-radius:7px;cursor:pointer">Street View da Rodovia</button>
             </div>`
          )
          .addTo(groups.highways);
      });
    });

    let lastContainerW = containerRef.current.clientWidth;
    let lastContainerH = containerRef.current.clientHeight;
    let resizeRaf = 0;
    const initRaf = requestAnimationFrame(() => {
      mapRef.current?.invalidateSize({ animate: false });
    });
    const containerRo = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w > 0 && h > 0 && (w !== lastContainerW || h !== lastContainerH)) {
        lastContainerW = w;
        lastContainerH = h;
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          mapRef.current?.invalidateSize({ animate: false });
        });
      }
    });
    containerRo.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(initRaf);
      containerRo.disconnect();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      mainPegmanCleanupRef.current?.();
      mainPegmanCleanupRef.current = null;
      miniPegmanCleanupRef.current?.();
      miniPegmanCleanupRef.current = null;
      resultMascotCleanupRef.current?.();
      resultMascotCleanupRef.current = null;
      baseTileLayersRef.current = {};
      baseLayerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [geoLayers, rodoviasKm, openStreetViewAt]);

  // Troca instantânea e sem travamentos entre Mapa / Satélite / Terreno (reutiliza TileLayers + crossfade suave sem invalidateSize desnecessário)
  useEffect(() => {
    const map = mapRef.current;
    const prevMode = prevBasemapRef.current;
    prevBasemapRef.current = basemap;

    if (!map || basemap === 'openfreemap') return;

    const cfg = BASEMAPS[basemap];
    let nextLayer = baseTileLayersRef.current[basemap];
    if (!nextLayer) {
      nextLayer = L.tileLayer(cfg.url, {
        subdomains: cfg.subdomains,
        attribution: cfg.attribution,
        maxNativeZoom: cfg.maxNativeZoom,
        maxZoom: 21,
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 4,
      });
      baseTileLayersRef.current[basemap] = nextLayer;
    }

    const oldLayer = baseLayerRef.current;
    if (oldLayer !== nextLayer) {
      if (!map.hasLayer(nextLayer)) {
        nextLayer.addTo(map);
      }
      nextLayer.bringToBack();
      if (oldLayer && map.hasLayer(oldLayer)) {
        oldLayer.bringToBack();
      }
      baseLayerRef.current = nextLayer;

      let cleanupDone = false;
      const cleanupOld = () => {
        if (cleanupDone) return;
        cleanupDone = true;
        if (oldLayer && oldLayer !== baseLayerRef.current && map.hasLayer(oldLayer)) {
          map.removeLayer(oldLayer);
        }
      };

      nextLayer.once('load', cleanupOld);
      const timer = window.setTimeout(cleanupOld, 260);
      return () => {
        window.clearTimeout(timer);
        nextLayer?.off('load', cleanupOld);
        cleanupOld();
      };
    }

    if (prevMode === 'openfreemap') {
      const t = window.setTimeout(() => map.invalidateSize({ animate: false }), 60);
      return () => window.clearTimeout(t);
    }
  }, [basemap]);

  // Manage bottom-left Floating Mini-Map (in Immersive mode) and Split-Screen Pegman
  useEffect(() => {
    const mainMap = mapRef.current;
    const timer = setTimeout(() => mainMap?.invalidateSize(), 120);

    if (!svOpen) {
      if (miniMapRef.current) {
        miniPegmanCleanupRef.current?.();
        miniPegmanCleanupRef.current = null;
        miniMapRef.current.remove();
        miniMapRef.current = null;
        miniPegmanRef.current = null;
      }
      if (mainPegmanRef.current && mainMap) {
        mainPegmanCleanupRef.current?.();
        mainPegmanCleanupRef.current = null;
        mainMap.removeLayer(mainPegmanRef.current);
        mainPegmanRef.current = null;
      }
      return () => clearTimeout(timer);
    }

    const activeLat = panoInfo?.panoLat ?? svTarget.lat;
    const activeLon = panoInfo?.panoLon ?? svTarget.lon;

    // 1. In Split mode -> keep draggable custom mascot Pegman on main bottom map
    if (svLayout === 'split' && mainMap) {
      if (miniMapRef.current) {
        miniPegmanCleanupRef.current?.();
        miniPegmanCleanupRef.current = null;
        miniMapRef.current.remove();
        miniMapRef.current = null;
        miniPegmanRef.current = null;
      }
      if (!mainPegmanRef.current) {
        const m = L.marker([activeLat, activeLon], {
          draggable: true,
          zIndexOffset: 900,
          icon: createMascotDivIcon('sjp-mascot-main-pegman', 44, -46),
        });
        attachMascotLifecycle(
          m,
          'sjp-mascot-main-pegman',
          {
            heightPx: 44,
            auraColor: '#F59E0B',
            headingConeDeg: heading,
            phaseOffsetMs: 3500,
          },
          mainPegmanCleanupRef
        );
        m.addTo(mainMap);
        m.bindTooltip('Arraste o bonequinho para caminhar em outra rua!', { direction: 'top' });
        m.on('dragend', () => {
          const ll = m.getLatLng();
          const lat = Number(ll.lat.toFixed(6));
          const lon = Number(ll.lng.toFixed(6));
          openStreetViewAt(lat, lon);
          onCoordinatePickedRef.current(lat, lon);
        });
        mainPegmanRef.current = m;
      }
    }

    // 2. In Immersive mode -> build floating Bottom-Left Mini-Map just like Google Maps Street View!
    if (svLayout === 'immersive') {
      if (mainPegmanRef.current && mainMap) {
        mainPegmanCleanupRef.current?.();
        mainPegmanCleanupRef.current = null;
        mainMap.removeLayer(mainPegmanRef.current);
        mainPegmanRef.current = null;
      }
      if (miniMapContainerRef.current && !miniMapRef.current) {
        const mMap = L.map(miniMapContainerRef.current, {
          center: [activeLat, activeLon],
          zoom: 17,
          zoomControl: false,
          attributionControl: false,
        });

        L.tileLayer('https://{s}.google.com/vt/lyrs=m&hl=pt-BR&x={x}&y={y}&z={z}', {
          subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
          maxZoom: 20,
        }).addTo(mMap);

        // Draw subtle Region outlines inside mini-map
        geoLayers.oficiais_sjp.forEach((poly) => {
          L.polygon(poly.coords, {
            color: poly.cor,
            weight: 1.5,
            fillColor: poly.cor,
            fillOpacity: 0.14,
            interactive: false,
          }).addTo(mMap);
        });

        const peg = L.marker([activeLat, activeLon], {
          draggable: true,
          icon: createMascotDivIcon('sjp-mascot-mini-pegman', 34, -36),
        });
        attachMascotLifecycle(
          peg,
          'sjp-mascot-mini-pegman',
          {
            heightPx: 34,
            auraColor: '#F59E0B',
            headingConeDeg: heading,
            phaseOffsetMs: 2000,
          },
          miniPegmanCleanupRef
        );
        peg.addTo(mMap);

        peg.on('dragend', () => {
          const ll = peg.getLatLng();
          const lat = Number(ll.lat.toFixed(6));
          const lon = Number(ll.lng.toFixed(6));
          openStreetViewAt(lat, lon);
          onCoordinatePickedRef.current(lat, lon);
        });

        mMap.on('click', (e: L.LeafletMouseEvent) => {
          const lat = Number(e.latlng.lat.toFixed(6));
          const lon = Number(e.latlng.lng.toFixed(6));
          openStreetViewAt(lat, lon);
          onCoordinatePickedRef.current(lat, lon);
        });

        miniMapRef.current = mMap;
        miniPegmanRef.current = peg;
        setTimeout(() => mMap.invalidateSize(), 150);
      }
    }

    return () => clearTimeout(timer);
  }, [svOpen, svLayout, geoLayers, openStreetViewAt]);

  // Resize mini-map when expanded/collapsed
  useEffect(() => {
    const t = setTimeout(() => miniMapRef.current?.invalidateSize(), 200);
    return () => clearTimeout(t);
  }, [miniExpanded]);

  // Keep Pegman markers synced to panoLat/panoLon and heading
  useEffect(() => {
    const activeLat = panoInfo?.panoLat ?? svTarget.lat;
    const activeLon = panoInfo?.panoLon ?? svTarget.lon;
    if (mainPegmanRef.current) {
      mainPegmanRef.current.setLatLng([activeLat, activeLon]);
      const cone = mainPegmanRef.current
        .getElement()
        ?.querySelector('[data-sv-cone]') as HTMLElement | null;
      if (cone) cone.style.transform = `rotate(${heading}deg)`;
    }
    if (miniPegmanRef.current && miniMapRef.current) {
      miniPegmanRef.current.setLatLng([activeLat, activeLon]);
      const cone = miniPegmanRef.current
        .getElement()
        ?.querySelector('[data-sv-cone]') as HTMLElement | null;
      if (cone) cone.style.transform = `rotate(${heading}deg)`;
      miniMapRef.current.setView([activeLat, activeLon], Math.max(miniMapRef.current.getZoom(), 17), {
        animate: true,
      });
    }
  }, [panoInfo, svTarget, heading]);

  // Toggle layers visibility
  useEffect(() => {
    const map = mapRef.current;
    const g = layersRef.current;
    if (!map || !g) return;

    (Object.keys(visibleLayers) as Array<keyof typeof visibleLayers>).forEach((k) => {
      const grp = g[k];
      if (visibleLayers[k]) {
        if (!map.hasLayer(grp)) map.addLayer(grp);
      } else {
        if (map.hasLayer(grp)) map.removeLayer(grp);
      }
    });
  }, [visibleLayers]);

  // Focus region
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusRegion) return;

    if (svOpenRef.current && svLayoutRef.current === 'immersive') {
      setSvOpen(false);
    }

    if (focusRegion === 'Região 7') {
      const bounds = L.latLngBounds(geoLayers.tijucas_sul);
      bounds.extend([-25.7997, -48.90974]);
      map.flyToBounds(bounds, { padding: [30, 30], duration: 0.7 });
      return;
    }

    const matching = geoLayers.oficiais_sjp.filter((p) => p.regiao === focusRegion);
    if (matching.length > 0) {
      const bounds = L.latLngBounds(matching.flatMap((m) => m.coords));
      map.flyToBounds(bounds, { padding: [35, 35], duration: 0.7 });
    }
  }, [focusRegion, geoLayers]);

  // Render activeResult street polylines & custom mascot pin + sync Street View if already open
  useEffect(() => {
    const map = mapRef.current;
    const g = layersRef.current;
    if (!map || !g) return;

    resultMascotCleanupRef.current?.();
    resultMascotCleanupRef.current = null;
    g.result.clearLayers();
    if (!activeResult) return;

    const bounds = L.latLngBounds([]);

    if (activeResult.highlightPolylines && activeResult.highlightPolylines.length > 0) {
      activeResult.highlightPolylines.forEach((seg) => {
        const segCol = REGION_COLORS[seg.r] || activeResult.cor || '#FFD600';
        const haloCol = isLightRegionColor(segCol) ? '#0F172A' : '#FFFFFF';
        L.polyline(seg.p, {
          color: haloCol,
          weight: 9,
          opacity: 0.9,
          lineCap: 'round',
        }).addTo(g.result);

        L.polyline(seg.p, {
          color: segCol,
          weight: 5,
          opacity: 1,
          lineCap: 'round',
        })
          .bindTooltip(`<b>Trecho em ${seg.r}</b>`, { sticky: true })
          .addTo(g.result);

        seg.p.forEach((pt) => bounds.extend(pt));
      });
    }

    if (activeResult.pin) {
      const { lat, lon, label, fonte, regiao } = activeResult.pin;
      const pinCol = activeResult.cor || REGION_COLORS[regiao] || '#FFD600';
      const pinBadgeTxt = getRegionTextColor(pinCol);
      const streetNameHint =
        activeResult.bestMatch?.street.n || activeResult.reverseAddress?.road || '';
      const encodedStreetJs = escapeHtml(JSON.stringify(streetNameHint));
      bounds.extend([lat, lon]);
      setSvTarget({ lat, lon, street: streetNameHint || undefined });
      if (svOpenRef.current) {
        resolveStreetViewPano(lat, lon, streetNameHint || undefined);
      }

      const isPointingMode = Boolean(
        activeResult.signals.houseNumber ||
          activeResult.reverseAddress?.houseNumber ||
          activeResult.pin.fonte.includes('Geocodificação')
      );
      const pinHeight = isPointingMode ? 54 : 56;

      const mapSize = map.getSize();
      const pinPt = map.latLngToContainerPoint([lat, lon]);
      const facing: MascotFacing = isPointingMode
        ? resolvePointingFacing({
            pinLat: lat,
            pinLon: lon,
            polylines: activeResult.highlightPolylines,
            fallbackViewportFractionX: mapSize.x > 0 ? pinPt.x / mapSize.x : undefined,
          })
        : 'right';

      const customMarker = L.marker([lat, lon], {
        zIndexOffset: 600,
        icon: createMascotDivIcon(
          'sjp-mascot-pin-host',
          pinHeight,
          -(pinHeight + 4),
          isPointingMode,
          facing
        ),
      });
      attachMascotLifecycle(
        customMarker,
        'sjp-mascot-pin-host',
        {
          heightPx: pinHeight,
          mode: isPointingMode ? 'pointing' : 'dance',
          facing,
          showPulse: false,
          hideGroundDot: true,
        },
        resultMascotCleanupRef
      );

      const rv = activeResult.reverseAddress;
      const popupBody = rv
        ? (() => {
            const streetStr = rv.road
              ? `${rv.road}${rv.houseNumber ? `, nº ${rv.houseNumber}` : ''}`
              : label;
            const estadoStr = [rv.city, rv.state || rv.uf].filter(Boolean).join(' – ');
            return `
              <div style="min-width:230px;font-family:Inter,sans-serif">
                <div style="display:inline-block;background:${pinCol};color:${pinBadgeTxt};font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;margin-bottom:6px">${escapeHtml(regiao)}</div>
                <div style="font-size:12px;color:#0F172A;line-height:1.45;margin-bottom:8px">
                  <div><strong style="color:#64748B;font-size:10px;text-transform:uppercase">Rua:</strong> <strong>${escapeHtml(streetStr)}</strong></div>
                  <div><strong style="color:#64748B;font-size:10px;text-transform:uppercase">Bairro:</strong> ${escapeHtml(rv.suburb || 'Não informado')}</div>
                  <div><strong style="color:#64748B;font-size:10px;text-transform:uppercase">Estado:</strong> ${escapeHtml(estadoStr || 'Paraná')}</div>
                  <div><strong style="color:#64748B;font-size:10px;text-transform:uppercase">CEP:</strong> <span style="font-family:monospace;font-weight:700">${escapeHtml(rv.postcode || 'Não informado')}</span></div>
                </div>
                <button onclick="window.dispatchEvent(new CustomEvent('sjp-open-sv',{detail:{lat:${lat},lon:${lon},street:${encodedStreetJs}}}))" style="display:inline-flex;align-items:center;gap:5px;background:#FACC15;color:#0F172A;border:1px solid #CA8A04;font-size:11px;font-weight:800;padding:5px 10px;border-radius:8px;cursor:pointer">Street View 360°</button>
              </div>
            `;
          })()
        : `
          <div style="min-width:215px;font-family:Inter,sans-serif">
            <div style="display:inline-block;background:${pinCol};color:${pinBadgeTxt};font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;margin-bottom:5px">${escapeHtml(regiao)}</div>
            <div style="font-weight:700;font-size:12px;color:#0F172A;margin-bottom:2px">${escapeHtml(label)}</div>
            <div style="font-size:11px;color:#475569;margin-bottom:8px">${escapeHtml(fonte)}</div>
            <button onclick="window.dispatchEvent(new CustomEvent('sjp-open-sv',{detail:{lat:${lat},lon:${lon},street:${encodedStreetJs}}}))" style="display:inline-flex;align-items:center;gap:5px;background:#FACC15;color:#0F172A;border:1px solid #CA8A04;font-size:11px;font-weight:800;padding:5px 10px;border-radius:8px;cursor:pointer">Street View 360°</button>
          </div>
        `;

      customMarker.bindPopup(popupBody);
      customMarker.addTo(g.result);
      // Open popup automatically on direct map clicks (showing street, bairro, estado, CEP),
      // while leaving text/CEP searches unobstructed so the house or street dance is clearly visible!
      if (activeResult.signals.coords) {
        customMarker.openPopup();
      }
    }

    if (bounds.isValid()) {
      const pinKey = activeResult.pin
        ? `${activeResult.pin.lat.toFixed(5)},${activeResult.pin.lon.toFixed(5)}`
        : '';
      const shouldFly = !pinKey || lastFlyPinKeyRef.current !== pinKey;
      if (pinKey) lastFlyPinKeyRef.current = pinKey;

      if (shouldFly) {
        if (
          activeResult.highlightPolylines &&
          activeResult.highlightPolylines.length > 0 &&
          !activeResult.pin?.fonte.includes('Geocodificação') &&
          !activeResult.signals.houseNumber &&
          !activeResult.reverseAddress
        ) {
          map.flyToBounds(bounds, { padding: [55, 55], maxZoom: 16.5, duration: 0.75 });
        } else if (activeResult.pin) {
          const targetZoom =
            activeResult.signals.houseNumber || activeResult.pin.fonte.includes('Geocodificação')
              ? Math.max(map.getZoom(), 18)
              : Math.max(map.getZoom(), 16.5);
          map.flyTo([activeResult.pin.lat, activeResult.pin.lon], targetZoom, {
            duration: 0.65,
          });
        }
      }
    }
  }, [activeResult]);

  // Open real Street View when triggered from TriagePanel
  useEffect(() => {
    if (streetViewTriggerTick === 0) return;
    const targetLat = activeResult?.pin?.lat ?? svTarget.lat;
    const targetLon = activeResult?.pin?.lon ?? svTarget.lon;
    const streetHint =
      activeResult?.bestMatch?.street.n ||
      activeResult?.reverseAddress?.road ||
      svTarget.street;
    openStreetViewAt(targetLat, targetLon, undefined, streetHint);
  }, [streetViewTriggerTick]);

  const svLat = panoInfo?.panoLat ?? svTarget.lat;
  const svLon = panoInfo?.panoLon ?? svTarget.lon;

  // Google's official embedded interactive 360° Street View panorama URL (no API key needed, walkable arrows included)
  const svIframeUrl = panoInfo?.found && panoInfo.panoId
    ? `https://www.google.com/maps?layer=c&panoid=${encodeURIComponent(panoInfo.panoId)}&cbll=${svLat},${svLon}&cbp=12,${heading},,0,0&output=svembed&hl=pt-BR`
    : `https://www.google.com/maps?layer=c&cbll=${svTarget.lat},${svTarget.lon}&cbp=12,${heading},,0,0&output=svembed&hl=pt-BR`;

  const externalMapsSvUrl = panoInfo?.found && panoInfo.panoId
    ? `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(panoInfo.panoId)}&viewpoint=${svLat},${svLon}&heading=${heading}&pitch=0`
    : `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${svTarget.lat},${svTarget.lon}&heading=${heading}&pitch=0`;

  return (
    <div className="relative w-full h-full flex flex-col bg-slate-200 select-none overflow-hidden">
      {/* REAL FIRST-PERSON WALKABLE GOOGLE STREET VIEW 360° */}
      {svOpen && (
        <div
          className={`relative w-full bg-slate-950 flex flex-col transition-all ${
            svLayout === 'immersive'
              ? 'h-full z-30'
              : 'h-[58%] min-h-[300px] border-b-2 border-slate-800 z-20'
          }`}
        >
          {/* Compact Top Street View Control Strip */}
          <div className="bg-slate-950 text-white px-3 py-2 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 shrink-0">
            <div className="flex items-center gap-2 text-xs min-w-0">
              <span className="w-5 h-5 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center font-black text-[11px] shrink-0">
                P
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-extrabold truncate">Google Street View 360°</span>
                  <span
                    className="px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0"
                    style={{
                      backgroundColor: REGION_COLORS[svClassification.regiao] || '#FFD600',
                      color: getRegionTextColor(svClassification.regiao),
                    }}
                  >
                    {svClassification.regiao}
                  </span>
                  {panoInfo?.captureDate && (
                    <span className="hidden lg:inline px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-slate-300">
                      {panoInfo.captureDate}
                    </span>
                  )}
                </div>
                {panoInfo?.address && (
                  <div className="text-[10px] text-slate-400 truncate">
                    {panoInfo.address}
                    {typeof panoInfo.distanceMeters === 'number' && panoInfo.distanceMeters > 8
                      ? ` (${panoInfo.distanceMeters} m do ponto)`
                      : ''}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {/* Toggle Immersive (like Google Maps) vs Split-Screen */}
              <button
                onClick={() => setSvLayout((m) => (m === 'immersive' ? 'split' : 'immersive'))}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold shadow-sm transition"
                title={
                  svLayout === 'immersive'
                    ? 'Dividir tela: Street View em cima + Mapa das Regiões embaixo'
                    : 'Expandir Street View para tela cheia com mini-mapa no canto'
                }
              >
                {svLayout === 'immersive' ? (
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

              {/* Snap Camera Heading toward house */}
              {typeof panoInfo?.heading === 'number' && (
                <button
                  onClick={() => setHeading(panoInfo.heading!)}
                  className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 text-[11px] font-bold transition"
                  title="Virar câmera diretamente para o imóvel pesquisado"
                >
                  <RotateCw className="w-3 h-3" />
                  Focar Imóvel
                </button>
              )}

              <a
                href={externalMapsSvUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-semibold transition"
                title="Abrir em nova aba no Google Maps"
              >
                <ExternalLink className="w-3 h-3" />
                Maps ↗
              </a>

              <button
                onClick={() => setSvOpen(false)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-bold transition"
                title="Voltar ao mapa das Regiões"
              >
                <X className="w-3.5 h-3.5" />
                Fechar
              </button>
            </div>
          </div>

          {/* Interactive Walkable 360° Google Street View Viewport */}
          <div className="relative flex-1 w-full bg-slate-900">
            {svLoading && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/75 backdrop-blur-xs text-white gap-2">
                <Loader2 className="w-7 h-7 animate-spin text-amber-400" />
                <span className="text-xs font-semibold">
                  Posicionando câmera na rua mais próxima...
                </span>
              </div>
            )}

            {!svLoading && panoInfo && !panoInfo.found ? (
              <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center text-white gap-3 bg-slate-900">
                <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-400/40 flex items-center justify-center">
                  <MapIcon className="w-6 h-6 text-amber-400" />
                </div>
                <div className="max-w-md space-y-1">
                  <div className="text-sm font-extrabold">
                    Sem cobertura do carro do Google Street View neste ponto rural
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Não foram encontradas imagens 360° de rua num raio de 700 metros em ({svTarget.lat.toFixed(5)}, {svTarget.lon.toFixed(5)}). Clique no mini-mapa ou volte ao mapa em modo Satélite Híbrido para visualizar a via de acesso.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setBasemap('google_hybrid');
                      setSvOpen(false);
                    }}
                    className="px-3.5 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-extrabold"
                  >
                    Ver em Satélite Híbrido
                  </button>
                  <a
                    href={externalMapsSvUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold border border-slate-700"
                  >
                    Conferir no Google Maps ↗
                  </a>
                </div>
              </div>
            ) : (
              <iframe
                key={svIframeUrl}
                src={svIframeUrl}
                title="Google Street View 360° Interativo"
                className="w-full h-full border-0"
                allow="accelerometer; gyroscope; fullscreen"
                allowFullScreen
                loading="eager"
                referrerPolicy="no-referrer-when-downgrade"
              />
            )}

            {/* Floating Bottom-Left Interactive Mini-Map in Immersive Mode (matches Google Street View UI!) */}
            {svLayout === 'immersive' && (
              <div
                className={`absolute bottom-4 left-4 z-[450] rounded-xl overflow-hidden border-2 border-white shadow-2xl bg-white transition-all duration-200 ${
                  miniExpanded ? 'w-[340px] h-[230px]' : 'w-[235px] h-[148px]'
                }`}
              >
                <div ref={miniMapContainerRef} className="w-full h-full" />
                <div className="absolute top-1.5 right-1.5 z-[500] flex items-center gap-1">
                  <button
                    onClick={() => setMiniExpanded((v) => !v)}
                    className="p-1 rounded-md bg-white/95 hover:bg-white text-slate-800 shadow border border-slate-200"
                    title={miniExpanded ? 'Reduzir mini-mapa' : 'Expandir mini-mapa'}
                  >
                    {miniExpanded ? (
                      <Minimize2 className="w-3 h-3" />
                    ) : (
                      <Maximize2 className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <div className="absolute bottom-1 left-1.5 right-1.5 z-[500] pointer-events-none flex justify-between items-center">
                  <span className="bg-slate-950/80 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
                    Clique no mini-mapa p/ mudar de rua
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MAIN / BOTTOM PANE: GOOGLE MAPS OR OPENFREEMAP 3D + 9 REGIONS */}
      <div
        ref={mapAreaRef}
        className={`relative flex-1 w-full ${
          pegmanDragging ? 'cursor-grabbing' : pegmanMode ? 'cursor-crosshair' : ''
        } ${svOpen && svLayout === 'immersive' ? 'hidden' : 'block'}`}
      >
        <div
          ref={containerRef}
          className={`w-full h-full z-0 ${basemap === 'openfreemap' ? 'hidden' : 'block'}`}
        />

        {basemap === 'openfreemap' && (
          <div className="w-full h-full block">
            <OpenFreeMapView
              geoLayers={geoLayers}
              rodoviasKm={rodoviasKm}
              activeResult={activeResult}
              focusRegion={focusRegion}
              isActive={basemap === 'openfreemap'}
              pegmanMode={pegmanMode}
              svOpen={svOpen}
              svTarget={svTarget}
              svHeading={heading}
              onCoordinatePicked={onCoordinatePicked}
              onOpenStreetViewAt={(lat, lon, streetName) =>
                openStreetViewAt(lat, lon, undefined, streetName)
              }
              onSelectRegionFocus={onSelectRegionFocus}
              onCancelPegman={() => setPegmanMode(false)}
              onRegisterScreenProjector={(fn) => {
                ofmProjectorRef.current = fn;
              }}
            />
          </div>
        )}

        {/* Pegman Mode Active Banner */}
        {pegmanMode && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[520] bg-amber-400 text-slate-950 px-4 py-2 rounded-full shadow-xl border-2 border-slate-900 text-xs font-extrabold flex items-center gap-2 animate-bounce">
            <span>Clique em qualquer rua no mapa para entrar pessoalmente no Street View 360°!</span>
            <button onClick={() => setPegmanMode(false)} className="p-0.5 rounded-full hover:bg-amber-300">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Top-Right Minimalist Floating Map Pill (Dark Glass) */}
        <div className="absolute top-3 right-3 z-[500] max-w-[calc(100%-24px)] flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-0.5 bg-slate-950/90 backdrop-blur-md p-1 rounded-full shadow-xl border border-slate-800">
            {(
              [
                ['google_roads', 'Mapa'],
                ['google_hybrid', 'Satélite'],
                ['google_terrain', 'Terreno'],
              ] as Array<[Exclude<BasemapId, 'openfreemap'>, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setBasemap(id)}
                className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition-all ${
                  basemap === id
                    ? 'bg-white text-slate-950 shadow-sm'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}

            <button
              onClick={() => {
                setShowPanel(false);
                setBasemap('openfreemap');
              }}
              className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition-all inline-flex items-center gap-1 ${
                basemap === 'openfreemap'
                  ? 'bg-sky-500 text-slate-950 shadow-sm'
                  : 'text-sky-300 hover:bg-slate-800'
              }`}
              title="Cidade Real 3D"
            >
              <Box className="w-3.5 h-3.5" />
              3D
            </button>

            <div className="w-px h-4 bg-slate-800 mx-1" />

            {/* Compact Pegman / Walkable 360° Street View Toggle */}
            <button
              onClick={() => {
                if (svOpen) {
                  setSvOpen(false);
                } else {
                  setPegmanMode((p) => !p);
                }
              }}
              className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition-all inline-flex items-center gap-1.5 ${
                svOpen || pegmanMode
                  ? 'bg-amber-400 text-slate-950 shadow-sm'
                  : 'bg-amber-400/15 hover:bg-amber-400/25 text-amber-300 border border-amber-400/30'
              }`}
              title="Entrar no Street View 360°"
            >
              <span className="w-4 h-4 rounded-full overflow-hidden bg-slate-900 border border-amber-400/70 shrink-0 relative">
                <img
                  src="/mascot/full.png"
                  alt=""
                  draggable={false}
                  className="w-full h-full object-cover object-top scale-[2.6] origin-top"
                />
              </span>
              <span>{pegmanMode ? 'Clique na Rua' : 'Street View'}</span>
            </button>

            {basemap !== 'openfreemap' && (
              <>
                <button
                  onClick={() => setShowPanel((s) => !s)}
                  className={`p-1.5 rounded-full transition-all ${
                    showPanel ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                  title="Camadas do mapa"
                >
                  <Layers className="w-3.5 h-3.5" />
                </button>

                <button
                  onClick={() => mapRef.current?.flyTo([-25.58, -49.14], 12, { duration: 0.6 })}
                  className="p-1.5 rounded-full text-slate-300 hover:bg-slate-800 hover:text-white transition-all"
                  title="Centralizar Comarca"
                >
                  <LocateFixed className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>

          {basemap !== 'openfreemap' && showPanel && (
            <div className="w-64 bg-slate-950/95 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-800 p-3 text-xs space-y-1.5 text-slate-200">
              <div className="font-bold text-slate-100 pb-1 border-b border-slate-800 flex items-center justify-between">
                <span>Camadas</span>
                <button onClick={() => setShowPanel(false)} className="text-slate-400 hover:text-white">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {(
                [
                  ['polygons', 'Regiões Oficiais SJP (1–6)'],
                  ['tijucas', 'Região 7 (Tijucas + Castelhanos)'],
                  ['divisa', 'Divisa Municipal SJP'],
                  ['criticos', 'Pontos R9, Fórum & Pegadinhas'],
                  ['highways', 'Marcos KM (BR-277/376/116)'],
                  ['bairros', 'Bairros & Colônias'],
                ] as Array<[keyof typeof visibleLayers, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setVisibleLayers((v) => ({ ...v, [key]: !v[key] }))}
                  className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-slate-900 transition text-left"
                >
                  <span className={visibleLayers[key] ? 'text-slate-100 font-medium' : 'text-slate-500'}>
                    {label}
                  </span>
                  {visibleLayers[key] ? (
                    <Eye className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                  )}
                </button>
              ))}
              <button
                onClick={() => {
                  setShowPanel(false);
                  onOpenKeyModal();
                }}
                className="w-full mt-1 pt-2 border-t border-slate-800 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-amber-300 font-semibold transition"
              >
                <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                API Key Google (opcional)
              </button>
            </div>
          )}
        </div>

        {/* Subtle Bottom-Center Live Coordinate Pill */}
        {basemap !== 'openfreemap' && (
          <div
            ref={hudWrapRef}
            style={{ opacity: 0 }}
            className="hidden sm:flex absolute bottom-3 left-1/2 -translate-x-1/2 z-[450] pointer-events-none items-center gap-1.5 bg-slate-950/85 text-white backdrop-blur-md px-2.5 py-1 rounded-full border border-slate-800/80 text-[10px] font-mono shadow-sm transition-opacity duration-150"
          >
            <span ref={hudRegRef} className="font-sans font-bold text-emerald-300" />
            <span className="opacity-40">·</span>
            <span ref={hudCoordRef} />
          </div>
        )}

        {/* Minimalist Bottom-Left Region Legend */}
        {basemap !== 'openfreemap' && (
          <div className="hidden md:flex absolute bottom-9 left-3 z-[450] bg-slate-950/88 backdrop-blur-md rounded-full shadow-lg border border-slate-800 px-2 py-1 gap-1">
            {['Região 1', 'Região 1A', 'Região 2', 'Região 3', 'Região 4', 'Região 4A', 'Região 5', 'Região 6', 'Região 7', 'Região 9'].map(
              (reg) => (
                <button
                  key={reg}
                  onClick={() => onSelectRegionFocus(reg)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold text-slate-200 hover:bg-slate-800 transition"
                  title={`Centralizar em ${reg}`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: REGION_COLORS[reg],
                      border: isLightRegionColor(reg) ? '1px solid #9A7B00' : 'none',
                    }}
                  />
                  <span>{reg.replace('Região ', 'R')}</span>
                </button>
              )
            )}
          </div>
        )}

        {/* Corner Draggable Realistic Pegman Dock — compact and seated directly above the bottom-right +/- zoom buttons */}
        {!(svOpen && svLayout === 'immersive') && (
          <div
            onPointerDown={handlePegmanPointerDown}
            onMouseEnter={() => setDockHovered(true)}
            onMouseLeave={() => setDockHovered(false)}
            role="button"
            tabIndex={0}
            aria-label="Arraste para entrar no Google Street View 360°"
            title="Arraste para qualquer rua no mapa para abrir o Street View 360°"
            style={{
              touchAction: 'none',
              bottom: `${dockPos.bottom}px`,
              right: `${dockPos.right}px`,
            }}
            className={`absolute z-[510] flex flex-col items-center justify-end overflow-visible select-none transition-transform duration-150 ${
              pegmanDragging ? 'cursor-grabbing' : 'cursor-grab hover:-translate-y-0.5'
            }`}
          >
            {/* Hover Callout Pill positioned neatly to the left of the small dock so it stays inside the viewport */}
            <div
              className={`pointer-events-none absolute right-full mr-2 bottom-2 px-2.5 py-1 rounded-full bg-slate-950/92 text-amber-300 border border-amber-400/40 text-[10px] font-bold whitespace-nowrap shadow-xl transition-all duration-150 ${
                dockHovered && !pegmanDragging
                  ? 'opacity-100 translate-x-0'
                  : 'opacity-0 translate-x-1 pointer-events-none'
              }`}
            >
              Arraste para o Street View
            </div>

            {pegmanDragging ? (
              /* Recessed empty Google Maps Pegman socket while figure is carried */
              <div className="w-[36px] h-[48px] rounded-xl bg-slate-950/82 backdrop-blur-md border-2 border-dashed border-amber-400/60 shadow-inner flex flex-col items-center justify-center gap-0.5">
                <div className="w-2.5 h-2.5 rounded-full bg-amber-400/25 border border-amber-400/50 animate-pulse" />
                <span className="text-[7px] font-bold uppercase tracking-wide text-amber-300/80">
                  Solte
                </span>
              </div>
            ) : (
              /* Standard-sized standing animated realistic figurine directly above the +/- zoom stack */
              <div className="relative w-[36px] flex flex-col items-center overflow-visible pt-1.5 pb-1 rounded-xl bg-slate-950/76 backdrop-blur-md border border-slate-700/80 shadow-xl hover:border-amber-400/75 transition-colors">
                <MascotAvatar
                  heightPx={56}
                  state={dockHovered ? 'hover' : 'idle'}
                />
                <div
                  className={`w-5 h-1 -mt-0.5 rounded-full border transition-all ${
                    dockHovered || pegmanMode
                      ? 'bg-amber-400/95 border-amber-200 shadow-[0_0_12px_rgba(251,191,36,0.75)]'
                      : 'bg-amber-400/65 border-amber-300/60 shadow-[0_0_8px_rgba(251,191,36,0.4)]'
                  }`}
                />
              </div>
            )}
          </div>
        )}

        {/* Drop Landing Splash Ripple at drop coordinates */}
        {dropSplash && (
          <div
            key={dropSplash.key}
            style={{ left: `${dropSplash.x}px`, top: `${dropSplash.y}px` }}
            className="pointer-events-none absolute z-[560]"
          >
            <div className="pegman-drop-ripple w-12 h-12 rounded-full border-4 border-amber-400 bg-amber-400/25" />
          </div>
        )}
      </div>

      {/* Floating Cursor-Carried Pegman Ghost with Google Maps Pendulum Swing */}
      {pegmanDragging && (
        <div
          ref={pegmanGhostRef}
          style={{ left: 0, top: 0, willChange: 'transform' }}
          className="fixed z-[1500] pointer-events-none select-none overflow-visible"
        >
          {/* Target street landing bullseye centered directly under cursor */}
          <div className="relative -translate-x-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center">
            <div className="pin-pulse-ring absolute inset-0 rounded-full bg-amber-400/45" />
            <div className="w-3.5 h-3.5 rounded-full bg-amber-400/80 border-2 border-slate-950 shadow-lg" />
          </div>

          {/* Live region/drop pill next to landing ring */}
          <div className="absolute left-5 -top-3 px-2.5 py-1 rounded-full bg-slate-950/95 text-amber-300 border border-amber-400/50 text-[10px] font-extrabold whitespace-nowrap shadow-xl">
            <span ref={pegmanHoverLabelRef}>Soltar no Street View</span>
          </div>

          {/* Carried dangling figurine swinging by drag velocity */}
          <div className="absolute left-0 -translate-x-1/2" style={{ bottom: '8px', overflow: 'visible' }}>
            <MascotAvatar
              heightPx={64}
              state="dragging"
              dragTiltRef={pegmanTiltRef}
            />
          </div>
        </div>
      )}
    </div>
  );
}
