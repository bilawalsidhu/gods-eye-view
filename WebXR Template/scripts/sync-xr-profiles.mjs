import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
const source='node_modules/@webxr-input-profiles/assets/dist/profiles',out='public/webxr-profiles';
// Quest 3 reports Meta Touch Plus. Keep its older Oculus aliases as a compatibility fallback,
// because browser versions have used each of these profile IDs for the same controller family.
const keep=['generic-hand','meta-quest-touch-plus','meta-quest-touch-plus-v2','oculus-touch-v3','oculus-touch-v2','oculus-touch','generic-trigger','generic-trigger-squeeze-thumbstick'];
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
for(const id of keep)await cp(source+'/'+id,out+'/'+id,{recursive:true});
const profiles=JSON.parse(await readFile(source+'/profilesList.json','utf8'));
await writeFile(out+'/profilesList.json',JSON.stringify(Object.fromEntries(keep.filter(id=>profiles[id]).map(id=>[id,profiles[id]])),null,2));
console.log('Synced '+keep.length+' offline WebXR controller profiles.');
