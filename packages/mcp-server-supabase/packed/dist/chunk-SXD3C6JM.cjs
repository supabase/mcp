"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; } async function _asyncOptionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = await fn(value); } else if (op === 'call' || op === 'optionalCall') { value = await fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }var g={name:"@supabase/mcp-server-supabase",mcpName:"com.supabase/mcp",version:"0.17.0",description:"MCP server for interacting with Supabase",license:"Apache-2.0",repository:{type:"git",url:"https://github.com/supabase/mcp.git"},type:"module",main:"dist/index.cjs",types:"dist/index.d.ts",sideEffects:!1,scripts:{build:"tsup --clean",dev:"tsup --watch",typecheck:"tsc --noEmit",prebuild:"pnpm typecheck",prepublishOnly:"pnpm build","registry:update":"tsx scripts/registry/update-version.ts && biome format --write server.json","registry:login":"scripts/registry/login.sh","registry:publish":"mcp-publisher publish",test:"vitest","test:unit":"vitest --project unit","test:e2e":"vitest --project e2e","test:integration":"vitest --project integration","test:coverage":"vitest --coverage","generate:management-api-types":"node scripts/generate-management-api-types.mjs"},files:["dist/**/*"],bin:{"mcp-server-supabase":"./dist/cli.js"},exports:{".":{types:"./dist/index.d.ts",import:"./dist/index.js",default:"./dist/index.cjs"},"./platform":{types:"./dist/platform/index.d.ts",import:"./dist/platform/index.js",default:"./dist/platform/index.cjs"},"./platform/api":{types:"./dist/platform/api-platform.d.ts",import:"./dist/platform/api-platform.js",default:"./dist/platform/api-platform.cjs"}},dependencies:{"@mjackson/multipart-parser":"^0.10.1","@modelcontextprotocol/node":"catalog:","@supabase/mcp-utils":"workspace:^","common-tags":"^1.8.2",gqlmin:"^0.3.1",graphql:"^16.11.0","openapi-fetch":"^0.13.5"},peerDependencies:{"@modelcontextprotocol/server":"catalog:",zod:"catalog:"},devDependencies:{"@ai-sdk/anthropic":"catalog:","@ai-sdk/mcp":"catalog:","@electric-sql/pglite":"^0.2.17","@modelcontextprotocol/client":"catalog:","@modelcontextprotocol/server":"catalog:","@total-typescript/tsconfig":"^1.0.4","@types/common-tags":"^1.8.4","@types/node":"^22.8.6","@vitest/coverage-v8":"^2.1.9",ai:"catalog:","date-fns":"^4.1.0",dotenv:"^16.5.0",msw:"^2.7.3",nanoid:"^5.1.5","openapi-typescript":"^7.5.0","openapi-typescript-helpers":"^0.0.15",prettier:"^3.3.3",tsup:"^8.3.5",tsx:"^4.19.2",typescript:"^5.6.3",vite:"^5.4.19",vitest:"^2.1.9",zod:"catalog:"}};var _commontags = require('common-tags');var _posix = require('path/posix');var _url = require('url');function D(e,t,s){return`${e}_${t}_${s}`}function x(e){return`/tmp/user_fn_${e}/`}function f(e,t){return e.startsWith(t)?e.slice(t.length):e}function I(e){try{return _url.fileURLToPath.call(void 0, e,{windows:!1})}catch (e2){return e}}function N({deploymentId:e,filename:t}){let s=x(e),a=_posix.resolve.call(void 0, s,t);return a=f(a,s),a=f(a,"source/"),a}var q=_commontags.codeBlock`
  import "jsr:@supabase/functions-js/edge-runtime.d.ts";

  Deno.serve(async (req: Request) => {
    const data = {
      message: "Hello there!"
    };
    
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
      }
    });
  });
