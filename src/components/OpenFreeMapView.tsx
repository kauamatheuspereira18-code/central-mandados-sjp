'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  Box,
  Building2,
  Camera,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  LocateFixed,
  Mountain,
  RotateCw,
  Ruler,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { City3DCustomLayer } from '@/lib/city3d/City3DLayer';
import {
  type MascotFacing,
  getPointingAnchorPx,
  mountAnimatedMascotElement,
  resolvePointingFacing,
} from '@/components/MascotAvatar';
import { haversineMeters, quickRegionAt } from '@/lib/geoMath';
import { REGION_COLORS, getRegionTextColor, isLightRegionColor } from '@/lib/mandadosEngine';
import type { AnalysisResult, GeoLayers, RodoviasKmDB } from '@/types/mandados';

export type OfmStyleId = 'city-3d' | 'dark-3d';

interface OpenFreeMapViewProps {
  geoLayers: GeoLayers;
  rodoviasKm: RodoviasKmDB;
  activeResult: AnalysisResult | null;
  focusRegion: string | null;
  isActive?: boolean;
  pegmanMode: boolean;
  svOpen: boolean;
  svTarget: { lat: number; lon: number };
  svHeading: number;
  onCoordinatePicked: (lat: number, lon: number) => void;
  onOpenStreetViewAt: (lat: number, lon: number, streetName?: string) => void;
  onSelectRegionFocus: (reg: string) => void;
  onCancelPegman: () => void;
  onRegisterScreenProjector?: (
    projector: ((clientX: number, clientY: number) => { lat: number; lon: number } | null) | null
  ) => void;
}

const CITY_3D_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  name: 'Cidade Realista 3D (SJP)',
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    'google-satellite': {
      type: 'raster',
      tiles: [
        'https://mt0.google.com/vt/lyrs=s&hl=pt-BR&scale=2&x={x}&y={y}&z={z}',
        'https://mt1.google.com/vt/lyrs=s&hl=pt-BR&scale=2&x={x}&y={y}&z={z}',
        'https://mt2.google.com/vt/lyrs=s&hl=pt-BR&scale=2&x={x}&y={y}&z={z}',
        'https://mt3.google.com/vt/lyrs=s&hl=pt-BR&scale=2&x={x}&y={y}&z={z}',
      ],
      tileSize: 256,
      maxzoom: 20,
      attribution: '© Google Satélite',
    },
    'google-labels': {
      type: 'raster',
      tiles: [
        'https://mt0.google.com/vt/lyrs=h&hl=pt-BR&scale=2&x={x}&y={y}&z={z}',
        'https://mt1.google.com/vt/lyrs=h&hl=pt-BR&scale=2&x={x}&y={y}&z={z}',
        'https://mt2.google.com/vt/lyrs=h&hl=pt-BR&scale=2&x={x}&y={y}&z={z}',
        'https://mt3.google.com/vt/lyrs=h&hl=pt-BR&scale=2&x={x}&y={y}&z={z}',
      ],
      tileSize: 256,
      maxzoom: 20,
    },
  },
  layers: [
    {
      id: 'city-bg',
      type: 'background',
      paint: { 'background-color': '#0b1120' },
    },
    {
      id: 'google-satellite-layer',
      type: 'raster',
      source: 'google-satellite',
      paint: {
        'raster-fade-duration': 0,
        'raster-contrast': 0.04,
        'raster-saturation': 0.06,
      },
    },
    {
      id: 'google-labels-layer',
      type: 'raster',
      source: 'google-labels',
      paint: { 'raster-fade-duration': 0 },
    },
  ],
};

const OFM_STYLES: Record<OfmStyleId, { label: string; url: string | null }> = {
  'city-3d': { label: 'Realista 3D', url: null },
  'dark-3d': { label: 'Noturno 3D', url: 'https://tiles.openfreemap.org/styles/dark' },
};

let workerConfigured = false;
function ensureMapLibreWorker() {
  if (workerConfigured || typeof window === 'undefined') return;
  workerConfigured = true;
  maplibregl.setWorkerUrl(`${window.location.origin}/workers/maplibre-gl-worker.js`);
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  maplibregl.setWorkerCount(Math.min(4, Math.max(2, Math.floor(cores / 2))));
}

function ringToLngLat(coords: [number, number][]): [number, number][] {
  const pts = coords.map(([lat, lon]): [number, number] => [lon, lat]);
  if (pts.length > 0) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      pts.push([first[0], first[1]]);
    }
  }
  return pts;
}

