// Runs in Grok's authenticated main world: HTTP uploads and a direct gateway WebSocket, no UI actions.
export async function sendGatewayRequest({ prompt, images, eventId, mode, timeout }) {
  const fail = (code, status = 502, retryAfter = null) => ({ ok: false, code, status, retryAfter });
  if (location.origin !== 'https://grok.com') return fail('auth_required', 401);
  if (typeof globalThis.__grokProxyMint !== 'function') return fail('castle_sdk_unavailable');
  const request = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, signal: AbortSignal.timeout(20000) });
    if (response.status === 429) {
      const raw = response.headers.get('retry-after');
      const numeric = raw == null ? NaN : Number(raw), date = Date.parse(raw || '');
      throw fail('rate_limit_exceeded', 429, Number.isFinite(numeric) ? Math.max(1, numeric)
        : Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : null);
    }
    if (response.status === 401) throw fail('auth_required', 401);
    if (!response.ok) throw fail('upstream_http_error');
    try { return await response.json(); } catch { throw fail('protocol_error'); }
  };
  let userId;
  const files = [];
  try {
    const session = await request('/api/auth/session');
    userId = session?.session?.userId || session?.user?.id;
    if (!userId || session.status === 'unauthenticated') return fail('auth_required', 401);
    for (const image of images) {
      const bytes = Uint8Array.from(atob(image.base64), character => character.charCodeAt(0));
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: image.mimeType }), image.name);
      let uploaded = await request('/http/upload-file-v2/direct', { method: 'POST', body: form });
      const until = Date.now() + 30000;
      while (!uploaded.fileMetadata?.fileMetadataId && !uploaded.fileMetadataId && uploaded.uploadId && !uploaded.terminalError) {
        if (Date.now() >= until) return fail('upload_timeout', 504);
        await new Promise(resolve => setTimeout(resolve, 500));
        uploaded = { ...uploaded, ...await request(`/rest/app-chat/upload-file-v2/status?uploadId=${encodeURIComponent(uploaded.uploadId)}`) };
      }
      const id = uploaded.fileMetadata?.fileMetadataId || uploaded.fileMetadataId;
      if (uploaded.terminalError || typeof id !== 'string' || !id) return fail('upload_failed');
      files.push(id);
    }
  } catch (error) { return error?.ok === false ? error : fail('upstream_http_error'); }
  return new Promise(resolve => {
    let socket, sessionId, created = false, attached = false, sending = false, sent = false, heartbeat, settled = false;
    const timer = setTimeout(() => finish(fail('gateway_handshake_timeout', 504)), Math.min(timeout, 25000));
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (!result.ok) { clearInterval(heartbeat); socket?.close(); }
      resolve(result);
    };
    const send = event => socket.send(JSON.stringify({ ...(sessionId ? { session_id: sessionId } : {}), event }));
    const startTurn = async () => {
      if (!created || !attached || !sessionId || sending || settled) return;
      sending = true;
      let token;
      try { token = await globalThis.__grokProxyMint(); } catch { return finish(fail('castle_token_missing')); }
      if (settled) return;
      if (typeof token !== 'string' || !token) return finish(fail('castle_token_missing'));
      if (socket.readyState !== WebSocket.OPEN) return finish(fail('connection_closed'));
      const chunks = files.map(id => ({ mention: { file_mention: { file_id: id } } }));
      chunks.push({ text: { text: prompt } });
      const item = { type: 'message', role: 'user', x_grok: { client_message_id: crypto.randomUUID(), input_chunks: chunks } };
      if (files.length) item.file_attachment_ids = files;
      send({ type: 'response.create', event_id: eventId, item, castle_request_token: token });
      sent = true; finish({ ok: true });
    };
    try {
      socket = new WebSocket(`wss://grok.com/ws/mgw/?uid=${encodeURIComponent(userId)}`);
      globalThis.__grokProxySocket = socket;
      socket.onopen = () => {
        send({ type: 'session.create', event_id: `evt_init_${crypto.randomUUID()}`, session: {
          model: mode, x_grok: { protocol_capabilities: ['conversation_attached', 'custom_methods_v1'],
            is_temporary: true, keep_context: false, enable_image_generation: false, disable_text_follow_ups: true },
        } });
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: { type: 'ping', event_id: `evt_hb_${Date.now()}` } }));
        }, 15000);
      };
      socket.onmessage = ({ data }) => {
        let packet;
        try { packet = JSON.parse(data); } catch { return; }
        if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;
        const event = packet.event || packet;
        if (!event || typeof event !== 'object') return;
        if (event.type === 'session.created') { created = true; sessionId = packet.session_id || event.session?.id; }
        if (event.type === 'conversation.attached') { attached = true; sessionId ||= packet.session_id || event.conversation?.id; }
        if (!sent && event.type === 'error') {
          const code = String(event.error?.code || event.code || '').toUpperCase(), seconds = Number(event.error?.retry_after);
          return finish(['429', 'RATE_LIMIT_EXCEEDED', 'RATE_LIMITED', 'RESOURCE_EXHAUSTED'].includes(code)
            ? fail('rate_limit_exceeded', 429, Number.isFinite(seconds) && seconds > 0 ? seconds : null)
            : ['401', 'UNAUTHENTICATED', 'AUTH_REQUIRED'].includes(code) ? fail('auth_required', 401) : fail('upstream_error'));
        }
        void startTurn().catch(() => finish(fail('protocol_error')));
      };
      socket.onerror = () => { if (!sent) finish(fail('connection_closed')); };
      socket.onclose = () => { clearInterval(heartbeat); if (!sent) finish(fail('connection_closed')); };
    } catch { finish(fail('connection_closed')); }
  });
}
