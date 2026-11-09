import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StdioMcpClient } from '../../scripts/stdio-client.js';
const ROOT='/Users/nicolaskheirallah/Documents/GitHub/polestar-mcp';
const c=StdioMcpClient.spawn(['--import','tsx','src/server.ts'],{cwd:ROOT,env:{...process.env,POLESTAR_FIXTURES_DIR:path.join(ROOT,'test/fixtures/dump'),POLESTAR_HISTORY_DIR:mkdtempSync(path.join(tmpdir(),'probe-'))}});
try{
 await c.request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'p',version:'0'}});
 c.notifyInitialized();
 const t=(await c.request('tools/list',{})).result?.tools as any[];
 const callable=t.filter(x=>(x.inputSchema?.required??[]).length===0).map(x=>x.name);
 let withData=0; const rows:string[]=[];
 for(const n of callable){const r=await c.callTool(n);const keys=Object.keys(r.structuredContent??{});const d=r.structuredContent?.data;
  if(d!==undefined)withData++;
  rows.push(`${n} data=${d!==undefined} keys=${keys.join(',')}`);}
 console.log(`callable=${callable.length} withData=${withData}`);console.log(rows.join('\n'));
}finally{c.stop();}
