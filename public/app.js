const socket = io();

const $ = (id) => document.getElementById(id);
const els = {
  appName:$("appName"), joinOverlay:$("joinOverlay"), joinBtn:$("joinBtn"),
  nameInput:$("nameInput"), roomInput:$("roomInput"), micSelect:$("micSelect"),
  camSelect:$("camSelect"), settingsMicSelect:$("settingsMicSelect"),
  settingsCamSelect:$("settingsCamSelect"), settingsQualitySelect:$("settingsQualitySelect"),
  qualitySelect:$("qualitySelect"), qualityBadge:$("qualityBadge"),
  settingsDialog:$("settingsDialog"), settingsBtn:$("settingsBtn"),
  applySettingsBtn:$("applySettingsBtn"), videoGrid:$("videoGrid"),
  localVideo:$("localVideo"), localPlaceholder:$("localPlaceholder"),
  localTile:$("localTile"), emptyStage:$("emptyStage"), localNameLabel:$("localNameLabel"),
  localStateLabel:$("localStateLabel"), localBigAvatar:$("localBigAvatar"),
  localAvatar:$("localAvatar"), localTileName:$("localTileName"),
  localMicState:$("localMicState"), localCamState:$("localCamState"),
  connectionCard:$("connectionCard"), connectionText:$("connectionText"),
  roomLabel:$("roomLabel"), stageTitle:$("stageTitle"),
  stageSubtitle:$("stageSubtitle"), currentChannelTitle:$("currentChannelTitle"),
  participantCount:$("participantCount"), micBtn:$("micBtn"), camBtn:$("camBtn"),
  screenBtn:$("screenBtn"), deafenBtn:$("deafenBtn"),
  disconnectBtn:$("disconnectBtn"), leaveBtn:$("leaveBtn"),
  muteBtnMini:$("muteBtnMini"), deafenBtnMini:$("deafenBtnMini"),
  audioModeBtn:$("audioModeBtn"), messages:$("messages"),
  chatForm:$("chatForm"), messageInput:$("messageInput"), toast:$("toast")
};

const state = {
  joined:false, roomId:"geral", name:"Paulo",
  iceServers:[{urls:"stun:stun.l.google.com:19302"}],
  micStream:null, camStream:null, screenStream:null,
  micEnabled:true, cameraEnabled:false, screenEnabled:false,
  deafened:false, audioOnly:false, peers:new Map(),
  selectedMicId:"", selectedCamId:""
};

const profiles = {
  "720p30": {width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{ideal:30,max:30}},
  "1080p30": {width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:30,max:30}},
  "1080p60": {width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:60,max:60}}
};

function notify(msg, error){
  els.toast.textContent = msg;
  els.toast.className = "toast show" + (error ? " error" : "");
  clearTimeout(notify.t);
  notify.t = setTimeout(() => els.toast.className = "toast", 2800);
}

function initial(name){ return (name || "U").trim().charAt(0).toUpperCase(); }
function clean(text){ const d=document.createElement("div"); d.textContent=text; return d.innerHTML; }

async function loadConfig(){
  try{
    const r = await fetch("/api/config");
    const c = await r.json();
    state.iceServers = c.iceServers || state.iceServers;
    els.appName.textContent = c.appName || "RaiCord";
    document.title = c.appName || "RaiCord";
  }catch(e){}
}

async function refreshDevices(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try{
    const ds = await navigator.mediaDevices.enumerateDevices();
    const mics = ds.filter(d=>d.kind==="audioinput");
    const cams = ds.filter(d=>d.kind==="videoinput");
    function fill(sel,list,label){
      const old=sel.value; sel.innerHTML="";
      if(!list.length){ const o=document.createElement("option"); o.value=""; o.textContent="Nenhum "+label; sel.appendChild(o); return; }
      list.forEach((d,i)=>{ const o=document.createElement("option"); o.value=d.deviceId; o.textContent=d.label || label+" "+(i+1); sel.appendChild(o); });
      if([...sel.options].some(o=>o.value===old)) sel.value=old;
    }
    [els.micSelect,els.settingsMicSelect].forEach(s=>fill(s,mics,"microfone"));
    [els.camSelect,els.settingsCamSelect].forEach(s=>fill(s,cams,"câmera"));
  }catch(e){}
}

