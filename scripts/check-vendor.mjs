import {readFile,readdir} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const vendor=fileURLToPath(new URL('../vendor/',import.meta.url));
const metadata=JSON.parse(await readFile(join(vendor,'UPSTREAM.json'),'utf8'));
if(!metadata.files||typeof metadata.files!=='object'||!Object.keys(metadata.files).length)throw Error('Missing vendored file checksums');
for(const [name,expected] of Object.entries(metadata.files)){
  const path=resolve(vendor,name);
  if(!path.startsWith(resolve(vendor)+sep)||!/^[a-f0-9]{64}$/.test(expected))throw Error('Invalid vendor manifest entry');
  const actual=createHash('sha256').update(await readFile(path)).digest('hex');
  if(actual!==expected)throw Error(`Vendored source checksum mismatch: ${name}`);
}
async function list(directory){
  const paths=[];
  for(const item of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,item.name);
    if(item.isSymbolicLink())throw Error('Vendored symlinks are not allowed');
    if(item.isDirectory())paths.push(...await list(path));else paths.push(path);
  }
  return paths;
}
const manifestFiles=new Set(Object.keys(metadata.files).map(name=>resolve(vendor,name)));
for(const path of await list(join(vendor,'OpenViking-v0.5.1.1')))if(!manifestFiles.has(resolve(path)))throw Error('Unexpected vendored file');
process.stdout.write(`Verified ${manifestFiles.size} pinned upstream files (${metadata.ref}).\n`);
