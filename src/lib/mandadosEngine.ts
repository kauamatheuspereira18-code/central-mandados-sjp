import { classifyCoordinates, haversineMeters } from '@/lib/geoMath';
import {
  canonicalizeNumberedStreetText,
  expandAbbr,
  norm,
  parseMandadoSignals,
  splitLeadingStreetIdentifier,
} from '@/lib/mandadoParser';
import type {
  AnalysisResult,
  GeoLayers,
  ParsedMandadoSignals,
  RodoviasKmDB,
  StreetAliasEntry,
  StreetAliasesDB,
  StreetEntry,
  StreetMatchCandidate,
  StreetsGeomMap,
} from '@/types/mandados';

export const REGION_COLORS: Record<string, string> = {
  'Região 1': '#FFD600',   // Amarelo Ouro (KML original)
  'Região 1A': '#FFEA00',  // Amarelo Claro (KML original)
  'Região 2': '#01579B',   // Azul (KML original)
  'Região 3': '#558B2F',   // Verde (KML original)
  'Região 4': '#A52714',   // Vermelho Tijolo (KML original)
  'Região 4A': '#A52714',  // Vermelho Tijolo (KML original, opacidade mais suave)
  'Região 5': '#006064',   // Verde-Petróleo / Teal (KML original)
  'Região 6': '#4E342E',   // Marrom (KML original)
  'Região 7': '#DB2777',   // Tijucas do Sul + Castelhanos
  'Região 8': '#4F46E5',   // Citação Online
  'Região 9': '#DC2626',   // Plantão / CCJP / Delegacias / CENSE
  'Fora da Comarca': '#475569',
  'Complementação Necessária': '#B45309',
};

export const REGION_FILL_OPACITY: Record<string, number> = {
  'Região 1': 0.36,
  'Região 1A': 0.25,
  'Região 2': 0.38,
  'Região 3': 0.34,
  'Região 4': 0.38,
  'Região 4A': 0.26,
  'Região 5': 0.24,
  'Região 6': 0.34,
  'Região 7': 0.16,
};

export function isLightRegionColor(regOrHex: string): boolean {
  const hex = (REGION_COLORS[regOrHex] || regOrHex || '').toUpperCase();
  return hex === '#FFD600' || hex === '#FFEA00';
}

export function getRegionTextColor(regOrHex: string): string {
  return isLightRegionColor(regOrHex) ? '#0F172A' : '#FFFFFF';
}

export function getRegionAccentTextColor(regOrHex: string): string {
  const hex = (REGION_COLORS[regOrHex] || regOrHex || '').toUpperCase();
  return hex === '#FFD600' || hex === '#FFEA00' ? '#785600' : REGION_COLORS[regOrHex] || regOrHex;
}

export const CERTIDAO_FORA_COMARCA = {
  tipo: 'fora_comarca' as const,
  titulo: 'Certidão — Devolução sem Distribuição (Fora da Competência Territorial)',
  texto:
    'CERTIDÃO\n\nCertifico e dou fé, em triagem na Central de Mandados do Foro Regional de São José dos Pinhais (Comarca da Região Metropolitana de Curitiba — TJPR), que o endereço indicado no expediente pertence a município externo, fora da competência territorial deste Foro Regional (cuja jurisdição compreende os Municípios de São José dos Pinhais e Tijucas do Sul).\n\nNos termos da Instrução Normativa Conjunta nº 25/2020–P-GP/CGJPR (texto compilado até a INC nº 262/2026, arts. 3º, 7º, parágrafo único, e 11), dos arts. 325 a 327 do Código de Normas do Foro Judicial (CNFJ — Provimento nº 316/2022–CGJ, atualizado até o Provimento nº 359/2026), do art. 15 da Resolução nº 139/2015–OE/TJPR (alterada pela Resolução nº 517/2025–OE) e do Ofício-Circular nº 17/2026–CGJ (classificação "DEV — Mandado Devolvido"), devolvo o expediente sem distribuição à Unidade Expedidora para remessa direta à Central de Mandados do foro competente mediante Mandado Compartilhado (ou expedição de carta precatória, se fora do Estado do Paraná) ou retificação do endereço.',
};

export const CERTIDAO_COMPLEMENTACAO = {
  tipo: 'complementacao' as const,
  titulo: 'Certidão — Devolução sem Distribuição (Endereço Incompleto / Não Localizado)',
  texto:
    'CERTIDÃO\n\nCertifico e dou fé, em triagem na Central de Mandados do Foro Regional de São José dos Pinhais (Comarca da Região Metropolitana de Curitiba — TJPR), que o endereço indicado no mandado apresenta insuficiência de dados essenciais (ausência de número predial, bairro, loteamento, CEP ou ponto de referência em via limítrofe/multirregião) ou não foi localizado nas bases oficiais dos Municípios de São José dos Pinhais e Tijucas do Sul, impossibilitando a individualização do local de cumprimento e a regular distribuição.\n\nNos termos do art. 15 da Resolução nº 139/2015–OE/TJPR (alterada pela Resolução nº 517/2025–OE), dos arts. 289 e 325 do Código de Normas do Foro Judicial (CNFJ — Provimento nº 316/2022–CGJ, atualizado até o Provimento nº 359/2026) e do Ofício-Circular nº 17/2026–CGJ (item 7 — "DEV — Mandado Devolvido", c/c Resolução nº 443/2024–OE), devolvo o expediente sem distribuição à Unidade Expedidora para complementação pela parte interessada ou Secretaria.',
};

export interface EngineDependencies {
  geo: GeoLayers;
  streets: StreetEntry[];
  streetsGeom: StreetsGeomMap | null;
  rodoviasKm: RodoviasKmDB;
  externalRmc?: Record<string, { n: string; c: string }> | null;
  getExternalRmc?: () => Promise<Record<string, { n: string; c: string }> | null>;
  streetAliases?: StreetAliasesDB | null;
}

interface StreetIndex {
  sjp: StreetEntry[];
  tij: StreetEntry[];
  byMunTarget: Map<string, StreetEntry[]>;
  byCoreToken: Map<string, StreetEntry[]>;
  coreOf: WeakMap<StreetEntry, string>;
}

const streetIndexCache = new WeakMap<StreetEntry[], StreetIndex>();

function getStreetIndex(streets: StreetEntry[]): StreetIndex {
  let idx = streetIndexCache.get(streets);
  if (idx) return idx;
  const sjp: StreetEntry[] = [];
  const tij: StreetEntry[] = [];
  const byMunTarget = new Map<string, StreetEntry[]>();
  const byCoreToken = new Map<string, StreetEntry[]>();
  const coreOf = new WeakMap<StreetEntry, string>();

  for (const s of streets) {
    if (s.m === 'TIJ') tij.push(s);
    else sjp.push(s);

    const munK = `${s.m}|${canonicalizeNumberedStreetText(s.n, true)}`;
    let munArr = byMunTarget.get(munK);
    if (!munArr) {
      munArr = [];
      byMunTarget.set(munK, munArr);
    }
    munArr.push(s);

    const core = expandAbbr(s.n)
      .split(' ')
      .filter((t) => !STOPWORDS.has(t))
      .join(' ');
    coreOf.set(s, core);
    if (core && core.length >= 4) {
      let cArr = byCoreToken.get(core);
      if (!cArr) {
        cArr = [];
        byCoreToken.set(core, cArr);
      }
      cArr.push(s);
    }
  }
  idx = { sjp, tij, byMunTarget, byCoreToken, coreOf };
  streetIndexCache.set(streets, idx);
  return idx;
}

const STOPWORDS = new Set([
  'rua',
  'avenida',
  'estrada',
  'travessa',
  'rodovia',
  'alameda',
  'praca',
  'largo',
  'beco',
  'servidao',
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'em',
  'no',
  'na',
  'com',
  'sao',
  'santa',
  'santo',
  'doutor',
  'professor',
  'vereador',
  'prefeito',
]);

const PREFIX_SET = new Set([
  'rua',
  'avenida',
  'travessa',
  'estrada',
  'rodovia',
  'alameda',
  'praca',
  'largo',
  'beco',
  'servidao',
]);

const TITLE_SET = new Set([
  'prefeito',
  'vereador',
  'doutor',
  'professor',
  'senador',
  'deputado',
  'coronel',
  'marechal',
  'tenente',
  'general',
  'capitao',
  'padre',
  'comendador',
  'governador',
  'presidente',
  'engenheiro',
  'desembargador',
  'expedicionario',
  'dom',
  'sao',
  'santa',
  'santo',
]);

const TIJUCAS_BAIRROS_EXCLUSIVOS = new Set([
  'campo alto',
  'campina',
  'lagoinha',
  'vila cubas',
  'bosque da saude',
  'bosque das oliveiras',
  'anne louise',
  'campo dos cruz',
  'morro vermelho',
  'rincao',
  'tabatinga',
  'cangoera',
  'ambrosios',
  'pirai',
  'rio da prata',
  'fazendinha',
  'lagoa',
  'salto do arvoredo',
  'mato grosso',
  'rio abaixo',
  'vossoroca',
  'matulao',
  'postinho',
  'amola faca',
  'serrinha',
]);