async function ensureMic(){
  if(state.micStream && state.micStream.getAudioTracks()[0]) return state.micStream.getAudioTracks()[0];
  try{
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio:{deviceId:state.selectedMicId?{exact:state.selectedMicId}:undefined,echoCancellation:true,noiseSuppression:true,autoGainControl:true},
      video:false
    });
    const t=state.micStream.getAudioTracks()[0]; t.enabled=state.micEnabled;
    state.selectedMicId=t.getSettings().deviceId || state.selectedMicId;
    await refreshDevices();
    return t;
  }catch(e){ state.micEnabled=false; updateControls(); notify("Microfone indisponível ou sem permissão.",true); return null; }
}

async function ensureCamera(){
  if(state.camStream && state.camStream.getVideoTracks()[0]) return state.camStream.getVideoTracks()[0];
  try{
    state.camStream=await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{deviceId:state.selectedCamId?{exact:state.selectedCamId}:undefined,width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:60}}
    });
    const t=state.camStream.getVideoTracks()[0];
    state.selectedCamId=t.getSettings().deviceId || state.selectedCamId;
    t.onended=()=>{state.cameraEnabled=false; syncAll(); updateControls(); broadcastState();};
    await refreshDevices();
    return t;
  }catch(e){ state.cameraEnabled=false; notify("Câmera indisponível ou sem permissão.",true); return null; }
}

const micTrack=()=>state.micStream?.getAudioTracks()[0] || null;
const camTrack=()=>state.camStream?.getVideoTracks()[0] || null;
const screenTrack=()=>state.screenStream?.getVideoTracks()[0] || null;
const currentVideo=()=>state.screenEnabled?screenTrack():(state.cameraEnabled?camTrack():null);

async function syncPeer(peer){
  await peer.audio.sender.replaceTrack(micTrack());
  await peer.video.sender.replaceTrack(currentVideo());
  const sender=peer.video.sender;
  if(currentVideo()){
    try{
      const p=sender.getParameters(); p.encodings=p.encodings?.length?p.encodings:[{}];
      p.encodings[0].maxBitrate=state.screenEnabled?10000000:4500000;
      p.encodings[0].maxFramerate=state.screenEnabled && els.qualitySelect.value==="1080p60"?60:30;
      await sender.setParameters(p);
    }catch(e){}
  }
}
async function syncAll(){ await Promise.all([...state.peers.values()].map(syncPeer)); }

function addTile(id,name){
  let tile=$("peer-"+id); if(tile) return tile;
  tile=document.createElement("article"); tile.className="video-tile"; tile.id="peer-"+id;
  tile.innerHTML='<video autoplay playsinline></video><div class="video-placeholder"><div class="big-avatar">'+clean(initial(name))+'</div></div><div class="tile-overlay"><span>'+clean(name||"Usuário")+'</span><div class="tile-status"><span class="pmic">🎙</span><span class="pcam">📷</span></div></div>';
  els.videoGrid.appendChild(tile); updateStage(); return tile;
}
function removeTile(id){ $("peer-"+id)?.remove(); updateStage(); }

function updateRemoteState(id,s){
  const tile=$("peer-"+id); if(!tile) return;
  tile.querySelector(".video-placeholder")?.classList.toggle("hidden",!!(s.camera||s.screen));
  tile.classList.toggle("screen",!!s.screen);
  const m=tile.querySelector(".pmic"), c=tile.querySelector(".pcam");
  if(m) m.textContent=s.mic?"🎙":"🔇";
  if(c) c.textContent=s.screen?"🖥":(s.camera?"📷":"🚫");
}

