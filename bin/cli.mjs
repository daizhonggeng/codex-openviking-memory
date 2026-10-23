#!/usr/bin/env node
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {loadConfig,defaultConfigPath,configFingerprint,assertIdentity} from '../lib/config.mjs';
import {loadCredentials} from '../lib/credentials.mjs';
import {Vault,propose,handleHook} from '../lib/candidate-core.mjs';
import {runOfficialCapture} from '../lib/official-writer.mjs';
import {createHandler,runMcp} from '../lib/readonly-mcp.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const help=`Codex OpenViking Memory v0.1.0

node bin/cli.mjs propose --config PATH --input FILE
node bin/cli.mjs hook UserPromptSubmit --config PATH  (hook JSON on stdin)
node bin/cli.mjs hook Stop --config PATH              (hook JSON on stdin)
node bin/cli.mjs doctor --config PATH
node bin/cli.mjs status --config PATH --id CANDIDATE_ID
node bin/cli.mjs mcp --config PATH

Configuration defaults to OVCM_CONFIG or the per-user application data folder.
Only human-confirmed candidate summaries are eligible for the Stop hook.
`;

async function stdin(){
  let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>4*1024*1024)throw Error('Input exceeds the supported size');}return value;
}
const json=value=>process.stdout.write(JSON.stringify(value)+'\n');
function parseJson(value){try{return JSON.parse(value);}catch{throw Error('Input must be valid JSON');}}
const psQuote=value=>"'"+value.replaceAll("'","''")+"'";
const shQuote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";

function reviewContext(config){
  const command=process.platform==='win32'
    ?`& ${psQuote(process.execPath)} ${psQuote(join(root,'bin','cli.mjs'))} propose --config ${psQuote(config.configPath)} --input <UTF8_JSON_FILE>`
    :`${shQuote(process.execPath)} ${shQuote(join(root,'bin','cli.mjs'))} propose --config ${shQuote(config.configPath)} --input <UTF8_JSON_FILE>`;
  return `[codex-openviking-memory semantic-review-v1] During the current normal response, assess the current human message for durable personal facts, preferences, goals, or reusable knowledge. Use semantic judgement, not keywords. Do not invent facts or treat quoted, third-party, fictional, test, placeholder, ordinary help requests, temporary feelings, or this integration's setup as personal memory. Do not extract from old chats. Do not make a separate model request or upload a transcript to decide. If nothing is worth saving, answer normally without a memory-review notice. Otherwise propose at most 3 concise summaries in the user's language. For each, create a UTF-8 JSON file containing ONLY summary (2-2000 characters), kind (profile/preference/current/knowledge), and source (current-human-statement), then run: ${command}. Use its real candidate id. Prefer a native request_user_input_async confirmation card displaying the summary with choices exactly "save candidate <REAL_ID>" and "Not now" (Chinese: "保存候选 <REAL_ID>" / "暂不保存"). If this client lacks a native card tool, clearly state that limitation and offer the exact text confirmation. Displaying a card is not approval. Never invoke the hook entrypoint yourself, fabricate a human reply, or call a write API. Only the trusted UserPromptSubmit/Stop hooks handle the human's actual selection. Do not submit Git commits or upload raw chat/tool logs as memory. Read existing relevant knowledge only when needed through the read-only MCP, and restrict search to mode=list without session_id. After a submission, use the status command and read-only MCP readback before claiming extraction and retrieval succeeded.`;
}

