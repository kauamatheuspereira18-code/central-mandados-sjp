# Central de Mandados — São José dos Pinhais & Tijucas do Sul (TJPR)

Sistema web de **Triagem Territorial Inteligente e Mapa Interativo com Base Google Maps, Street View 360° e Modo 3D** para distribuição de mandados nas **Regiões 1 a 9** da Comarca de São José dos Pinhais (incluindo Tijucas do Sul), pronto para hospedagem no **GitHub + Vercel**.

## Recursos Principais

1. **Base Google Maps, Street View 360° Real & Modo 3D:**
   - **Camadas instantâneas:** alternância fluida entre **Mapa**, **Satélite**, **Terreno** e **3D** (com edificações e vegetação em 3D real via `MapLibre GL` + `Three.js`).
   - **Street View 360° em primeira pessoa:** serviço `/api/streetview-pano` encontra o panorama oficial na via e abre a visualização caminhável com tela dividida + mini-mapa, além do Pegman 3D interativo no mapa.
   - **Clique em qualquer ponto do mapa:** resolve via `/api/reverse-geocode` (OSM + GeoSJP Bairros) e exibe **rua, bairro, cidade/estado, CEP** e a **região competente**.

2. **Motor de Triagem Territorial (`mandadosEngine.ts` + Tripla Verificação):**
   - **2.503 logradouros indexados** (`2.279` em São José dos Pinhais + `224` em Tijucas do Sul), **350 aliases/leis/nomes antigos**, **500 loteamentos**, **142 bairros/localidades**, **15.663 vias exclusivas da RMC** e faixas quilométricas das rodovias **BR-277, BR-376, BR-116, Contorno Leste e PR-281**.
   - **Tripla Verificação ao vivo (`/api/geocode`):** consulta em paralelo **Google Maps**, **GeoSJP (Número Predial / Eixos 1897 / Bairros)** e **OpenStreetMap (Nominatim)** com cache LRU e proteção contra conflito entre bairro e logradouro.
   - **CEPs universais (`/api/cep`):** corrida paralela entre **ViaCEP**, **BrasilAPI v2** e **OpenCEP**, incluindo tratamento da armadilha **Butiazinho** (`CEP 83050-190..216` → **Região 2**) e CEPs gerais municipais (`83190-000` → **Região 7**).
   - **Regras Oficiais (Regiões 1 a 9):**
     - **Região 9:** Plantão, Casa de Custódia / Cadeia Pública, CENSE, 1ª DRP, Delegacia da Mulher, Complexo Médico Penal (CMP) e medidas imediatas.
     - **Região 8:** Citações/intimações online por determinação expressa.
     - **Região 7:** Tijucas do Sul + Colônia Castelhanos.
     - **Região 6:** Área rural < 30 km (polígonos Norte e Sul unificados em Região 6, sem "6A").
     - **Fora da Comarca:** identificação automática de endereços externos (Curitiba, RMC, outros municípios/Estados).

3. **Histórico de Consultas & Certidões Prontas (`DEV` — Sem Data):**
   - Aba dedicada **Histórico** entre **Consulta** e **Regiões (1–9)** com filtros e restauração instantânea no mapa.
   - Certidões de devolução sem distribuição atualizadas (**INC nº 25/2020–P-GP/CGJPR** compilada até a **INC nº 262/2026**, **CNFJ** atualizado até o Provimento **359/2026**, **Resolução nº 139/2015–OE** e **Ofício-Circular nº 17/2026–CGJ**), com título **CERTIDÃO** em destaque e sem data no rodapé (o PROJUDI insere a data automaticamente), prontas para copiar formatadas.

---

## Como rodar localmente

```bash
npm install
npm run dev
```

Acesse [http://localhost:3000](http://localhost:3000).

## Como publicar no GitHub e colocar no ar na Vercel

### Opção 1 — Pelo navegador (sem usar terminal/Git)
1. Crie um repositório no GitHub (ex.: `central-mandados-sjp`).
2. Baixe e extraia `mandados-sjp-site.zip`.
3. Na tela do repositório no GitHub, clique em **Add file → Upload files**, arraste todos os arquivos e pastas de dentro de `mandados-sjp-site` e clique em **Commit changes**.
4. Acesse [vercel.com](https://vercel.com), entre com sua conta do GitHub, clique em **Add New → Project**, importe o repositório e clique em **Deploy**.

### Opção 2 — Via terminal (`git`)
```bash
git init
git add .
git commit -m "Central de Mandados SJP"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/central-mandados-sjp.git
git push -u origin main
```

*(Opcional)* Para ativar o JS SDK oficial do Google Maps + Street View embutido, adicione em **Project Settings → Environment Variables** na Vercel:
```text
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=sua_chave_google_maps_javascript_api
```
