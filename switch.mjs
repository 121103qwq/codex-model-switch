#!/usr/bin/env node
// Node.js 22.13+. No dependencies. Public commands: on, off, status.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(import.meta.url);
const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const root = path.join(home, 'simple-model-switch');
const target = path.join(home, 'config.toml');
const stateFile = path.join(root, 'state.json');
const alias = 'router-custom';
const header = 'x-codex-router-token';
const startup = process.platform === 'win32'
  ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'CodexSimpleModelSwitch.vbs') : null;
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const quote = value => JSON.stringify(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, value, {mode: 0o600});
  fs.renameSync(temp, file);
}
function save(state) { write(stateFile, JSON.stringify(state, null, 2)); }
function acquireLock(file) {
  try{return fs.openSync(file,'wx');}catch(error){if(error.code!=='EEXIST')throw error;}
  const contents=fs.readFileSync(file,'utf8'),pid=Number(contents);
  if(Number.isSafeInteger(pid)&&pid>0){
    try{process.kill(pid,0);}catch(error){
      if(error.code==='ESRCH'&&fs.readFileSync(file,'utf8')===contents){
        fs.renameSync(file,path.join(root,`interrupted-switch-${crypto.randomUUID()}.lock`));
        return fs.openSync(file,'wx');
      }
    }
  }
  throw Error(`Another switch may be running. Inspect ${file} before retrying.`);
}
function tableName(line) {
  const match=line.match(/^\s*\[([^\[].*?)\]\s*(?:#.*)?$/);
  if(!match)return null;
  const tokens=match[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+|\S/g)||[];
  const parts=[];
  for(let i=0;i<tokens.length;i++){
    if(i%2){if(tokens[i]!=='.')return null;}
    else parts.push(tokens[i][0]==='"'?JSON.parse(tokens[i]):tokens[i][0]==="'"?tokens[i].slice(1,-1):tokens[i]);
  }
  return tokens.length%2?JSON.stringify(parts):null;
}
function sectionRange(lines, section) {
  const start = section ? lines.findIndex(line => tableName(line) === JSON.stringify(section.split('.'))) + 1 : 0;
  if (section && !start) return null;
  let end = lines.findIndex((line, index) => index >= start && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  return [start, end];
}
function lineIndex(lines, section, key) {
  const range = sectionRange(lines, section);
  if (!range) return -1;
  return lines.findIndex((line, i) => {
    if(i<range[0]||i>=range[1])return false;
    const match=line.match(/^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/);
    if(!match)return false;
    const name=match[1][0]==='"'?JSON.parse(match[1]):match[1][0]==="'"?match[1].slice(1,-1):match[1];
    return name===key;
  });
}
function originalLine(text, section, key) {
  const lines = text.split(/\r?\n/), index = lineIndex(lines, section, key);
  return index < 0 ? null : lines[index];
}
function stringValue(text, section, key, fallback) {
  const line = originalLine(text, section, key);
  if (!line) return fallback;
  const match = line.match(/=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
  if (!match) throw Error(`Unsupported TOML value: ${section}.${key}`);
  return match[1].startsWith("'") ? match[1].slice(1,-1) : JSON.parse(match[1]);
}
function replaceLine(text, section, key, replacement) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/), index = lineIndex(lines, section, key);
  if (index >= 0) {
    if (replacement === null) lines.splice(index, 1); else lines[index] = replacement;
  } else if (replacement !== null) {
    const range = sectionRange(lines, section);
    if (range) lines.splice(range[1], 0, replacement);
    else lines.push(`[${section}]`, replacement, '');
  }
  return lines.join(newline);
}
function removeEmptyAddedTables(text,before,changes) {
  const newline=text.includes('\r\n')?'\r\n':'\n',lines=text.split(/\r?\n/);
  const tables=[...new Set(changes.map(change=>change.table).filter(Boolean))].sort((a,b)=>b.length-a.length);
  for(const table of tables){
    if(sectionRange(before.split(/\r?\n/),table))continue;
    const range=sectionRange(lines,table);
    if(range&&lines.slice(...range).every(line=>/^\s*(?:#.*)?$/.test(line)))lines.splice(range[0]-1,1);
  }
  return lines.join(newline);
}
function validate(config) {
  const url = new URL(config.endpoint);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || /\/responses\/?$/.test(url.pathname)) {
    throw Error('endpoint must be an HTTPS API base URL (local HTTP is allowed), without credentials, query, or /responses.');
  }
  if (url.hostname === 'api.example.com' || typeof config.api_key !== 'string' || !config.api_key.trim() || config.api_key === 'YOUR_API_KEY' ||
      typeof config.model !== 'string' || !config.model.trim() || config.model === 'YOUR_MODEL_ID') {
    throw Error('Fill endpoint, api_key and model in config.json first.');
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('port must be an integer from 1024 to 65535.');
  return {...config, endpoint: config.endpoint.replace(/\/+$/, '')};
}
function catalog(original, config) {
  const file = stringValue(original, '', 'model_catalog_json', path.join(home, 'models_cache.json'));
  const data = readJSON(path.resolve(home, file));
  if (!Array.isArray(data.models) || !data.models.length) throw Error('Open Codex once to populate its model cache, then retry.');
  const template = data.models.find(model => model.slug === 'gpt-6.1-sol') || data.models[0];
  const model = {...template, slug: alias, display_name: `${config.model} (Custom API)`,
    description: 'Model selected in config.json', visibility: 'list', supported_in_api: true,
    default_reasoning_level: 'high', supported_reasoning_levels: [{effort:'high', description:'High'}],
    context_window: 64000, max_context_window: 64000, input_modalities: ['text'],
    supports_image_detail_original: false, supports_search_tool: false};
  return {...data, models: [...data.models.filter(model => model.slug !== alias), model]};
}
async function health(state) {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {headers:{[header]:state.token}, signal:AbortSignal.timeout(1000)});
    const data = await response.json();
    return response.ok && data.service === 'codex-simple-model-switch' && data.instance === state.instance ? data : null;
  } catch { return null; }
}
function startupText() {
  const command = `"${process.execPath}" "${path.join(root,'switch.mjs')}" _serve`;
  return `Set s = CreateObject("WScript.Shell")\r\ns.Environment("PROCESS")("CODEX_HOME") = "${home.replaceAll('"','""')}"\r\ns.Run "${command.replaceAll('"','""')}", 0, False\r\n`;
}
async function start(state) {
  if (await health(state)) return;
  const child = spawn(process.execPath, [path.join(root,'switch.mjs'), '_serve'], {
    cwd:root, env:{...process.env,CODEX_HOME:home}, detached:true, windowsHide:true, stdio:'ignore'
  });
  child.unref();
  for (let i=0;i<30;i++) { await sleep(200); if (await health(state)) return; }
  throw Error('Router did not start. The port may be occupied; original configuration is preserved.');
}
async function stop(state) {
  if (!(await health(state))) return;
  await fetch(`http://127.0.0.1:${state.port}/shutdown`, {method:'POST', headers:{[header]:state.token}, signal:AbortSignal.timeout(2000)});
  for (let i=0;i<20;i++) { if (!(await health(state))) return; await sleep(100); }
  throw Error('Router did not stop; inspect the local process before enabling again.');
}
// Only provider metadata is journalled/restored. Conversation bodies are never rewritten as JSON.
function sessionFiles() {
  const files=[];
  function visit(dir){
    if(!fs.existsSync(dir))return;
    if(fs.lstatSync(dir).isSymbolicLink())throw Error(`Session directory is a link: ${dir}`);
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink())throw Error(`Session path is a link: ${file}`);
      if(entry.isDirectory())visit(file);
      else if(entry.isFile()&&entry.name.endsWith('.jsonl'))files.push(file);
    }
  }
  visit(path.join(home,'sessions'));visit(path.join(home,'archived_sessions'));
  return files;
}
function sessionMeta(file) {
  const fd=fs.openSync(file,'r'),chunks=[];let size=0;
  try{
    while(true){
      const chunk=Buffer.alloc(65536),n=fs.readSync(fd,chunk,0,chunk.length,null);
      if(!n)break;
      const end=chunk.subarray(0,n).indexOf(10),part=chunk.subarray(0,end<0?n:end+1);
      chunks.push(part);size+=part.length;
      if(size>16*1024*1024)throw Error(`Session metadata is too large: ${file}`);
      if(end>=0)break;
    }
  }finally{fs.closeSync(fd);}
  const line=Buffer.concat(chunks).toString('utf8');
  if(!line.trim())return null;
  const record=JSON.parse(line.replace(/^\uFEFF/,''));
  if(record.type!=='session_meta')return null;
  if(typeof record.payload?.id!=='string')throw Error(`Session metadata has no ID: ${file}`);
  return {file,line,record,id:record.payload.id,provider:record.payload.model_provider??'openai'};
}
function providerLine(meta,provider) {
  const record=JSON.parse(JSON.stringify(meta.record));
  if(provider===null)delete record.payload.model_provider;else record.payload.model_provider=provider;
  return (meta.line.startsWith('\uFEFF')?'\uFEFF':'')+JSON.stringify(record)+(meta.line.endsWith('\r\n')?'\r\n':meta.line.endsWith('\n')?'\n':'');
}
function rewriteMeta(file,before,after) {
  if(fs.lstatSync(file).isSymbolicLink())throw Error(`Session path is a link: ${file}`);
  const input=fs.openSync(file,'r'),temp=file+`.model-switch-${crypto.randomUUID()}.tmp`;let output;
  try{
    const stat=fs.fstatSync(input),prefix=Buffer.alloc(Buffer.byteLength(before));
    fs.readSync(input,prefix,0,prefix.length,0);
    if(prefix.toString('utf8')!==before)throw Error(`Session changed; close Codex and retry: ${file}`);
    output=fs.openSync(temp,'wx',stat.mode);
    fs.writeFileSync(output,after);
    const buffer=Buffer.alloc(1024*1024);let offset=prefix.length;
    while(offset<stat.size){const n=fs.readSync(input,buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!n)throw Error('Session truncated during migration');fs.writeSync(output,buffer,0,n);offset+=n;}
    fs.fsyncSync(output);
    const current=fs.fstatSync(input);
    if(current.size!==stat.size||current.mtimeMs!==stat.mtimeMs)throw Error(`Session changed; close Codex and retry: ${file}`);
  }finally{fs.closeSync(input);if(output!==undefined)fs.closeSync(output);}
  fs.renameSync(temp,file);
}
async function sqlite() {
  try{return (await import('node:sqlite')).DatabaseSync;}
  catch{throw Error('Conversation migration requires Node.js 22.13 or newer. Nothing was migrated.');}
}
function stateDatabases(directory) {
  return fs.existsSync(directory)?fs.readdirSync(directory).filter(name=>/^state_\d+\.sqlite$/.test(name)).map(name=>path.join(directory,name)):[];
}
async function planMigration(original) {
  const plan={from:'openai',to:'openai_http',files:[],databases:[],databaseOnlyIds:[]};
  const metas=sessionFiles().map(sessionMeta).filter(Boolean);
  for(const meta of metas)if(meta.provider===plan.from)plan.files.push({file:meta.file,id:meta.id,before:meta.line,after:providerLine(meta,plan.to)});
  const dbHome=path.resolve(home,stringValue(original,'','sqlite_home',home));
  plan.dbHome=dbHome;
  const paths=stateDatabases(dbHome);
  if(paths.length){
    const DatabaseSync=await sqlite(),knownFiles=new Set(metas.map(meta=>fs.realpathSync(meta.file)));
    for(const file of paths){
      if(fs.lstatSync(file).isSymbolicLink())throw Error(`State database is a link: ${file}`);
      const db=new DatabaseSync(file,{readOnly:true});
      try{
        const allRows=db.prepare('SELECT id, model_provider, rollout_path FROM threads').all();
        const rows=allRows.filter(row=>row.model_provider===plan.from);
        for(const row of rows)if(row.rollout_path&&fs.existsSync(row.rollout_path)&&!knownFiles.has(fs.realpathSync(row.rollout_path)))throw Error(`Unrecognized conversation log; nothing migrated: ${row.rollout_path}`);
        plan.databases.push({file,ids:rows.map(row=>row.id),existingIds:allRows.map(row=>row.id)});
      }finally{db.close();}
    }
  }
  const loggedIds=new Set(metas.map(meta=>meta.id));
  plan.databaseOnlyIds=[...new Set(plan.databases.flatMap(db=>db.ids).filter(id=>!loggedIds.has(id)))];
  return plan;
}
async function migrate(plan,reverse=false) {
  const from=reverse?plan.to:plan.from,to=reverse?plan.from:plan.to;
  const connections=[],operations=[],written=[];
  try{
    const migratedIds=[...new Set([...plan.files.map(meta=>meta.id),...plan.databases.flatMap(db=>db.ids)])];
    const databases=reverse?stateDatabases(plan.dbHome).map(file=>{
      const original=plan.databases.find(db=>db.file===file);
      return {file,ids:original?[...new Set([...original.ids,...migratedIds.filter(id=>!original.existingIds.includes(id))])]:migratedIds};
    }):plan.databases;
    // Lock databases and validate every affected record before the first metadata write.
    if(databases.length){
      const DatabaseSync=await sqlite();
      for(const entry of databases){
        if(!fs.existsSync(entry.file)||fs.lstatSync(entry.file).isSymbolicLink())throw Error(`State database missing or linked: ${entry.file}`);
        const db=new DatabaseSync(entry.file),connection={db,entry,begun:false,committed:false,changed:[]};connections.push(connection);
        db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
        connection.begun=true;
        const read=db.prepare('SELECT model_provider FROM threads WHERE id = ?');
        for(const id of entry.ids){
          const row=read.get(id);if(!row)continue; // Deleted conversations stay deleted.
          if(![from,to].includes(row.model_provider))throw Error(`Conversation provider changed: ${id}. Nothing migrated.`);
          if(row.model_provider===from)connection.changed.push(id);
        }
      }
    }
    const current=reverse?sessionFiles().map(sessionMeta).filter(Boolean):[];
    const entries=reverse?[...plan.files,...(plan.databaseOnlyIds||[]).map(id=>({id,before:null,after:null}))]:plan.files;
    for(const entry of entries){
      const candidates=reverse?current.filter(meta=>meta.id===entry.id):[sessionMeta(entry.file)];
      for(const meta of candidates){
        if(!meta||meta.id!==entry.id)throw Error(`Conversation identity changed: ${entry.file}`);
        if(![from,to].includes(meta.provider))throw Error(`Conversation provider changed: ${meta.id}. Nothing migrated.`);
        if(meta.provider===to)continue;
        const expected=reverse?entry.after:entry.before;
        let next=reverse?entry.before:entry.after;
        if(meta.line!==expected){
          if(!reverse)throw Error(`Session changed; close Codex and retry: ${meta.file}`);
          const before=entry.before?JSON.parse(entry.before.replace(/^\uFEFF/,'')):null;
          next=providerLine(meta,before?before.payload.model_provider??null:plan.from);
        }
        if(!operations.some(op=>op.file===meta.file))operations.push({file:meta.file,before:meta.line,after:next});
      }
    }
    for(const op of operations){rewriteMeta(op.file,op.before,op.after);written.push(op);}
    for(const {db,changed} of connections){const update=db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?');for(const id of changed)update.run(to,id,from);}
    for(const connection of connections){connection.db.exec('COMMIT');connection.committed=true;}
  }catch(error){
    const failures=[];
    for(const connection of connections){
      try{
        if(connection.committed){
          connection.db.exec('BEGIN IMMEDIATE');
          const update=connection.db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?');
          for(const id of connection.changed)update.run(from,id,to);
          connection.db.exec('COMMIT');
        }else if(connection.begun)connection.db.exec('ROLLBACK');
      }catch(e){failures.push(e.message);}
    }
    for(const op of written.reverse())try{rewriteMeta(op.file,op.after,op.before);}catch(e){failures.push(e.message);}
    if(failures.length){const failure=Error(`${error.message}. Recovery incomplete; keep the migration journal and run off after resolving: ${failures.join('; ')}`);failure.recoveryIncomplete=true;throw failure;}
    throw error;
  }finally{for(const {db} of connections)db.close();}
}
async function on() {
  if (fs.existsSync(stateFile) && readJSON(stateFile).enabled) {
    const state=readJSON(stateFile);
    if(state.phase&&state.phase!=='enabled')throw Error('A switch was interrupted. Close Codex and run off to recover first.');
    await start(state);
    console.log('Already enabled. Use off before changing config.json.'); return;
  }
  const local=path.join(path.dirname(script),'config.json');
  if (!fs.existsSync(local)) {
    fs.copyFileSync(path.join(path.dirname(script),'config.example.json'),local);
    throw Error('Created config.json. Fill endpoint, api_key and model, then run on again.');
  }
  const config=validate(readJSON(local));
  const original=fs.readFileSync(target,'utf8');
  const previousProvider=stringValue(original,'','model_provider','openai');
  if (!['openai','openai_http'].includes(previousProvider)) throw Error('Only an existing official OpenAI provider is supported. Restore that configuration first.');
  const provider='openai_http';
  const section=`model_providers.${provider}`;
  if (originalLine(original,section,'http_headers')) throw Error('Inline http_headers is unsupported; use a TOML table before enabling.');
  if (startup && fs.existsSync(startup)) throw Error('A startup entry with this name already exists; nothing was replaced.');
  const official=previousProvider==='openai'?stringValue(original,'','openai_base_url','https://chatgpt.com/backend-api/codex'):stringValue(original,section,'base_url','https://chatgpt.com/backend-api/codex');
  if (new URL(official).hostname === '127.0.0.1' && Number(new URL(official).port) === config.port) throw Error('The new port conflicts with the existing provider.');
  const merged=catalog(original,config);
  const migration=previousProvider==='openai'?await planMigration(original):null;
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const token=crypto.randomBytes(32).toString('hex');
  const changes=[['','model',quote(alias)],['','model_provider',quote(provider)],
    ['','model_catalog_json',quote(path.join(root,'models.json').replaceAll('\\','/'))],
    ['','model_reasoning_effort',quote('high')],['','model_context_window','64000'],
    [section,'name',quote('OpenAI HTTP')],[section,'base_url',quote(`http://127.0.0.1:${config.port}`)],[section,'wire_api',quote('responses')],
    [section,'requires_openai_auth','true'],[section,'supports_websockets','false'],
    [`${section}.http_headers`,header,quote(token)]].map(([table,key,value])=>({table,key,before:originalLine(original,table,key),after:`${key} = ${value}`}));
  let applied=original; for(const change of changes) applied=replaceLine(applied,change.table,change.key,change.after);
  const state={enabled:true,phase:'enabling',instance:crypto.randomUUID(),token,port:config.port,official,
    originalHash:hash(original),appliedHash:hash(applied),changes};
  if(migration){state.migrationFile=path.join(root,`migration-${state.instance}.json`);write(state.migrationFile,JSON.stringify(migration,null,2));}
  write(path.join(root,'config.before.toml'),original);
  write(path.join(root,'api-config.json'),JSON.stringify(config,null,2));
  write(path.join(root,'models.json'),JSON.stringify(merged));
  if (script !== path.join(root,'switch.mjs')) fs.copyFileSync(script,path.join(root,'switch.mjs'));
  save(state);
  let migrated=false;
  try {
    await start(state);
    if (hash(fs.readFileSync(target,'utf8'))!==state.originalHash) throw Error('Codex config changed during setup; retry after closing Codex.');
    if(migration){await migrate(migration);migrated=true;}
    if (hash(fs.readFileSync(target,'utf8'))!==state.originalHash) throw Error('Codex config changed during migration; close Codex and retry.');
    if (startup) {fs.mkdirSync(path.dirname(startup),{recursive:true});fs.writeFileSync(startup,startupText(),{flag:'wx'});}
    write(target,applied);
    state.phase='enabled';save(state);
  } catch(error) {
    if(error.recoveryIncomplete)throw error;
    if(migrated)await migrate(migration,true);
    if(hash(fs.readFileSync(target,'utf8'))===state.appliedHash)write(target,original);
    if(startup && fs.existsSync(startup) && fs.readFileSync(startup,'utf8')===startupText()) fs.renameSync(startup,path.join(root,`startup-failed-${Date.now()}.vbs`));
    state.enabled=false;state.phase='disabled';save(state);await stop(state);throw error;
  }
  if(migration)console.log(`Migrated openai -> openai_http: ${migration.databases.reduce((n,db)=>n+db.ids.length,0)} database records, ${migration.files.length} session logs. Recovery journal: ${state.migrationFile}`);
  console.log(`Enabled: ${config.model}. Restart Codex to load the configuration.`);
}
async function off() {
  if(!fs.existsSync(stateFile)||!readJSON(stateFile).enabled){console.log('Already disabled.');return;}
  const state=readJSON(stateFile),before=fs.readFileSync(path.join(root,'config.before.toml'),'utf8');
  if(hash(before)!==state.originalHash)throw Error('Backup hash mismatch; nothing changed.');
  const current=fs.readFileSync(target,'utf8');let restored=before;
  if(hash(current)!==state.appliedHash){
    restored=current;
    for(const change of state.changes){
      const actual=originalLine(current,change.table,change.key);
      if(actual!==change.after && actual!==change.before)throw Error(`Managed setting changed: ${change.table}.${change.key}. Backup is in ${root}; nothing changed.`);
      restored=replaceLine(restored,change.table,change.key,change.before);
    }
    restored=removeEmptyAddedTables(restored,before,state.changes);
  }
  if(startup && fs.existsSync(startup) && fs.readFileSync(startup,'utf8')!==startupText())throw Error('Startup entry changed; nothing was replaced.');
  state.phase='disabling';save(state);
  if(state.migrationFile)await migrate(readJSON(state.migrationFile),true);
  write(target,restored);
  if(startup && fs.existsSync(startup))fs.renameSync(startup,path.join(root,`startup-disabled-${Date.now()}.vbs`));
  await stop(state);
  state.enabled=false;state.phase='disabled';save(state);
  console.log('Restored the previous configuration. Restart Codex to load it.');
}
async function serve() {
  const state=readJSON(stateFile);if(!state.enabled)return;
  const config=validate(readJSON(path.join(root,'api-config.json')));
  const server=http.createServer(async(req,res)=>{
    const deny=(status,message)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message}}));};
    const supplied=Buffer.from(String(req.headers[header]||'')),expected=Buffer.from(state.token);
    if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return deny(401,'Router authentication required');
    if(req.method==='GET'&&req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'codex-simple-model-switch',instance:state.instance,pid:process.pid}));return;}
    if(req.method==='POST'&&req.url==='/shutdown'){res.end('ok');server.close();setTimeout(()=>process.exit(0),100).unref();return;}
    if(req.method!=='POST'||!['/responses','/responses/compact'].includes(req.url))return deny(404,'Not found');
    const abort=new AbortController();res.on('close',()=>{if(!res.writableFinished)abort.abort();});
    try{
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>64*1024*1024)throw Error('Body too large');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));const custom=body.model===alias;
      if(!custom && !(typeof body.model==='string' && /^(gpt-|codex-auto-review$)/.test(body.model)))return deny(400,'Unknown model');
      let headers;
      if(custom){
        body.model=config.model;for(const key of ['service_tier','client_metadata','prompt_cache_key'])delete body[key];
        headers={'content-type':'application/json',authorization:`Bearer ${config.api_key}`};
      }else{
        const skip=new Set([header,'host','connection','content-length','transfer-encoding','accept-encoding','upgrade','proxy-authorization']);
        headers=Object.fromEntries(Object.entries(req.headers).filter(([key])=>!skip.has(key)));
      }
      const upstream=await fetch((custom?config.endpoint:state.official.replace(/\/+$/,''))+req.url,{
        method:'POST',headers,body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(900000)])});
      if(upstream.status>=300&&upstream.status<400)throw Error('Redirect rejected');
      res.statusCode=upstream.status;
      for(const [key,value]of upstream.headers)if(!['content-length','content-encoding','transfer-encoding','connection','set-cookie'].includes(key))res.setHeader(key,value);
      if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),res);else res.end();
    }catch{if(!res.headersSent)deny(502,'Model router request failed');else res.destroy();}
  });
  server.on('error',()=>process.exit(1));server.listen(config.port,'127.0.0.1');
}
async function main(){
  const command=process.argv[2];
  if(command==='_serve')return serve();
  if(!['on','off','status'].includes(command))throw Error('Usage: node switch.mjs on|off|status');
  if(command==='status'){
    const state=fs.existsSync(stateFile)?readJSON(stateFile):null;
    console.log(JSON.stringify({enabled:!!state?.enabled,routerRunning:!!(state?.enabled&&await health(state))},null,2));return;
  }
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const lock=path.join(root,'switch.lock');let fd;
  fd=acquireLock(lock);
  try{fs.writeSync(fd,String(process.pid));await(command==='on'?on():off());}
  finally{fs.closeSync(fd);fs.renameSync(lock,path.join(root,'last-switch.lock'));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
