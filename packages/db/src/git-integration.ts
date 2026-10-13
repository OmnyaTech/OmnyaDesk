import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {UuidSchema} from '../../contracts/src/domain.ts';
import type {AuthPrincipal,ApiScope} from './tokens.ts';
import {BareGitIntegration,GitValidationError,validRef,validSha} from './git-driver.ts';
import {EvidenceLedger,EvidenceIntegrityError} from './evidence-ledger.ts';

export const GitProposalSchema=z.strictObject({
 projectId:UuidSchema,taskId:UuidSchema,candidateRef:z.string().max(180),
 candidateSha:z.string().length(40),baseSha:z.string().length(40),
 priority:z.number().int().min(0).max(10).default(5)
}).refine(x=>validRef(x.candidateRef)&&validSha(x.candidateSha)&&validSha(x.baseSha),{
 message:'Invalid candidate Git ref or object ID'
});
export type GitProposal=z.input<typeof GitProposalSchema>;
export class IntegrationConflict extends Error{readonly status=409;}
export class IntegrationForbidden extends Error{readonly status=403;}
export class IntegrationNotFound extends Error{readonly status=404;}
type Row={
 id:string;project_id:string;task_id:string;submitter_id:string;
 candidate_ref:string;candidate_sha:string;base_sha:string;
 state:string;priority:number;created_at:Date;reviewed_head:string|null;
 tested_tree:string|null;planned_commit:string|null;review_sha256:string|null;
 review_evidence_id:string|null;
 approved_by:string|null;approved_at:Date|null;merged_at:Date|null;
 validation_json:unknown
};
export class GitIntegrationQueue{
 private readonly pool:Pool;
 private readonly evidence:EvidenceLedger;
 constructor(pool:Pool){this.pool=pool;this.evidence=new EvidenceLedger(pool);}
 private actor(principal:AuthPrincipal,projectId:string,scope:ApiScope){
  if(principal.projectId!==projectId)throw new IntegrationNotFound('Project not found');
  if(!principal.scopes.includes(scope))throw new IntegrationForbidden('Scope not granted');
 }
 private async locked<T>(projectId:string,principal:AuthPrincipal,scope:ApiScope,
  callback:(c:PoolClient,driver:BareGitIntegration)=>Promise<T>):Promise<T>{
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   // Revalidate token under a row lock against concurrent revocation.
   const auth=await c.query('SELECT project_id,subject_id,subject_kind FROM api_tokens '+
    'WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() '+
    'AND $2=ANY(scopes) FOR SHARE',[principal.tokenId,scope]);
   if(!auth.rowCount||auth.rows[0].project_id!==projectId||
     auth.rows[0].subject_id!==principal.subjectId||auth.rows[0].subject_kind!==principal.kind)
    throw new IntegrationForbidden('Token revoked, expired or changed');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,11011))',['git-integration:'+projectId]);
   const root=await c.query<{repository_root:string|null}>(
    'SELECT repository_root FROM projects WHERE id=$1 FOR SHARE',[projectId]);
   if(!root.rowCount)throw new IntegrationNotFound('Project not found');
   if(!root.rows[0]!.repository_root)throw new IntegrationConflict('Dedicated bare integration repo not configured');
   const driver=new BareGitIntegration(root.rows[0]!.repository_root!);
   const outcome=await callback(c,driver);
   await c.query('COMMIT');
   return outcome;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 private async audit(c:PoolClient,projectId:string,id:string,action:string,actorId:string,detail:object){
  await c.query(
   'INSERT INTO git_integration_audit(project_id,request_id,action,actor_id,detail) VALUES($1,$2,$3,$4,$5::jsonb)',
   [projectId,id,action,actorId,JSON.stringify(detail)]);
 }
 private async read(c:PoolClient,projectId:string,id:string):Promise<Row>{
  const r=await c.query<Row>(
   'SELECT * FROM git_integration_requests WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,id]);
  if(!r.rowCount)throw new IntegrationNotFound('Integration request not found');
  return r.rows[0]!;
 }
 async submit(input:GitProposal,principal:AuthPrincipal){
  const p=GitProposalSchema.parse(input);this.actor(principal,p.projectId,'git:propose');
  return this.locked(p.projectId,principal,'git:propose',async(c,git)=>{
   git.verifyCandidate(p.candidateRef,p.baseSha,p.candidateSha);
   const existing=await c.query('SELECT 1 FROM git_integration_requests WHERE project_id=$1 AND task_id=$2',
    [p.projectId,p.taskId]);
   if(existing.rowCount)throw new IntegrationConflict('Task already has an integration proposal');
   const id=randomUUID();
   await c.query(
    'INSERT INTO git_integration_requests(id,project_id,task_id,submitter_id,candidate_ref,candidate_sha,base_sha,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [id,p.projectId,p.taskId,principal.subjectId,p.candidateRef,p.candidateSha,p.baseSha,p.priority]);
   await this.audit(c,p.projectId,id,'submitted',principal.subjectId,
    {candidateSha:p.candidateSha,baseSha:p.baseSha,origin:principal.origin});
   return {id,projectId:p.projectId,taskId:p.taskId,state:'queued',priority:p.priority};
  });
 }
 async prepare(projectId:string,id:string,principal:AuthPrincipal){
  UuidSchema.parse(projectId);UuidSchema.parse(id);this.actor(principal,projectId,'git:integrate');
  return this.locked(projectId,principal,'git:integrate',async(c,git)=>{
   const row=await this.read(c,projectId,id);
   if(row.state==='merged')throw new IntegrationConflict('Already merged');
   const ahead=await c.query(
    "SELECT id FROM git_integration_requests WHERE project_id=$1 AND state IN ('queued','stale') AND id<>$2 "+
    'AND (priority>$3 OR (priority=$3 AND (created_at<$4 OR (created_at=$4 AND id<$2)))) LIMIT 1',
    [projectId,id,row.priority,row.created_at]);
   if(ahead.rowCount)throw new IntegrationConflict('Higher priority queued proposal must be prepared first');
   let nextState='ready',prepared:ReturnType<BareGitIntegration['prepare']>|null=null;
   try{prepared=git.prepare(row.candidate_ref,row.base_sha,row.candidate_sha,id,row.created_at.toISOString());}
   catch(e){nextState=e instanceof GitValidationError&&String(e.message).includes('merge conflict')?'conflict':'tests_failed';}
   if(!prepared){
    await c.query("UPDATE git_integration_requests SET state=$3,reviewed_head=NULL,tested_tree=NULL,"+
      'planned_commit=NULL,review_sha256=NULL,review_evidence_id=NULL,approved_by=NULL,approved_at=NULL,'+
      'validation_json=$4::jsonb,updated_at=now() WHERE project_id=$1 AND id=$2',
     [projectId,id,nextState,JSON.stringify({ok:false,reason:'candidate conflict or combined checks did not pass'})]);
    await this.audit(c,projectId,id,'blocked',principal.subjectId,{state:nextState});
    return {id,state:nextState};
   }
   const snapshot=await this.evidence.appendTx(c,{
    projectId,taskId:row.task_id,runId:null,kind:'review_diff',
    scopeKey:'git-review:'+id,actorId:principal.subjectId,content:prepared.diff,
    metadata:{reviewHash:prepared.reviewHash,targetHead:prepared.targetHead,
     testedTree:prepared.tree,plannedCommit:prepared.commit}
   });
   if(snapshot.contentSha256!==prepared.diffSha256)throw new EvidenceIntegrityError('Stored diff mismatch');
   await c.query("UPDATE git_integration_requests SET state='ready',reviewed_head=$3,tested_tree=$4,"+
     'planned_commit=$5,review_sha256=$6,review_evidence_id=$7,approved_by=NULL,approved_at=NULL,'+
     'validation_json=$8::jsonb,updated_at=now() WHERE project_id=$1 AND id=$2',
    [projectId,id,prepared.targetHead,prepared.tree,prepared.commit,prepared.reviewHash,
     snapshot.id,JSON.stringify({ok:true,checks:prepared.checks,diffSha256:prepared.diffSha256})]);
   await this.audit(c,projectId,id,'prepared',principal.subjectId,
    {targetHead:prepared.targetHead,tree:prepared.tree,reviewHash:prepared.reviewHash,
     checks:prepared.checks});
   return {id,state:'ready',targetHead:prepared.targetHead,testedTree:prepared.tree,
    reviewHash:prepared.reviewHash,diff:prepared.diff,diffSha256:prepared.diffSha256,
    evidenceId:snapshot.id,checks:prepared.checks};
  });
 }
 private async verifiedReview(c:PoolClient,git:BareGitIntegration,row:Row){
  if(!row.review_evidence_id||!row.reviewed_head||!row.tested_tree||!row.review_sha256||
     !row.planned_commit)
   throw new IntegrationConflict('Immutable diff evidence missing; prepare again before review');
  const e=await this.evidence.read(row.project_id,row.task_id,row.review_evidence_id,c);
  const scope='git-review:'+row.id;
  if(e.kind!=='review_diff'||e.scopeKey!==scope||e.metadata.reviewHash!==row.review_sha256||
     e.metadata.targetHead!==row.reviewed_head||
     e.metadata.testedTree!==row.tested_tree||e.metadata.plannedCommit!==row.planned_commit)
   throw new EvidenceIntegrityError('Review evidence does not match prepared proposal');
  // Same exact tree and HEAD produce the exact bytes that were displayed for approval.
  const actual=git.reviewDiff(row.reviewed_head,row.tested_tree);
  if(createHash('sha256').update(actual).digest('hex')!==e.contentSha256||actual!==e.content)
   throw new EvidenceIntegrityError('Displayed diff differs from immutable reviewed artifact');
  return e;
 }
 async approve(projectId:string,id:string,reviewHash:string,principal:AuthPrincipal){
  UuidSchema.parse(projectId);UuidSchema.parse(id);
  if(!/^[a-f0-9]{64}$/.test(reviewHash))throw new IntegrationConflict('Invalid review hash');
  this.actor(principal,projectId,'git:review');
  if(principal.kind!=='human')throw new IntegrationForbidden('Human identity required');
  return this.locked(projectId,principal,'git:review',async(c,git)=>{
   const row=await this.read(c,projectId,id);
   if(row.approved_by)throw new IntegrationConflict('Proposal already reviewed; reprepare for a new review');
   if(row.state!=='ready'||row.review_sha256!==reviewHash||row.submitter_id===principal.subjectId)
    throw new IntegrationConflict('Proposal not reviewable by this human with this hash');
   const snapshot=await this.verifiedReview(c,git,row);
   if(git.head()!==row.reviewed_head)throw new IntegrationConflict('Base moved, reprepare before approval');
   try{git.verifyCandidate(row.candidate_ref,row.base_sha,row.candidate_sha);}
   catch{throw new IntegrationConflict('Candidate changed, reprepare before approval');}
   await c.query(
    'UPDATE git_integration_requests SET approved_by=$3,approved_at=now(),updated_at=now() WHERE project_id=$1 AND id=$2',
    [projectId,id,principal.subjectId]);
   await this.evidence.appendTx(c,{projectId,taskId:row.task_id,runId:null,
    kind:'review_approval',scopeKey:'git-approval:'+id,actorId:principal.subjectId,
    content:JSON.stringify({reviewHash,evidenceId:snapshot.id,diffSha256:snapshot.contentSha256,
     plannedCommit:row.planned_commit}),metadata:{reviewEvidenceId:snapshot.id}
   });
   await this.audit(c,projectId,id,'approved',principal.subjectId,
    {reviewHash,evidenceId:snapshot.id,diffSha256:snapshot.contentSha256});
   return {id,approved:true,reviewHash,approvedBy:principal.subjectId};
  });
 }
 async integrate(projectId:string,id:string,principal:AuthPrincipal){
  UuidSchema.parse(projectId);UuidSchema.parse(id);this.actor(principal,projectId,'git:integrate');
  return this.locked(projectId,principal,'git:integrate',async(c,git)=>{
   const row=await this.read(c,projectId,id);
   if(row.state==='merged'){
    await this.verifiedReview(c,git,row);
    return {id,state:'merged',commit:row.planned_commit,replayed:true};
   }
   if(row.state!=='ready'||!row.approved_by||!row.approved_at||!row.planned_commit||
      !row.reviewed_head||!row.review_sha256||!row.tested_tree)
    throw new IntegrationConflict('Verified human approval required before merge');
   await this.verifiedReview(c,git,row);
   if(git.head()===row.planned_commit){
    await c.query("UPDATE git_integration_requests SET state='merged',merged_at=now(),updated_at=now() WHERE project_id=$1 AND id=$2",[projectId,id]);
    await this.audit(c,projectId,id,'merged',principal.subjectId,{recovered:true,commit:row.planned_commit});
    return {id,state:'merged',commit:row.planned_commit,replayed:true};
   }
   const earlier=await c.query(
    "SELECT id FROM git_integration_requests WHERE project_id=$1 AND id<>$2 AND state='ready' AND approved_by IS NOT NULL "+
     'AND (priority>$3 OR (priority=$3 AND (created_at<$4 OR (created_at=$4 AND id<$2)))) LIMIT 1',
    [projectId,id,row.priority,row.created_at]);
   if(earlier.rowCount)throw new IntegrationConflict('Earlier approved proposal must integrate first');
   let stale=git.head()!==row.reviewed_head;
   if(!stale){
    try{git.verifyCandidate(row.candidate_ref,row.base_sha,row.candidate_sha);}
    catch{stale=true;}
   }
   if(stale){
    await c.query("UPDATE git_integration_requests SET state='stale',approved_by=NULL,approved_at=NULL,"+
      'updated_at=now() WHERE project_id=$1 AND id=$2',[projectId,id]);
    await this.audit(c,projectId,id,'stale',principal.subjectId,{reason:'branch or target changed'});
    return {id,state:'stale',replayed:false};
   }
   try{git.apply(row.reviewed_head,row.planned_commit);}
   catch{
    await c.query("UPDATE git_integration_requests SET state='stale',approved_by=NULL,approved_at=NULL,"+
      'updated_at=now() WHERE project_id=$1 AND id=$2',[projectId,id]);
    await this.audit(c,projectId,id,'stale',principal.subjectId,{reason:'atomic Git ref CAS failed'});
    return {id,state:'stale',replayed:false};
   }
   await c.query("UPDATE git_integration_requests SET state='merged',merged_at=now(),updated_at=now() WHERE project_id=$1 AND id=$2",[projectId,id]);
   await this.audit(c,projectId,id,'merged',principal.subjectId,{commit:row.planned_commit,
    tree:row.tested_tree,reviewHash:row.review_sha256,approvedBy:row.approved_by});
   return {id,state:'merged',commit:row.planned_commit,replayed:false};
  });
 }
 async get(projectId:string,id:string,principal:AuthPrincipal){
  UuidSchema.parse(projectId);UuidSchema.parse(id);this.actor(principal,projectId,'tasks:read');
  const r=await this.pool.query<Row>(
   'SELECT * FROM git_integration_requests WHERE project_id=$1 AND id=$2',[projectId,id]);
  if(!r.rowCount)throw new IntegrationNotFound('Integration request not found');
  const x=r.rows[0]!;
  let review:null|{evidenceId:string;diff:string;diffSha256:string;version:number}=null;
  if(x.state==='ready'||x.state==='merged'){
   const source=await this.pool.query<{repository_root:string|null}>(
    'SELECT repository_root FROM projects WHERE id=$1',[projectId]);
   if(!source.rows[0]?.repository_root)throw new IntegrationConflict('Cannot verify review Git source');
   const git=new BareGitIntegration(source.rows[0]!.repository_root!);
   const client=await this.pool.connect();
   try{
    const snapshot=await this.verifiedReview(client,git,x);
    review={evidenceId:snapshot.id,diff:snapshot.content,diffSha256:snapshot.contentSha256,
     version:snapshot.version};
   }finally{client.release();}
  }
  return {id:x.id,projectId,taskId:x.task_id,state:x.state,priority:x.priority,
   candidateRef:x.candidate_ref,candidateSha:x.candidate_sha,baseSha:x.base_sha,
   targetHead:x.reviewed_head,testedTree:x.tested_tree,reviewHash:x.review_sha256,
   review,approvedBy:x.approved_by,mergedCommit:x.state==='merged'?x.planned_commit:null,checks:x.validation_json};
 }
 async list(projectId:string,principal:AuthPrincipal){
  UuidSchema.parse(projectId);this.actor(principal,projectId,'tasks:read');
  const r=await this.pool.query(
   'SELECT id,task_id,state,priority,review_sha256,approved_by FROM git_integration_requests WHERE project_id=$1 ORDER BY priority DESC,created_at,id LIMIT 100',[projectId]);
  return r.rows.map(x=>({id:x.id,taskId:x.task_id,state:x.state,priority:x.priority,
   reviewHash:x.review_sha256,approvedBy:x.approved_by}));
 }
}
