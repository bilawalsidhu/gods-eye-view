# Manual 23 — Cadastro de presets e favoritos geográficos (Geo Mission 0.3)

**Integração:** Walney Moreira Klein — walneyk@hotmail.com. Respeitar créditos e licenças originais.

## O que é
O Geo Mission permite cadastrar locais favoritos com nome, latitude, longitude, altitude da câmera e observações. Os presets são salvos em `localStorage` no navegador do Habblaud, não em banco de dados e não sincronizam entre dispositivos. Limite de 200 favoritos. Há exportação e importação em JSON para backup e compartilhamento voluntário.

## Como cadastrar
Abra `http://127.0.0.1:4747/geo-mission`. Clique **Cadastrar preset**, informe nome, coordenadas e altitude, e confirme. Para guardar o lugar que está vendo no globo incorporado, navegue até ele e clique **Salvar local exibido**: o Habblaud solicita à câmera Cesium as coordenadas e abre o formulário preenchido. O usuário pode editar o nome e confirmar. Para navegar, selecione o favorito no menu e clique **Viajar no globo**. Para excluir, selecione um favorito e clique **Excluir selecionado**. Presets originais não são excluídos.

## Como funciona a ponte da câmera
O God's Eye View, em `src/app/embed.js`, responde à mensagem `gev:camera-request` com `gev:camera-response` contendo latitude, longitude, altitude, heading e pitch da câmera. A Central valida `event.origin`, `event.source` e um identificador de requisição antes de aceitar a resposta. Não se trata de geolocalização do usuário: é a posição da câmera do mapa. A resposta não é armazenada até o usuário confirmar o cadastro.

## Exportação e importação
**Exportar** baixa `geo-mission-presets.json`. **Importar** aceita JSON com `schemaVersion:1` e `presets` válidos; cada preset deve ter nome, lat, lon, alt e notes. Há validação de faixa e tamanho. Nunca importe arquivos desconhecidos sem verificar sua origem.

## Português brasileiro
O fork brasileiro do God's Eye View usa `pt-BR` como idioma padrão, mantendo seleção manual e `?lang=` para outros idiomas. A Central de Missões solicita explicitamente `lang=pt-BR` ao incorporar o globo. A tradução existente em `src/i18n/locales/pt-BR.json` é preservada. Textos ainda sem entrada no catálogo podem continuar em inglês; é necessário revisar a cobertura do catálogo antes de afirmar tradução integral.

## Testes
1. Atualize o Habblaud com Ctrl+Shift+R e teste os 5 presets iniciais.
2. Cadastre um local manualmente, navegue até ele e atualize a página: o favorito deve permanecer.
3. Mova a câmera no globo e clique **Salvar local exibido**: confira os campos preenchidos.
4. Exporte o JSON, exclua um favorito, importe o arquivo e verifique se ele voltou.
5. Teste latitude fora de -90..90, longitude fora de -180..180 e JSON inválido: devem ser recusados.
6. Abra o God's Eye View completo e verifique se o idioma padrão é português brasileiro.
7. Sem o servidor do globo, o cadastro manual continua possível; capturar câmera não funciona e deve exibir aviso.

## Privacidade e responsabilidade
O cadastro manual não usa GPS. A opção separada **Usar minha localização** requer permissão do navegador. Presets exportados podem revelar locais pessoais; o usuário deve decidir conscientemente se deseja compartilhá-los. O acesso a dados externos exige autorização, cumprimento de termos, licenças e leis aplicáveis. Isso não afasta as obrigações de segurança dos desenvolvedores e operadores.

**Limites conhecidos:** presets salvos na Central não são automaticamente compartilhados com o armazenamento do domínio God's Eye View; o link no lançador do God's Eye View abre a Central para gerenciá-los. A captura da câmera está disponível no globo incorporado, não no globo completo em outra aba.