`;var _mcputils = require('@supabase/mcp-utils');function P(e,t=100){switch(e){case"api":return _commontags.stripIndent`
        select id, log_attributes['identifier'] as identifier, timestamp, event_message, log_attributes['request.method'] as method, log_attributes['request.path'] as path, log_attributes['response.status_code'] as status_code
        from logs
        where source = 'edge_logs'
        order by timestamp desc
        limit ${t}
      `;case"branch-action":return _commontags.stripIndent`
        select log_attributes['workflow_run'] as workflow_run, timestamp, id, event_message
        from logs
        where source = 'workflow_run_logs'
        order by timestamp desc
        limit ${t}
      `;case"postgres":return _commontags.stripIndent`
        select log_attributes['identifier'] as identifier, timestamp, id, event_message, log_attributes['parsed.error_severity'] as error_severity
        from logs
        where source = 'postgres_logs'
        order by timestamp desc
        limit ${t}
      `;case"edge-function":return _commontags.stripIndent`
        select id, timestamp, event_message, log_attributes['response.status_code'] as status_code, log_attributes['request.method'] as method, log_attributes['function_id'] as function_id, log_attributes['execution_time_ms'] as execution_time_ms, log_attributes['deployment_id'] as deployment_id, log_attributes['version'] as version
        from logs
        where source = 'function_edge_logs'
        order by timestamp desc
        limit ${t}
      `;case"edge-function-runtime":return _commontags.stripIndent`
        select id, timestamp, event_message, severity_text, log_attributes['level'] as level, log_attributes['event_type'] as event_type, log_attributes['function_id'] as function_id, log_attributes['execution_id'] as execution_id, log_attributes['deployment_id'] as deployment_id, log_attributes['version'] as version
        from logs
        where source = 'function_logs'
        order by timestamp desc
        limit ${t}
      `;case"auth":return _commontags.stripIndent`
        select id, timestamp, event_message, log_attributes['level'] as level, log_attributes['status'] as status, log_attributes['path'] as path, log_attributes['msg'] as msg, log_attributes['error'] as error
        from logs
        where source = 'auth_logs'
        order by timestamp desc
        limit ${t}
      `;case"storage":return _commontags.stripIndent`
        select id, timestamp, event_message
        from logs
        where source = 'storage_logs'
        order by timestamp desc
        limit ${t}
      `;case"realtime":return _commontags.stripIndent`
        select id, timestamp, event_message
        from logs
        where source = 'realtime_logs'
        order by timestamp desc
        limit ${t}
      `;default:throw new Error(`unsupported log service type: ${e}`)}}var _=1440*60*1e3;function R(e,t){let s=t?Date.parse(t):Date.now();if(Number.isNaN(s))throw new (0, _mcputils.ToolCallerError)(`Invalid iso_timestamp_end: "${t}". Expected an ISO 8601 timestamp.`);let i=e?Date.parse(e):s-_;if(Number.isNaN(i))throw new (0, _mcputils.ToolCallerError)(`Invalid iso_timestamp_start: "${e}". Expected an ISO 8601 timestamp.`);if(i>=s)throw new (0, _mcputils.ToolCallerError)("iso_timestamp_start must be before iso_timestamp_end.");if(s-i>_)throw new (0, _mcputils.ToolCallerError)("The log window can be at most 24 hours.");return{iso_timestamp_start:new Date(i).toISOString(),iso_timestamp_end:new Date(s).toISOString()}}var k={production:{url:"https://xguihxuzqibwxjnimxev.supabase.co",key:"sb_publishable__4DBgvrDe7ec234wnvCAog_LPzBtkQe"},staging:{url:"https://actixlblmrqglneypada.supabase.co",key:"sb_publishable_wLdx7w89KWFq-39s4emmnA__9XR9r-_"}},j=1e4;function M({environment:e="production",fetch:t=globalThis.fetch,getUserId:s}={}){let{url:i,key:a}=k[e];async function m(){try{return await _optionalChain([s, 'optionalCall', _2 => _2()])}catch (e3){return}}async function u(c,n,r){let p=await t(`${i}/rest/v1/${c}`,{...n,headers:{apikey:a,"Content-Type":"application/json",...n.headers},signal:AbortSignal.timeout(j)});if(!p.ok)throw new Error(`Failed to ${r}: ${p.status} ${await p.text()}`);return p}return{async submit({feedback:c,projectId:n,clientInfo:r}){let p=await m(),d=await(await u("rpc/submit_interfaces_feedback",{method:"POST",body:JSON.stringify({feedback:c,user_agent:`supabase-mcp/${g.version}`,user_id:p,project_ref:n,metadata:{source:"mcp",...r&&{client_name:r.name,client_version:r.version}}})},"submit feedback")).json();if(typeof d!="string"||d.length===0)throw new Error("Failed to submit feedback: no delete token returned");return{deleteToken:d}},async delete({deleteToken:c,projectId:n}){let r=await m();return{deleted:await _asyncOptionalChain([(await u(`interfaces_feedback?delete_token=eq.${encodeURIComponent(c)}`,{method:"DELETE",headers:{Prefer:"count=exact","x-feedback-token":c,...n&&{"x-feedback-project-ref":n},...r&&{"x-feedback-user-id":r}}},"delete feedback")), 'access', async _3 => _3.headers, 'access', async _4 => _4.get, 'call', async _5 => _5("Content-Range"), 'optionalAccess', async _6 => _6.split, 'call', async _7 => _7("/"), 'access', async _8 => _8[1]])==="1"}}}}exports.a = g; exports.b = D; exports.c = I; exports.d = N; exports.e = q; exports.f = P; exports.g = R; exports.h = M;
//# sourceMappingURL=chunk-SXD3C6JM.cjs.map