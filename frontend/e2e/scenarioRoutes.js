// Playwright adapter for the shared scenarios (ADR-0087): the same factories the preview installs answer the page, and
// anything a scenario does not declare fails closed.
import { createScenario } from './scenarios.js';

// A JSON body as the scenario reads it, or a multipart upload as its one `file` part's name, type, and size.
async function requestBody(request) {
  const type = (await request.headerValue('content-type')) ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': type } })
      .formData()
      .catch(() => null);
    const parts = form ? [...form.entries()] : [];
    const [name, file] = parts[0] ?? [];
    return parts.length === 1 && name === 'file' && file instanceof File
      ? { file: { name: file.name, type: file.type, size: file.size } }
      : null;
  }
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

export async function routeScenario(page, name = 'ready') {
  const scenario = createScenario(name);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const body = await requestBody(request);
    const answer = scenario.respond({ method: request.method(), path: new URL(request.url()).pathname, body });
    return route.fulfill(answer
      ? { status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.json) }
      : { status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Not in this scenario.' }) });
  });
  // Every other Admin socket is closed; the scenario's chat socket is registered last, so it takes precedence.
  await page.routeWebSocket(/\/api(?:\/|$)/, (socket) => socket.close({ code: 1008, reason: 'Not in this scenario.' }));
  // Every chat frame the page sends is kept in order, so a test can prove exactly what reached the Team boundary.
  const chatFrames = [];
  await page.routeWebSocket(`**${scenario.chat.path}`, (socket) => {
    socket.onMessage((message) => {
      const frame = JSON.parse(message);
      chatFrames.push(frame);
      for (const reply of scenario.chat.message(frame)) socket.send(JSON.stringify(reply));
    });
  });
  return { ...scenario, chatFrames: () => chatFrames };
}
