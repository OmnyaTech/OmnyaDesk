import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OfficeWorld} from '../../web/operator/world/OfficeWorld.jsx';
import './webview.css';

const vscode=typeof acquireVsCodeApi==='function'?acquireVsCodeApi():null;
function App(){
 const [snapshot,setSnapshot]=useState(null),[message,setMessage]=useState('Conectando ao Extension Host…');
 const [connection,setConnection]=useState('offline'),[selectedTask,setSelectedTask]=useState(null),[selectedReview,setSelectedReview]=useState(null);
 useEffect(()=>{
  const receive=event=>{
   const data=event.data;
   if(!data||typeof data!=='object')return;
   if(data.type==='snapshot'&&data.value?.project&&Array.isArray(data.value.tasks)&&Array.isArray(data.value.events)){
    setSnapshot(data.value);setConnection('online');setMessage('');setSelectedTask(null);setSelectedReview(null);
   }else if(data.type==='error'||data.type==='waiting'){
    setConnection('offline');setMessage(String(data.message||'Sem conexão').slice(0,250));
   }else if(data.type==='task'){
    setSelectedTask(data.value||null);setSelectedReview(null);
   }else if(data.type==='review'){
    setSelectedReview(data.value||null);
   }
  };
  window.addEventListener('message',receive);
  vscode?.postMessage({type:'ready'});
  return()=>window.removeEventListener('message',receive);
 },[]);
 const refresh=()=>vscode?.postMessage({type:'refresh'});
 const select=id=>vscode?.postMessage({type:'selectProject',projectId:id});
 const inspect=id=>vscode?.postMessage({type:'inspectTask',taskId:id});
 return <div className="vscode-office">
  <header className="office-head">
   <div><strong>OmnyaDesk</strong><small>ESCRITÓRIO — VISUALIZAÇÃO SOMENTE LEITURA</small></div>
   <div className="office-actions">
    <label htmlFor="project-select">Projeto</label>
    <select id="project-select" value={snapshot?.project.id||''}
     onChange={e=>select(e.target.value)} disabled={!snapshot?.projects.length}>
     {!snapshot&&<option value="">Não conectado</option>}
     {snapshot?.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
    <button onClick={refresh}>Atualizar</button>
   </div>
  </header>
  {message&&<p className="office-status" role="status">{message}</p>}
  {snapshot&&<OfficeWorld projectId={snapshot.project.id} tasks={snapshot.tasks}
   events={snapshot.events} historyComplete={snapshot.historyComplete}
   connection={connection} onInspectTask={inspect}/>}
  {selectedTask&&<section className="office-task" role="region" aria-label="Detalhes da tarefa">
   <h3>{selectedTask.title}</h3>
   <p>Estado: <strong>{selectedTask.status}</strong> · Versão {selectedTask.version}</p>
   <p>ID: <code>{selectedTask.id}</code></p>
   {selectedReview?.taskId===selectedTask.id&&<section className="office-review" aria-label="Diff de revisão Git">
    <h4>Diff Git verificado — {selectedReview.state}</h4>
    <p>Hash de revisão: <code>{selectedReview.reviewHash}</code></p>
    <pre className="office-review-diff">{selectedReview.diff}</pre>
    {selectedReview.truncated&&<p>Prévia limitada a 24.000 caracteres.</p>}
    <p>Somente leitura; aprovações exigem fluxo humano autenticado.</p>
   </section>}
   <button onClick={()=>{setSelectedTask(null);setSelectedReview(null);}}>Fechar detalhes</button>
  </section>}
  <footer>Dados autorizados da API local • Sem tokens no Webview • Sincronização a cada 8 segundos enquanto visível</footer>
 </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
