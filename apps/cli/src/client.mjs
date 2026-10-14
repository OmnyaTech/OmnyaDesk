import {randomUUID} from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/i;
const TOKEN=/^odt_[a-f0-9]{64}$/;
const LOCAL=new Set(['127.0.0.1','[::1]']);
const transitions=new Set(['cancel','approve','reject','changes-requested']);
export const usage=`OmnyaDesk CLI — API /v1 (autorização por token e projeto)
Configuração: OMNYA_TOKEN (Bearer somente no ambiente); OMNYA_URL=http://127.0.0.1:4317
Comandos:
  pnpm cli projects
  pnpm cli tasks <projectId>
  pnpm cli task <projectId> <taskId>
  pnpm cli create <projectId> <officeId> "<título>" ["descrição"] [--key UUID]
  pnpm cli cancel <projectId> <taskId> <versão> ["motivo"] --confirm [--key UUID]
  pnpm cli logs <projectId> [--after SEQUÊNCIA] [--task UUID]
  pnpm cli evidence <projectId> <taskId>
  pnpm cli reviews <projectId>
  pnpm cli review <projectId> <integrationId>
  pnpm cli approve <projectId> <taskId> <integrationId> <versão> <reviewHash> --confirm [--key UUID]
  pnpm cli reject <projectId> <taskId> <integrationId> <versão> <reviewHash> "<motivo>" --confirm [--key UUID]
  pnpm cli changes-requested <projectId> <taskId> <integrationId> <versão> <reviewHash> "<motivo>" --confirm [--key UUID]
Aprovações usam a operação ATÔMICA de revisão Git + evidência imutável + evento.
--key mantém idempotência para reenvios seguros. Nenhum comando imprime o token.
`;
export class CliError extends Error{
 constructor(message,status=2){super(message);this.exitCode=status;}
}
const need=(value,label)=>{if(!value)throw new CliError('Informe '+label);return value;};
const uuid=(value,label)=>{if(!UUID.test(need(value,label)))throw new CliError(label+' deve ser UUID válido');return value;};
const version=value=>{const n=Number(value);if(!/^[1-9][0-9]*$/.test(String(value||''))||!Number.isSafeInteger(n))throw new CliError('versão deve ser inteiro positivo');return n;};
const keyValue=(options,newUuid)=>uuid(options.key??newUuid(),'--key');
const projectPath=projectId=>'/v1/projects/'+uuid(projectId,'projectId');
const taskPath=(projectId,taskId)=>projectPath(projectId)+'/tasks/'+uuid(taskId,'taskId');
const strictArgs=(given,count,optional=0)=>{if(given.length<count||given.length>count+optional)throw new CliError('Argumentos inválidos. Execute pnpm cli help.');};
function parseArgs(argv){
 const words=[],opts={};
 for(let i=0;i<argv.length;i++){
  const token=argv[i];
  if(token==='--confirm'){if(opts.confirm)throw new CliError('--confirm duplicado');opts.confirm=true;continue;}
  if(['--key','--after','--task'].includes(token)){
   if(Object.hasOwn(opts,token.slice(2)))throw new CliError('Opção duplicada '+token);
   opts[token.slice(2)]=need(argv[++i],token);continue;
  }
  if(token.startsWith('--'))throw new CliError('Opção desconhecida '+token);
  words.push(token);
 }
 return {words,opts};
}
function checkOptions(opts,...allowed){
 for(const opt of Object.keys(opts))if(!allowed.includes(opt))throw new CliError('Opção incompatível --'+opt);
}
function parseBase(value){
 let base;
 try{base=new URL(value??'http://127.0.0.1:4317');}catch{throw new CliError('OMNYA_URL inválida');}
 if(base.protocol!=='http:'||!LOCAL.has(base.hostname)||base.username||base.password||
    base.pathname!=='/'||base.search||base.hash||!base.port)
  throw new CliError('OMNYA_URL deve apontar a HTTP localhost com porta explícita e sem path/credenciais');
 return base.origin;
}
function sanitize(error){
 const msg=typeof error==='string'?error:'Falha na API';
 return msg.replace(/odt_[a-f0-9]{64}/gi,'[TOKEN]').slice(0,160);
}
export async function executeCli(argv,{token,baseUrl='http://127.0.0.1:4317',fetcher=globalThis.fetch,newUuid=randomUUID,onMutationKey=()=>{}}={}){
 const {words,opts}=parseArgs(argv);
 const [command,...args]=words;
 if(!command||command==='help'){strictArgs(args,0);checkOptions(opts);return {help:usage};}
 const base=parseBase(baseUrl);
 if(!TOKEN.test(token??''))throw new CliError('Configure OMNYA_TOKEN com um token Bearer válido.',2);
 const http=async(method,path,{body,headers}={})=>{
  const url=new URL(path,base);
  if(url.origin!==base||!url.pathname.startsWith('/v1/'))throw new CliError('Rota fora da API local');
  let response;
  try{
   response=await fetcher(url.href,{
    method,redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(12000),
    headers:{Authorization:'Bearer '+token,Accept:'application/json',
      ...(body?{'Content-Type':'application/json'}:{}),...headers},
    ...(body?{body:JSON.stringify(body)}:{})
   });
  }catch{throw new CliError('API local indisponível; verifique OmnyaDesk em 127.0.0.1.',1);}
  if(!response.ok){
   // Never print remote response bodies (which could echo credentials or untrusted input).
   throw new CliError('API recusou '+method+' '+url.pathname+' (HTTP '+response.status+').',1);
  }
  try{return await response.json();}catch{throw new CliError('Resposta da API não é JSON.',1);}
 };
 if(command==='projects'){
  strictArgs(args,0);checkOptions(opts);
  return {result:await http('GET','/v1/projects')};
 }
 if(command==='tasks'){
  strictArgs(args,1);checkOptions(opts);
  return {result:await http('GET',projectPath(args[0])+'/tasks')};
 }
 if(command==='task'){
  strictArgs(args,2);checkOptions(opts);
  const result=await http('GET',projectPath(args[0])+'/tasks');
  const task=result.tasks?.find(t=>t.id===uuid(args[1],'taskId'));
  if(!task)throw new CliError('Tarefa não encontrada neste projeto.',1);
  return {result:{task}};
 }
 if(command==='create'){
  strictArgs(args,3,1);checkOptions(opts,'key');
  const [pid,officeId,title,description='']=args;
  uuid(officeId,'officeId');
  if(!title.trim()||title.length>140||description.length>4000)throw new CliError('Título/descrição fora dos limites.');
  const idempotencyKey=keyValue(opts,newUuid);
  onMutationKey('Idempotency-Key',idempotencyKey);
  const result=await http('POST',projectPath(pid)+'/intake',{
   headers:{'Idempotency-Key':idempotencyKey},body:{officeId,title,description}
  });
  return {result,idempotencyKey};
 }
 if(command==='cancel'){
  strictArgs(args,3,1);checkOptions(opts,'key','confirm');
  if(!opts.confirm)throw new CliError('Cancelamento exige --confirm.');
  const [pid,tid,rawVersion,reason=null]=args;
  if(reason!==null&&reason.length>2000)throw new CliError('Motivo excede 2000 caracteres');
  const commandKey=keyValue(opts,newUuid);
  onMutationKey('Command-Key',commandKey);
  return {result:await http('POST',taskPath(pid,tid)+'/transitions',
   {body:{commandKey,expectedVersion:version(rawVersion),to:'cancelled',reason}}),commandKey};
 }
 if(command==='logs'){
  strictArgs(args,1);checkOptions(opts,'after','task');
  const path=projectPath(args[0]);
  const n=opts.after===undefined?0:Number(opts.after);
  if(!/^(0|[1-9][0-9]*)$/.test(String(opts.after??0))||!Number.isSafeInteger(n))
   throw new CliError('--after exige cursor não negativo');
  if(opts.task)uuid(opts.task,'--task');
  const data=await http('GET',path+'/events?after='+n);
  return {result:{events:opts.task?(data.events??[]).filter(e=>e.taskId===opts.task):data.events??[]}};
 }
 if(command==='evidence'){
  strictArgs(args,2);checkOptions(opts);
  return {result:await http('GET',taskPath(args[0],args[1])+'/evidence')};
 }
 if(command==='reviews'){
  strictArgs(args,1);checkOptions(opts);
  return {result:await http('GET',projectPath(args[0])+'/git/integrations')};
 }
 if(command==='review'){
  strictArgs(args,2);checkOptions(opts);
  return {result:await http('GET',projectPath(args[0])+'/git/integrations/'+uuid(args[1],'integrationId'))};
 }
 if(transitions.has(command)&&command!=='cancel'){
  const decision=command==='approve'?'approved':command==='reject'?'rejected':'changes_requested';
  strictArgs(args,5,decision==='approved'?0:1);
  checkOptions(opts,'key','confirm');
  if(!opts.confirm)throw new CliError('Decisão humana exige --confirm.');
  const [pid,tid,integrationId,rawVersion,reviewHash,reason]=args;
  uuid(integrationId,'integrationId');
  if(!HASH.test(reviewHash??''))throw new CliError('reviewHash deve ser SHA256 (64 hex)');
  if(decision!=='approved'&&(!reason||reason.length>2000))throw new CliError('Motivo obrigatório (até 2000 caracteres)');
  const commandKey=keyValue(opts,newUuid);
  onMutationKey('Command-Key',commandKey);
  return {result:await http('POST',taskPath(pid,tid)+'/human-decisions',
   {body:{integrationId,commandKey,expectedVersion:version(rawVersion),
    reviewHash,decision,reason:reason??null}}),commandKey};
 }
 throw new CliError('Comando desconhecido: '+sanitize(command)+'. Execute pnpm cli help.');
}
