// DropWave calls and screen sharing over WebRTC, shared by the PC app and the phone page.
//
// Media goes straight between the two devices on the local network (no servers). Signaling
// rides on DropWave's existing connection: the caller's `send(peerId, msg)` delivers small JSON
// messages and the app feeds whatever arrives into `handle(fromPeer, msg)`.
//
// Messages: ring {call, media, share} -> accept | decline {reason} ; then the caller sends
// offer {sdp}, the callee answers {sdp}; both trickle ice {candidate}; either side sends end.
//   media: 'audio' | 'video' (calls)  or 'screen' (one side shares its screen)
//   share: for 'screen', who shares: 'caller' or 'callee'
//
// Remote control (screen sessions only): a data channel "input" carries control-request /
// control {on} and the viewer's mouse/keyboard events. The sharing side passes input events to
// `onInput` only while it has allowed control.
(function () {
  const RING_TIMEOUT_MS = 45000;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  function createCalls({ send, onChange, onInput }) {
    let s = null; // current session

    const snapshot = () => s && {
      id: s.id, peer: s.peer, media: s.media, share: s.share, role: s.role, status: s.status, reason: s.reason,
      local: s.local, remote: s.remote, muted: s.muted, camOff: s.camOff, sharing: s.sharing(),
      control: s.control, controlAsked: s.controlAsked, controlPending: s.controlPending, dataReady: s.dc?.readyState === 'open',
    };
    const changed = () => onChange(snapshot());
    const msg = (type, extra = {}) => send(s.peer.id, { type, call: s.id, ...extra }).catch((e) => fail(e.message || 'Could not reach the other device'));

    function newSession(peer, media, share, role, id) {
      s = { id: id || uid(), peer, media, share: share || null, role, status: role === 'caller' ? 'ringing-out' : 'ringing-in',
        reason: '', pc: null, local: null, remote: null, pendingIce: [], muted: false, camOff: false, timer: null,
        dc: null, control: false, controlAsked: false, controlPending: false };
      s.sharing = () => s.media === 'screen' && s.share === s.role; // this device shows its screen
      s.timer = setTimeout(() => { if (s && s.status.startsWith('ringing')) { if (s.role === 'caller') msg('end'); finish('No answer'); } }, RING_TIMEOUT_MS);
    }

    async function localMedia() {
      const md = navigator.mediaDevices;
      if (s.media === 'screen') {
        if (!s.sharing()) return null; // just watching
        if (!md?.getDisplayMedia) throw new Error('This device can’t share its screen');
        return md.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      }
      if (!md?.getUserMedia) throw new Error('Calls need the DropWave app (this browser blocks the microphone on plain HTTP)');
      return md.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: s.media === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    }

    function makePc() {
      const pc = new RTCPeerConnection({ iceServers: [] }); // same Wi-Fi: no STUN/TURN, nothing leaves the network
      pc.onicecandidate = (e) => { if (e.candidate) msg('ice', { candidate: e.candidate.toJSON() }); };
      pc.ontrack = (e) => {
        if (!s.remote) s.remote = new MediaStream();
        if (!s.remote.getTracks().includes(e.track)) s.remote.addTrack(e.track);
        changed();
      };
      pc.ondatachannel = (e) => bindDc(e.channel);
      pc.onconnectionstatechange = () => {
        if (!s || s.pc !== pc) return;
        const st = pc.connectionState;
        if (st === 'connected') { s.status = 'live'; changed(); }
        else if (st === 'failed') { msg('end'); finish('Connection lost'); }
      };
      s.pc = pc;
      return pc;
    }

    const INPUT_EVENTS = new Set(['move', 'down', 'up', 'click', 'wheel', 'text', 'key']);
    function bindDc(dc) {
      s.dc = dc;
      const mine = s;
      dc.onopen = () => { if (s === mine) changed(); };
      dc.onclose = () => { if (s === mine) { s.control = false; changed(); } };
      dc.onmessage = (ev) => {
        if (s !== mine) return;
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (!d || typeof d.t !== 'string') return;
        if (INPUT_EVENTS.has(d.t)) { if (s.control && s.sharing()) onInput?.(d); return; } // only when allowed
        if (d.t === 'control-request' && s.sharing()) { s.controlAsked = true; changed(); }
        if (d.t === 'control' && !s.sharing()) { s.control = !!d.on; s.controlPending = false; changed(); }
      };
    }
    function sendData(obj) { if (s?.dc?.readyState === 'open') s.dc.send(JSON.stringify(obj)); }

    function addLocalTracks(pc) {
      if (!s.local) return;
      for (const t of s.local.getTracks()) pc.addTrack(t, s.local);
      // When screen sharing ends from the system bar ("Stop sharing"), end the session.
      s.local.getVideoTracks()[0]?.addEventListener('ended', () => { if (s?.sharing()) end(); });
    }

    async function flushIce() {
      for (const c of s.pendingIce.splice(0)) await s.pc.addIceCandidate(c).catch(() => {});
    }

    function fail(reason) { if (s) { if (s.role === 'caller' || s.status !== 'ringing-in') send(s.peer.id, { type: 'end', call: s.id }).catch(() => {}); finish(reason); } }

    function finish(reason = '') {
      if (!s) return;
      clearTimeout(s.timer);
      s.control = false;
      try { s.dc?.close(); } catch {}
      s.local?.getTracks().forEach((t) => t.stop());
      try { s.pc?.close(); } catch {}
      s.status = 'ended'; s.reason = reason;
      changed();
      const done = s;
      setTimeout(() => { if (s === done) { s = null; onChange(null); } }, reason ? 2500 : 0);
    }

    // ---- public API ----
    async function start(peer, media, share) {
      if (s && s.status !== 'ended') throw new Error('Already in a call');
      newSession(peer, media, share, 'caller');
      changed();
      await msg('ring', { media, share });
    }

    async function accept() {
      if (!s || s.status !== 'ringing-in') return;
      clearTimeout(s.timer);
      s.status = 'connecting'; changed();
      try { s.local = await localMedia(); } catch (e) { return fail(e.message || 'Microphone/camera not available'); }
      changed();
      await msg('accept');
    }

    function decline(reason = 'Declined') {
      if (!s || s.status !== 'ringing-in') return;
      send(s.peer.id, { type: 'decline', call: s.id, reason }).catch(() => {});
      finish('');
    }

    function end() {
      if (!s || s.status === 'ended') return;
      if (s.status === 'ringing-in') return decline();
      send(s.peer.id, { type: 'end', call: s.id }).catch(() => {});
      finish('');
    }

    function toggleMute() {
      if (!s?.local) return;
      s.muted = !s.muted;
      s.local.getAudioTracks().forEach((t) => { t.enabled = !s.muted; });
      changed();
    }

    function toggleCam() {
      if (!s?.local || s.media !== 'video') return;
      s.camOff = !s.camOff;
      s.local.getVideoTracks().forEach((t) => { t.enabled = !s.camOff; });
      changed();
    }

    async function handle(peer, m) {
      if (!m || !m.type) return;
      if (m.type === 'ring') {
        if (s && s.status !== 'ended') { send(peer.id, { type: 'decline', call: m.call, reason: 'Busy on another call' }).catch(() => {}); return; }
        if (!['audio', 'video', 'screen'].includes(m.media)) return;
        newSession(peer, m.media, m.share === 'caller' ? 'caller' : m.share === 'callee' ? 'callee' : null, 'callee', m.call);
        changed();
        return;
      }
      if (!s || m.call !== s.id || peer.id !== s.peer.id) return;
      try {
        if (m.type === 'decline') return finish(m.reason || 'Declined');
        if (m.type === 'end') return finish(s.status.startsWith('ringing') ? 'Call cancelled' : 'Call ended');
        if (m.type === 'accept' && s.role === 'caller' && s.status === 'ringing-out') {
          clearTimeout(s.timer);
          s.status = 'connecting'; changed();
          try { s.local = await localMedia(); } catch (e) { return fail(e.message || 'Microphone/camera not available'); }
          const pc = makePc();
          addLocalTracks(pc);
          if (s.media === 'screen') bindDc(pc.createDataChannel('input', { ordered: true }));
          // Just watching a screen: ask to receive its video (and system sound).
          if (!s.local) { pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' }); }
          changed();
          await pc.setLocalDescription(await pc.createOffer());
          return msg('offer', { sdp: pc.localDescription.toJSON() });
        }
        if (m.type === 'offer' && s.role === 'callee') {
          const pc = makePc();
          await pc.setRemoteDescription(m.sdp);
          addLocalTracks(pc); // after the offer, so they reuse its m-lines
          await flushIce();
          await pc.setLocalDescription(await pc.createAnswer());
          return msg('answer', { sdp: pc.localDescription.toJSON() });
        }
        if (m.type === 'answer' && s.role === 'caller' && s.pc) {
          await s.pc.setRemoteDescription(m.sdp);
          return flushIce();
        }
        if (m.type === 'ice' && m.candidate) {
          if (s.pc?.remoteDescription) await s.pc.addIceCandidate(m.candidate).catch(() => {});
          else s.pendingIce.push(m.candidate);
        }
      } catch (e) {
        console.warn('DropWave call:', e);
        fail('Could not connect the call');
      }
    }

    /** Bytes sent/received so far (for a quality hint, and to check media really flows). */
    async function stats() {
      if (!s?.pc) return null;
      const out = { sent: 0, received: 0, video: null };
      (await s.pc.getStats()).forEach((x) => {
        if (x.type === 'outbound-rtp') out.sent += x.bytesSent || 0;
        if (x.type === 'inbound-rtp') {
          out.received += x.bytesReceived || 0;
          if (x.kind === 'video' && x.frameWidth) out.video = { width: x.frameWidth, height: x.frameHeight, fps: x.framesPerSecond || 0 };
        }
      });
      return out;
    }

    // ---- remote control ----
    /** Viewer: ask the sharing device for control of its mouse and keyboard. */
    function requestControl() {
      if (!s || s.sharing() || s.media !== 'screen') return;
      s.controlPending = true; changed();
      sendData({ t: 'control-request' });
    }
    /** Sharing side: allow or stop control (also answers a request). */
    function setControl(on) {
      if (!s || !s.sharing()) return;
      s.control = !!on; s.controlAsked = false;
      sendData({ t: 'control', on: !!on });
      changed();
    }
    /** Viewer: send one mouse/keyboard event (only does anything while control is allowed). */
    function sendInput(e) { if (s && s.control && !s.sharing()) sendData(e); }

    return { start, accept, decline, end, toggleMute, toggleCam, handle, stats, requestControl, setControl, sendInput, get state() { return snapshot(); } };
  }

  window.DWCalls = createCalls;
})();
