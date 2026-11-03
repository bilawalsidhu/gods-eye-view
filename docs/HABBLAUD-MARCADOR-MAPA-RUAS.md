Manual 30 — Marcador geográfico e mapa com nomes de ruas

Integração: Walney Moreira Klein — walneyk@hotmail.com.

1. Marcar no globo: em Geo Mission clique 'Marcar ponto no mapa', depois clique no terreno ou prédio no Cesium. A aplicação God's Eye View usa ScreenSpaceEventHandler, pickPosition, globe.pick ou pickEllipsoid para capturar coordenadas geográficas e desenhar um marcador temporário. A mensagem gev:geo-picked devolve latitude, longitude e altitude de câmera à janela pai. O marcador não usa GPS do dispositivo.

2. Endereço: o Geo Mission consulta Nominatim /reverse com lat, lon, zoom=18, format=jsonv2 e addressdetails=1. Mostra rua, bairro, município e endereço aproximado, se existirem. Reverse geocoding retorna o objeto mapeado mais próximo, que pode não corresponder exatamente ao imóvel ou rua clicada. Confirme antes de salvar. A consulta externa transmite as coordenadas do ponto escolhido.

3. Favorito: o botão 'Salvar ponto como favorito' abre o cadastro com coordenadas do clique e nome aproximado. Presets pessoais são armazenados no navegador. Não publique endereços residenciais ou favoritos privados no GitHub.

4. Camada cartográfica: opção 'Sobrepor mapa OSM com nomes de ruas (experimental)' envia gev:osm-overlay para o God's Eye View, que cria uma camada Cesium OpenStreetMapImageryProvider com transparência de 78%. Os nomes já vêm desenhados nos tiles raster do OpenStreetMap; não dependem do Overpass. Desligar remove a camada. O mapa cobre parcialmente a imagem de satélite. Pode falhar por CORS, CSP, rede ou indisponibilidade dos tiles. O serviço tile.openstreetmap.org é destinado a uso moderado, com atribuição e observância de sua política; para produto público, contratar provedor de tiles ou hospedar infraestrutura apropriada.

5. Como personalizar: no Geo Mission, procure pickPoint, pickDetails, pickSave, pickTour e osmMapEnabled. No God's Eye View, src/app/embed.js contém setGeoPick e setOsmOverlay. Para alterar cor do marcador, modifique Cesium.Color.ORANGE; para tamanho, point.pixelSize; para transparência, osmOverlay.alpha (0 a 1). Para zoom de endereço, ajuste o parâmetro zoom na consulta Nominatim. Não execute geocodificação reversa em massa ou automaticamente durante todo movimento de câmera.

6. Testes: inicie God's Eye View em 4173 e Habblaud em 4747. Abra /geo-mission, marque um ponto, confirme coordenadas, veja endereço ou erro explícito, salve favorito e teste sua navegação. Ative a camada cartográfica e verifique nomes de ruas; desligue e confira retorno à imagem de satélite. A camada antiga Overpass permanece experimental e pode falhar.

7. Limitações: o clique em prédios 3D pode usar superfície/terreno aproximado; não é medição cadastral. A camada de mapa é raster e não produz entidades individuais clicáveis de ruas. Teste visual e políticas de provedores são necessários antes de disponibilização pública.