export function phoneticBr(s: string): string {
  return norm(s)
    .replace(/ph/g, 'f')
    .replace(/ch/g, 'x')
    .replace(/sh/g, 'x')
    .replace(/lh/g, 'li')
    .replace(/nh/g, 'ni')
    .replace(/qu([ei])/g, 'k$1')
    .replace(/qu/g, 'k')
    .replace(/c([ei])/g, 's$1')
    .replace(/ss/g, 's')
    .replace(/sc([ei])/g, 's$1')
    .replace(/z\b/g, 's')
    .replace(/x/g, 's')
    .replace(/ç/g, 's')
    .replace(/g([ei])/g, 'j$1')
    .replace(/w/g, 'v')
    .replace(/y/g, 'i')
    .replace(/k/g, 'c')
    .replace(/h/g, '')
    .replace(/(.)\1+/g, '$1')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function seqRatio(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function extractHighwayCode(s: string): string | null {
  const m = norm(s).match(/\b(br|pr)\s*0*(\d{2,3})\b/);
  return m ? `${m[1]}-${m[2]}` : null;
}

export function similarityScore(query: string, candidate: string): number {
  const qExp = expandAbbr(query);
  const cExp = expandAbbr(candidate);
  if (!qExp || !cExp) return 0;
  if (qExp === cExp) return 1.0;

  const qHw = extractHighwayCode(query);
  const cHw = extractHighwayCode(candidate);
  if (qHw && cHw) {
    if (qHw === cHw) {
      const qBareHw = /^(?:rodovia\s+)?(?:br|pr)\s*0*\d{2,3}$/i.test(qExp);
      const cBareHw = /^(?:rodovia\s+)?(?:br|pr)\s*0*\d{2,3}$/i.test(cExp);
      if (qBareHw && cBareHw) return 1.0;
      if (qBareHw || cBareHw) return 0.96;
    } else {
      return 0.2;
    }
  }

  const qNum = canonicalizeNumberedStreetText(query, false);
  const cNum = canonicalizeNumberedStreetText(candidate, false);
  const qBare = canonicalizeNumberedStreetText(query, true);
  const cBare = canonicalizeNumberedStreetText(candidate, true);

  const qTokensAll = qBare.split(' ').filter(Boolean);
  const cTokensAll = cBare.split(' ').filter(Boolean);

  const qCore = qTokensAll.filter((t) => !STOPWORDS.has(t));
  const cCore = cTokensAll.filter((t) => !STOPWORDS.has(t));
  const qCoreStr = qCore.join(' ');
  const cCoreStr = cCore.join(' ');

  // Proteção rigorosa para vias numeradas ou de letra única ("Rua 1" != "Rua 2", "Rua A" != "Rua B")
  const isShortIdent = (arr: string[]) =>
    arr.length === 1 && (/^\d{1,3}[a-z]?$/.test(arr[0]) || /^[a-z]$/.test(arr[0]));
  if (isShortIdent(qCore) && isShortIdent(cCore) && qCore[0] !== cCore[0]) {
    return 0.25;
  }

  if (qNum && qNum === cNum) return 0.985;
  if (qBare && qBare === cBare) return 0.97;

  if (qCoreStr && qCoreStr === cCoreStr) {
    let score = 0.94;
    if (
      PREFIX_SET.has(qTokensAll[0] || '') &&
      PREFIX_SET.has(cTokensAll[0] || '') &&
      qTokensAll[0] !== cTokensAll[0]
    ) {
      score -= 0.14;
    }
    const qTitles = new Set(qTokensAll.filter((t) => TITLE_SET.has(t)));
    const cTitles = new Set(cTokensAll.filter((t) => TITLE_SET.has(t)));
    if ((qTitles.size || cTitles.size) && !setsEqual(qTitles, cTitles)) {
      score -= 0.12;
    }
    return Math.max(score, 0.72);
  }

  const rExp = seqRatio(qBare, cBare);
  const rCore = qCoreStr && cCoreStr ? seqRatio(qCoreStr, cCoreStr) : rExp;
  const rPhon = qCoreStr && cCoreStr ? seqRatio(phoneticBr(qCoreStr), phoneticBr(cCoreStr)) : rExp;

  let tokenHit = 0;
  if (qCore.length > 0 && cCore.length > 0) {
    const qSet = new Set(qCore);
    const cSet = new Set(cCore);
    let inter = 0;
    for (const qt of qSet) if (cSet.has(qt)) inter++;
    if (inter > 0) tokenHit = inter / Math.max(qSet.size, cSet.size);
  }

  let base = Math.max(rExp, 0.55 * rCore + 0.45 * rPhon, 0.78 * tokenHit + 0.22 * rPhon);

  // Penalidade para conflito explícito de prenome/sobrenome distinto (ex.: "João Paulo Cordeiro" != "João Ângelo Cordeiro")
  if (qCore.length >= 2 && cCore.length >= 2) {
    const tokensMatchClose = (a: string, b: string) =>
      a === b || seqRatio(a, b) >= 0.62 || (a.length >= 3 && b.length >= 3 && phoneticBr(a) === phoneticBr(b));
    const unmatchedQ = qCore.filter((qt) => qt.length >= 3 && !cCore.some((ct) => tokensMatchClose(qt, ct)));
    const unmatchedC = cCore.filter((ct) => ct.length >= 3 && !qCore.some((qt) => tokensMatchClose(qt, ct)));
    if (unmatchedQ.length >= 1 && unmatchedC.length >= 1) {
      const penalty = 0.16 * Math.min(unmatchedQ.length, unmatchedC.length);
      base = Math.min(base - penalty, 0.78);
    }
  }

  const diffPrefix =
    PREFIX_SET.has(qTokensAll[0] || '') &&
    PREFIX_SET.has(cTokensAll[0] || '') &&
    qTokensAll[0] !== cTokensAll[0];

  // Protege contra falsos positivos em nomes curtos com prefixo distinto (ex.: "Avenida Iraí" != "Rua Irati")
  if (diffPrefix && Math.min(qCoreStr.length, cCoreStr.length) <= 6 && rCore < 0.88) {
    return Math.min(base, 0.65);
  }

  if (diffPrefix) {
    base -= 0.08;
  }
  return Math.min(Math.max(base, 0), 0.99);
}

function coreWithoutConnectors(s: string): string {
  return expandAbbr(s)
    .split(' ')
    .filter((t) => t && !['de', 'da', 'do', 'das', 'dos', 'e'].includes(t))
    .join(' ');
}

export function cleanStreetCandidateFromAddress(addrLine: string): string {
  let s = addrLine;
  s = s.replace(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g, ' ');
  s = s.replace(/\bc\.?\s*e\.?\s*p\.?\s*[:\-]?\s*\d[\d.\-\s]{4,10}\d/gi, ' ');
  s = s.replace(/(?:c\.?\s*e\.?\s*p\.?\s*[:\-]?\s*)?\d{2}\.?\d{3}[-\s.]?\d{3}/gi, ' ');
  s = s.replace(/\bc\.?\s*e\.?\s*p\.?\s*[:\-]?\s*/gi, ' ');
  s = s.replace(
    /\s+\b(?:bairro|cidade|munic[ií]pio|uf|estado|complemento|compl\.?|ref\.?|refer[êe]ncia)\s*[:\-].*$/i,
    ''
  );
  s = s.replace(
    /(?:[-,/]\s*|\s+(?:em|na|no|municipio de|comarca de)\s+)(?:s[aã]o jos[eé] dos pinhais|tijucas do sul|curitiba|pinhais|fazenda rio grande|piraquara|arauc[aá]ria|colombo|mandirituba)\b(?:\s*[-/]\s*(?:pr|sc))?.*$/i,
    ''
  );
  s = s.replace(/\s+(?:s[aã]o jos[eé] dos pinhais|tijucas do sul)\s*$/i, '');
  s = s.replace(/\b(?:pr|parana|paran[aá]|sc|brasil)\b\s*$/i, '');

  // Protege vias numeradas/letradas/datas ("Rua 2", "Rua Nº 5", "Rua Cinco", "Rua A")
  const { streetHead } = splitLeadingStreetIdentifier(s);
  if (streetHead) {
    const restAfterHead = s.slice(s.indexOf(streetHead) + streetHead.length);
    if (!/^\s+(?:de|da|do|dos|das)\s+[a-zà-ÿ]{3,}/i.test(restAfterHead)) {
      return streetHead.replace(/[-,/]+$/, '').trim();
    }
  }

  s = s.replace(/,\s*(?:n[º°.]?\s*\d+.*|\d{1,5}.*|s\s*\/\s*n.*|km.*)$/i, '');
  s = s.replace(/\s+\bn[º°.]?\s*\d{1,5}\b.*$/i, '');
  s = s.replace(/\s+\bs\s*\/\s*n\b.*$/i, '');
  s = s.replace(/\s+\d{1,5}\s*[-,/]?\s*(?:apto?|bl|bloco|casa|loja|sala|lote|quadra).*$/i, '');
  if (!/\b(?:br|pr|sc|sp)\s+\d{2,3}\s*$/i.test(s)) {
    s = s.replace(/\s+\d{1,5}\s*$/i, '');
  }
  // Remove bairro/loteamento após " - " (ex.: "Rua da Olaria - Borda do Campo", preservando "BR-277")
  if (/\s+-\s+/.test(s) && !/\b(?:br|pr|sc)-\d+/i.test(s.split(/\s+-\s+/)[1] || '')) {
    const partsDash = s.split(/\s+-\s+/);
    if (
      partsDash.length >= 2 &&
      /^(?:r\.?|rua|av\.?|avenida|estr\.?|estrada|tv\.?|trav\.?|travessa|rod\.?|rodovia|al\.?|alameda|praca|pra[çc]a|caminho|largo)\s+/i.test(
        partsDash[0].trim()
      )
    ) {
      s = partsDash[0].trim();
    }
  }
  // Se o trecho antes da primeira vírgula já tem tipo de via (Rua, Av., Estrada...), remove bairro/complemento após vírgula
  if (
    s.includes(',') &&
    /^(?:r\.?|rua|av\.?|avenida|estr\.?|estrada|tv\.?|trav\.?|travessa|rod\.?|rodovia|al\.?|alameda|praca|pra[çc]a|caminho|largo)\s+/i.test(
      s.trim()
    )
  ) {
    s = s.split(',')[0].trim();
  } else if (s.includes(',')) {
    // Também limpa vírgulas quando o logradouro foi digitado sem prefixo (ex.: "Contorno Leste, Zacarias" ou "JOAO PAULO DE CORDEIRO, 462 ,colonia roça velha")
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2 && parts[0].length >= 4 && !/^\d/.test(parts[0])) {
      s = parts[0];
    }
  }
  s = s.replace(/[-,/]+$/, '').trim();
  return s;
}

function isOutOfStateLocation(text: string): boolean {
  const s = norm(text);
  if (!s) return false;
  if (
    /(?:\/|-|\s)\s*(?:ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pe|pi|rj|rn|rs|ro|rr|sc|se|sp|to)\b/i.test(
      s
    )
  ) {
    return true;
  }
  return /\b(?:santa catarina|garuva|joinville|itajai|blumenau|florianopolis|balneario camboriu|jaragua do sul|sao bento do sul|itapoa|sao paulo|rio grande do sul|minas gerais)\b/.test(
    s
  );
}

export function buildDynamicCertidao(
  tipo: 'fora_comarca' | 'complementacao',
  queryText: string,
  extraInfo?: string
) {
  if (tipo === 'fora_comarca') {
    const outOfState = isOutOfStateLocation(`${queryText} ${extraInfo || ''}`);
    const detalheLocal = extraInfo ? ` (${extraInfo})` : '';
    if (outOfState) {
      return {
        tipo: 'fora_comarca' as const,
        titulo: CERTIDAO_FORA_COMARCA.titulo,
        texto: `CERTIDÃO\n\nCertifico e dou fé, em triagem na Central de Mandados do Foro Regional de São José dos Pinhais (Comarca da Região Metropolitana de Curitiba — TJPR), que, analisado o endereço constante no expediente ("${queryText.trim()}"${detalheLocal}), verificou-se tratar-se de localidade situada em unidade federativa diversa, fora do Estado do Paraná e da competência territorial deste Foro Regional (cuja jurisdição compreende os Municípios de São José dos Pinhais e Tijucas do Sul).\n\nNos termos do art. 3º, parágrafo único, e do art. 11 da Instrução Normativa Conjunta nº 25/2020–P-GP/CGJPR (texto compilado até a INC nº 262/2026), dos arts. 325 e 326 do Código de Normas do Foro Judicial (CNFJ — Provimento nº 316/2022–CGJ, atualizado até o Provimento nº 359/2026), do art. 15 da Resolução nº 139/2015–OE/TJPR (alterada pela Resolução nº 517/2025–OE) e do Ofício-Circular nº 17/2026–CGJ (classificação "DEV — Mandado Devolvido"), devolvo o expediente sem distribuição à Unidade Expedidora para apreciação quanto à expedição de Carta Precatória ou retificação do endereço.`,
      };
    }
    return {
      tipo: 'fora_comarca' as const,
      titulo: CERTIDAO_FORA_COMARCA.titulo,
      texto: `CERTIDÃO\n\nCertifico e dou fé, em triagem na Central de Mandados do Foro Regional de São José dos Pinhais (Comarca da Região Metropolitana de Curitiba — TJPR), que, analisado o endereço constante no expediente ("${queryText.trim()}"${detalheLocal}), verificou-se tratar-se de localidade pertencente a outro foro ou comarca, fora da competência territorial deste Foro Regional (cuja jurisdição compreende exclusivamente os Municípios de São José dos Pinhais e Tijucas do Sul).\n\nNos termos da Instrução Normativa Conjunta nº 25/2020–P-GP/CGJPR (texto compilado até a INC nº 262/2026, arts. 3º, 7º, parágrafo único, e 11), dos arts. 325 a 327 do Código de Normas do Foro Judicial (CNFJ — Provimento nº 316/2022–CGJ, atualizado até o Provimento nº 359/2026), do art. 15 da Resolução nº 139/2015–OE/TJPR (alterada pela Resolução nº 517/2025–OE) e do Ofício-Circular nº 17/2026–CGJ (classificação "DEV — Mandado Devolvido"), devolvo o expediente sem distribuição à Unidade Expedidora para encaminhamento direto à Central de Mandados do foro competente mediante Mandado Compartilhado, ou eventual retificação do endereço.`,
    };
  }
  return {
    tipo: 'complementacao' as const,
    titulo: CERTIDAO_COMPLEMENTACAO.titulo,
    texto: `CERTIDÃO\n\nCertifico e dou fé, em triagem na Central de Mandados do Foro Regional de São José dos Pinhais (Comarca da Região Metropolitana de Curitiba — TJPR), que o endereço indicado no mandado ("${queryText.trim()}") ${extraInfo || 'apresenta insuficiência de dados essenciais ou não foi localizado nas bases oficiais dos Municípios de São José dos Pinhais e Tijucas do Sul'}, impossibilitando a individualização segura do local de cumprimento e a regular distribuição.\n\nNos termos do art. 15 da Resolução nº 139/2015–OE/TJPR (alterada pela Resolução nº 517/2025–OE), dos arts. 289 e 325 do Código de Normas do Foro Judicial (CNFJ — Provimento nº 316/2022–CGJ, atualizado até o Provimento nº 359/2026) e do Ofício-Circular nº 17/2026–CGJ (item 7 — "DEV — Mandado Devolvido", c/c Resolução nº 443/2024–OE), devolvo o expediente sem distribuição à Unidade Expedidora para complementação pela parte interessada ou Secretaria.`,
  };
}

function buildMissingAlerts(signals: ParsedMandadoSignals, isRuralOrHighway: boolean): string[] {
  const alerts: string[] = [];
  if (signals.hearingDateAlert) alerts.push(signals.hearingDateAlert.message);
  if (!signals.houseNumber && !isRuralOrHighway && !signals.coords) {
    alerts.push(
      'Ausência de número predial no texto — conferir se há numeral, quadra/lote ou complemento nos autos (Resolução nº 139/2015–OE, art. 15; OC nº 17/2026–CGJ).'
    );
  }
  return alerts;
}

type ExternalRmcRecord = Record<string, { n: string; c: string }>;
interface ExternalRmcIndex {
  noConnMap: Map<string, { n: string; c: string }>;
  prefixMap: Map<string, Array<{ k: string; v: { n: string; c: string } }>>;
}
const externalRmcIndexCache = new WeakMap<ExternalRmcRecord, ExternalRmcIndex>();

function getExternalRmcIndex(externalRmc: ExternalRmcRecord): ExternalRmcIndex {
  let idx = externalRmcIndexCache.get(externalRmc);
  if (idx) return idx;
  const noConnMap = new Map<string, { n: string; c: string }>();
  const prefixMap = new Map<string, Array<{ k: string; v: { n: string; c: string } }>>();
  for (const [k, v] of Object.entries(externalRmc)) {
    const nc = coreWithoutConnectors(k);
    if (nc && !noConnMap.has(nc)) noConnMap.set(nc, v);
    const ch = k[0] || '';
    if (ch) {
      let arr = prefixMap.get(ch);
      if (!arr) {
        arr = [];
        prefixMap.set(ch, arr);
      }
      arr.push({ k, v });
    }
  }
  idx = { noConnMap, prefixMap };
  externalRmcIndexCache.set(externalRmc, idx);
  return idx;
}

const clientExternalGeoCache = new Map<
  string,
  {
    found: boolean;
    lat?: number;
    lon?: number;
    road?: string;
    suburb?: string;
    city?: string;
    state?: string;
  }
>();

const clientCepCache = new Map<
  string,
  {
    cep?: string;
    logradouro?: string;
    bairro?: string;
    localidade?: string;
    uf?: string;
    ibge?: string;
    fonte?: string;
  }
>();

function detectExternalRmcMatch(
  streetQuery: string,
  externalRmc?: ExternalRmcRecord | null
): { matchedName: string; cities: string; score: number } | null {
  if (!externalRmc || !streetQuery) return null;
  const qExp = expandAbbr(streetQuery);
  if (!qExp || qExp.length < 4) return null;

  if (externalRmc[qExp]) {
    return { matchedName: externalRmc[qExp].n, cities: externalRmc[qExp].c, score: 1.0 };
  }

  const idx = getExternalRmcIndex(externalRmc);
  const qNoConn = coreWithoutConnectors(streetQuery);
  if (qNoConn.length >= 6) {
    const exactNoConn = idx.noConnMap.get(qNoConn);
    if (exactNoConn) {
      return { matchedName: exactNoConn.n, cities: exactNoConn.c, score: 0.96 };
    }
  }

  const qCore = qNoConn.replace(/^(?:rua|avenida|estrada|travessa|rodovia|alameda|praca)\s+/, '');
  if (qCore.length >= 7) {
    const bucket = idx.prefixMap.get(qExp[0]) || [];
    const slice4 = qCore.slice(0, 4);
    let best: { matchedName: string; cities: string; score: number } | null = null;
    for (const { k, v } of bucket) {
      if (!k.includes(slice4) && k[0] !== qExp[0]) continue;
      const sc = similarityScore(streetQuery, v.n);
      if (sc >= 0.91 && (!best || sc > best.score)) {
        best = { matchedName: v.n, cities: v.c, score: sc };
      }
    }
    if (best) return best;
  }

  return null;
}

async function queryExternalNominatim(
  streetQuery: string,
  tijucasHint: boolean
): Promise<{
  found: boolean;
  lat?: number;
  lon?: number;
  road?: string;
  suburb?: string;
  city?: string;
  state?: string;
}> {
  if (typeof window === 'undefined') return { found: false };
  const qParam = tijucasHint ? `${streetQuery}, Tijucas do Sul` : streetQuery;
  const cached = clientExternalGeoCache.get(qParam.toLowerCase());
  if (cached) return cached;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2800);
  try {
    const res = await fetch(`/api/geocode-external?q=${encodeURIComponent(qParam)}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return { found: false };
    const data = await res.json();
    if (!data?.found || !data.road) {
      const miss = { found: false };
      clientExternalGeoCache.set(qParam.toLowerCase(), miss);
      return miss;
    }
    const sim = similarityScore(streetQuery, data.road);
    if (sim < 0.72) return { found: false };

    const out = {
      found: true,
      lat: parseFloat(data.lat),
      lon: parseFloat(data.lon),
      road: data.road,
      suburb: data.suburb || '',
      city: data.city || '',
      state: data.state || '',
    };
    clientExternalGeoCache.set(qParam.toLowerCase(), out);
    return out;
  } catch {
    return { found: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzeMandadoInput(
  rawText: string,
  deps: EngineDependencies
): Promise<AnalysisResult> {
  const query = rawText.trim();
  const { geo, streets, streetsGeom, rodoviasKm, externalRmc, streetAliases } = deps;
  const signals = parseMandadoSignals(
    query,
    geo.bairros_localidades,
    streetAliases?.loteamentos || []
  );

  if (!query) {
    return {
      status: 'complementacao',
      regiaoFinal: 'Complementação Necessária',
      regioesPossiveis: [],
      cor: REGION_COLORS['Complementação Necessária'],
      certezaLabel: 'Aguardando entrada',
      titulo: 'Informe endereço, CEP, rodovia+km ou coordenadas',
      subtitulo: '',
      explicacao: [],
      alertas: [],
      lookalikes: [],
      bestMatch: null,
      signals,
    };
  }

  // 1. PRIORIDADE MÁXIMA — Regra Oficial R9 (Casa de Custódia, CMP, CENSE, Delegacias, Plantão)
  if (signals.r9Trigger) {
    const isCMP = signals.r9Trigger.includes('Médico Penal') || signals.r9Trigger.includes('CMP');
    const isCCJP = signals.r9Trigger.includes('Custódia');
    const isCense = signals.r9Trigger.includes('CENSE');
    const isMulher = signals.r9Trigger.includes('Mulher');
    const isDrp = signals.r9Trigger.includes('1ª DRP');
    const pin = isCMP
      ? { lat: -25.4375, lon: -49.1525, kml: 'Pinhais (CMP)' }
      : isCCJP
      ? { lat: -25.50359, lon: -49.14159, kml: 'Região 2' }
      : isCense
      ? { lat: -25.49921, lon: -49.13437, kml: 'Região 2' }
      : isMulher
      ? { lat: -25.53251, lon: -49.21239, kml: 'Região 1' }
      : isDrp
      ? { lat: -25.5308, lon: -49.20225, kml: 'Região 1' }
      : { lat: -25.54045, lon: -49.19599, kml: 'Região 1' };

    return {
      status: 'ok',
      regiaoFinal: 'Região 9',
      regioesPossiveis: ['Região 9'],
      cor: REGION_COLORS['Região 9'],
      certezaLabel: 'Regra Oficial R9 · 99% de certeza',
      titulo: 'Região 9 — Plantão / Prisional / Delegacia',
      subtitulo: signals.r9Trigger,
      explicacao: [
        `Regra oficial do sistema sobrepõe o polígono geográfico (${pin.kml}) e destina Complexo Médico Penal (CMP), Casa de Custódia, CENSE, Delegacias e medidas de cumprimento imediato para a Região 9.`,
      ],
      alertas: [
        `Mesmo que o imóvel físico esteja em ${pin.kml}, a distribuição correta na Central de Mandados é Região 9.`,
        ...buildMissingAlerts(signals, false),
      ],
      lookalikes: [],
      bestMatch: null,
      signals,
      pin: {
        lat: pin.lat,
        lon: pin.lon,
        label: signals.r9Trigger,
        fonte: 'Regra Oficial R9',
        regiao: 'Região 9',
      },
    };
  }

  // 2. Regra Oficial R8 (Citação / Intimação Online expressa)
  if (signals.r8Trigger) {
    return {
      status: 'ok',
      regiaoFinal: 'Região 8',
      regioesPossiveis: ['Região 8'],
      cor: REGION_COLORS['Região 8'],
      certezaLabel: 'Regra Oficial R8 · 98% de certeza',
      titulo: 'Região 8 — Citação / Intimação via Online',
      subtitulo: signals.r8Trigger,
      explicacao: [
        'Identificada determinação expressa de cumprimento eletrônico/virtual, enquadrando na Região 8 conforme tabela oficial da Central.',
      ],
      alertas: buildMissingAlerts(signals, true),
      lookalikes: [],
      bestMatch: null,
      signals,
    };
  }

  // 3. Município externo explícito no texto
  if (signals.externalCity) {
    return {
      status: 'fora_comarca',
      regiaoFinal: 'Fora da Comarca',
      regioesPossiveis: [],
      cor: REGION_COLORS['Fora da Comarca'],
      certezaLabel: 'Fora da Comarca · 98% de certeza',
      titulo: `Fora da Comarca (${signals.externalCity})`,
      subtitulo:
        'A Central de Mandados de SJP abrange exclusivamente São José dos Pinhais (R1–R6) e Tijucas do Sul (R7).',
      explicacao: [
        `Detectado município externo explícito no endereço: ${signals.externalCity}.`,
        'Cabe devolução sem distribuição como "DEV — Mandado Devolvido" (INC nº 25/2020 atualizada até a INC nº 262/2026, arts. 3º, 7º, parágrafo único, e 11; CNFJ arts. 325–327; Resolução nº 139/2015–OE, art. 15; OC nº 17/2026–CGJ).',
      ],
      alertas: [
        `Município externo (${signals.externalCity}) — devolver sem distribuição (DEV / INC nº 25/2020 e Res. nº 139/2015–OE).`,
      ],
      lookalikes: [],
      bestMatch: null,
      signals,
      certidao: buildDynamicCertidao('fora_comarca', query, signals.externalCity),
    };
  }

  // 4. Coordenadas explícitas
  if (signals.coords) {
    const cl = classifyCoordinates(signals.coords.lat, signals.coords.lon, geo);
    if (!cl.dentroComarca) {
      return {
        status: 'fora_comarca',
        regiaoFinal: 'Fora da Comarca',
        regioesPossiveis: [],
        cor: REGION_COLORS['Fora da Comarca'],
        certezaLabel: 'Coordenada fora da Comarca · 96%',
        titulo: 'Fora da Comarca de SJP / Tijucas do Sul',
        subtitulo: cl.subtitulo,
        explicacao: [
          `Coordenadas (${signals.coords.lat.toFixed(5)}, ${signals.coords.lon.toFixed(5)}) caem fora dos polígonos de São José dos Pinhais e Tijucas do Sul.`,
        ],
        alertas: cl.alertas,
        lookalikes: [],
        bestMatch: null,
        signals,
        pin: {
          lat: signals.coords.lat,
          lon: signals.coords.lon,
          label: 'Ponto fora da Comarca',
          fonte: 'Geolocalização KML/OSM',
          regiao: 'Fora da Comarca',
        },
        certidao: buildDynamicCertidao(
          'fora_comarca',
          query,
          `coordenadas (${signals.coords.lat.toFixed(5)}, ${signals.coords.lon.toFixed(5)}) fora da Comarca`
        ),
      };
    }

    return {
      status: 'ok',
      regiaoFinal: cl.regiao,
      regioesPossiveis: [cl.regiao],
      cor: REGION_COLORS[cl.regiao] || '#2563EB',
      certezaLabel: `Coordenada Validada · ${cl.camadaBase}`,
      titulo: cl.regiao,
      subtitulo: cl.subtitulo,
      explicacao: [
        `Ponto (${signals.coords.lat.toFixed(5)}, ${signals.coords.lon.toFixed(5)}) validado por geometria poligonal (${cl.camadaBase}).`,
      ],
      alertas: [
        ...cl.alertas,
        ...(signals.hearingDateAlert ? [signals.hearingDateAlert.message] : []),
      ],
      lookalikes: [],
      bestMatch: null,
      signals,
      pin: {
        lat: signals.coords.lat,
        lon: signals.coords.lon,
        label: cl.subtitulo,
        fonte: cl.camadaBase,
        regiao: cl.regiao,
      },
      highlightPolygonName: cl.regiao,
    };
  }

  // 5. Rodovia + KM calibrado (BR-277, BR-376, BR-116)
  if (signals.highwayKm) {
    const { rodovia, km } = signals.highwayKm;
    const kmTable = rodoviasKm[rodovia];
    if (kmTable) {
      const pairs = Object.entries(kmTable);
      let bestKmNum = parseFloat(pairs[0][0]);
      let best = pairs[0][1];
      let bestDiff = Math.abs(bestKmNum - km);
      for (const [kStr, e] of pairs) {
        const kVal = parseFloat(kStr);
        const d = Math.abs(kVal - km);
        if (d < bestDiff) {
          bestKmNum = kVal;
          best = e;
          bestDiff = d;
        }
      }

      if (best && bestDiff <= 5) {
        const regText = best.regioes.join(' / ');
        const isOut = regText.startsWith('Fora');
        if (isOut) {
          return {
            status: 'fora_comarca',
            regiaoFinal: 'Fora da Comarca',
            regioesPossiveis: [],
            cor: REGION_COLORS['Fora da Comarca'],
            certezaLabel: `Marco Rodoviário (${best.fonte})`,
            titulo: `Fora da Comarca — ${rodovia} km ${km}`,
            subtitulo: `${regText} (marco próximo: km ${bestKmNum})`,
            explicacao: [
              `Na tabela calibrada de ${rodovia}, o km ${km} (marco de referência ${bestKmNum}) já ultrapassa os limites da Comarca de SJP/Tijucas do Sul.`,
            ],
            alertas: [`Marco calibrado: ${rodovia} km ${bestKmNum} -> ${regText}.`],
            lookalikes: [],
            bestMatch: null,
            signals,
            pin: {
              lat: best.lat,
              lon: best.lon,
              label: `${rodovia} km ${km}`,
              fonte: best.fonte,
              regiao: 'Fora da Comarca',
            },
            certidao: buildDynamicCertidao('fora_comarca', query, `${rodovia} km ${km} (${regText})`),
          };
        }

        const primaryReg = regText.includes('Região 7')
          ? 'Região 7'
          : regText.match(/Região\s+\d+A?/)?.[0] || regText;
        const isDivisa = regText.includes('Divisa');
        return {
          status: isDivisa ? 'divisa' : 'ok',
          regiaoFinal: primaryReg,
          regioesPossiveis: best.regioes,
          cor: REGION_COLORS[primaryReg] || '#2563EB',
          certezaLabel: isDivisa ? 'Trecho de Divisa Rodoviária' : 'Marco Rodoviário Calibrado · 95%',
          titulo: isDivisa ? regText : primaryReg,
          subtitulo: `${rodovia}, km ${km} (referência calibrada: km ${bestKmNum} · ${best.fonte})`,
          explicacao: [
            `Localização calibrada pelos marcos quilométricos da ${rodovia} (${best.fonte}).`,
          ],
          alertas: isDivisa
            ? [
                `ATENÇÃO — TRECHO DE DIVISA (${regText}): o lado norte/leste ou sul/oeste da pista define a Região exata; confira no mapa abaixo.`,
                ...buildMissingAlerts(signals, true),
              ]
            : buildMissingAlerts(signals, true),
          lookalikes: [],
          bestMatch: null,
          signals,
          pin: {
            lat: best.lat,
            lon: best.lon,
            label: `${rodovia} km ${km}`,
            fonte: best.fonte,
            regiao: primaryReg,
          },
          highlightPolygonName: primaryReg,
        };
      }
    }
  }

  // 6. CEP — aceita qualquer pontuação, "CEP" na frente ou só números (ViaCEP -> BrasilAPI v2 -> OpenCEP + faixa PR)
  let workingAddress = signals.extractedAddressLine;
  const cepAlerts: string[] = [];
  let cepInfo: AnalysisResult['cepInfo'] = null;

  if (signals.malformedCep) {
    cepAlerts.push(
      `CEP informado fora do padrão de 8 dígitos ("${signals.malformedCep}") — desconsiderado para evitar direcionamento postal incorreto; triagem realizada pelo logradouro, número e bairro.`
    );
  }

  if (signals.cep) {
    const cepNum = parseInt(signals.cep, 10);
    const isButiazinhoTrap = cepNum >= 83050190 && cepNum <= 83050216;
    if (isButiazinhoTrap) {
      cepAlerts.push(
        `ARMADILHA BUTIAZINHO (CEP ${signals.cep.slice(0, 5)}-${signals.cep.slice(5)}): Os Correios rotulam este CEP como "Parque da Fonte" (R3), mas a localidade física é São Judas Tadeu / Butiazinho — REGIÃO 2!`
      );
    }

    const cleanedWithoutCep = workingAddress
      .replace(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g, '')
      .replace(/(?:c\.?\s*e\.?\s*p\.?\s*[:\-]?\s*)?\d{2}\.?\d{3}[-\s.]?\d{3}/gi, '')
      .replace(/\bc\.?\s*e\.?\s*p\.?\b/gi, '')
      .replace(/\b(?:n[º°.]?\s*\d{1,5}|s\s*\/\s*n)\b/gi, '')
      .replace(/[\d\s,.\-:/]+/g, '');
    const userOnlyTypedCep = cleanedWithoutCep.length < 3;

    if (typeof window !== 'undefined') {
      try {
        let data = clientCepCache.get(signals.cep);
        if (!data) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 2400);
          try {
            const res = await fetch(`/api/cep?cep=${signals.cep}`, { signal: ctrl.signal });
            if (res.ok) {
              const json = await res.json();
              if (json && !json.erro && json.localidade) {
                data = json;
                clientCepCache.set(signals.cep, json);
              }
            }
          } finally {
            clearTimeout(timer);
          }
        }
        if (data && data.localidade) {
            cepInfo = {
              cep: data.cep || signals.cep,
              logradouro: data.logradouro || '',
              bairro: data.bairro || '',
              localidade: data.localidade,
              uf: data.uf || 'PR',
              ibge: data.ibge,
              isButiazinhoTrap,
            };

            const locNorm = norm(data.localidade);
            if (!['sao jose dos pinhais', 'tijucas do sul'].includes(locNorm)) {
              return {
                status: 'fora_comarca',
                regiaoFinal: 'Fora da Comarca',
                regioesPossiveis: [],
                cor: REGION_COLORS['Fora da Comarca'],
                certezaLabel: `CEP Oficial (${data.fonte || 'Correios'}) · 99%`,
                titulo: `Fora da Comarca (${data.localidade}/${data.uf})`,
                subtitulo: `${data.logradouro || `CEP ${data.cep}`}${data.bairro ? ` — ${data.bairro}` : ''}`,
                explicacao: [
                  `CEP consultado via ${data.fonte || 'Correios'} pertence oficialmente a ${data.localidade}/${data.uf}, fora desta Comarca.`,
                ],
                alertas: [
                  `CEP de ${data.localidade}/${data.uf} — devolver sem distribuição (DEV / INC nº 25/2020, CNFJ arts. 325–327 e OC nº 17/2026–CGJ).`,
                ],
                lookalikes: [],
                bestMatch: null,
                signals,
                cepInfo,
                certidao: buildDynamicCertidao(
                  'fora_comarca',
                  query,
                  `${data.localidade}/${data.uf} — CEP ${data.cep}`
                ),
              };
            }

            if (locNorm === 'tijucas do sul') {
              if (!data.logradouro) {
                return {
                  status: 'ok',
                  regiaoFinal: 'Região 7',
                  regioesPossiveis: ['Região 7'],
                  cor: REGION_COLORS['Região 7'],
                  certezaLabel: `CEP Tijucas do Sul (${data.fonte || 'BrasilAPI'}) · 97%`,
                  titulo: 'Região 7 — Tijucas do Sul',
                  subtitulo: `CEP geral municipal ${data.cep} — Tijucas do Sul/PR`,
                  explicacao: [
                    `CEP resolvido via ${data.fonte || 'BrasilAPI'} como pertencente a Tijucas do Sul/PR.`,
                    'Todo o município de Tijucas do Sul distribui exclusivamente na Região 7.',
                  ],
                  alertas: [...cepAlerts, ...buildMissingAlerts(signals, true)],
                  lookalikes: [],
                  bestMatch: null,
                  signals,
                  cepInfo,
                  pin: {
                    lat: -25.92734,
                    lon: -49.17927,
                    label: `Tijucas do Sul (CEP ${data.cep})`,
                    fonte: data.fonte || 'BrasilAPI',
                    regiao: 'Região 7',
                  },
                  highlightPolygonName: 'Região 7',
                };
              }
              cepAlerts.push(
                `${data.fonte || 'Correios'}: ${data.logradouro}${data.bairro ? ` — ${data.bairro}` : ''}, Tijucas do Sul/PR (Região 7).`
              );
            } else {
              cepAlerts.push(
                `${data.fonte || 'Correios'}: ${data.logradouro || '(CEP geral sem logradouro)'}${data.bairro ? ` — Bairro ${data.bairro}` : ''}, SJP/PR.`
              );
            }

            if (userOnlyTypedCep) {
              if (data.logradouro) {
                const numPart = signals.houseNumber ? `, ${signals.houseNumber}` : '';
                const bPart = data.bairro ? `, ${data.bairro}` : '';
                workingAddress = `${data.logradouro}${numPart}${bPart}`;
              } else if (locNorm === 'sao jose dos pinhais') {
                return {
                  status: 'complementacao',
                  regiaoFinal: 'Complementação Necessária',
                  regioesPossiveis: ['Região 1', 'Região 2', 'Região 3', 'Região 4', 'Região 5', 'Região 6'],
                  cor: REGION_COLORS['Complementação Necessária'],
                  certezaLabel: `CEP Geral de SJP (${data.fonte || 'Correios'})`,
                  titulo: `CEP Geral de São José dos Pinhais (${data.cep})`,
                  subtitulo: 'CEP único/geral sem logradouro específico vinculado nos Correios',
                  explicacao: [
                    `O CEP ${data.cep} é CEP geral do município de São José dos Pinhais (sem rua vinculada nos Correios).`,
                    'Como SJP divide-se entre as Regiões 1 a 6, informe também o nome da rua, bairro ou colônia rural.',
                  ],
                  alertas: cepAlerts,
                  lookalikes: [],
                  bestMatch: null,
                  signals,
                  cepInfo,
                  certidao: buildDynamicCertidao(
                    'complementacao',
                    query,
                    'contém apenas o CEP geral do município, sem indicação de logradouro ou bairro correspondente'
                  ),
                };
              }
            }
        }
      } catch {
        // segue para fallback por faixa oficial de CEP
      }
    }

    // Fallback determinístico caso APIs externas estejam indisponíveis
    if (!cepInfo) {
      if (cepNum >= 83190000 && cepNum <= 83199999) {
        cepInfo = {
          cep: `${signals.cep.slice(0, 5)}-${signals.cep.slice(5)}`,
          logradouro: '',
          bairro: '',
          localidade: 'Tijucas do Sul',
          uf: 'PR',
        };
        if (userOnlyTypedCep) {
          return {
            status: 'ok',
            regiaoFinal: 'Região 7',
            regioesPossiveis: ['Região 7'],
            cor: REGION_COLORS['Região 7'],
            certezaLabel: 'Faixa Postal Tijucas do Sul · 95%',
            titulo: 'Região 7 — Tijucas do Sul',
            subtitulo: `Faixa oficial ${cepInfo.cep} (83190-000 a 83199-999)`,
            explicacao: [
              'A faixa de CEP 83190-000 a 83199-999 pertence integralmente ao município de Tijucas do Sul (Região 7).',
            ],
            alertas: [...cepAlerts, ...buildMissingAlerts(signals, true)],
            lookalikes: [],
            bestMatch: null,
            signals,
            cepInfo,
            pin: {
              lat: -25.92734,
              lon: -49.17927,
              label: `CEP ${cepInfo.cep} (Tijucas do Sul)`,
              fonte: 'Faixa Postal Correios',
              regiao: 'Região 7',
            },
            highlightPolygonName: 'Região 7',
          };
        }
      } else if (cepNum >= 80000000 && cepNum <= 82999999) {
        cepInfo = {
          cep: `${signals.cep.slice(0, 5)}-${signals.cep.slice(5)}`,
          logradouro: '',
          bairro: '',
          localidade: 'Curitiba',
          uf: 'PR',
        };
        return {
          status: 'fora_comarca',
          regiaoFinal: 'Fora da Comarca',
          regioesPossiveis: [],
          cor: REGION_COLORS['Fora da Comarca'],
          certezaLabel: 'Faixa Postal Curitiba · 98%',
          titulo: 'Fora da Comarca (Curitiba/PR)',
          subtitulo: `CEP ${cepInfo.cep} pertence à faixa oficial 80000–82999 de Curitiba/PR`,
          explicacao: ['A faixa de CEP 80000-000 a 82999-999 pertence exclusivamente a Curitiba/PR.'],
          alertas: ['CEP de Curitiba/PR — devolver sem distribuição para envio de Mandado Compartilhado à Central de Curitiba (INC nº 25/2020 / OC nº 17/2026–CGJ).'],
          lookalikes: [],
          bestMatch: null,
          signals,
          cepInfo,
          certidao: buildDynamicCertidao('fora_comarca', query, `Curitiba/PR — CEP ${cepInfo.cep}`),
        };
      } else if (cepNum < 80000000 || cepNum >= 83200000) {
        const cepFmt = `${signals.cep.slice(0, 5)}-${signals.cep.slice(5)}`;
        const isOutOfPr = cepNum < 80000000 || cepNum >= 88000000;
        const faixaDesc = isOutOfPr ? 'outro Estado da Federação' : 'outro município do Paraná (fora da faixa 83000–83199)';
        return {
          status: 'fora_comarca',
          regiaoFinal: 'Fora da Comarca',
          regioesPossiveis: [],
          cor: REGION_COLORS['Fora da Comarca'],
          certezaLabel: 'Faixa Postal Externa · 97%',
          titulo: `Fora da Comarca (CEP ${cepFmt})`,
          subtitulo: `Faixa postal pertencente a ${faixaDesc}`,
          explicacao: [
            `O CEP ${cepFmt} está fora das faixas postais de São José dos Pinhais e Tijucas do Sul (83000–83199).`,
          ],
          alertas: [
            `CEP externo (${cepFmt}) — devolver sem distribuição como "DEV — Mandado Devolvido" (INC nº 25/2020, CNFJ arts. 325–327 e OC nº 17/2026–CGJ).`,
          ],
          lookalikes: [],
          bestMatch: null,
          signals,
          cepInfo: {
            cep: cepFmt,
            logradouro: '',
            bairro: '',
            localidade: isOutOfPr ? 'Outro Estado' : 'Município Externo/PR',
            uf: isOutOfPr ? 'BR' : 'PR',
          },
          certidao: buildDynamicCertidao('fora_comarca', query, `${faixaDesc} — CEP ${cepFmt}`),
        };
      } else if (userOnlyTypedCep && cepNum >= 83000000 && cepNum <= 83119999) {
        const cepFmt = `${signals.cep.slice(0, 5)}-${signals.cep.slice(5)}`;
        cepInfo = {
          cep: cepFmt,
          logradouro: '',
          bairro: '',
          localidade: 'São José dos Pinhais',
          uf: 'PR',
        };
        return {
          status: 'complementacao',
          regiaoFinal: 'Complementação Necessária',
          regioesPossiveis: ['Região 1', 'Região 2', 'Região 3', 'Região 4', 'Região 5', 'Região 6'],
          cor: REGION_COLORS['Complementação Necessária'],
          certezaLabel: 'CEP Geral / Faixa de SJP sem rua vinculada',
          titulo: `CEP Geral de São José dos Pinhais (${cepFmt})`,
          subtitulo:
            'CEP da faixa de São José dos Pinhais sem logradouro específico vinculado nos Correios',
          explicacao: [
            `O CEP ${cepFmt} pertence à faixa postal de São José dos Pinhais (83000-000 a 83119-999), porém não possui logradouro único vinculado nas bases Correios/ViaCEP/BrasilAPI.`,
            'Como SJP divide-se em 6 regiões (R1 a R6), informe também o nome da rua, bairro ou colônia rural.',
          ],
          alertas: [
            ...cepAlerts,
            'CEP geral/sem rua — necessário informar logradouro ou bairro para distribuir entre as Regiões 1 a 6.',
          ],
          lookalikes: [],
          bestMatch: null,
          signals,
          cepInfo,
          certidao: buildDynamicCertidao(
            'complementacao',
            query,
            'contém apenas o CEP geral de São José dos Pinhais, sem indicação de logradouro ou bairro correspondente'
          ),
        };
      }
    }
  }

  // 7. Identificação de contexto Tijucas do Sul / Castelhanos
  const workingNorm = expandAbbr(workingAddress);
  const workingCoreNoAccents = norm(workingAddress);
  const hasTijucasBairro = Array.from(TIJUCAS_BAIRROS_EXCLUSIVOS).some((tb) =>
    workingCoreNoAccents.includes(tb)
  );
  const tijucasHint = Boolean(
    signals.r7Trigger ||
      signals.internalCityHint === 'TIJ' ||
      (cepInfo && norm(cepInfo.localidade) === 'tijucas do sul') ||
      (signals.cep && /^8319/.test(signals.cep)) ||
      (signals.internalCityHint !== 'SJP' && hasTijucasBairro) ||
      /\btijucas(?:\s+do\s+sul)?\b/i.test(workingNorm)
  );

  // 8. Busca na base unificada SJP + Tijucas do Sul + aliases/leis/loteamentos
  const streetQuery = cleanStreetCandidateFromAddress(workingAddress);
  const qNormClean = expandAbbr(streetQuery);

  // Sinais de contexto de bairro / loteamento / CEP para desambiguar ruas homônimas ("Rua 2, Ipê" vs "Rua 2, Santo Antônio")
  const ctxBairrosNorm = Array.from(
    new Set(
      [
        ...signals.bairrosDetectados.map((b) => expandAbbr(b.nome)),
        ...(cepInfo?.bairro ? [expandAbbr(cepInfo.bairro)] : []),
      ].filter(Boolean)
    )
  );
  const ctxLotsNorm = Array.from(
    new Set((signals.loteamentosDetectados || []).map((l) => expandAbbr(l.nome)).filter(Boolean))
  );
  const expectedRegions = new Set<string>();
  const regCountByBairroNorm = new Map<string, Set<string>>();
  for (const bl of geo.bairros_localidades) {
    const bn = expandAbbr(bl.nome);
    const set = regCountByBairroNorm.get(bn) || new Set<string>();
    set.add(bl.regiao);
    regCountByBairroNorm.set(bn, set);
  }
  for (const b of signals.bairrosDetectados) {
    const bn = expandAbbr(b.nome);
    if (bn === 'area rural') continue;
    const regs = regCountByBairroNorm.get(bn);
    if (!regs || regs.size <= 2) {
      expectedRegions.add(b.regiao);
    }
  }
  for (const l of signals.loteamentosDetectados || []) {
    expectedRegions.add(l.regiao);
  }
  if (tijucasHint) expectedRegions.add('Região 7');

  const rawTail = workingAddress.slice(
    workingAddress.toLowerCase().indexOf(streetQuery.toLowerCase()) >= 0
      ? workingAddress.toLowerCase().indexOf(streetQuery.toLowerCase()) + streetQuery.length
      : 0
  );
  const workingTailNorm = expandAbbr(rawTail);
  const tailSegments = rawTail
    .split(/[,;\-\n]/)
    .map((seg) => expandAbbr(seg))
    .filter((seg) => seg.length >= 4);
  const stripPhaseSuffix = (v: string) =>
    v.replace(/\s+(?:i|ii|iii|iv|v|1|2|3|4|5)$/i, '').trim();
  const hasExplicitLocContext = ctxBairrosNorm.length > 0 || ctxLotsNorm.length > 0 || Boolean(cepInfo?.cep);

  const computeContextAffinity = (
    candB?: string | null,
    candLot?: string | null,
    candCep?: string | null,
    candRegions?: string[],
    candSubBairros?: StreetEntry['subBairros'],
    candScore = 1
  ): { bonus: number; matchedHint: boolean; regionConflict: boolean } => {
    let bonus = 0;
    let matchedHint = false;
    let regionConflict = false;
    const bNorm = candB ? expandAbbr(candB) : '';
    const lNorm = candLot ? expandAbbr(candLot) : '';
    const cDigits = candCep ? candCep.replace(/\D/g, '') : '';

    if (signals.cep && cDigits && signals.cep === cDigits) {
      bonus += 0.18;
      matchedHint = true;
    }

    let matchedSubBairroHit = false;
    if (candSubBairros && ctxBairrosNorm.length > 0) {
      for (const sbName of Object.keys(candSubBairros)) {
        const sbNorm = expandAbbr(sbName);
        if (ctxBairrosNorm.some((bn) => sbNorm.includes(bn) || bn.includes(sbNorm))) {
          matchedSubBairroHit = true;
          matchedHint = true;
          break;
        }
      }
    }

    if (lNorm) {
      const lotParts = lNorm
        .split(/[/,]/)
        .map((p) => p.trim())
        .filter((p) => p.length >= 4);
      const lotHit =
        ctxLotsNorm.some((ln) => lNorm.includes(ln) || ln.includes(lNorm)) ||
        lotParts.some((p) => {
          const pBase = stripPhaseSuffix(p);
          return (
            workingTailNorm.includes(p) ||
            (pBase.length >= 5 && workingTailNorm.includes(pBase)) ||
            tailSegments.some((ts) => {
              const tsBase = stripPhaseSuffix(ts);
              return p.includes(ts) || (tsBase.length >= 5 && pBase.includes(tsBase));
            })
          );
        });
      if (lotHit) {
        bonus += 0.16;
        matchedHint = true;
      }
    }

    let bHit = false;
    if (bNorm) {
      bHit =
        ctxBairrosNorm.some((bn) => bNorm.includes(bn) || bn.includes(bNorm)) ||
        (workingTailNorm.length >= 3 &&
          bNorm.split('/').some((part) => {
            const p = part.trim();
            return p.length >= 3 && new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(workingTailNorm);
          }));
      if (bHit) {
        bonus += 0.12;
        matchedHint = true;
      }
    }

    if (matchedSubBairroHit) {
      // Only add full +0.16 when bNorm didn't already grant +0.12; prevents a 150m stub with subBairros from outranking a 2.8km main road in the same bairro
      bonus += bHit ? 0.02 : 0.16;
    }

    if (
      expectedRegions.size > 0 &&
      candRegions &&
      candRegions.length > 0 &&
      !candRegions.some((r) => expectedRegions.has(r))
    ) {
      regionConflict = true;
      bonus -= candScore < 0.94 ? 0.45 : 0.40;
    }

    // Penalidade apenas quando o usuário informou bairro/loteamento explícito e o candidato pertence a outro local conhecido
    if (!matchedHint && (ctxBairrosNorm.length > 0 || ctxLotsNorm.length > 0) && (bNorm || lNorm)) {
      bonus -= 0.14;
    }

    return { bonus, matchedHint, regionConflict };
  };

  interface RankedCandidate extends StreetMatchCandidate {
    rankScore: number;
    matchedContext: boolean;
    regionConflict: boolean;
    aliasMatch?: StreetAliasEntry;
  }

  const streetIdx = getStreetIndex(streets);
  const scoredRaw: RankedCandidate[] = [];

  const qStripColonia = (qNormClean || '').replace(/^colonia\s+/, '');
  const qIsExplicitBairroOrLot = Boolean(
    qNormClean &&
      (signals.bairrosDetectados.some((b) => {
        const bn = expandAbbr(b.nome);
        return bn === qNormClean || bn.replace(/^colonia\s+/, '') === qStripColonia;
      }) ||
        (signals.loteamentosDetectados || []).some((l) => expandAbbr(l.nome) === qNormClean))
  );

  const exactOrthoBonus = (qStr: string, candStr: string): number => {
    const qLit = norm(qStr).replace(/\bdona\s+/g, '');
    const cLit = norm(candStr).replace(/\bdona\s+/g, '');
    if (qLit === cLit) return 0.025;
    if (qLit.length >= 8 && cLit.includes(qLit)) return 0.015;
    return 0;
  };

  if (qNormClean && qNormClean.length >= 3 && !qIsExplicitBairroOrLot) {
    const pool = tijucasHint
      ? streetIdx.tij
      : signals.internalCityHint === 'SJP'
      ? streetIdx.sjp
      : streets;
    for (const s of pool) {
      const sc = similarityScore(streetQuery, s.n);
      if (sc >= 0.72) {
        const { bonus, matchedHint, regionConflict } = computeContextAffinity(
          s.b,
          s.lot,
          s.cep,
          s.r,
          s.subBairros,
          sc
        );
        if (regionConflict && sc < 0.88) continue;
        scoredRaw.push({
          street: s,
          score: sc,
          rankScore: sc + bonus + exactOrthoBonus(streetQuery, s.n),
          matchedContext: matchedHint,
          regionConflict,
        });
      }
    }
    if (tijucasHint && scoredRaw.length === 0) {
      for (const s of streets) {
        const sc = similarityScore(streetQuery, s.n);
        if (sc >= 0.74) {
          const { bonus, matchedHint, regionConflict } = computeContextAffinity(
            s.b,
            s.lot,
            s.cep,
            s.r,
            s.subBairros,
            sc
          );
          if (regionConflict && sc < 0.88) continue;
          scoredRaw.push({
            street: s,
            score: sc,
            rankScore: sc + bonus + exactOrthoBonus(streetQuery, s.n),
            matchedContext: matchedHint,
            regionConflict,
          });
        }
      }
    }

    // Busca na tabela de aliases (leis de denominação antiga, nomes populares, PDFs GeoSJP, Google Maps)
    const aliasPool = (streetAliases?.aliases || []).filter((al) =>
      tijucasHint ? al.m === 'TIJ' : signals.internalCityHint === 'SJP' ? al.m === 'SJP' : true
    );
    if (aliasPool.length > 0) {
      for (const al of aliasPool) {
        const alSim = similarityScore(streetQuery, al.a);
        if (alSim < 0.8) continue;
        const targetKey = `${al.m}|${canonicalizeNumberedStreetText(al.t, true)}`;
        const targets = streetIdx.byMunTarget.get(targetKey);
        if (!targets || targets.length === 0) continue;

        const alB = al.b ? expandAbbr(al.b) : '';
        const alLot = al.lot ? expandAbbr(al.lot) : '';
        const chosenTarget =
          targets.find(
            (tg) =>
              (alLot && tg.lot && expandAbbr(tg.lot).includes(alLot)) ||
              (alB && tg.b && expandAbbr(tg.b).includes(alB))
          ) || targets[0];

        const baseAlScore = Math.min(0.985, alSim * 0.985);
        const { bonus, matchedHint, regionConflict } = computeContextAffinity(
          al.b || chosenTarget.b,
          al.lot || chosenTarget.lot,
          chosenTarget.cep,
          chosenTarget.r,
          chosenTarget.subBairros,
          baseAlScore
        );
        if (regionConflict && baseAlScore < 0.88) continue;
        scoredRaw.push({
          street: chosenTarget,
          score: baseAlScore,
          rankScore: baseAlScore + bonus,
          matchedContext: matchedHint,
          regionConflict,
          aliasMatch: al,
        });
      }
    }
  }

  // Deduplica mantendo o melhor candidato por (cluster/nome + região principal)
  const dedupMap = new Map<string, RankedCandidate>();
  for (const cand of scoredRaw) {
    const dk = cand.street.gid || `${cand.street.m}|${cand.street.n}|${cand.street.rp}`;
    const prev = dedupMap.get(dk);
    if (!prev || cand.rankScore > prev.rankScore) {
      dedupMap.set(dk, cand);
    }
  }
  const scored: RankedCandidate[] = Array.from(dedupMap.values()).sort((a, b) => {
    if (Math.abs(b.rankScore - a.rankScore) > 0.005) return b.rankScore - a.rankScore;
    if (b.score !== a.score) return b.score - a.score;
    if (tijucasHint && a.street.m !== b.street.m) return b.street.m === 'TIJ' ? -1 : 1;
    return b.street.len - a.street.len;
  });

  // Fallback R7 se o texto era explicitamente Castelhanos / Tijucas do Sul sem nome de rua específico
  if (signals.r7Trigger && (scored.length === 0 || scored[0].score < 0.78)) {
    const isCastelhanos = signals.r7Trigger.includes('Castelhanos');
    return {
      status: 'ok',
      regiaoFinal: 'Região 7',
      regioesPossiveis: ['Região 7'],
      cor: REGION_COLORS['Região 7'],
      certezaLabel: 'Regra Oficial R7 · 94%',
      titulo: 'Região 7 — Tijucas do Sul / Castelhanos',
      subtitulo: signals.r7Trigger,
      explicacao: [
        isCastelhanos
          ? 'Regra oficial do sistema: toda a comunidade da Colônia Castelhanos pertence à Região 7 (sobrepondo a Área Rural 5 do mapa).'
          : 'Regra oficial: todo o município de Tijucas do Sul pertence à Região 7.',
      ],
      alertas: [...cepAlerts, ...buildMissingAlerts(signals, true)],
      lookalikes: [],
      bestMatch: null,
      signals,
      cepInfo,
      pin: {
        lat: isCastelhanos ? -25.7997 : -25.92734,
        lon: isCastelhanos ? -48.90974 : -49.17927,
        label: signals.r7Trigger,
        fonte: 'Regra Oficial R7',
        regiao: 'Região 7',
      },
      highlightPolygonName: 'Região 7',
    };
  }

  // 9. TRIPLA VERIFICAÇÃO AO VIVO (Google Maps + GeoSJP + OSM) + DETECÇÃO RMC
  const bestSjpScore = scored.length > 0 ? scored[0].score : 0;
  const hasInternalComarcaAnchor =
    tijucasHint || signals.internalCityHint === 'SJP' || expectedRegions.size > 0;
  const shouldCheckExternalRmc =
    !qIsExplicitBairroOrLot && !hasInternalComarcaAnchor && streetQuery.length >= 3 && bestSjpScore < 0.90;
  const resolvedExternalRmc = shouldCheckExternalRmc
    ? externalRmc || (deps.getExternalRmc ? await deps.getExternalRmc() : null)
    : null;
  const extMatchForCheck = shouldCheckExternalRmc
    ? detectExternalRmcMatch(streetQuery, resolvedExternalRmc)
    : null;
  const isGenericNumberedQuery = /^(?:rua|avenida|travessa|estrada|servidao)\s+(?:n[oº]?\s*|numero\s*)?(?:\d{1,3}|[a-z]|um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez)$/i.test(
    canonicalizeNumberedStreetText(streetQuery, true)
  );
  if (
    extMatchForCheck &&
    bestSjpScore < 0.90 &&
    !(isGenericNumberedQuery && scored.length > 0) &&
    (scored.length === 0 || extMatchForCheck.score >= 0.96)
  ) {
    const extMatch = extMatchForCheck;
    if (extMatch) {
      const cityDisplay = extMatch.cities;
      return {
        status: 'fora_comarca',
        regiaoFinal: 'Fora da Comarca',
        regioesPossiveis: [],
        cor: REGION_COLORS['Fora da Comarca'],
        certezaLabel: `Logradouro de ${cityDisplay} · ${Math.round(extMatch.score * 100)}%`,
        titulo: `Fora da Comarca (${cityDisplay})`,
        subtitulo: `${extMatch.matchedName} — município de ${extMatch.cities}/PR`,
        explicacao: [
          `Embora a cidade não tenha sido digitada, "${extMatch.matchedName}" corresponde exatamente a logradouro oficial de ${extMatch.cities} (e difere de eventuais vias homônimas parciais em SJP).`,
          'Nos termos da INC nº 25/2020 (arts. 3º e 7º, parágrafo único), CNFJ (arts. 325–327), Resolução nº 139/2015–OE (art. 15) e Ofício-Circular nº 17/2026–CGJ (DEV), trata-se de endereço fora da competência territorial deste Foro (não é falta de complemento).',
        ],
        alertas: [
          `FORA DA COMARCA (${cityDisplay}): devolver sem distribuição por incompetência territorial (DEV / INC nº 25/2020 e Res. nº 139/2015–OE).`,
        ],
        lookalikes: [],
        bestMatch: null,
        signals,
        cepInfo,
        pin: null,
        certidao: buildDynamicCertidao(
          'fora_comarca',
          query,
          `${extMatch.matchedName} — município de ${cityDisplay}/PR`
        ),
      };
    }
  }

  if (scored.length === 0 && streetQuery.length >= 3 && !qIsExplicitBairroOrLot) {
    // 9A. Tripla Verificação dentro da Comarca (Google Maps + GeoSJP Número Predial/1897 + OSM Nominatim)
    if (typeof window !== 'undefined') {
      try {
        const cityParam = tijucasHint ? 'Tijucas do Sul' : 'São José dos Pinhais';
        const bairroParam =
          signals.bairrosDetectados[0]?.nome || cepInfo?.bairro || '';
        const qForGeo = `${streetQuery}${signals.houseNumber ? `, ${signals.houseNumber}` : ''}${
          bairroParam ? `, ${bairroParam}` : ''
        }`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3800);
        try {
          const gRes = await fetch(
            `/api/geocode?q=${encodeURIComponent(qForGeo)}&city=${encodeURIComponent(
              cityParam
            )}&street=${encodeURIComponent(streetQuery)}&bairro=${encodeURIComponent(bairroParam)}`,
            { signal: ctrl.signal }
          );
          if (gRes.ok) {
            const gdata = await gRes.json();
            if (gdata?.found && !gdata.bairroFallback && gdata.lat && gdata.lon) {
              const gLat = parseFloat(gdata.lat);
              const gLon = parseFloat(gdata.lon);
              const cl = classifyCoordinates(gLat, gLon, geo);
              const approxAllowed =
                !gdata.approximateMatch ||
                expectedRegions.size === 0 ||
                expectedRegions.has(cl.regiao);

              if (cl.dentroComarca && approxAllowed) {
                const roadName = String(gdata.road || streetQuery);
                const matchedEntry = streets.find(
                  (st) =>
                    st.m === (tijucasHint ? 'TIJ' : 'SJP') &&
                    similarityScore(roadName, st.n) >= 0.9
                );
                const matchedGeoms = matchedEntry ? getStreetGeoms(streetsGeom, matchedEntry) : [];
                const fontes: string[] = Array.isArray(gdata.verification?.sourcesFound)
                  ? [...gdata.verification.sourcesFound]
                  : [String(gdata.source || 'Geocodificação ao vivo')];
                if (matchedEntry && !fontes.includes('Base Unificada OSM + GeoSJP')) {
                  fontes.unshift('Base Unificada OSM + GeoSJP');
                }
                const agreedCount = Math.max(
                  Number(gdata.verification?.agreedCount || 1),
                  fontes.length > 1 ? Math.min(fontes.length, 3) : 1
                );

                const approxAlert = gdata.approximateMatch
                  ? `ATENÇÃO — GRAFIA NÃO LITERAL: "${streetQuery}" não consta exatamente com essa grafia no GeoSJP/OSM; a Tripla Verificação localizou correspondência provável em "${roadName}"${
                      gdata.bairro ? ` (${gdata.bairro})` : ''
                    } dentro de ${cl.regiao} — conferir o nome da via no expediente.`
                  : null;

                return {
                  status: 'ok',
                  regiaoFinal: cl.regiao,
                  regioesPossiveis: [cl.regiao],
                  cor: REGION_COLORS[cl.regiao] || '#2563EB',
                  certezaLabel: gdata.approximateMatch
                    ? `Tripla Verificação (Provável) · ${agreedCount} fonte(s)`
                    : `Tripla Verificação · ${agreedCount} fonte(s)`,
                  titulo: cl.regiao,
                  subtitulo: `${roadName}${signals.houseNumber ? `, nº ${signals.houseNumber}` : ''}${
                    gdata.bairro ? ` · ${gdata.bairro}` : ''
                  } · ${cityParam}`,
                  explicacao: [
                    gdata.approximateMatch
                      ? `O logradouro informado ("${streetQuery}") não foi encontrado literalmente nas bases oficiais. Na Tripla Verificação (${fontes.join(' + ')}), o endereço foi associado a "${roadName}" em (${gLat.toFixed(5)}, ${gLon.toFixed(5)}), situado dentro de ${cl.regiao}.`
                      : `Endereço confirmado pela Tripla Verificação (${fontes.join(' + ')}) em (${gLat.toFixed(5)}, ${gLon.toFixed(5)}) dentro de ${cl.regiao}.`,
                  ],
                  alertas: [
                    ...cepAlerts,
                    ...(approxAlert ? [approxAlert] : []),
                    ...cl.alertas,
                    ...buildMissingAlerts(signals, cl.regiao === 'Região 5' || cl.regiao === 'Região 6'),
                  ],
                  lookalikes: [],
                  bestMatch: matchedEntry
                    ? { street: matchedEntry, score: gdata.approximateMatch ? 0.78 : 0.92, geoms: matchedGeoms }
                    : null,
                  signals,
                  cepInfo:
                    cepInfo ||
                    (gdata.bairro || gdata.postcode
                      ? {
                          cep: String(gdata.postcode || ''),
                          logradouro: roadName,
                          bairro: String(gdata.bairro || ''),
                          localidade: cityParam,
                          uf: 'PR',
                        }
                      : null),
                  pin: {
                    lat: gLat,
                    lon: gLon,
                    label: `${roadName}${signals.houseNumber ? `, ${signals.houseNumber}` : ''} (${cl.regiao})`,
                    fonte: fontes.join(' + '),
                    regiao: cl.regiao,
                  },
                  highlightPolylines: matchedGeoms,
                  highlightPolygonName: cl.regiao,
                  verificacao: {
                    fontes,
                    concordantes: agreedCount,
                    detalhe: fontes.join(' · '),
                  },
                };
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // segue para fallback externo PR/SC e bairro/colônia
      }
    }

    // 9B. Fallback externo Nominatim PR/SC (somente se não houver âncora explícita de SJP/Tijucas/bairro local)
    if (!hasInternalComarcaAnchor) {
      const geoExt = await queryExternalNominatim(streetQuery, tijucasHint);
      if (geoExt.found && geoExt.lat !== undefined && geoExt.lon !== undefined) {
        const cl = classifyCoordinates(geoExt.lat, geoExt.lon, geo);
        const cityNorm = norm(geoExt.city || '');
        const insideComarca =
          cl.dentroComarca ||
          cityNorm === 'sao jose dos pinhais' ||
          cityNorm === 'tijucas do sul';

        if (insideComarca && cl.dentroComarca) {
          return {
            status: 'ok',
            regiaoFinal: cl.regiao,
            regioesPossiveis: [cl.regiao],
            cor: REGION_COLORS[cl.regiao] || '#2563EB',
            certezaLabel: 'Geocodificado ao vivo OSM · 88%',
            titulo: cl.regiao,
            subtitulo: `${geoExt.road || streetQuery}${geoExt.suburb ? ` — ${geoExt.suburb}` : ''} (${geoExt.city || 'Comarca'})`,
            explicacao: [
              `Via geocodificada ao vivo via OpenStreetMap em (${geoExt.lat.toFixed(5)}, ${geoExt.lon.toFixed(5)}) e validada dentro de ${cl.regiao}.`,
            ],
            alertas: [...cepAlerts, ...cl.alertas, ...buildMissingAlerts(signals, false)],
            lookalikes: [],
            bestMatch: null,
            signals,
            cepInfo,
            pin: {
              lat: geoExt.lat,
              lon: geoExt.lon,
              label: `${geoExt.road || streetQuery} (${cl.regiao})`,
              fonte: 'Geocodificação OSM + Polígono Oficial',
              regiao: cl.regiao,
            },
            highlightPolygonName: cl.regiao,
          };
        }

        if (geoExt.city && !['sao jose dos pinhais', 'tijucas do sul'].includes(cityNorm)) {
          return {
            status: 'fora_comarca',
            regiaoFinal: 'Fora da Comarca',
            regioesPossiveis: [],
            cor: REGION_COLORS['Fora da Comarca'],
            certezaLabel: `Geocodificado em ${geoExt.city} · 90%`,
            titulo: `Fora da Comarca (${geoExt.city}${geoExt.state ? `/${geoExt.state}` : ''})`,
            subtitulo: `${geoExt.road || streetQuery}${geoExt.suburb ? ` — Bairro ${geoExt.suburb}` : ''}`,
            explicacao: [
              `Geocodificado via OpenStreetMap em ${geoExt.city}/${geoExt.state || 'PR'}, fora da Comarca de SJP e Tijucas do Sul.`,
            ],
            alertas: [
              `FORA DA COMARCA (${geoExt.city}): devolver sem distribuição como "DEV — Mandado Devolvido" (INC nº 25/2020, CNFJ arts. 325–327 e OC nº 17/2026–CGJ).`,
            ],
            lookalikes: [],
            bestMatch: null,
            signals,
            cepInfo,
            pin: {
              lat: geoExt.lat,
              lon: geoExt.lon,
              label: `${geoExt.road || streetQuery} (${geoExt.city})`,
              fonte: 'Geocodificação OSM PR/SC',
              regiao: 'Fora da Comarca',
            },
            certidao: buildDynamicCertidao(
              'fora_comarca',
              query,
              `${geoExt.road || streetQuery} — ${geoExt.city}/${geoExt.state || 'PR'}`
            ),
          };
        }
      }
    }
  }

  // 10. Se ainda não encontrou nenhuma rua -> verifica bairro/loteamento exclusivo de SJP/Tijucas ou devolução (Res. 139/2015 + OC 17/2026)
  if (scored.length === 0) {
    const lotList = signals.loteamentosDetectados || [];
    const distinctLotRegs = Array.from(new Set(lotList.map((l) => l.regiao)));
    if (distinctLotRegs.length === 1 && lotList.length > 0 && (!streetQuery || streetQuery.length < 4 || expandAbbr(streetQuery) === expandAbbr(lotList[0].nome))) {
      const lotObj = (streetAliases?.loteamentos || []).find((l) => l.n === lotList[0].nome);
      const reg = distinctLotRegs[0];
      return {
        status: 'ok',
        regiaoFinal: reg,
        regioesPossiveis: [reg],
        cor: REGION_COLORS[reg] || '#2563EB',
        certezaLabel: 'Loteamento / Planta Oficial · 88%',
        titulo: reg,
        subtitulo: `Loteamento: ${lotList[0].nome}${lotList[0].bairro ? ` (${lotList[0].bairro})` : ''}`,
        explicacao: [
          `Loteamento "${lotList[0].nome}" pertencente exclusivamente à ${reg} na base municipal GeoSJP.`,
        ],
        alertas: [
          ...cepAlerts,
          ...buildMissingAlerts(signals, reg === 'Região 5' || reg === 'Região 6'),
        ],
        lookalikes: [],
        bestMatch: null,
        signals,
        cepInfo,
        pin: lotObj
          ? {
              lat: lotObj.lat,
              lon: lotObj.lon,
              label: lotObj.n,
              fonte: 'Base GeoSJP de Loteamentos',
              regiao: reg,
            }
          : null,
        highlightPolygonName: reg,
      };
    }

    const distinctRegs = Array.from(new Set(signals.bairrosDetectados.map((b) => b.regiao)));
    if (distinctRegs.length === 1 && (signals.bairrosDetectados.length > 0 || !streetQuery)) {
      const bObj = geo.bairros_localidades.find(
        (b) => b.nome === signals.bairrosDetectados[0].nome
      );
      const reg = distinctRegs[0];
      const qTokensLong = canonicalizeNumberedStreetText(streetQuery, true)
        .split(' ')
        .filter((t) => t.length >= 5 && !STOPWORDS.has(t));
      const sameRegionCandidates =
        qTokensLong.length > 0
          ? streets
              .filter(
                (st) =>
                  st.r.includes(reg) &&
                  qTokensLong.some((qt) => norm(st.n).includes(qt))
              )
              .slice(0, 3)
          : [];
      return {
        status: 'ok',
        regiaoFinal: reg,
        regioesPossiveis: [reg],
        cor: REGION_COLORS[reg] || '#2563EB',
        certezaLabel: 'Bairro / Colônia Exclusiva · 84%',
        titulo: reg,
        subtitulo: `Bairro/Localidade: ${signals.bairrosDetectados[0].nome}`,
        explicacao: [
          `O logradouro literal ("${streetQuery || query}") não foi encontrado na base viária, porém "${signals.bairrosDetectados[0].nome}" pertence exclusivamente à ${reg}.`,
          ...(sameRegionCandidates.length > 0
            ? [
                `Vias cadastradas na mesma ${reg} com termo semelhante: ${sameRegionCandidates
                  .map((c) => `${c.n}${c.b ? ` (${c.b})` : ''}`)
                  .join('; ')}.`,
              ]
            : []),
        ],
        alertas: [
          ...cepAlerts,
          'Logradouro não encontrado literalmente — triagem assegurada pela localidade/colônia exclusiva; confira grafia no expediente.',
          ...buildMissingAlerts(signals, reg === 'Região 5' || reg === 'Região 6'),
        ],
        lookalikes: sameRegionCandidates.map((c) => ({
          street: c,
          score: similarityScore(streetQuery, c.n),
          geoms: getStreetGeoms(streetsGeom, c),
        })),
        bestMatch: null,
        signals,
        cepInfo,
        pin: bObj
          ? {
              lat: bObj.lat,
              lon: bObj.lon,
              label: bObj.nome,
              fonte: 'Índice de Bairros e Localidades',
              regiao: reg,
            }
          : null,
        highlightPolygonName: reg,
      };
    }

    return {
      status: 'complementacao',
      regiaoFinal: 'Complementação Necessária',
      regioesPossiveis: [],
      cor: REGION_COLORS['Complementação Necessária'],
      certezaLabel: 'Endereço não localizado / Incompleto',
      titulo: 'Complementação / Endereço não localizado',
      subtitulo: `Não localizado em SJP/Tijucas (${streets.length.toLocaleString('pt-BR')} vias) nem em Curitiba/RMC (15.663 vias): "${streetQuery || query}"`,
      explicacao: [
        'O logradouro não correspondeu com segurança às bases de São José dos Pinhais, Tijucas do Sul ou municípios vizinhos da RMC.',
      ],
      alertas: [
        ...cepAlerts,
        'Confira grafia, número, bairro e CEP — persistindo a insuficiência ou inexistência do endereço, devolver sem distribuição ("DEV", Res. nº 139/2015–OE, art. 15; CNFJ arts. 289 e 325; OC nº 17/2026–CGJ).',
      ],
      lookalikes: [],
      bestMatch: null,
      signals,
      cepInfo,
      certidao: buildDynamicCertidao(
        'complementacao',
        query,
        'não foi localizado nas bases oficiais da Comarca nem dos municípios vizinhos da RMC'
      ),
    };
  }

function getStreetGeoms(
  streetsGeom: StreetsGeomMap | null,
  street: StreetEntry
): Array<{ r: string; p: [number, number][] }> {
  if (!streetsGeom) return [];
  return (
    (street.gid ? streetsGeom[street.gid] : undefined) ||
    streetsGeom[`${street.m}|${street.n}`] ||
    streetsGeom[street.n] ||
    []
  );
}

function distPointToSegmentMeters(
  lat: number,
  lon: number,
  a: [number, number],
  b: [number, number]
): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const kx = 111320 * cosLat;
  const ky = 111320;
  const ax = (a[1] - lon) * kx;
  const ay = (a[0] - lat) * ky;
  const bx = (b[1] - lon) * kx;
  const by = (b[0] - lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return Math.hypot(ax, ay);
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function distPointToPolylinesMeters(
  lat: number,
  lon: number,
  geoms: Array<{ r: string; p: [number, number][] }>
): number {
  let best = Infinity;
  for (const seg of geoms) {
    const pts = seg.p;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = distPointToSegmentMeters(lat, lon, pts[i], pts[i + 1]);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Returns the exact 50% arc-length midpoint directly along the street centerline geometry
 * so street-only / CEP searches always stand centered on the road rather than off-road centroids.
 */
function getCenterPointOnPolylines(
  geoms: Array<{ r: string; p: [number, number][] }>,
  preferRegion?: string
): { lat: number; lon: number } | null {
  if (!geoms || geoms.length === 0) return null;
  const filtered =
    preferRegion ? geoms.filter((g) => g.r === preferRegion && g.p.length > 0) : [];
  const pool = filtered.length > 0 ? filtered : geoms.filter((g) => g.p.length > 0);
  if (pool.length === 0) return null;

  // Order segments along the street's principal geographical axis for deterministic midpoint traversal
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const seg of pool) {
    for (const [lat, lon] of seg.p) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  const sortByLat = maxLat - minLat >= maxLon - minLon;
  const ordered = [...pool].sort((a, b) => {
    const amid = a.p[Math.floor(a.p.length / 2)];
    const bmid = b.p[Math.floor(b.p.length / 2)];
    return sortByLat ? amid[0] - bmid[0] : amid[1] - bmid[1];
  });

  const subSegs: Array<{ a: [number, number]; b: [number, number]; len: number }> = [];
  let totalLen = 0;
  for (const seg of ordered) {
    const pts = seg.p;
    for (let i = 0; i + 1 < pts.length; i++) {
      const len = haversineMeters(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (len > 0) {
        subSegs.push({ a: pts[i], b: pts[i + 1], len });
        totalLen += len;
      }
    }
  }

  if (subSegs.length === 0 || totalLen <= 0) {
    const midSeg = ordered[Math.floor(ordered.length / 2)];
    const pt = midSeg.p[Math.floor(midSeg.p.length / 2)];
    return { lat: pt[0], lon: pt[1] };
  }

  const target = totalLen * 0.5;
  let acc = 0;
  for (const ss of subSegs) {
    if (acc + ss.len >= target) {
      const t = (target - acc) / ss.len;
      return {
        lat: ss.a[0] + (ss.b[0] - ss.a[0]) * t,
        lon: ss.a[1] + (ss.b[1] - ss.a[1]) * t,
      };
    }
    acc += ss.len;
  }

  const last = subSegs[subSegs.length - 1].b;
  return { lat: last[0], lon: last[1] };
}

  // 11. Rua(s) localizada(s) em SJP ou Tijucas do Sul
  let best = scored[0];
  let s = best.street;
  let bestGeoms = getStreetGeoms(streetsGeom, s);

  const lookalikes: StreetMatchCandidate[] = [];
  const seenLook = new Set<string>();
  seenLook.add(s.gid || `${s.m}|${s.n}`);

  const bestCore = streetIdx.coreOf.get(s) || '';
  for (const cand of scored.slice(1, 12)) {
    const ck = cand.street.gid || `${cand.street.m}|${cand.street.n}`;
    if (seenLook.has(ck)) continue;
    const cCore = streetIdx.coreOf.get(cand.street) || '';
    const isHomonymSibling =
      canonicalizeNumberedStreetText(cand.street.n, true) ===
        canonicalizeNumberedStreetText(s.n, true) ||
      Boolean(cand.aliasMatch && cand.score >= 0.86);
    if (
      (cand.street.n !== s.n || cand.street.gid !== s.gid) &&
      cand.score >= 0.75 &&
      (isHomonymSibling || cCore === bestCore || seqRatio(bestCore, cCore) >= 0.85)
    ) {
      seenLook.add(ck);
      lookalikes.push({
        street: cand.street,
        score: cand.score,
        geoms: getStreetGeoms(streetsGeom, cand.street),
      });
    }
  }
  // Garante captura instantânea O(1) de homônimos com prefixo/título diferente (ex.: Av. João Nester vs Rua Pref. João Nester)
  if (bestCore && bestCore.length >= 4) {
    const coreMatches = streetIdx.byCoreToken.get(bestCore) || [];
    for (const candStreet of coreMatches) {
      if (candStreet.n === s.n && candStreet.gid === s.gid) continue;
      const key = candStreet.gid || `${candStreet.m}|${candStreet.n}`;
      if (seenLook.has(key)) continue;
      seenLook.add(key);
      lookalikes.push({
        street: candStreet,
        score: similarityScore(s.n, candStreet.n),
        geoms: getStreetGeoms(streetsGeom, candStreet),
      });
    }
  }

  // Guarda rigorosa contra conflito total de região/bairro (ex.: "Rua Dois, Afonso Pena" onde nenhuma via correspondente pertence à Região 3)
  const hasNonConflictingCandidate = scored.some((c) => !c.regionConflict);
  if (!hasNonConflictingCandidate && expectedRegions.size > 0) {
    const expectedList = Array.from(expectedRegions);
    const bairroReq =
      signals.bairrosDetectados[0]?.nome ||
      signals.loteamentosDetectados?.[0]?.nome ||
      cepInfo?.bairro ||
      '';

    // Verifica se o geocoder ao vivo localiza exatamente na região/bairro informado (ex.: via recém-denominada no GeoSJP/Google Maps)
    if (typeof window !== 'undefined' && bairroReq) {
      try {
        const cityParam = expectedList.includes('Região 7') ? 'Tijucas do Sul' : 'São José dos Pinhais';
        const qCheck = `${streetQuery}${signals.houseNumber ? `, ${signals.houseNumber}` : ''}, ${bairroReq}`;
        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), 2200);
        try {
          const r = await fetch(
            `/api/geocode?q=${encodeURIComponent(qCheck)}&city=${encodeURIComponent(cityParam)}&street=${encodeURIComponent(streetQuery)}&bairro=${encodeURIComponent(bairroReq)}`,
            { signal: ctrl.signal }
          );
          if (r.ok) {
            const gd = await r.json();
            if (gd?.found && !gd.bairroFallback && !gd.approximateMatch && gd.lat && gd.lon) {
              const gLat = parseFloat(gd.lat);
              const gLon = parseFloat(gd.lon);
              const cl = classifyCoordinates(gLat, gLon, geo);
              if (cl.dentroComarca && expectedRegions.has(cl.regiao)) {
                const roadName = String(gd.road || streetQuery);
                const fontes: string[] = Array.isArray(gd.verification?.sourcesFound)
                  ? [...gd.verification.sourcesFound]
                  : [String(gd.source || 'Geocodificação ao vivo')];
                return {
                  status: 'ok',
                  regiaoFinal: cl.regiao,
                  regioesPossiveis: [cl.regiao],
                  cor: REGION_COLORS[cl.regiao] || '#2563EB',
                  certezaLabel: `Tripla Verificação · ${fontes.length} fonte(s)`,
                  titulo: cl.regiao,
                  subtitulo: `${roadName}${signals.houseNumber ? `, nº ${signals.houseNumber}` : ''} · ${gd.bairro || bairroReq} · ${cityParam}`,
                  explicacao: [
                    `Localizado via Tripla Verificação (${fontes.join(' + ')}) em (${gLat.toFixed(5)}, ${gLon.toFixed(5)}) no bairro/região informado (${cl.regiao}).`,
                  ],
                  alertas: [...cepAlerts, ...cl.alertas, ...buildMissingAlerts(signals, false)],
                  lookalikes: scored.slice(0, 6).map((c) => ({
                    street: c.street,
                    score: c.score,
                    geoms: getStreetGeoms(streetsGeom, c.street),
                  })),
                  bestMatch: null,
                  signals,
                  cepInfo,
                  reverseAddress: {
                    road: roadName,
                    houseNumber: signals.houseNumber || '',
                    suburb: String(gd.bairro || bairroReq),
                    city: cityParam,
                    state: 'Paraná',
                    uf: 'PR',
                    postcode: String(gd.postcode || ''),
                  },
                  pin: {
                    lat: gLat,
                    lon: gLon,
                    label: `${roadName} (${cl.regiao})`,
                    fonte: fontes.join(' + '),
                    regiao: cl.regiao,
                  },
                  highlightPolygonName: cl.regiao,
                };
              }
            }
          }
        } finally {
          clearTimeout(tId);
        }
      } catch {
        // segue para alerta claro de divergência
      }
    }

    const candDescs = scored.slice(0, 5).map((c) => {
      const local = [c.street.b, c.street.lot].filter(Boolean).join(' / ');
      return `${c.street.n}${local ? ` (${local})` : ''} -> ${c.street.r.join(', ')}`;
    });
    return {
      status: 'complementacao',
      regiaoFinal: 'Complementação Necessária',
      regioesPossiveis: expectedList,
      cor: REGION_COLORS['Complementação Necessária'],
      certezaLabel: 'Divergência Bairro × Logradouro',
      titulo: `Divergência — "${bairroReq || expectedList.join('/')}" (${expectedList.join(', ')})`,
      subtitulo: `"${streetQuery}" não consta em ${bairroReq || expectedList.join('/')} — só há registros em outros bairros`,
      explicacao: [
        `O bairro/localidade informado (${bairroReq || expectedList.join('/')}) pertence à ${expectedList.join(', ')}, porém os logradouros semelhantes encontrados pertencem a outras regiões:`,
        ...candDescs,
      ],
      alertas: [
        ...cepAlerts,
        `DIVERGÊNCIA DE BAIRRO/REGIÃO: "${streetQuery}" não está cadastrado em ${bairroReq || expectedList.join('/')}. Confira o nome exato da via, loteamento ou CEP antes de distribuir (Res. nº 139/2015–OE, art. 15; OC nº 17/2026–CGJ).`,
      ],
      lookalikes: scored.slice(0, 6).map((c) => ({
        street: c.street,
        score: c.score,
        geoms: getStreetGeoms(streetsGeom, c.street),
      })),
      bestMatch: null,
      signals,
      cepInfo,
      certidao: buildDynamicCertidao(
        'complementacao',
        query,
        `apresenta divergência entre o logradouro ("${streetQuery}") e o bairro informado ("${bairroReq || expectedList.join('/')}"), sem localização inequívoca nas bases oficiais`
      ),
    };
  }

  // Verifica se há múltiplas vias homônimas em regiões distintas empatadas (ex.: "Rua 2" sem informar bairro/loteamento)
  const tiedHomonyms = scored.filter(
    (c) =>
      !c.regionConflict &&
      c.score >= 0.88 &&
      Math.abs(c.rankScore - best.rankScore) <= 0.045
  );
  const tiedDistinctRegions = Array.from(new Set(tiedHomonyms.map((c) => c.street.rp)));
  let isAmbiguousMultiClusterHomonym =
    tiedDistinctRegions.length > 1 && !best.matchedContext && !hasExplicitLocContext && !tijucasHint;

  // Se houver homônimo em múltiplas regiões/municípios, MAS o usuário informou número predial (ex.: "Rua XV de Novembro, 1800" ou "Rua Joinville, 500"), desambigua via geocoder + GeoSJP Predial!
  let preResolvedHomonymGeo: {
    lat: number;
    lon: number;
    bairro: string;
    postcode: string;
    regiao: string;
    sources: string[];
  } | null = null;
  if (isAmbiguousMultiClusterHomonym && signals.houseNumber && typeof window !== 'undefined') {
    const citiesToProbe = Array.from(
      new Set(
        tiedHomonyms
          .map((c) => (c.street.m === 'TIJ' ? 'Tijucas do Sul' : 'São José dos Pinhais'))
          .sort((a) => (a === 'São José dos Pinhais' ? -1 : 1))
      )
    );
    const matchesByCity: Array<{
      cand: RankedCandidate;
      lat: number;
      lon: number;
      reg: string;
      bairro: string;
      postcode: string;
      hasExactNumber: boolean;
      sources: string[];
    }> = [];
    await Promise.all(
      citiesToProbe.map(async (cityName) => {
        const munCode = cityName === 'Tijucas do Sul' ? 'TIJ' : 'SJP';
        const candInMun = tiedHomonyms.find((c) => c.street.m === munCode);
        if (!candInMun) return;
        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), 2200);
        try {
          const r = await fetch(
            `/api/geocode?q=${encodeURIComponent(`${candInMun.street.n}, ${signals.houseNumber}`)}&city=${encodeURIComponent(cityName)}&street=${encodeURIComponent(candInMun.street.n)}`,
            { signal: ctrl.signal }
          );
          if (!r.ok) return;
          const gd = await r.json();
          if (gd?.found && !gd.bairroFallback && !gd.approximateMatch && gd.lat && gd.lon) {
            const gLat = parseFloat(gd.lat);
            const gLon = parseFloat(gd.lon);
            const geoms = getStreetGeoms(streetsGeom, candInMun.street);
            const nearTol = candInMun.street.len < 200 ? 600 : 280;
            const nearGeom =
              geoms.length > 0
                ? distPointToPolylinesMeters(gLat, gLon, geoms) <= nearTol
                : haversineMeters(gLat, gLon, candInMun.street.lat, candInMun.street.lon) <= 3000;
            if (nearGeom) {
              const cl = classifyCoordinates(gLat, gLon, geo);
              if (cl.dentroComarca) {
                matchesByCity.push({
                  cand: candInMun,
                  lat: gLat,
                  lon: gLon,
                  reg: cl.regiao,
                  bairro: String(gd.bairro || candInMun.street.b || ''),
                  postcode: String(gd.postcode || candInMun.street.cep || ''),
                  hasExactNumber: Boolean(gd.hasExactNumber || gd.source === 'geosjp_predial'),
                  sources: Array.isArray(gd.verification?.sourcesFound)
                    ? gd.verification.sourcesFound.map(String)
                    : [String(gd.source || 'Geocodificação ao vivo')],
                });
              }
            }
          }
        } catch {
          // ignore
        } finally {
          clearTimeout(tId);
        }
      })
    );

    const exactNumberMatches = matchesByCity.filter((m) => m.hasExactNumber);
    const chosenMatch =
      exactNumberMatches.length === 1
        ? exactNumberMatches[0]
        : matchesByCity.length === 1
        ? matchesByCity[0]
        : null;

    if (chosenMatch) {
      const m = chosenMatch;
      best = m.cand;
      s = best.street;
      bestGeoms = getStreetGeoms(streetsGeom, s);
      preResolvedHomonymGeo = {
        lat: m.lat,
        lon: m.lon,
        bairro: m.bairro,
        postcode: m.postcode,
        regiao: m.reg,
        sources: m.sources,
      };
      isAmbiguousMultiClusterHomonym = false;
    }
  }

  if (isAmbiguousMultiClusterHomonym) {
    const descList = tiedHomonyms.slice(0, 6).map((c) => {
      const local = [c.aliasMatch?.b || c.street.b, c.aliasMatch?.lot || c.street.lot]
        .filter(Boolean)
        .join(' / ');
      const aliasTag = c.aliasMatch ? ` [atual: ${c.street.n}]` : '';
      return `${c.aliasMatch ? c.aliasMatch.a : c.street.n}${aliasTag}${local ? ` (${local})` : ''} -> ${c.street.rp}`;
    });
    return {
      status: 'complementacao',
      regiaoFinal: 'Complementação Necessária',
      regioesPossiveis: tiedDistinctRegions,
      cor: REGION_COLORS['Complementação Necessária'],
      certezaLabel: `Via Homônima (${tiedHomonyms.length} localidades)`,
      titulo: `Complementação — ${tiedDistinctRegions.join(' / ')}`,
      subtitulo: `"${streetQuery}" existe em ${tiedDistinctRegions.length} regiões distintas — selecione ou informe bairro/loteamento/CEP`,
      explicacao: [
        `Foram encontradas múltiplas vias distintas com a denominação "${streetQuery}" em bairros e regiões diferentes da Comarca:`,
        ...descList,
      ],
      alertas: [
        ...cepAlerts,
        `FALTA DE COMPLEMENTO — HOMÔNIMO EM MÚLTIPLAS REGIÕES: informe bairro, loteamento ou CEP (ex.: ${descList.slice(0, 3).join(' | ')}).`,
      ],
      lookalikes: tiedHomonyms.slice(0, 8).map((c) => ({
        street: c.street,
        score: c.score,
        geoms: getStreetGeoms(streetsGeom, c.street),
      })),
      bestMatch: null,
      signals,
      cepInfo,
      certidao: buildDynamicCertidao(
        'complementacao',
        query,
        `refere-se a denominação comum a múltiplas vias ("${streetQuery}") em bairros/regiões distintos (${tiedDistinctRegions.join(', ')}), sem indicação de bairro, loteamento ou CEP`
      ),
    };
  }

  const allSameName = scored.filter(
    (c) => !c.regionConflict && norm(c.street.n) === norm(s.n) && c.score >= 0.9
  );
  const allHomonymRegs = Array.from(new Set(allSameName.flatMap((c) => c.street.r)));

  const alerts: string[] = [...cepAlerts];
  const explicacao: string[] = [];

  if (best.aliasMatch) {
    const am = best.aliasMatch;
    explicacao.push(
      `Denominação anterior/alternativa reconhecida: "${am.a}" -> logradouro oficial atual "${s.n}"${am.note ? ` (${am.note})` : ''}.`
    );
    alerts.push(`Nome oficial atual: ${s.n} (${am.note || `referência: ${am.a}`}).`);
    if (extMatchForCheck && !tijucasHint) {
      alerts.push(
        `Nota: existe também via homônima em ${extMatchForCheck.cities} (${extMatchForCheck.matchedName}) — confirme se o mandado é realmente para SJP.`
      );
    }
  } else if (best.score < 0.96) {
    alerts.push(
      `Correção ortográfica/fonética aplicada (${Math.round(best.score * 100)}% de similaridade com "${s.n}").`
    );
  }
  if (s.al) alerts.push(s.al);

  if (
    !best.matchedContext &&
    (ctxBairrosNorm.length > 0 || ctxLotsNorm.length > 0) &&
    (s.b || s.lot) &&
    !s.mr
  ) {
    const cadastroLocal = [s.b, s.lot].filter(Boolean).join(' / ');
    alerts.push(
      `Atenção ao bairro/loteamento informado: nos registros oficiais, "${s.n}" localiza-se em ${cadastroLocal}.`
    );
  }

  if (allSameName.length > 1 && allHomonymRegs.length > 1 && !tijucasHint && !best.matchedContext) {
    alerts.push(
      `ATENÇÃO — HOMÔNIMO EM MUNICÍPIOS DISTINTOS: "${s.n}" existe em SJP e em Tijucas do Sul! Informe o município, CEP ou bairro.`
    );
  }

  if (lookalikes.length > 0 && !s.mr && !best.matchedContext) {
    const diffs = lookalikes
      .slice(0, 3)
      .map(
        (lk) =>
          `${lk.street.n}${lk.street.b ? ` (${lk.street.b})` : ''} (${lk.street.m === 'TIJ' ? 'Tijucas' : 'SJP'} -> ${lk.street.r.join(', ')})`
      )
      .join(' | ');
    alerts.push(`ATENÇÃO — TÍTULO/PREFIXO SEMELHANTE EM OUTRA REGIÃO: confira se não é ${diffs}.`);
  }

  let pinLat = s.lat;
  let pinLon = s.lon;
  let resolvedReg = s.rp;
  let status: AnalysisResult['status'] = 'ok';
  let fonte =
    s.h === 'correios'
      ? 'Base Correios Tijucas do Sul'
      : s.h === 'geosjp'
      ? 'Base GeoSJP Municipal'
      : s.h === 'gmap_verified'
      ? 'Base Verificada SJP'
      : 'Base Unificada OSM + GeoSJP';
  let geocodedMeta: { bairro: string; postcode: string } | null = null;
  let matchedSubBairroName: string | null = null;
  let lockedSubBairroRegion: string | null = null;
  const verifiedSources = new Set<string>([fonte]);

  // Para vias multirregião e rodovias com mapeamento por bairro oficial (ex.: Rodovia BR-376, Cruzeiro -> Região 4)
  if (s.mr && s.subBairros && ctxBairrosNorm.length > 0) {
    for (const [sbName, sbInfo] of Object.entries(s.subBairros)) {
      const sbNorm = expandAbbr(sbName);
      if (ctxBairrosNorm.some((bn) => sbNorm.includes(bn) || bn.includes(sbNorm))) {
        resolvedReg = sbInfo.r;
        pinLat = sbInfo.lat;
        pinLon = sbInfo.lon;
        matchedSubBairroName = sbName;
        lockedSubBairroRegion = sbInfo.r;
        fonte = `Base Unificada + Polígono Oficial (${sbName})`;
        explicacao.push(
          `Via multirregião (${s.r.join(', ')}) direcionada para ${sbInfo.r} pelo trecho oficial no bairro ${sbName}.`
        );
        break;
      }
    }
  }

  // Tripla Verificação ao vivo (Google Maps + GeoSJP Número Predial/1897 + OSM) para nº predial ou confirmação multirregião
  if (preResolvedHomonymGeo) {
    pinLat = preResolvedHomonymGeo.lat;
    pinLon = preResolvedHomonymGeo.lon;
    resolvedReg = preResolvedHomonymGeo.regiao;
    for (const sf of preResolvedHomonymGeo.sources) verifiedSources.add(sf);
    fonte = `Tripla Verificação nº ${signals.houseNumber} (${preResolvedHomonymGeo.sources[0] || 'GeoSJP/Maps'})`;
    geocodedMeta = {
      bairro: preResolvedHomonymGeo.bairro,
      postcode: preResolvedHomonymGeo.postcode,
    };
    explicacao.push(
      `Número predial ${signals.houseNumber} localizado em ${s.m === 'TIJ' ? 'Tijucas do Sul' : 'São José dos Pinhais'} (${preResolvedHomonymGeo.bairro || resolvedReg}) -> ${resolvedReg}.`
    );
  } else if (
    (signals.houseNumber || (s.mr && !lockedSubBairroRegion)) &&
    typeof window !== 'undefined'
  ) {
    try {
      const cityParam = s.m === 'TIJ' ? 'Tijucas do Sul' : 'São José dos Pinhais';
      const bairroHintForGeocode = matchedSubBairroName || signals.bairrosDetectados[0]?.nome || s.b || '';
      const qGeocode = signals.houseNumber
        ? `${s.n}, ${signals.houseNumber}${bairroHintForGeocode ? `, ${bairroHintForGeocode}` : ''}`
        : `${s.n}${bairroHintForGeocode ? `, ${bairroHintForGeocode}` : ''}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2200);
      try {
        const res = await fetch(
          `/api/geocode?q=${encodeURIComponent(qGeocode)}&city=${encodeURIComponent(
            cityParam
          )}&street=${encodeURIComponent(s.n)}&bairro=${encodeURIComponent(bairroHintForGeocode)}`,
          { signal: ctrl.signal }
        );
        if (res.ok) {
          const gdata = await res.json();
          if (gdata.found && gdata.lat && gdata.lon) {
            if (Array.isArray(gdata.verification?.sourcesFound)) {
              for (const sf of gdata.verification.sourcesFound) {
                verifiedSources.add(String(sf));
              }
            }
            const gLat = parseFloat(gdata.lat);
            const gLon = parseFloat(gdata.lon);
            const nearTol = s.len < 200 ? 600 : 280;
            const nearStreetGeom =
              bestGeoms.length > 0
                ? distPointToPolylinesMeters(gLat, gLon, bestGeoms) <= nearTol
                : haversineMeters(gLat, gLon, s.lat, s.lon) <= Math.max(s.len * 1.35 + 1500, 3000);

            if (nearStreetGeom && !gdata.approximateMatch && !gdata.bairroFallback) {
              const cl = classifyCoordinates(gLat, gLon, geo);
              if (s.mr) {
                const regionOk =
                  cl.dentroComarca &&
                  s.r.includes(cl.regiao) &&
                  (!lockedSubBairroRegion || cl.regiao === lockedSubBairroRegion);
                if (regionOk) {
                  pinLat = gLat;
                  pinLon = gLon;
                  resolvedReg = cl.regiao;
                  fonte = signals.houseNumber
                    ? `Tripla Verificação nº ${signals.houseNumber} + Polígono KML`
                    : `Tripla Verificação + Polígono KML`;
                  geocodedMeta = {
                    bairro: String(gdata.bairro || matchedSubBairroName || s.b || ''),
                    postcode: String(gdata.postcode || s.cep || ''),
                  };
                  if (!matchedSubBairroName) {
                    explicacao.push(
                      `Via multirregião (${s.r.join(', ')}) desambiguada com precisão em (${gLat.toFixed(
                        5
                      )}, ${gLon.toFixed(5)}) -> ${cl.regiao}.`
                    );
                  }
                }
              } else {
                pinLat = gLat;
                pinLon = gLon;
                if (signals.houseNumber) {
                  fonte = `Tripla Verificação nº ${signals.houseNumber} (${
                    gdata.source === 'google_maps'
                      ? 'Google Maps'
                      : gdata.source === 'geosjp_predial'
                      ? 'GeoSJP Predial'
                      : 'OSM'
                  })`;
                }
                geocodedMeta = {
                  bairro: String(gdata.bairro || s.b || ''),
                  postcode: String(gdata.postcode || s.cep || ''),
                };
              }
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // mantém centroide/trecho da via se geocodificador falhar
    }
  }

  if (s.mr && !lockedSubBairroRegion && !fonte.startsWith('Tripla Verificação') && !fonte.startsWith('Geocodificação')) {
    const bairroMatch =
      signals.bairrosDetectados.find((b) => s.r.includes(b.regiao))?.regiao ||
      signals.loteamentosDetectados?.find((l) => s.r.includes(l.regiao))?.regiao ||
      (cepInfo?.bairro
        ? geo.bairros_localidades.find(
            (b) => norm(b.nome) === norm(cepInfo!.bairro) && s.r.includes(b.regiao)
          )?.regiao
        : undefined);

    if (bairroMatch) {
      resolvedReg = bairroMatch;
      fonte = 'Via Multirregião desambiguada por Bairro/Loteamento';
      explicacao.push(
        `Via multirregião (${s.r.join(', ')}) direcionada para ${resolvedReg} pelo bairro/loteamento informado.`
      );
    } else {
      status = 'complementacao';
      alerts.push(
        `FALTA DE COMPLEMENTO — VIA MULTIRREGIÃO: "${s.n}" atravessa ${s.r.join(', ')}. Sem número predial ou bairro compatível não é possível definir com segurança qual oficial recebe o mandado (Res. nº 139/2015–OE, art. 15; OC nº 17/2026–CGJ — DEV).`
      );
    }
  } else if (!s.mr) {
    explicacao.push(
      `${s.n} pertence integralmente à ${resolvedReg} (${s.m === 'TIJ' ? 'Tijucas do Sul' : 'São José dos Pinhais'}).`
    );
  }

  // Regra Butiazinho (CEP 83050-190..216 ou bairro mencionado -> Região 2, não 3!)
  if (
    s.m === 'SJP' &&
    resolvedReg === 'Região 3' &&
    s.r.includes('Região 2') &&
    (norm(workingAddress).includes('butiazinho') ||
      norm(workingAddress).includes('sao judas tadeu') ||
      cepInfo?.isButiazinhoTrap)
  ) {
    resolvedReg = 'Região 2';
    status = 'ok';
    explicacao.push(
      'Regra Butiazinho aplicada: embora conste "Parque da Fonte" nos Correios, o endereço situa-se ao norte da BR-277 na Região 2 (São Judas Tadeu).'
    );
  }

  alerts.push(...buildMissingAlerts(signals, resolvedReg === 'Região 5' || resolvedReg === 'Região 6'));

  // Para buscas só de rua ou CEP sem número predial geocodificado nem sub-bairro específico, centraliza sobre o eixo da via na região
  if (!fonte.includes('Tripla Verificação') && !fonte.includes('Geocodificação') && !matchedSubBairroName && bestGeoms.length > 0) {
    const roadMid = getCenterPointOnPolylines(
      bestGeoms,
      status === 'ok' ? resolvedReg : undefined
    );
    if (roadMid) {
      pinLat = roadMid.lat;
      pinLon = roadMid.lon;
    }
  }

  const munName = s.m === 'TIJ' ? 'Tijucas do Sul' : 'São José dos Pinhais';
  const isFinalIncomplete = status === 'complementacao';
  const effBairro = matchedSubBairroName || geocodedMeta?.bairro || s.b || '';
  const effLot = s.len >= 5000 || matchedSubBairroName ? '' : s.lot || '';
  const effCep = matchedSubBairroName ? cepInfo?.cep || '' : geocodedMeta?.postcode || s.cep || '';

  if (!cepInfo && (effBairro || effCep || effLot)) {
    cepInfo = {
      cep: effCep,
      logradouro: s.n,
      bairro: effLot && effBairro ? `${effBairro} (${effLot})` : effBairro || effLot || '',
      localidade: munName,
      uf: 'PR',
    };
  }

  const reverseAddress =
    geocodedMeta && (geocodedMeta.bairro || geocodedMeta.postcode)
      ? {
          road: s.n,
          houseNumber: signals.houseNumber || '',
          suburb: effBairro || geocodedMeta.bairro,
          city: munName,
          state: 'Paraná',
          uf: 'PR',
          postcode: effCep || geocodedMeta.postcode,
        }
      : undefined;

  const fontesList = Array.from(verifiedSources);
  const verificacao =
    fontesList.length > 0
      ? {
          fontes: fontesList,
          concordantes: Math.min(fontesList.length, 3),
          detalhe: fontesList.join(' · '),
        }
      : null;

  return {
    status,
    regiaoFinal: isFinalIncomplete ? 'Complementação Necessária' : resolvedReg,
    regioesPossiveis: s.r,
    cor: isFinalIncomplete
      ? REGION_COLORS['Complementação Necessária']
      : REGION_COLORS[resolvedReg] || '#2563EB',
    certezaLabel: isFinalIncomplete
      ? 'Falta Complemento (Via Multirregião)'
      : `${fonte} · ${Math.round(best.score * 100)}%`,
    titulo: isFinalIncomplete
      ? `Complementação — ${s.r.join(' / ')}`
      : `${resolvedReg}${s.sr6.length > 0 && resolvedReg === 'Região 6' ? ` (${s.sr6.join('/')})` : ''}`,
    subtitulo: `${s.n}${signals.houseNumber ? `, nº ${signals.houseNumber}` : ''}${effBairro ? ` · ${effBairro}` : ''}${effLot ? ` (${effLot})` : ''}${effCep ? ` · CEP ${effCep}` : ''} · ${munName} · ${(s.len / 1000).toFixed(2)} km`,
    explicacao,
    alertas: alerts,
    lookalikes,
    bestMatch: { street: s, score: best.score, geoms: bestGeoms },
    signals,
    cepInfo,
    reverseAddress,
    verificacao,
    pin: {
      lat: pinLat,
      lon: pinLon,
      label: s.n,
      fonte,
      regiao: resolvedReg,
    },
    highlightPolylines: bestGeoms,
    highlightPolygonName: isFinalIncomplete ? null : resolvedReg,
    certidao: isFinalIncomplete
      ? buildDynamicCertidao(
          'complementacao',
          query,
          `refere-se à via "${s.n}", a qual atravessa múltiplas regiões (${s.r.join(', ')}), sem indicação suficiente de número predial, bairro ou ponto de referência`
        )
      : null,
  };
}
