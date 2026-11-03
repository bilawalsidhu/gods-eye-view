# Integração oficial do fork: Habblaud ↔ God's Eye View (laboratório)

**Status:** integração experimental documentada neste fork; não é funcionalidade oficial do projeto original de terceiros nem certificação de segurança. **Créditos da integração:** Walney Moreira Klein — walneyk@hotmail.com. Preservar os autores e licenças originais.

## Objetivo
O God's Eye View fornece dados e ferramentas de consulta geoespacial via MCP local; o Habblaud utiliza essas ferramentas para solicitar dados e opcionalmente enviar um recorte ao modelo de IA escolhido pelo usuário. A conexão é de mão dupla na experiência: o God's Eye View apresenta um atalho para abrir o laboratório do Habblaud, enquanto o Habblaud consulta o MCP do God's Eye View. **Não há ainda orquestração autônoma entre múltiplos agentes nem controle remoto bidirecional do globo.**

## Como utilizar
1. Instale dependências e inicie o God's Eye View na porta 4173, conforme README e configuração de APIs do projeto. Use fontes gratuitas quando disponíveis.
2. Inicie o Habblaud e abra `/geo-lab` na porta configurada.
3. No God's Eye View, utilize o painel **Habblaud · Geo Intelligence** para abrir a central (a porta padrão do atalho é 3000, configurável no painel).
4. Na central, selecione uma ferramenta, consulte os dados e revise a resposta antes de enviar ao agente. O envio a um provedor de IA exige confirmação.
5. Para usar outro diretório local do God's Eye View, configure `GODS_EYE_ROOT` no ambiente do processo Habblaud.

## Responsabilidades e limites de acesso
**A pessoa ou organização que utiliza a ferramenta é responsável por verificar se possui autorização legal, contratual e técnica para acessar, processar, armazenar e compartilhar cada fonte de dados e cada sistema.** Deve respeitar licenças, termos de serviço, cotas, privacidade, proteção de dados e legislação aplicável. É proibido utilizar a integração para acesso não autorizado, perseguição, vigilância indevida, invasão ou exposição de informações privadas. Não há garantia de que um dado público seja atualizado, completo ou preciso.

**Essa responsabilidade do usuário não elimina as obrigações dos desenvolvedores e operadores** de proteger credenciais, corrigir falhas de segurança, informar limites conhecidos, obter consentimentos aplicáveis e cumprir as leis pertinentes. O software não concede acesso a dados privados, não contorna autenticação nem cria permissões inexistentes.

## Segurança e custo
A ponte MCP é local, somente leitura e utiliza uma lista explícita de ferramentas. Não aceita nomes arbitrários de ferramentas enviados pelo navegador. Os dados de consultas podem ser enviados ao provedor IA configurado somente após confirmação; isso pode consumir cota gratuita ou gerar cobrança. A ausência de pagamento não garante disponibilidade de API. Não exponha a ponte à internet sem autenticação, controles de acesso e revisão de segurança.

## Arquivos para programadores
- Habblaud: `server/geo-bridge.ts`, `community/geo-lab.html`, `server/index.ts`, `manuais/19-geo-intelligence.html`.
- God's Eye View: `server/mcp/stdio.js`, `server/mcp/server.js`, `src/tools/index.js`, `index.html`.
- O fluxo MCP é `initialize` → `notifications/initialized` → `tools/call`.
- Ao adicionar ferramentas, consulte o esquema de entrada real no catálogo, valide todos os parâmetros e atualize a allowlist.
- Antes de declarar integração homologada, teste a comunicação com o God's Eye View em execução, a fonte externa e o modelo IA configurado.

## Estado atual
TypeScript e build do Habblaud foram aprovados anteriormente; o teste MCP ponta a ponta depende da instalação das dependências do God's Eye View e de sua execução local. Não confundir interface criada com integração integralmente homologada.
