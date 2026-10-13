import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {OfficeRuntime} from '../../../packages/core/src/runtime.ts';

if(process.env.DATABASE_URL){
 // Database mode never mounts the legacy unauthenticated mock endpoints.
 const {servePersistentApi}=await import('./server.ts');
 await servePersistentApi();
}else{
 const host=process.env.OMNYA_HOST??'127.0.0.1';
 if(host!=='127.0.0.1'&&host!=='::1')throw Error('Mock API must bind only to loopback');
 const port=Number(process.env.OMNYA_PORT??4317);
 const office=new OfficeRuntime();
 function json(res:ServerResponse,status:number,data:unknown){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
   'x-content-type-options':'nosniff'});
  res.end(JSON.stringify(data));
 }
 async function input(req:IncomingMessage):Promise<Record<string,unknown>>{
  let body='';for await(const chunk of req){body+=String(chunk);if(body.length>8192)throw Error('Payload too large');}
  const value:unknown=JSON.parse(body||'{}');
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid JSON');
  return value as Record<string,unknown>;
 }
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url??'/',`http://${host}:${port}`);
   if(req.method==='GET'&&url.pathname==='/'){
    const html=await readFile(new URL('../../web/index.html',import.meta.url),'utf8');
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(html);
   }else if(req.method==='GET'&&url.pathname==='/api/health'){
    json(res,200,{ok:true,mode:'mock-in-memory',warning:'NO AUTHENTICATION — localhost only'});
   }else if(req.method==='GET'&&url.pathname==='/api/tasks'){
    json(res,200,{tasks:office.listTasks()});
   }else if(req.method==='POST'&&url.pathname==='/api/tasks'){
    const body=await input(req);
    if(typeof body.title!=='string'||typeof body.description!=='string')throw Error('title and description required');
    json(res,201,{task:office.createTask(body.title,body.description)});
   }else if(req.method==='POST'&&/^\/api\/tasks\/[0-9a-f-]+\/decision$/.test(url.pathname)){
    const id=url.pathname.split('/')[3]!;
    const body=await input(req);
    if(body.decision!=='approve'&&body.decision!=='reject')throw Error('Invalid decision');
    json(res,200,{task:office.decide(id,body.decision)});
   }else if(req.method==='GET'&&url.pathname==='/api/events'){
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform',
     connection:'keep-alive','x-content-type-options':'nosniff'});
    const headerCursor=Number(req.headers['last-event-id']??0);
    const cursor=Number.isSafeInteger(headerCursor)&&headerCursor>=0?headerCursor:0;
    const un=office.subscribe(event=>res.write(`id: ${event.id}\nevent: office\ndata: ${JSON.stringify(event)}\n\n`));
    for(const event of office.listEvents(cursor))res.write(`id: ${event.id}\nevent: office\ndata: ${JSON.stringify(event)}\n\n`);
    const keepAlive=setInterval(()=>res.write(': keep-alive\n\n'),25000);
    req.on('close',()=>{clearInterval(keepAlive);un();});
   }else json(res,404,{error:'Not found'});
  }catch(e){json(res,400,{error:e instanceof Error?e.message:'Invalid request'});}
 });
 server.listen(port,host,()=>console.log('OmnyaDesk localhost mock listening; NOT authenticated'));
}
