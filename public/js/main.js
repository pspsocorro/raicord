RC.joinRoom = async (roomId=RC.els.joinRoomSelect.value,{reconnect=false}={}) => {
  if (!window.isSecureContext && location.hostname!=='localhost') {
    return RC.toast('Microfone e câmera exigem HTTPS.',true);
  }

  const name=(RC.els.nameInput.value||RC.state.name||'Visitante').trim().slice(0,32)||'Visitante';
  const nextRoom=roomId||'geral';
  RC.state.name=name;
  localStorage.setItem('raicord-name',name);
  RC.state.selectedMicId=RC.els.micSelect.value||RC.state.selectedMicId;
  RC.state.selectedCamId=RC.els.camSelect.value||RC.state.selectedCamId;

  if (!reconnect) {
    RC.els.joinBtn.disabled=true;
    RC.els.joinBtn.textContent='Conectando…';
    await RC.media.ensureMic();
  }

  RC.socket.emit('join-room',{roomId:nextRoom,name},async result=>{
    RC.els.joinBtn.disabled=false;
    RC.els.joinBtn.textContent='Entrar no canal de voz';
    if (!result?.ok) return RC.toast(result?.error||'Não consegui entrar no canal.',true);

    RC.state.joined=true;
    RC.state.disconnected=false;
    RC.rtc.closeAll();
    RC.state.members.clear();
    (result.members||[]).forEach(member=>RC.state.members.set(member.peerId,member));
    RC.state.members.set(RC.socket.id,{
      peerId:RC.socket.id,name,roomId:result.roomId,
      ...RC.media.mediaState(),joinedAt:Date.now()
    });
    if (result.directory) RC.state.directory=result.directory;

    RC.applyRoomUi(result.roomId);
    RC.els.joinOverlay.classList.add('hidden');
    RC.els.voiceConnection.classList.remove('hidden');
    RC.els.localNameLabel.textContent=name;
    RC.els.localStatusLabel.textContent='online';
    RC.els.localAvatar.textContent=RC.initial(name);
    RC.els.localBigAvatar.textContent=RC.initial(name);
    RC.els.localTileName.textContent=name+' (você)';
    RC.renderMembers();
    RC.renderChannels();
    RC.renderHistory(result.history||[]);
    RC.media.updateControls();
    RC.updateRtcBadge();
    RC.media.broadcastPresence();

    for (const member of result.members||[]) {
      await RC.rtc.createPeer(member.peerId,member.name,true);
      await RC.rtc.makeOffer(member.peerId,false);
      RC.rtc.updateTile(member);
    }
    if (!reconnect) RC.toast('Você entrou em #'+result.roomId+'.');
  });
};

RC.leaveRoom = () => {
  if (RC.state.joined) RC.socket.emit('leave-room');
  RC.state.joined=false;
  RC.state.disconnected=false;
  RC.rtc.closeAll();
  RC.state.members.clear();
  if (RC.state.screenEnabled) RC.media.stopScreen();
  RC.els.voiceConnection.classList.add('hidden');
  RC.els.localStatusLabel.textContent='offline';
  RC.els.joinOverlay.classList.remove('hidden');
  RC.renderMembers();
  RC.updateRtcBadge();
};

RC.switchRoom = (roomId) => {
  RC.applyRoomUi(roomId);
  if (RC.state.joined) RC.joinRoom(roomId);
};

RC.socket.on('directory',directory=>{
  RC.state.directory=directory||[];
  RC.renderChannels();
});

RC.socket.on('room-users',members=>{
  const list=members||[];
  const liveIds=new Set(list.map(member=>member.peerId));
  [...RC.state.peers.keys()].forEach(peerId=>{
    if (!liveIds.has(peerId)) RC.rtc.closePeer(peerId);
  });
  RC.state.members.clear();
  list.forEach(member=>RC.state.members.set(member.peerId,member));
  RC.renderMembers();
  list.forEach(RC.rtc.updateTile);
});

RC.socket.on('presence-update',member=>{
  RC.state.members.set(member.peerId,member);
  RC.renderMembers();
  RC.rtc.updateTile(member);
});

