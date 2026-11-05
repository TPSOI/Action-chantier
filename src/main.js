import './style.css';
import { jsPDF } from 'jspdf';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { initializeApp } from 'firebase/app';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc, deleteDoc, onSnapshot } from 'firebase/firestore';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from 'firebase/auth';
import { firebaseConfig } from './firebase-config.js';
window.jspdf = { jsPDF };

(function(){
'use strict';
window.addEventListener('error', e => { const st=document.getElementById('status'); if(st){ st.className='status err'; st.textContent='Erreur : '+(e.message||'inconnue'); } });
const $ = s => document.querySelector(s);
const board = $('#board');
const LS_DATA='ac-data-v1', LS_UI='ac-ui-v1';
const STATUS = {todo:'À faire', doing:'En cours', done:'Fait'};
const NEXT = {todo:'doing', doing:'done', done:'todo'};
const CONDUCTEURS = ['Noah','Techer Thomas'];
const COKEYS = ['tpsoi','citanea','sps'];
const COMPANIES = {
  tpsoi:  {name:'TPSOI',   full:'TPS Océan Indien',          c1:'#1B87D8', c2:'#2E2E2E', ink:'#FFFFFF', rgb1:[27,135,216], rgb2:[46,46,46],  chefs:['Stephane','Gilbert','Ryan','Johan']},
  citanea:{name:'Citanéa', full:'Citanéa',                   c1:'#FFBE33', c2:'#134558', ink:'#134558', rgb1:[255,190,51], rgb2:[19,69,88],  chefs:['Stephane','Gilbert','Ryan','Johan','Olivier']},
  sps:    {name:'SPS',     full:'Sports Paysages Solutions', c1:'#7AC02B', c2:'#6E6E6E', ink:'#1C2228', rgb1:[122,192,43], rgb2:[110,110,110], chefs:['Olivier']}
};
let chantiers = [];
let backend = null, coll = null;
let ui = { filter:'all', q:'', resp:'', cond:'', chef:'', company:'tpsoi', collapsed:{}, notesOpen:{}, openMenu:null, confirmDel:null, renaming:null, editingNote:null, editingNoteCh:null, form:null };
const drafts = {};
try{ const s=JSON.parse(localStorage.getItem(LS_UI)||'{}'); if(s.collapsed) ui.collapsed=s.collapsed; if(s.notesOpen) ui.notesOpen=s.notesOpen; if(s.company && COMPANIES[s.company]) ui.company=s.company; }catch(e){}
const saveUi = () => { try{ localStorage.setItem(LS_UI, JSON.stringify({collapsed:ui.collapsed, notesOpen:ui.notesOpen, company:ui.company})); }catch(e){} };

const uid = () => Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4);
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = s => String(s==null?'':s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const dateFR = d => d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
$('#today').textContent = dateFR(new Date()).replace(/^./, c=>c.toUpperCase());
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'),2200); }
function setStatus(msg){ const st=$('#status'); st.className='status'; st.textContent=msg||''; }

/* ---------- Dates ---------- */
function todayMid(){ const d=new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function parseDue(s){ if(!s) return null; const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m? new Date(+m[1], +m[2]-1, +m[3]) : null; }
function dueDiff(a){ const d=parseDue(a.due); if(!d) return null; return Math.round((d - todayMid())/86400000); }
const isLate = a => a.status!=='done' && dueDiff(a)!==null && dueDiff(a)<0;
const fmtDue = s => { const d=parseDue(s); return d? d.toLocaleDateString('fr-FR',{weekday:'short',day:'2-digit',month:'2-digit'}) : ''; };
const shortDate = iso => { const d=new Date(iso); return isNaN(d)? '' : d.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}); };
function relDue(a){
  const n=dueDiff(a); if(n===null) return '';
  if(a.status==='done') return '';
  if(n<0) return `retard ${-n} j`;
  if(n===0) return "aujourd'hui";
  if(n===1) return 'demain';
  return `dans ${n} j`;
}

/* ---------- Stockage ---------- */
function persistLocal(){ try{ localStorage.setItem(LS_DATA, JSON.stringify(chantiers)); }catch(e){} }
const pending=new Map(), unsynced=new Set(), deletedIds=new Set(), chains={};
const cleanNote = n => ({id:String(n.id), text:String(n.text), createdAt:String(n.createdAt||'')});
const cleanAct = a => { const o={id:String(a.id), sujet:String(a.sujet||''), constat:String(a.constat||''), action:String(a.action||''), resp:String(a.resp||''), due:String(a.due||''), status:STATUS[a.status]?a.status:'todo', urgent:!!a.urgent, createdAt:String(a.createdAt||'')}; if(a.doneAt) o.doneAt=String(a.doneAt); return o; };
function errLabel(e){ return (e && (e.code||e.name)) ? (e.code||e.name)+(e.message?' – '+e.message:'') : String(e); }
function showSyncError(e){
  const st=$('#status'); st.className='status err';
  st.innerHTML = `Modification non enregistrée en ligne (${esc(errLabel(e))}). Elle reste affichée sur cet appareil. <button class="linkbtn" type="button" id="retrySync">Réessayer</button>`;
  const b=$('#retrySync'); if(b) b.onclick=retrySync;
}
function clearSyncError(){ if(!unsynced.size){ const st=$('#status'); if(st.classList.contains('err')){ st.className='status'; st.textContent=''; } } }
function retrySync(){ const ids=[...unsynced]; unsynced.clear(); ids.forEach(id=>{ const c=findCh(id); if(c) save(c); }); }
function track(id, op){
  pending.set(id,(pending.get(id)||0)+1);
  const slow=setTimeout(()=>{ const st=$('#status'); if(!st.classList.contains('err')) st.textContent='Enregistrement en attente…'; },8000);
  chains[id]=(chains[id]||Promise.resolve()).then(op).then(
    ()=>{ unsynced.delete(id); clearSyncError(); const st=$('#status'); if(st.textContent.startsWith('Enregistrement en attente')) st.textContent=''; },
    e=>{ unsynced.add(id); showSyncError(e); console.error('db write', e); }
  ).finally(()=>{ clearTimeout(slow); const n=(pending.get(id)||1)-1; if(n>0) pending.set(id,n); else pending.delete(id); });
}
function save(ch){
  persistLocal();
  if(backend!=='db') return;
  const body={name:String(ch.name), order:Number(ch.order)||0, company:String(ch.company||'tpsoi'), conducteur:String(ch.conducteur||''), chef:String(ch.chef||''), actions:ch.actions.map(cleanAct), notes:(ch.notes||[]).map(cleanNote)};
  track(ch.id, ()=>coll.doc(ch.id).set(body));
}
function removeCh(id){
  persistLocal();
  if(backend!=='db') return;
  deletedIds.add(id);
  track(id, ()=>coll.doc(id).delete());
}
function normCh(c){
  if(!Array.isArray(c.notes)) c.notes=[]; if(!Array.isArray(c.actions)) c.actions=[];
  if(!COMPANIES[c.company]) c.company='tpsoi';
  c.conducteur=String(c.conducteur||''); c.chef=String(c.chef||'');
  const ch=COMPANIES[c.company].chefs; if(ch.length===1 && !c.chef) c.chef=ch[0];
  return c;
}
function useLocal(note){
  backend='local';
  try{ chantiers=JSON.parse(localStorage.getItem(LS_DATA)||'[]'); }catch(e){ chantiers=[]; }
  chantiers.forEach(normCh);
  setStatus(note); render();
}

/* ---------- Firebase (partage multi-appareils) ---------- */
const FS_COLLECTION = 'chantiers_actions';
const cfgOk = !!(firebaseConfig && firebaseConfig.apiKey && !/^COLLE|^YOUR|^XXX/i.test(firebaseConfig.apiKey));
let auth = null, fs = null;
function makeColl(){
  const c = collection(fs, FS_COLLECTION);
  return {
    doc: id => ({
      set: body => { const p = setDoc(doc(fs, FS_COLLECTION, id), body); return navigator.onLine ? p : (p.catch(()=>{}), Promise.resolve()); },
      delete: () => { const p = deleteDoc(doc(fs, FS_COLLECTION, id)); return navigator.onLine ? p : (p.catch(()=>{}), Promise.resolve()); }
    }),
    onSnapshot: (ok, err) => onSnapshot(c, snap => ok({docs: snap.docs.map(d => ({id:d.id, data:()=>d.data()}))}), err)
  };
}
let unsub = null;
const loginEl = () => document.getElementById('login');
function showLogin(msg){ loginEl().hidden = false; document.getElementById('userbar').hidden = true; if(msg) document.getElementById('loginMsg').textContent = msg; }
function startSync(user){
  loginEl().hidden = true;
  $('#userbar').hidden = false; $('#userMail').textContent = user.email || '';
  backend = 'db'; coll = makeColl();
  setStatus('Synchronisation…');
  unsub = coll.onSnapshot(onServerSnapshot, err => { setStatus('Synchronisation interrompue (' + (err && err.code || 'erreur') + ').'); });
}
function stopSync(){ if(unsub){ unsub(); unsub = null; } chantiers = []; backend = null; coll = null; render(); }
function netDot(){ const d=$('#netdot'); if(d) { d.classList.toggle('off', !navigator.onLine); d.title = navigator.onLine ? 'En ligne' : 'Hors ligne : les modifications seront envoyées au retour du réseau'; } }
window.addEventListener('online', netDot); window.addEventListener('offline', netDot);
async function init(){
  render();
  if(!cfgOk){ useLocal("Mode local : Firebase n'est pas encore configuré (src/firebase-config.js). Les données restent sur cet appareil."); return; }
  const app = initializeApp(firebaseConfig);
  fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  auth = getAuth(app);
  netDot();
  onAuthStateChanged(auth, user => { if(user) startSync(user); else { stopSync(); showLogin(); } });
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); const m=$('#loginMsg'); m.className='status'; m.textContent='Connexion…';
    try{ await signInWithEmailAndPassword(auth, $('#loginMail').value.trim(), $('#loginPass').value); m.textContent=''; $('#loginPass').value=''; }
    catch(err){ m.className='status err'; const c=err&&err.code||''; m.textContent = /invalid-credential|wrong-password|user-not-found|invalid-email/.test(c) ? 'E-mail ou mot de passe incorrect.' : /api-key|invalid-api/.test(c) ? 'Clé Firebase invalide : vérifie apiKey dans src/firebase-config.js.' : /network/.test(c) ? 'Pas de connexion réseau.' : /too-many/.test(c) ? 'Trop de tentatives, réessaie dans quelques minutes.' : 'Connexion impossible ('+c+').'; }
  });
  $('#loginReset').addEventListener('click', async () => {
    const mail=$('#loginMail').value.trim(), m=$('#loginMsg');
    if(!mail){ m.className='status err'; m.textContent="Saisis d'abord ton e-mail."; return; }
    try{ await sendPasswordResetEmail(auth, mail); m.className='status'; m.textContent='E-mail de réinitialisation envoyé.'; }catch(err){ m.className='status err'; m.textContent='Envoi impossible.'; }
  });
  $('#btnLogout').addEventListener('click', () => signOut(auth));
}
function onServerSnapshot(snap){
  const local=new Map(chantiers.map(c=>[c.id,c]));
  const server=snap.docs.map(d=>Object.assign({id:d.id}, JSON.parse(JSON.stringify(d.data()||{})))).map(c=>({id:c.id, name:String(c.name||'Sans nom'), order:+c.order||0, company:c.company, conducteur:c.conducteur, chef:c.chef, actions:Array.isArray(c.actions)?c.actions.map(a=>Object.assign({},a)):[], notes:Array.isArray(c.notes)?c.notes.map(n=>Object.assign({},n)):[]}));
  const keep=id=>pending.has(id)||unsynced.has(id);
  const next=server.filter(c=>!deletedIds.has(c.id)||!keep(c.id)).map(c=>keep(c.id)&&local.has(c.id)?local.get(c.id):c);
  local.forEach((c,id)=>{ if(keep(id)&&!deletedIds.has(id)&&!next.some(x=>x.id===id)) next.push(c); });
  chantiers=next; chantiers.forEach(normCh);
  chantiers.sort((a,b)=>a.order-b.order||a.name.localeCompare(b.name));
  const st=$('#status'); if(!st.classList.contains('err') && !st.textContent.startsWith('Enregistrement')) setStatus('');
  render();
}

