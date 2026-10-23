import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=fileURLToPath(new URL('..',import.meta.url));
const excluded=new Set(['.git','node_modules']);
const privateDirectories=new Set(['secrets','candidate-vault','approved-hook-data','backups','logs','knowledge']);
const secretPatterns=[/^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m,/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,/\bgithub_pat_[A-Za-z0-9_]{30,}\b/,/\bsk-[A-Za-z0-9_-]{30,}\b/];
const failures=[];let checked=0;
async function visit(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(excluded.has(entry.name))continue;
    const path=join(directory,entry.name),label=relative(root,path);
    if(entry.isSymbolicLink()){failures.push(`${label}: symlinks are not distributed`);continue;}
    if(entry.isDirectory()){
      if(privateDirectories.has(entry.name)){failures.push(`${label}: local private data directory`);continue;}
      await visit(path);continue;
    }
    if(/\.dpapi$|\.keychain(?:-db)?$|\.approved\.jsonl$|\.receipt\.jsonl$|^\.env(?:\.|$)/.test(entry.name)){failures.push(`${label}: private runtime file`);continue;}
    const content=await readFile(path,'utf8');
    if(secretPatterns.some(pattern=>pattern.test(content)))failures.push(`${label}: potential credential material`);
    if(entry.name.endsWith('.mjs')){
      try{execFileSync(process.execPath,['--check',path],{stdio:'pipe',windowsHide:true});}
      catch{failures.push(`${label}: JavaScript syntax check failed`);}
    }
    checked++;
  }
}
await visit(root);
if(failures.length){process.stderr.write(failures.join('\n')+'\n');process.exitCode=1;}
else process.stdout.write(`Checked ${checked} source files: syntax and distribution checks passed.\n`);
