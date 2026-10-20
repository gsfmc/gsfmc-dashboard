const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const htmlText = (value) => esc(value).replace(/\n/g, '<br>');
let state = null;
let pendingImport = null;
let editingId = null;
let viewingId = null;
let account = null;
let staffSession = null;
let staffPeople = [];
let staffAccounts = [];
try { staffSession = sessionStorage.getItem('workplan-staff-session'); } catch {}
const apiBase=String(window.WORKPLAN_API_BASE||'').replace(/\/+$/,'');
function staffId(dept,owner){return JSON.stringify([String(dept||'').trim().normalize('NFC'),String(owner||'').replace(/\s+/gu,'').normalize('NFC')]);}
function linkAccess(){
  const match=/^#(edit|view)\/([a-f0-9]{64})(?:\/(overview|departments|tasks|safety))?$/i.exec(location.hash);
  const token=match?.[2]||'';
  const kind=match?.[1]?.toLowerCase()||'';
  const readonly=new URLSearchParams(location.search).get('view')==='readonly';
  return {token,kind,mode:kind==='edit'&&!readonly?'edit':'view'};
}
let {token:editToken,kind:linkKind,mode:accessMode}=linkAccess();
// Remove the old browser-wide capability; access now belongs to the URL.
try { sessionStorage.removeItem('workplan-edit-token'); } catch {}

function canEdit(task) {
  return accessMode==='edit'&&(account?.role === 'admin' || (account?.role === 'staff' && account.staffId === staffId(task.dept,task.owner)));
}
function applyAccount() {
  if (!account) return;
  if(accessMode==='view')account={...account,role:'viewer',departments:[]};
  $('accountLabel').textContent = `${account.username} · ${account.role === 'admin' ? '관리자' : account.role === 'staff' ? '담당자' : '조회 전용'}`;
  for (const id of ['uploadBtn', 'backupBtn', 'safetyBtn']) $(id).hidden = account.role !== 'admin';
  $('manageStaffBtn').hidden = account.role !== 'admin';
  $('staffLogoutBtn').hidden = account.role !== 'staff';
  $('addTaskBtn').hidden = account.role !== 'admin';
  const editable=accessMode==='edit'&&account.role!=='viewer';
  $('accessBanner').classList.toggle('editing',editable);
  $('accessModeTitle').textContent=editable?'편집 모드':'보기 전용';
  $('accessModeDescription').textContent=account.role==='staff'?'본인 담당 과제만 수정할 수 있습니다.':editable?'업무를 등록하고 수정할 수 있습니다.':'조회와 인쇄만 가능합니다. 업무를 수정하려면 직원용 링크를 이용하세요.';
  // A read-only URL must use its own viewer token. Never offer a link that
  // only masks an editor token with a query parameter.
  $('viewOnlyLink').hidden=true;
  $('taskAccessBadge').textContent=account.role==='staff'?'본인 과제만 수정':editable?'편집 가능':'보기 전용';
  document.querySelector('.panel-caption').textContent=editable?'업무명을 누르면 추진계획과 이행현황을 확인하고 수정할 수 있습니다.':'업무명을 누르면 추진계획과 이행현황을 확인할 수 있습니다.';
  document.querySelector('.action-note').textContent=editable?'부서별 과제를 선택해 세부내용을 확인하고 수정할 수 있습니다.':'부서별 과제를 선택해 세부내용을 확인할 수 있습니다.';
  if($('detailDialog').open){const task=state?.tasks.find(task=>task.id===viewingId);$('detailEdit').hidden=!task||!canEdit(task);}
  for(const link of document.querySelectorAll('a[data-section]'))link.setAttribute('href',linkKind&&editToken?`#${linkKind}/${editToken}/${link.dataset.section}`:`#${link.dataset.section}`);
}
async function refreshLinkAccess(){
  const next=linkAccess();if(next.token===editToken&&next.kind===linkKind&&next.mode===accessMode)return;
  editToken=next.token;linkKind=next.kind;accessMode=next.mode;account={username:'방문자',role:'viewer',departments:[]};applyAccount();
  for(const id of ['taskDialog','uploadDialog','safetyDialog'])if($(id).open)$(id).close();
  $('detailEdit').hidden=true;
  const mode=accessMode,token=editToken;
  try{await initializeAccess();}catch(err){toast(err.message);}
}