RC.socket.on('peer-joined',async member=>{
  RC.state.members.set(member.peerId,member);
  await RC.rtc.createPeer(member.peerId,member.name,false);
  RC.renderMembers();
  RC.rtc.updateTile(member);
});

RC.socket.on('peer-left',({peerId})=>{
  RC.state.members.delete(peerId);
  RC.rtc.closePeer(peerId);
  RC.renderMembers();
});

RC.socket.on('signal',RC.rtc.handleSignal);
RC.socket.on('chat-message',RC.appendMessage);

RC.socket.on('disconnect',()=>{
  if (!RC.state.joined) return;
  RC.state.disconnected=true;
  RC.els.localStatusLabel.textContent='reconectando';
  RC.els.rtcBadge.className='rtc-badge warn';
  RC.els.rtcBadge.textContent='Reconectando…';
});

RC.socket.on('connect',()=>{
  if (RC.state.joined && RC.state.disconnected) {
    RC.joinRoom(RC.state.currentRoom,{reconnect:true});
  }
});

RC.els.joinBtn.onclick=()=>RC.joinRoom();
RC.els.leaveBtn.onclick=RC.leaveRoom;
RC.els.disconnectBtn.onclick=RC.leaveRoom;
RC.els.micBtn.onclick=RC.media.toggleMic;
RC.els.miniMicBtn.onclick=RC.media.toggleMic;
RC.els.camBtn.onclick=RC.media.toggleCamera;
RC.els.screenBtn.onclick=()=>RC.state.screenEnabled?RC.media.stopScreen():RC.media.startScreen();
RC.els.deafenBtn.onclick=RC.media.toggleDeafen;
RC.els.audioOnlyBtn.onclick=RC.media.toggleAudioOnly;
RC.els.copyInviteBtn.onclick=RC.copyInvite;
RC.els.emptyInviteBtn.onclick=RC.copyInvite;
RC.els.membersToggle.onclick=()=>RC.els.rightPanel.classList.toggle('mobile-hidden');

RC.els.settingsBtn.onclick=async()=>{
  await RC.refreshDevices();
  RC.els.settingsMicSelect.value=RC.state.selectedMicId||RC.els.settingsMicSelect.value;
  RC.els.settingsCamSelect.value=RC.state.selectedCamId||RC.els.settingsCamSelect.value;
  RC.els.settingsDialog.showModal();
};
RC.els.applySettingsBtn.onclick=RC.media.applySettings;

RC.els.chatForm.onsubmit=event=>{
  event.preventDefault();
  const text=RC.els.messageInput.value.trim();
  if (!text) return;
  if (!RC.state.joined) return RC.toast('Entre em um canal de voz primeiro.');
  RC.socket.emit('chat-message',{text});
  RC.els.messageInput.value='';
};

RC.els.qualitySelect.onchange=()=>{
  if (RC.state.screenEnabled) RC.toast('A nova qualidade será usada na próxima transmissão.');
};

document.querySelectorAll('.tab').forEach(tab=>{
  tab.onclick=()=>{
    document.querySelectorAll('.tab').forEach(item=>item.classList.toggle('active',item===tab));
    RC.els.membersTab.classList.toggle('active',tab.dataset.tab==='members');
    RC.els.chatTab.classList.toggle('active',tab.dataset.tab==='chat');
  };
});

navigator.mediaDevices?.addEventListener?.('devicechange',RC.refreshDevices);
window.addEventListener('beforeunload',()=>RC.socket.emit('leave-room'));

(async()=>{
  await RC.loadConfig();
  const room=new URL(location.href).searchParams.get('room');
  if (room && RC.config.channels.includes(room)) RC.state.currentRoom=room;
  RC.els.nameInput.value=RC.state.name;
  RC.els.joinRoomSelect.value=RC.state.currentRoom;
  RC.applyRoomUi(RC.state.currentRoom);
  await RC.refreshDevices();
  RC.media.updateControls();
  RC.renderMembers();
  RC.renderChannels();
})();