/* ---------- Rendu ---------- */
const ICON = {
  chev:'<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dots:'<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="4" cy="9" r="1.6" fill="currentColor"/><circle cx="9" cy="9" r="1.6" fill="currentColor"/><circle cx="14" cy="9" r="1.6" fill="currentColor"/></svg>',
  flag:'<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 14V2.5M3.5 3h8l-1.8 3 1.8 3h-8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  edit:'<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5l1-3.8 8-8 2.8 2.8-8 8-3.8 1zM10 3.2l2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  x:'<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
};
const findCh = id => chantiers.find(c=>c.id===id);
const inCo = () => chantiers.filter(c=>c.company===ui.company);
const chOk = c => (!ui.cond || c.conducteur===ui.cond) && (!ui.chef || c.chef===ui.chef);
function allResps(list){ const s=new Set(); (list||chantiers).forEach(c=>c.actions.forEach(a=>{ if(a.resp && a.resp.trim()) s.add(a.resp.trim()); })); return [...s].sort((a,b)=>a.localeCompare(b,'fr')); }
function refreshFilters(){
  const co=COMPANIES[ui.company], base=inCo();
  const fill=(id,label,list,key)=>{ const sel=$(id); let cur=ui[key]; if(cur && !list.includes(cur)){ ui[key]=''; cur=''; }
    sel.innerHTML=`<option value="">${label}</option>`+list.map(r=>`<option value="${esc(r)}"${r===cur?' selected':''}>${esc(r)}</option>`).join(''); };
  fill('#condFilter','Tous les conducteurs',CONDUCTEURS,'cond');
  fill('#chefFilter','Tous les chefs',co.chefs,'chef');
  fill('#respFilter','Tous les responsables',allResps(base),'resp');
}
function renderTabs(){
  const co=COMPANIES[ui.company];
  const wrap=document.querySelector('.wrap'); wrap.style.setProperty('--brand',co.c1); wrap.style.setProperty('--brand2',co.c2);
  $('#eyebrow').textContent=co.full+' · Suivi des actions';
  document.querySelector('#addChPanel h3').textContent='Nouveau chantier · '+co.name;
  $('#tabs').innerHTML=COKEYS.map(k=>{
    const c=COMPANIES[k]; let open=0, late=0;
    chantiers.forEach(ch=>{ if(ch.company!==k) return; ch.actions.forEach(a=>{ if(a.status!=='done'){ open++; if(isLate(a)) late++; } }); });
    return `<button class="tab" role="tab" type="button" data-co="${k}" aria-selected="${k===ui.company}" style="--tc1:${c.c1};--tc2:${c.c2};--tci:${c.ink}" title="${esc(c.full)}"><span class="sw"><i style="background:${c.c1}"></i><i style="background:${c.c2}"></i></span><span class="tn">${esc(c.name)}</span>${late?`<span class="tb late" title="En retard">${late}</span>`:''}<span class="tb" title="Actions ouvertes">${open}</span></button>`;
  }).join('');
}
function crewHtml(c){
  const co=COMPANIES[c.company];
  const opts=(list,val,fixed)=>{ const l=list.slice(); if(val && !l.includes(val)) l.push(val);
    return (fixed?'':'<option value="">— à choisir —</option>')+l.map(x=>`<option value="${esc(x)}"${x===val?' selected':''}>${esc(x)}</option>`).join(''); };
  const single=co.chefs.length===1;
  return `<div class="crew">
    <label>Conducteur de travaux<select data-crew="conducteur" class="${c.conducteur?'':'empty'}" aria-label="Conducteur de travaux de ${esc(c.name)}">${opts(CONDUCTEURS,c.conducteur,false)}</select></label>
    <label>Chef de chantier<select data-crew="chef" class="${c.chef?'':'empty'}" aria-label="Chef de chantier de ${esc(c.name)}">${opts(co.chefs,c.chef,single)}</select></label>
  </div>`;
}
function refreshRespSelect(){
  const sel=$('#respFilter'), cur=ui.resp, list=allResps();
  if(cur && !list.includes(cur)) { ui.resp=''; }
  sel.innerHTML='<option value="">Tous les responsables</option>'+list.map(r=>`<option value="${esc(r)}"${r===ui.resp?' selected':''}>${esc(r)}</option>`).join('');
}
function matches(c,a){
  const q=norm(ui.q.trim());
  if(ui.filter==='todo' && a.status==='done') return false;
  if(ui.filter==='done' && a.status!=='done') return false;
  if(ui.filter==='urgent' && (!a.urgent || a.status==='done')) return false;
  if(ui.filter==='late' && !isLate(a)) return false;
  if(ui.resp && (a.resp||'').trim()!==ui.resp) return false;
  if(q && !(norm(c.name).includes(q) || norm(a.sujet).includes(q) || norm(a.constat).includes(q) || norm(a.action).includes(q) || norm(a.resp).includes(q))) return false;
  return true;
}
function sortActs(list){
  const rank=a=>a.status==='done'?3:(isLate(a)?0:(a.urgent?1:2));
  const dueKey=a=>{ const d=parseDue(a.due); return d? d.getTime() : 9e15; };
  return list.map((a,i)=>[a,i]).sort((x,y)=>rank(x[0])-rank(y[0]) || dueKey(x[0])-dueKey(y[0]) || x[1]-y[1]).map(x=>x[0]);
}
function renderStats(){
  let open=0, late=0, urg=0, done=0;
  inCo().forEach(c=>c.actions.forEach(a=>{ if(a.status==='done') done++; else { open++; if(a.urgent) urg++; if(isLate(a)) late++; } }));
  $('#stats').innerHTML =
    `<div class="stat"><b>${open}</b><span>Ouvertes</span></div>`+
    `<div class="stat${late?' hot':''}"><b>${late}</b><span>En retard</span></div>`+
    `<div class="stat${urg?' warm':''}"><b>${urg}</b><span>Urgentes</span></div>`+
    `<div class="stat"><b>${done}</b><span>Faites</span></div>`+
    `<div class="stat"><b>${inCo().length}</b><span>Chantiers</span></div>`;
}
function formHtml(c, editId){
  const d=ui.form.d;
  const dl='<datalist id="respList">'+allResps().map(r=>`<option value="${esc(r)}">`).join('')+'</datalist>';
  return `<div class="form" data-form="1">
    <label>Sujet<input data-f="sujet" data-key="f-sujet" value="${esc(d.sujet)}" placeholder="Ex. Réseau EU – tranchée zone B" autocomplete="off"></label>
    <label>Constat<textarea data-f="constat" data-key="f-constat" rows="2" placeholder="Ce qui a été observé sur le chantier">${esc(d.constat)}</textarea></label>
    <label>Action à mener<textarea data-f="action" data-key="f-action" rows="2" placeholder="Ce qu'il faut faire">${esc(d.action)}</textarea></label>
    <div class="two">
      <label>Responsable<input data-f="resp" data-key="f-resp" list="respList" value="${esc(d.resp)}" placeholder="Ex. Chef de chantier" autocomplete="off"></label>
      <label>Échéance<input type="date" data-f="due" data-key="f-due" value="${esc(d.due)}"></label>
    </div>
    ${dl}
    <div class="form-btns">
      <button class="btn primary sm" type="button" data-act="saveform">${editId?'Enregistrer':'Ajouter l\'action'}</button>
      <button class="btn ghost sm" type="button" data-act="cancelform">Annuler</button>
      <span class="hint">Ctrl+Entrée pour valider</span>
    </div>
  </div>`;
}
function actHtml(c, a){
  if(ui.form && ui.form.ch===c.id && ui.form.id===a.id) return `<li class="act-edit">${formHtml(c,a.id)}</li>`;
  const late=isLate(a), n=dueDiff(a);
  let dueChip='';
  if(a.due){
    const cls = a.status==='done' ? '' : late ? ' late' : (n!==null && n<=2 ? ' soon' : '');
    const rel = relDue(a);
    dueChip = `<span class="chip${cls}" title="Échéance">Échéance ${esc(fmtDue(a.due))}${rel?` · ${esc(rel)}`:''}</span>`;
  } else dueChip = `<span class="chip">Sans échéance</span>`;
  const respChip = a.resp ? `<span class="chip" title="Responsable">${esc(a.resp)}</span>` : `<span class="chip" style="color:var(--muted)">Responsable à définir</span>`;
  const doneInfo = a.status==='done' && a.doneAt ? `<span>Clos le ${esc(shortDate(a.doneAt).slice(0,5))}</span>` : '';
  return `<li class="act${a.status==='done'?' done':''}${a.urgent?' urgent':''}" data-a="${a.id}">
    <div class="act-top">
      <button class="st ${a.status}" type="button" data-act="status" title="Changer le statut" aria-label="Statut : ${STATUS[a.status]}. Cliquer pour changer">${STATUS[a.status]}</button>
      <span class="sujet">${esc(a.sujet||'(sans sujet)')}</span>
      <span class="tools">
        <button class="flag" type="button" data-act="urgent" title="${a.urgent?'Retirer urgent':'Marquer urgent'}" aria-label="Urgent" aria-pressed="${!!a.urgent}">${ICON.flag}</button>
        <button type="button" data-act="editact" title="Modifier" aria-label="Modifier l'action">${ICON.edit}</button>
        <button class="del" type="button" data-act="delact" title="Supprimer" aria-label="Supprimer l'action">${ICON.x}</button>
      </span>
    </div>
    <dl class="kv" style="margin:0">
      ${a.constat?`<dt>Constat</dt><dd>${esc(a.constat)}</dd>`:''}
      ${a.action?`<dt>Action</dt><dd>${esc(a.action)}</dd>`:''}
    </dl>
    <div class="meta">${respChip}${dueChip}${doneInfo}</div>
  </li>`;
}
function notesHtml(c){
  const notes=c.notes||[]; const open = ui.notesOpen[c.id]!==undefined ? !!ui.notesOpen[c.id] : notes.length>0;
  const items=notes.map(n=>{
    const editing=ui.editingNote===n.id;
    const body = editing
      ? `<textarea class="note-edit" data-key="nedit-${n.id}" data-role="editnote" rows="2" aria-label="Modifier la note">${esc(drafts['nedit-'+n.id] ?? n.text)}</textarea>`
      : `<span class="note-txt" data-act="editnote" title="Cliquer pour modifier">${esc(n.text)}<span class="note-date">${esc(shortDate(n.createdAt))}</span></span>`;
    return `<div class="nt-item" data-n="${n.id}">${body}
      <button class="to-task" type="button" data-act="note2act" title="Transformer cette note en action">→ Action</button>
      <button class="del" type="button" data-act="delnote" title="Supprimer la note" aria-label="Supprimer la note">${ICON.x}</button></div>`;
  }).join('');
  return `<section class="notes${open?' open':''}">
    <button class="notes-h" type="button" data-act="togglenotes" aria-expanded="${open}">${ICON.chev} Notes <span class="mono">${notes.length||''}</span></button>
    <div class="notes-body">${items}
      <div class="note-add"><textarea data-key="note-${c.id}" data-role="addnote" rows="2" placeholder="Note rapide… (Ctrl+Entrée pour ajouter)" aria-label="Nouvelle note pour ${esc(c.name)}">${esc(drafts['note-'+c.id]||'')}</textarea><button type="button" data-act="addnote" aria-label="Ajouter la note" title="Ajouter la note (Ctrl+Entrée)">+</button></div>
    </div></section>`;
}
function cardHtml(c, idx, nTot){
  const total=c.actions.length, done=c.actions.filter(a=>a.status==='done').length;
  const late=c.actions.filter(isLate).length;
  const pct=total?Math.round(done/total*100):0;
  const acts=sortActs(c.actions.filter(a=>matches(c,a)));
  const collapsed=!!ui.collapsed[c.id] && !ui.q;
  const nameEl = ui.renaming===c.id
    ? `<input class="ren-input" data-key="ren-${c.id}" data-role="rename" value="${esc(drafts['ren-'+c.id] ?? c.name)}" aria-label="Nom du chantier">`
    : `<h2 class="ch-name" data-act="rename" title="Cliquer pour renommer">${esc(c.name)}</h2>`;
  let menu='';
  if(ui.openMenu===c.id){
    menu=`<div class="menu" role="menu">
      <button data-act="rename" role="menuitem">Renommer</button>
      <button data-act="up" role="menuitem" ${idx===0?'disabled':''}>Monter</button>
      <button data-act="down" role="menuitem" ${idx===nTot-1?'disabled':''}>Descendre</button>
      <button data-act="cleardone" role="menuitem" ${done?'':'disabled'}>Retirer les actions faites (${done})</button>
      ${COKEYS.filter(k=>k!==c.company).map(k=>`<button data-act="move" data-co="${k}" role="menuitem">Déplacer vers ${esc(COMPANIES[k].name)}</button>`).join('')}
      <button data-act="askdel" role="menuitem" class="warn">Supprimer le chantier…</button></div>`;
  }
  const nn=(c.notes||[]).length;
  const confirm = ui.confirmDel===c.id ? `<div class="confirm"><span>Supprimer <b>${esc(c.name)}</b> et ses ${total} action${total>1?'s':''}${nn?` et ${nn} note${nn>1?'s':''}`:''} ? Cette action est définitive.</span>
      <div class="row"><button class="btn danger sm" data-act="del" type="button">Supprimer</button><button class="btn ghost sm" data-act="canceldel" type="button">Annuler</button></div></div>` : '';
  let list = acts.map(a=>actHtml(c,a)).join('');
  // si on édite une action masquée par le filtre, on l'affiche quand même
  if(ui.form && ui.form.ch===c.id && ui.form.id && !acts.some(a=>a.id===ui.form.id)){
    const a=c.actions.find(x=>x.id===ui.form.id); if(a) list=actHtml(c,a)+list;
  }
  const emptyMsg = !acts.length && !(ui.form&&ui.form.ch===c.id&&ui.form.id) ? `<div class="empty-acts">${total?'Aucune action pour ce filtre.':'Aucune action. Ajoute la première ci-dessous.'}</div>` : '';
  const adding = ui.form && ui.form.ch===c.id && ui.form.id===null;
  const addBlock = adding ? formHtml(c,null) : `<div class="addrow"><button class="btn sm" type="button" data-act="openform">+ Nouvelle action</button></div>`;
  return `<article class="card${collapsed?' collapsed':''}" data-ch="${c.id}">
    <header class="card-h">
      <button class="chev" data-act="collapse" aria-label="${collapsed?'Déplier':'Replier'}" aria-expanded="${!collapsed}">${ICON.chev}</button>
      ${nameEl}
      ${late?`<span class="badge-late" title="Actions en retard">${late} retard</span>`:''}
      <span class="count mono${total&&done===total?' all-done':''}">${done}/${total}</span>
      <button class="icon" data-act="menu" aria-label="Options du chantier" aria-haspopup="menu">${ICON.dots}</button>
    </header>
    <div class="bar"><span style="width:${pct}%"></span></div>
    ${crewHtml(c)}
    ${menu}${confirm}
    <ul class="acts">${list}</ul>${emptyMsg}
    ${addBlock}
    ${notesHtml(c)}
  </article>`;
}
const grow = el => { el.style.height='auto'; el.style.height=el.scrollHeight+'px'; };
function render(){
  const a=document.activeElement, key=a&&a.dataset&&a.dataset.key;
  const sel=key&&a.selectionStart!=null&&a.type!=='date'?[a.selectionStart,a.selectionEnd]:null;
  renderTabs(); renderStats(); refreshFilters();
  if(backend===null){ board.innerHTML=''; return; }
  const base=inCo(); const list=base.filter(chOk);
  if(!base.length){
    board.innerHTML=`<div class="empty"><strong>Aucun chantier ${esc(COMPANIES[ui.company].name)} pour l'instant</strong><span>Crée un chantier, choisis son conducteur de travaux et son chef de chantier, puis consigne les actions.</span><button class="btn primary" type="button" data-act="openadd">+ Ajouter un chantier</button></div>`;
  } else {
    const filtering = ui.filter!=='all' || ui.q.trim() || ui.resp;
    const qn=norm(ui.q.trim());
    const cards=list.map(c=>{
      if(filtering){
        const has=c.actions.some(x=>matches(c,x));
        const formHere = ui.form && ui.form.ch===c.id;
        const nameOrNote = ui.filter==='all' && !ui.resp && qn && (norm(c.name).includes(qn) || (c.notes||[]).some(n=>norm(n.text).includes(qn)));
        if(!has && !formHere && !nameOrNote) return '';
      }
      return cardHtml(c, base.indexOf(c), base.length);
    }).join('');
    board.innerHTML = cards || `<div class="empty"><strong>Rien ne correspond</strong><span>Change le filtre ou la recherche.</span></div>`;
  }
  board.querySelectorAll('textarea').forEach(grow);
  if(key){ const el=board.querySelector(`[data-key="${key}"]`); if(el){ el.focus(); if(sel) try{ el.setSelectionRange(sel[0],sel[1]); }catch(e){} } }
  if(!$('#pdfPanel').hidden) renderPicks();
}

