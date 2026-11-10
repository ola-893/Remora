// Demo helper: preserve the current session in memory, close it, prove denial.
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const {values}=parseArgs({options:{project:{type:'string'},agent:{type:'string',default:'follower'},'cli-root':{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('node scripts/demo-close-proof.mjs --project PATH --agent follower --cli-root INSTALLED_CLI_PATH');process.exit(0);}
if(!values.project||!values['cli-root'])throw new Error('--project and --cli-root are required.');
const moduleAt=name=>import(pathToFileURL(join(resolve(values['cli-root']),'src',name+'.mjs')).href);
const {selectedAgent,readAgentState}=await moduleAt('agents');
const {gatewayFor}=await moduleAt('config');
const {stopCopy}=await moduleAt('copy-runtime');
const {outlayerFeedResponse}=await moduleAt('outlayer');
const agent=await selectedAgent(resolve(values.project),values.agent);
if(!agent)throw new Error('Select the follower agent first.');
const state=await readAgentState(agent),follow=state.follow;
if(follow?.status!=='active'||follow.listing.delivery!=='outlayer')throw new Error('An active OutLayer copy subscription is required. Stop the follower runner with close-on-exit false first.');
const client=await gatewayFor(agent.path);
try{
 const headers=await client.sessionHeaders();
 if(!headers['x-agentpay-session'])throw new Error('The active session credential is unavailable.');
 const before=await outlayerFeedResponse(follow.listing.id,'/copy/actions?after='+follow.cursor,headers);
 const closed=await stopCopy(agent,'stopped','DEMO_COMPLETE');
 const after=await outlayerFeedResponse(follow.listing.id,'/copy/actions?after='+follow.cursor,headers);
 console.log(JSON.stringify({beforeCloseHTTP:before.status,streamStatus:closed.status,closeTransaction:closed.closeHash,afterCloseHTTP:after.status,sameSessionCredential:true},null,2));
 if(before.status!==200||after.status!==403||!closed.closeHash)process.exitCode=1;
}finally{await client.dispose();}
