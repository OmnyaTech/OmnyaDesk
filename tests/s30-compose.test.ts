import assert from 'node:assert/strict';
import test from 'node:test';
import {allowedApiBind} from '../apps/api/src/server.ts';
import {readFileSync} from 'node:fs';
test('S30 default API listener remains loopback-only; container opt-in cannot enable public host',()=>{
 assert.equal(allowedApiBind('127.0.0.1',false,false),true);
 assert.equal(allowedApiBind('::1',false,false),true);
 for(const bind of ['0.0.0.0','::','1.2.3.4','localhost','']){
  if(bind==='0.0.0.0')continue;
  assert.equal(allowedApiBind(bind,true,true),false,bind);
 }
 assert.equal(allowedApiBind('0.0.0.0',false,true),false);
 assert.equal(allowedApiBind('0.0.0.0',true,false),false);
 assert.equal(allowedApiBind('0.0.0.0',true,true),true);
});
test('S30 Compose declares exclusive networks and loopback web only; no ports for API, worker or DB',()=>{
 const source=readFileSync('infra/s30/compose.yaml','utf8');
 const services=source.slice(source.indexOf('\nservices:'),source.indexOf('\nnetworks:'));
 assert.match(services,/127\.0\.0\.1:4387:8080/);
 assert.equal((services.match(/^ {4}ports:/gm)??[]).length,1);
 assert.match(source,/name: omnyadesk_backend/);
 assert.match(source,/name: omnyadesk_ingress/);
 assert.match(source,/internal: true/);
 assert.match(source,/OMNYADESK_INGRESS_SUBNET:\?/);
 assert.match(source,/OMNYADESK_BACKEND_SUBNET:\?/);
 assert.match(source,/omnyadesk_db_data/);
 assert.match(source,/OMNYADESK_SECRET_FILE:\?/);
 for(const name of ['db','api','worker','web'])
  assert.match(services,new RegExp('^  '+name+':','m'));
 assert.doesNotMatch(source,/privileged:\s*true|network_mode:\s*host|\/var\/run\/docker\.sock/);
 assert.match(services,/read_only: true/);
 assert.match(services,/no-new-privileges:true/);
});
