import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,readdir,realpath,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';

const cli=fileURLToPath(new URL('../bin/cli.mjs',import.meta.url));
async function fixture(t,{configName='config.json'}={}){
  const temporaryBase=await realpath(tmpdir());
  const directory=await mkdtemp(join(temporaryBase,'ovcm-cli-'));
  const state={messages:[],commits:0,requests:[],malformedHealth:false};
  const health={status:'ok',healthy:true,account_id:'test-account',user_id:'test-user',role:'user'};
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    let body;try{body=raw?JSON.parse(raw):null;}catch{body=null;}
    state.requests.push({method:req.method,path:req.url,body});
    const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.headers.authorization!=='Bearer test-only-credential'){send({status:'error'},401);return;}
    if(req.url==='/health'){
      if(state.malformedHealth){res.writeHead(200,{'Content-Type':'application/json'});res.end('sensitive_response_never_echo');}
      else send(health);
      return;
    }
    if(req.url==='/mcp'){
      if(body?.method==='initialize')send({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'mock',version:'1'}}});
      else if(body?.method==='notifications/initialized'){res.writeHead(202);res.end();}
      else if(body?.method==='tools/call')send({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:'[]'}],isError:false}});
      else send({status:'error'},404);
      return;
    }
    if(req.url==='/api/v1/tasks/integration-task'){send({status:'ok',result:{status:'completed',stage:'completed',result:{memories_extracted:1},error:null}});return;}
    if(/^\/api\/v1\/sessions\/cx-confirmed-[a-f0-9]{16}\/messages\/batch$/.test(req.url)&&req.method==='POST'){
      state.messages.push(...body.messages);send({status:'ok',result:{}});return;
    }
    if(/^\/api\/v1\/sessions\/cx-confirmed-[a-f0-9]{16}\/commit$/.test(req.url)&&req.method==='POST'){
      state.commits++;send({status:'ok',result:{task_id:'integration-task'}});return;
    }
    if(/^\/api\/v1\/sessions\/cx-confirmed-[a-f0-9]{16}$/.test(req.url)&&req.method==='GET'){
      if(!state.messages.length&&!state.commits)send({status:'error'},404);
      else send({status:'ok',result:{commit_count:state.commits,pending_tokens:state.messages.length*10,total_message_count:state.messages.length}});
      return;
    }
    send({status:'error'},404);
  });
  await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
  t.after(async()=>{
    server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose));
    assert.ok(resolve(directory).startsWith(resolve(temporaryBase)+sep));
    await rm(directory,{recursive:true,force:true});
  });
  const origin=`http://127.0.0.1:${server.address().port}`;
  const configPath=join(directory,configName);
  const config={schemaVersion:1,serverUrl:origin,writeUrl:origin,account:'test-account',user:'test-user',dataDir:directory};
  await writeFile(configPath,JSON.stringify(config));
  const env={...process.env,OVCM_API_KEY:'test-only-credential',OVCM_VAULT_KEY:randomBytes(32).toString('base64')};
  async function run(args,input='',override={}){
    return new Promise((resolveRun,reject)=>{
      const child=spawn(process.execPath,[cli,...args,'--config',configPath],{env:{...env,...override},windowsHide:true,stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';
      const timer=setTimeout(()=>{child.kill();reject(Error('CLI test timed out'));},25000);
      child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{clearTimeout(timer);resolveRun({code,stdout,stderr});});
      child.stdin.on('error',()=>{});child.stdin.end(input);
    });
  }
  return {directory,state,run,configPath,config};
}

