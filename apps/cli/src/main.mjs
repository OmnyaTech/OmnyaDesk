const base = process.env.OMNYA_URL ?? 'http://127.0.0.1:4317';
const [command, ...args] = process.argv.slice(2);
const usage = 'Uso: npm run cli -- tasks | create "Título" "Descrição" | approve <id> | reject <id>';
if (!command) { console.log(usage); process.exit(0); }
const commands = {
  tasks: () => fetch(`${base}/api/tasks`),
  create: () => fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: args[0], description: args[1] ?? '' }) }),
  approve: () => fetch(`${base}/api/tasks/${args[0]}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) }),
  reject: () => fetch(`${base}/api/tasks/${args[0]}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'reject' }) }),
};
if (!commands[command] || ((command === 'approve' || command === 'reject' || command === 'create') && !args[0])) {
  console.error(usage); process.exit(1);
}
try {
  const res = await commands[command]();
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) process.exitCode = 1;
} catch {
  console.error('API indisponível. Inicie npm run dev.');
  process.exitCode = 1;
}
