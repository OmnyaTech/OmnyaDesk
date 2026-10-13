const [url,projectId]=process.argv.slice(2);
const credential=process.env.OMNYA_SCHEDULER_TEST_TOKEN;
if(!credential||!url||!projectId)throw Error('Missing isolated scheduler probe configuration');
const response=await fetch(new URL('/v1/projects/'+projectId+'/scheduler/claim',url),{
 method:'POST',
 headers:{authorization:'Bearer '+credential,'content-type':'application/json'},
 body:JSON.stringify({ttlMs:250}),
 signal:AbortSignal.timeout(5000)
});
if(response.status!==200)throw Error('Claim returned '+response.status);
const body=await response.json();
console.log(JSON.stringify(body.claim));
