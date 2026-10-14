import {executeCli,CliError} from './client.mjs';

try{
 const answer=await executeCli(process.argv.slice(2),{
  token:process.env.OMNYA_TOKEN,
  baseUrl:process.env.OMNYA_URL??'http://127.0.0.1:4317',
  onMutationKey:(kind,key)=>console.error(kind+': '+key+' (reutilize --key ao reenviar)')
 });
 if(answer.help)console.log(answer.help);
 else {
  console.log(JSON.stringify(answer.result,null,2));
 }
}catch(error){
 console.error(error instanceof CliError?error.message:'Falha de execução do CLI (detalhes privados omitidos).');
 process.exitCode=error instanceof CliError?error.exitCode:1;
}
