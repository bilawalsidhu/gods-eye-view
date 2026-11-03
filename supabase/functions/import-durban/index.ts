import { createClient } from 'npm:@supabase/supabase-js@2.99.1';
import { fetchFacilities } from './normalize.mjs';
Deno.serve(async (req: Request) => {
 const origin=req.headers.get('Origin')??'';
 const allowed=(Deno.env.get('ALLOWED_ORIGINS')??'http://localhost:4173').split(',');
 const headers={'Content-Type':'application/json','Vary':'Origin',...(allowed.includes(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'}:{})};
 const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(origin&&!allowed.includes(origin))return reply({error:'Origin not allowed'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({error:'POST required'},405);
 const token=req.headers.get('Authorization');if(!token?.startsWith('Bearer '))return reply({error:'Sign in required'},401);
 const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:token}},auth:{persistSession:false}});
 const {data:{user},error:authError}=await client.auth.getUser(token.slice(7));
 if(authError||!user)return reply({error:'Invalid session'},401);
 const {data:admin,error:roleError}=await client.rpc('is_mzansi_admin');
 if(roleError||!admin)return reply({error:'Administrator required'},403);
 const {data:run,error:startError}=await client.rpc('start_import');
 if(startError)return reply({error:startError.message},429);
 try {
  const rows=await fetchFacilities();
  const {data:count,error}=await client.rpc('finish_import',{p_run:run,p_rows:rows});
  if(error)throw error;
  return reply({run_id:run,imported:count,published:false});
 } catch(e) {
  await client.rpc('finish_import',{p_run:run,p_error:String(e).slice(0,1000)});
  return reply({error:'Import failed. See the protected import log.'},502);
 }
});
