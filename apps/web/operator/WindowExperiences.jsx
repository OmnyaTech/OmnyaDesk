import {useEffect,useMemo,useRef,useState} from 'react';
import {OfficeWorld} from './world/OfficeWorld.jsx';
import {projectOffice} from './world/projector.mjs';
import './window-experiences.css';

const roleStyle={
 architect:{shirt:'#5a9cf1',hair:'#34496e',skin:'#f5ba90'},
 developer:{shirt:'#2dbb96',hair:'#513d3a',skin:'#e6a875'},
 qa:{shirt:'#bd8eeb',hair:'#6b3853',skin:'#f2bf9f'},
 reviewer:{shirt:'#e8a76a',hair:'#29283b',skin:'#cc9274'}
};
const phaseText={working:'Em execução',waiting:'Revisão pendente',paused:'Sem conexão',idle:'Disponível'};
const taskPhases=new Set(['planning','implementing','testing','reviewing','retrying']);
const IMPORTANT=new Set(['awaiting_approval','failed','blocked','changes_requested']);
const short=value=>String(value||'').slice(0,70);
function Avatar({id,phase='idle',size=56}){
 const c=roleStyle[id]||roleStyle.developer;
 return <span className={'px-avatar px-avatar--'+phase} style={{'--avatar-size':size+'px'}} aria-hidden="true">
  <svg viewBox="0 0 32 38" shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
   <rect x="9" y="33" width="6" height="4" fill="#25304c"/><rect x="19" y="33" width="6" height="4" fill="#25304c"/>
   <rect x="7" y="24" width="18" height="10" fill={c.shirt}/>
   <rect x="4" y="26" width="5" height="8" fill={c.skin}/><rect x="25" y="26" width="5" height="8" fill={c.skin}/>
   <rect x="8" y="11" width="18" height="15" fill={c.skin}/>
   <rect x="6" y="6" width="22" height="11" fill={c.hair}/>
   <rect x="10" y="3" width="14" height="5" fill={c.hair}/>
   <rect x="8" y="16" width="4" height="7" fill={c.hair}/>
   <rect x="22" y="16" width="4" height="7" fill={c.hair}/>
   <rect x="12" y="18" width="3" height="3" fill="#27354c"/>
   <rect x="20" y="18" width="3" height="3" fill="#27354c"/>
   <rect x="15" y="23" width="5" height="2" fill="#bd755f"/>
   <rect x="10" y="29" width="13" height="3" fill="#142f45" opacity=".55"/>
  </svg>
  <span className="px-avatar-dot"/>
 </span>;
}
function AgentTile({role,onInspect,mini=false}){
 return <button className={'px-agent '+(mini?'px-agent--mini':'')} type="button" onClick={()=>role.taskId&&onInspect?.(role.taskId)}
 disabled={!role.taskId} title={role.name+': '+(phaseText[role.phase]||'')}
 aria-label={role.name+': '+(phaseText[role.phase]||'')}>
  <Avatar id={role.id} phase={role.phase} size={mini?39:57}/>
  <span className="px-agent-copy"><strong>{role.name}</strong><small>{phaseText[role.phase]||'Livre'}{role.total?' · '+role.total:''}</small></span>
 </button>;
}
function WindowModes({mode,onMode,top,onTop,onTray}){
 return <div className="px-mode-switch" role="group" aria-label="Alternar modo de janela">
  {[['full','Completo'],['compact','Compacto'],['floating','Flutuante'],['taskbar','Taskbar']].map(([value,label])=>
   <button type="button" key={value} aria-label={label} title={'Modo '+label}
    aria-pressed={mode===value} className={mode===value?'is-selected':''} onClick={()=>onMode(value)}>
    {label}</button>)}
  <button type="button" aria-label="Sempre no topo" title="Sempre no topo" aria-pressed={top}
   className={top?'is-selected':''} onClick={()=>onTop(!top)}>⌃</button>
  <button type="button" aria-label="Bandeja" title="Minimizar para bandeja" onClick={onTray}>—</button>
 </div>;
}
function projectSummary(project,counts,connection){
 return {project:short(project?.name||'Sem projeto'),online:connection==='online',
  working:counts.active,review:counts.review,done:counts.done};
}
export function WindowExperience({mode,project,tasks=[],events=[],historyComplete=true,
 connection='offline',counts,onInspectTask,onMode,onTop,onTray,alwaysOnTop=false}){
 const projection=useMemo(()=>projectOffice({
  projectId:project?.id,tasks,events,historyComplete,connection
 }),[project?.id,tasks,events,historyComplete,connection]);
 const roles=projection.roles;
 const summary=projectSummary(project,counts,connection);
 const [selectedAlert,setSelectedAlert]=useState(null);
 const lastSeen=useRef({project:null,seq:0});
 const actionable=tasks.filter(t=>t.projectId===project?.id&&IMPORTANT.has(t.status)).slice(0,3);
 const activeTasks=tasks.filter(t=>t.projectId===project?.id&&taskPhases.has(t.status)).slice(0,3);
 const realEvents=events.filter(e=>e.projectId===project?.id&&
  (e.type==='task.created'||e.type==='task.status_changed')).slice(-5).reverse();
 useEffect(()=>{
  const scope=project?.id;
  const current=events.filter(e=>e.projectId===scope&&Number.isSafeInteger(e.sequence));
  const latest=current.reduce((best,e)=>e.sequence>best.sequence?e:best,{sequence:0});
  if(lastSeen.current.project!==scope){lastSeen.current={project:scope,seq:latest.sequence};return;}
  if(lastSeen.current.seq>0&&latest.sequence>lastSeen.current.seq&&connection==='online'){
   const task=tasks.find(t=>t.id===latest.taskId);
   setSelectedAlert('Evento atualizado: '+(task?.title||'Tarefa registrada'));
  }
  lastSeen.current.seq=Math.max(lastSeen.current.seq,latest.sequence);
 },[project?.id,events,connection,tasks]);
 const controls=<WindowModes mode={mode} onMode={onMode} top={alwaysOnTop} onTop={onTop} onTray={onTray}/>;
 const status=<span className={'px-online '+(summary.online?'is-online':'')}>{summary.online?'● Online':'○ API indisponível'}</span>;
 if(mode==='taskbar')return <section className="px-experience px-experience--taskbar" aria-label="Modo Taskbar OmnyaDesk" data-layout="taskbar">
  <div className="px-taskbar-brand"><span className="px-mark">O</span><strong>OmnyaDesk</strong></div>
  <div className="px-taskbar-people">{roles.map(role=><AgentTile key={role.id} mini role={role} onInspect={onInspectTask}/>)}</div>
  <div className="px-taskbar-counts" aria-label="Indicadores operacionais">
   <span title="Tarefas em execução">⚙ {summary.working}</span><span title="Revisão humana pendente">◈ {summary.review}</span>
  </div><div className="px-taskbar-buttons">{controls}</div>
 </section>;
 if(mode==='compact')return <section className="px-experience px-experience--compact" aria-label="Modo Compacto OmnyaDesk" data-layout="compact">
  <header className="px-compact-top"><div className="px-name"><span className="px-mark">O</span><div><strong>OmnyaDesk</strong><small>{summary.project}</small></div></div>
   <div className="px-compact-status">{status}<span>⚙ {summary.working} ativos</span><span>◈ {summary.review} revisão</span></div>{controls}</header>
  <div className="px-compact-room" aria-label="Agentes e estações">
   <div className="px-room-shelf"><span>▥</span><span>◈</span><span>▣</span><span>☕</span></div>
   <div className="px-room-agents">{roles.map(role=><div className="px-room-station" key={role.id}><span className="px-station-monitor" aria-hidden="true"/><AgentTile role={role} onInspect={onInspectTask}/></div>)}</div>
   <div className="px-room-floor"/>
  </div>
 </section>;
 if(mode==='floating')return <section className="px-experience px-experience--floating" aria-label="Modo Flutuante OmnyaDesk" data-layout="floating">
  <header className="px-floating-top"><div className="px-name"><span className="px-mark">O</span><div><strong>OmnyaDesk</strong><small>{summary.project}</small></div></div>{controls}</header>
  <div className="px-floating-body">
   <div className="px-floating-room">
    <span className="px-floating-label">ESCRITÓRIO EM TEMPO REAL</span>
    <div className="px-floating-scene"><span className="px-decor">▣</span><span className="px-decor">☕</span>{roles.map(role=><div className="px-floating-station" key={role.id}><span className="px-station-monitor" aria-hidden="true"/><AgentTile mini role={role} onInspect={onInspectTask}/></div>)}</div>
   </div>
   <div className="px-floating-side">{status}
    <div><strong>{summary.working}</strong><small>em execução</small></div>
    <div><strong>{summary.review}</strong><small>aprovações pendentes</small></div>
    <div><strong>{summary.done}</strong><small>concluídas</small></div>
   </div>
  </div>
  <footer className="px-floating-footer">{activeTasks[0]?<button onClick={()=>onInspectTask(activeTasks[0].id)}>{short(activeTasks[0].title)}</button>:
   <span>Nenhuma tarefa em execução registrada</span>}</footer>
 </section>;
 return <section className="px-experience px-experience--full" aria-label="Escritório Completo OmnyaDesk" data-layout="full">
  <div className="px-full-head"><div><span className="eyebrow">CENTRAL DE OPERAÇÕES</span><h2>Escritório principal <small>{roles.length} estações</small></h2></div>
   <div className="px-full-status">{status}<span>⚙ {summary.working} em execução</span><span>◈ {summary.review} revisão</span></div>
  </div>
  <div className="px-full-columns"><div className="px-full-world">
   <OfficeWorld projectId={project.id} tasks={tasks} events={events} historyComplete={historyComplete} connection={connection} onInspectTask={onInspectTask} overview/>
   <div className="px-full-agents">{roles.map(role=><AgentTile key={role.id} mini role={role} onInspect={onInspectTask}/>)}</div>
  </div>
  <aside className="px-activity" aria-label="Atividades em tempo real">
   <header><strong>Atividades em tempo real</strong><small>Eventos persistidos</small></header>
   {realEvents.length?<ol>{realEvents.map((event,i)=><li key={event.eventId||i}>
    <span className="px-event-icon">{event.type==='task.created'?'▣':'↗'}</span>
    <div><strong>{event.type==='task.created'?'Tarefa registrada':'Estado atualizado'}</strong>
    <small>{tasks.find(t=>t.id===event.taskId)?.title||'Tarefa '+String(event.taskId).slice(0,8)}</small></div></li>)}</ol>:<p className="px-no-activity">Nenhum evento recente registrado.</p>}
   <div className="px-activity-actions"><strong>Intervenções</strong><span>{actionable.length} pendentes</span></div>
   {actionable.map(t=><button type="button" className="px-alert-task" key={t.id} onClick={()=>onInspectTask(t.id)}>{short(t.title)} <small>{t.status==='awaiting_approval'?'Revisão humana':t.status}</small></button>)}
   {!actionable.length&&<p className="px-no-activity">Nenhuma intervenção pendente.</p>}
  </aside></div>
  {selectedAlert&&<div role="status" className="px-toast">{selectedAlert}<button onClick={()=>setSelectedAlert(null)}>Fechar</button></div>}
 </section>;
}
