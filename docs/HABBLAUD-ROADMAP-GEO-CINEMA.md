# Geo Mission BR — Plano de evolução e primeiro Geo Cinema experimental

**Integração:** Walney Moreira Klein — walneyk@hotmail.com.

## Roadmap HTML
O arquivo `roadmap.html` é uma página independente e responsiva, com dez módulos, prioridades, versões-alvo, estados, critérios de aceite, busca, filtros e exportação JSON. Ele está em `community/roadmap.html` no Habblaud e na raiz do God's Eye View BR. A URL do Habblaud é `http://127.0.0.1:4747/roadmap.html`; a do God's Eye View é `http://127.0.0.1:4173/roadmap.html`.

## Arquitetura
- God's Eye View BR: renderização Cesium, câmera, camadas e dados geográficos.
- Geo Mission: interface, favoritos, roteiros e experiências.
- Habblaud: agentes e consultas MCP. O protótipo atual representa três papéis com uma única chamada de IA, não três agentes autônomos.
- MCP: consultas de dados com lista permitida de ferramentas; servidores locais, sem publicação pública dos endpoints.

## Geo Cinema (protótipo funcional inicial)
Na Central de Missões, escolha um destino e clique **Adicionar destino**. Repita para pelo menos dois locais, ajuste duração de 1 a 30 segundos por voo e clique **Reproduzir roteiro**. O Habblaud envia mensagens `gev:cinema-fly` para o iframe; o God's Eye View valida latitude, longitude, altitude e duração, move a câmera Cesium e responde `gev:cinema-done`. O botão **Parar** envia `gev:cinema-stop`. A lista permite remover destinos e limpar o roteiro. **Limitações:** não há ainda timeline visual, easing configurável, edição de orientação, gravação de vídeo, persistência do roteiro ou recuperação automática de uma falha do globo.

## Módulos e situação
1. Geo Cinema: primeiro roteiro de câmera experimental, ainda incompleto.
2. Geo Traffic: aproveita camadas de aeronaves existentes; painel dedicado planejado.
3. Geo Cockpit: planejado; simulações deverão ser rotuladas.
4. Geo Events: consultas MCP iniciais; filtros e histórico planejados.
5. Geo Studio: planejado.
6. Geo Explorer: CRUD de favoritos inicial; coleções e busca planejadas.
7. Geo Agents: planejamento por IA inicial; agentes independentes e auditoria planejados.
8. Geo Time Machine: planejado, condicionado a dados históricos legítimos.
9. Geo Simulator: planejado, dados simulados identificados.
10. Geo Plugins: planejado, com contratos e isolamento de extensões.

## Critérios de qualidade
Cada módulo precisa de testes automatizados, validação visual, recuperação de falhas, documentação e identificação de dados reais ou simulados antes de ser marcado concluído. A localização GPS só pode ser obtida com consentimento. O operador deve respeitar direitos, privacidade, licenças e permissões; desenvolvedores e operadores mantêm suas obrigações legais. Não publicar os servidores locais diretamente na internet.

## Testes manuais
1. Acesse o roadmap em ambos os projetos, pesquise, filtre e exporte JSON.
2. Na Central de Missões, selecione Copacabana e adicione ao roteiro; depois selecione Nova Friburgo e adicione.
3. Clique Reproduzir roteiro e observe os voos da câmera; teste Parar durante um voo.
4. Teste entrada inválida (duração menor que 1 ou maior que 30), roteiro com menos de duas paradas e remoção de destinos.
5. Verifique se favoritos, IA e camadas existentes continuam acessíveis.
