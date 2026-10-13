import {randomUUID} from 'node:crypto';
import type {RemoteWorktreeManager} from './remote-worktrees.ts';
import {RemoteUnavailable,quoteRemote} from './remote-ubuntu.ts';

export type DockerSandboxResult={ok:boolean;exitCode:number;stdout:string;stderr:string;
 name:string;image:string;isolatedByPolicy:boolean};
export class UbuntuDockerSandbox{
 private readonly manager:RemoteWorktreeManager;
 constructor(manager:RemoteWorktreeManager){this.manager=manager;}
 async run(projectId:string,runId:string):Promise<DockerSandboxResult>{
  const row=await this.manager.get(projectId,runId);
  const ssh=this.manager.ssh;
  if(!row||row.state!=='ready'||row.executionBackend!=='ubuntu_ssh_docker'||
   row.remoteHost!==ssh.config.host||row.checkoutPath!==this.manager.root+'/projects/'+projectId+'/'+runId+'/workspace')
   throw new RemoteUnavailable('Unregistered or cross-project remote worktree');
  await ssh.connect();
  const q=quoteRemote,checkout=row.checkoutPath;
  await ssh.requireOk('test -d '+q(checkout)+' && test ! -L '+q(checkout)+
   ' && test -f '+q(checkout+'/entry.sh')+' && test ! -L '+q(checkout+'/entry.sh'));
  await ssh.requireOk('docker image inspect '+q(ssh.config.image)+' >/dev/null');
  const name='omnyadesk-s12-'+runId.slice(0,8)+'-'+randomUUID().slice(0,8);
  const cmd=[
   'timeout','-k','2','19',
   'docker','run','--rm','--pull','never',
   '--name',q(name),
   '--label','com.omnyadesk.sprint=S12',
   '--label',q('com.omnyadesk.run='+runId),
   '--network','none',
   '--read-only',
   '--cap-drop','ALL',
   '--security-opt','no-new-privileges',
   '--pids-limit','32',
   '--memory','128m',
   '--cpus','0.5',
   '--user','65534:65534',
   '--ipc','private',
   // Docker's default PID mode is private; --pid private is not a valid Docker flag.
   '--tmpfs',q('/tmp:rw,nosuid,nodev,noexec,size=8m'),
   '--mount',q('type=bind,source='+checkout+',target=/workspace,readonly'),
   '--workdir','/workspace',
   q(ssh.config.image),
   '/bin/sh','/workspace/entry.sh'
  ].join(' ');
  try{
   const result=await ssh.exec(cmd,24000);
   return {ok:result.exitCode===0,exitCode:result.exitCode,stdout:result.stdout,
    stderr:result.stderr,name,image:ssh.config.image,isolatedByPolicy:true};
  }finally{
   // Only the uniquely generated S12 container may be removed. Never prune global containers.
   await ssh.exec('docker rm -f -- '+q(name)+' >/dev/null 2>&1 || true',8000);
  }
 }
}
