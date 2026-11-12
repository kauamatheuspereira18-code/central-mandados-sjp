export type RegionCode =
  | 'Região 1'
  | 'Região 1A'
  | 'Região 2'
  | 'Região 3'
  | 'Região 4'
  | 'Região 4A'
  | 'Região 5'
  | 'Região 6'
  | 'Região 7'
  | 'Região 8'
  | 'Região 9'
  | 'Fora da Comarca'
  | 'Complementação Necessária';

export interface OfficialPolygon {
  regiao: string;
  setor: string | null;
  cor: string;
  coords: [number, number][]; // [lat, lon]
}

export interface RegionInfo {
  codigo: string;
  tipo: string;
  descricao_sistema: string;
  area_km2: number | null;
  observacoes_operacionais: string;
  cor: string;
  qtd_ruas: number;
}

export interface CriticalPoint {
  id: string;
  nome: string;
  categoria: string;
  regiao: string;
  lat: number;
  lon: number;
  endereco: string;
  nota: string;
}

export interface BairroLocalidade {
  nome: string;
  tipo: string;
  regiao: string;
  lat: number;
  lon: number;
}

export interface Pegadinha {
  local: string;
  regiao_correta: string;
  motivo: string;
}

export interface GeoLayers {
  oficiais_sjp: OfficialPolygon[];
  divisa_sjp: [number, number][];
  tijucas_sul: [number, number][];
  castelhanos_zona: {
    regiao: string;
    nome: string;
    cor: string;
    center: [number, number];
    coords: [number, number][];
  };
  regioes_info: RegionInfo[];
  pegadinhas: Pegadinha[];
  pontos_criticos: CriticalPoint[];
  bairros_localidades: BairroLocalidade[];
}

export interface StreetEntry {
  n: string;       // nome
  m: 'SJP' | 'TIJ';
  rp: string;      // regiao_principal
  r: string[];     // regioes
  mr: boolean;     // multi_regiao
  sr6: string[];   // setores_r6
  h: string;       // hierarquia
  len: number;     // comprimento_total_m
  er: Record<string, number>; // extensao_por_regiao_m
  lat: number;
  lon: number;
  al: string | null; // alerta_mandados
  gid?: string;    // chave única quando há múltiplas vias homônimas em bairros distintos
  b?: string;      // bairro principal
  lot?: string;    // loteamento / planta
  cep?: string;    // CEP oficial predominante
  subBairros?: Record<string, { r: string; lat: number; lon: number }>; // sub-trechos por bairro oficial (vias multirregião/rodovias)
}

export interface StreetAliasEntry {
  a: string;   // nome antigo / popular / alternativo / PDF
  t: string;   // nome oficial atual na base
  m: 'SJP' | 'TIJ';
  b?: string;
  lot?: string;
  k: 'old' | 'alt' | 'law' | 'pdf' | 'typo' | 'gmap';
  note?: string;
}

export interface LoteamentoEntry {
  n: string;
  r: string;
  rs: string[];
  b?: string;
  lat: number;
  lon: number;
}

export interface StreetAliasesDB {
  aliases: StreetAliasEntry[];
  loteamentos: LoteamentoEntry[];
}

export interface StreetSegment {
  r: string;
  p: [number, number][];
}

export type StreetsGeomMap = Record<string, StreetSegment[]>;

export interface HighwayKmEntry {
  km: number;
  lat: number;
  lon: number;
  regioes: string[];
  fonte: string;
}

export type RodoviasKmDB = Record<'BR-277' | 'BR-376' | 'BR-116', Record<string, HighwayKmEntry>>;

export interface CoordClassification {
  lat: number;
  lon: number;
  regiao: string;
  subtitulo: string;
  dentroComarca: boolean;
  municipioProvavel: 'São José dos Pinhais' | 'Tijucas do Sul' | 'Fora da Comarca';
  camadaBase: string;
  sliverAjustado: boolean;
  distanciaBordaM?: number;
  alertas: string[];
}

export interface CertidaoSugerida {
  tipo: 'fora_comarca' | 'complementacao';
  titulo: string;
  texto: string;
}

export interface StreetMatchCandidate {
  street: StreetEntry;
  score: number;
  geoms?: StreetSegment[];
}

export interface ParsedMandadoSignals {
  rawText: string;
  extractedAddressLine: string;
  cep: string | null;
  coords: { lat: number; lon: number; format: string } | null;
  highwayKm: { rodovia: 'BR-277' | 'BR-376' | 'BR-116'; km: number } | null;
  houseNumber: string | null;
  hasComplement: boolean;
  externalCity: string | null;
  internalCityHint?: 'SJP' | 'TIJ' | null;
  malformedCep?: string | null;
  r9Trigger: string | null;
  r8Trigger: string | null;
  r7Trigger: string | null;
  hearingDateAlert: {
    dateStr: string;
    daysUntil: number;
    status: 'ok' | 'curto' | 'longo' | 'passado';
    message: string;
  } | null;
  bairrosDetectados: { nome: string; regiao: string }[];
  loteamentosDetectados?: { nome: string; regiao: string; bairro?: string }[];
}

export interface ReverseAddressInfo {
  road: string;
  houseNumber: string;
  suburb: string;
  city: string;
  state: string;
  uf: string;
  postcode: string;
  displayName?: string;
}

export interface AnalysisResult {
  status: 'ok' | 'divisa' | 'fora_comarca' | 'complementacao';
  regiaoFinal: string;
  regioesPossiveis: string[];
  cor: string;
  certezaLabel: string;
  titulo: string;
  subtitulo: string;
  explicacao: string[];
  alertas: string[];
  lookalikes: StreetMatchCandidate[];
  bestMatch: StreetMatchCandidate | null;
  signals: ParsedMandadoSignals;
  cepInfo?: {
    cep: string;
    logradouro: string;
    bairro: string;
    localidade: string;
    uf: string;
    ibge?: string;
    isButiazinhoTrap?: boolean;
  } | null;
  pin?: {
    lat: number;
    lon: number;
    label: string;
    fonte: string;
    regiao: string;
  } | null;
  highlightPolylines?: StreetSegment[];
  highlightPolygonName?: string | null;
  certidao?: CertidaoSugerida | null;
  reverseAddress?: ReverseAddressInfo | null;
  verificacao?: {
    fontes: string[];
    concordantes: number;
    detalhe: string;
  } | null;
}

export type SearchHistoryKind =
  | 'rua'
  | 'cep'
  | 'rodovia'
  | 'coordenada'
  | 'mandado'
  | 'bairro';

export interface SearchHistoryEntry {
  id: string;
  query: string;
  kind: SearchHistoryKind;
  title: string;
  subtitle: string;
  regiao: string;
  cor: string;
  status: AnalysisResult['status'];
  lat?: number;
  lon?: number;
  timestamp: number;
  count: number;
}

