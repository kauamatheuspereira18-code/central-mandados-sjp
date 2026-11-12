import { parseCoordinates } from '@/lib/geoMath';
import type { LoteamentoEntry, ParsedMandadoSignals } from '@/types/mandados';

export const EXTERNAL_CITIES = [
  'curitiba',
  'pinhais',
  'fazenda rio grande',
  'piraquara',
  'mandirituba',
  'quitandinha',
  'araucaria',
  'colombo',
  'campina grande do sul',
  'quatro barras',
  'almirante tamandare',
  'campo largo',
  'balsa nova',
  'agudos do sul',
  'pien',
  'rio branco do sul',
  'itaperucu',
  'bocaiuva do sul',
  'tunas do parana',
  'cerro azul',
  'adrianopolis',
  'contenda',
  'lapa',
  'campo magro',
  'doutor ulisses',
  'morretes',
  'antonina',
  'paranagua',
  'guaratuba',
  'matinhos',
  'pontal do parana',
  'londrina',
  'maringa',
  'ponta grossa',
  'cascavel',
  'foz do iguacu',
  'guarapuava',
  'toledo',
  'umuarama',
  'apucarana',
  'arapongas',
  'campo mourao',
  'francisco beltrao',
  'pato branco',
  'paranavai',
  'castro',
  'palmeira',
  'irati',
  'sao mateus do sul',
  'telemaco borba',
  'uniao da vitoria',
  'garuva',
  'joinville',
  'florianopolis',
  'itajai',
  'balneario camboriu',
  'blumenau',
  'sao bento do sul',
  'jaragua do sul',
  'itapoa',
  'barra velha',
  'navegantes',
  'chapeco',
  'criciuma',
  'lages',
  'palhoca',
  'sao paulo',
  'campinas',
  'santos',
  'sorocaba',
  'ribeirao preto',
  'rio de janeiro',
  'belo horizonte',
  'porto alegre',
  'caxias do sul',
  'brasilia',
  'goiania',
  'tijucas', // Tijucas (SC) vs Tijucas do Sul (PR)
];