/* ---------- Actions ---------- */
function commit(ch){ render(); save(ch); }
function addChantier(name){
  name=name.trim(); if(!name) return;
  const order=chantiers.length?Math.max(...chantiers.map(c=>c.order))+1:0;
  const co=COMPANIES[ui.company]; const ch={id:uid(), name:name.toUpperCase(), order, company:ui.company, conducteur:'', chef:co.chefs.length===1?co.chefs[0]:'', actions:[], notes:[]};
  chantiers.push(ch); commit(ch); toast(`Chantier ${ch.name} ajouté`);
}
function finishRename(saveIt){
  const id=ui.renaming; if(!id) return; ui.renaming=null;
  const key='ren-'+id, val=(drafts[key]??'').trim(); delete drafts[key];
  const ch=findCh(id);
  if(saveIt && ch && val && val!==ch.name){ ch.name=val.toUpperCase(); commit(ch); } else render();
}
function finishNoteEdit(saveIt){
  const id=ui.editingNote; if(!id) return; const chId=ui.editingNoteCh; ui.editingNote=null;
  const key='nedit-'+id, val=(drafts[key]??'').trim(); delete drafts[key];
  const ch=findCh(chId), n=ch&&(ch.notes||[]).find(x=>x.id===id);
  if(saveIt && n && val && val!==n.text){ n.text=val; commit(ch); } else render();
}
function swap(ch,dir){
  const L=inCo(), i=L.indexOf(ch), j=i+dir; if(j<0||j>=L.length) return;
  const other=L[j]; const prev=new Map(chantiers.map(c=>[c.id,c.order]));
  chantiers.forEach((c,k)=>c.order=k);
  [ch.order,other.order]=[other.order,ch.order];
  chantiers.sort((a,b)=>a.order-b.order);
  render(); chantiers.forEach(c=>{ if(c.order!==prev.get(c.id)) save(c); });
}
function openForm(ch, act){
  ui.form = { ch:ch.id, id: act?act.id:null, d: act ? {sujet:act.sujet||'',constat:act.constat||'',action:act.action||'',resp:act.resp||'',due:act.due||''} : {sujet:'',constat:'',action:'',resp:'',due:''} };
  if(ui.collapsed[ch.id]){ delete ui.collapsed[ch.id]; saveUi(); }
  render();
  const el=board.querySelector('[data-key="f-sujet"]'); if(el){ el.focus(); if(act) el.select(); el.scrollIntoView({block:'center',behavior:'smooth'}); }
}
function submitForm(){
  const f=ui.form; if(!f) return;
  const ch=findCh(f.ch); if(!ch){ ui.form=null; render(); return; }
  const d=f.d;
  if(!d.sujet.trim()){ const el=board.querySelector('[data-key="f-sujet"]'); if(el) el.focus(); toast('Le sujet est obligatoire'); return; }
  const vals={sujet:d.sujet.trim(), constat:d.constat.trim(), action:d.action.trim(), resp:d.resp.trim(), due:d.due||''};
  if(f.id){ const a=ch.actions.find(x=>x.id===f.id); if(a) Object.assign(a, vals); }
  else ch.actions.push(Object.assign({id:uid(), status:'todo', urgent:false, createdAt:new Date().toISOString()}, vals));
  const wasNew=!f.id; ui.form=null; commit(ch);
  toast(wasNew?'Action ajoutée':'Action modifiée');
}