async function createPeer(id,name){
  if(state.peers.has(id)) return state.peers.get(id);
  const pc=new RTCPeerConnection({iceServers:state.iceServers});
  const audio=pc.addTransceiver("audio",{direction:"sendrecv"});
  const video=pc.addTransceiver("video",{direction:"sendrecv"});
  const stream=new MediaStream(), tile=addTile(id,name), vid=tile.querySelector("video");
  vid.srcObject=stream; vid.muted=state.deafened;
  pc.onicecandidate=e=>{ if(e.candidate) socket.emit("signal",{to:id,data:{type:"candidate",candidate:e.candidate}}); };
  pc.ontrack=e=>{ if(!stream.getTracks().some(t=>t.id===e.track.id)) stream.addTrack(e.track); vid.srcObject=stream; vid.play().catch(()=>{}); };
  pc.onconnectionstatechange=()=>{ if(["failed","closed"].includes(pc.connectionState)) closePeer(id); };
  const peer={pc,id,name,audio,video,makingOffer:false,ignoreOffer:false};
  state.peers.set(id,peer); await syncPeer(peer); updateCount(); return peer;
}

async function offer(id){
  const p=await createPeer(id,state.peers.get(id)?.name||"Usuário");
  try{
    p.makingOffer=true; await p.pc.setLocalDescription(await p.pc.createOffer());
    socket.emit("signal",{to:id,data:{type:"description",description:p.pc.localDescription}});
  }finally{ p.makingOffer=false; }
}

async function onSignal(msg){
  const p=await createPeer(msg.from,msg.name||"Usuário"), d=msg.data;
  try{
    if(d.type==="description"){
      const desc=d.description;
      const collision=desc.type==="offer" && (p.makingOffer || p.pc.signalingState!=="stable");
      const polite=socket.id>msg.from; p.ignoreOffer=!polite&&collision; if(p.ignoreOffer) return;
      if(collision&&polite&&p.pc.signalingState!=="stable") await p.pc.setLocalDescription({type:"rollback"});
      await p.pc.setRemoteDescription(desc);
      if(desc.type==="offer"){
        await syncPeer(p); await p.pc.setLocalDescription(await p.pc.createAnswer());
        socket.emit("signal",{to:msg.from,data:{type:"description",description:p.pc.localDescription}});
      }
    }else if(d.type==="candidate" && d.candidate){
      try{ await p.pc.addIceCandidate(d.candidate); }catch(e){ if(!p.ignoreOffer) throw e; }
    }
  }catch(e){ console.warn(e); }
}

function closePeer(id){ const p=state.peers.get(id); if(!p)return; try{p.pc.close();}catch(e){} state.peers.delete(id); removeTile(id); updateCount(); }
function closeAll(){ [...state.peers.keys()].forEach(closePeer); }

function updateCount(){
  const n=1+state.peers.size; els.participantCount.textContent=n+" online";
  els.stageSubtitle.textContent=state.joined?(n+" participante"+(n===1?"":"s")+" · WebRTC"):"Entre na sala para começar";
}
function updateStage(){ els.emptyStage.style.display=(state.peers.size===0&&!state.cameraEnabled&&!state.screenEnabled)?"flex":"none"; }

function updatePreview(){
  let s=null;
  if(state.screenEnabled&&screenTrack()){s=new MediaStream([screenTrack()]);els.localTile.classList.add("screen");}
  else if(state.cameraEnabled&&camTrack()){s=new MediaStream([camTrack()]);els.localTile.classList.remove("screen");}
  else els.localTile.classList.remove("screen");
  els.localVideo.srcObject=s; els.localPlaceholder.classList.toggle("hidden",!!s);
  els.localMicState.textContent=state.micEnabled?"🎙":"🔇";
  els.localCamState.textContent=state.screenEnabled?"🖥":(state.cameraEnabled?"📷":"🚫");
  updateStage();
}

function updateControls(){
  const active=!!micTrack()&&state.micEnabled;
  els.micBtn.textContent=active?"🎙":"🔇"; els.muteBtnMini.textContent=active?"🎙":"🔇";
  els.micBtn.classList.toggle("active",active); els.micBtn.classList.toggle("off",!active);
  els.camBtn.textContent=state.cameraEnabled?"📷":"🚫"; els.camBtn.classList.toggle("active",state.cameraEnabled);
  els.screenBtn.textContent=state.screenEnabled?"🖥 Parar transmissão":"🖥 Compartilhar tela"; els.screenBtn.classList.toggle("active",state.screenEnabled);
  els.deafenBtn.textContent=state.deafened?"🔕":"🎧"; els.deafenBtnMini.textContent=state.deafened?"🔕":"🎧";
  els.deafenBtn.classList.toggle("off",state.deafened); els.audioModeBtn.classList.toggle("active",state.audioOnly);
  updatePreview();
}

