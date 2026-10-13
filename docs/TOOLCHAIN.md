# S02 — Toolchain de desenvolvimento

Status: implementado no starter após S01. Este guia **não** indica que o produto já possui agentes reais, banco persistente ou acesso remoto.

## Requisitos verificados localmente (developer-workstation)

- Windows, Node.js 24.13.1; requisito do projeto Node >= 22.16.0
- pnpm 10.18.0, versão declarada em `packageManager`
- TypeScript 5.9.3 e ESLint 9.39.1 com tipos Node.js; dependências de desenvolvimento pinadas por versão e `pnpm-lock.yaml` versionado
- Git 2.53.0.windows.1

## Fluxo recomendado

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm run dev
```

`pnpm run check` executa sequencialmente lint, typecheck, testes unitários, compilação e smoke test da API compilada. Execução compilada alternativa:

```powershell
pnpm run build
pnpm start
```

O artefato `dist/` é gerado localmente e **não** versionado. O build reescreve as extensões relativas de importação TypeScript para JavaScript e copia `apps/web/index.html` para o caminho esperado no executável.

## CI

`.github/workflows/quality.yml` foi configurado para `main`, pull requests e execução manual no GitHub Actions com Node 24, pnpm 10.18.0 e instalação por lockfile imutável. O workflow chama `pnpm run check`.

**Status CI remoto:** não executado: nesta etapa há apenas repositório Git local e não foi configurado nem publicado um remote. A validação feita é o mesmo pipeline executado no Windows com exit code 0, mais `pnpm install --frozen-lockfile --offline` com exit code 0.

## QA / observações

- Os testes históricos continham um atraso fixo `sleep(65)`; substituído por polling com prazo para aguardar o status observável da tarefa. Isso evita falso negativo sob carga.
- Uma execução do pipeline falhou inicialmente no lint por variável de `catch` não utilizada; removida, mantendo o comportamento.
- O primeiro teste após o lint detectou o teste temporalmente instável; corrigido e revalidado no pipeline completo.
- A API do demo segue em memória e sem autenticação, apenas para loopback. **Nunca usar esse mock com Cloudflare Tunnel**.
- O `docker-compose.yml` e seu segredo de demonstração não constituem uma configuração de produção. Não implantar antes dos gates de segurança.
- ESLint 9 foi avisado como fora da janela de suporte pelo gerenciador no momento da instalação; a versão foi pinada para compatibilidade e deve ser reavaliada numa sprint futura após testar ESLint 10 e TypeScript ESLint atualizados. Não comprometer reproducibilidade mudando versões sem revisão.
- O workflow remoto depende de um futuro repositório GitHub. Nunca presumir PASS no GitHub sem run registrado.

## Escopo e pendências

A S02 implanta toolchain, Git e qualidade técnica, **não** implementa a modelagem avançada do domínio, banco, engine de agentes, Docker no servidor ou interfaces pixeladas. Próxima sprint planejada: S03 — domínio e contratos.
