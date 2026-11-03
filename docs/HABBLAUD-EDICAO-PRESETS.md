# Geo Mission 0.4 — Cadastro, edição e exclusão de presets

**Créditos:** Walney Moreira Klein — walneyk@hotmail.com.

## Fluxo de edição
Abra `http://127.0.0.1:4747/geo-mission`, selecione um preset e clique em **Editar selecionado**. O mesmo formulário modal de cadastro será aberto com nome, latitude, longitude, altitude e observações. Salvar atualiza o registro preservando o identificador. O botão **Excluir** também está dentro do modal de edição. Para criar um favorito, use **Cadastrar preset** ou **Salvar local exibido**.

## Presets originais e favoritos
- Favoritos cadastrados são armazenados em `localStorage['habblaud-geo-presets-v1']`. Editar substitui o registro; excluir remove o favorito após confirmação.
- Os cinco destinos originais são tratados como padrões recuperáveis: alterações ficam em `habblaud-geo-builtin-overrides-v1`. Excluir um original **oculta** o destino no navegador, sem apagar sua definição de fábrica; **Restaurar original** reexibe todos os padrões ocultados.
- Os favoritos podem ser exportados/importados em JSON. **Atenção:** exportação atual cobre apenas os favoritos pessoais, não as alterações nos destinos originais.
- Nada disso é sincronizado entre navegadores nem enviado automaticamente ao GitHub.

## Testes recomendados
1. Criar um favorito, editar nome e coordenadas, salvar e recarregar a página.
2. Editar um preset original, confirmar as coordenadas novas e recarregar a página.
3. Excluir um favorito pelo modal, confirmar que desapareceu.
4. Excluir um preset original, verificar que sumiu do menu e usar **Restaurar original**.
5. Exportar/importar favoritos; testar coordenadas inválidas e falha de armazenamento.
6. Testar captura da câmera do globo; ela exige ambos os serviços em execução.

## Responsabilidades
O operador é responsável por ter autorização para usar e compartilhar fontes e coordenadas. Favoritos podem revelar locais sensíveis. Desenvolvedores e operadores mantêm suas obrigações de segurança, privacidade e conformidade. Não publique coordenadas pessoais sem consentimento.
