import {useCallback,useEffect,useState} from 'react';
import './attachments.css';

const MAX_BYTES=1048576;
const kinds={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
 '.pdf':'application/pdf','.txt':'text/plain','.diff':'text/x-diff','.patch':'text/x-diff'};
const suffix=name=>name.slice(name.lastIndexOf('.')).toLowerCase();
function encodeBytes(bytes){
 let binary='';
 for(let offset=0;offset<bytes.length;offset+=16384)
  binary+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
 return btoa(binary);
}
const humanError=message=>/403|permission|scope|forbidden/i.test(String(message))
 ?'Seu acesso não possui files:write. Solicite um token de anexos ou utilize a estação autorizada.'
 :String(message||'Falha ao consultar ou enviar arquivo.');
export function AttachmentPanel({projectId,taskId,token,desktopMode,desktopInvoke,request}){
 const [items,setItems]=useState([]);
 const [current,setCurrent]=useState(null);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState('');
 const [selectedFile,setSelectedFile]=useState(null);
 const root='/v1/projects/'+encodeURIComponent(projectId)+'/tasks/'+encodeURIComponent(taskId)+'/attachments';
 const refresh=useCallback(async()=>{
  const data=await request(token,root);
  setItems(Array.isArray(data.attachments)?data.attachments:[]);
 },[token,root,request]);
 useEffect(()=>{
  let open=true;
  setItems([]);setCurrent(null);setSelectedFile(null);setError('');
  request(token,root).then(data=>{if(open)setItems(Array.isArray(data.attachments)?data.attachments:[]);})
   .catch(()=>{if(open)setError('Não foi possível carregar anexos privados.');});
  return()=>{open=false;};
 },[token,root,request]);
 async function upload(){
  if(!selectedFile||loading)return;
  setLoading(true);setError('');
  try{
   const mime=kinds[suffix(selectedFile.name)];
   if(!mime||selectedFile.size<1||selectedFile.size>MAX_BYTES)
    throw Error('Arquivo inválido. Use PNG, JPG, PDF, TXT ou DIFF até 1 MiB.');
   const name=selectedFile.name;
   const dataBase64=encodeBytes(new Uint8Array(await selectedFile.arrayBuffer()));
   if(desktopMode)await desktopInvoke('desktop_upload',{
    projectId,taskId,filename:name,mimeType:mime,dataBase64});
   else{
    const response=await fetch(root,{method:'POST',headers:{
     Authorization:'Bearer '+token,Accept:'application/json','Content-Type':'application/json'},
     credentials:'omit',cache:'no-store',
     body:JSON.stringify({filename:name,mimeType:mime,dataBase64})});
    if(!response.ok)throw Error('Envio recusado ('+response.status+').');
   }
   setCurrent(null);setSelectedFile(null);
   const input=document.getElementById('attachment-file-input');
   if(input)input.value='';
   await refresh();
  }catch(e){setError(humanError(e?.message));}
  finally{setLoading(false);}
 }
 async function view(id){
  setLoading(true);setError('');
  try{
   const result=await request(token,root+'/'+encodeURIComponent(id));
   if(!result.attachment||!result.dataBase64)throw Error('Resposta sem conteúdo');
   let preview=null;
   if(result.attachment.mimeType.startsWith('text/')){
    const bytes=Uint8Array.from(atob(result.dataBase64),c=>c.charCodeAt(0));
    preview=new TextDecoder('utf-8',{fatal:true}).decode(bytes).slice(0,32000);
   }
   setCurrent({...result,preview});
  }catch(e){setError(humanError(e?.message));}
  finally{setLoading(false);}
 }
 const uri=current?'data:'+current.attachment.mimeType+';base64,'+current.dataBase64:null;
 const previewLines=current?.attachment.mimeType==='text/x-diff'?
  current.preview.split('\n').slice(0,250):[];
 return <div className="attachment-panel" aria-label="Arquivos e mídia da tarefa" id="attachments">
  <div className="attachment-head"><strong>Arquivos e mídia <span className="count">{items.length}</span></strong>
   <small>Privados · limite de 1 MiB por arquivo · sem execução</small></div>
  <label htmlFor="attachment-file-input" className="attachment-label">Adicionar documento, imagem ou diff</label>
  <input id="attachment-file-input" type="file" accept=".png,.jpg,.jpeg,.pdf,.txt,.diff,.patch"
   onChange={e=>setSelectedFile(e.target.files?.[0]||null)}/>
  <button type="button" className="attachment-action" disabled={loading||!selectedFile}
   onClick={()=>void upload()}> {loading?'Aguarde...':'Enviar arquivo validado'} </button>
  {error&&<p role="alert" className="attachment-error">{error}</p>}
  {!items.length?<p className="empty-inline">Nenhum arquivo anexado a esta tarefa.</p>:
   <ul className="attachment-list">{items.map(item=><li key={item.id}>
    <button type="button" onClick={()=>void view(item.id)} disabled={loading}
     aria-label={'Pré-visualizar '+item.filename}>▤ {item.filename}</button>
    <small>{item.mimeType} · {item.sizeBytes} bytes · SHA-256 {item.sha256.slice(0,12)}…</small>
   </li>)}</ul>}
  {current&&<section className="attachment-preview" aria-label="Prévia segura do arquivo">
    <header><strong>{current.attachment.filename}</strong><button type="button" onClick={()=>setCurrent(null)}>Fechar</button></header>
    {current.attachment.mimeType.startsWith('image/')?<img alt={'Imagem '+current.attachment.filename}
     src={uri} loading="lazy"/>:
     current.attachment.mimeType==='text/x-diff'?<pre className="attachment-diff" aria-label="Diff textual seguro">
      {previewLines.map((line,i)=><span key={i} className={line.startsWith('+')?'diff-plus':line.startsWith('-')?'diff-minus':line.startsWith('@@')?'diff-hunk':''}>{line.slice(0,450)}</span>)}
     </pre>:
     current.attachment.mimeType==='text/plain'?<pre className="attachment-text">{current.preview}</pre>:
     <p className="empty-inline">PDF não é renderizado dentro do aplicativo por segurança. Salve e abra em um leitor confiável.</p>}
    <a download={current.attachment.filename} href={uri} className="attachment-action attachment-download">Salvar arquivo verificado</a>
    <small>Integridade SHA-256: {current.attachment.sha256}</small>
   </section>}
 </div>;
}
