# Modelo mínimo de segurança

## Princípio principal

**Agentes são processos não confiáveis**. Prompts, arquivos do repositório, logs, saídas do terminal e resultados de ferramentas podem conter instruções maliciosas e não podem alterar a política do sistema.

## Limites de confiança

- O browser/Webview não guarda tokens de provedor. A extensão guarda apenas segredos locais no VS Code SecretStorage; servidor usa cofre/ambiente segregado.
- MCP gateway autenticado não concede automaticamente autoridade de escrita, shell, deploy ou aprovação.
- Worktrees isolam **arquivos Git**, não privilégios do sistema operacional. Worker precisa de sandbox/container/conta restrita com limites de CPU, memória, rede e paths.
- Não permitir paths arbitrários, travessia `../`, symlink escapes ou acesso ao `$HOME`, `.ssh`, `.env` e diretórios de credenciais.
- Nenhum agente edita o repositório principal ou faz merge/push/deploy sem aprovação explícita.
- Aprovações são checadas pelo backend contra identidade, papel, versão do diff e estado corrente. Prompt do agente não substitui aprovação.
- Estruturar limites por tarefa: token budget, custo, número de ferramentas, timeout, retries, concorrência e kill switch.
- Auditoria com payload redigido (tokens, e-mails, senhas, PII) e retention policy.
- Uso remoto somente por TLS, autenticação adequada, escopo por ferramenta/usuário, rate limit e proteção CSRF/origin conforme transporte.
- Anexos passam por tamanho/MIME/varredura, armazenamento controlado e URLs temporárias; não fornecer Webview acesso indiscriminado ao filesystem.

## Riscos conhecidos do pacote demonstrativo

- **Não autenticado**: serve exclusivamente em `127.0.0.1` e não deve ser publicado.
- **Em memória**: perda completa no reinício; não é auditoria durável.
- **Sem sandbox real**: como não executa modelos/comandos, não é apropriado evoluí-lo para execução real sem antes adicionar sandbox.
- **Sem dados reais**: não conecte contas, documentos pessoais, produção ou repositórios sensíveis neste estágio.
- **Sem verificação de integridade de artefatos**: SQL/arquitetura são especificação, não mecanismo ativo.

## Gate de segurança antes de ligar um provider real

- [ ] Token e permissão do operador corretamente verificados.
- [ ] Sandbox isolado, workspace autorizado e rede de saída restrita.
- [ ] Capture/inspecione toda alteração em diff e classifique ações sensíveis.
- [ ] Testes de prompt injection, path traversal, symlink escape e exfiltração.
- [ ] Aprovação humana ligada a hash de diff e identidade de quem aprovou.
- [ ] Timeout, custo máximo, concorrência e kill switch comprovados.
