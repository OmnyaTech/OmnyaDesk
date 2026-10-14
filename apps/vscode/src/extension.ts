import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import {isUuid,parseRequest,type HostMessage,type Project,type Task,type OfficeEvent,type Snapshot} from './protocol.js';

const SECRET_KEY='omnyadesk.readOnlyToken.v1';
const ALLOWED_STATES=new Set(['created','queued','planning','implementing','testing','reviewing',
 'awaiting_approval','approved','changes_requested','retrying','blocked','failed','cancelled','expired']);
const MAX_RESPONSE_BYTES=2_000_000;
function text(value:unknown,max=150):string{
 return typeof value==='string'?value.slice(0,max):'';
}
function validProject(item:unknown):item is Project{
 return !!item&&typeof item==='object'&&isUuid((item as Project).id)&&
 typeof (item as Project).name==='string';
}
function safeTask(item:unknown,scope:string):Task|null{
 if(!item||typeof item!=='object')return null;
 const t=item as Task;
 if(!isUuid(t.id)||t.projectId!==scope||!ALLOWED_STATES.has(t.status)||
 !Number.isSafeInteger(t.version)||t.version<1)return null;
 return {id:t.id,projectId:scope,title:text(t.title,200),status:t.status,
 version:t.version,updatedAt:text(t.updatedAt,40),createdAt:text(t.createdAt,40)};
}
function safeEvent(item:unknown,scope:string):OfficeEvent|null{
 if(!item||typeof item!=='object')return null;
 const e=item as OfficeEvent;
 if(e.schemaVersion!==1||e.projectId!==scope||!isUuid(e.taskId)||
 !Number.isSafeInteger(e.sequence)||e.sequence<1)return null;
 if(e.type!=='task.created'&&e.type!=='task.status_changed')return null;
 return {schemaVersion:1,sequence:e.sequence,projectId:scope,taskId:e.taskId,
 eventId:isUuid(e.eventId)?e.eventId:e.taskId,type:e.type,occurredAt:text(e.occurredAt,40),
 actor:{kind:text(e.actor?.kind,20)},...(e.type==='task.status_changed'?{
 payload:{from:text(e.payload?.from,32),to:text(e.payload?.to,32)}}:{})};
}

export class LocalReadGateway{
 constructor(private readonly getToken:()=>Thenable<string|undefined>,
 private readonly port:()=>number,private readonly transport:typeof fetch=globalThis.fetch){}
 private async get(path:string):Promise<unknown>{
  // Only fixed localhost paths constructed in this host; never a webview URL.
  if(!/^\/v1\/(?:projects(?:\/[a-f0-9-]+(?:\/(?:tasks|events\?after=\d+))?)?)$/i.test(path))
   throw Error('Rota de leitura inválida');
  const p=this.port();
  if(!Number.isInteger(p)||p<1024||p>65535)throw Error('Porta local inválida');
  const token=await this.getToken();
  if(!token)throw Error('Conecte um token de leitura pelo comando OmnyaDesk: Configurar token de leitura.');
  const response=await this.transport('http://127.0.0.1:'+p+path,{
   method:'GET',redirect:'error',credentials:'omit',cache:'no-store',
   headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(6000)
  });
  if(response.status===401||response.status===403)throw Error('Acesso recusado ou token revogado. Atualize o token.');
  if(!response.ok)throw Error('API local indisponível ('+response.status+').');
  if(Number(response.headers.get('content-length')||0)>MAX_RESPONSE_BYTES)
   throw Error('Resposta da API acima do limite de segurança.');
  const body=await response.text();
  if(body.length>MAX_RESPONSE_BYTES)throw Error('Resposta da API acima do limite de segurança.');
  return JSON.parse(body) as unknown;
 }
 async projects():Promise<Project[]>{
  const data=await this.get('/v1/projects') as {projects?:unknown[]};
  return Array.isArray(data?.projects)?data.projects.filter(validProject)
   .map(item=>({id:item.id,name:text(item.name,100)})).slice(0,100):[];
 }
 async snapshot(projectId:string,authorized:Project[]):Promise<Snapshot>{
  if(!isUuid(projectId)||!authorized.some(p=>p.id===projectId))
   throw Error('Projeto fora do escopo autorizado.');
  const base='/v1/projects/'+encodeURIComponent(projectId);
  const res=await this.get(base+'/tasks') as {tasks?:unknown[]};
  const tasks=Array.isArray(res?.tasks)?res.tasks.map(t=>safeTask(t,projectId))
   .filter((t):t is Task=>t!==null).slice(0,1000):[];
  const events:OfficeEvent[]=[];
  let after=0,complete=false;
  for(let i=0;i<6;i++){
   const reply=await this.get(base+'/events?after='+after) as {events?:unknown[]};
   const batch=Array.isArray(reply?.events)?reply.events:[];
   if(batch.length>500)throw Error('Lote de eventos excedeu o limite.');
   const page=batch.map(e=>safeEvent(e,projectId)).filter((e):e is OfficeEvent=>e!==null);
   if(page.some(e=>e.sequence<=after))throw Error('Histórico fora de ordem.');
   events.push(...page);
   if(batch.length<500){complete=true;break;}
   after=Math.max(after,...page.map(e=>e.sequence));
   if(after===0)throw Error('Cursor inválido.');
  }
  const project=authorized.find(p=>p.id===projectId)!;
  return {project,projects:authorized,tasks,events,historyComplete:complete,
   updatedAt:new Date().toISOString()};
 }
}

