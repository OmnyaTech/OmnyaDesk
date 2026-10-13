import type { AgentProvider, AgentExecutionRequest, AgentExecutionResult } from '../../contracts/src/index.ts';

/** Apenas referência de contrato. O core do exemplo usa estágios simulados diretamente. */
export class MockProvider implements AgentProvider {
  readonly id = 'mock';

  async run(request: AgentExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResult> {
    if (signal.aborted) throw new Error('Execução cancelada.');
    return {
      output: `[SIMULADO] ${request.role}: ${request.prompt.slice(0, 100)}`,
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
}
