'use strict';

const API = 'https://gitlab.com/api/v4';
const PROJECT = 'book-of-songs-data';
const $ = id => document.getElementById(id);
const state = { scope: 'choir', songs: [], selected: null, syncing: false, sort: { key: 'number', dir: 'asc' } };

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('book-of-songs-ios', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('settings');
      db.createObjectStore('snapshots');
      db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const dbp = openDb();
async function get(store, key) { const db=await dbp; return new Promise((res,rej)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}); }
async function put(store, value, key) { const db=await dbp; return new Promise((res,rej)=>{const r=db.transaction(store,'readwrite').objectStore(store).put(value,key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}); }
async function add(store, value) { const db=await dbp; return new Promise((res,rej)=>{const r=db.transaction(store,'readwrite').objectStore(store).add(value);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}); }
async function all(store) { const db=await dbp; return new Promise((res,rej)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}); }
async function removeMany(store, ids) { if(!ids.length)return; const db=await dbp; await new Promise((res,rej)=>{const tx=db.transaction(store,'readwrite'),os=tx.objectStore(store);ids.forEach(id=>os.delete(id));tx.oncomplete=res;tx.onerror=()=>rej(tx.error);}); }

const enc = encodeURIComponent;
function b64bytes(value) { const raw=atob(value.replace(/\s/g,'')), out=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i); return out; }
function bytesB64(bytes) { let s=''; for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(s); }
async function gunzip(bytes) { const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')); return new TextDecoder().decode(await new Response(stream).arrayBuffer()); }
async function gzip(text) { const stream=new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')); return new Uint8Array(await new Response(stream).arrayBuffer()); }
async function api(token, method, path, body) {
  const response=await fetch(API+path,{method,headers:{'PRIVATE-TOKEN':token,'Accept':'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();
  if(!response.ok){let detail=text;try{detail=JSON.parse(text).message||text}catch{};throw new Error(`GitLab ${response.status}: ${typeof detail==='string'?detail:JSON.stringify(detail)}`)}
  return text?JSON.parse(text):{};
}
async function config() { return get('settings','sync'); }
async function connect() {
  const token=$('token').value.trim(); if(!token){toast('Введите токен');return;}
  busy(true,'Подключаюсь к GitLab…');
  try {
    const projects=await api(token,'GET',`/projects?search=${enc(PROJECT)}&membership=true&simple=true&per_page=100`);
    const project=projects.find(p=>p.name===PROJECT); if(!project)throw new Error(`Проект ${PROJECT} не найден`);
    await put('settings',{token,projectId:String(project.id),branch:project.default_branch||'main'},'sync');
    $('setup').classList.add('hidden'); $('app').classList.remove('hidden'); await syncAll();
  } catch(e) { toast(friendly(e)); busy(false,'Не подключено'); }
}
function keyOf(song,index) { return `${song.createdAt||''}|${song.number??''}|${song.title||''}|${index}`; }
function findSong(songs, op) {
  let exact=null, number=[], created=[];
  songs.forEach((s,i)=>{if(keyOf(s,i)===op.songKey)exact=s;if(String(s.number??'')===String(op.number??'')){number.push(s);if(op.createdAt&&s.createdAt===op.createdAt)created.push(s);}});
  return exact || songs.find(s=>String(s.number??'')===String(op.number??'')&&s.title===op.title) || (created.length===1?created[0]:null) || (number.length===1?number[0]:null);
}
function merge(snapshot, ops) {
  for(const op of ops){const song=findSong(snapshot.songs,op);if(!song)throw new Error(`Не найдена песня №${op.number||'—'} в свежей базе`);song.dates=Array.isArray(song.dates)?song.dates:[];
    if(op.type==='add'){if(!song.dates.includes(op.date))song.dates.push(op.date);}
    else {song.dates=song.dates.filter(d=>d!==op.oldDate);if(!song.dates.includes(op.newDate))song.dates.push(op.newDate);}
    song.dates.sort();
  }
}
async function downloadScope(cfg,scope) {
  const meta=await api(cfg.token,'GET',`/projects/${enc(cfg.projectId)}/repository/files/${enc(scope+'.json.gz')}?ref=${enc(cfg.branch)}`);
  const snapshot=JSON.parse(await gunzip(b64bytes(meta.content))); if(snapshot.version!==1||snapshot.scope!==scope)throw new Error('Неподдерживаемый формат данных');
  return {snapshot,lastCommitId:meta.last_commit_id};
}
async function uploadScope(cfg,scope,file) {
  file.snapshot.publishedAt=new Date().toISOString(); file.snapshot.device='iPhone PWA';
  const content=bytesB64(await gzip(JSON.stringify(file.snapshot)));
  await api(cfg.token,'PUT',`/projects/${enc(cfg.projectId)}/repository/files/${enc(scope+'.json.gz')}`,{branch:cfg.branch,content,encoding:'base64',commit_message:`sync ${scope} @ ${file.snapshot.publishedAt} (iPhone)`,last_commit_id:file.lastCommitId});
}
async function syncScope(cfg,scope) {
  for(let attempt=0;attempt<3;attempt++){
    const file=await downloadScope(cfg,scope), ops=(await all('pending')).filter(x=>x.scope===scope);
    merge(file.snapshot,ops);
    try { if(ops.length)await uploadScope(cfg,scope,file); await put('snapshots',file.snapshot,scope); await removeMany('pending',ops.map(x=>x.id)); return ops.length; }
    catch(e){if(!String(e.message).includes('GitLab 400')&&!String(e.message).includes('GitLab 409')||attempt===2)throw e;}
  }
}
async function syncAll(silent=false) {
  if(state.syncing)return; const cfg=await config(); if(!cfg){showSetup();return;}
  state.syncing=true; busy(true,'Синхронизация…');
  try { const sent=(await syncScope(cfg,'choir'))+(await syncScope(cfg,'general')); await loadSongs(); busy(false,sent?`Отправлено изменений: ${sent}`:'Данные актуальны'); if(!silent)toast('Синхронизация завершена'); }
  catch(e){await loadSongs();busy(false,navigator.onLine?'Ошибка синхронизации':'Нет интернета — изменения сохранены');if(!silent)toast(navigator.onLine?friendly(e):'Нет интернета. Даты отправятся позже.');}
  finally { state.syncing=false; }
}
async function pendingFor(scope) { return (await all('pending')).filter(x=>x.scope===scope); }
async function loadSongs() {
  const snapshot=await get('snapshots',state.scope), ops=await pendingFor(state.scope);
  state.songs=snapshot?JSON.parse(JSON.stringify(snapshot.songs)):[]; if(snapshot)merge({songs:state.songs},ops); render();
}
async function addDate() {
  const date=$('newDate').value;if(!date||!state.selected)return;
  const s=state.selected.song; await add('pending',{type:'add',scope:state.scope,songKey:keyOf(s,state.selected.index),number:s.number,title:s.title,createdAt:s.createdAt||'',date});
  $('newDate').value=''; await loadSongs(); reopenSelected(); toast('Дата сохранена на iPhone'); if(navigator.onLine)syncAll(true);
}
async function editDate(oldDate) {
  const next=prompt('Новая дата (ГГГГ-ММ-ДД)',oldDate);if(!next||next===oldDate||!/^\d{4}-\d{2}-\d{2}$/.test(next))return;
  const s=state.selected.song; await add('pending',{type:'edit',scope:state.scope,songKey:keyOf(s,state.selected.index),number:s.number,title:s.title,createdAt:s.createdAt||'',oldDate,newDate:next});
  await loadSongs(); reopenSelected(); toast('Изменение сохранено на iPhone'); if(navigator.onLine)syncAll(true);
}
function displayDate(d){return /^\d{4}-\d{2}-\d{2}$/.test(d)?`${d.slice(8)}.${d.slice(5,7)}.${d.slice(0,4)}`:d;}
function latestDate(song){const dates=[...(song.dates||[])].sort();return dates.length?dates[dates.length-1]:'';}
function themeText(song){return (song.themes||[]).map(x=>typeof x==='string'?x:x.name).filter(Boolean).join(', ');}
function tintClass(date){if(!date||!/^\d{4}-\d{2}-\d{2}$/.test(date))return '';const last=new Date(date+'T00:00:00');if(Number.isNaN(last.getTime()))return '';const days=(Date.now()-last.getTime())/86400000;if(days<182)return 'tint-red';if(days<365)return 'tint-orange';return 'tint-green';}
function naturalCompare(a,b){const sa=String(a),sb=String(b),ma=sa.match(/^(\d+)(.*)$/),mb=sb.match(/^(\d+)(.*)$/);if(ma&&mb){const la=ma[2]!==''?1:0,lb=mb[2]!==''?1:0;if(la!==lb)return la-lb;const d=Number(ma[1])-Number(mb[1]);if(d!==0)return d;return ma[2].localeCompare(mb[2],'ru',{sensitivity:'base'});}return sa.localeCompare(sb,'ru',{sensitivity:'base'});}
function sortSongs(items){const getters={number:x=>x.song.number,title:x=>x.song.title,lastDate:x=>latestDate(x.song),themes:x=>themeText(x.song),updatedAt:x=>x.song.updatedAt};const get=getters[state.sort.key],sign=state.sort.dir==='asc'?1:-1;return [...items].sort((a,b)=>{const va=get(a),vb=get(b),ea=va===null||va===undefined||va==='',eb=vb===null||vb===undefined||vb==='';if(ea&&eb)return 0;if(ea)return 1;if(eb)return -1;return naturalCompare(va,vb)*sign;});}
function render(){const q=$('search').value.trim().toLocaleLowerCase('ru'),matched=state.songs.map((song,index)=>({song,index})).filter(x=>!q||String(x.song.number??'').toLocaleLowerCase('ru').includes(q)||x.song.title.toLocaleLowerCase('ru').includes(q)),filtered=sortSongs(matched);
  $('summary').textContent=`Песен: ${filtered.length}`;$('songs').replaceChildren(...filtered.map(({song,index})=>{const b=document.createElement('button'),last=latestDate(song),themes=themeText(song),updated=song.updatedAt?displayDate(String(song.updatedAt).split(/[ T]/)[0]):'';b.className=`song ${tintClass(last)}`.trim();b.innerHTML=`<strong>${song.number?`№${escapeHtml(song.number)} · `:''}${escapeHtml(song.title)}</strong><span class="last-played">${last?'Последнее исполнение: '+displayDate(last):'Не исполнялась'}</span>${themes||updated?`<span class="song-meta">${themes?`<span>Тематика: ${escapeHtml(themes)}</span>`:''}${updated?`<span>Изменено: ${escapeHtml(updated)}</span>`:''}</span>`:''}`;b.onclick=()=>openSong(index);return b;}));}
function openSong(index){const song=state.songs[index];state.selected={song,index};$('songNumber').textContent=song.number?`Песня №${song.number}`:'';$('songTitle').textContent=song.title;$('lyrics').textContent=song.lyrics||'Текст пока не добавлен';renderDates(song);if(!$('songDialog').open)$('songDialog').showModal();}
function reopenSelected(){if(!state.selected)return;const ref=state.selected.song;const index=state.songs.findIndex((s,i)=>keyOf(s,i)===keyOf(ref,state.selected.index))>=0?state.songs.findIndex((s,i)=>keyOf(s,i)===keyOf(ref,state.selected.index)):state.selected.index;openSong(index);}
async function renderDates(song){const pending=await pendingFor(state.scope),pendingDates=new Set();pending.forEach(x=>{if(x.songKey===keyOf(song,state.selected.index)){if(x.type==='add')pendingDates.add(x.date);else pendingDates.add(x.newDate);}});const dates=[...(song.dates||[])].sort().reverse();$('dates').replaceChildren(...dates.map(d=>{const row=document.createElement('div');row.className='date-row';const label=document.createElement('span');label.textContent=displayDate(d);if(pendingDates.has(d))label.className='pending';const edit=document.createElement('button');edit.textContent='Изменить';edit.onclick=()=>editDate(d);row.append(label,edit);return row;}));}
function setScope(scope){state.scope=scope;document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.scope===scope));loadSongs();}
function updateSortButtons(){document.querySelectorAll('[data-sort]').forEach(button=>{const active=button.dataset.sort===state.sort.key;button.classList.toggle('active',active);button.querySelector('b').textContent=active?(state.sort.dir==='asc'?'▲':'▼'):'';});}
function changeSort(key){if(state.sort.key===key)state.sort.dir=state.sort.dir==='asc'?'desc':'asc';else state.sort={key,dir:'asc'};updateSortButtons();render();}
function busy(on,text){$('sync').disabled=on;$('connect').disabled=on;$('status').textContent=text;}
function toast(text){const el=$('toast');el.textContent=text;el.classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.add('hidden'),4000);}
function friendly(e){return e&&e.message?e.message:'Неизвестная ошибка';}
function escapeHtml(v){return String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function showSetup(){ $('setup').classList.remove('hidden');$('app').classList.add('hidden');busy(false,'Требуется подключение'); }

document.querySelectorAll('.tab').forEach(x=>x.onclick=()=>setScope(x.dataset.scope));
$('search').oninput=render;document.querySelectorAll('[data-sort]').forEach(button=>button.onclick=()=>changeSort(button.dataset.sort));$('connect').onclick=connect;$('sync').onclick=()=>syncAll();$('addDate').onclick=addDate;$('closeDialog').onclick=()=>$('songDialog').close();
$('settings').onclick=()=>{if(confirm('Заменить сохранённый GitLab-токен?'))showSetup();};
window.addEventListener('online',()=>syncAll(true));
window.addEventListener('error',()=>busy(false,'Ошибка запуска — обновите приложение'));
window.addEventListener('unhandledrejection',()=>busy(false,'Ошибка данных — нажмите синхронизацию'));
(async()=>{if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js');try{await navigator.storage?.persist?.()}catch{};const cfg=await config();if(cfg){$('app').classList.remove('hidden');await loadSongs();syncAll(true);}else showSetup();})().catch(e=>{busy(false,'Ошибка запуска');toast(friendly(e));});
