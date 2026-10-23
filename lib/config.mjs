import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

const identifier=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const allowedFields=new Set(['schemaVersion','serverUrl','writeUrl','account','user','dataDir']);

export function validateOrigin(value){
  if(typeof value!=='string'||!value.trim()||value!==value.trim())throw Error('Invalid service origin');
  let url;try{url=new URL(value);}catch{throw Error('Invalid service origin');}
  if(url.username||url.password||value.includes('?')||value.includes('#')||url.pathname!=='/')throw Error('Service URL must be an origin without credentials, path, query, or fragment');
  const loopback=['127.0.0.1','[::1]','localhost'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw Error('Service origin requires HTTPS or loopback HTTP');
  return url.origin;
}

export function defaultConfigPath(){
  if(process.env.OVCM_CONFIG)return resolve(process.env.OVCM_CONFIG);
  const dataRoot=process.platform==='win32'
    ?join(process.env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'CodexOpenVikingMemory')
    :join(process.env.XDG_STATE_HOME||join(homedir(),'.local','state'),'codex-openviking-memory');
  return join(dataRoot,'config.json');
}

export function validateConfig(raw,configPath=defaultConfigPath()){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!allowedFields.has(key)))throw Error('Invalid configuration fields');
  if(raw.schemaVersion!==1)throw Error('Unsupported configuration schemaVersion');
  if(typeof raw.account!=='string'||typeof raw.user!=='string'||!identifier.test(raw.account)||!identifier.test(raw.user))throw Error('Account and user must be explicit safe identifiers');
  if(typeof raw.dataDir!=='string'||!isAbsolute(raw.dataDir))throw Error('dataDir must be an absolute path');
  const serverUrl=validateOrigin(raw.serverUrl),writeUrl=validateOrigin(raw.writeUrl??raw.serverUrl);
  return Object.freeze({...raw,serverUrl,writeUrl,dataDir:resolve(raw.dataDir),configPath:resolve(configPath),memoryRoot:`viking://user/${raw.user}/memories/`,resourceRoot:`viking://user/${raw.user}/resources/personal-context/`});
}

export async function loadConfig(configPath=defaultConfigPath()){
  let raw;try{raw=JSON.parse(await readFile(configPath,'utf8'));}catch{throw Error('Configuration is missing or invalid; run the installer first');}
  return validateConfig(raw,configPath);
}

export function assertIdentity(health,config){
  const identity=health?.result&&typeof health.result==='object'?health.result:health;
  if(health?.status!=='ok'||(identity.status!==undefined&&identity.status!=='ok')||identity.healthy!==true||identity.account_id!==config.account||identity.user_id!==config.user||identity.role!=='user')throw Error('Service identity must match the configured account and user with role=user');
}

export function configFingerprint(config){
  return createHash('sha256').update(JSON.stringify([config.schemaVersion,config.serverUrl,config.writeUrl,config.account,config.user,config.dataDir])).digest('hex');
}
