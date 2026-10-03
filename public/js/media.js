RC.media = {};
RC.media.micTrack=()=>RC.state.micStream?.getAudioTracks?.()[0]||null;
RC.media.cameraTrack=()=>RC.state.cameraStream?.getVideoTracks?.()[0]||null;
RC.media.screenVideoTrack=()=>RC.state.screenStream?.getVideoTracks?.()[0]||null;
RC.media.screenAudioTrack=()=>RC.state.screenStream?.getAudioTracks?.()[0]||null;
RC.media.mediaState=()=>({mic:!!RC.media.micTrack()&&RC.state.micEnabled,camera:!!RC.media.cameraTrack()&&RC.state.cameraEnabled,screen:!!RC.media.screenVideoTrack()&&RC.state.screenEnabled});

RC.media.ensureMic=async(force=false)=>{
  const requested=RC.state.selectedMicId||RC.els.micSelect.value||RC.els.settingsMicSelect.value;
  if(force&&RC.state.micStream){RC.state.micStream.getTracks().forEach(t=>t.stop());RC.state.micStream=null}
  if(RC.media.micTrack()){RC.media.micTrack().enabled=RC.state.micEnabled;return RC.media.micTrack()}
  try{
    RC.state.micStream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:requested?{exact:requested}:undefined,echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:{ideal:2}},video:false});
    const track=RC.media.micTrack();track.enabled=RC.state.micEnabled;
    RC.state.selectedMicId=track.getSettings().deviceId||requested||'';
    await RC.refreshDevices();return track;
  }catch(error){RC.state.micEnabled=false;RC.media.updateControls();RC.toast('Não consegui acessar o microfone. Libere a permissão e tente novamente.',true);return null}
};

RC.media.ensureCamera=async(force=false)=>{
  const requested=RC.state.selectedCamId||RC.els.camSelect.value||RC.els.settingsCamSelect.value;
  if(force&&RC.state.cameraStream){RC.state.cameraStream.getTracks().forEach(t=>t.stop());RC.state.cameraStream=null}
  if(RC.media.cameraTrack())return RC.media.cameraTrack();
  try{
    RC.state.cameraStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{deviceId:requested?{exact:requested}:undefined,width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:60}}});
    const track=RC.media.cameraTrack();track.contentHint='motion';
    RC.state.selectedCamId=track.getSettings().deviceId||requested||'';
    track.onended=async()=>{RC.state.cameraEnabled=false;await RC.rtc?.syncAll?.();RC.media.updateControls();RC.media.broadcastPresence()};
    await RC.refreshDevices();return track;
  }catch(error){RC.state.cameraEnabled=false;RC.toast('Não consegui acessar a câmera.',true);return null}
};

RC.media.clearMixed=()=>{
  if(RC.state.mixedStream){RC.state.mixedStream.getTracks().forEach(t=>t.stop());RC.state.mixedStream=null}
  RC.state.mixNodes.forEach(n=>{try{n.disconnect()}catch{}});RC.state.mixNodes=[];
};

RC.media.outgoingAudioTrack=async(force=false)=>{
  const mic=RC.media.micTrack(),screenAudio=RC.media.screenAudioTrack();
  if(!screenAudio){RC.media.clearMixed();return mic}
  if(!mic){RC.media.clearMixed();return screenAudio}
  const cached=RC.state.mixedStream?.getAudioTracks?.()[0];
  if(!force&&cached&&cached.readyState==='live')return cached;
  RC.media.clearMixed();
  const AudioCtx=window.AudioContext||window.webkitAudioContext;if(!AudioCtx)return mic;
  if(!RC.state.audioContext)RC.state.audioContext=new AudioCtx();
  if(RC.state.audioContext.state==='suspended'){try{await RC.state.audioContext.resume()}catch{}}
  const destination=RC.state.audioContext.createMediaStreamDestination();
  [mic,screenAudio].forEach(track=>{const source=RC.state.audioContext.createMediaStreamSource(new MediaStream([track]));source.connect(destination);RC.state.mixNodes.push(source)});
  RC.state.mixedStream=destination.stream;return destination.stream.getAudioTracks()[0]||mic;
};

RC.media.ensureLocalScreenTile=()=>{
  let tile=RC.$('local-screen-tile');
  if(tile)return tile;
  tile=document.createElement('article');
  tile.id='local-screen-tile';
  tile.className='participant-tile screen';
  tile.innerHTML='<video autoplay playsinline muted></video><div class="tile-topline"><span class="connection-pill connected">sua tela</span></div><div class="tile-footer"><strong>'+RC.escape(RC.state.name||'Você')+' — Tela</strong><div class="tile-icons"><span>🖥</span></div></div>';
  RC.els.videoGrid.appendChild(tile);
  return tile;
};

RC.media.updateLocalPreview=()=>{
  const camera=RC.state.cameraEnabled?RC.media.cameraTrack():null;
  RC.els.localVideo.srcObject=camera?new MediaStream([camera]):null;
  RC.els.localTile.classList.remove('screen');
  RC.els.localPlaceholder.classList.toggle('hidden',!!camera);
  RC.els.localMicIcon.textContent=RC.state.micEnabled&&RC.media.micTrack()?'🎙':'🔇';
  RC.els.localVideoIcon.textContent=RC.state.cameraEnabled?'📷':'🚫';

  const screen=RC.state.screenEnabled?RC.media.screenVideoTrack():null;
  let screenTile=RC.$('local-screen-tile');
  if(screen){
    screenTile=RC.media.ensureLocalScreenTile();
    const video=screenTile.querySelector('video');
    video.srcObject=new MediaStream([screen]);
    video.play().catch(()=>{});
  }else if(screenTile){
    screenTile.remove();
  }
  RC.updateEmpty();
};

