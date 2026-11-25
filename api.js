/* =====================================================================
   데이터 연결부 (api.js)
   화면 코드는 그대로 두고, 저장소와 이야기하는 부분만 이 파일이 맡음.
   지금: 구글 앱스 스크립트(config.js 의 EQ_API_URL)
   나중: NAS 서버 — 같은 API(sync / write / upload / file)를 NAS가 제공하면
         config.js 의 주소만 바꾸면 됨.
   ===================================================================== */
(function(){
  const API = /^https?:\/\/|^\//.test((window.EQ_API_URL||"").trim()) ? window.EQ_API_URL.trim() : "";
  const POLL_MS = 10000;
  const LS = {
    get(k,d){try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v);}catch(e){return d;}},
    set(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
  };

  // ---------- 로컬 사본 (오프라인에서도 마지막 자료로 화면이 뜨게) ----------
  const CACHE_KEY="eqCache_v1";
  const cache = LS.get(CACHE_KEY,{seq:0,docs:{},files:{}});
  const saveCache=()=>{clearTimeout(saveCache.t);saveCache.t=setTimeout(()=>LS.set(CACHE_KEY,cache),300);};
  const coll = c => (cache.docs[c]||(cache.docs[c]={}));
  const subs = [];           // {coll, q, cb}
  const fileMap = () => cache.files;

  async function getJSON(params){
    const u = API + (API.includes("?")?"&":"?") + new URLSearchParams(params).toString();
    const r = await fetch(u,{method:"GET",redirect:"follow"});
    if(!r.ok) throw Object.assign(new Error("서버 응답 "+r.status),{code:"network"});
    return r.json();
  }
  async function post(body){
    // text/plain 으로 보내야 브라우저 사전확인(preflight)이 생기지 않음 (앱스 스크립트 제약)
    const r = await fetch(API,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify(body),redirect:"follow"});
    if(!r.ok) throw Object.assign(new Error("서버 응답 "+r.status),{code:"network"});
    const j = await r.json();
    if(!j.ok) throw Object.assign(new Error(j.error||"저장하지 못했습니다"),{code:j.code||"error"});
    return j;
  }

  // ---------- 바뀐 자료 받아오기 ----------
  let syncing=false, lastOk=0;
  let firstSync=null;  // 처음 열 때 한 번 다 받은 뒤에 화면을 그림
  async function sync(){
    if(!API||syncing) return;
    syncing=true;
    try{
      const j = await getJSON({action:"sync",since:cache.seq});
      if(!j.ok) throw new Error(j.error||"sync");
      // 서버 번호가 내 기기보다 작으면(시트를 새로 만들었거나 초기화한 경우) 내 기기 자료를 비우고 처음부터 다시 받음
      if((j.seq||0) < cache.seq){ cache.seq=0; cache.docs={}; cache.files={}; saveCache(); syncing=false; return sync(); }
      const changed = new Set();
      for(const [c,docs] of Object.entries(j.docs||{})){Object.assign(coll(c),docs);changed.add(c);}
      for(const [c,ids] of Object.entries(j.gone||{})){for(const id of ids)delete coll(c)[id];changed.add(c);}
      for(const [id,f] of Object.entries(j.files||{})){if(f)cache.files[id]=f;else delete cache.files[id];changed.add("__files");}
      cache.seq = Math.max(cache.seq, j.seq||0);
      lastOk = Date.now(); setNet(true);
      if(changed.size){saveCache();notify(changed);}
    }catch(e){ setNet(false); }
    finally{ syncing=false; }
  }
  function setNet(ok){ document.documentElement.toggleAttribute("data-offline",!ok); }
  function notify(changed){ for(const s of subs) if(!changed||changed.has(s.coll)||changed.has("__files")) s.fire(); }

  // ---------- 쿼리 (where / orderBy / limit 는 내 기기에서 처리) ----------
  const OPS={"==":(a,b)=>a===b,"!=":(a,b)=>a!==b,"<":(a,b)=>a<b,"<=":(a,b)=>a<=b,">":(a,b)=>a>b,">=":(a,b)=>a>=b};
  function run(c,q){
    let arr = Object.entries(coll(c)).map(([id,d])=>({id,d}));
    for(const [f,op,v] of q.where) arr = arr.filter(x=>OPS[op](x.d[f],v));
    if(q.order){const [f,dir]=q.order;arr.sort((a,b)=>((a.d[f]??0)<(b.d[f]??0)?-1:(a.d[f]??0)>(b.d[f]??0)?1:0)*(dir==="desc"?-1:1));}
    if(q.limit) arr = arr.slice(0,q.limit);
    return {docs:arr.map(x=>({id:x.id,exists:true,data:()=>JSON.parse(JSON.stringify(x.d))})),size:arr.length,empty:!arr.length};
  }
  function query(c,q={where:[],order:null,limit:0}){
    const api = {
      where:(f,op,v)=>query(c,{...q,where:[...q.where,[f,op,v]]}),
      orderBy:(f,dir="asc")=>query(c,{...q,order:[f,dir]}),
      limit:n=>query(c,{...q,limit:n}),
      get:async()=>{await sync();return run(c,q);},
      onSnapshot:(cb,err)=>{const s={coll:c,fire:()=>{try{cb(run(c,q));}catch(e){console.error(e);}}};subs.push(s);(cache.seq||!API?Promise.resolve():firstSync).then(()=>setTimeout(s.fire,0));return()=>{const i=subs.indexOf(s);if(i>=0)subs.splice(i,1);};},
    };
    return api;
  }
  // 저장: 화면을 먼저 바꾸고(낙관적 반영) 서버에 보냄. 실패하면 되돌림.
  async function write(op,c,id,data){
    const before = id&&coll(c)[id]?JSON.parse(JSON.stringify(coll(c)[id])):undefined;
    if(op==="set") coll(c)[id]=JSON.parse(JSON.stringify(data));
    else if(op==="update"){const cur=coll(c)[id]||{};for(const [k,v] of Object.entries(data))if(v&&v.__delete__)delete cur[k];else cur[k]=v;coll(c)[id]=cur;}
    else if(op==="delete") delete coll(c)[id];
    notify(new Set([c]));
    try{
      const j = await post({op,coll:c,id,data,pin:LS.get("eqPin","")});
      if(op==="add"){coll(c)[j.id]=JSON.parse(JSON.stringify(data));notify(new Set([c]));}
      saveCache(); setTimeout(sync,300);
      return j;
    }catch(e){
      if(op!=="add"){if(before===undefined)delete coll(c)[id];else coll(c)[id]=before;notify(new Set([c]));}
      throw e;
    }
  }
  function docRef(path){
    const i=path.indexOf("/"), c=path.slice(0,i), id=path.slice(i+1);
    return {
      id,
      set:(d)=>write("set",c,id,d),
      update:(d)=>write("update",c,id,d),
      delete:()=>write("delete",c,id),
      get:async()=>{await sync();const d=coll(c)[id];return {id,exists:!!d,data:()=>d?JSON.parse(JSON.stringify(d)):undefined};},
    };
  }
  const db = {
    collection:(c)=>Object.assign(query(c),{doc:(id)=>docRef(c+"/"+id),add:async(d)=>{const j=await write("add",c,null,d);return {id:j.id};}}),
    doc:docRef,
  };

  // ---------- 파일(사진·PDF) ----------
  function b64(blob){return new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(",")[1]);r.onerror=no;r.readAsDataURL(blob);});}
  const assets = {
    async upload(blob){
      const j = await post({op:"upload",mime:blob.type||"application/octet-stream",name:blob.name||"",b64:await b64(blob)});
      cache.files[j.id]={d:j.driveId,t:j.mime};saveCache();
      return {id:j.id,url:blobUrl(j.id)};
    },
    async delete(id){await post({op:"deleteFile",id,pin:LS.get("eqPin","")});delete cache.files[id];saveCache();},
  };
  // 사진 주소: 드라이브 썸네일 (공유 링크) — 안 열리면 아래 오류 처리에서 서버로 받아 보여줌
  function blobUrl(id){
    const f = fileMap()[id];
    if(!f) return "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    return "https://drive.google.com/thumbnail?id="+encodeURIComponent(f.d)+"&sz=w2000";
  }
  const dataCache = {};
  async function fileData(id){
    if(dataCache[id]) return dataCache[id];
    const j = await getJSON({action:"file",id});
    if(!j.ok) throw new Error(j.error||"파일을 받지 못했습니다");
    const bin = atob(j.b64), u = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
    return (dataCache[id]={mime:j.mime,bytes:u});
  }
  // 드라이브 썸네일이 막혀 있으면(회사망 등) 서버에서 직접 받아서 표시
  document.addEventListener("error",async ev=>{
    const img=ev.target; if(!(img instanceof HTMLImageElement)) return;
    const m=String(img.src).match(/thumbnail\?id=([^&]+)/); if(!m||img.dataset.fb) return;
    img.dataset.fb="1";
    const id=Object.keys(fileMap()).find(k=>fileMap()[k].d===decodeURIComponent(m[1])); if(!id) return;
    try{const f=await fileData(id);img.src=URL.createObjectURL(new Blob([f.bytes],{type:f.mime}));}catch(e){}
  },true);

  // ---------- 내려받기 ----------
  const downloads = {
    async save({filename,data}){
      const blob = data instanceof Blob?data:new Blob([data],{type:/\.csv$/i.test(filename)?"text/csv;charset=utf-8":"application/octet-stream"});
      const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();
      setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},2000);
    }
  };

  // ---------- 사용자 (로그인 없음: 기기별 번호 + 관리자 PIN) ----------
  let devId = LS.get("eqDevice",""); if(!devId){devId="d_"+Math.random().toString(36).slice(2,12);LS.set("eqDevice",devId);}
  const user = {
    id:async()=>devId,
    canEdit:async()=>!!LS.get("eqPinOk",false),
    profiles:async()=>({}),
  };
  async function checkPin(pin){
    if(!API) return false;
    const j = await getJSON({action:"pin",pin});
    if(j.ok){LS.set("eqPin",pin);LS.set("eqPinOk",true);} return !!j.ok;
  }
  function clearPin(){LS.set("eqPin","");LS.set("eqPinOk",false);}

  firstSync = API ? sync() : Promise.resolve();
  window.EQ = {blobUrl,fileData,checkPin,clearPin,sync,hasApi:!!API,lastOk:()=>lastOk};
  window.claude = {
    use: async(name)=>({db:API?db:null,user,assets:API?assets:null,downloads})[name]??null
  };
  if(API){ setInterval(sync,POLL_MS); document.addEventListener("visibilitychange",()=>{if(!document.hidden)sync();}); }
})();
