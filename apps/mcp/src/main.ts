import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

// A strictly local adapter. Clients need only an API-scoped bearer token,
// never database credentials. The Fastify intake remains the single authority.
const token=process.env.OMNYA_MCP_TOKEN;
if(!token||!/^odt_[a-f0-9]{64}$/.test(token))throw Error('Local MCP bearer token is required');
const address=new URL(process.env.OMNYA_MCP_URL??'http://127.0.0.1:4317');
if(address.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(address.hostname)||
   address.username||address.password||address.search||address.hash||
   address.pathname!=='/')throw Error('MCP adapter only accepts loopback API URL');
const server=new McpServer({name:'omnyadesk-intake',version:'0.1.0'});
server.registerTool('submit_task',{
 title:'Submit OmnyaDesk task',
 description:'Create a task idempotently for an authorized project, sharing the HTTP intake. Does not execute code or approve diffs.',
 inputSchema:{
  projectId:z.uuid(),officeId:z.uuid(),title:z.string().trim().min(1).max(140),
  description:z.string().max(4000),idempotencyKey:z.uuid()
 },
},async({projectId,officeId,title,description,idempotencyKey})=>{
 try{
  const response=await fetch(new URL('/v1/projects/'+projectId+'/intake',address),{
   method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',
    'idempotency-key':idempotencyKey},
   body:JSON.stringify({officeId,title,description}),
   signal:AbortSignal.timeout(10000)
  });
  const value:unknown=await response.json();
  if(!response.ok)return {isError:true,content:[{type:'text',text:'Intake refused (HTTP '+response.status+')'}]};
  return {content:[{type:'text',text:JSON.stringify(value)}]};
 }catch{
  return {isError:true,content:[{type:'text',text:'Local intake API unavailable'}]};
 }
});
const transport=new StdioServerTransport();
await server.connect(transport);