RC.media.updateControls=()=>{
  const micOn=!!RC.media.micTrack()&&RC.state.micEnabled;
  RC.els.micBtn.textContent=micOn?'🎙':'🔇';RC.els.micBtn.classList.toggle('active',micOn);RC.els.micBtn.classList.toggle('off',!micOn);RC.els.miniMicBtn.textContent=micOn?'🎙':'🔇';
  RC.els.camBtn.textContent=RC.state.cameraEnabled?'📷':'🚫';RC.els.camBtn.classList.toggle('active',RC.state.cameraEnabled);
  RC.els.screenBtn.classList.toggle('active',RC.state.screenEnabled);RC.els.screenBtn.innerHTML=RC.state.screenEnabled?'🖥 <span>Parar transmissão</span>':'🖥 <span>Transmitir tela</span>';
  RC.els.deafenBtn.textContent=RC.state.deafened?'🔕':'🎧';RC.els.deafenBtn.classList.toggle('off',RC.state.deafened);RC.els.audioOnlyBtn.classList.toggle('active',RC.state.audioOnly);RC.media.updateLocalPreview();
};

RC.media.broadcastPresence=()=>{if(RC.state.joined)RC.socket.emit('presence-update',RC.media.mediaState())};

RC.media.toggleMic=async()=>{
  if(!RC.media.micTrack()){RC.state.micEnabled=true;await RC.media.ensureMic()}else{RC.state.micEnabled=!RC.state.micEnabled;RC.media.micTrack().enabled=RC.state.micEnabled}
  await RC.rtc.syncAll();RC.media.updateControls();RC.media.broadcastPresence();
};

RC.media.toggleCamera=async()=>{
  if(!RC.state.cameraEnabled){if(!await RC.media.ensureCamera())return;RC.state.cameraEnabled=true}else RC.state.cameraEnabled=false;
  await RC.rtc.syncAll();await RC.rtc.renegotiateAll();RC.media.updateControls();RC.media.broadcastPresence();
};

RC.media.startScreen=async()=>{
  if(!navigator.mediaDevices?.getDisplayMedia)return RC.toast('Seu navegador não suporta transmissão de tela.',true);
  try{
    const profile=RC.profiles[RC.els.qualitySelect.value]||RC.profiles['1080p60'];
    RC.state.screenStream=await navigator.mediaDevices.getDisplayMedia({video:profile,audio:true});RC.state.screenEnabled=true;
    const track=RC.media.screenVideoTrack();if(track){track.contentHint='detail';try{await track.applyConstraints(profile)}catch{}track.onended=()=>RC.media.stopScreen()}
    await RC.rtc.syncAll();RC.media.broadcastPresence();await RC.rtc.renegotiateAll();RC.media.updateControls();
    const s=track?.getSettings?.()||{};const label=s.width?s.width+'×'+s.height+(s.frameRate?' · '+Math.round(s.frameRate)+' FPS':''):'ativa';RC.toast('Transmissão de tela '+label+'.');
  }catch(error){if(error.name!=='NotAllowedError')RC.toast('Não consegui iniciar a transmissão de tela.',true)}
};

RC.media.stopScreen=async()=>{
  if(!RC.state.screenStream)return;const old=RC.state.screenStream;RC.state.screenStream=null;RC.state.screenEnabled=false;
  old.getTracks().forEach(t=>{t.onended=null;try{t.stop()}catch{}});RC.media.clearMixed();
  await RC.rtc.syncAll();RC.media.broadcastPresence();await RC.rtc.renegotiateAll();RC.media.updateControls();
};

RC.media.toggleDeafen=()=>{
  RC.state.deafened=!RC.state.deafened;RC.state.peers.forEach(peer=>{
    [RC.$('peer-'+peer.peerId),RC.$('peer-screen-'+peer.peerId)].forEach(tile=>{const media=tile?.querySelector('video');if(media)media.muted=RC.state.deafened})
  });RC.media.updateControls();
};

RC.media.toggleAudioOnly=async()=>{
  RC.state.audioOnly=!RC.state.audioOnly;document.body.classList.toggle('audio-only',RC.state.audioOnly);
  if(RC.state.audioOnly&&RC.state.cameraEnabled)await RC.media.toggleCamera();RC.media.updateControls();
};

RC.media.applySettings=async()=>{
  const newMic=RC.els.settingsMicSelect.value,newCam=RC.els.settingsCamSelect.value;
  const micChanged=newMic&&newMic!==RC.state.selectedMicId,camChanged=newCam&&newCam!==RC.state.selectedCamId;
  RC.state.selectedMicId=newMic||RC.state.selectedMicId;RC.state.selectedCamId=newCam||RC.state.selectedCamId;
  if(micChanged)await RC.media.ensureMic(true);if(camChanged&&RC.state.cameraEnabled)await RC.media.ensureCamera(true);
  await RC.rtc.syncAll();RC.media.updateControls();RC.media.broadcastPresence();RC.els.settingsDialog.close();RC.toast('Configurações aplicadas.');
};