function broadcastState(){
  if(state.joined) socket.emit("room-state",{state:{mic:!!micTrack()&&state.micEnabled,camera:state.cameraEnabled,screen:state.screenEnabled}});
}

async function toggleMic(){
  if(!micTrack()){ state.micEnabled=true; await ensureMic(); }
  else { state.micEnabled=!state.micEnabled; micTrack().enabled=state.micEnabled; }
  await syncAll(); updateControls(); broadcastState();
}

async function toggleCam(){
  if(state.screenEnabled){ notify("Pare a transmissão de tela antes de ligar a câmera."); return; }
  if(!state.cameraEnabled){ if(!await ensureCamera()) return; state.cameraEnabled=true; }
  else state.cameraEnabled=false;
  await syncAll(); updateControls(); broadcastState();
}

async function startScreen(){
  try{
    const profile=profiles[els.qualitySelect.value]||profiles["1080p60"];
    state.screenStream=await navigator.mediaDevices.getDisplayMedia({video:profile,audio:true});
    state.screenEnabled=true; const t=screenTrack(); if(t){try{await t.applyConstraints(profile);}catch(e){} t.onended=stopScreen;}
    await syncAll(); updateControls(); broadcastState();
    const s=t?.getSettings()||{}; notify("Tela compartilhada"+(s.width?": "+s.width+"×"+s.height+(s.frameRate?" · "+Math.round(s.frameRate)+" FPS":""):""));
  }catch(e){ if(e.name!=="NotAllowedError") notify("Não foi possível compartilhar a tela.",true); }
}
async function stopScreen(){
  if(!state.screenStream)return; const s=state.screenStream; state.screenStream=null; state.screenEnabled=false;
  s.getTracks().forEach(t=>{try{t.stop();}catch(e){}}); await syncAll(); updateControls(); broadcastState();
}
const toggleScreen=()=>state.screenEnabled?stopScreen():startScreen();

function toggleDeafen(){
  state.deafened=!state.deafened;
  state.peers.forEach((p,id)=>{const v=document.querySelector("#peer-"+id+" video"); if(v)v.muted=state.deafened;});
  updateControls();
}
function toggleAudioOnly(){
  state.audioOnly=!state.audioOnly; document.body.classList.toggle("audio-only",state.audioOnly);
  if(state.audioOnly&&state.cameraEnabled) toggleCam(); updateControls();
}

async function join(room){
  if(!window.isSecureContext&&location.hostname!=="localhost"){ notify("Este recurso precisa de HTTPS.",true); return; }
  state.name=(els.nameInput.value||"Usuário").trim().slice(0,32)||"Usuário";
  state.roomId=(room||els.roomInput.value||"geral").trim().slice(0,64)||"geral";
  state.selectedMicId=els.micSelect.value||state.selectedMicId; state.selectedCamId=els.camSelect.value||state.selectedCamId;
  els.joinBtn.disabled=true; els.joinBtn.textContent="Conectando...";
  await ensureMic();
  socket.emit("join-room",{roomId:state.roomId,name:state.name},async res=>{
    els.joinBtn.disabled=false; els.joinBtn.textContent="Entrar na sala";
    if(!res?.ok){notify(res?.error||"Falha ao entrar.",true);return;}
    state.joined=true; closeAll(); els.joinOverlay.classList.add("hidden"); els.connectionCard.classList.add("visible");
    els.connectionText.textContent="Voz conectada"; els.roomLabel.textContent="🔊 "+state.roomId;
    els.localNameLabel.textContent=state.name; els.localStateLabel.textContent="online";
    els.localBigAvatar.textContent=initial(state.name); els.localAvatar.textContent=initial(state.name);
    els.localTileName.textContent=state.name+" (você)"; els.stageTitle.textContent="Canal "+state.roomId;
    els.currentChannelTitle.textContent=state.roomId; els.messageInput.placeholder="Conversar em #"+state.roomId; els.roomInput.value=state.roomId;
    updateControls(); updateCount(); broadcastState();
    for(const m of res.members||[]){ await createPeer(m.peerId,m.name); await offer(m.peerId); }
    notify("Conectado em #"+state.roomId);
  });
}