board.addEventListener('click', e=>{
  const b=e.target.closest('[data-act]');
  if(!b){ if(ui.openMenu && !e.target.closest('.menu')){ ui.openMenu=null; render(); } return; }
  const act=b.dataset.act;
  if(act==='openadd'){ openAdd(); return; }
  if(act==='saveform'){ submitForm(); return; }
  if(act==='cancelform'){ ui.form=null; render(); return; }
  if(act==='addnote'){ addNote(b.closest('.card')); return; }
  const card=b.closest('.card'); const ch=card&&findCh(card.dataset.ch); if(!ch) return;
  const li=b.closest('.act'); const a=li&&ch.actions.find(x=>x.id===li.dataset.a);
  const nl=b.closest('.nt-item'); const nt=nl&&(ch.notes||[]).find(x=>x.id===nl.dataset.n);
  if(act!=='menu') ui.openMenu=null;
  switch(act){
    case 'openform': openForm(ch,null); break;
    case 'editact': if(a) openForm(ch,a); break;
    case 'status': if(!a) break; a.status=NEXT[a.status]; a.doneAt = a.status==='done' ? new Date().toISOString() : null; commit(ch); break;
    case 'urgent': if(!a) break; a.urgent=!a.urgent; commit(ch); break;
    case 'delact': if(!a) break; ch.actions.splice(ch.actions.indexOf(a),1); commit(ch); toast('Action supprimée'); break;
    case 'rename': ui.renaming=ch.id; drafts['ren-'+ch.id]=ch.name; render(); { const el=board.querySelector(`[data-key="ren-${ch.id}"]`); if(el){ el.focus(); el.select(); } } break;
    case 'menu': ui.openMenu=ui.openMenu===ch.id?null:ch.id; ui.confirmDel=null; render(); break;
    case 'collapse': ui.collapsed[ch.id]=!ui.collapsed[ch.id]; if(!ui.collapsed[ch.id]) delete ui.collapsed[ch.id]; saveUi(); render(); break;
    case 'togglenotes': { const open=ui.notesOpen[ch.id]!==undefined?!!ui.notesOpen[ch.id]:(ch.notes||[]).length>0; ui.notesOpen[ch.id]=!open; saveUi(); render(); if(!open){ const el=board.querySelector(`[data-key="note-${ch.id}"]`); if(el) el.focus(); } break; }
    case 'editnote': if(!nt) break; if(ui.editingNote) finishNoteEdit(true); ui.editingNote=nt.id; ui.editingNoteCh=ch.id; drafts['nedit-'+nt.id]=nt.text; render(); { const el=board.querySelector(`[data-key="nedit-${nt.id}"]`); if(el){ el.focus(); el.select(); } } break;
    case 'delnote': if(!nt) break; ch.notes=ch.notes.filter(x=>x.id!==nt.id); commit(ch); toast('Note supprimée'); break;
    case 'note2act': {
      if(!nt) break;
      const lines=nt.text.split(/\n+/).map(x=>x.trim()).filter(Boolean);
      ch.notes=ch.notes.filter(x=>x.id!==nt.id);
      ch.actions.push({id:uid(), sujet:(lines[0]||'Action').slice(0,120), constat:lines.slice(1).join(' – '), action:'', resp:'', due:'', status:'todo', urgent:false, createdAt:new Date().toISOString()});
      commit(ch); toast('Note transformée en action'); break; }
    case 'move': { const k=b.dataset.co; if(!COMPANIES[k]) break; ch.company=k; const cs=COMPANIES[k].chefs; if(!cs.includes(ch.chef)) ch.chef = cs.length===1?cs[0]:''; if(ui.form&&ui.form.ch===ch.id) ui.form=null; commit(ch); toast(`${ch.name} déplacé vers ${COMPANIES[k].name}`); break; }
    case 'up': swap(ch,-1); break;
    case 'down': swap(ch,1); break;
    case 'cleardone': { const n=ch.actions.filter(x=>x.status==='done').length; ch.actions=ch.actions.filter(x=>x.status!=='done'); commit(ch); toast(`${n} action${n>1?'s':''} retirée${n>1?'s':''}`); break; }
    case 'askdel': ui.confirmDel=ch.id; render(); break;
    case 'canceldel': ui.confirmDel=null; render(); break;
    case 'del': ui.confirmDel=null; chantiers=chantiers.filter(c=>c.id!==ch.id); if(ui.form&&ui.form.ch===ch.id) ui.form=null; render(); removeCh(ch.id); toast(`Chantier ${ch.name} supprimé`); break;
  }
});
board.addEventListener('input', e=>{
  const t=e.target;
  if(t.dataset && t.dataset.f && ui.form){ ui.form.d[t.dataset.f]=t.value; }
  const k=t.dataset&&t.dataset.key; if(k && !t.dataset.f) drafts[k]=t.value;
  if(t.tagName==='TEXTAREA') grow(t);
});
board.addEventListener('change', e=>{
  const t=e.target;
  if(t.dataset && t.dataset.f && ui.form){ ui.form.d[t.dataset.f]=t.value; return; }
  if(t.dataset && t.dataset.crew){ const ch=findCh(t.closest('.card').dataset.ch); if(!ch) return; ch[t.dataset.crew]=t.value; commit(ch); toast(t.dataset.crew==='chef'?'Chef de chantier mis à jour':'Conducteur de travaux mis à jour'); }
});
function addNote(card){
  const ch=card&&findCh(card.dataset.ch); const inp=card&&card.querySelector('[data-role="addnote"]');
  if(!ch||!inp) return;
  const text=inp.value.trim(); if(!text){ inp.focus(); return; }
  inp.value=''; delete drafts['note-'+ch.id];
  if(!Array.isArray(ch.notes)) ch.notes=[];
  ch.notes.push({id:uid(), text, createdAt:new Date().toISOString()});
  ui.notesOpen[ch.id]=true; if(ui.collapsed[ch.id]) delete ui.collapsed[ch.id]; saveUi();
  commit(ch);
  const el=board.querySelector(`[data-key="note-${ch.id}"]`); if(el) el.focus();
}
document.addEventListener('keydown', e=>{
  const el=e.target, r=el&&el.dataset&&el.dataset.role;
  if(r==='rename'){ if(e.key==='Enter'){ e.preventDefault(); finishRename(true); } else if(e.key==='Escape') finishRename(false); return; }
  if(r==='editnote'){ if(e.key==='Escape') finishNoteEdit(false); else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); finishNoteEdit(true); } return; }
  if(r==='addnote'){ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); addNote(el.closest('.card')); } return; }
  if(el&&el.dataset&&el.dataset.f){
    if(e.key==='Escape'){ ui.form=null; render(); }
    else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey||el.tagName==='INPUT')){ e.preventDefault(); submitForm(); }
    return;
  }
  if(e.key==='Escape' && ui.openMenu){ ui.openMenu=null; render(); }
});
board.addEventListener('focusout', e=>{
  const r=e.target.dataset&&e.target.dataset.role;
  if(r==='rename') setTimeout(()=>{ if(ui.renaming && document.activeElement!==e.target) finishRename(true); },0);
  if(r==='editnote') setTimeout(()=>{ if(ui.editingNote && document.activeElement!==e.target) finishNoteEdit(true); },0);
});
document.addEventListener('click', e=>{ if(ui.openMenu && !e.target.closest('.card')){ ui.openMenu=null; render(); } });

