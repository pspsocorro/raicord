RC.rtc = {};

RC.rtc.createTile = (peerId,name) => {
  let tile = RC.$('peer-'+peerId);
  if (tile) return tile;
  tile = document.createElement('article');
  tile.className='participant-tile';
  tile.id='peer-'+peerId;
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-placeholder"><div class="avatar huge">${RC.escape(RC.initial(name))}</div></div>
    <div class="tile-topline"><span class="connection-pill connecting">conectando</span></div>
    <div class="tile-footer"><strong>${RC.escape(name||'Usuário')}</strong><div class="tile-icons"><span class="peer-mic">🔇</span><span class="peer-video"></span></div></div>`;
  RC.els.videoGrid.appendChild(tile);
  RC.updateEmpty();
  return tile;
};

RC.rtc.updateTile = (member) => {
  const tile = RC.$('peer-'+member.peerId);
  if (!tile) return;
  tile.classList.toggle('screen',!!member.screen);
  tile.querySelector('.tile-placeholder')?.classList.toggle('hidden',!!(member.camera||member.screen));
  const mic = tile.querySelector('.peer-mic');
  const video = tile.querySelector('.peer-video');
  if (mic) mic.textContent = member.mic ? '🎙' : '🔇';
  if (video) video.textContent = member.screen ? '🖥' : member.camera ? '📷' : '';
};

RC.rtc.setBadge = (peerId,status) => {
  const badge = RC.$('peer-'+peerId)?.querySelector('.connection-pill');
  if (!badge) return;
  badge.className='connection-pill';
  if (status==='connected' || status==='completed') {
    badge.classList.add('connected'); badge.textContent='conectado';
  } else if (status==='failed') {
    badge.textContent='falha RTC';
  } else {
    badge.classList.add('connecting');
    badge.textContent=status==='disconnected'?'reconectando':'conectando';
  }
  RC.updateRtcBadge();
};

RC.rtc.syncPeer = async (peer,audioTrack=null,videoTrack=undefined) => {
  if (audioTrack === null) audioTrack = await RC.media.outgoingAudioTrack();
  if (videoTrack === undefined) videoTrack = RC.media.currentVideoTrack();
  await peer.audio.sender.replaceTrack(audioTrack || null);
  await peer.video.sender.replaceTrack(videoTrack || null);

  if (videoTrack) {
    try {
      const params = peer.video.sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      const screen = RC.state.screenEnabled;
      params.degradationPreference = screen ? 'maintain-resolution' : 'balanced';
      params.encodings[0].maxBitrate = screen
        ? (RC.els.qualitySelect.value==='1080p60' ? 12000000 : 8000000)
        : 4500000;
      params.encodings[0].maxFramerate = screen && RC.els.qualitySelect.value==='1080p60' ? 60 : 30;
      await peer.video.sender.setParameters(params);
    } catch (error) {
      console.debug('Sender params:',error);
    }
  }
};

RC.rtc.syncAll = async () => {
  const audioTrack = await RC.media.outgoingAudioTrack(true);
  const videoTrack = RC.media.currentVideoTrack();
  await Promise.all([...RC.state.peers.values()].map(peer=>RC.rtc.syncPeer(peer,audioTrack,videoTrack)));
};

RC.rtc.createPeer = async (peerId,name,initiator=false) => {
  if (RC.state.peers.has(peerId)) return RC.state.peers.get(peerId);

  const pc = new RTCPeerConnection({
    iceServers:RC.config.iceServers,
    iceCandidatePoolSize:4,
    bundlePolicy:'max-bundle'
  });
  const audio = pc.addTransceiver('audio',{direction:'sendrecv'});
  const video = pc.addTransceiver('video',{direction:'sendrecv'});
  const stream = new MediaStream();
  const tile = RC.rtc.createTile(peerId,name);
  const media = tile.querySelector('video');
  media.srcObject = stream;
  media.muted = RC.state.deafened;

  const peer = {
    peerId,name,pc,audio,video,remoteStream:stream,initiator,
    makingOffer:false,ignoreOffer:false,restartTimer:null
  };
  RC.state.peers.set(peerId,peer);

  pc.onicecandidate = ({candidate}) => {
    if (candidate) RC.socket.emit('signal',{to:peerId,data:{type:'candidate',candidate}});
  };
  pc.onicecandidateerror = (event) => console.warn('ICE',event.errorCode,event.errorText,event.url);

  pc.ontrack = ({track}) => {
    if (!stream.getTracks().some(t=>t.id===track.id)) stream.addTrack(track);
    media.srcObject=stream;
    media.play().catch(()=>{});
  };

  const connectionChanged = () => {
    const status = pc.connectionState || pc.iceConnectionState;
    RC.rtc.setBadge(peerId,status);
    if (status==='failed') {
      clearTimeout(peer.restartTimer);
      peer.restartTimer=setTimeout(()=>{
        if (peer.initiator) RC.rtc.makeOffer(peerId,true);
        else RC.socket.emit('signal',{to:peerId,data:{type:'restart-request'}});
      },700);
    }
    if (status==='closed') RC.rtc.closePeer(peerId);
  };
  pc.onconnectionstatechange=connectionChanged;
  pc.oniceconnectionstatechange=connectionChanged;

  await RC.rtc.syncPeer(peer);
  RC.updateRtcBadge();
  return peer;
};

RC.rtc.makeOffer = async (peerId,iceRestart=false) => {
  const peer=RC.state.peers.get(peerId);
  if (!peer || peer.makingOffer) return;
  try {
    peer.makingOffer=true;
    const offer=await peer.pc.createOffer({iceRestart});
    await peer.pc.setLocalDescription(offer);
    RC.socket.emit('signal',{to:peerId,data:{type:'description',description:peer.pc.localDescription}});
  } catch (error) {
    console.warn('Offer:',error);
  } finally {
    peer.makingOffer=false;
  }
};

RC.rtc.handleSignal = async ({from,name,data}) => {
  const peer=await RC.rtc.createPeer(from,name||'Usuário',false);
  try {
    if (data.type==='restart-request') {
      peer.initiator=true;
      return RC.rtc.makeOffer(from,true);
    }
    if (data.type==='description') {
      const description=data.description;
      const collision=description.type==='offer' && (peer.makingOffer || peer.pc.signalingState!=='stable');
      const polite=RC.socket.id>from;
      peer.ignoreOffer=!polite && collision;
      if (peer.ignoreOffer) return;
      if (collision && polite && peer.pc.signalingState!=='stable') {
        await peer.pc.setLocalDescription({type:'rollback'});
      }
      await peer.pc.setRemoteDescription(description);
      if (description.type==='offer') {
        await RC.rtc.syncPeer(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        RC.socket.emit('signal',{to:from,data:{type:'description',description:peer.pc.localDescription}});
      }
      return;
    }
    if (data.type==='candidate' && data.candidate) {
      try { await peer.pc.addIceCandidate(data.candidate); }
      catch (error) { if (!peer.ignoreOffer) throw error; }
    }
  } catch (error) {
    console.warn('Signal:',error);
  }
};

RC.rtc.closePeer = (peerId) => {
  const peer=RC.state.peers.get(peerId);
  if (!peer) return;
  clearTimeout(peer.restartTimer);
  try { peer.pc.close(); } catch {}
  RC.state.peers.delete(peerId);
  RC.$('peer-'+peerId)?.remove();
  RC.updateEmpty();
  RC.updateRtcBadge();
};

RC.rtc.closeAll = () => [...RC.state.peers.keys()].forEach(RC.rtc.closePeer);
