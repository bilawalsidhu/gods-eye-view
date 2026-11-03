Geo Labels & Places — protótipo 0.5

Integração: Walney Moreira Klein — walneyk@hotmail.com.

Busca por cidades, ruas e endereços via Nominatim, com visita no globo e cadastro de preset. Camada opcional de nomes de ruas via OpenStreetMap/Overpass, exibidos como entidades Cesium; o usuário ativa manualmente, aproxima abaixo de 16 km e consulta até 50 vias com no máximo 35 nomes distintos. A consulta é limitada por intervalo e movimento da câmera. Desativar remove as etiquetas temporárias.

A consulta Nominatim respondeu HTTP 200; a consulta Overpass pública NÃO pôde ser confirmada na rede de desenvolvimento. Pode estar indisponível. A interface informa erros e não inventa ruas. Ainda faltam testes visuais, organização de etiquetas sobrepostas, tiles vetoriais, bairros e POIs automáticos.

Dados OpenStreetMap sujeitos à ODbL e atribuição. Nominatim e Overpass públicos não são infraestrutura ilimitada: para implantação pública, usar cache/proxy próprio, limitar chamadas, cumprir políticas e evitar consultas em massa.

Teste: buscar Nova Friburgo, visitar resultado, salvar preset; ativar etiquetas, aproximar a câmera, atualizar ruas, desativar etiquetas e verificar remoção. O God's Eye View recebe mensagens de câmera e etiquetas da janela pai no modo incorporado.
