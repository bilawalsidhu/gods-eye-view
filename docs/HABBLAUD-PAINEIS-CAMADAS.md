# Geo Mission 0.2.1 — Painéis móveis e camadas de dados

**Integração:** Walney Moreira Klein — walneyk@hotmail.com. Preserve os créditos e licenças dos projetos originais.

## Problema identificado e solução
O God's Eye View protege a incorporação com CSP `frame-ancestors 'none'` e `X-Frame-Options: DENY`. A incorporação é liberada **somente** para `http://127.0.0.1:4747` quando o servidor é iniciado com `GEV_EMBED_FRAME_ANCESTORS=http://127.0.0.1:4747` e a página usa `?embed=1`. Esse modo ocultava intencionalmente os painéis. O fork agora oferece `?embed=1&geoControls=1`, que reexibe os controles de camadas, cenas e contexto dentro da central, mantendo a permissão restrita ao Habblaud local.

## Controles
No God's Eye View completo, o lançador Habblaud agora fica à esquerda da barra inferior de Localização, com cabeçalho arrastável e botão de recolher. A posição é salva no armazenamento local do navegador. Na Central de Missões, o painel esquerdo também pode ser arrastado pelo título e recolhido pelo botão `−`; a posição é lembrada localmente. A opção de abrir o globo completo permite utilizar todos os controles originais e a tradução existente.

## Teste manual
1. Acesse `http://127.0.0.1:4747/geo-mission` e pressione Ctrl+Shift+R.
2. No globo integrado, abra **Camadas de dados (+)** e escolha uma camada de aeronaves ou satélites, caso esteja disponível e configurada.
3. Use **Cenas (+)** e escolha um preset. Nem toda fonte estará disponível sem chave, licença ou serviço ativo.
4. Arraste o painel da missão pelo título; recolha-o e reabra-o. No globo completo `http://127.0.0.1:4173/`, arraste o pequeno painel Habblaud e confira se não cobre Localização.
5. Clique em **Viajar no globo**, escolha Copacabana e depois outro destino. A posição e a qualidade 3D dependem dos dados Cesium.
6. Use **Consultar terremotos reais** para verificar a ponte MCP; teste **Reunir agentes** com Ollama configurado para verificar a IA. Esses são testes independentes.
7. Se não aparecerem camadas, abra o globo completo e verifique a configuração do provedor e o console do navegador. Não atribua automaticamente ausência de dados à integração.

## Segurança
A geolocalização do usuário é opcional e exige consentimento. O operador deve respeitar autorização de acesso, termos de uso, privacidade e licenças das fontes; desenvolvedores e operadores mantêm suas obrigações legais e de segurança. A integração local não está preparada para exposição pública sem autenticação, TLS e auditoria.