/* Barre d'outils */
$('#search').addEventListener('input', e=>{ ui.q=e.target.value; render(); });
$('#respFilter').addEventListener('change', e=>{ ui.resp=e.target.value; render(); });
$('#condFilter').addEventListener('change', e=>{ ui.cond=e.target.value; render(); });
$('#chefFilter').addEventListener('change', e=>{ ui.chef=e.target.value; render(); });
$('#tabs').addEventListener('click', e=>{
  const b=e.target.closest('[data-co]'); if(!b || b.dataset.co===ui.company) return;
  ui.company=b.dataset.co; ui.cond=''; ui.chef=''; ui.resp=''; ui.form=null; ui.openMenu=null; ui.confirmDel=null; ui.renaming=null;
  saveUi(); render(); window.scrollTo({top:0});
});
document.querySelectorAll('.seg button').forEach(b=>b.addEventListener('click',()=>{
  ui.filter=b.dataset.filter; document.querySelectorAll('.seg button').forEach(x=>x.setAttribute('aria-pressed', x===b)); render();
}));

/* Ajout chantier */
function openAdd(){ $('#pdfPanel').hidden=true; $('#addChPanel').hidden=false; $('#newChName').focus(); }
$('#btnAddCh').addEventListener('click',()=>{ const p=$('#addChPanel'); if(p.hidden) openAdd(); else p.hidden=true; });
$('#cancelAddCh').addEventListener('click',()=>{ $('#addChPanel').hidden=true; });
function submitCh(){ const v=$('#newChName').value; if(!v.trim()){ $('#newChName').focus(); return; } addChantier(v); $('#newChName').value=''; $('#addChPanel').hidden=true; }
$('#addChGo').addEventListener('click', submitCh);
$('#newChName').addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.isComposing){ e.preventDefault(); submitCh(); } });