function leave(){
  if(state.joined) socket.emit("leave-room"); state.joined=false; closeAll(); if(state.screenEnabled) stopScreen();
  els.connectionCard.classList.remove("visible"); els.localStateLabel.textContent="offline"; els.joinOverlay.classList.remove("hidden"); updateCount();
}

function appendMessage(m){
  const row=document.createElement("div"); row.className="message";
  const time=new Date(m.at||Date.now()).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
  row.innerHTML='<div class="message-avatar">'+clean(initial(m.name))+'</div><div><strong>'+clean(m.name||"Usuário")+'<time>'+time+'</time></strong><p>'+clean(m.text||"")+'</p></div>';
  els.messages.appendChild(row); els.messages.scrollTop=els.messages.scrollHeight;
}

socket.on("signal",onSignal);
socket.on("peer-joined",m=>createPeer(m.peerId,m.name).then(()=>{updateCount();notify(m.name+" entrou.");}));
socket.on("peer-left",m=>{closePeer(m.peerId);notify((m.name||"Usuário")+" saiu.");});
socket.on("room-state",m=>updateRemoteState(m.peerId,m.state));
socket.on("chat-message",appendMessage);
socket.on("disconnect",()=>{if(state.joined){els.connectionText.textContent="Reconectando...";els.localStateLabel.textContent="reconectando";}});

els.joinBtn.onclick=()=>join();
els.micBtn.onclick=toggleMic; els.muteBtnMini.onclick=toggleMic;
els.camBtn.onclick=toggleCam; els.screenBtn.onclick=toggleScreen;
els.deafenBtn.onclick=toggleDeafen; els.deafenBtnMini.onclick=toggleDeafen;
els.audioModeBtn.onclick=toggleAudioOnly; els.disconnectBtn.onclick=leave; els.leaveBtn.onclick=leave;

els.settingsBtn.onclick=async()=>{await refreshDevices(); els.settingsQualitySelect.value=els.qualitySelect.value; els.settingsDialog.showModal();};
els.applySettingsBtn.onclick=async()=>{
  state.selectedMicId=els.settingsMicSelect.value||state.selectedMicId;
  state.selectedCamId=els.settingsCamSelect.value||state.selectedCamId;
  els.qualitySelect.value=els.settingsQualitySelect.value;
  els.qualityBadge.textContent=els.qualitySelect.options[els.qualitySelect.selectedIndex].textContent;
  if(state.micStream){state.micStream.getTracks().forEach(t=>t.stop());state.micStream=null;await ensureMic();}
  if(state.cameraEnabled){state.camStream?.getTracks().forEach(t=>t.stop());state.camStream=null;await ensureCamera();}
  await syncAll(); els.settingsDialog.close(); notify("Configurações aplicadas.");
};

document.querySelectorAll(".voice-channel").forEach(b=>b.onclick=()=>{
  const r=b.dataset.room; document.querySelectorAll(".voice-channel").forEach(x=>x.classList.toggle("active",x===b));
  els.roomInput.value=r; state.joined?join(r):(state.roomId=r,els.stageTitle.textContent="Canal "+r,els.currentChannelTitle.textContent=r);
});
document.querySelectorAll(".text-channel").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".text-channel").forEach(x=>x.classList.remove("active")); b.classList.add("active");
  els.currentChannelTitle.textContent=b.dataset.textChannel; els.messageInput.placeholder="Conversar em #"+b.dataset.textChannel;
});
els.chatForm.onsubmit=e=>{e.preventDefault();const text=els.messageInput.value.trim();if(!text)return;if(!state.joined){notify("Entre numa sala primeiro.");return;}socket.emit("chat-message",{text});els.messageInput.value="";};
els.qualitySelect.onchange=()=>els.qualityBadge.textContent=els.qualitySelect.options[els.qualitySelect.selectedIndex].textContent;

navigator.mediaDevices?.addEventListener?.("devicechange",refreshDevices);

(async()=>{await loadConfig();await refreshDevices();updateControls();})();