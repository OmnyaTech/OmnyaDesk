// S18 independently executed fixture QA and reviewer verification.
// This verifier is a separate process, never an LLM, and NEVER grants S15 approval.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const sha=s=>createHash('sha256').update(s,'utf8').digest('hex');
const role=process.argv[2];
const data=JSON.parse(readFileSync(0,'utf8'));
assert.ok(role==='qa'||role==='reviewer');
assert.match(data.outputSha256,/^[0-9a-f]{64}$/);
assert.equal(sha(data.output),data.outputSha256);
assert.ok(data.output.length>=10&&data.output.length<=16000);
assert.ok(data.output.includes('S18_SYNTHETIC'),'Expected synthetic safety sentinel');
assert.ok(!/\b(human approved|merged to main|deployed to production)\b/i.test(data.output));
const repo=JSON.parse(readFileSync('/runtime/pilot/fixture-metadata.json','utf8'));
const readme=readFileSync(repo.readme,'utf8');
assert.ok(readme.includes('S18_SYNTHETIC')&&readme.includes('fixture'));
if(role==='qa'){
 assert.equal(sha(data.output),data.developerOutputSha256);
 assert.equal(data.actorId,'external-s18-ci');
}else{
 assert.equal(data.actorId,'external-s18-independent-review');
 assert.match(data.output,/risk/i,'Reviewer must discuss synthetic risk');
}
const receipt={passed:true,role,examinerId:data.actorId,
 outputSha256:data.outputSha256,reportSha256:sha(role+':'+data.outputSha256+':'+sha(readme)+':verified')};
process.stdout.write(JSON.stringify(receipt)+'\n');