/* ---------- Export PDF (paysage) ---------- */
const pdfSel=new Set(); const pdfInit={};
function renderPicks(){
  const base=inCo();
  if(!pdfInit[ui.company] && base.length){ base.forEach(c=>pdfSel.add(c.id)); pdfInit[ui.company]=true; }
  $('#pdfPicks').innerHTML = base.length ? base.map(c=>`<label class="pick"><input type="checkbox" data-pick="${c.id}" ${pdfSel.has(c.id)?'checked':''}> ${esc(c.name)}</label>`).join('') : '<span class="note">Aucun chantier à exporter.</span>';
}
$('#pdfPicks').addEventListener('change', e=>{ const id=e.target.dataset.pick; if(!id) return; e.target.checked?pdfSel.add(id):pdfSel.delete(id); });
$('#pdfAll').addEventListener('click',()=>{ inCo().forEach(c=>pdfSel.add(c.id)); renderPicks(); });
$('#pdfNone').addEventListener('click',()=>{ pdfSel.clear(); renderPicks(); });
$('#btnPdf').addEventListener('click',()=>{ const p=$('#pdfPanel'); $('#addChPanel').hidden=true; p.hidden=!p.hidden; if(!p.hidden){ renderPicks(); $('#pdfMsg').textContent=''; $('#pdfMsg').className='note'; } });
$('#pdfCancel').addEventListener('click',()=>{ $('#pdfPanel').hidden=true; });

