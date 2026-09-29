# God's Eye View — guia em português (Brasil)

[English](README.md) · [Como contribuir](CONTRIBUTING.pt-BR.md)

O God's Eye View reúne sinais públicos em um globo explorável: aeronaves, navios, satélites, terremotos, câmeras públicas, trânsito, transporte e clima. Parte dos dados é ao vivo; trânsito representa veículos **simulados** sobre ruas reais, e a orientação de câmeras e as trajetórias reproduzidas de foguetes são estimativas. A interface indica fontes e limitações. Esta página é um guia de entrada em português; o [README original](README.md) contém o catálogo completo, demonstrações e detalhes técnicos mais recentes.

## Comece sem chave de API

O aplicativo inicia com imagens de satélite Esri e terreno sem chave; se Esri estiver indisponível, muda para OSM. Voos, tráfego militar, satélites, terremotos, câmeras públicas, rádio e lançamentos podem ser usados sem chave. Para 3D fotorrealista, configure um token Cesium ion conforme elegibilidade e cotas do provedor ou uma chave Google Maps para acesso direto com cobrança e busca de lugares.

**Com Pinokio:** instale ou atualize o [Pinokio](https://desktop.pinokio.co/) para a versão 8.2 ou posterior, abra o [instalador do God's Eye View](https://pinokio.co/apps/github-com-bilawalsidhu-gods-eye-view) e escolha **Install** e **Start**.

**Pelo terminal:** use Node.js 24.14.0 ou posterior da série 24, ou Node.js 26.

```bash
git clone https://github.com/bilawalsidhu/gods-eye-view.git
cd gods-eye-view
npm ci
npm run doctor
npm run dev
```

Abra **http://localhost:4173** e escolha uma das missões iniciais ou **Explore Manually**. O cartão inicial aparece em português quando o navegador usa um idioma `pt`; o restante da interface ainda está predominantemente em inglês. No macOS, `./scripts/dev-fresh.sh` pode ler chaves configuradas no Keychain.

Se você instalou uma versão anterior, **atualize**: versões antigas consultam instâncias públicas do Overpass que agora recusam essas requisições, deixando algumas camadas vazias.

## Primeiros passos no globo

1. Escolha **Live Contacts** ou ative **Flights** e selecione uma aeronave para acompanhar telemetria e trilha.
2. Use **COCKPIT** em uma aeronave selecionada. Ative **CCTV** para explorar câmeras públicas e **VIEWSHED** para ver coberturas estimadas.
3. Ative **Traffic** perto de uma cidade. Os veículos são simulados; uma chave TomTom acrescenta velocidades e congestionamento reais à simulação, sem transformar posições individuais dos veículos em observações ao vivo.
4. Explore **Satellites**, **Earthquakes**, **Transit**, **Directions** e as camadas de clima. O [catálogo original](README.md#️-whats-on-the-globe) explica as fontes e o acesso das 19 camadas e mapas.
5. Com chave OpenAI, use **GEV MIC** para navegar, perguntar sobre objetos e criar anotações por voz. Os exemplos de comandos estão no [README original](README.md).

Atalhos: `1`–`7` estilos visuais · `H` HUD · `D` detecção · `C` cockpit · `Esc` sair.

## Chaves opcionais e custos

Abra **POWER UP → Provider Settings** no aplicativo para adicionar chaves. Em uma instalação pelo terminal, elas são salvas no `.env` ignorado pelo Git; no Pinokio, no arquivo de ambiente local do aplicativo. Valores vindos do shell ou Keychain aparecem como configurados externamente. Se o botão estiver escondido por uma tela compacta, `?setup=1` reabre o painel.

| Provedor | Recurso adicional | Acesso |
|---|---|---|
| [Cesium ion](https://cesium.com/ion) | Google 3D e terreno mundial hospedados pela ion | Plano comunitário sujeito a elegibilidade de uso pessoal/não comercial e cotas |
| [Google Maps](https://console.cloud.google.com/) | Google 3D direto e busca de lugares | Uso medido; restrinja a chave |
| [OpenAI](https://platform.openai.com/) | Voz e resumo de IA no HUD | Uso medido |
| [AISStream](https://aisstream.io/) | Embarcações ao vivo | Cadastro gratuito |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/) | Incêndios ativos | Chave gratuita |
| [TomTom](https://developer.tomtom.com/) | Velocidades e congestionamento no trânsito simulado | Camada gratuita disponível |
| [OpenSky](https://opensky-network.org) e [Launch Library 2](https://thespacedevs.com) | Cotas maiores de consulta | Opcionais |

Preços, permissões e cotas mudam: confirme os termos atuais com os provedores. O servidor atende em `localhost` por padrão. Chaves usadas no navegador, como Google Maps e Cesium ion, devem ser restritas no provedor. Consulte [segurança](SECURITY.md), [origem dos dados](DATA_SOURCES.md) e a [análise de custos](README.md#-api-keys).

## Limites e contribuição

O código é [MIT](LICENSE), mas conjuntos de dados e imagens têm termos próprios. Este é um instrumento exploratório: dados podem estar atrasados, incompletos, simulados ou errados. Não o use para navegação, emergências ou decisões críticas; verifique informações importantes em fontes oficiais. O projeto não aceita recursos para identificar ou rastrear pessoas.

Para ajudar com câmeras públicas, camadas, testes ou interface, siga o [guia de contribuição em português](CONTRIBUTING.pt-BR.md) e confira a [versão original](CONTRIBUTING.md) antes de enviar um PR.