export function webviewHtml(webview:vscode.Webview,extensionUri:vscode.Uri):string{
 const folder=vscode.Uri.joinPath(extensionUri,'dist');
 const js=webview.asWebviewUri(vscode.Uri.joinPath(folder,'webview.js'));
 const css=webview.asWebviewUri(vscode.Uri.joinPath(folder,'webview.css'));
 const nonce=randomBytes(20).toString('base64url');
 return `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1">
 <meta http-equiv="Content-Security-Policy" content="default-src 'none';
 img-src ${webview.cspSource} data:; font-src ${webview.cspSource};
 style-src ${webview.cspSource}; script-src 'nonce-${nonce}';
 connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
 <link rel="stylesheet" href="${css}"><title>OmnyaDesk — Escritório</title></head>
 <body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
}

export function activate(context:vscode.ExtensionContext):void{
 const getPort=()=>vscode.workspace.getConfiguration('omnyadesk').get<number>('apiPort',4317);
 const gateway=new LocalReadGateway(()=>context.secrets.get(SECRET_KEY),getPort);
 let panel:vscode.WebviewPanel|undefined;
 let selected:string|null=null;
 let activeProjects:Project[]=[];
 let activeTasks:Task[]=[];
 let busy=false;
 let polling:ReturnType<typeof setInterval>|undefined;
 const post=(message:HostMessage)=>{if(panel)void panel.webview.postMessage(message);};
 const refresh=async(force=false)=>{
  if(busy||(!force&&!panel?.visible))return;
  busy=true;
  try{
   activeProjects=await gateway.projects();
   if(!activeProjects.length){selected=null;activeTasks=[];post({type:'waiting',message:'Nenhum projeto autorizado para este token.'});return;}
   if(!selected||!activeProjects.some(p=>p.id===selected))selected=activeProjects[0].id;
   const result=await gateway.snapshot(selected,activeProjects);
   activeTasks=result.tasks;
   post({type:'snapshot',value:result});
  }catch{
   // Do not forward network diagnostics or secrets into the less trusted webview.
   post({type:'error',message:'Sem acesso à API local ou token inválido. Execute OmnyaDesk: Configurar token de leitura.'});
  }finally{busy=false;}
 };
 const configure=async()=>{
  const token=await vscode.window.showInputBox({
   title:'OmnyaDesk — Token de leitura',prompt:'Informe token Bearer somente leitura do projeto autorizado.',
   password:true,ignoreFocusOut:true,placeHolder:'odt_…',
   validateInput:value=>/^odt_[a-f0-9]{64}$/i.test(value)?undefined:'Formato de token inválido.'
  });
  if(!token)return;
  await context.secrets.store(SECRET_KEY,token);
  void vscode.window.showInformationMessage('Credencial armazenada com segurança no SecretStorage do VS Code.');
  void refresh(true);
 };
 const open=()=>{
  if(panel){panel.reveal(vscode.ViewColumn.Beside);void refresh(true);return;}
  panel=vscode.window.createWebviewPanel('omnyadesk.office','OmnyaDesk — Escritório',
   vscode.ViewColumn.Beside,{
    enableScripts:true,retainContextWhenHidden:false,
    localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'dist')]
   });
  panel.webview.html=webviewHtml(panel.webview,context.extensionUri);
  panel.webview.onDidReceiveMessage((incoming:unknown)=>{
   const msg=parseRequest(incoming);if(!msg)return;
   if(msg.type==='ready'||msg.type==='refresh'){void refresh(true);return;}
   if(msg.type==='selectProject'){
    if(!activeProjects.some(p=>p.id===msg.projectId))return;
    selected=msg.projectId;void refresh(true);return;
   }
   if(msg.type==='inspectTask'){
    const task=activeTasks.find(t=>t.id===msg.taskId);
    post({type:'task',value:task??null});
   }
  },undefined,context.subscriptions);
  panel.onDidDispose(()=>{
   panel=undefined;selected=null;activeTasks=[];activeProjects=[];
   if(polling){clearInterval(polling);polling=undefined;}
  },undefined,context.subscriptions);
  polling=setInterval(()=>{void refresh();},8000);
  void refresh(true);
 };
 context.subscriptions.push(
  vscode.commands.registerCommand('omnyadesk.openOffice',open),
  vscode.commands.registerCommand('omnyadesk.configureToken',()=>configure()),
  vscode.commands.registerCommand('omnyadesk.disconnect',async()=>{
   await context.secrets.delete(SECRET_KEY);
   selected=null;activeProjects=[];activeTasks=[];
   post({type:'waiting',message:'Credencial local removida.'});
  }),
  {dispose:()=>{if(polling)clearInterval(polling);panel?.dispose();}}
 );
}
export function deactivate():void{}