const clean = s => String(s==null?'':s).replace(/[\u2018\u2019\u02bc]/g,"'").replace(/[\u201c\u201d\u00ab\u00bb]/g,'"').replace(/[\u2013\u2014]/g,'-').replace(/\u2026/g,'...').replace(/[\u00a0\u202f]/g,' ').replace(/\u2192/g,'->').replace(/[^\x00-\xFF\u0152\u0153\u20AC]/g,'');

function buildPdf(list, includeDone, pageBreak, includeNotes){
  const co=COMPANIES[ui.company];
  const doc = new jsPDF({orientation:'landscape', unit:'mm', format:'a4'});
  const W=297, H=210, M=12, CW=W-2*M, FS=8.5, LH=FS*0.3528*1.3;
  doc.setLineHeightFactor(1.3);
  const cols=[{k:'sujet',w:52,t:'Sujet'},{k:'constat',w:66,t:'Constat'},{k:'action',w:66,t:'Action'},{k:'resp',w:30,t:'Responsable'},{k:'due',w:29,t:'Échéance'},{k:'st',w:30,t:'Statut'}];
  let y=M;
  const now=new Date();
  const pick = arr => arr.filter(a=>includeDone||a.status!=='done');
  let open=0, late=0, done=0; list.forEach(c=>c.actions.forEach(a=>{ if(a.status==='done') done++; else { open++; if(isLate(a)) late++; } }));
  doc.setFont('helvetica','bold'); doc.setFontSize(19); doc.setTextColor(28,34,40);
  doc.text('ACTIONS CHANTIERS - '+clean(co.name.toUpperCase()), M, y+6);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(94,106,112);
  doc.text(clean(dateFR(now).replace(/^./,c=>c.toUpperCase())), W-M, y+2.5, {align:'right'});
  doc.text(`${open} ouvertes · ${late} en retard · ${done} faites · ${list.length} chantier${list.length>1?'s':''}`, W-M, y+7, {align:'right'});
  y+=11; doc.setDrawColor(...co.rgb1); doc.setLineWidth(1.4); doc.line(M,y,W-M,y); y+=6;

  const colHeader = () => {
    doc.setFillColor(232,236,232); doc.rect(M,y,CW,6,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(94,106,112);
    let x=M; cols.forEach(c=>{ doc.text(clean(c.t).toUpperCase(), x+2, y+4.1); x+=c.w; });
    y+=6;
  };
  const newPage = () => { doc.addPage(); y=M+2; };
  const need = h => { if(y+h > H-M-6){ newPage(); return true; } return false; };
  const chHeader = (c, cont) => {
    const acts=c.actions, d=acts.filter(a=>a.status==='done').length;
    doc.setFillColor(...co.rgb2); doc.rect(M,y,CW,8,'F'); doc.setFillColor(...co.rgb1); doc.rect(M,y,2.4,8,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(255,255,255);
    doc.text(clean(c.name.toUpperCase())+(cont?' (suite)':''), M+5, y+5.5);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text(`${d}/${acts.length} faites`, W-M-3, y+5.5, {align:'right'});
    const crew=[c.conducteur&&('Conducteur : '+c.conducteur), c.chef&&('Chef de chantier : '+c.chef)].filter(Boolean).join('   |   ');
    if(crew){ doc.setFontSize(8.5); doc.text(clean(crew), W-M-30, y+5.5, {align:'right'}); }
    y+=8;
  };

  list.forEach((c,ci)=>{
    const acts=sortActs(pick(c.actions));
    if(ci>0){ if(pageBreak) newPage(); else if(y > H-M-40) newPage(); else y+=6; }
    chHeader(c,false); colHeader();
    if(!acts.length){
      doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.setTextColor(120,128,132);
      doc.text(c.actions.length?'Toutes les actions sont faites.':'Aucune action.', M+2, y+5); y+=9;
    }
    acts.forEach(a=>{
      doc.setFont('helvetica','normal'); doc.setFontSize(FS);
      const cells={
        sujet: doc.splitTextToSize(clean(a.sujet||'-'), cols[0].w-4),
        constat: doc.splitTextToSize(clean(a.constat||'-'), cols[1].w-4),
        action: doc.splitTextToSize(clean(a.action||'-'), cols[2].w-4),
        resp: doc.splitTextToSize(clean(a.resp||'-'), cols[3].w-4),
        due: [a.due?clean(fmtDue(a.due)):'-'].concat(a.status!=='done'&&a.due&&relDue(a)?[clean(relDue(a))]:[]),
        st: [STATUS[a.status]].concat(a.urgent&&a.status!=='done'?['URGENT']:[])
      };
      const n=Math.max(...Object.values(cells).map(x=>x.length));
      const h=n*LH+3.4;
      if(y+h > H-M-6){ newPage(); chHeader(c,true); colHeader(); }
      if(a.urgent && a.status!=='done'){ doc.setFillColor(200,70,13); doc.rect(M,y,0.9,h,'F'); }
      let x=M;
      cols.forEach(col=>{
        const lines=cells[col.k];
        const isDone=a.status==='done';
        let rgb=isDone?[140,146,150]:[28,34,40];
        doc.setFont('helvetica', col.k==='sujet'?'bold':'normal'); doc.setFontSize(FS);
        if(col.k==='due' && isLate(a)) rgb=[180,35,24];
        doc.setTextColor(rgb[0],rgb[1],rgb[2]);
        doc.text(lines, x+2, y+LH+0.6);
        if(col.k==='st'){
          // 1re ligne statut en couleur
          const sc = a.status==='done'?[46,122,76]:a.status==='doing'?[31,111,178]:[94,106,112];
          doc.setTextColor(sc[0],sc[1],sc[2]); doc.setFont('helvetica','bold'); doc.text(lines[0], x+2, y+LH+0.6);
          if(lines[1]){ doc.setTextColor(200,70,13); doc.setFontSize(7.5); doc.text(lines[1], x+2, y+LH*2+0.6); }
        }
        if(col.k==='due' && lines[1] && isLate(a)){ doc.setFont('helvetica','bold'); doc.setTextColor(180,35,24); doc.text(lines[1], x+2, y+LH*2+0.6); }
        x+=col.w;
      });
      y+=h;
      doc.setDrawColor(215,220,215); doc.setLineWidth(0.2); doc.line(M,y,W-M,y);
    });
    const notes=includeNotes?(c.notes||[]):[];
    if(notes.length){
      need(14); y+=3;
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(107,90,18); doc.text('NOTES', M+2, y+2); y+=6;
      notes.forEach(n=>{
        doc.setFont('helvetica','normal'); doc.setFontSize(9);
        const lines=doc.splitTextToSize(clean(n.text), CW-40);
        const h=lines.length*LH+1.6;
        need(h+1);
        doc.setFillColor(107,90,18); doc.circle(M+3.2, y-0.8, 0.7, 'F');
        doc.setTextColor(60,64,68); doc.text(lines, M+8, y);
        doc.setFontSize(7.5); doc.setTextColor(140,146,150); doc.text(clean(shortDate(n.createdAt)), W-M-1, y, {align:'right'});
        y+=h;
      });
    }
  });
  const np=doc.getNumberOfPages();
  for(let i=1;i<=np;i++){ doc.setPage(i); doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(140,146,150);
    doc.text(clean(co.full)+' - Suivi des actions chantiers', M, H-7); doc.text(`Page ${i}/${np}`, W-M, H-7, {align:'right'}); }
  return doc;
}
$('#pdfGo').addEventListener('click', async ()=>{
  const msg=$('#pdfMsg'); msg.className='note';
  const list=inCo().filter(c=>pdfSel.has(c.id));
  if(!list.length){ msg.textContent='Sélectionne au moins un chantier.'; msg.className='note err'; return; }
    const btn=$('#pdfGo'); btn.disabled=true; msg.textContent='Préparation du PDF…';
  try{
    const doc=buildPdf(list, $('#pdfDone').checked, $('#pdfBreak').checked, $('#pdfNotes').checked);
    const d=new Date(), stamp=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const fname=`Actions_${COMPANIES[ui.company].name}_${stamp}.pdf`;
    if(Capacitor.isNativePlatform()){
      const data = doc.output('datauristring').split(',')[1];
      const r = await Filesystem.writeFile({path:fname, data, directory:Directory.Cache});
      await Share.share({title:fname, url:r.uri, dialogTitle:'Enregistrer ou partager le PDF'});
    } else {
      doc.save(fname);
    }
    msg.textContent='PDF prêt.';
  }catch(e){
    const code=e&&e.code;
    msg.textContent = code==='declined' ? 'Téléchargement annulé.' : code==='rate_limited' ? 'Une demande est déjà ouverte, réessaie dans un instant.' : "L'export n'a pas abouti ("+(code||'erreur')+').';
    if(code!=='declined') msg.className='note err';
  }finally{ btn.disabled=false; }
});

init();
})();