async function request(config,apiKey,path,origin=config.writeUrl){
  let response;
  try{response=await fetch(origin+path,{headers:{Authorization:`Bearer ${apiKey}`},redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch{throw Error('Service connection failed; check the configured endpoint and local credential');}
  if(!response.ok)throw Error(`Service request failed (HTTP ${response.status})`);
  try{return await response.json();}catch{throw Error('Service returned an invalid JSON response');}
}

async function ready(config){
  try{const state=JSON.parse(await readFile(join(config.dataDir,'state','readiness.json'),'utf8'));return state.ready===true&&state.fingerprint===configFingerprint(config);}catch{return false;}
}

async function saveReadiness(config,value){
  const directory=join(config.dataDir,'state');await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'readiness.json'),JSON.stringify({schemaVersion:1,ready:value,fingerprint:configFingerprint(config),checkedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
}

async function doctor(config){
  await saveReadiness(config,false);
  const {apiKey}=await loadCredentials(config,{needVault:false});
  assertIdentity(await request(config,apiKey,'/health',config.serverUrl),config);
  if(config.writeUrl!==config.serverUrl)assertIdentity(await request(config,apiKey,'/health'),config);
  const handler=createHandler({config,credentialProvider:()=>apiKey});
  const read=await handler({jsonrpc:'2.0',id:'doctor',method:'tools/call',params:{name:'list',arguments:{uri:config.memoryRoot,limit:1}}});
  if(read?.error||read?.result?.isError)throw Error('Read-only memory scope could not be verified');
  await saveReadiness(config,true);
  json({ready:true,account:config.account,user:config.user,role:'user',readScopeVerified:true,nativeButtonAvailability:'check-in-client',writePerformed:false});
}

async function status(config,vault,id){
  if(!/^[a-f0-9]{16}$/.test(id||''))throw Error('A valid candidate id is required');
  const candidate=await vault.get(id);if(!candidate)throw Error('Candidate does not exist locally');
  const result={id,status:candidate.status,expiresAt:candidate.expiresAt};
  const batch=candidate.batchId?await vault.get(candidate.batchId):null;
  if(candidate.status==='submitted'||batch?.status==='submitted'){
    const receipt=batch?.receipt;
    result.status='submitted';
    result.submitted=true;result.indexVerified=false;result.readbackRequired=true;
    if(receipt?.taskId){
      const {apiKey}=await loadCredentials(config,{needVault:false});
      assertIdentity(await request(config,apiKey,'/health'),config);
      if(typeof receipt.taskId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(receipt.taskId))throw Error('Invalid task receipt');
      const task=(await request(config,apiKey,'/api/v1/tasks/'+encodeURIComponent(receipt.taskId))).result;
      result.taskId=receipt.taskId;
      result.taskStatus=['pending','queued','running','completed','failed','cancelled','canceled'].includes(task?.status)?task.status:'unknown';
      result.stage=typeof task?.stage==='string'&&/^[a-z][a-z0-9_.:-]{0,63}$/i.test(task.stage)&&!task.stage.includes(apiKey)?task.stage:null;
      if(Number.isSafeInteger(task?.result?.memories_extracted))result.memoriesExtracted=task.result.memories_extracted;
      result.errorPresent=Boolean(task?.error);
    }else result.taskStatus='unknown';
  }
  json(result);
}

async function main(){
  const {values,positionals}=parseArgs({options:{config:{type:'string'},input:{type:'string'},id:{type:'string'},help:{type:'boolean',short:'h'}},allowPositionals:true,strict:true});
  if(values.help||!positionals.length){process.stdout.write(help);return;}
  const command=positionals[0],config=await loadConfig(values.config||defaultConfigPath());
  if(command==='doctor'){await doctor(config);return;}
  if(command==='mcp'){const {apiKey}=await loadCredentials(config,{needVault:false});await runMcp({config,apiKey});return;}
  if(!['propose','hook','status'].includes(command))throw Error('Unknown command; use --help');
  const {vaultKey}=await loadCredentials(config,{needApi:false});
  const vault=new Vault(join(config.dataDir,'candidate-vault'),vaultKey);
  if(command==='propose'){
    if(!values.input)throw Error('--input is required');
    const raw=values.input==='-'?await stdin():await readFile(resolve(values.input),'utf8');
    if(raw.length>65536)throw Error('Candidate input is too large');
    json(await propose(vault,parseJson(raw)));return;
  }
  if(command==='status'){await status(config,vault,values.id);return;}
  const event=positionals[1];if(!['UserPromptSubmit','Stop','SessionStart','SessionEnd','PreCompact'].includes(event))throw Error('Unknown hook event');
  const input=parseJson(await stdin()||'{}');
  const writer=async({batch,candidates})=>{
    const {apiKey}=await loadCredentials(config,{needVault:false});
    return runOfficialCapture({source:join(root,'vendor','OpenViking-v0.5.1.1'),workRoot:join(config.dataDir,'approved-hook-data'),guard:join(root,'lib','approval-transport.mjs'),batchId:batch.id,summaries:candidates.map(candidate=>candidate.summary),apiKey,config});
  };
  json(await handleHook({vault,event,input,primaryReady:await ready(config),writer,reviewContext:reviewContext(config)}));
}

main().catch(error=>{
  // 错误仅来自本地校验或固定服务状态，不输出服务响应正文或凭据。
  process.stderr.write(JSON.stringify({error:error?.message||'Operation failed'})+'\n');
  process.exitCode=1;
});
