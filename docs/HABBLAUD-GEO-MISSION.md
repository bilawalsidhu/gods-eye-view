# Geo Mission 0.2 — experiência cinematográfica Habblaud + God's Eye View

**Créditos da integração:** Walney Moreira Klein — walneyk@hotmail.com. Respeitar autoria e licenças originais de Habblaud e God's Eye View.

## Funcionalidade demonstrável
Acesse `http://127.0.0.1:4747/geo-mission` com os dois servidores locais ativos (God's Eye View em `http://127.0.0.1:4173`). A central apresenta o globo do God's Eye View em um iframe, destinos geográficos predefinidos, latitude/longitude customizadas, geolocalização opcional mediante consentimento e um painel com Aurora, Byte e Atlas. Ao clicar em **Viajar no globo**, atualiza-se a URL da câmera do God's Eye View; o nível de detalhe depende de dados e tokens Cesium configurados. O botão **Consultar terremotos reais** usa a ponte MCP, com resposta de fonte externa e possível link de visualização. **Reunir agentes e planejar** usa uma única chamada ao modelo configurado, solicitando uma resposta organizada por papéis. A equipe visual ainda não corresponde a três agentes autônomos.

## Privacidade e segurança
A localização do navegador é solicitada apenas após clique explícito e confirmação. A central não persiste coordenadas. Não envia coordenadas privadas automaticamente para IA. Ao utilizar IA, uma confirmação separada informa que a missão e o nome público do destino serão enviados ao provedor escolhido. O navegador pode transmitir dados de conexão aos serviços de mapas do God's Eye View; consulte suas políticas. A responsabilidade pelo uso de fontes e acesso autorizado é de quem opera o software, sem excluir as obrigações dos desenvolvedores e operadores de segurança, privacidade e conformidade. A integração não dá acesso a câmeras privadas nem permite rastrear pessoas.

## Testes
No Habblaud: `npm run typecheck`, `npm run build`, abrir `/geo-mission` e `/geo-lab`. No God's Eye View: `npm install` e iniciar Vite na porta 4173. O teste direto MCP de terremotos foi aprovado com dados reais e 30 ferramentas descobertas. Verifique manualmente a navegação de destinos, o iframe e o provedor de IA; a aprovação do build não comprova o fluxo visual nem a resposta de IA. Teste os erros: serviço do globo desligado, provedor ausente, geolocalização negada, ferramenta MCP indisponível.

## Próximas etapas para produção
Implementar canal autenticado de comandos de câmera em vez de trocar a URL do iframe, orquestrador multiagente real com sessões isoladas, auditoria, testes E2E de navegador, controles de custo e permissões por ferramenta, modo de hospedagem seguro com TLS e autenticação, documentação de implantação e revisão jurídica das fontes. **Não expor publicamente o serviço local atual.**
