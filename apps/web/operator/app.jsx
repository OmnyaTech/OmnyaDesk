import {useCallback,useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';
import {WindowExperience} from './WindowExperiences.jsx';
import {AttachmentPanel} from './AttachmentPanel.jsx';
import {REPLAY_MAX_EVENTS} from './world/projector.mjs';
const STATUSES={
 created:['Criada','neutral'],queued:['Na fila','neutral'],planning:['Planejamento','active'],
 implementing:['Desenvolvimento','active'],testing:['Testes','active'],
 reviewing:['Revisão','active'],awaiting_approval:['Aguardando aprovação','warning'],
 approved:['Aprovada','success'],changes_requested:['Ajustes solicitados','warning'],
 retrying:['Repetindo','warning'],blocked:['Bloqueada','danger'],
 failed:['Falhou','danger'],cancelled:['Cancelada','neutral'],expired:['Expirada','danger']
};
const fmtDate=value=>{if(!value)return '—';const date=new Date(value);
 return Number.isNaN(date.valueOf())?'—':new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(date);};
const shortId=id=>id?String(id).slice(0,8)+'…':'—';
const badge=(status)=>{const [label,kind]=STATUSES[status]??[String(status||'Desconhecido'),'neutral'];
 return <span className={'status status--'+kind}>{label}</span>;};
const desktopMode=typeof window!=='undefined'&&Boolean(window.__TAURI__?.core?.invoke);
const desktopInvoke=(command,args={})=>window.__TAURI__.core.invoke(command,args);
const displayError=error=>{
 const message=typeof error==='string'?error:error instanceof Error?error.message:'';
 if(/Workstation session is invalid or expired|Workstation not enrolled/i.test(message))
  return 'A inscrição da estação foi recusada ou expirou. Use uma nova chave de inscrição válida.';
 if(/Local API unavailable/i.test(message))
  return 'A API local do OmnyaDesk está indisponível. Inicie o backend antes de conectar.';
 return message||'Não foi possível concluir a operação. Verifique a conexão e tente novamente.';
};
const route=(projectId,path='')=>'/v1/projects/'+encodeURIComponent(projectId)+path;
async function request(token,path,signal){
 if(desktopMode)return desktopInvoke('desktop_read',{path});
 const response=await fetch(path,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},
  credentials:'omit',cache:'no-store',signal});
 if(!response.ok){
  if(response.status===401)throw new Error('Credencial inválida, expirada ou revogada.');
  if(response.status===403)throw new Error('Este token não possui permissão para esta consulta.');
  if(response.status===404)throw new Error('Recurso não encontrado neste projeto.');
  throw new Error('Falha na consulta ('+response.status+').');
 }
 return response.json();
}
const sliceCursor=data=>{const id=Number(data);return Number.isSafeInteger(id)&&id>=0?id:0;};
async function connectStream(token,projectId,onNew,signal){
 let last=0;
 while(!signal.aborted){
  try{
   const headers={Authorization:'Bearer '+token,Accept:'text/event-stream'};
   if(last)headers['Last-Event-ID']=String(last);
   const response=await fetch(route(projectId,'/stream'),{
    headers,signal,credentials:'omit',cache:'no-store'
   });
   if(response.status===401||response.status===403)return onNew('denied');
   if(!response.ok||!response.body)throw new Error('Stream unavailable');
   onNew('online');
   const reader=response.body.getReader(),decoder=new TextDecoder();
   let buffer='';
   while(!signal.aborted){
    const {done,value}=await reader.read();if(done)break;
    buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');
    if(buffer.length>65536)throw new Error('SSE frame too large');
    let cut;
    while((cut=buffer.indexOf('\n\n'))>=0){
     const frame=buffer.slice(0,cut);buffer=buffer.slice(cut+2);
     const match=frame.match(/^id:\s*(\d+)$/m);
     const eventType=frame.match(/^event:\s*(\S+)$/m);
     if(match&&eventType?.[1]==='office'){
      const seq=sliceCursor(match[1]);if(seq<=last)continue;last=seq;onNew('event');
     }
    }
   }
  }catch{
   if(signal.aborted)return;
   onNew('offline');
  }
  if(signal.aborted)return;
  await new Promise(resolve=>{const timer=setTimeout(resolve,1800);
   signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
 }
}
function Icon({name,size=18}){const shapes={
 grid:<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
 layers:<><rect x="3" y="3" width="18" height="5" rx="1"/><rect x="3" y="10" width="18" height="5" rx="1"/><rect x="3" y="17" width="18" height="4" rx="1"/></>,
 shield:<><path d="M12 22S4 18 4 11V5l8-3 8 3v6c0 7-8 11-8 11Z"/><path d="m9 12 2 2 4-4"/></>,
 activity:<><polyline points="2 12 7 12 10 4 14 20 17 12 22 12"/></>,
 refresh:<><path d="M20 11a8 8 0 0 0-15-3L2 11"/><path d="M2 5v6h6"/><path d="M4 13a8 8 0 0 0 15 3l3-3"/><path d="M22 19v-6h-6"/></>,
 lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
 arrow:<><path d="m9 18 6-6-6-6"/></>,
 logout:<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></>,
 file:<><path d="M5 3h9l5 5v13H5Z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h8"/></>,
 clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>
 };return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg>;}
function App(){
 const [credential,setCredential]=useState('');
 const [windowPrefs,setWindowPrefs]=useState({mode:'full',alwaysOnTop:false});
 const [windowActionBusy,setWindowActionBusy]=useState(false);
 useEffect(()=>{if(!desktopMode)return;
  let alive=true;
  desktopInvoke('desktop_window_state').then(data=>{if(alive&&data?.mode)setWindowPrefs(data);}).catch(()=>{});
  return()=>{alive=false;};
 },[]);
 useEffect(()=>{
  if(!desktopMode)return;
  document.documentElement.dataset.officeMode=windowPrefs.mode;
  return()=>{delete document.documentElement.dataset.officeMode;};
 },[windowPrefs.mode]);
 const desktopWindowAction=async(command,args={})=>{
  setWindowActionBusy(true);setError('');
  try{const value=await desktopInvoke(command,args);if(value?.mode)setWindowPrefs(value);}
  catch(e){setError(displayError(e));}
  finally{setWindowActionBusy(false);}
 };
 const [desktopProjects,setDesktopProjects]=useState([]);
 const [token,setToken]=useState(null),[project,setProject]=useState(null);
 const [tasks,setTasks]=useState([]),[events,setEvents]=useState([]);
 const [eventHistory,setEventHistory]=useState([]),[historyComplete,setHistoryComplete]=useState(true);
 const [selectedId,setSelectedId]=useState(null),[evidences,setEvidences]=useState([]);
 const [filter,setFilter]=useState('all'),[search,setSearch]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [connection,setConnection]=useState('offline'),[lastRefresh,setLastRefresh]=useState(null);
 const disconnect=useCallback(()=>{if(desktopMode)void desktopInvoke('desktop_logout').catch(()=>{});
  setDesktopProjects([]);setToken(null);setCredential('');setProject(null);
  setTasks([]);setEvents([]);setEventHistory([]);setHistoryComplete(true);setSelectedId(null);setEvidences([]);setConnection('offline');
  setError('');},[]);
 const load=useCallback(async(secret,scopeId,signal)=>{
  const taskData=await request(secret,route(scopeId,'/tasks'),signal);
  const history=[];let after=0,complete=false;
  while(history.length<REPLAY_MAX_EVENTS){
   const page=await request(secret,route(scopeId,'/events?after='+after),signal);
   const batch=Array.isArray(page.events)?page.events:[];
   if(!batch.every(event=>Number.isSafeInteger(event.sequence)&&event.sequence>after))
    throw new Error('Sequência inválida ao recuperar eventos persistidos.');
   history.push(...batch);
   if(batch.length<500){complete=true;break;}
   after=batch[batch.length-1].sequence;
  }
  if(signal?.aborted)return;
  setTasks(Array.isArray(taskData.tasks)?taskData.tasks:[]);
  setEventHistory(history.slice(0,REPLAY_MAX_EVENTS));
  setHistoryComplete(complete);
  setEvents(history.slice(-500).reverse());
  setLastRefresh(new Date().toISOString());
 },[]);
 const activateDesktop=async(projects,id)=>{
  const active=projects.find(p=>p.id===id)||projects[0];
  if(!active){setProject(null);setToken('desktop');return;}
  await desktopInvoke('desktop_select',{projectId:active.id});
  await load('desktop',active.id);
  setProject(active);setToken('desktop');
 };
 useEffect(()=>{if(!desktopMode)return;let disposed=false;
  desktopInvoke('desktop_restore').then(async result=>{
   if(disposed)return;
   const projects=Array.isArray(result.projects)?result.projects:[];
   setDesktopProjects(projects);await activateDesktop(projects);
  }).catch(()=>{});
  return()=>{disposed=true;};
 },[]);
 const registerFolder=async()=>{setBusy(true);setError('');
  try{await desktopInvoke('desktop_register');const response=await desktopInvoke('desktop_restore');
   const projects=Array.isArray(response.projects)?response.projects:[];
   setDesktopProjects(projects);await activateDesktop(projects,projects.at(-1)?.id);
  }catch(e){setError(displayError(e));}finally{setBusy(false);}
 };
 const switchDesktop=async id=>{setBusy(true);setError('');
  try{await activateDesktop(desktopProjects,id);}catch(e){setError(displayError(e));}finally{setBusy(false);}
 };
 const submit=async(ev)=>{
  ev.preventDefault();setBusy(true);setError('');
  try{
   if(desktopMode){
    if(!/^ods_[a-f0-9]{64}$/.test(credential.trim()))throw new Error('Informe a chave de inscrição da estação.');
    const response=await desktopInvoke('desktop_login',{value:credential.trim()});
    const projects=Array.isArray(response.projects)?response.projects:[];
    setDesktopProjects(projects);await activateDesktop(projects);setCredential('');return;
   }
   if(!/^odt_[a-f0-9]{64}$/.test(credential.trim()))throw new Error('Informe uma credencial Bearer válida.');
   const value=credential.trim();const response=await request(value,'/v1/projects');
   const active=response.projects?.[0];
   if(!active?.id)throw new Error('Nenhum projeto associado a este token.');
   await load(value,active.id);
   setProject(active);setToken(value);setCredential('');
  }catch(e){setError(displayError(e));}
  finally{setBusy(false);}
 };
 useEffect(()=>{
  if(!token||!project?.id)return;
  if(desktopMode){
   let stopped=false,working=false,after=0,online=false;
   const poll=async()=>{if(stopped||working)return;working=true;
    try{const result=await desktopInvoke('desktop_poll',{after});
     if(stopped)return;
     const batch=Array.isArray(result.events)?result.events:[];
     if(batch.length){after=Math.max(after,...batch.map(e=>e.sequence||0));await load('desktop',project.id);}
     if(!stopped){if(!online){online=true;await load('desktop',project.id);}setConnection('online');}
    }catch{if(!stopped){online=false;setConnection('offline');}}
    finally{working=false;}
   };
   void poll();const timer=setInterval(()=>{void poll();},1800);
   return()=>{stopped=true;clearInterval(timer);};
  }
  const controller=new AbortController(),id=project.id;
  let refreshing=false,pending=false,streamOpen=false;
  const resync=()=>{
   pending=true;if(refreshing)return;
   refreshing=true;setConnection('syncing');
   void (async()=>{
    try{
     while(pending&&!controller.signal.aborted){
      pending=false;
      await load(token,id,controller.signal);
     }
     if(!controller.signal.aborted)setConnection(streamOpen?'online':'offline');
    }catch{if(!controller.signal.aborted)setConnection('offline');}
    finally{refreshing=false;}
   })();
  };
  void connectStream(token,id,status=>{
   if(controller.signal.aborted)return;
   if(status==='denied'){disconnect();setError('A sessão foi revogada. Reconecte com um novo token.');return;}
   if(status==='offline'){streamOpen=false;setConnection('offline');return;}
   if(status==='online'){streamOpen=true;resync();return;}
   if(status==='event'&&streamOpen)resync();
  },controller.signal);
  return()=>controller.abort();
 },[token,project?.id,load,disconnect]);
 const inspectTask=useCallback(id=>{setSelectedId(id);
  requestAnimationFrame(()=>document.querySelector('.detail-surface')?.scrollIntoView({behavior:'smooth',block:'start'}));
 },[]);
 const selected=tasks.find(task=>task.id===selectedId)||null;
 useEffect(()=>{
  if(!token||!project?.id||!selected?.id){setEvidences([]);return;}
  const controller=new AbortController();setEvidences([]);
  request(token,route(project.id,'/tasks/'+encodeURIComponent(selected.id)+'/evidence'),controller.signal)
   .then(data=>{if(!controller.signal.aborted)setEvidences(Array.isArray(data.evidence)?data.evidence:[]);})
   .catch(err=>{if(!controller.signal.aborted)setError(displayError(err));});
  return()=>controller.abort();
 },[token,project?.id,selected?.id]);
 const visible=useMemo(()=>tasks.filter(task=>
  (filter==='all'||(filter==='active'?['planning','implementing','testing','reviewing','retrying'].includes(task.status):
   filter==='review'?task.status==='awaiting_approval':task.status===filter))&&
  (task.title||'').toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))),[tasks,filter,search]);
 const selectedEvents=useMemo(()=>events.filter(e=>e.taskId===selectedId).slice(0,20),[events,selectedId]);
 const counts={active:tasks.filter(t=>['planning','implementing','testing','reviewing','retrying'].includes(t.status)).length,
  review:tasks.filter(t=>t.status==='awaiting_approval').length,
  done:tasks.filter(t=>t.status==='approved').length};
 const openModeTask=id=>{if(desktopMode&&windowPrefs.mode!=='full')void desktopWindowAction('desktop_window_mode',{mode:'full'});inspectTask(id);};
 const showModeExperience=desktopMode&&!!project&&!!token&&windowPrefs.mode!=='full';
 const refresh=async()=>{if(!token||!project)return;setBusy(true);setError('');
  try{await load(token,project.id);}catch(e){setError(displayError(e));}finally{setBusy(false);}};
 return <div className="app" data-layout-active={showModeExperience?'true':'false'}>
  <aside className="rail">
   <div className="brand"><div className="brand-logo">O<span>✦</span></div><div><strong>OmnyaDesk</strong><small>CONTROL CENTER</small></div></div>
   <p className="rail-caption">WORKSPACE</p>
   <nav aria-label="Navegação principal">
    <a href="#overview" className="nav-item selected"><Icon name="grid"/> Visão geral</a>
    <a href="#tasks" className="nav-item"><Icon name="layers"/> Projetos e tarefas</a>
    <a href="#world" className="nav-item"><Icon name="grid"/> Escritório 2D</a>
    <a href="#timeline" className="nav-item"><Icon name="activity"/> Linha do tempo</a>
    <a href="#evidence" className="nav-item"><Icon name="shield"/> Evidências</a>
   </nav>
   <div className="rail-foot"><span className="rail-avatar">OD</span><div><strong>Operação local</strong><small>API autenticada • v1</small></div></div>
  </aside>
  <div className="workspace">
   <header className="topbar"><div><span className="eyebrow">OMNYATECH / OPERAÇÕES</span><h1 id="overview">Painel operacional <span className="h1-star">✦</span></h1><p>Visibilidade real de projetos, execuções e evidências auditáveis.</p></div>
    <div className="top-actions">{desktopMode&&<div className="desktop-window-controls" role="group" aria-label="Modos da janela do OmnyaDesk">
     {[['full','Completo'],['compact','Compacto'],['floating','Flutuante'],['taskbar','Taskbar']].map(([mode,name])=><button key={mode} type="button" className={windowPrefs.mode===mode?'active':''} aria-pressed={windowPrefs.mode===mode} disabled={windowActionBusy} onClick={()=>desktopWindowAction('desktop_window_mode',{mode})}>{name}</button>)}
     <button type="button" className={windowPrefs.alwaysOnTop?'active':''} aria-pressed={windowPrefs.alwaysOnTop} disabled={windowActionBusy} onClick={()=>desktopWindowAction('desktop_always_on_top',{enabled:!windowPrefs.alwaysOnTop})}>Sempre no topo</button>
     <button type="button" onClick={()=>desktopWindowAction('desktop_minimize_to_tray')} disabled={windowActionBusy}>Bandeja</button>
    </div>}<span className={'connection '+(connection==='online'?'connected':'')} role="status"><span className="dot"/>{!token?'Desconectado':connection==='online'?(desktopMode?'Sincronização ativa':'Tempo real ativo'):(desktopMode?'Aguardando API local':'Aguardando stream')}</span>{token&&<button className="icon-button" title="Atualizar painel" aria-label="Atualizar painel" onClick={refresh} disabled={busy}><Icon name="refresh"/></button>}{token&&<button className="disconnect" onClick={disconnect}><Icon name="logout"/> Sair</button>}</div>
   </header>
   {!token?<main className="login-wrap"><div className="login-card">
    <span className="login-icon"><Icon name="lock" size={28}/></span>
    <span className="eyebrow">ACESSO DE OPERADOR</span><h2>Conecte seu projeto</h2>
    <p>{desktopMode?'Inscreva esta estação uma única vez. A chave fica no Gerenciador de Credenciais do Windows; tokens dos projetos nunca chegam à interface.':'Utilize um token Bearer de leitura emitido para seu projeto. A credencial permanece somente na memória desta aba; não é salva no navegador nem enviada para outros domínios.'}</p>
    <form onSubmit={submit}><label htmlFor="access-token">{desktopMode?'Chave de inscrição da estação':'Token de acesso'}</label><input id="access-token" type="password" autoComplete="off" spellCheck="false" required value={credential} onChange={e=>setCredential(e.target.value)} placeholder={desktopMode?'ods_••••••••••••••••':'odt_••••••••••••••••'} aria-describedby="access-help"/><small id="access-help">{desktopMode?'Inscrição única, emissão temporária de acesso somente leitura por projeto autorizado.':'Escopos necessários: projects:read, tasks:read e events:read.'}</small>
    {error&&<p className="form-error" role="alert">{error}</p>}<button className="primary full" type="submit" disabled={busy}>{busy?'Conectando…':'Conectar com segurança'} <Icon name="arrow"/></button></form>
    </div></main>:desktopMode&&!project?<main className="main"><section className="surface desktop-onboarding">
      <span className="eyebrow">ESTAÇÃO AUTENTICADA</span><h2>Cadastre seu primeiro projeto</h2>
      <p>Selecione uma pasta no Windows. O servidor validará a pasta contra as raízes explicitamente autorizadas; não são necessárias novas chaves por projeto.</p>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <button className="primary" disabled={busy} onClick={registerFolder}>Escolher pasta do projeto</button>
     </section></main>:<main className={'main '+(showModeExperience?'main--window-experience':'')} aria-live="off">
    {showModeExperience?<WindowExperience mode={windowPrefs.mode} project={project} tasks={tasks} events={eventHistory} historyComplete={historyComplete} connection={connection} counts={counts} onInspectTask={openModeTask} onMode={mode=>desktopWindowAction('desktop_window_mode',{mode})} onTop={enabled=>desktopWindowAction('desktop_always_on_top',{enabled})} onTray={()=>desktopWindowAction('desktop_minimize_to_tray')} alwaysOnTop={windowPrefs.alwaysOnTop}/>:<>
    {error&&<div className="alert" role="alert">{error}<button aria-label="Fechar aviso" onClick={()=>setError('')}>×</button></div>}
    <div className="project-banner"><div className="project-mark"><Icon name="layers" size={22}/></div><div className="project-summary"><span className="eyebrow">PROJETO AUTORIZADO</span><h2>{project.name}</h2><span>ID {shortId(project.id)} · Acesso limitado ao projeto do token</span></div><div className="banner-right"> <span className="mini-label">DADOS DE ORIGEM</span><strong>PostgreSQL / API v1</strong><small>Última consulta: {fmtDate(lastRefresh)}</small></div></div>
    {desktopMode&&<div className="desktop-projects"><label htmlFor="native-project">Projeto local</label><select id="native-project" value={project.id} onChange={e=>{void switchDesktop(e.target.value);}} disabled={busy}>{desktopProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><button type="button" className="secondary" disabled={busy} onClick={registerFolder}>Adicionar pasta…</button></div>}
    <WindowExperience mode="full" project={project} tasks={tasks} events={eventHistory} historyComplete={historyComplete} connection={connection} counts={counts} onInspectTask={inspectTask}/>
    {tasks.some(task=>['awaiting_approval','blocked','failed','changes_requested'].includes(task.status))&&<section className="intervention-panel" aria-label="Alertas de intervenção" role="region">
     <h2>Intervenção necessária</h2><p>Alertas baseados exclusivamente no estado persistido. Aprovações permanecem protegidas pelo fluxo S15.</p>
     <ul>{tasks.filter(task=>['awaiting_approval','blocked','failed','changes_requested'].includes(task.status)).map(task=><li key={task.id}>
      {badge(task.status)} <span>{task.title}</span><button type="button" onClick={()=>inspectTask(task.id)}>Ver eventos e evidências</button>
     </li>)}</ul>
    </section>}
    <section className="metrics" aria-label="Indicadores do projeto">
     <div className="metric"><div className="metric-head">Total de tarefas <Icon name="layers"/></div><strong>{tasks.length}</strong><small>Registradas neste projeto</small></div>
     <div className="metric"><div className="metric-head">Em execução <Icon name="activity"/></div><strong>{counts.active}</strong><small>Etapas ativas reportadas</small></div>
     <div className="metric"><div className="metric-head">Aguardando revisão <Icon name="clock"/></div><strong className="amber">{counts.review}</strong><small>Exigem decisão humana</small></div>
     <div className="metric"><div className="metric-head">Aprovadas <Icon name="shield"/></div><strong className="mint">{counts.done}</strong><small>Estados persistidos</small></div>
    </section>
    <div className="content-grid">
     <section className="surface task-surface" id="tasks" aria-label="Tarefas do projeto">
      <div className="surface-heading"><div><span className="eyebrow">FLUXO DE TRABALHO</span><h2>Tarefas do projeto <span className="count">{visible.length}</span></h2></div><button className="secondary" onClick={refresh} disabled={busy}><Icon name="refresh" size={15}/> Atualizar</button></div>
      <div className="toolbar"><label className="search-label"><span className="sr-only">Buscar por título</span><input placeholder="Buscar tarefa por título…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
       <label className="sr-only" htmlFor="status-filter">Filtrar por status</label><select id="status-filter" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Todos os status</option><option value="active">Em execução</option><option value="review">Aguardando revisão</option><option value="approved">Aprovadas</option><option value="failed">Falharam</option><option value="blocked">Bloqueadas</option></select></div>
      <div className="task-table-wrap"><table><thead><tr><th>TAREFA</th><th>ESTADO</th><th>ATUALIZAÇÃO</th><th><span className="sr-only">Detalhes</span></th></tr></thead><tbody>
       {visible.map(task=><tr key={task.id} className={selectedId===task.id?'row-active':''}>
        <td><button className="task-link" onClick={()=>inspectTask(task.id)} aria-label={'Abrir detalhes de '+task.title}>{task.title}</button><span className="task-sub">#{shortId(task.id)} · versão {task.version}</span></td>
        <td>{badge(task.status)}</td><td className="date-cell">{fmtDate(task.updatedAt)}</td>
        <td><button className="row-open" onClick={()=>inspectTask(task.id)} aria-label={'Visualizar '+task.title}><Icon name="arrow" size={16}/></button></td>
       </tr>)}</tbody></table>
       {!visible.length&&<div className="empty"><Icon name="layers" size={28}/><strong>Nenhuma tarefa encontrada</strong><span>Experimente alterar o filtro ou aguarde novas tarefas.</span></div>}</div>
      <div className="surface-footer">Até 500 tarefas por projeto · Ordenação persistida pela API · Sem dados simulados</div>
     </section>
     <section className="surface detail-surface" aria-label="Detalhes da tarefa selecionada">
      {selected?<><div className="surface-heading detail-heading"><div><span className="eyebrow">INSPEÇÃO DE TAREFA</span><h2>Detalhes da execução</h2></div><button className="close-detail" title="Fechar detalhes" aria-label="Fechar detalhes" onClick={()=>setSelectedId(null)}>×</button></div>
      <h3 className="detail-title">{selected.title}</h3>{badge(selected.status)}
      <p className="detail-description">{selected.description||'Nenhuma descrição registrada.'}</p>
      <div className="key-grid"><div><span>Identificador</span><code title={selected.id}>{shortId(selected.id)}</code></div><div><span>Versão</span><strong>{selected.version}</strong></div><div><span>Run atual</span><code title={selected.currentRunId||''}>{shortId(selected.currentRunId)}</code></div><div><span>Atualização</span><strong>{fmtDate(selected.updatedAt)}</strong></div></div>
      <div className="subsection" id="timeline"><h4><Icon name="activity" size={17}/> Eventos da tarefa</h4>
       {selectedEvents.length?<ol className="timeline">{selectedEvents.map(e=><li key={e.eventId||e.sequence}><span className="timeline-icon"/><div><strong>{String(e.type||'Evento')}</strong><small>{fmtDate(e.occurredAt)} · {e.actor?.kind||'system'}</small></div></li>)}</ol>:<p className="empty-inline">Nenhum evento recente retornado pela API.</p>}</div>
      <div className="subsection" id="evidence"><h4><Icon name="shield" size={17}/> Evidências verificadas <span className="count">{evidences.length}</span></h4>
       {evidences.length?<ul className="evidence-list">{evidences.map(e=><li key={e.id}><span className="evidence-icon"><Icon name="file" size={16}/></span><div><strong>{e.kind} · v{e.version}</strong><small>{fmtDate(e.createdAt)}</small><code title={e.chainSha256}>SHA-256 {shortId(e.chainSha256)}</code></div></li>)}</ul>:<p className="empty-inline">Nenhuma evidência vinculada a esta tarefa. O painel nunca exibe conteúdo bruto do ledger.</p>}</div>
      <AttachmentPanel key={project.id+':'+selected.id} projectId={project.id} taskId={selected.id} token={token} desktopMode={desktopMode} desktopInvoke={desktopInvoke} request={request}/>
      </>:<div className="detail-placeholder"><div className="detail-illustration"><Icon name="file" size={32}/></div><h3>Selecione uma tarefa</h3><p>Clique em uma linha para inspecionar o estado persistido, os eventos e os resumos criptográficos do ledger.</p></div>}
     </section>
    </div>
    <footer className="footer"><span>OmnyaDesk · Operação local autenticada</span><span>Leitura protegida por escopo · Aprovações somente pelo fluxo S15</span></footer>
   </>}
   </main>}
  </div>
 </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
