import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateConfig,validateOrigin,assertIdentity,configFingerprint} from '../lib/config.mjs';
import {validateApiKey,validateVaultKey} from '../lib/credentials.mjs';

const raw={schemaVersion:1,serverUrl:'https://memory.example.com',account:'test-account',user:'test-user',dataDir:join(tmpdir(),'ovcm-config-test')};
test('derive isolated roots and write origin from explicit user configuration',()=>{
  const config=validateConfig(raw);
  assert.equal(config.memoryRoot,'viking://user/test-user/memories/');
  assert.equal(config.resourceRoot,'viking://user/test-user/resources/personal-context/');
  assert.equal(config.writeUrl,raw.serverUrl);
  assert.notEqual(configFingerprint(config),configFingerprint(validateConfig({...raw,user:'other-user'})));
});
test('reject unsafe origins, identity paths, extra fields, and relative data paths',()=>{
  for(const url of ['http://memory.example.com','https://user:secret@example.com','https://example.com/path','https://example.com?','https://example.com/#','file:///tmp/data','javascript:alert(1)'])assert.throws(()=>validateOrigin(url));
  assert.equal(validateOrigin('http://127.0.0.1:11933'),'http://127.0.0.1:11933');
  for(const user of ['../another','user/name','',123])assert.throws(()=>validateConfig({...raw,user}));
  assert.throws(()=>validateConfig({...raw,apiKey:'never-store-in-config'}));
  assert.throws(()=>validateConfig({...raw,dataDir:'./relative'}));
});
test('ordinary-user identity is mandatory including enveloped health responses',()=>{
  const config=validateConfig(raw),health={status:'ok',healthy:true,account_id:config.account,user_id:config.user,role:'user'};
  assert.doesNotThrow(()=>assertIdentity(health,config));
  assert.doesNotThrow(()=>assertIdentity({status:'ok',result:health},config));
  for(const change of [{role:'admin'},{role:'root'},{healthy:false},{account_id:'other'},{user_id:'other'},{status:'error'}])assert.throws(()=>assertIdentity({...health,...change},config));
});
test('credentials reject malformed vault keys and header injection',()=>{
  assert.equal(validateVaultKey(Buffer.alloc(32,7).toString('base64')),Buffer.alloc(32,7).toString('base64'));
  for(const value of ['', 'not-a-key',Buffer.alloc(31).toString('base64'),Buffer.alloc(33).toString('base64')])assert.throws(()=>validateVaultKey(value));
  for(const value of ['', '  ','dummy\r\ninjected: yes','dummy\u0000credential','dummy\u007fcredential','dummy\u4e2dcredential'])assert.throws(()=>validateApiKey(value));
});