async function api(method, url, payload) {
  if(accessMode==='view'&&!['GET','HEAD'].includes(method))throw new Error('보기 전용 링크에서는 수정할 수 없습니다.');
  if(!apiBase)throw new Error('데이터 서버 주소가 설정되지 않았습니다.');
  if(!editToken)throw new Error('조회용 또는 편집용 링크로 접속해 주세요.');
  const headers = {'X-Workplan-Mode':accessMode,...(payload?{'Content-Type':'application/json'}:{})};
  headers['X-Workplan-Link-Token']=editToken;
  if(staffSession)headers['X-Workplan-Staff-Session']=staffSession;
  const response = await fetch(`${apiBase}${url}`, { method, headers, body:payload ? JSON.stringify(payload) : undefined });
  const result = await response.json();
  if (!response.ok){const error=new Error(result.error || '처리 중 오류가 발생했습니다.');error.status=response.status;throw error;}
  return result;
}
function toast(message) { const el=$('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(el.timer); el.timer=setTimeout(()=>el.classList.remove('show'),3300); }
function statusOf(value) { const s=String(value||'').trim(); if (/완료/.test(s)) return '완료'; if (/보류|중단/.test(s)) return '보류'; if (/진행|추진중/.test(s)) return '진행중'; if (/예정|계획/.test(s)) return '예정'; return '미입력'; }
function statusClass(value) { return ({'완료':'done','진행중':'active','예정':'soon','보류':'late','미입력':'blank'})[value]||'blank'; }
function dateOnly(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value||'')) ? String(value) : ''; }
function isLate(task) { const d=dateOnly(task.dueDate); return Boolean(d && task.status !== '완료' && d < new Date().toISOString().slice(0,10)); }
function pct(task) { const n=Number(task.pct); return Number.isFinite(n) ? Math.max(0,Math.min(100,n)) : 0; }
function scoreText(task) {
  const number=value=>Number.isFinite(Number(value))?Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2}):'0';
  return `${number(task.score)} / ${number(task.points)}점`;
}
const activityTypes={content:'추진내용',period:'기간',date:'추진일자',target:'대상',place:'장소',people:'인원',cooperation:'협조사항',note:'진행사항 / 비고'};
function taskActivities(task){
  if(Array.isArray(task.activities))return task.activities;
  const fields=Object.keys(activityTypes).filter(type=>String(task[type]??'').trim()).map(type=>({type,value:String(task[type])}));
  const documents=taskDocuments(task);
  return fields.length||documents.length?[{fields,documents}]:[];
}
function activityDetails(task){
  const activities=taskActivities(task);
  return activities.length?activities.map((item,index)=>`<section class="activity-detail"><h3 class="activity-detail-title">추진 내역 ${index+1}</h3>${item.fields.map(field=>detailField(activityTypes[field.type]||field.type,field.value)).join('')}${documentField({documents:item.documents})}</section>`).join(''):'<p class="detail-empty">입력된 이행현황이 없습니다.</p>';
}
function detailField(label,value){return String(value??'').trim()?`<section class="detail-field"><h3>${esc(label)}</h3><div>${htmlText(value)}</div></section>`:'';}
function safeDocumentUrl(value){try{const url=new URL(String(value||''));return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}}
function taskDocuments(task){return Array.isArray(task.documents)&&task.documents.length?task.documents:(task.docnum?[{number:task.docnum,url:''}]:[]);}
function documentField(task){
  const documents=taskDocuments(task);
  if(!documents.length)return '';
  return `<section class="detail-field"><h3>관련 문서</h3><div class="document-links">${documents.map(item=>{
    const label=esc(item.number||'문서 보기'),url=safeDocumentUrl(item.url);
    return url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}<span aria-hidden="true">↗</span></a>`:`<span>${label}</span>`;
  }).join('')}</div></section>`;
}
function openDetail(task){
  viewingId=task.id;
  $('detailEdit').hidden = !canEdit(task);
  const source=task.plan_source||'';
  const plan=task.detail_content||'';
  const headline=`<div class="detail-kicker">${esc(task.dept)} · ${esc(task.owner||'담당자 미입력')}</div><h2>${esc(task.task)}</h2><div class="detail-chips"><span class="badge ${statusClass(task.status)}">${esc(task.status||'미입력')}</span><span>이행률 <b>${pct(task)}%</b></span><span>자체평가 <b>${esc(scoreText(task))}</b></span>${task.category?`<span>${esc(task.category)}</span>`:''}</div>`;
  const meta=[['경영목표',task.goal],['전략과제',task.strategy],['계획상 과제명',task.hwp_task&&task.hwp_task!==task.task?task.hwp_task:''],['자료 출처',source]].filter(([,v])=>v);
  $('detailBody').innerHTML=`${headline}${meta.length?`<div class="detail-meta">${meta.map(([k,v])=>`<div><small>${esc(k)}</small><strong>${esc(v)}</strong></div>`).join('')}</div>`:''}<div class="detail-section-label">추진계획</div>${detailField('추진배경 / 목적',task.background)}${detailField('추진근거',task.basis)}${detailField('계획 주요내용',plan)}${detailField('추진일정',task.schedule)}${detailField('소요예산',task.budget)}${detailField('기대효과',task.effect)}${task.detailed_plan?`<details class="detail-raw"><summary>한글 세부계획 원문 전체 보기</summary><div>${htmlText(task.detailed_plan)}</div></details>`:''}<div class="detail-section-label">과제 이행현황</div>${activityDetails(task)}${task.dueDate?`<div class="detail-meta"><div><small>마감일</small><strong>${esc(task.dueDate)}</strong></div></div>`:''}`;
  $('detailDialog').showModal();
}

function render() {
  if (!state) return;
  const tasks=state.tasks||[];
  const dataLabel=state.mode==='demo'?'예시 데이터 표시 중':`과제 관리 · ${tasks.length}건`;
  $('dataStatus').textContent=dataLabel; $('dataStatusMirror').textContent=dataLabel;
  $('kpiTotal').textContent=tasks.length; $('kpiActive').textContent=tasks.filter(t=>t.status==='진행중').length; $('kpiDone').textContent=tasks.filter(t=>t.status==='완료').length; $('kpiLate').textContent=tasks.filter(isLate).length;
  const deptMap=new Map();
  for(const t of tasks){ const d=deptMap.get(t.dept)||{count:0,sum:0,done:0}; d.count++; d.sum+=pct(t); if(t.status==='완료')d.done++; deptMap.set(t.dept,d); }
  const averageRaw=tasks.length?tasks.reduce((sum,t)=>sum+pct(t),0)/tasks.length:0;
  const average=averageRaw.toFixed(1);
  const completed=tasks.filter(t=>t.status==='완료').length;
  $('headerChips').innerHTML=`<div class="header-chip"><b>${tasks.length}</b><small>전체 과제</small></div><div class="header-chip"><b>${deptMap.size}</b><small>참여 부서</small></div><div class="header-chip"><b>${completed}</b><small>완료 과제</small></div>`;
  $('gaugeMount').innerHTML=`<div class="gauge-ring" style="--gauge:${average}%"><div class="gauge-inner"><strong>${average}%</strong><span>평균 이행률</span></div></div>`;
  $('gaugeFootRate').textContent=`${completed} / ${tasks.length}건`;
  const statusGroups=[['완료','#1f8a5f'],['진행중','#0e6e7c'],['예정','#9ebdc1'],['보류','#c97a2b'],['미입력','#dce4e2']];
  const statusCounts=statusGroups.map(([name,color])=>({name,color,count:tasks.filter(t=>t.status===name).length}));
  $('statusStrip').innerHTML=`<div class="status-head"><span>진행상태 구성</span><b>${completed}건 완료</b></div><div class="stack-bar">${statusCounts.map(x=>`<span style="width:${tasks.length?x.count/tasks.length*100:0}%;background:${x.color}"></span>`).join('')}</div><div class="status-legend">${statusCounts.map(x=>`<span><i style="background:${x.color}"></i>${x.name} ${x.count}</span>`).join('')}</div>`;
  const orderedDepts=[...deptMap].sort((a,b)=>a[0].localeCompare(b[0],'ko'));
  $('deptList').innerHTML=orderedDepts.length ? orderedDepts.map(([name,v])=>{const rate=(v.sum/v.count).toFixed(1);const below=v.sum/v.count<averageRaw;return `<div class="dept-row ${below?'below-average':''}" data-dept="${esc(name)}" title="${esc(name)} 과제 보기"><div class="dept-name">${esc(name)} <small>${v.count}개 과제</small></div><div class="progress-track"><div class="progress-fill" style="width:${rate}%"></div><i class="avg-marker" style="left:${average}%"></i></div><div class="dept-pct">${rate}%</div></div>`;}).join('') : '<div class="empty">등록된 부서가 없습니다.</div>';
  $('deptCards').innerHTML=orderedDepts.length ? orderedDepts.map(([name,v])=>{const rate=(v.sum/v.count).toFixed(1);const below=v.sum/v.count<averageRaw;return `<button class="dept-card ${below?'below-average':''}" type="button" data-dept="${esc(name)}" aria-label="${esc(name)} 평균 이행률 ${rate}%, 추진과제 ${v.count}건, 완료 ${v.done}건"><span class="dept-card-head"><b>${esc(name)}</b></span><span class="dept-donut" style="--rate:${rate}%"><span class="dept-donut-inner"><strong>${rate}%</strong><em>평균 이행률</em></span></span><small>추진과제 ${v.count}건 · 완료 ${v.done}건</small></button>`;}).join('') : '<div class="empty">등록된 부서가 없습니다.</div>';
  const depts=[...new Set(tasks.map(t=>t.dept).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
  const oldDept=$('deptFilter').value; $('deptFilter').innerHTML='<option value="">전체 부서</option>'+depts.map(d=>`<option value="${esc(d)}">${esc(d)}</option>`).join(''); $('deptFilter').value=depts.includes(oldDept)?oldDept:'';
  renderRows();
  const incident=(state.incidents||[]).find(x=>x.year==='2026');
  $('safetyCount').textContent=incident?incident.count:'—'; $('safetyCumulative').textContent=incident?incident.cumulative:'—'; $('safetyNote').textContent=incident?.note||'2026년 안전사고 현황을 입력해 주세요.';
  $('lastUpdated').textContent=state.updatedAt?`마지막 저장 ${new Date(state.updatedAt).toLocaleString('ko-KR')}`:'';
}
function renderRows(){
  if(!state)return;
  const overallAverage=state.tasks.length?state.tasks.reduce((sum,t)=>sum+pct(t),0)/state.tasks.length:0;
  const query=$('searchInput').value.trim().toLocaleLowerCase('ko'); const dept=$('deptFilter').value,status=$('statusFilter').value;
  const filtered=state.tasks.filter(t=>(!dept||t.dept===dept)&&(!status||t.status===status)&&(!query||[t.task,t.hwp_task,t.dept,t.owner,t.strategy,t.content,t.background,...taskActivities(t).flatMap(a=>a.fields.map(f=>f.value))].some(v=>String(v||'').toLocaleLowerCase('ko').includes(query))));
  $('taskRows').innerHTML=filtered.length?filtered.slice(0,150).map(t=>`<tr class="${pct(t)<overallAverage?'below-average':''}" data-task-id="${esc(t.id)}"><td>${esc(t.dept)}<div class="td-muted">${esc(t.owner||'담당자 미입력')}</div></td><td><button type="button" class="task-open" data-open="${esc(t.id)}"><span class="task-name">${esc(t.task)}<small>${t.hwp_task&&t.hwp_task!==t.task?`최종계획: ${esc(t.hwp_task)}`:esc(t.strategy||t.content||'')}</small></span></button></td><td><span class="badge ${isLate(t)?'late':statusClass(t.status)}">${isLate(t)?'지연':esc(t.status||'미입력')}</span></td><td><div class="row-progress"><div class="progress-track"><div class="progress-fill" style="width:${pct(t)}%"></div></div><b>${pct(t)}%</b></div></td><td><b>${esc(scoreText(t))}</b></td><td>${esc(t.dueDate||'—')}</td><td><button type="button" class="edit-link" data-open="${esc(t.id)}">상세보기 →</button></td></tr>`).join(''):'<tr><td colspan="7"><div class="empty">조건에 맞는 업무가 없습니다.</div></td></tr>';
  $('taskFoot').textContent=`${filtered.length}건 표시${filtered.length>150?' · 목록은 앞의 150건만 표시':''} · 전체 ${state.tasks.length}건`;
  for(const card of $('deptCards').querySelectorAll('[data-dept]'))card.classList.toggle('active',Boolean(dept&&card.dataset.dept===dept));
}

function xmlChildren(node, local) { return [...node.getElementsByTagName('*')].filter(x=>x.localName===local); }
function xmlFirst(node, local) { return xmlChildren(node,local)[0]; }
function xmlFromZip(zip, filename) { return zip.file(filename)?.async('string').then(s=>new DOMParser().parseFromString(s,'application/xml')); }
function normalizeZipPath(target) { return target.startsWith('/') ? target.slice(1) : 'xl/'+target.replace(/^\.\//,''); }
function excelDate(raw) { if(!/^\d+(\.\d+)?$/.test(String(raw))) return raw; const d=new Date(Date.UTC(1899,11,30)+Math.floor(Number(raw))*86400000); return d.toISOString().slice(0,10); }
async function parseWorkbook(file){
  if(!/\.xlsx$/i.test(file.name))throw new Error('.xlsx 파일을 선택해 주세요.');
  const zip=await JSZip.loadAsync(await file.arrayBuffer());
  const workbook=await xmlFromZip(zip,'xl/workbook.xml'); const rels=await xmlFromZip(zip,'xl/_rels/workbook.xml.rels');
  if(!workbook||!rels)throw new Error('엑셀 통합문서 구조를 읽을 수 없습니다.');
  const relMap=new Map(xmlChildren(rels,'Relationship').map(r=>[r.getAttribute('Id'),normalizeZipPath(r.getAttribute('Target')||'')]));
  const stringsXml=await xmlFromZip(zip,'xl/sharedStrings.xml');
  const shared=stringsXml?xmlChildren(stringsXml,'si').map(si=>xmlChildren(si,'t').map(t=>t.textContent).join('')):[];
  let rows=[], checked=0, warnings=[];
  for(const sheet of xmlChildren(workbook,'sheet')){
    const name=sheet.getAttribute('name')||''; const path=relMap.get(sheet.getAttribute('r:id')||sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id'));
    if(!path||!zip.file(path))continue;
    const doc=await xmlFromZip(zip,path); const rowNodes=xmlChildren(doc,'row');
    const readRow=(row)=>{const out={}; for(const c of [...row.children].filter(x=>x.localName==='c')){const col=/^[A-Z]+/.exec(c.getAttribute('r')||'')?.[0]; if(!col)continue;let v='';if(c.getAttribute('t')==='inlineStr')v=xmlChildren(c,'t').map(x=>x.textContent).join('');else {v=xmlFirst(c,'v')?.textContent??'';if(c.getAttribute('t')==='s')v=shared[Number(v)]??'';}out[col]=v;}return out;};
    const headerNode=rowNodes.find(r=>Number(r.getAttribute('r'))===2); if(!headerNode)continue; const header=readRow(headerNode);
    if(!String(header.E||'').includes('추진과제')||!String(header.G||'').includes('이행현황'))continue;
    checked++; let goal='',strategy='',sheetCount=0;
    for(const rowNode of rowNodes){const num=Number(rowNode.getAttribute('r'));if(num<3)continue;const c=readRow(rowNode);if(c.B)goal=String(c.B).trim();if(c.C)strategy=String(c.C).trim();
      if(!/^\d+(\.0)?$/.test(String(c.A||'').trim())||!String(c.E||'').trim())continue;
      const p=Number(c.H);const percent=Number.isFinite(p)?Math.round(Math.max(0,Math.min(1,p))*100):0;
      rows.push({dept:name,task:String(c.E).trim(),goal,strategy,category:String(c.D||'').trim(),points:c.F===''||c.F===undefined?'':Number(c.F),status:statusOf(c.G),pct:percent,score:c.I===''||c.I===undefined?'':Number(c.I),content:String(c.J||'').trim(),docnum:String(c.K||'').trim(),date:String(c.L||'').trim()?excelDate(String(c.L).trim()):'',note:String(c.M||'').trim()});sheetCount++;
    }
    if(!sheetCount)warnings.push(`${name}: 읽을 과제가 없습니다.`);
  }
  if(!checked||!rows.length)throw new Error('첨부2 양식의 부서별 시트와 추진과제 열을 찾지 못했습니다.');
  return {rows,sheets:checked,warnings};
}

function addDocumentRow(holder,item={}){
  if($('activityRows').querySelectorAll('.document-row').length>=10)return toast('문서 링크는 과제별 최대 10개까지 등록할 수 있습니다.');
  const row=document.createElement('div');row.className='document-row';
  row.innerHTML=`<label>문서번호 / 문서명<input class="document-number" maxlength="240" placeholder="문서번호 또는 문서명" value="${esc(item.number||'')}"></label><label>문서 링크<input class="document-url" type="url" maxlength="2000" placeholder="복사한 문서 주소 붙여넣기" value="${esc(item.url||'')}"></label><button type="button" class="document-remove" aria-label="이 문서 삭제">삭제</button>`;
  holder.append(row);updateActivityControls();
}
function updateActivityControls(){
  const cards=[...$('activityRows').children],documents=$('activityRows').querySelectorAll('.document-row').length;
  $('activityCount').textContent=`${cards.length}개 내역`;$('addActivityBtn').disabled=cards.length>=30;
  cards.forEach((card,index)=>{
    card.querySelector('.activity-title').textContent=`추진 내역 ${index+1}`;
    card.querySelector('.activity-up').disabled=index===0;
    card.querySelector('.activity-down').disabled=index===cards.length-1;
    card.querySelector('.document-count').textContent=`이 과제의 문서 ${documents} / 10`;
    card.querySelector('.add-document').disabled=documents>=10;
    const used=[...card.querySelectorAll('.activity-field')].map(field=>field.dataset.type),select=card.querySelector('.field-type');
    const selected=select.value;
    select.innerHTML=Object.entries(activityTypes).filter(([type])=>!used.includes(type)).map(([type,label])=>`<option value="${type}">${label}</option>`).join('');
    if([...select.options].some(option=>option.value===selected))select.value=selected;
    select.disabled=!select.options.length;card.querySelector('.add-field').disabled=select.disabled;
  });
}
function addActivityField(card,type,value=''){
  if(!Object.hasOwn(activityTypes,type)||card.querySelector(`.activity-field[data-type="${type}"]`))return;
  const row=document.createElement('div');row.className='activity-field';row.dataset.type=type;
  const multiline=['content','cooperation','note'].includes(type);
  row.innerHTML=`<label>${activityTypes[type]}${multiline?`<textarea maxlength="20000" placeholder="${activityTypes[type]} 입력">${esc(value)}</textarea>`:`<input maxlength="2000" placeholder="${type==='date'?'예: 2026. 10. 16.':type==='period'?'예: 2026. 10. ~ 12.':type==='people'?'예: 25명':activityTypes[type]+' 입력'}" value="${esc(value)}">`}</label><button type="button" class="field-remove" aria-label="${activityTypes[type]} 항목 삭제">×</button>`;
  card.querySelector('.activity-fields').append(row);updateActivityControls();
}
function addActivity(item={fields:[{type:'content',value:''}],documents:[]}){
  if($('activityRows').children.length>=30)return toast('추진 내역은 최대 30개까지 추가할 수 있습니다.');
  const card=document.createElement('section');card.className='activity-card';
  card.innerHTML=`<div class="activity-head"><h3 class="activity-title"></h3><div class="activity-actions"><button type="button" class="activity-up" aria-label="이 내역을 위로 이동">↑</button><button type="button" class="activity-down" aria-label="이 내역을 아래로 이동">↓</button><button type="button" class="activity-remove">내역 삭제</button></div></div><div class="activity-fields"></div><div class="field-toolbar"><select class="field-type" aria-label="추가할 항목 선택"></select><button type="button" class="button subtle add-field">＋ 항목 추가</button></div><div class="activity-documents"><div class="activity-document-heading"><strong>관련 문서</strong><span class="document-count"></span></div><div class="document-rows"></div><button type="button" class="button subtle add-document">＋ 문서번호 · 링크 추가</button></div>`;
  $('activityRows').append(card);
  for(const field of item.fields||[])addActivityField(card,field.type,field.value);
  for(const document of item.documents||[])addDocumentRow(card.querySelector('.document-rows'),document);
  updateActivityControls();return card;
}
function formActivities(){
  return [...$('activityRows').children].map(card=>({
    fields:[...card.querySelectorAll('.activity-field')].map(row=>({type:row.dataset.type,value:row.querySelector('input,textarea').value.trim()})).filter(field=>field.value),
    documents:[...card.querySelectorAll('.document-row')].map(row=>({number:row.querySelector('.document-number').value.trim(),url:row.querySelector('.document-url').value.trim()})).filter(item=>item.number||item.url)
  })).filter(item=>item.fields.length||item.documents.length);
}
function updateScore(){
  const form=$('taskForm'),score=form.elements.score,points=form.elements.points;
  score.setCustomValidity(score.value!==''&&points.value!==''&&Number(score.value)>Number(points.value)?'취득점수는 배점보다 클 수 없습니다.':'');
  $('scorePreview').textContent=scoreText({score:score.value,points:points.value});
}
function openTask(task){
  if (task && !canEdit(task)) return toast('이 업무를 수정할 권한이 없습니다.');
  if (!task && account?.role !== 'admin') return toast('업무 등록은 관리자만 할 수 있습니다.');
  editingId=task?.id||null; $('taskDialogTitle').textContent=task?'업무 수정':'업무 등록'; $('taskEditHint').textContent=task?`${task.dept} · ${task.task}`:'새 업무의 기본 정보와 추진계획을 입력하세요.'; const f=$('taskForm');f.reset();
  const fields=['dept','owner','task','status','pct','dueDate','score','points','background','detail_content','schedule','basis','budget','effect'];
  for(const key of fields)if(f.elements[key]) f.elements[key].value=task?.[key]??'';
  $('activityRows').replaceChildren();
  const activities=task?taskActivities(task):[];
  for(const item of activities)addActivity(item);
  if(!activities.length)addActivity();
  updateScore();
  f.elements.dept.readOnly = account?.role === 'staff';
  f.elements.owner.readOnly = account?.role === 'staff';
  $('taskDialog').showModal();
}
function printReport(){
  const tasks=state.tasks||[]; const incident=(state.incidents||[]).find(x=>x.year==='2026');
  const groups=new Map();for(const t of tasks){if(!groups.has(t.dept))groups.set(t.dept,[]);groups.get(t.dept).push(t);}
  const field=(label,value)=>value?`<dt>${label}</dt><dd>${htmlText(value)}</dd>`:'';
  $('printReport').innerHTML=`<div class="print-cover"><div class="org">광산구시설관리공단</div><h1>2026년 주요업무계획 추진 및 이행현황</h1><div class="meta"><div>전체 과제&nbsp;&nbsp; ${tasks.length}건</div><div>참여 부서&nbsp;&nbsp; ${groups.size}개</div><div>완료 과제&nbsp;&nbsp; ${tasks.filter(t=>t.status==='완료').length}건</div></div><p class="print-note">${state.mode==='demo'?'※ 예시 자료 · 실제 내부 현황이 아닙니다.':'주요업무계획 관리 자료'}</p></div><section class="print-section"><h2>1. 부서별 주요업무계획</h2>${groups.size?[...groups].map(([dept,items])=>`<h3>${esc(dept)}</h3>${items.map(t=>`<div class="print-task"><strong>${esc(t.task)}</strong> · ${esc(t.status)} · 이행률 ${pct(t)}% · 자체평가 ${esc(scoreText(t))}<dl>${field('담당자',t.owner)}${field('추진배경',t.background)}${field('계획 주요내용',t.detail_content)}${field('추진일정',t.schedule)}${taskActivities(t).map((a,i)=>field('추진 내역 '+(i+1),a.fields.map(f=>`${activityTypes[f.type]||f.type}: ${f.value}`).join('\n'))+field('관련 문서',a.documents.map(d=>`${d.number}${d.url?' · '+d.url:''}`).join('\n'))).join('')}${field('마감일',t.dueDate)}</dl></div>`).join('')}`).join(''):'<p>등록된 과제가 없습니다.</p>'}</section><section class="print-section"><h2>2. 안전사고 발생현황</h2><p>2026년 발생 ${incident?incident.count:'미입력'}건 · 누계 ${incident?incident.cumulative:'미입력'}건</p><p>${htmlText(incident?.note||'')}</p></section>`;
  window.print();
}

async function showStaffLogin(){
  staffSession=null;
  try { sessionStorage.removeItem('workplan-staff-session'); } catch {}
  staffPeople=await api('GET','/api/staff-directory');
  const depts=[...new Set(staffPeople.map(person=>person.dept))].sort((a,b)=>a.localeCompare(b,'ko'));
  $('staffLoginDept').innerHTML='<option value="">부서 선택</option>'+depts.map(dept=>`<option value="${esc(dept)}">${esc(dept)}</option>`).join('');
  $('staffLoginOwner').innerHTML='<option value="">담당자 선택</option>';
  $('staffLoginError').textContent='';
  if(!$('staffLoginDialog').open)$('staffLoginDialog').showModal();
}

async function initializeAccess(){
  try{
    const me=await api('GET','/api/me');
    const nextState=await api('GET','/api/state');
    account=me;state=nextState;applyAccount();render();
    if($('staffLoginDialog').open)$('staffLoginDialog').close();
  }catch(error){
    if(linkKind==='edit'&&error.status===401){
      state=null;account=null;await showStaffLogin();return;
    }
    throw error;
  }
}

function renderStaffAdmin(){
  const configured=staffAccounts.filter(person=>person.configured).length;
  $('staffAdminSummary').textContent=`담당자 ${staffAccounts.length}명 · 비밀번호 설정 ${configured}명 · 미설정 ${staffAccounts.length-configured}명`;
  const query=$('staffAdminSearch').value.trim().toLocaleLowerCase('ko');
  const visible=staffAccounts.map((person,index)=>({...person,index})).filter(person=>!query||`${person.dept} ${person.owner}`.toLocaleLowerCase('ko').includes(query));
  $('staffAccountRows').innerHTML=visible.length?visible.map(person=>`<div class="staff-account-row" data-index="${person.index}">
    <div><strong>${esc(person.dept)} · ${esc(person.owner)}</strong><small>담당 과제 ${person.taskCount}건</small></div>
    <div><strong>${person.configured?'설정 완료':'미설정'}</strong><small>${person.passwordUpdatedAt?new Date(person.passwordUpdatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'비밀번호 필요'}</small></div>
    <input type="password" autocomplete="new-password" minlength="10" maxlength="128" aria-label="${esc(person.dept)} ${esc(person.owner)} 새 비밀번호" placeholder="새 비밀번호 10자 이상">
    <div class="staff-account-actions"><button type="button" class="button primary staff-password-save">${person.configured?'변경':'설정'}</button><button type="button" class="button ghost staff-password-disable" ${person.configured?'':'disabled'}>차단</button></div>
  </div>`).join(''):'<div class="empty">조건에 맞는 담당자가 없습니다.</div>';
}

function renderStaffAudit(rows){
  const names=new Map(staffAccounts.map(person=>[person.id,`${person.dept} · ${person.owner}`]));
  const labels={login_success:'로그인 성공',login_failed:'로그인 실패',logout:'로그아웃',task_updated:'과제 수정',password_set:'관리자가 비밀번호 설정·변경',password_disabled:'관리자가 접속 차단'};
  $('staffAuditRows').innerHTML=rows.length?rows.map(row=>{
    const task=state?.tasks.find(item=>item.id===row.task_id);
    const who=names.get(row.staff_id)||'현재 과제에 없는 담당자';
    return `<div class="staff-audit-row"><time>${esc(new Date(row.created_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))}</time><strong>${esc(who)}</strong><span>${esc(labels[row.event]||row.event)}${task?' · '+esc(task.task):''}</span></div>`;
  }).join(''):'<div class="empty">기록된 접속 이력이 없습니다.</div>';
}

async function refreshStaffAdmin(){
  const [people,audit]=await Promise.all([api('GET','/api/admin/staff'),api('GET','/api/admin/staff-audit')]);
  staffAccounts=people;renderStaffAdmin();renderStaffAudit(audit);
}

async function openStaffAdmin(){
  await refreshStaffAdmin();
  $('staffAdminDialog').showModal();
}

function bind(){
  $('staffLoginDialog').addEventListener('cancel',event=>event.preventDefault());
  $('staffLoginDept').onchange=()=>{
    const people=staffPeople.filter(person=>person.dept===$('staffLoginDept').value);
    $('staffLoginOwner').innerHTML='<option value="">담당자 선택</option>'+people.map(person=>`<option value="${esc(person.owner)}">${esc(person.owner)}</option>`).join('');
  };
  $('staffLoginForm').onsubmit=async event=>{
    event.preventDefault();
    const form=event.target,submit=form.querySelector('[type="submit"]');
    submit.disabled=true;$('staffLoginError').textContent='';
    try{
      const result=await api('POST','/api/staff-login',Object.fromEntries(new FormData(form)));
      staffSession=result.session;
      try { sessionStorage.setItem('workplan-staff-session',staffSession); } catch {}
      form.elements.password.value='';
      await initializeAccess();
    }catch(error){$('staffLoginError').textContent=error.message;form.elements.password.value='';}
    finally{submit.disabled=false;}
  };
  $('staffLogoutBtn').onclick=async()=>{
    try{await api('POST','/api/staff-logout');}catch{}
    staffSession=null;
    try{sessionStorage.removeItem('workplan-staff-session');}catch{}
    location.reload();
  };
  $('manageStaffBtn').onclick=()=>openStaffAdmin().catch(error=>toast(error.message));
  $('staffAdminClose').onclick=()=>$('staffAdminDialog').close();
  $('staffAdminSearch').oninput=renderStaffAdmin;
  $('staffAccountRows').onclick=async event=>{
    const button=event.target.closest('button'),row=button?.closest('.staff-account-row');
    if(!row)return;
    const person=staffAccounts[Number(row.dataset.index)];
    if(!person)return;
    if(button.matches('.staff-password-save')){
      const input=row.querySelector('input'),password=input.value;
      if([...password].length<10){toast('비밀번호는 10자 이상으로 입력해 주세요.');input.focus();return;}
      button.disabled=true;
      try{await api('PUT','/api/admin/staff-password',{dept:person.dept,owner:person.owner,password});input.value='';await refreshStaffAdmin();toast(`${person.dept} ${person.owner} 비밀번호를 설정했습니다.`);}
      catch(error){toast(error.message);}finally{button.disabled=false;}
    }
    if(button.matches('.staff-password-disable')){
      if(!confirm(`${person.dept} ${person.owner}의 접속을 차단하고 로그인 상태를 해제할까요?`))return;
      button.disabled=true;
      try{await api('DELETE','/api/admin/staff-password',{dept:person.dept,owner:person.owner});await refreshStaffAdmin();toast(`${person.owner}의 접속을 차단했습니다.`);}
      catch(error){toast(error.message);}finally{button.disabled=false;}
    }
  };
  for(const link of document.querySelectorAll('.top-nav a,.nav-link')){
    const section=link.getAttribute('href').slice(1);link.dataset.section=section;
    link.addEventListener('click',event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();history.pushState(null,'',link.getAttribute('href'));$(section)?.scrollIntoView({behavior:'smooth',block:'start'});});
  }
  window.addEventListener('hashchange',refreshLinkAccess);window.addEventListener('popstate',refreshLinkAccess);
  $('uploadBtn').onclick=()=>$('fileInput').click();
  $('fileInput').onchange=async(e)=>{const file=e.target.files?.[0]; if(!file)return;try{const parsed=await parseWorkbook(file);pendingImport={fileName:file.name,rows:parsed.rows};$('uploadPreview').innerHTML=`<b>${esc(file.name)}</b><br>${parsed.sheets}개 부서 시트 · ${parsed.rows.length}개 과제 확인<br>적용하면 대시보드 전체 과제 목록이 이 자료로 갱신됩니다.${parsed.warnings.length?'<br>'+parsed.warnings.map(esc).join('<br>'):''}`;$('uploadDialog').showModal();}catch(err){toast(err.message);}e.target.value='';};
  $('uploadCancel').onclick=()=>$('uploadDialog').close();
  $('uploadConfirm').onclick=async()=>{if(!pendingImport)return;try{const result=await api('POST','/api/import',pendingImport);state=result.state;pendingImport=null;$('uploadDialog').close();render();toast(`${result.count}건을 반영했습니다. 한글 최종본 세부계획 ${result.hwpMatched}건 연결.`);}catch(err){toast(err.message);}};
  $('addTaskBtn').onclick=()=>openTask(null);$('taskCancel').onclick=()=>$('taskDialog').close();$('taskClose').onclick=()=>$('taskDialog').close();
  $('addActivityBtn').onclick=()=>{const card=addActivity();card?.querySelector('textarea')?.focus();};
  $('activityRows').onclick=(event)=>{
    const button=event.target.closest('button'),card=button?.closest('.activity-card');if(!card)return;
    if(button.matches('.add-field')){addActivityField(card,card.querySelector('.field-type').value);card.querySelector('.activity-field:last-child input,.activity-field:last-child textarea')?.focus();}
    if(button.matches('.field-remove'))button.closest('.activity-field').remove();
    if(button.matches('.add-document')){addDocumentRow(card.querySelector('.document-rows'));card.querySelector('.document-row:last-child input')?.focus();}
    if(button.matches('.document-remove'))button.closest('.document-row').remove();
    if(button.matches('.activity-remove')){
      const hasContent=[...card.querySelectorAll('input,textarea')].some(input=>input.value.trim());
      if(!hasContent||confirm('이 추진 내역과 연결된 문서를 삭제할까요? 저장할 때 반영됩니다.'))card.remove();
    }
    if(button.matches('.activity-up')&&card.previousElementSibling)card.previousElementSibling.before(card);
    if(button.matches('.activity-down')&&card.nextElementSibling)card.nextElementSibling.after(card);
    updateActivityControls();
  };
  for(const name of ['score','points'])$('taskForm').elements[name].addEventListener('input',updateScore);
  $('detailClose').onclick=()=>$('detailDialog').close();$('detailDone').onclick=()=>$('detailDialog').close();
  $('detailEdit').onclick=()=>{const task=state.tasks.find(x=>x.id===viewingId);$('detailDialog').close();if(task)openTask(task);};
  $('taskRows').onclick=(event)=>{const id=event.target.closest('[data-open]')?.dataset.open||event.target.closest('[data-task-id]')?.dataset.taskId;if(id){const task=state.tasks.find(x=>x.id===id);if(task)openDetail(task);}};
  for(const id of ['deptCards','deptList'])$(id).onclick=(event)=>{const name=event.target.closest('[data-dept]')?.dataset.dept;if(!name)return;$('deptFilter').value=name;renderRows();$('tasks').scrollIntoView({behavior:'smooth',block:'start'});};
  $('taskForm').onsubmit=async(event)=>{event.preventDefault();const form=event.target;updateScore();if(!form.reportValidity())return;const row=Object.fromEntries(new FormData(form));row.pct=Number(row.pct)||0;row.activities=formActivities();const submit=form.querySelector('[type="submit"]');submit.disabled=true;try{const saved=await api(editingId?'PUT':'POST',editingId?`/api/tasks/${encodeURIComponent(editingId)}`:'/api/tasks',row);if(editingId){const i=state.tasks.findIndex(x=>x.id===editingId);state.tasks[i]=saved;}else state.tasks.push(saved);$('taskDialog').close();render();toast('업무를 저장했습니다.');}catch(err){toast(err.message);}finally{submit.disabled=false;}};
  $('safetyBtn').onclick=()=>{const f=$('safetyForm'),row=(state.incidents||[]).find(x=>x.year==='2026');f.elements.count.value=row?.count??'';f.elements.cumulative.value=row?.cumulative??'';f.elements.note.value=row?.note||'';$('safetyDialog').showModal();};$('safetyCancel').onclick=()=>$('safetyDialog').close();
  $('safetyForm').onsubmit=async(e)=>{e.preventDefault();try{const row=await api('PUT','/api/incidents',Object.fromEntries(new FormData(e.target)));state.incidents=state.incidents.filter(x=>x.year!==row.year);state.incidents.push(row);$('safetyDialog').close();render();toast('안전 현황을 저장했습니다.');}catch(err){toast(err.message);}};
  for(const id of ['searchInput','deptFilter','statusFilter'])$(id).addEventListener(id==='searchInput'?'input':'change',renderRows);
  $('resetFilters').onclick=()=>{for(const id of ['searchInput','deptFilter','statusFilter'])$(id).value='';renderRows();};
  $('backupBtn').onclick=async()=>{try{const data=await api('GET','/api/export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='workplan-backup.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(err){toast(err.message);}};$('printBtn').onclick=printReport;
}
bind();
initializeAccess().then(()=>{
  setInterval(async()=>{
    if(!state)return;
    try{const fresh=await api('GET','/api/state');if(fresh.updatedAt!==state.updatedAt){state=fresh;render();}}
    catch(error){if(error.status===401&&linkKind==='edit'){staffSession=null;try{sessionStorage.removeItem('workplan-staff-session');}catch{}location.reload();}}
  },15000);
}).catch(err=>toast(`서버 연결 실패: ${err.message}`));
