window.RC = {
  socket: io({ transports: ['websocket', 'polling'] }),
  config: {
    appName: 'RaiCord',
    channels: ['geral', 'gaming', 'musica', 'privado'],
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    hasTurn: false
  },
  state: {
    joined: false,
    disconnected: false,
    currentRoom: 'geral',
    name: localStorage.getItem('raicord-name') || '',
    directory: [],
    members: new Map(),
    peers: new Map(),
    micStream: null,
    cameraStream: null,
    screenStream: null,
    mixedStream: null,
    audioContext: null,
    mixNodes: [],
    micEnabled: true,
    cameraEnabled: false,
    screenEnabled: false,
    deafened: false,
    audioOnly: false,
    selectedMicId: '',
    selectedCamId: ''
  },
  profiles: {
    '720p30': { width:{ideal:1280,max:1280}, height:{ideal:720,max:720}, frameRate:{ideal:30,max:30} },
    '1080p30': { width:{ideal:1920,max:1920}, height:{ideal:1080,max:1080}, frameRate:{ideal:30,max:30} },
    '1080p60': { width:{ideal:1920,max:1920}, height:{ideal:1080,max:1080}, frameRate:{ideal:60,max:60} }
  }
};

RC.$ = (id) => document.getElementById(id);
RC.els = {};
[
  'appName','voiceChannels','voiceConnection','connectedRoomLabel','leaveBtn','localAvatar',
  'localNameLabel','localStatusLabel','miniMicBtn','settingsBtn','copyInviteBtn','emptyInviteBtn',
  'roomTitle','roomSubtitle','rtcBadge','membersToggle','callHeading','callMeta','qualitySelect',
  'audioOnlyBtn','videoGrid','localTile','localVideo','localPlaceholder','localBigAvatar',
  'localConnectionBadge','localTileName','localMicIcon','localVideoIcon','emptyCall','micBtn',
  'camBtn','screenBtn','deafenBtn','disconnectBtn','rightPanel','onlineCount','membersList',
  'membersTab','chatTab','messages','chatForm','messageInput','joinOverlay','nameInput',
  'joinRoomSelect','micSelect','camSelect','joinBtn','settingsDialog','settingsMicSelect',
  'settingsCamSelect','turnStatus','applySettingsBtn','toast'
].forEach((id) => RC.els[id] = RC.$(id));

RC.escape = (value) => {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
};
RC.initial = (name) => String(name || 'U').trim().charAt(0).toUpperCase() || 'U';
RC.roomTitle = (room) => ({geral:'Geral',gaming:'Gaming',musica:'Música',privado:'Privado'})[room]
  || room.charAt(0).toUpperCase() + room.slice(1);

RC.toast = (message, error = false) => {
  RC.els.toast.textContent = message;
  RC.els.toast.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(RC.toast.timer);
  RC.toast.timer = setTimeout(() => RC.els.toast.className = 'toast', 3200);
};

RC.loadConfig = async () => {
  try {
    const response = await fetch('/api/config', { cache:'no-store' });
    if (!response.ok) throw new Error('config');
    RC.config = await response.json();
    document.title = RC.config.appName || 'RaiCord';
    RC.els.appName.textContent = RC.config.appName || 'RaiCord';
    RC.els.turnStatus.textContent = RC.config.hasTurn
      ? 'TURN configurado: fallback por relay ativo.'
      : 'P2P/STUN ativo. Em NAT muito restritivo, um TURN ainda será necessário.';
  } catch (error) {
    console.warn('Config:', error);
  }
};

RC.refreshDevices = async () => {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const cams = devices.filter(d => d.kind === 'videoinput');
    const fill = (select, list, label, selected) => {
      const wanted = selected || select.value;
      select.innerHTML = '';
      if (!list.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Nenhum ' + label;
        select.appendChild(option);
        return;
      }
      list.forEach((device,index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || label + ' ' + (index + 1);
        select.appendChild(option);
      });
      if ([...select.options].some(option => option.value === wanted)) select.value = wanted;
    };
    [RC.els.micSelect,RC.els.settingsMicSelect].forEach(el => fill(el,mics,'microfone',RC.state.selectedMicId));
    [RC.els.camSelect,RC.els.settingsCamSelect].forEach(el => fill(el,cams,'câmera',RC.state.selectedCamId));
  } catch (error) {
    console.warn('Devices:', error);
  }
};

