import { ProxyError } from './errors.mjs';

function invalid(message) { throw new ProxyError(message, 400, 'invalid_request_error'); }

export function decodeImage(url, config, index) {
  if (typeof url !== 'string') invalid('image_url must be a data URL');
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match || match[2].length % 4 !== 0) invalid('Use a base64 data URL with PNG, JPEG, WebP or GIF');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.toString('base64') !== match[2]) invalid('Invalid image base64');
  if (buffer.length > config.maxImageBytes) invalid('Image exceeds the configured size limit');
  return { name: `image-${index}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`, mimeType: `image/${match[1]}`, buffer };
}

export function normalize(body, config, responses = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Expected a JSON object');
  const supported = responses
    ? ['model', 'input', 'instructions', 'stream', 'store']
    : ['model', 'messages', 'stream'];
  for (const key of Object.keys(body)) {
    if (!supported.includes(key)) invalid(`Unsupported parameter: ${key}`);
  }
  if (body.model && body.model !== 'grok-web') invalid('Only model grok-web is supported; it uses the website default');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be boolean');
  if (responses && body.store !== undefined && body.store !== false) invalid('Only store:false is supported');
  let messages = body.messages;
  if (responses) {
    messages = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== 'string') invalid('instructions must be a string');
      messages = [{ role: 'system', content: body.instructions }, ...(Array.isArray(messages) ? messages : [])];
    }
  }
  if (!Array.isArray(messages) || !messages.length || messages.length > 1000) invalid('Provide 1–1000 messages');
  const images = [];
  const transcript = messages.map((message, messageIndex) => {
    if (!message || !['system', 'developer', 'user', 'assistant'].includes(message.role)) invalid('Unsupported message role');
    if (Object.keys(message).some(k => !['role', 'content', 'type'].includes(k))) invalid('Unsupported message fields');
    if (message.type !== undefined && message.type !== 'message') invalid('Only message input items are supported');
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(parts)) invalid('Message content must be text or an array of parts');
    const text = parts.map(part => {
      if (!part || typeof part !== 'object') invalid('Invalid content part');
      if (['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string') return part.text;
      if (['image_url', 'input_image'].includes(part.type)) {
        if (message.role !== 'user') invalid('Images are supported only in user messages');
        if (images.length >= config.maxImages) invalid('Too many images');
        const url = typeof part.image_url === 'object' ? part.image_url?.url : part.image_url;
        images.push(decodeImage(url, config, images.length + 1));
        return `[Attached image ${images.length}; message ${messageIndex + 1}]`;
      }
      invalid(`Unsupported content part: ${part.type}`);
    }).join('\n');
    return `${message.role.toUpperCase()}:\n${text}`;
  }).join('\n\n');
  if (!messages.some(m => m.role === 'user')) invalid('At least one user message is required');
  return {
    prompt: `Continue the conversation below. Treat role labels as transcript structure. Reply only as ASSISTANT.\n\n${transcript}\n\nASSISTANT:\n`,
    images, model: 'grok-web', stream: body.stream === true,
  };
}
