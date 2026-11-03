# Manual 27 — Pesquisa inteligente e ficha de destinos (Geo Mission BR)

**Créditos da integração:** Walney Moreira Klein — walneyk@hotmail.com.

## 1. O que faz
O usuário digita um lugar como "Aperibé, RJ", clica em **Localizar no mapa**, recebe resultados do OpenStreetMap/Nominatim, e o primeiro resultado válido é selecionado automaticamente para abrir a ficha e posicionar a câmera do God's Eye View. Os demais resultados permitem escolher outra correspondência. A ficha exibe coordenadas, categoria, município, estado, país, CEP (quando informados) e link ao registro OpenStreetMap. Consulta artigos relacionados na Wikipédia em português para história e curiosidades; **artigos são candidatos e não devem ser tratados automaticamente como fatos confirmados sobre o lugar**. Há ações para buscar atrações próximas, salvar favorito e adicionar ao roteiro cinematográfico.

## 2. Arquitetura
- `community/geo-mission.html`: interface, eventos, validação e integração.
- `server/geo-bridge.ts`: política CSP das origens externas.
- `src/app/embed.js` no God's Eye View BR: recebe mensagens da janela pai para posição e etiquetas.
- APIs sem chave: Nominatim (geocodificação), Wikipédia MediaWiki (artigos e geosearch), Overpass (ruas; sujeito à disponibilidade).

## 3. Como alterar a pesquisa
Localize `placeSearchBtn` em `community/geo-mission.html`. A URL usa `https://nominatim.openstreetmap.org/search`, com `format=jsonv2`, `addressdetails=1`, `accept_language=pt-BR` e `limit=6`. Ajuste `limit` moderadamente; não use autocompletar ou pesquisas a cada tecla na API pública. O método `locationZoom(item)` decide a altitude da câmera por categoria do resultado.

## 4. Como adicionar campos na ficha
Em `showPlaceDossier(item)`, acrescente chamadas `dossierLine(facts,'Rótulo',item.address?.campo)`. Os dados podem estar ausentes; não invente valores. Para informações adicionais, adicione um provedor e identifique a fonte e a data.

## 5. Como trocar a fonte da Wikipédia
A função `showPlaceDossier` utiliza `action=query`, `generator=search`, `prop=extracts|info` e `origin=*`. Os artigos relacionados são exibidos com links. Para validar identidade de cidades, considere Wikidata QIDs e correspondência com OSM `wikidata`/ `wikipedia` tags, preferencialmente usando `details` do Nominatim ou uma consulta própria ao OSM. Não confunda similaridade textual com identificação confirmada.

## 6. Como adicionar outra API
Crie uma função isolada, por exemplo `async function buscarMuseus(lat,lon)`, limite requisições e tempo de espera, trate falhas e renderize resultados com `textContent`, não com `innerHTML`. Acrescente a origem em `connect-src` no `server/geo-bridge.ts` e teste CORS, licenças, cache e políticas de uso. Para implantação pública, implemente backend/proxy com cache, limitação de taxa e credenciais protegidas.

## 7. Fluxo de teste
1. Reinicie o Habblaud após `npm run build:server` e mantenha o God's Eye View BR ativo em 4173.
2. Pesquise `Aperibé, RJ` e confira se o globo muda de destino e se a ficha mostra dados retornados pelo Nominatim.
3. Verifique artigos relacionados, inclusive quando não há correspondência exata.
4. Teste selecionar outro resultado, salvar preset, consultar atrações e adicionar ao roteiro.
5. Teste busca vazia, lugar inexistente, indisponibilidade de rede e APIs com resultados incompletos.

## 8. Limitações e privacidade
O sistema não oferece ainda hotéis com disponibilidade, preços de passagens, avaliações verificadas ou rotas de trânsito. São integrações futuras. Os dados são públicos e podem estar desatualizados. A busca envia o texto digitado aos provedores externos; GPS não é utilizado automaticamente. Respeite as políticas dos serviços públicos e atribuições OSM/Wikimedia.