RC.renderChannels = () => {
  const byRoom = new Map(RC.state.directory.map(item => [item.roomId,item.members || []]));
  RC.els.voiceChannels.innerHTML = '';
  RC.config.channels.forEach(roomId => {
    const members = byRoom.get(roomId) || [];
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <button class="channel-row voice-channel ${roomId===RC.state.currentRoom?'active':''}" data-room="${RC.escape(roomId)}">
        <span>🔊</span><span class="channel-main">${RC.escape(RC.roomTitle(roomId))}</span>
        ${members.length ? '<span class="channel-count">'+members.length+'</span>' : ''}
      </button>
      <div class="voice-members">
        ${members.map(m => '<div class="voice-member-mini"><span class="dot"></span><span>'+RC.escape(m.name)+'</span>'+(m.screen?'🖥':m.camera?'📷':'')+'</div>').join('')}
      </div>`;
    wrap.querySelector('.voice-channel').onclick = () => RC.switchRoom(roomId);
    RC.els.voiceChannels.appendChild(wrap);
  });
};

RC.renderMembers = () => {
  const members = [...RC.state.members.values()].sort((a,b) => a.joinedAt - b.joinedAt);
  RC.els.onlineCount.textContent = String(members.length);
  const friends = Math.max(0,members.length-1);
  RC.els.callMeta.textContent = friends + ' amigo' + (friends===1?'':'s') + ' conectado' + (friends===1?'':'s');
  RC.els.membersList.innerHTML = members.map(member => {
    const self = member.peerId === RC.socket.id;
    const detail = member.screen ? 'Transmitindo tela' : member.camera ? 'Câmera ligada' : member.mic ? 'Em chamada' : 'Microfone desligado';
    return `<div class="member-row">
      <div class="avatar-wrap"><div class="avatar small">${RC.escape(RC.initial(member.name))}</div><span class="online-dot"></span></div>
      <div class="member-copy"><strong>${RC.escape(member.name)}${self?' (você)':''}</strong><span>${detail}</span></div>
      <div class="member-media"><span>${member.mic?'🎙':'🔇'}</span><span>${member.screen?'🖥':member.camera?'📷':''}</span></div>
    </div>`;
  }).join('');
};

RC.updateEmpty = () => {
  RC.els.emptyCall.classList.toggle('hidden', RC.state.peers.size>0 || RC.state.cameraEnabled || RC.state.screenEnabled);
};

RC.updateRtcBadge = () => {
  const badge = RC.els.rtcBadge;
  if (!RC.state.joined) {
    badge.className='rtc-badge'; badge.textContent='RTC aguardando'; return;
  }
  if (!RC.state.peers.size) {
    badge.className='rtc-badge ok'; badge.textContent='Pronto para receber'; return;
  }
  const statuses = [...RC.state.peers.values()].map(p => p.pc.connectionState);
  if (statuses.every(s => s === 'connected')) {
    badge.className='rtc-badge ok'; badge.textContent='RTC conectado';
  } else if (statuses.some(s => s === 'failed')) {
    badge.className='rtc-badge warn'; badge.textContent='RTC com falha';
  } else {
    badge.className='rtc-badge warn'; badge.textContent='RTC conectando';
  }
};

RC.applyRoomUi = (roomId) => {
  RC.state.currentRoom = roomId;
  RC.els.roomTitle.textContent = roomId;
  RC.els.roomSubtitle.textContent = 'Canal de voz · ' + RC.roomTitle(roomId);
  RC.els.callHeading.textContent = 'Canal ' + RC.roomTitle(roomId);
  RC.els.connectedRoomLabel.textContent = '# ' + roomId;
  RC.els.messageInput.placeholder = 'Conversar em #' + roomId;
  RC.els.joinRoomSelect.value = roomId;
  RC.renderChannels();
  const url = new URL(location.href);
  url.searchParams.set('room',roomId);
  history.replaceState({},'',url);
};

RC.copyInvite = async () => {
  const url = new URL(location.href);
  url.searchParams.set('room',RC.state.currentRoom);
  try {
    await navigator.clipboard.writeText(url.toString());
    RC.toast('Convite copiado. Manda para seus amigos!');
  } catch {
    window.prompt('Copie este link:',url.toString());
  }
};

RC.renderHistory = (messages) => {
  RC.els.messages.innerHTML = '<div class="welcome-message"><div class="avatar medium">R</div><div><h3>Bem-vindo ao RaiCord</h3><p>Mensagens e eventos aparecem aqui em tempo real.</p></div></div>';
  messages.forEach(RC.appendMessage);
};

RC.appendMessage = (message) => {
  const row = document.createElement('div');
  if (message.type === 'system') {
    row.className='message system';
    row.innerHTML='<p>• '+RC.escape(message.text)+'</p>';
  } else {
    const time = new Date(message.at||Date.now()).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    row.className='message';
    row.innerHTML='<div class="avatar medium">'+RC.escape(RC.initial(message.name))+'</div><div><strong>'+RC.escape(message.name||'Usuário')+'<time>'+time+'</time></strong><p>'+RC.escape(message.text||'')+'</p></div>';
  }
  RC.els.messages.appendChild(row);
  RC.els.messages.scrollTop = RC.els.messages.scrollHeight;
};