test('CLI wires native confirmation, readiness, real vendor hooks and safe status against a loopback mock service',async t=>{
  const {directory,state,run}=await fixture(t);
  const summary='Synthetic acceptance-test preference.';
  const inputPath=join(directory,'candidate.json');
  await writeFile(inputPath,JSON.stringify({summary,kind:'knowledge',source:'current-human-statement'}));
  const proposed=await run(['propose','--input',inputPath]);assert.equal(proposed.code,0,proposed.stderr);
  const id=JSON.parse(proposed.stdout).id;
  assert.equal(state.requests.length,0);
  const envelope='<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','call_integration',0]),question:'Save the test candidate?',answer:'save candidate '+id}])+'\n</send_user_message_question_reply>';
  const approved=await run(['hook','UserPromptSubmit'],JSON.stringify({session_id:'test-session',prompt:envelope}));
  assert.equal(approved.code,0,approved.stderr);assert.match(approved.stdout,/human approved/i);
  const blocked=await run(['hook','Stop'],JSON.stringify({session_id:'test-session'}));
  assert.equal(blocked.code,0,blocked.stderr);assert.match(blocked.stdout,/nothing was submitted/i);assert.equal(state.commits,0);
  const doctor=await run(['doctor']);assert.equal(doctor.code,0,doctor.stderr);assert.equal(JSON.parse(doctor.stdout).ready,true);
  assert.equal(state.commits,0);
  const saved=await run(['hook','Stop'],JSON.stringify({session_id:'test-session',transcript_path:'MUST-NOT-BE-READ'}));
  assert.equal(saved.code,0,saved.stderr);assert.match(saved.stdout,/Submitted 1/);
  assert.equal(state.commits,1);assert.equal(state.messages.length,1);assert.deepEqual(state.messages[0].parts,[{type:'text',text:summary}]);
  const retry=await run(['hook','Stop'],JSON.stringify({session_id:'test-session'}));assert.equal(retry.code,0,retry.stderr);assert.equal(state.commits,1);
  const status=await run(['status','--id',id]);assert.equal(status.code,0,status.stderr);
  const result=JSON.parse(status.stdout);assert.equal(result.status,'submitted');assert.equal(result.taskStatus,'completed');assert.equal(result.indexVerified,false);assert.equal(result.readbackRequired,true);
  assert.ok(!status.stdout.includes(summary));
  assert.ok(!(await readdir(join(directory,'approved-hook-data'))).some(name=>name.endsWith('.approved.jsonl')));
});

test('CLI does not reflect malformed credentials, malformed service JSON, or input JSON',async t=>{
  const {state,run,directory}=await fixture(t);
  const badCredential=await run(['doctor'],'',{OVCM_API_KEY:'synthetic\u007fcredential'});
  assert.notEqual(badCredential.code,0);assert.ok(!badCredential.stderr.includes('synthetic'));assert.equal(state.requests.length,0);
  state.malformedHealth=true;
  const badResponse=await run(['doctor']);assert.notEqual(badResponse.code,0);assert.ok(!badResponse.stderr.includes('sensitive_response_never_echo'));
  assert.equal(JSON.parse(await readFile(join(directory,'state','readiness.json'),'utf8')).ready,false);
  const badJson=await run(['propose','--input','-'],'{sensitive_input_never_echo');assert.notEqual(badJson.code,0);assert.ok(!badJson.stderr.includes('sensitive_input_never_echo'));
});

test('review instructions quote configured paths safely for the current shell',async t=>{
  const {run,configPath,state}=await fixture(t,{configName:"config 'literal$(value)`.json"});
  const result=await run(['hook','UserPromptSubmit'],JSON.stringify({session_id:'test-session',prompt:'An ordinary question.'}));
  assert.equal(result.code,0,result.stderr);
  const context=JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  const expected=process.platform==='win32'?"'"+configPath.replaceAll("'","''")+"'":"'"+configPath.replaceAll("'","'\"'\"'")+"'";
  assert.ok(context.includes('--config '+expected));assert.equal(state.requests.length,0);
});

test('template commands map the existing hierarchy and preserve files without credentials or network access',async t=>{
  const {run,configPath,directory,state}=await fixture(t);
  const withoutCredentials={OVCM_API_KEY:'',OVCM_VAULT_KEY:''};
  const originalConfig=await readFile(configPath,'utf8');
  const mapped=await run(['template','map'],'',withoutCredentials);assert.equal(mapped.code,0,mapped.stderr);
  const mapping=JSON.parse(mapped.stdout);
  assert.equal(mapping.coreFiles.profile.resourceUri,'viking://user/test-user/resources/personal-context/PROFILE.md');
  assert.equal(mapping.memoryRoot,'viking://user/test-user/memories/');
  await assert.rejects(access(join(directory,'knowledge')));
  const initialized=await run(['template','init'],'',withoutCredentials);assert.equal(initialized.code,0,initialized.stderr);
  assert.ok(JSON.parse(initialized.stdout).created.includes('PROFILE.md'));
  const profile=join(directory,'knowledge','PROFILE.md');
  const custom='Synthetic user-edited content retained during template upgrade.\n';
  await writeFile(profile,custom);
  const second=await run(['template','init'],'',withoutCredentials);assert.equal(second.code,0,second.stderr);
  assert.ok(JSON.parse(second.stdout).skipped.includes('PROFILE.md'));
  assert.equal(await readFile(profile,'utf8'),custom);
  assert.equal(await readFile(configPath,'utf8'),originalConfig);
  assert.equal(state.requests.length,0);
});
