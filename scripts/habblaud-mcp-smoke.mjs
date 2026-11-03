import {createLocalMcpServer} from '../server/mcp/server.js';
const server=createLocalMcpServer({apiBase:'http://127.0.0.1:4173'});
const init=await server.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'geo-smoke',version:'0.1'}}});
console.log('initialize:',JSON.stringify(init).slice(0,350));
const list=await server.handle({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
console.log('tools:',list.result?.tools?.length,'earthquakes:',list.result?.tools?.some(t=>t.name==='get_earthquakes'));
const query=await server.handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_earthquakes',arguments:{min_magnitude:5,limit:3}}});
console.log('query:',JSON.stringify(query).slice(0,2500));
if(init.error||!list.result?.tools?.some(t=>t.name==='get_earthquakes')||query.error||query.result?.isError)process.exitCode=1;
