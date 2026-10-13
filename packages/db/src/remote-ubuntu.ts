import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import {Client} from 'ssh2';
import {z} from 'zod';

export class RemoteUnavailable extends Error {}
export const UbuntuRemoteConfigSchema=z.strictObject({
 host:z.ipv4(),port:z.number().int().min(1).max(65535).default(22),
 username:z.string().regex(/^[a-z_][a-z0-9_-]{0,30}$/),
 hostFingerprint:z.string().min(30).max(90),
 agentSocket:z.string().min(1).max(220),
 remoteRoot:z.string().min(10).max(180),
 image:z.string().regex(/^alpine@sha256:[a-f0-9]{64}$/)
});
export type UbuntuRemoteConfig=z.input<typeof UbuntuRemoteConfigSchema>;
export type RemoteExecResult={exitCode:number;stdout:string;stderr:string};
export function safeLinuxPath(path:string):string{
 if(!/^\/[a-z0-9._/-]+$/.test(path)||path.includes('//')||path.split('/').some(x=>x==='..'||x==='.'))
  throw new RemoteUnavailable('Unsafe Linux path');
 return path;
}
export const quoteRemote=(value:string):string=>{
 if(!/^[a-zA-Z0-9._/@:+,=-]+$/.test(value))throw new RemoteUnavailable('Invalid remote shell argument');
 return "'"+value+"'";
};

export class UbuntuSshTransport{
 private readonly client=new Client();
 readonly config:ReturnType<typeof UbuntuRemoteConfigSchema.parse>;
 private connected=false;
 constructor(input:UbuntuRemoteConfig){
  this.config=UbuntuRemoteConfigSchema.parse(input);
  safeLinuxPath(this.config.remoteRoot);
  if(!this.config.remoteRoot.startsWith('/home/'+this.config.username+'/'))
   throw new RemoteUnavailable('S12 remote root must be under the SSH user home directory');
 }
 async connect():Promise<void>{
  if(this.connected)return;
  await new Promise<void>((resolve,reject)=>{
   let settled=false;
   const fail=(error:Error)=>{if(!settled){settled=true;reject(new RemoteUnavailable('Pinned SSH connection failed: '+error.message));}};
   this.client.once('ready',()=>{settled=true;this.connected=true;resolve()});
   this.client.once('error',fail);
   this.client.connect({host:this.config.host,port:this.config.port,
    username:this.config.username,agent:this.config.agentSocket,readyTimeout:12000,
    hostVerifier:(key:Buffer)=>createHash('sha256').update(key).digest('base64').replace(/=+$/,'')===this.config.hostFingerprint
   });
  });
 }
 async exec(command:string,timeoutMs=22000):Promise<RemoteExecResult>{
  if(!this.connected)throw new RemoteUnavailable('SSH connection not established');
  if(command.length>8000||timeoutMs<1000||timeoutMs>90000)throw new RemoteUnavailable('Remote command out of limits');
  return new Promise((resolve,reject)=>{
   this.client.exec(command,{pty:false},(error,channel)=>{
    if(error){reject(new RemoteUnavailable('SSH exec failed'));return;}
    let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>{
     if(!settled){settled=true;channel.close();reject(new RemoteUnavailable('Remote process timeout'));}
    },timeoutMs);
    const add=(value:string,which:'stdout'|'stderr')=>{
     if(which==='stdout')stdout+=value;else stderr+=value;
     if(stdout.length+stderr.length>65536&&!settled){
      settled=true;clearTimeout(timer);channel.close();reject(new RemoteUnavailable('Remote output exceeded 64KiB'));
     }
    };
    channel.on('data',(buf:Buffer)=>add(String(buf),'stdout'));
    channel.stderr.on('data',(buf:Buffer)=>add(String(buf),'stderr'));
    channel.on('close',(code:number)=>{
     clearTimeout(timer);
     if(settled)return;settled=true;
     resolve({exitCode:typeof code==='number'?code:255,stdout,stderr});
    });
    channel.on('error',()=>{if(!settled){settled=true;clearTimeout(timer);reject(new RemoteUnavailable('Remote channel failed'));}});
   });
  });
 }
 async requireOk(command:string,timeoutMs=22000):Promise<string>{
  const result=await this.exec(command,timeoutMs);
  if(result.exitCode!==0)throw new RemoteUnavailable('Remote command rejected (exit '+result.exitCode+'): '+result.stderr.slice(0,450));
  return result.stdout.trim();
 }
 async upload(localFile:string,remoteFile:string):Promise<void>{
  safeLinuxPath(remoteFile);
  if(statSync(localFile).size>64*1024*1024)throw new RemoteUnavailable('Git bundle exceeds 64MiB limit');
  if(!this.connected)throw new RemoteUnavailable('SSH not connected');
  await new Promise<void>((resolve,reject)=>this.client.sftp((error,sftp)=>{
   if(error){reject(new RemoteUnavailable('SFTP setup failed'));return;}
   sftp.fastPut(localFile,remoteFile,{concurrency:2,chunkSize:32768},e=>{
    // Close each SFTP channel. Leaving them open exhausts OpenSSH MaxSessions
    // after several tool calls over one long-lived pinned SSH connection.
    sftp.end();
    if(e)reject(new RemoteUnavailable('SFTP upload failed'));else resolve();
   });
  }));
 }
 close():void{this.connected=false;this.client.end();}
}