export function stripAccents(s: string): string {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function norm(s: string): string {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function expandAbbr(s: string): string {
  const mapping: Record<string, string> = {
    r: 'rua',
    av: 'avenida',
    al: 'alameda',
    tv: 'travessa',
    trav: 'travessa',
    estr: 'estrada',
    est: 'estrada',
    rod: 'rodovia',
    dr: 'doutor',
    dra: 'doutora',
    prof: 'professor',
    profa: 'professora',
    ver: 'vereador',
    pref: 'prefeito',
    sen: 'senador',
    ten: 'tenente',
    mal: 'marechal',
    cel: 'coronel',
    dep: 'deputado',
    pe: 'padre',
    sto: 'santo',
    sta: 'santa',
    s: 'sao',
    ns: 'nossa senhora',
    sra: 'senhora',
    jd: 'jardim',
    vl: 'vila',
    pq: 'parque',
    col: 'colonia',
    com: 'comandante',
    gov: 'governador',
    pres: 'presidente',
    eng: 'engenheiro',
    des: 'desembargador',
    exp: 'expedicionario',
    nr: 'numero',
    num: 'numero',
    xv: 'quinze',
  };
  const NOSSA_FOLLOWERS = new Set([
    's',
    'sr',
    'sra',
    'senhora',
    'aparecida',
    'fatima',
    'conceicao',
    'lourdes',
    'gracas',
    'luz',
    'saude',
    'gloria',
  ]);
  const STREET_LEADERS = new Set(['rua', 'avenida', 'travessa', 'estrada', 'alameda', 'rodovia', 'servidao', 'beco']);
  const tokens = norm(s).split(' ').filter(Boolean);
  return tokens
    .map((t, idx) => {
      if (t === 'n') {
        const next = tokens[idx + 1] || '';
        if (/^\d+[a-z]?$/.test(next)) return 'numero';
        if (NOSSA_FOLLOWERS.has(next)) return 'nossa';
        return 'n';
      }
      if (t === 's') {
        const prev = tokens[idx - 1] || '';
        if (idx === tokens.length - 1 && STREET_LEADERS.has(prev)) return 's';
        return 'sao';
      }
      if (t === '15') {
        const next = tokens[idx + 1] || '';
        return next === 'de' ? 'quinze' : '15';
      }
      return mapping[t] || t;
    })
    .join(' ');
}

const PT_NUM_WORD_MAP: Record<string, string> = {
  zero: '0',
  um: '1',
  uma: '1',
  primeiro: '1',
  primeira: '1',
  dois: '2',
  duas: '2',
  segundo: '2',
  segunda: '2',
  tres: '3',
  terceiro: '3',
  terceira: '3',
  quatro: '4',
  quarto: '4',
  cinco: '5',
  quinto: '5',
  seis: '6',
  sexto: '6',
  sete: '7',
  setimo: '7',
  oito: '8',
  oitavo: '8',
  nove: '9',
  nono: '9',
  dez: '10',
  decimo: '10',
  onze: '11',
  doze: '12',
  treze: '13',
  quatorze: '14',
  catorze: '14',
  quinze: '15',
  dezesseis: '16',
  dezessete: '17',
  dezoito: '18',
  dezenove: '19',
  vinte: '20',
  trinta: '30',
  quarenta: '40',
  cinquenta: '50',
  ii: '2',
  iii: '3',
  iv: '4',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  xi: '11',
  xii: '12',
  xiii: '13',
  xiv: '14',
  xv: '15',
  xvi: '16',
  xx: '20',
};

/**
 * Converte cardinais/ordinais em português e zeros à esquerda ("01"->"1", "Dois"->"2", "Cinco"->"5",
 * "Vinte e Quatro"->"24") preservando letras isoladas de vias ("Rua A".."Rua M", inclusive "Rua I").
 */
export function canonicalizeNumberedStreetText(s: string, stripNumeroMarker = false): string {
  let t = expandAbbr(s)
    .replace(/\b0+(\d+)\b/g, '$1')
    .replace(/\bvinte e (\w+)\b/g, (_, w) =>
      PT_NUM_WORD_MAP[w] && PT_NUM_WORD_MAP[w].length === 1 ? `2${PT_NUM_WORD_MAP[w]}` : `vinte e ${w}`
    )
    .replace(/\btrinta e (\w+)\b/g, (_, w) =>
      PT_NUM_WORD_MAP[w] && PT_NUM_WORD_MAP[w].length === 1 ? `3${PT_NUM_WORD_MAP[w]}` : `trinta e ${w}`
    )
    .replace(/\bquarenta e (\w+)\b/g, (_, w) =>
      PT_NUM_WORD_MAP[w] && PT_NUM_WORD_MAP[w].length === 1 ? `4${PT_NUM_WORD_MAP[w]}` : `quarenta e ${w}`
    )
    .replace(/\bduzentos e treze\b/g, '213')
    .replace(/\bduzentos e dezessete\b/g, '217')
    .replace(/\btrezentos e seis\b/g, '306');

  // Normaliza marcadores "n 5" / "nº 5" / "n° 5" / "numero 5"
  t = t.replace(/\bn\s+(?=\d)/g, 'numero ');
  if (stripNumeroMarker) {
    t = t.replace(/\bnumero\s+(?=\d)/g, '');
  }

  return t
    .split(' ')
    .filter(Boolean)
    .map((tok) => PT_NUM_WORD_MAP[tok] || tok)
    .join(' ');
}

const NUMBERED_STREET_HEAD_RE =
  /^((?:r\.?|rua|av\.?|avenida|tv\.?|trav\.?|travessa|estr\.?|estrada|al\.?|alameda|servid[aã]o|beco|largo|pra[çc]a|pc\.?|rodovia|rod\.?|via)\s+(?:(?:projetada|particular|sem\s+denomina[çc][aã]o)\s+)?(?:(?:\d{1,2}[º°]?\s+de\s+(?:janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)|(?:n(?:[uú]mero|um\.?|\.?[º°])\s*)?(?:["']?(?:0?\d{1,3}(?:[-/]?[A-Za-z])?(?:\s+bis)?)["']?)|["']?[A-Za-z](?=["']?(?:\s*(?:$|[,;\-\d]|\bn(?:[uú]mero|um\.?|\.?[º°]))))["']?|(?:n(?:[uú]mero|um\.?|\.?[º°])\s*)?(?:um|uma|primeiro|primeira|dois|duas|segundo|segunda|tr[eê]s|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte(?:\s+e\s+(?:um|dois|tr[eê]s|tres|quatro|cinco|seis|sete|oito|nove))?|trinta(?:\s+e\s+\w+)?|quarenta(?:\s+e\s+\w+)?|duzentos\s+e\s+(?:treze|dezessete)|trezentos\s+e\s+seis)|ii|iii|iv|vi|vii|viii|ix|xi|xii|xiii|xiv|xv)\b["']?))/i;

/**
 * Separa o identificador inicial de vias numeradas/letradas/datas (ex.: "Rua 2", "Rua Nº 5",
 * "Rua Cinco", "Rua A", "Rua 7 de Setembro") do restante do endereço para impedir que o número
 * ou código da rua seja confundido com número predial da casa.
 */
export function splitLeadingStreetIdentifier(addressText: string): {
  streetHead: string;
  tail: string;
} {
  const trimmed = addressText.trim();
  const m = trimmed.match(NUMBERED_STREET_HEAD_RE);
  if (!m) return { streetHead: '', tail: trimmed };
  return {
    streetHead: m[1].trim(),
    tail: trimmed.slice(m[0].length),
  };
}

export function extractCep(rawText: string): string | null {
  const cleaned = rawText
    .replace(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g, ' ')
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, ' ');
  const m = cleaned.match(
    /(?:^|[^0-9])(?:c\.?\s*e\.?\s*p\.?\s*[:\-]?\s*)?(\d{2})\.?(\d{3})[-\s.]?(\d{3})(?=$|[^0-9])/i
  );
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

export function extractMalformedCep(rawText: string): string | null {
  if (extractCep(rawText)) return null;
  const cleaned = rawText
    .replace(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g, ' ')
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, ' ');
  const m = cleaned.match(/\bc\.?\s*e\.?\s*p\.?\s*[:\-]?\s*(\d[\d.\-\s]{4,10}\d)\b/i);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  return digits.length >= 6 && digits.length !== 8 ? m[1].trim() : null;
}

export function detectInternalCity(rawText: string): 'SJP' | 'TIJ' | null {
  const qClean = stripAccents(rawText).toLowerCase();
  if (
    /(?:cidade|municipio|comarca)\s*(?:de|do|da)?\s*[:\-]?\s*tijucas\s+do\s+sul\b|(?:,| - |\s\/|\b)\s*tijucas\s+do\s+sul(?:\s*[-/]\s*pr|\b)/i.test(
      qClean
    )
  ) {
    return 'TIJ';
  }
  if (
    /(?:cidade|municipio|comarca)\s*(?:de|do|da)?\s*[:\-]?\s*sao\s+jose\s+dos\s+pinhais\b|(?:,| - |\s\/)\s*sao\s+jose\s+dos\s+pinhais(?:\s*[-/]\s*pr|\s*$)|^\s*sao\s+jose\s+dos\s+pinhais\s*[-/]\s*pr\b|\bsjp\s*[-/]\s*pr\b/i.test(
      qClean
    )
  ) {
    return 'SJP';
  }
  return null;
}

export function detectExternalCity(rawText: string): string | null {
  const internalCity = detectInternalCity(rawText);
  // Remove menções às cidades da Comarca e bairros homônimos de SJP antes de checar municípios externos
  const qClean = stripAccents(rawText)
    .toLowerCase()
    .replace(/\bsao\s+jose\s+dos\s+pinhais(?:\s*[-/]\s*pr)?\b/gi, ' ')
    .replace(/\btijucas\s+do\s+sul(?:\s*[-/]\s*pr)?\b/gi, ' ')
    .replace(/\bcampo\s+largo\s+da\s+roseira\b/gi, ' ')
    .replace(/\bjardim\s+rio\s+branco\b/gi, ' ')
    .replace(/\bcolonia\s+rio\s+grande\b/gi, ' ')
    .replace(/\bbairro\s*[:\-]?\s*contenda\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Bairros/vias internas de SJP que coincidem com nomes de cidades da RMC/PR
  const AMBIGUOUS_WHEN_INTERNAL_DECLARED = new Set([
    'pinhais',
    'contenda',
    'campo largo',
    'palmeira',
    'castro',
    'lapa',
    'curitiba',
    'londrina',
    'maringa',
    'apucarana',
    'ponta grossa',
    'cascavel',
    'guarapuava',
    'toledo',
    'umuarama',
    'arapongas',
    'joinville',
    'blumenau',
    'florianopolis',
    'itajai',
    'sao paulo',
    'rio de janeiro',
    'brasilia',
    'campinas',
    'santos',
  ]);

  for (const city of EXTERNAL_CITIES) {
    if (city === 'tijucas') {
      if (
        /(?:,| - |\s\/\s|\bcomarca de\s+|\bmunicipio de\s+)\s*tijucas(?!\s+do\s+sul)\s*[-/]\s*sc\b/i.test(
          qClean
        )
      ) {
        return 'Tijucas/SC';
      }
      continue;
    }
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (internalCity && AMBIGUOUS_WHEN_INTERNAL_DECLARED.has(city)) {
      const explicitOtherCity = new RegExp(
        `\\b(?:cidade|municipio|comarca)\\s*(?:de|do|da)?\\s*[:\\-]\\s*${escaped}\\b`,
        'i'
      );
      if (!explicitOtherCity.test(qClean)) continue;
    }
    if (city === 'contenda') {
      // Só trata Contenda como município externo quando houver indicação explícita de cidade/UF ou sem SJP/colônia
      const explicitContendaCity =
        /\b(?:cidade|municipio|comarca)\s*(?:de|do|da)?\s*[:\-]?\s*contenda\b|\bcontenda\s*[-/]\s*pr\b/i.test(
          qClean
        );
      if (!explicitContendaCity) continue;
    }
    const patterns = [
      new RegExp(
        `(?:,\\s*|\\s+-\\s*|\\s*/\\s*|\\bmunicipio de\\s+|\\bcomarca de\\s+|\\bcidade(?:\\s+de)?\\s*[:\\-]\\s*|\\bcidade de\\s+)${escaped}(?:\\s*[-/]\\s*[a-z]{2}|\\s*$|\\s*,|\\s*-)`,
        'i'
      ),
      new RegExp(`\\b${escaped}\\s*[-/]\\s*(?:pr|sc|sp|rs|mg|rj|df|go|ba|ms|mt|es|pe|ce)\\b`, 'i'),
      // Ex.: "Rua Marechal Deodoro 500 Curitiba" (após nº predial, sem disparar em "Rua Curitiba 500")
      new RegExp(
        `^(?!\\s*(?:rua|r\\.?|avenida|av\\.?|travessa|tv\\.?|estrada|rodovia|alameda|praca|largo|beco|servidao)\\s+${escaped}\\b).*\\b\\d{1,5}[a-z]?\\s+${escaped}(?:\\s*[-/]\\s*[a-z]{2})?\\s*$`,
        'i'
      ),
    ];
    if (patterns.some((p) => p.test(qClean))) {
      return city.replace(/\b\w/g, (l) => l.toUpperCase());
    }
  }

  // Padrão genérico "Cidade/UF" ou "Cidade - UF" para qualquer UF fora do PR (ou município/comarca explícito)
  const genericUfMatch = qClean.match(
    /(?:,| - |\s)\s*([a-z][a-z\s]{2,28}?)\s*[\/-]\s*(sc|sp|rs|mg|rj|df|go|ba|ms|mt|es|pe|ce|pa|am|ma|pb|rn|al|se|pi|ro|ac|ap|rr|to)\b/i
  );
  if (genericUfMatch) {
    const cand = genericUfMatch[1].trim();
    const uf = genericUfMatch[2].toUpperCase();
    const invalidTokens = new Set([
      'casa', 'apto', 'apartamento', 'bloco', 'lote', 'quadra', 'sala', 'loja', 'km', 'br', 'centro', 'zona', 'cidade', 'cep',
    ]);
    const words = cand.split(/\s+/);
    const tailCity = words.slice(-Math.min(words.length, 3)).join(' ');
    if (tailCity.length >= 3 && !words.every((w) => invalidTokens.has(w))) {
      return `${tailCity.replace(/\b\w/g, (l) => l.toUpperCase())}/${uf}`;
    }
  }

  const explicitMunMatch = qClean.match(
    /\b(?:municipio|comarca|cidade)\s*(?:de|do|da)?\s*[:\-]?\s*([a-z][a-z\s]{2,32}?)(?:\s*[-/]\s*[a-z]{2}|,|\bcep\b|\s*$)/i
  );
  if (explicitMunMatch) {
    const mun = explicitMunMatch[1].trim();
    if (mun.length >= 3 && !/\b(?:sao jose dos pinhais|tijucas do sul|sjp)\b/i.test(mun)) {
      return mun.replace(/\b\w/g, (l) => l.toUpperCase());
    }
  }

  return null;
}

export function extractAddressLineFromMandado(rawText: string): string {
  const normalizedRaw = rawText.replace(/\u00a0/g, ' ');
  const lines = normalizedRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return normalizedRaw
      .replace(
        /^(?:endere[çc]o|logradouro|local(?:\s+da\s+dilig[êe]ncia)?|resid[êe]ncia)\s*[:\-]\s*/i,
        ''
      )
      .trim();
  }

  const companionFieldRe =
    /^(?:bairro|loteamento|complemento|cidade|munic[ií]pio|comarca|uf|estado|cep|c\.e\.p\.|ponto de refer[êe]ncia)\s*[:\-]/i;
  const joinWithCompanionLines = (startIdx: number, baseLine: string): string => {
    const parts = [baseLine];
    for (let j = startIdx + 1; j < lines.length && j <= startIdx + 5; j++) {
      if (companionFieldRe.test(lines[j])) {
        parts.push(lines[j]);
      }
    }
    return parts.join(', ');
  };

  const addrPrefixes =
    /^(?:endere[çc]o(?:\s+atualizado|\s+completo)?|logradouro|local(?:\s+da\s+dilig[êe]ncia|\s+de\s+cumprimento)?|rua|av\.?|avenida|rodovia|estrada)\s*[:\-]?\s*(.+)$/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(addrPrefixes);
    if (m && !/foro regional|vara c[ií]vel|vara criminal|juizado|poder judici[aá]rio/i.test(line)) {
      const cleanedLine = line
        .replace(
          /^(?:endere[çc]o(?:\s+atualizado|\s+completo)?|logradouro|local(?:\s+da\s+dilig[êe]ncia|\s+de\s+cumprimento)?)\s*[:\-]\s*/i,
          ''
        )
        .trim();
      return joinWithCompanionLines(i, cleanedLine);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/foro regional|vara\b|poder judici[aá]rio|autos\s*n/i.test(line)) continue;
    if (
      /\d{2}\.?\d{3}[-\s.]?\d{3}|\b(?:rua|av\.?|avenida|travessa|estrada|rodovia|alameda|br[-\s]?\d{3})\b/i.test(
        line
      )
    ) {
      return joinWithCompanionLines(i, line);
    }
  }

  return (
    lines.filter((l) => !/foro regional|poder judici[aá]rio|autos\s*n/i.test(l)).join(' ').trim() ||
    normalizedRaw.trim()
  );
}

export function extractHearingDateAlert(rawText: string): ParsedMandadoSignals['hearingDateAlert'] {
  const qNorm = stripAccents(rawText).toLowerCase();
  if (!/audiencia|sessao de conciliacao|julgamento|oitiva/.test(qNorm)) return null;

  const dateMatch = rawText.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (!dateMatch) return null;

  const day = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10) - 1;
  const year = parseInt(dateMatch[3], 10);
  const hearingDate = new Date(year, month, day);
  if (Number.isNaN(hearingDate.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((hearingDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  const dateStr = dateMatch[0];

  if (diffDays < 0) {
    return {
      dateStr,
      daysUntil: diffDays,
      status: 'passado',
      message: `Audiência em ${dateStr} já transcorreu (${Math.abs(diffDays)} dias atrás) — conferir antes de distribuir!`,
    };
  }
  if (diffDays <= 15) {
    return {
      dateStr,
      daysUntil: diffDays,
      status: 'curto',
      message: `Audiência próxima (${dateStr}, em ${diffDays} dias) — atenção à prioridade/urgência de cumprimento (Resolução nº 139/2015–OE, art. 17; o Ofício-Circular nº 16/2026–GCJ cancelou a antiga trava de antecedência de 30–60 dias).`,
    };
  }
  return {
    dateStr,
    daysUntil: diffDays,
    status: 'ok',
    message: `Audiência designada para ${dateStr} (em ${diffDays} dias) — sem trava geral de antecedência mínima/máxima após o Ofício-Circular nº 16/2026–GCJ (salvo regra específica de Portaria local).`,
  };
}

export function extractHouseNumber(addressText: string): string | null {
  const cleanedRaw = addressText
    .replace(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g, ' ')
    .replace(/\bc\.?\s*e\.?\s*p\.?\s*[:\-]?\s*\d[\d.\-\s]{4,10}\d/gi, ' ')
    .replace(/\d{2}\.?\d{3}[-\s.]?\d{3}/gi, ' ')
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, ' ')
    .replace(/\b(?:br|pr|sc|sp)[-\s]?\d{2,3}\b/gi, ' ')
    .replace(/\bkm\s*[:]?\s*\d+(?:[.,]\d+)?\b/gi, ' ');

  // Protege o identificador numérico da própria via (ex.: "Rua 2", "Rua Nº 5", "Rua 7 de Setembro")
  const { streetHead, tail } = splitLeadingStreetIdentifier(cleanedRaw);
  const targetForNumber = streetHead
    ? tail
    : cleanedRaw.replace(
        /\b\d{1,2}[º°]?\s+de\s+(?:janeiro|fevereiro|marco|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/gi,
        ' '
      );

  if (!targetForNumber || !targetForNumber.trim()) return null;

  const mExplicit = targetForNumber.match(/(?:\bn[º°.]?\s*|,\s*|^\s*-\s*)(\d{1,5})\b/i);
  if (mExplicit) return mExplicit[1];

  const mTrailing = targetForNumber.match(/(?:^|\s)(\d{1,5})(?:\s*[-,/]|\s*$)/);
  if (mTrailing) return mTrailing[1];

  return null;
}

export function parseMandadoSignals(
  rawText: string,
  bairrosList: { nome: string; regiao: string }[],
  loteamentosList: LoteamentoEntry[] = []
): ParsedMandadoSignals {
  const extractedAddressLine = extractAddressLineFromMandado(rawText);
  const fullNorm = expandAbbr(rawText);
  const addrNorm = expandAbbr(extractedAddressLine);

  const cep = extractCep(rawText);
  const malformedCep = extractMalformedCep(rawText);
  const coords = parseCoordinates(rawText);

  let highwayKm: ParsedMandadoSignals['highwayKm'] = null;
  const hwNorm = norm(extractedAddressLine) || norm(rawText);
  const mBr = hwNorm.match(/\b(br\s*[-]?\s*(277|376|116)|contorno\s+leste)\b/);
  const mKm = hwNorm.match(/\bkm\s*[:]?\s*(\d+(?:[.,]\d+)?)\b/);
  if (mBr && mKm) {
    const kmVal = parseFloat(mKm[1].replace(',', '.'));
    const rod: 'BR-277' | 'BR-376' | 'BR-116' = mBr[0].includes('277')
      ? 'BR-277'
      : mBr[0].includes('376')
      ? 'BR-376'
      : 'BR-116';
    highwayKm = { rodovia: rod, km: kmVal };
  }

  const houseNumber = highwayKm || coords ? null : extractHouseNumber(extractedAddressLine);
  const hasComplement =
    /\b(apto?|apartamento|bloco|bl\.?|casa\s+\w+|fundos|lote|quadra|qd\.?|lt\.?|sala|sobreloja|condom[ií]nio|ch[aá]cara|km)\b/i.test(
      extractedAddressLine
    );

  const internalCityHint = detectInternalCity(rawText);
  const externalCity = detectExternalCity(extractedAddressLine) || detectExternalCity(rawText);

  let r9Trigger: string | null = null;
  if (/\bcomplexo\s+medico\s+penal\b|\bcmp\b(?=\s*(?:[-,/]|pinhais|pr\b|presidio|penal|$))/.test(fullNorm)) {
    r9Trigger = 'Complexo Médico Penal (CMP — Pinhais)';
  } else if (/\bcasa de custodia\b|\bccjp\b|\bcadeia publica\b/.test(fullNorm)) {
    r9Trigger = 'Casa de Custódia / Cadeia Pública de São José dos Pinhais';
  } else if (/\bcense\b|\bsocioeduca/.test(fullNorm)) {
    r9Trigger = 'CENSE — Centro de Socioeducação de SJP';
  } else if (/\bdelegacia\b|\b1 drp\b|\b1a drp\b|\bdelegacia da mulher\b/.test(fullNorm)) {
    r9Trigger = 'Delegacia de Polícia (1ª DRP / Delegacia da Mulher / Especializada)';
  } else if (
    /\bcumprimento imediato\b|\bmedida imediata\b|\bplantao judiciario\b|\bplantao\b|\balvara de soltura\b|\bmandado de prisao\b|\bmedida protetiva urgente\b/.test(
      fullNorm
    )
  ) {
    r9Trigger = 'Plantão / Medida de Cumprimento Imediato';
  } else if (
    addrNorm.includes('sebastiana santana fraga') &&
    ['427', '1100', '1011'].some((n) => addrNorm.split(' ').includes(n) || houseNumber === n)
  ) {
    r9Trigger =
      houseNumber === '427' || addrNorm.split(' ').includes('427')
        ? 'Casa de Custódia (R. Sebastiana Santana Fraga, 427)'
        : 'CENSE SJP (R. Sebastiana Santana Fraga, 1100)';
  } else if (
    addrNorm.includes('norberto de brito') &&
    (addrNorm.split(' ').includes('1445') || houseNumber === '1445')
  ) {
    r9Trigger = '1ª DRP (R. Dr. Norberto de Brito, 1445)';
  } else if (
    addrNorm.includes('souza naves') &&
    (addrNorm.split(' ').includes('484') || houseNumber === '484')
  ) {
    r9Trigger = 'Delegacia da Mulher (Av. Sen. Souza Naves, 484)';
  }

  let r8Trigger: string | null = null;
  if (
    /\bcitacao online\b|\bcitacao via online\b|\bintimacao online\b|\bcomunicacao virtual\b|\bvia online\b/.test(
      fullNorm
    )
  ) {
    r8Trigger = 'Citação/Intimação via Online (determinação expressa)';
  }

  let r7Trigger: string | null = null;
  if (addrNorm.includes('castelhanos') || fullNorm.includes('colonia castelhanos')) {
    r7Trigger = 'Colônia Castelhanos (Região 7 por regra do sistema)';
  } else if (
    addrNorm.includes('tijucas do sul') ||
    (!externalCity && /\btijucas\b/.test(addrNorm)) ||
    (cep && /^8319/.test(cep))
  ) {
    r7Trigger = 'Município de Tijucas do Sul (Região 7)';
  }

  const hearingDateAlert = extractHearingDateAlert(rawText);

  // Detecta bairros e localidades priorizando menções explícitas ("Bairro: X", após vírgula/traço/número),
  // evitando falso positivo quando o nome do bairro faz parte do próprio nome da rua (ex.: "Rua Afonso Pena, 100").
  const cleanNormalizedText = rawText.replace(/\u00a0/g, ' ');
  const bairroTailMatch =
    extractedAddressLine.match(/\bbairro\s*[:\-]\s*([^,;\n]+)/i) ||
    cleanNormalizedText.match(/\bbairro\s*[:\-]\s*([^,;\n]+)/i);
  const streetPrefixOnly = /^(?:r\.?|rua|av\.?|avenida|tv\.?|trav\.?|travessa|estr\.?|estrada|rod\.?|rodovia|al\.?|alameda|praca|pra[çc]a|servidao|servid[aã]o|beco|largo|via)\s+/i.test(
    extractedAddressLine.trim()
  );
  const firstCommaIdx = extractedAddressLine.indexOf(',');
  const tailAfterComma = firstCommaIdx >= 0 ? extractedAddressLine.slice(firstCommaIdx + 1) : '';
  const bairroSearchSource = bairroTailMatch
    ? expandAbbr(`${bairroTailMatch[1]} ${tailAfterComma}`)
    : streetPrefixOnly && tailAfterComma.trim().length >= 3
    ? expandAbbr(tailAfterComma)
    : addrNorm;

  const bairrosDetectados: { nome: string; regiao: string }[] = [];
  const seenB = new Set<string>();
  const IGNORED_MUNICIPAL_NAMES = new Set(['sao jose dos pinhais', 'tijucas do sul', 'area rural']);
  for (const b of bairrosList) {
    const bn = expandAbbr(b.nome);
    if (
      bn.length < 3 ||
      IGNORED_MUNICIPAL_NAMES.has(bn) ||
      (['ina', 'ipe', 'campo', 'centro'].includes(bn) &&
        !new RegExp(`\\b${bn}\\b`).test(bairroSearchSource))
    ) {
      continue;
    }
    const regexB = new RegExp(
      `(?:^|[,\\s:\\-/])${bn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[,\\s:\\-/])`
    );
    if (regexB.test(bairroSearchSource) && !seenB.has(`${bn}|${b.regiao}`)) {
      seenB.add(`${bn}|${b.regiao}`);
      bairrosDetectados.push({ nome: b.nome, regiao: b.regiao });
    }
  }

  const loteamentosDetectados: { nome: string; regiao: string; bairro?: string }[] = [];
  const seenLot = new Set<string>();
  for (const lot of loteamentosList) {
    const ln = expandAbbr(lot.n);
    if (ln.length < 4) continue;
    const regexL = new RegExp(
      `(?:^|[,\\s:\\-/])${ln.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[,\\s:\\-/])`
    );
    if (regexL.test(addrNorm) && !seenLot.has(`${ln}|${lot.r}`)) {
      seenLot.add(`${ln}|${lot.r}`);
      loteamentosDetectados.push({ nome: lot.n, regiao: lot.r, bairro: lot.b });
    }
  }

  return {
    rawText,
    extractedAddressLine,
    cep,
    malformedCep,
    coords,
    highwayKm,
    houseNumber,
    hasComplement,
    externalCity,
    internalCityHint,
    r9Trigger,
    r8Trigger,
    r7Trigger,
    hearingDateAlert,
    bairrosDetectados,
    loteamentosDetectados,
  };
}
