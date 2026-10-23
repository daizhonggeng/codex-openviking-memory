import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';

async function readDpapi(path){
  if(process.platform!=='win32')throw Error('Configure OVCM_API_KEY and OVCM_VAULT_KEY on this platform');
  const script="$ErrorActionPreference='Stop';$cipher=[Convert]::FromBase64String([IO.File]::ReadAllText($env:OVCM_SECRET_FILE).Trim());$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);try{[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))}finally{[Array]::Clear($plain,0,$plain.Length)}";
  try{
    const result=await promisify(execFile)('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:16384,env:{...process.env,OVCM_SECRET_FILE:path}});
    return result.stdout.trim();
  }catch{throw Error('Local credential could not be unlocked; rerun the installer as the same OS user');}
}

export function validateVaultKey(value){
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value)||Buffer.from(value,'base64').length!==32||Buffer.from(value,'base64').toString('base64')!==value)throw Error('Vault key must be a base64-encoded 32-byte random key');
  return value;
}

export function validateApiKey(value){
  if(typeof value!=='string'||!/^[\x21-\x7e]+$/.test(value))throw Error('A local ordinary-user API credential is required');
  return value;
}

export async function loadCredentials(config,{needApi=true,needVault=true}={}){
  const credentials={};
  if(needApi)credentials.apiKey=validateApiKey(process.env.OVCM_API_KEY||await readDpapi(join(config.dataDir,'secrets','api-key.dpapi')));
  if(needVault)credentials.vaultKey=validateVaultKey(process.env.OVCM_VAULT_KEY||await readDpapi(join(config.dataDir,'secrets','vault-key.dpapi')));
  return credentials;
}
