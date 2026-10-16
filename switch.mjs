#!/usr/bin/env node
// Node.js 22+. No dependencies. Public commands: on, off, status.
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
function sectionRange(lines, section) {
  const start = section ? lines.findIndex(line => line.trim() === `[${section}]`) + 1 : 0;
  if (section && !start) return null;
  let end = lines.findIndex((line, index) => index >= start && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  return [start, end];
}
function lineIndex(lines, section, key) {
  const range = sectionRange(lines, section);
  if (!range) return -1;
  return lines.findIndex((line, i) => i >= range[0] && i < range[1] &&
    new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(line));
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
async function on() {
  if (fs.existsSync(stateFile) && readJSON(stateFile).enabled) {
    const state=readJSON(stateFile); await start(state);
    console.log('Already enabled. Use off before changing config.json.'); return;
  }
  const local=path.join(path.dirname(script),'config.json');
  if (!fs.existsSync(local)) {
    fs.copyFileSync(path.join(path.dirname(script),'config.example.json'),local);
    throw Error('Created config.json. Fill endpoint, api_key and model, then run on again.');
  }
  const config=validate(readJSON(local));
  const original=fs.readFileSync(target,'utf8');
  const provider=stringValue(original,'','model_provider','openai');
  if (!['openai','openai_http'].includes(provider)) throw Error('Only an existing official OpenAI provider is supported. Restore that configuration first.');
  const section=`model_providers.${provider}`;
  if (originalLine(original,section,'http_headers')) throw Error('Inline http_headers is unsupported; use a TOML table before enabling.');
  if (startup && fs.existsSync(startup)) throw Error('A startup entry with this name already exists; nothing was replaced.');
  const official=stringValue(original,section,'base_url','https://chatgpt.com/backend-api/codex');
  if (new URL(official).hostname === '127.0.0.1' && Number(new URL(official).port) === config.port) throw Error('The new port conflicts with the existing provider.');
  const merged=catalog(original,config);
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const token=crypto.randomBytes(32).toString('hex');
  const changes=[['','model',quote(alias)],['','model_provider',quote(provider)],
    ['','model_catalog_json',quote(path.join(root,'models.json').replaceAll('\\','/'))],
    ['','model_reasoning_effort',quote('high')],['','model_context_window','64000'],
    [section,'base_url',quote(`http://127.0.0.1:${config.port}`)],[section,'wire_api',quote('responses')],
    [section,'requires_openai_auth','true'],[section,'supports_websockets','false'],
    [`${section}.http_headers`,header,quote(token)]].map(([table,key,value])=>({table,key,before:originalLine(original,table,key),after:`${key} = ${value}`}));
  let applied=original; for(const change of changes) applied=replaceLine(applied,change.table,change.key,change.after);
  const state={enabled:true,instance:crypto.randomUUID(),token,port:config.port,official,
    originalHash:hash(original),appliedHash:hash(applied),changes};
  write(path.join(root,'config.before.toml'),original);
  write(path.join(root,'api-config.json'),JSON.stringify(config,null,2));
  write(path.join(root,'models.json'),JSON.stringify(merged));
  if (script !== path.join(root,'switch.mjs')) fs.copyFileSync(script,path.join(root,'switch.mjs'));
  save(state);
  try {
    await start(state);
    if (hash(fs.readFileSync(target,'utf8'))!==state.originalHash) throw Error('Codex config changed during setup; retry after closing Codex.');
    if (startup) {fs.mkdirSync(path.dirname(startup),{recursive:true});fs.writeFileSync(startup,startupText(),{flag:'wx'});}
    write(target,applied);
  } catch(error) {
    if(startup && fs.existsSync(startup) && fs.readFileSync(startup,'utf8')===startupText()) fs.renameSync(startup,path.join(root,`startup-failed-${Date.now()}.vbs`));
    state.enabled=false;save(state);await stop(state);throw error;
  }
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
  }
  if(startup && fs.existsSync(startup) && fs.readFileSync(startup,'utf8')!==startupText())throw Error('Startup entry changed; nothing was replaced.');
  write(target,restored);
  state.enabled=false;save(state);
  if(startup && fs.existsSync(startup))fs.renameSync(startup,path.join(root,`startup-disabled-${Date.now()}.vbs`));
  await stop(state);
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
  try{fd=fs.openSync(lock,'wx');}catch{throw Error(`Another switch is running. If it was interrupted, inspect ${lock}.`);}
  try{fs.writeSync(fd,String(process.pid));await(command==='on'?on():off());}
  finally{fs.closeSync(fd);fs.renameSync(lock,path.join(root,'last-switch.lock'));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
