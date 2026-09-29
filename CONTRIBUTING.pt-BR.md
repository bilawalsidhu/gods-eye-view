# Como contribuir com o God's Eye View

[English](CONTRIBUTING.md) · [Guia inicial em português](README.pt-BR.md)

Este guia resume o fluxo de contribuição atual. Consulte o [CONTRIBUTING.md original](CONTRIBUTING.md) para as regras completas e mudanças recentes.

## Preparar o ambiente

Use Node.js 24.14.x ou 26.x, conforme `package.json`:

```bash
git clone https://github.com/bilawalsidhu/gods-eye-view.git
cd gods-eye-view
nvm install 24.14.0
nvm use 24.14.0
npm ci
npm run doctor
npm run dev
```

Abra `http://localhost:4173`. Não é necessária uma chave para iniciar: Esri e terreno sem chave carregam o mapa, com OSM como alternativa. Chaves opcionais podem ser adicionadas pelo painel **POWER UP**. No macOS, `./scripts/dev-fresh.sh` pode buscar chaves no Keychain.

## Onde ajudar

- **Câmeras públicas:** adicione um catálogo de outra cidade com coordenadas, atribuição e URLs de imagens registradas no servidor. O proxy não aceita URLs arbitrárias enviadas pelo cliente; veja [SECURITY.md](SECURITY.md).
- **Camadas de dados:** use as fábricas existentes em `src/layers/<family>/` como modelo para fonte, registros, controlador e renderização.
- **Comandos de voz:** os argumentos ficam em `src/voice/actionSchemas.js`, descrições do servidor em `server/providers/openai/tools.js` e execução no cliente em `src/voice/gevActions.js`. Confirme apenas ações concluídas.
- **Estilos e bugs:** shaders GLSL ficam em `src/styles/`; consulte os [problemas conhecidos](docs/KNOWN-ISSUES.md) antes de corrigir a interface.

O projeto usa JavaScript puro, CesiumJS e Vite. A montagem fica em `src/app/`, controladores de interface em `src/ui/`, camadas em `src/layers/`, fontes reutilizáveis em `src/sources/` e operações em `src/services/`. Leia [docs/CURRENT-STATE.md](docs/CURRENT-STATE.md) para o comportamento de referência.

## Verificar e enviar

Crie uma branch a partir da `main` atualizada. Use módulos ES, recuo de dois espaços, aspas simples, ponto e vírgula e JSDoc para funções públicas. Antes do PR:

```bash
npm run format
npm run format:check
npm run check:boundaries
npm run build
npm test
npm run test:track
```

`test:track` exige o servidor de desenvolvimento ativo. Rode também o teste de navegador específico do recurso alterado em `scripts/qa-*.mjs`; o cabeçalho de cada script explica os requisitos. O CI não executa esses testes de navegador por você.

Se mudar o comportamento em execução, atualize `docs/CURRENT-STATE.md` e `CHANGELOG.md`. Se alterar uma fonte de dados, registre licença e atribuição em [DATA_SOURCES.md](DATA_SOURCES.md). Não inclua dados sem direito de redistribuição. Explique no PR o que mudou e quais verificações foram executadas.

Novas camadas que aparecem em links compartilháveis exigem um token imutável no registro e no histórico de reservas. Depois de atualizar sua branch, consulte a seção **Share-link layer tokens** do [guia original](CONTRIBUTING.md#share-link-layer-tokens) e execute `npm run layer-token:next -- <layer-id>` e `npm run layer-token:check -- --base-ref origin/main` conforme as instruções.

Use dados públicos e respeite os termos das fontes. Não adicione busca por pessoas, reconhecimento facial ou rastreamento individual. As contribuições de código seguem a [licença MIT](LICENSE) do projeto.
