import assert from 'node:assert/strict';
import test from 'node:test';
import { OfficeRuntime } from '../packages/core/src/runtime.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStatus(office: OfficeRuntime, expected: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (office.listTasks()[0]?.status === expected) return;
    await sleep(5);
  }
  throw new Error(`Timeout aguardando estado: ${expected}`);
}

test('fluxo simulado vai até aprovação humana; eventos são registrados', async () => {
  const office = new OfficeRuntime(2);
  const task = office.createTask('Criar feature', 'Somente teste');
  assert.equal(task.status, 'created');
  await waitForStatus(office, 'awaiting_approval');
  const updated = office.listTasks()[0];
  assert.equal(updated.status, 'awaiting_approval');
  assert.deepEqual(office.listEvents().map((e) => e.status), [
    'created', 'planning', 'implementing', 'testing', 'reviewing', 'awaiting_approval',
  ]);
  assert.equal(office.decide(task.id, 'approve').status, 'approved');
  assert.throws(() => office.decide(task.id, 'approve'), /Transição inválida/);
});

test('rejeição é terminal no protótipo', async () => {
  const office = new OfficeRuntime(2);
  const task = office.createTask('Validar regra', 'Teste');
  await waitForStatus(office, 'awaiting_approval');
  assert.equal(office.decide(task.id, 'reject').status, 'changes_requested');
  assert.throws(() => office.decide(task.id, 'approve'), /Transição inválida/);
});

test('título vazio é rejeitado', () => {
  const office = new OfficeRuntime(1);
  assert.throws(() => office.createTask(' ', ''), /Título obrigatório/);
});