function createCirclePolygon(lat: number, lon: number, radiusMeters: number, steps = 36): [number, number][] {
  const coords: [number, number][] = [];
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return coords;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildPopupHtml(res: AnalysisResult): string {
  const pin = res.pin!;
  const col = res.cor || REGION_COLORS[pin.regiao] || '#FFD600';
  const badgeTxt = getRegionTextColor(col);
  const rv = res.reverseAddress;
  const streetHint = res.bestMatch?.street.n || rv?.road || '';
  const encodedStreetJs = escapeHtml(JSON.stringify(streetHint));

  if (rv) {
    const streetStr = rv.road
      ? `${rv.road}${rv.houseNumber ? `, nº ${rv.houseNumber}` : ''}`
      : pin.label;
    const estadoStr = [rv.city, rv.state || rv.uf].filter(Boolean).join(' – ');
    return `
      <div style="min-width:230px;font-family:Inter,sans-serif">
        <div style="display:inline-block;background:${col};color:${badgeTxt};font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;margin-bottom:6px">${escapeHtml(pin.regiao)}</div>
        <div style="font-size:12px;color:#0F172A;line-height:1.45;margin-bottom:8px">
          <div><strong style="color:#64748B;font-size:10px;text-transform:uppercase">Rua:</strong> <strong>${escapeHtml(streetStr)}</strong></div>
          <div><strong style="color:#64748B;font-size:10px;text-transform:uppercase">Bairro:</strong> ${escapeHtml(rv.suburb || 'Não informado')}</div>
          <div><strong style="color:#64748B;font-size:10px;text-transform:uppercase">Estado:</strong> ${escapeHtml(estadoStr || 'Paraná')}</div>
          <div><strong style="color:#64748B;font-size:10px;text-transform:uppercase">CEP:</strong> <span style="font-family:monospace;font-weight:700">${escapeHtml(rv.postcode || 'Não informado')}</span></div>
        </div>
        <button onclick="window.dispatchEvent(new CustomEvent('sjp-open-sv',{detail:{lat:${pin.lat},lon:${pin.lon},street:${encodedStreetJs}}}))" style="display:inline-flex;align-items:center;gap:5px;background:#FACC15;color:#0F172A;border:1px solid #CA8A04;font-size:11px;font-weight:800;padding:5px 10px;border-radius:8px;cursor:pointer">Street View 360°</button>
      </div>
    `;
  }

  return `
    <div style="min-width:215px;font-family:Inter,sans-serif">
      <div style="display:inline-block;background:${col};color:${badgeTxt};font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;margin-bottom:5px">${escapeHtml(pin.regiao)}</div>
      <div style="font-weight:700;font-size:12px;color:#0F172A;margin-bottom:2px">${escapeHtml(pin.label)}</div>
      <div style="font-size:11px;color:#475569;margin-bottom:8px">${escapeHtml(pin.fonte)}</div>
      <button onclick="window.dispatchEvent(new CustomEvent('sjp-open-sv',{detail:{lat:${pin.lat},lon:${pin.lon},street:${encodedStreetJs}}}))" style="display:inline-flex;align-items:center;gap:5px;background:#FACC15;color:#0F172A;border:1px solid #CA8A04;font-size:11px;font-weight:800;padding:5px 10px;border-radius:8px;cursor:pointer">Street View 360°</button>
    </div>
  `;
}

export default function OpenFreeMapView({
  geoLayers,
  rodoviasKm,
  activeResult,
  focusRegion,
  isActive = true,
  pegmanMode,
  svOpen,
  svTarget,
  svHeading,
  onCoordinatePicked,
  onOpenStreetViewAt,
  onSelectRegionFocus,
  onCancelPegman,
  onRegisterScreenProjector,
}: OpenFreeMapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const city3DLayerRef = useRef<City3DCustomLayer | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pegmanMarkerRef = useRef<maplibregl.Marker | null>(null);
  const pegmanCleanupRef = useRef<(() => void) | null>(null);
  const resultMarkerRef = useRef<maplibregl.Marker | null>(null);
  const resultMascotCleanupRef = useRef<(() => void) | null>(null);
  const orbitRafRef = useRef<number | null>(null);
  const styleReadyRef = useRef(false);

  const hudWrapRef = useRef<HTMLDivElement | null>(null);
  const hudRegRef = useRef<HTMLSpanElement | null>(null);
  const hudCoordRef = useRef<HTMLSpanElement | null>(null);
  const bearingLabelRef = useRef<HTMLSpanElement | null>(null);
  const isInteractingRef = useRef(false);

  const [mapReady, setMapReady] = useState(false);
  const [city3dLoading, setCity3dLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [styleId, setStyleId] = useState<OfmStyleId>('city-3d');
  const [pitch, setPitch] = useState(50);
  const [bearing, setBearing] = useState(-12);
  const [orbiting, setOrbiting] = useState(false);
  const [showOptions, setShowOptions] = useState(false);

  const [measureMode, setMeasureMode] = useState(false);
  const [measurePts, setMeasurePts] = useState<Array<[number, number]>>([]);

  const [ofmLayers, setOfmLayers] = useState({
    buildings3d: true,
    terrain3d: false,
    labels: true,
    polygons: true,
    tijucas: true,
    divisa: true,
    criticos: false,
    highways: false,
    bairros: false,
  });

  const geoLayersRef = useRef(geoLayers);
  geoLayersRef.current = geoLayers;
  const ofmLayersRef = useRef(ofmLayers);
  ofmLayersRef.current = ofmLayers;
  const pitchRef = useRef(pitch);
  pitchRef.current = pitch;
  const pegmanModeRef = useRef(pegmanMode);
  pegmanModeRef.current = pegmanMode;
  const measureModeRef = useRef(measureMode);
  measureModeRef.current = measureMode;
  const onCoordinatePickedRef = useRef(onCoordinatePicked);
  onCoordinatePickedRef.current = onCoordinatePicked;
  const onOpenStreetViewAtRef = useRef(onOpenStreetViewAt);
  onOpenStreetViewAtRef.current = onOpenStreetViewAt;
  const onCancelPegmanRef = useRef(onCancelPegman);
  onCancelPegmanRef.current = onCancelPegman;
  const styleIdRef = useRef(styleId);
  styleIdRef.current = styleId;
  const activeResultRef = useRef(activeResult);
  activeResultRef.current = activeResult;
  const onRegisterScreenProjectorRef = useRef(onRegisterScreenProjector);
  onRegisterScreenProjectorRef.current = onRegisterScreenProjector;
  const lastFlyPinKeyRef = useRef<string>('');
  const lastMarkerPinKeyRef = useRef<string>('');
  const lastMarkerColorRef = useRef<string>('');

  const geoJsonData = useMemo(() => {
    const polygonsFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: geoLayers.oficiais_sjp.map((poly) => ({
        type: 'Feature' as const,
        properties: {
          regiao: poly.regiao,
          cor: REGION_COLORS[poly.regiao] || poly.cor,
          setor: poly.setor || '',
        },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [ringToLngLat(poly.coords)],
        },
      })),
    };

    const tijucasFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { regiao: 'Região 7', cor: REGION_COLORS['Região 7'] },
          geometry: { type: 'Polygon', coordinates: [ringToLngLat(geoLayers.tijucas_sul)] },
        },
        {
          type: 'Feature',
          properties: { regiao: 'Região 7', cor: REGION_COLORS['Região 7'] },
          geometry: {
            type: 'Polygon',
            coordinates: [createCirclePolygon(-25.7997, -48.90974, 2300)],
          },
        },
      ],
    };

    const divisaFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: ringToLngLat(geoLayers.divisa_sjp) },
        },
      ],
    };

    const criticosFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: geoLayers.pontos_criticos.map((pt) => ({
        type: 'Feature',
        properties: {
          id: pt.id,
          nome: pt.nome,
          regiao: pt.regiao,
          categoria: pt.categoria,
          endereco: pt.endereco,
          nota: pt.nota,
          cor: pt.regiao === 'Região 9' ? '#DC2626' : pt.categoria.includes('Pegadinha') ? '#DB2777' : '#0F172A',
          regCor: REGION_COLORS[pt.regiao] || '#0F172A',
          glyph: pt.regiao === 'Região 9' ? 'R9' : pt.id === 'foro' ? '⚖' : pt.categoria.includes('Pegadinha') ? '!' : '★',
        },
        geometry: { type: 'Point', coordinates: [pt.lon, pt.lat] },
      })),
    };

    const highwayFeatures: GeoJSON.Feature[] = [];
    (['BR-277', 'BR-376', 'BR-116'] as const).forEach((rod) => {
      Object.values(rodoviasKm[rod] || {}).forEach((e) => {
        const isBorder = e.regioes.some(
          (r) => r.toLowerCase().includes('divisa') || r.toLowerCase().includes('fora')
        );
        if (!isBorder && e.km % 2 !== 0) return;
        const primaryR = e.regioes[0].match(/Região\s*\d+A?/)?.[0] || e.regioes[0];
        const col = e.regioes[0].includes('Fora')
          ? '#E11D48'
          : REGION_COLORS[primaryR] || '#0D9488';
        highwayFeatures.push({
          type: 'Feature',
          properties: {
            rodovia: rod,
            km: e.km,
            regioes: e.regioes.join(' / '),
            fonte: e.fonte,
            cor: col,
            isBorder,
          },
          geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
        });
      });
    });

    const highwaysFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: highwayFeatures,
    };

    const bairrosFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: geoLayers.bairros_localidades.map((b) => ({
        type: 'Feature',
        properties: { nome: b.nome, regiao: b.regiao, cor: REGION_COLORS[b.regiao] || '#475569' },
        geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
      })),
    };

    return { polygonsFc, tijucasFc, divisaFc, criticosFc, highwaysFc, bairrosFc };
  }, [geoLayers, rodoviasKm]);

  const geoJsonDataRef = useRef(geoJsonData);
  geoJsonDataRef.current = geoJsonData;

  const ensureTerrainLayer = useCallback((map: maplibregl.Map, enable: boolean) => {
    try {
      if (enable) {
        if (!map.getSource('terrarium-dem')) {
          map.addSource('terrarium-dem', {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            encoding: 'terrarium',
            tileSize: 256,
            maxzoom: 12,
          });
        }
        map.setTerrain({ source: 'terrarium-dem', exaggeration: 1.35 });
        city3DLayerRef.current?.setTerrainExaggeration(1.35);
      } else {
        if (map.getTerrain()) map.setTerrain(null);
        city3DLayerRef.current?.setTerrainExaggeration(0);
      }
    } catch {
      // ignore
    }
  }, []);

  const applyLayerToggles = useCallback(
    (map: maplibregl.Map, cfg: typeof ofmLayers) => {
      const style = map.getStyle();
      if (!style?.layers) return;

      // Always hide OpenFreeMap's sparse OSM vector extrusions in favor of our photorealistic 3D layer
      if (map.getLayer('building-3d')) {
        map.setLayoutProperty('building-3d', 'visibility', 'none');
      }
      if (map.getLayer('google-labels-layer')) {
        map.setLayoutProperty('google-labels-layer', 'visibility', cfg.labels ? 'visible' : 'none');
      }

      city3DLayerRef.current?.setVisible(cfg.buildings3d);
      ensureTerrainLayer(map, cfg.terrain3d);

      if (styleIdRef.current === 'dark-3d') {
        for (const layer of style.layers) {
          const id = layer.id;
          if (id.startsWith('sjp-') || id.startsWith('city-')) continue;
          const srcLayer = (layer as { 'source-layer'?: string })['source-layer'] || '';
          if (srcLayer === 'poi' || id.startsWith('poi')) {
            map.setLayoutProperty(id, 'visibility', 'none');
          } else if (
            srcLayer === 'transportation_name' ||
            id.includes('label') ||
            id.includes('road_name') ||
            id.includes('place_')
          ) {
            map.setLayoutProperty(id, 'visibility', cfg.labels ? 'visible' : 'none');
          }
        }
      }

      const toggleGroup = (ids: string[], on: boolean) => {
        for (const lid of ids) {
          if (map.getLayer(lid)) {
            map.setLayoutProperty(lid, 'visibility', on ? 'visible' : 'none');
          }
        }
      };

      toggleGroup(['sjp-polygons-fill', 'sjp-polygons-line'], cfg.polygons);
      toggleGroup(['sjp-tijucas-fill', 'sjp-tijucas-line'], cfg.tijucas);
      toggleGroup(['sjp-divisa-line'], cfg.divisa);
      toggleGroup(['sjp-criticos-circle', 'sjp-criticos-text'], cfg.criticos);
      toggleGroup(['sjp-highways-circle', 'sjp-highways-label'], cfg.highways);
      toggleGroup(['sjp-bairros-circle', 'sjp-bairros-label'], cfg.bairros);
    },
    [ensureTerrainLayer]
  );

  const syncStyleOverlays = useCallback(
    (map: maplibregl.Map) => {
      const data = geoJsonDataRef.current;
      const isCity3d = styleIdRef.current === 'city-3d';

      const ensureSource = (
        id: string,
        fc: GeoJSON.FeatureCollection,
        fastSimplify = false
      ) => {
        const existing = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
        if (existing) existing.setData(fc);
        else {
          map.addSource(id, {
            type: 'geojson',
            data: fc,
            tolerance: fastSimplify ? 0.75 : 0.375,
            buffer: fastSimplify ? 64 : 128,
          });
        }
      };

      ensureSource('sjp-polygons', data.polygonsFc, true);
      if (!map.getLayer('sjp-polygons-fill')) {
        map.addLayer({
          id: 'sjp-polygons-fill',
          type: 'fill',
          source: 'sjp-polygons',
          paint: {
            'fill-color': ['get', 'cor'],
            'fill-opacity': isCity3d ? 0.08 : 0.16,
          },
        });
      }
      if (!map.getLayer('sjp-polygons-line')) {
        map.addLayer({
          id: 'sjp-polygons-line',
          type: 'line',
          source: 'sjp-polygons',
          paint: { 'line-color': ['get', 'cor'], 'line-width': 2.4, 'line-opacity': 0.92 },
        });
      }

      ensureSource('sjp-tijucas', data.tijucasFc, true);
      if (!map.getLayer('sjp-tijucas-fill')) {
        map.addLayer({
          id: 'sjp-tijucas-fill',
          type: 'fill',
          source: 'sjp-tijucas',
          paint: { 'fill-color': ['get', 'cor'], 'fill-opacity': 0.08 },
        });
      }
      if (!map.getLayer('sjp-tijucas-line')) {
        map.addLayer({
          id: 'sjp-tijucas-line',
          type: 'line',
          source: 'sjp-tijucas',
          paint: { 'line-color': ['get', 'cor'], 'line-width': 2.4, 'line-dasharray': [3, 2] },
        });
      }

      ensureSource('sjp-divisa', data.divisaFc, true);
      if (!map.getLayer('sjp-divisa-line')) {
        map.addLayer({
          id: 'sjp-divisa-line',
          type: 'line',
          source: 'sjp-divisa',
          paint: {
            'line-color': '#F8FAFC',
            'line-width': 2.2,
            'line-dasharray': [4, 3],
          },
        });
      }

      // Photorealistic Three.js 3D City Layer (Satellite-textured roofs + pitched roofs + architectural facades + 3D trees)
      if (!map.getLayer('city-real-3d-mesh')) {
        const layer3d = new City3DCustomLayer({
          terrainExag: ofmLayersRef.current.terrain3d ? 1.35 : 0,
          visible: ofmLayersRef.current.buildings3d,
          onLoadingChange: (loading) => setCity3dLoading(loading),
        });
        city3DLayerRef.current = layer3d;
        map.addLayer(layer3d);
      }

      ensureSource('sjp-bairros', data.bairrosFc);
      if (!map.getLayer('sjp-bairros-circle')) {
        map.addLayer({
          id: 'sjp-bairros-circle',
          type: 'circle',
          source: 'sjp-bairros',
          paint: {
            'circle-radius': 4.5,
            'circle-color': ['get', 'cor'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#FFFFFF',
          },
        });
      }
      if (!map.getLayer('sjp-bairros-label')) {
        map.addLayer({
          id: 'sjp-bairros-label',
          type: 'symbol',
          source: 'sjp-bairros',
          minzoom: 12,
          layout: {
            'text-field': ['get', 'nome'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 10,
            'text-offset': [0, 1.1],
          },
          paint: { 'text-color': '#F8FAFC', 'text-halo-color': '#0F172A', 'text-halo-width': 1.6 },
        });
      }

      ensureSource('sjp-highways', data.highwaysFc);
      if (!map.getLayer('sjp-highways-circle')) {
        map.addLayer({
          id: 'sjp-highways-circle',
          type: 'circle',
          source: 'sjp-highways',
          paint: {
            'circle-radius': ['case', ['get', 'isBorder'], 6.5, 4.5],
            'circle-color': ['get', 'cor'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#FFFFFF',
          },
        });
      }
      if (!map.getLayer('sjp-highways-label')) {
        map.addLayer({
          id: 'sjp-highways-label',
          type: 'symbol',
          source: 'sjp-highways',
          minzoom: 12,
          layout: {
            'text-field': ['concat', ['get', 'rodovia'], ' km ', ['to-string', ['get', 'km']]],
            'text-font': ['Noto Sans Bold'],
            'text-size': 10,
            'text-offset': [0, -1.2],
          },
          paint: { 'text-color': '#F8FAFC', 'text-halo-color': '#0F172A', 'text-halo-width': 1.6 },
        });
      }

      ensureSource('sjp-criticos', data.criticosFc);
      if (!map.getLayer('sjp-criticos-circle')) {
        map.addLayer({
          id: 'sjp-criticos-circle',
          type: 'circle',
          source: 'sjp-criticos',
          paint: {
            'circle-radius': 10,
            'circle-color': ['get', 'cor'],
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#FFFFFF',
          },
        });
      }
      if (!map.getLayer('sjp-criticos-text')) {
        map.addLayer({
          id: 'sjp-criticos-text',
          type: 'symbol',
          source: 'sjp-criticos',
          layout: {
            'text-field': ['get', 'glyph'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 10,
            'text-allow-overlap': true,
          },
          paint: { 'text-color': '#FFFFFF' },
        });
      }

      ensureSource('sjp-active-lines', { type: 'FeatureCollection', features: [] });
      if (!map.getLayer('sjp-active-halo')) {
        map.addLayer({
          id: 'sjp-active-halo',
          type: 'line',
          source: 'sjp-active-lines',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#0F172A', 'line-width': 9, 'line-opacity': 0.88 },
        });
      }
      if (!map.getLayer('sjp-active-core')) {
        map.addLayer({
          id: 'sjp-active-core',
          type: 'line',
          source: 'sjp-active-lines',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'cor'], 'line-width': 5 },
        });
      }

      ensureSource('sjp-measure', { type: 'FeatureCollection', features: [] });
      if (!map.getLayer('sjp-measure-line')) {
        map.addLayer({
          id: 'sjp-measure-line',
          type: 'line',
          source: 'sjp-measure',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': '#F59E0B', 'line-width': 3.5, 'line-dasharray': [2, 1.5] },
        });
      }
      if (!map.getLayer('sjp-measure-pts')) {
        map.addLayer({
          id: 'sjp-measure-pts',
          type: 'circle',
          source: 'sjp-measure',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 6,
            'circle-color': '#F59E0B',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#0F172A',
          },
        });
      }

      applyLayerToggles(map, ofmLayersRef.current);
    },
    [applyLayerToggles]
  );

  const syncActiveResult = useCallback((map: maplibregl.Map, res: AnalysisResult | null) => {
    const src = map.getSource('sjp-active-lines') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!res) {
      resultMascotCleanupRef.current?.();
      resultMascotCleanupRef.current = null;
      if (resultMarkerRef.current) {
        resultMarkerRef.current.remove();
        resultMarkerRef.current = null;
      }
      lastMarkerPinKeyRef.current = '';
      lastMarkerColorRef.current = '';
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const lineFeatures: GeoJSON.Feature[] = (res.highlightPolylines || []).map((seg) => ({
      type: 'Feature',
      properties: { cor: REGION_COLORS[seg.r] || res.cor || '#2563EB', reg: seg.r },
      geometry: {
        type: 'LineString',
        coordinates: seg.p.map(([lat, lon]) => [lon, lat]),
      },
    }));
    src.setData({ type: 'FeatureCollection', features: lineFeatures });

    const bounds = new maplibregl.LngLatBounds();
    lineFeatures.forEach((f) => {
      if (f.geometry.type === 'LineString') {
        f.geometry.coordinates.forEach((c) => bounds.extend([c[0], c[1]]));
      }
    });

    if (res.pin) {
      const { lat, lon } = res.pin;
      const pinCol = res.cor || REGION_COLORS[res.pin.regiao] || '#2563EB';
      const isPointingMode = Boolean(
        res.signals.houseNumber ||
          res.reverseAddress?.houseNumber ||
          res.pin.fonte.includes('Geocodificação')
      );
      const pinHeight = isPointingMode ? 54 : 56;
      const containerW = map.getContainer().clientWidth || 1;
      const projPt = map.project([lon, lat]);
      const facing: MascotFacing = isPointingMode
        ? resolvePointingFacing({
            pinLat: lat,
            pinLon: lon,
            polylines: res.highlightPolylines,
            bearingDeg: map.getBearing(),
            fallbackViewportFractionX: projPt.x / containerW,
          })
        : 'right';
      const markerVariant = `${pinCol}:${isPointingMode ? `p:${facing}` : 'dance'}`;
      const pinKey = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      bounds.extend([lon, lat]);

      if (
        resultMarkerRef.current &&
        lastMarkerPinKeyRef.current === pinKey &&
        lastMarkerColorRef.current === markerVariant
      ) {
        resultMarkerRef.current.getPopup()?.setHTML(buildPopupHtml(res));
      } else {
        resultMascotCleanupRef.current?.();
        resultMascotCleanupRef.current = null;
        if (resultMarkerRef.current) {
          resultMarkerRef.current.remove();
          resultMarkerRef.current = null;
        }
        const el = document.createElement('div');
        el.className = 'sjp-mascot-pin-host';
        resultMascotCleanupRef.current = mountAnimatedMascotElement(el, {
          heightPx: pinHeight,
          mode: isPointingMode ? 'pointing' : 'dance',
          facing,
          showPulse: false,
          hideGroundDot: true,
        });

        const pt = getPointingAnchorPx(pinHeight, facing);
        const popup = new maplibregl.Popup({
          offset: isPointingMode ? [pt.popupX, pt.popupY] : [0, -(pinHeight + 4)],
        }).setHTML(buildPopupHtml(res));

        resultMarkerRef.current = new maplibregl.Marker(
          isPointingMode
            ? { element: el, anchor: 'top-left', offset: [-pt.anchorX, -pt.anchorY] }
            : { element: el, anchor: 'bottom' }
        )
          .setLngLat([lon, lat])
          .setPopup(popup)
          .addTo(map);
        if (res.signals.coords) {
          resultMarkerRef.current.togglePopup();
        }
        lastMarkerPinKeyRef.current = pinKey;
        lastMarkerColorRef.current = markerVariant;
      }

      if (lastFlyPinKeyRef.current !== pinKey) {
        lastFlyPinKeyRef.current = pinKey;
        if (
          res.highlightPolylines &&
          res.highlightPolylines.length > 0 &&
          !res.pin.fonte.includes('Geocodificação') &&
          !res.signals.houseNumber &&
          !res.reverseAddress
        ) {
          map.fitBounds(bounds, { padding: 70, maxZoom: 16.8, duration: 700 });
        } else {
          const targetZoom =
            res.signals.houseNumber || res.pin.fonte.includes('Geocodificação')
              ? Math.max(map.getZoom(), 18.2)
              : Math.max(map.getZoom(), 16.6);
          map.flyTo({
            center: [lon, lat],
            zoom: targetZoom,
            pitch: pitchRef.current,
            duration: 650,
          });
        }
      }
    } else {
      resultMascotCleanupRef.current?.();
      resultMascotCleanupRef.current = null;
      if (resultMarkerRef.current) {
        resultMarkerRef.current.remove();
        resultMarkerRef.current = null;
      }
      lastMarkerPinKeyRef.current = '';
      lastMarkerColorRef.current = '';
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 70, maxZoom: 16.8, duration: 700 });
      }
    }
  }, []);

  // Initialize MapLibre + Three.js Real 3D Engine
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    ensureMapLibreWorker();

    const initPin = activeResultRef.current?.pin;
    const initCenter: [number, number] = initPin
      ? [initPin.lon, initPin.lat]
      : [-49.19599, -25.54045];
    const initZoom = initPin ? 16.7 : 16.5;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: CITY_3D_STYLE,
        center: initCenter,
        zoom: initZoom,
        pitch: 50,
        bearing: -12,
        maxPitch: 60,
        pixelRatio: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 1.5) : 1,
        fadeDuration: 0,
        maxTileCacheSize: 128,
        cancelPendingTileRequestsWhileZooming: true,
        canvasContextAttributes: {
          antialias: false,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance',
          failIfMajorPerformanceCaveat: false,
        },
        attributionControl: { compact: true },
      });
    } catch (err) {
      setMapError(
        err instanceof Error
          ? `WebGL 3D indisponível neste navegador (${err.message}).`
          : 'WebGL 3D indisponível neste navegador.'
      );
      return;
    }

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true, showZoom: true }),
      'bottom-right'
    );
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      'bottom-right'
    );
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');

    mapRef.current = map;

    map.on('error', (ev) => {
      const msg = (ev as { error?: { message?: string } })?.error?.message || '';
      if (msg.toLowerCase().includes('worker') || msg.toLowerCase().includes('webgl')) {
        setMapError(`Erro ao inicializar motor 3D: ${msg}`);
      }
    });

    map.on('style.load', () => {
      styleReadyRef.current = true;
      setMapError(null);
      setMapReady(true);
      syncStyleOverlays(map);
      syncActiveResult(map, activeResultRef.current);
    });

    map.on('movestart', () => {
      isInteractingRef.current = true;
    });
    map.on('moveend', () => {
      isInteractingRef.current = false;
    });

    map.on('pitchend', () => setPitch(Math.round(map.getPitch())));
    map.on('rotateend', () => {
      setBearing(Math.round(map.getBearing()));
      if (styleReadyRef.current && activeResultRef.current) {
        syncActiveResult(map, activeResultRef.current);
      }
    });

    let lastHudTs = 0;
    map.on('mousemove', (e) => {
      if (isInteractingRef.current) return;
      const now = performance.now();
      if (now - lastHudTs < 120) return;
      lastHudTs = now;

      const lat = e.lngLat.lat;
      const lon = e.lngLat.lng;
      const reg = quickRegionAt(lat, lon, geoLayersRef.current);
      if (hudWrapRef.current) hudWrapRef.current.style.opacity = '1';
      if (hudRegRef.current) hudRegRef.current.textContent = reg;
      if (hudCoordRef.current) {
        hudCoordRef.current.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      }
    });

    map.on('click', (e) => {
      const lat = Number(e.lngLat.lat.toFixed(6));
      const lon = Number(e.lngLat.lng.toFixed(6));

      if (pegmanModeRef.current) {
        onCancelPegmanRef.current();
        onOpenStreetViewAtRef.current(lat, lon);
        onCoordinatePickedRef.current(lat, lon);
        return;
      }

      if (measureModeRef.current) {
        setMeasurePts((prev) => [...prev, [lon, lat]]);
        return;
      }

      if (map.getLayer('sjp-criticos-circle')) {
        const critHits = map.queryRenderedFeatures(e.point, { layers: ['sjp-criticos-circle'] });
        if (critHits.length > 0) {
          const p = critHits[0].properties || {};
          const coords = (critHits[0].geometry as GeoJSON.Point).coordinates as [number, number];
          popupRef.current?.remove();
          popupRef.current = new maplibregl.Popup({ offset: 14 })
            .setLngLat(coords)
            .setHTML(`
              <div style="min-width:225px;font-family:Inter,sans-serif">
                <div style="display:inline-block;background:${p.regCor};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-bottom:4px">${escapeHtml(String(p.regiao))} · ${escapeHtml(String(p.categoria))}</div>
                <div style="font-weight:700;font-size:13px;color:#0F172A">${escapeHtml(String(p.nome))}</div>
                <div style="font-size:11px;color:#475569;margin:2px 0 6px">${escapeHtml(String(p.endereco))}</div>
                <div style="font-size:11px;background:#F8FAFC;border-left:3px solid ${p.regCor};padding:5px 7px;color:#1E293B;margin-bottom:8px">${escapeHtml(String(p.nota))}</div>
                <button onclick="window.dispatchEvent(new CustomEvent('sjp-open-sv',{detail:{lat:${coords[1]},lon:${coords[0]}}}))" style="background:#FACC15;color:#0F172A;border:1px solid #CA8A04;font-size:11px;font-weight:800;padding:5px 10px;border-radius:8px;cursor:pointer">Street View 360°</button>
              </div>
            `)
            .addTo(map);
          return;
        }
      }

      if (map.getLayer('sjp-highways-circle')) {
        const hwHits = map.queryRenderedFeatures(e.point, { layers: ['sjp-highways-circle'] });
        if (hwHits.length > 0) {
          const p = hwHits[0].properties || {};
          const coords = (hwHits[0].geometry as GeoJSON.Point).coordinates as [number, number];
          popupRef.current?.remove();
          popupRef.current = new maplibregl.Popup({ offset: 10 })
            .setLngLat(coords)
            .setHTML(`
              <div style="font-family:Inter,sans-serif">
                <div style="font-weight:800;font-size:12px;color:#0F172A">${escapeHtml(String(p.rodovia))} — km ${p.km}</div>
                <div style="font-weight:700;color:${p.cor};font-size:12px;margin:3px 0">${escapeHtml(String(p.regioes))}</div>
                <div style="font-size:11px;color:#64748B;margin-bottom:6px">${escapeHtml(String(p.fonte))}</div>
                <button onclick="window.dispatchEvent(new CustomEvent('sjp-open-sv',{detail:{lat:${coords[1]},lon:${coords[0]}}}))" style="background:#FACC15;color:#0F172A;border:1px solid #CA8A04;font-size:11px;font-weight:800;padding:4px 9px;border-radius:7px;cursor:pointer">Street View</button>
              </div>
            `)
            .addTo(map);
          return;
        }
      }

      popupRef.current?.remove();
      onCoordinatePickedRef.current(lat, lon);
    });

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => mapRef.current?.resize());
    });
    ro.observe(containerRef.current);

    onRegisterScreenProjectorRef.current?.((clientX: number, clientY: number) => {
      const m = mapRef.current;
      if (!m) return null;
      const rect = m.getContainer().getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }
      const lngLat = m.unproject([clientX - rect.left, clientY - rect.top]);
      return { lat: Number(lngLat.lat.toFixed(6)), lon: Number(lngLat.lng.toFixed(6)) };
    });

    return () => {
      onRegisterScreenProjectorRef.current?.(null);
      ro.disconnect();
      if (orbitRafRef.current) cancelAnimationFrame(orbitRafRef.current);
      resultMascotCleanupRef.current?.();
      resultMascotCleanupRef.current = null;
      pegmanCleanupRef.current?.();
      pegmanCleanupRef.current = null;
      styleReadyRef.current = false;
      city3DLayerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [syncStyleOverlays, syncActiveResult]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncStyleOverlays(map);
  }, [geoJsonData, syncStyleOverlays]);

  const handleSelectStyle = useCallback((id: OfmStyleId) => {
    const map = mapRef.current;
    setStyleId(id);
    styleIdRef.current = id;
    if (!map) return;

    styleReadyRef.current = false;
    city3DLayerRef.current = null;
    if (id === 'city-3d') {
      map.setStyle(CITY_3D_STYLE);
    } else {
      map.setStyle(OFM_STYLES[id].url!);
    }
    map.easeTo({ pitch: Math.max(pitchRef.current, 48), duration: 450 });
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    applyLayerToggles(map, ofmLayers);
  }, [ofmLayers, applyLayerToggles]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncActiveResult(map, activeResult);
  }, [activeResult, syncActiveResult]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusRegion || !isActive) return;

    const bounds = new maplibregl.LngLatBounds();
    if (focusRegion === 'Região 7') {
      geoLayers.tijucas_sul.forEach(([lat, lon]) => bounds.extend([lon, lat]));
      bounds.extend([-48.90974, -25.7997]);
      map.fitBounds(bounds, { padding: 40, duration: 650 });
      return;
    }

    const matching = geoLayers.oficiais_sjp.filter((p) => p.regiao === focusRegion);
    if (matching.length > 0) {
      matching.forEach((p) => p.coords.forEach(([lat, lon]) => bounds.extend([lon, lat])));
      map.fitBounds(bounds, { padding: 40, duration: 650 });
    }
  }, [focusRegion, geoLayers, isActive]);

  useEffect(() => {
    if (!isActive) {
      if (orbiting) setOrbiting(false);
      return;
    }
    const t = setTimeout(() => {
      const map = mapRef.current;
      if (!map) return;
      map.resize();
      if (styleReadyRef.current) {
        syncActiveResult(map, activeResultRef.current);
      }
    }, 80);
    return () => clearTimeout(t);
  }, [isActive, svOpen, orbiting, syncActiveResult]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!svOpen) {
      pegmanCleanupRef.current?.();
      pegmanCleanupRef.current = null;
      if (pegmanMarkerRef.current) {
        pegmanMarkerRef.current.remove();
        pegmanMarkerRef.current = null;
      }
      return;
    }

    if (!pegmanMarkerRef.current) {
      const el = document.createElement('div');
      el.style.cursor = 'grab';
      pegmanCleanupRef.current = mountAnimatedMascotElement(el, {
        heightPx: 44,
        auraColor: '#F59E0B',
        headingConeDeg: svHeading,
        phaseOffsetMs: 4000,
      });
      const m = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' })
        .setLngLat([svTarget.lon, svTarget.lat])
        .addTo(map);
      m.on('dragend', () => {
        const ll = m.getLngLat();
        const lat = Number(ll.lat.toFixed(6));
        const lon = Number(ll.lng.toFixed(6));
        onOpenStreetViewAtRef.current(lat, lon);
        onCoordinatePickedRef.current(lat, lon);
      });
      pegmanMarkerRef.current = m;
    } else {
      pegmanMarkerRef.current.setLngLat([svTarget.lon, svTarget.lat]);
      const cone = pegmanMarkerRef.current
        .getElement()
        .querySelector('[data-sv-cone]') as HTMLElement | null;
      if (cone) {
        cone.style.transform = `rotate(${svHeading}deg)`;
      }
    }
  }, [svOpen, svTarget, svHeading]);

  const totalMeasuredMeters = useMemo(() => {
    let total = 0;
    for (let i = 1; i < measurePts.length; i++) {
      total += haversineMeters(
        measurePts[i - 1][1],
        measurePts[i - 1][0],
        measurePts[i][1],
        measurePts[i][0]
      );
    }
    return total;
  }, [measurePts]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    const src = map.getSource('sjp-measure') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const features: GeoJSON.Feature[] = measurePts.map((pt) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: pt },
    }));
    if (measurePts.length >= 2) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: measurePts },
      });
    }
    src.setData({ type: 'FeatureCollection', features });
  }, [measurePts]);

  useEffect(() => {
    const map = mapRef.current;
    if (!orbiting || !map || !isActive) {
      if (orbitRafRef.current) cancelAnimationFrame(orbitRafRef.current);
      orbitRafRef.current = null;
      return;
    }

    if (map.getPitch() < 35) {
      map.easeTo({ pitch: 50, duration: 450 });
      setPitch(50);
    }

    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const nextB = (map.getBearing() + dt * 12) % 360;
      map.setBearing(nextB);
      if (bearingLabelRef.current) {
        bearingLabelRef.current.textContent = `${Math.round(nextB)}°`;
      }
      orbitRafRef.current = requestAnimationFrame(tick);
    };
    orbitRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (orbitRafRef.current) cancelAnimationFrame(orbitRafRef.current);
      if (mapRef.current) {
        setBearing(Math.round(mapRef.current.getBearing()));
      }
    };
  }, [orbiting, isActive]);

  const handleCapturePng = () => {
    const map = mapRef.current;
    if (!map) return;
    map.once('render', () => {
      try {
        const dataUrl = map.getCanvas().toDataURL('image/png');
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `mapa-sjp-3d-${styleId}.png`;
        a.click();
      } catch {
        // ignore
      }
    });
    map.triggerRepaint();
  };

  const earthCenter = activeResult?.pin
    ? { lat: activeResult.pin.lat, lon: activeResult.pin.lon }
    : { lat: -25.54045, lon: -49.19599 };

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-950">
      <div
        ref={containerRef}
        className={`w-full h-full ${pegmanMode || measureMode ? 'cursor-crosshair' : ''}`}
      />

      {!mapReady && !mapError && (
        <div className="absolute inset-0 z-10 pointer-events-none flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-[2px] gap-2">
          <Loader2 className="w-7 h-7 animate-spin text-sky-400" />
          <span className="text-xs font-bold text-slate-200">Carregando Cidade 3D...</span>
        </div>
      )}

      {city3dLoading && mapReady && (
        <div className="absolute top-14 left-3 z-20 pointer-events-none flex items-center gap-1.5 bg-slate-950/88 backdrop-blur-md text-slate-200 px-2.5 py-1 rounded-full border border-slate-800 text-[11px] font-semibold shadow-lg">
          <Loader2 className="w-3 h-3 animate-spin text-sky-400" />
          <span>Renderizando 3D...</span>
        </div>
      )}

      {mapError && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/92 text-white p-6 text-center gap-3">
          <Box className="w-8 h-8 text-amber-400" />
          <div className="text-sm font-extrabold max-w-md">{mapError}</div>
          <p className="text-xs text-slate-400 max-w-md">
            Verifique se a aceleração de hardware (WebGL) está ativa no navegador.
          </p>
        </div>
      )}

      {/* Compact Dark-Glass 3D Dock */}
      <div className="absolute top-14 right-3 z-20 flex flex-col items-end gap-2">
        <div className="flex items-center gap-0.5 bg-slate-950/90 backdrop-blur-md p-1 rounded-full shadow-xl border border-slate-800 text-[11px]">
          <button
            onClick={() => {
              const nextPitch = pitch > 15 ? 0 : 50;
              setPitch(nextPitch);
              mapRef.current?.easeTo({ pitch: nextPitch, duration: 450 });
            }}
            className={`px-2.5 py-1 rounded-full font-bold flex items-center gap-1 transition ${
              pitch > 15 ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'
            }`}
            title="Alternar inclinação 2D / 3D"
          >
            <Box className="w-3 h-3" />
            {pitch > 15 ? '3D' : '2D'}
          </button>

          <button
            onClick={() => setOfmLayers((l) => ({ ...l, buildings3d: !l.buildings3d }))}
            className={`px-2.5 py-1 rounded-full font-bold flex items-center gap-1 transition ${
              ofmLayers.buildings3d ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
            }`}
            title="Casas, prédios e árvores 3D texturizados"
          >
            <Building2 className="w-3 h-3" />
            Prédios
          </button>

          <button
            onClick={() => setOfmLayers((l) => ({ ...l, terrain3d: !l.terrain3d }))}
            className={`px-2.5 py-1 rounded-full font-bold flex items-center gap-1 transition ${
              ofmLayers.terrain3d ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:bg-slate-800'
            }`}
            title="Relevo topográfico 3D real"
          >
            <Mountain className="w-3 h-3" />
            Relevo
          </button>

          <button
            onClick={() => setShowOptions((s) => !s)}
            className={`px-2.5 py-1 rounded-full font-bold flex items-center gap-1 transition ${
              showOptions ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-slate-800'
            }`}
            title="Controles e camadas 3D"
          >
            <SlidersHorizontal className="w-3 h-3" />
            Opções
          </button>

          <button
            onClick={() => {
              setOrbiting(false);
              mapRef.current?.flyTo({
                center: [-49.19599, -25.54045],
                zoom: 16.5,
                pitch: pitch > 15 ? 50 : 0,
                bearing: -12,
                duration: 600,
              });
            }}
            className="p-1.5 rounded-full text-slate-300 hover:bg-slate-800 hover:text-white transition"
            title="Centralizar no Centro / Fórum SJP"
          >
            <LocateFixed className="w-3.5 h-3.5" />
          </button>
        </div>

        {(measureMode || measurePts.length > 0) && (
          <div className="bg-slate-950/92 text-white rounded-full px-3 py-1.5 shadow-lg border border-amber-400/50 text-[11px] flex items-center gap-2.5">
            <Ruler className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="font-bold">
              {totalMeasuredMeters >= 1000
                ? `${(totalMeasuredMeters / 1000).toFixed(2)} km`
                : `${Math.round(totalMeasuredMeters)} m`}
              {totalMeasuredMeters >= 30000 ? ' (≥ 30 km · R5)' : ''}
            </span>
            <button
              onClick={() => {
                setMeasurePts([]);
                setMeasureMode(false);
              }}
              className="p-0.5 rounded-full hover:bg-rose-600 transition"
              title="Fechar régua"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}

        {showOptions && (
          <div className="w-72 bg-slate-950/95 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-800 p-3.5 text-xs text-slate-200 space-y-3 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-extrabold text-white">Controles 3D · SJP</span>
              <button onClick={() => setShowOptions(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(OFM_STYLES) as OfmStyleId[]).map((id) => (
                <button
                  key={id}
                  onClick={() => handleSelectStyle(id)}
                  className={`px-2 py-1.5 rounded-lg text-[11px] font-bold border transition ${
                    styleId === id
                      ? 'bg-sky-500 text-slate-950 border-sky-400'
                      : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
                  }`}
                >
                  {OFM_STYLES[id].label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <button
                onClick={() => setOrbiting((o) => !o)}
                className={`px-2 py-1.5 rounded-lg text-[11px] font-bold border flex items-center justify-center gap-1 transition ${
                  orbiting
                    ? 'bg-emerald-600 border-emerald-500 text-white'
                    : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <RotateCw className={`w-3 h-3 ${orbiting ? 'animate-spin' : ''}`} /> Órbita
              </button>
              <button
                onClick={() => setMeasureMode((m) => !m)}
                className={`px-2 py-1.5 rounded-lg text-[11px] font-bold border flex items-center justify-center gap-1 transition ${
                  measureMode
                    ? 'bg-amber-400 border-amber-500 text-slate-950'
                    : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Ruler className="w-3 h-3" /> Medir
              </button>
              <button
                onClick={handleCapturePng}
                className="px-2 py-1.5 rounded-lg text-[11px] font-bold border bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-1 transition"
              >
                <Camera className="w-3 h-3" /> PNG
              </button>
            </div>

            <a
              href={`https://earth.google.com/web/@${earthCenter.lat},${earthCenter.lon},920a,360d,35y,0h,50t,0r`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-1.5 px-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-sky-300 font-bold text-[11px] border border-slate-800 flex items-center justify-center gap-1.5 transition"
            >
              <ExternalLink className="w-3 h-3" /> Abrir ponto no Google Earth ↗
            </a>

            <div className="space-y-1.5 bg-slate-900/90 p-2.5 rounded-xl border border-slate-800">
              <div className="flex justify-between text-[10px] font-bold text-slate-400">
                <span>Inclinação 3D</span>
                <span className="font-mono text-slate-200">{pitch}°</span>
              </div>
              <input
                type="range"
                min={0}
                max={60}
                value={pitch}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setPitch(val);
                  mapRef.current?.setPitch(val);
                }}
                className="w-full accent-sky-400"
              />
              <div className="flex justify-between text-[10px] font-bold text-slate-400">
                <span>Rotação</span>
                <span ref={bearingLabelRef} className="font-mono text-slate-200">
                  {Math.round(bearing)}°
                </span>
              </div>
              <input
                type="range"
                min={-180}
                max={180}
                value={bearing}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setBearing(val);
                  mapRef.current?.setBearing(val);
                }}
                className="w-full accent-sky-400"
              />
            </div>

            <div className="space-y-1">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Camadas
              </div>
              {(
                [
                  ['polygons', 'Polígonos SJP (1–6)'],
                  ['tijucas', 'Região 7 (Tijucas + Castelhanos)'],
                  ['divisa', 'Divisa Municipal SJP'],
                  ['criticos', 'Pontos R9, Fórum & Pegadinhas'],
                  ['highways', 'Marcos KM (BR-277/376/116)'],
                  ['bairros', 'Bairros & Colônias'],
                  ['labels', 'Nomes de Ruas'],
                ] as Array<[keyof typeof ofmLayers, string]>
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setOfmLayers((prev) => ({ ...prev, [k]: !prev[k] }))}
                  className="w-full flex items-center justify-between px-2 py-1 rounded-lg hover:bg-slate-900 text-left"
                >
                  <span className={ofmLayers[k] ? 'text-slate-100 font-medium' : 'text-slate-500'}>
                    {label}
                  </span>
                  {ofmLayers[k] ? (
                    <Eye className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Subtle Bottom-Center Live Coordinate Pill */}
      <div
        ref={hudWrapRef}
        style={{ opacity: 0 }}
        className="hidden sm:flex absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none items-center gap-1.5 bg-slate-950/88 text-white backdrop-blur-md px-2.5 py-1 rounded-full border border-slate-800 text-[10px] font-mono shadow-sm transition-opacity duration-150"
      >
        <span ref={hudRegRef} className="font-sans font-bold text-sky-300" />
        <span className="opacity-40">·</span>
        <span ref={hudCoordRef} />
      </div>

      {/* Minimalist Bottom-Left Region Legend */}
      <div className="hidden md:flex absolute bottom-9 left-3 z-10 rounded-full shadow-lg border px-2 py-1 gap-1 backdrop-blur-md bg-slate-950/88 border-slate-800 text-slate-200">
        {['Região 1', 'Região 1A', 'Região 2', 'Região 3', 'Região 4', 'Região 4A', 'Região 5', 'Região 6', 'Região 7', 'Região 9'].map(
          (reg) => (
            <button
              key={reg}
              onClick={() => onSelectRegionFocus(reg)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold hover:bg-slate-800 transition"
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
    </div>
  );
}
